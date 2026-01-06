import { onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";

admin.initializeApp();
const db = admin.firestore();
const { Timestamp, FieldValue } = admin.firestore;

const DEVICE_TOKEN = process.env.DEVICE_TOKEN || "";

const DEFAULT_CONFIG = {
  home: null as { lat: number; lon: number } | null,
  geofence: { innerFt: 250, outerFt: 750 },
  forceRoamUntil: null as admin.firestore.Timestamp | number | null,
  wifiRssiMin: -72,
  ping: { homeSec: 900, nearbySec: 120, roamingSec: 15 },
  batteryUploadThreshold: 25
};

interface IncomingPoint {
  deviceId?: string;
  lat?: number | string;
  lon?: number | string;
  ts?: number | string | admin.firestore.Timestamp;
  battery?: number | string;
  sats?: number | string;
  hdop?: number | string;
  speedMph?: number | string;
  speed?: number | string;
  headingDeg?: number | string;
  heading?: number | string;
  mode?: string;
  net?: { kind?: string; rssi?: number | string; csq?: number | string };
  netKind?: string;
  network?: string;
  rssi?: number | string;
  csq?: number | string;
  fw?: string;
  seq?: number | string;
}

interface IngestRequest extends IncomingPoint {
  name?: string;
  type?: string;
  enabled?: boolean;
  points?: IncomingPoint[];
}

interface NormalizedPoint {
  lat: number;
  lon: number;
  ts: admin.firestore.Timestamp;
  battery: number | null;
  sats: number | null;
  hdop: number | null;
  speedMph: number | null;
  headingDeg: number | null;
  mode: string | null;
  netKind: string | null;
  rssi: number | null;
  csq: number | null;
  fw: string | null;
  seq: number | string | null;
}

interface Counters {
  monthStart: string;
  monthBytes: number;
  monthPoints: number;
}

export const ingest = onRequest(
  {
    cors: true,
    region: "us-central1",
    concurrency: 8
  },
  async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Headers", "Content-Type, X-Device-Token");

    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }

    if (req.method !== "POST") {
      res.set("Allow", "POST");
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    if (!DEVICE_TOKEN) {
      logger.error("DEVICE_TOKEN env var not set");
      res.status(500).json({ error: "Server auth not configured" });
      return;
    }

    const token = (req.get("X-Device-Token") || req.get("x-device-token") || "").trim();
    if (!token || token !== DEVICE_TOKEN) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const body = (req.body ?? {}) as IngestRequest;
    const deviceId = (body.deviceId || "").trim();
    if (!deviceId) {
      res.status(400).json({ error: "Missing deviceId" });
      return;
    }

    const points = normalizePoints(body);
    if (!points.length) {
      res.status(400).json({ error: "No valid points in payload" });
      return;
    }

    const payloadBytes = estimateBytes(req as { rawBody?: Buffer | string; body?: unknown });

    try {
      await db.runTransaction(async (tx) => {
        const deviceRef = db.collection("devices").doc(deviceId);
        const snap = await tx.get(deviceRef);
        const existing = snap.exists ? snap.data() : undefined;

        let counters = normalizeCounters(existing?.counters);
        counters = bumpCounters(counters, payloadBytes, points.length);

        const latest = points[points.length - 1];
        const config = ensureConfig(existing?.config, latest, existing?.last as NormalizedPoint | undefined);

        const deviceUpdate = {
          name: body.name ?? existing?.name ?? deviceId,
          type: body.type ?? existing?.type ?? "dog",
          enabled: body.enabled ?? existing?.enabled ?? true,
          updatedAt: FieldValue.serverTimestamp(),
          last: latest,
          config,
          counters
        };

        tx.set(deviceRef, deviceUpdate, { merge: true });

        points.forEach((p) => {
          const pointRef = deviceRef.collection("points").doc();
          tx.set(pointRef, { ...p, createdAt: FieldValue.serverTimestamp() });
        });
      });

      logger.info("Ingested points", { deviceId, points: points.length });
      res.status(200).json({ status: "ok", deviceId, points: points.length });
      return;
    } catch (err) {
      logger.error("Ingest failure", err as Error);
      res.status(500).json({ error: "Failed to ingest point(s)" });
      return;
    }
  }
);

export const config = onRequest(
  {
    cors: true,
    region: "us-central1"
  },
  async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Headers", "Content-Type, X-Device-Token");

    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }

    if (req.method !== "GET") {
      res.set("Allow", "GET");
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    if (!DEVICE_TOKEN) {
      logger.error("DEVICE_TOKEN env var not set");
      res.status(500).json({ error: "Server auth not configured" });
      return;
    }

    const token = (req.get("X-Device-Token") || req.get("x-device-token") || "").trim();
    if (!token || token !== DEVICE_TOKEN) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const deviceId = ((req.query.deviceId as string) || "").trim();
    if (!deviceId) {
      res.status(400).json({ error: "Missing deviceId" });
      return;
    }

    try {
      const ref = db.collection("devices").doc(deviceId);
      const snap = await ref.get();
      const data = snap.data();
      const last = data?.last as NormalizedPoint | undefined;
      const configValue = ensureConfig(data?.config, last, last);
      const counters = normalizeCounters(data?.counters);

      res.status(200).json({
        deviceId,
        config: serializeConfig(configValue),
        counters,
        last,
        serverTime: Date.now()
      });
      return;
    } catch (err) {
      logger.error("Config fetch failed", err as Error);
      res.status(500).json({ error: "Failed to load config" });
      return;
    }
  }
);

function normalizePoints(body: IngestRequest): NormalizedPoint[] {
  const rawPoints = Array.isArray(body.points) ? body.points : [body];
  const valid: NormalizedPoint[] = [];

  rawPoints.forEach((raw) => {
    const normalized = normalizePoint(raw);
    if (normalized) {
      valid.push(normalized);
    }
  });

  valid.sort((a, b) => a.ts.toMillis() - b.ts.toMillis());
  return valid.slice(0, historyMaxPoints());
}

function historyMaxPoints() {
  return 2000;
}

function normalizePoint(raw: IncomingPoint): NormalizedPoint | null {
  const lat = toNumber(raw.lat);
  const lon = toNumber(raw.lon);
  const ts = parseTimestamp(raw.ts);

  if (!isValidLat(lat) || !isValidLon(lon) || !ts || !isSaneTimestamp(ts)) {
    return null;
  }

  return {
    lat,
    lon,
    ts,
    battery: toNullableNumber(raw.battery),
    sats: toNullableNumber(raw.sats),
    hdop: toNullableNumber(raw.hdop),
    speedMph: toNullableNumber(raw.speedMph ?? raw.speed),
    headingDeg: toNullableNumber(raw.headingDeg ?? raw.heading),
    mode: raw.mode ?? null,
    netKind: raw.net?.kind ?? raw.netKind ?? raw.network ?? null,
    rssi: toNullableNumber(raw.net?.rssi ?? raw.rssi),
    csq: toNullableNumber(raw.net?.csq ?? raw.csq),
    fw: raw.fw ?? null,
    seq: raw.seq ?? null
  };
}

function ensureConfig(
  config: unknown,
  lastPoint?: NormalizedPoint,
  existingLast?: NormalizedPoint
): typeof DEFAULT_CONFIG {
  const cfg = (config || {}) as Record<string, unknown>;
  const incomingHome = normalizeHome((cfg as { home?: unknown }).home);
  const fallbackHome = normalizeHome(lastPoint) || normalizeHome(existingLast) || null;
  const rawForceUntil = (cfg as { forceRoamUntil?: unknown }).forceRoamUntil;
  const forceRoamUntil = rawForceUntil === undefined ? null : parseTimestamp(rawForceUntil);

  return {
    home: incomingHome ?? fallbackHome ?? null,
    geofence: {
      innerFt: toNumber((cfg as { geofence?: { innerFt?: unknown } }).geofence?.innerFt, DEFAULT_CONFIG.geofence.innerFt),
      outerFt: toNumber((cfg as { geofence?: { outerFt?: unknown } }).geofence?.outerFt, DEFAULT_CONFIG.geofence.outerFt)
    },
    forceRoamUntil,
    wifiRssiMin: toNumber((cfg as { wifiRssiMin?: unknown }).wifiRssiMin, DEFAULT_CONFIG.wifiRssiMin),
    ping: {
      homeSec: toNumber((cfg as { ping?: { homeSec?: unknown } }).ping?.homeSec, DEFAULT_CONFIG.ping.homeSec),
      nearbySec: toNumber((cfg as { ping?: { nearbySec?: unknown } }).ping?.nearbySec, DEFAULT_CONFIG.ping.nearbySec),
      roamingSec: toNumber((cfg as { ping?: { roamingSec?: unknown } }).ping?.roamingSec, DEFAULT_CONFIG.ping.roamingSec)
    },
    batteryUploadThreshold: toNumber(
      (cfg as { batteryUploadThreshold?: unknown }).batteryUploadThreshold,
      DEFAULT_CONFIG.batteryUploadThreshold
    )
  };
}

function normalizeHome(input: unknown): { lat: number; lon: number } | null {
  if (!input) return null;
  const maybe = input as { lat?: unknown; lon?: unknown };
  const lat = toNumber(maybe.lat);
  const lon = toNumber(maybe.lon);
  if (!isValidLat(lat) || !isValidLon(lon)) return null;
  return { lat, lon };
}

function normalizeCounters(input: unknown): Counters {
  const counters = (input || {}) as Counters;
  const monthStart = parseMonthStart(counters.monthStart);
  const currentKey = currentMonthKey();
  if (monthStart !== currentKey) {
    return { monthStart: currentKey, monthBytes: 0, monthPoints: 0 };
  }
  return {
    monthStart: currentKey,
    monthBytes: Number(counters.monthBytes) || 0,
    monthPoints: Number(counters.monthPoints) || 0
  };
}

function bumpCounters(base: Counters, byteLength: number, points: number): Counters {
  return {
    monthStart: base.monthStart,
    monthBytes: (base.monthBytes || 0) + (byteLength || 0),
    monthPoints: (base.monthPoints || 0) + (points || 0)
  };
}

function serializeConfig(cfg: typeof DEFAULT_CONFIG) {
  return {
    home: cfg.home,
    geofence: cfg.geofence,
    forceRoamUntil: cfg.forceRoamUntil
      ? parseTimestamp(cfg.forceRoamUntil)?.toMillis() ?? null
      : null,
    wifiRssiMin: cfg.wifiRssiMin,
    ping: cfg.ping,
    batteryUploadThreshold: cfg.batteryUploadThreshold
  };
}

function estimateBytes(req: { rawBody?: Buffer | string; body?: unknown }): number {
  if (req.rawBody) {
    return typeof req.rawBody === "string" ? Buffer.byteLength(req.rawBody, "utf8") : req.rawBody.length;
  }
  try {
    return Buffer.byteLength(JSON.stringify(req.body ?? {}), "utf8");
  } catch (err) {
    logger.warn("Failed to estimate payload size", err as Error);
    return 0;
  }
}

function parseTimestamp(input: unknown): admin.firestore.Timestamp | null {
  if (input instanceof Timestamp) return input;
  if (input instanceof Date) return Timestamp.fromDate(input);
  if (typeof input === "number") return Timestamp.fromMillis(input);
  if (typeof input === "string") {
    const n = Number(input);
    if (Number.isFinite(n)) return Timestamp.fromMillis(n);
    const d = new Date(input);
    return Number.isNaN(d.getTime()) ? null : Timestamp.fromDate(d);
  }
  if ((input as admin.firestore.Timestamp)?.toDate) {
    return Timestamp.fromDate((input as admin.firestore.Timestamp).toDate());
  }
  return null;
}

function isSaneTimestamp(ts: admin.firestore.Timestamp): boolean {
  const ms = ts.toMillis();
  const now = Date.now();
  const earliest = Date.UTC(2000, 0, 1);
  const latest = now + 10 * 60 * 1000;
  return ms >= earliest && ms <= latest;
}

function toNumber(value: unknown, fallback?: number): number {
  if (value === null || value === undefined || value === "") return fallback as number;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : (fallback as number);
}

function toNullableNumber(value: unknown): number | null {
  const n = toNumber(value, NaN);
  return Number.isFinite(n) ? n : null;
}

function isValidLat(lat?: number | null): lat is number {
  return lat !== null && lat !== undefined && lat >= -90 && lat <= 90;
}

function isValidLon(lon?: number | null): lon is number {
  return lon !== null && lon !== undefined && lon >= -180 && lon <= 180;
}

function currentMonthKey(date = new Date()): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}-01`;
}

function parseMonthStart(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === "string") return value;
  if ((value as admin.firestore.Timestamp)?.toDate) {
    return currentMonthKey((value as admin.firestore.Timestamp).toDate());
  }
  if (value instanceof Date) return currentMonthKey(value);
  return null;
}
