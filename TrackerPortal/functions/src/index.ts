import { onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";

admin.initializeApp();
const db = admin.firestore();
const { Timestamp, FieldValue } = admin.firestore;

const DEVICE_TOKEN = process.env.DEVICE_TOKEN || "";
const THERMOSTAT_TOKEN = process.env.THERMOSTAT_TOKEN || DEVICE_TOKEN;
const DEFAULT_THERMOSTAT_CONFIG = {
  setpointF: 70,
  diffF: 1,
  mode: "heat",
  fanUntil: 0,
  schedule: [] as Array<Array<number | null>>
};

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

interface ThermostatIngestRequest {
  deviceId?: string;
  ts?: number | string | admin.firestore.Timestamp;
  tempF?: number | string;
  humidity?: number | string;
  heatIndexF?: number | string;
  setpointF?: number | string;
  diffF?: number | string;
  mode?: string;
  heatOn?: boolean | string | number;
  coolOn?: boolean | string | number;
  fanOn?: boolean | string | number;
  fanUntil?: number | string;
  ssid?: string;
  rssi?: number | string;
  ip?: string;
  uptimeSec?: number | string;
  sensorOk?: boolean | string | number;
  sdOk?: boolean | string | number;
  sdError?: string;
  scheduleActive?: boolean | string | number;
  scheduleSetpoint?: number | string;
  overrideActive?: boolean | string | number;
  history?: Array<{ ts?: number | string | admin.firestore.Timestamp; tempF?: number | string; setpointF?: number | string }>;
  config?: {
    setpointF?: number | string;
    diffF?: number | string;
    mode?: string;
    fanUntil?: number | string;
    schedule?: unknown;
  };
}

interface ThermostatStatus {
  ts: admin.firestore.Timestamp;
  tempF: number | null;
  humidity: number | null;
  heatIndexF: number | null;
  setpointF: number;
  diffF: number;
  mode: string;
  heatOn: boolean;
  coolOn: boolean;
  fanOn: boolean;
  fanUntil: number;
  wifi: { ssid: string | null; rssi: number | null; ip: string | null };
  uptimeSec: number;
  sensorOk: boolean;
  sdOk: boolean;
  sdError: string | null;
  scheduleActive: boolean;
  scheduleSetpoint: number | null;
  overrideActive: boolean;
}

interface ThermostatHistoryPoint {
  ts: admin.firestore.Timestamp;
  tempF: number | null;
  setpointF: number | null;
}

interface ThermostatConfigShape {
  setpointF: number;
  diffF: number;
  mode: string;
  fanUntil: number;
  schedule: Array<Array<number | null>>;
}

export const thermostatIngest = onRequest(
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

    if (!THERMOSTAT_TOKEN) {
      logger.error("THERMOSTAT_TOKEN env var not set");
      res.status(500).json({ error: "Server auth not configured" });
      return;
    }

    const token = (req.get("X-Device-Token") || req.get("x-device-token") || "").trim();
    if (!token || token !== THERMOSTAT_TOKEN) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const body = (req.body ?? {}) as ThermostatIngestRequest;
    const deviceId = (body.deviceId || "").trim();
    if (!deviceId) {
      res.status(400).json({ error: "Missing deviceId" });
      return;
    }

    const status = normalizeThermostatStatus(body);
    const history = normalizeThermostatHistory(body);

    try {
      const ref = db.collection("thermostats").doc(deviceId);
      const snap = await ref.get();
      const existing = snap.exists ? snap.data() : undefined;
      const existingConfig = normalizeThermostatConfig(existing?.config);

      const update: Record<string, unknown> = {
        name: existing?.name ?? deviceId,
        updatedAt: FieldValue.serverTimestamp(),
        status
      };
      if (!existing?.config) {
        update.config = existingConfig;
      }

      const batch = db.batch();
      batch.set(ref, update, { merge: true });
      history.forEach((point) => {
        const id = String(point.ts.toMillis());
        const histRef = ref.collection("history").doc(id);
        batch.set(histRef, point, { merge: true });
      });
      await batch.commit();

      res.status(200).json({ status: "ok", deviceId });
      return;
    } catch (err) {
      logger.error("Thermostat ingest failure", err as Error);
      res.status(500).json({ error: "Failed to ingest thermostat data" });
      return;
    }
  }
);

export const thermostatConfig = onRequest(
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

    if (!THERMOSTAT_TOKEN) {
      logger.error("THERMOSTAT_TOKEN env var not set");
      res.status(500).json({ error: "Server auth not configured" });
      return;
    }

    const token = (req.get("X-Device-Token") || req.get("x-device-token") || "").trim();
    if (!token || token !== THERMOSTAT_TOKEN) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    if (req.method === "GET") {
      const deviceId = ((req.query.deviceId as string) || "").trim();
      if (!deviceId) {
        res.status(400).json({ error: "Missing deviceId" });
        return;
      }

      try {
        const ref = db.collection("thermostats").doc(deviceId);
        const snap = await ref.get();
        const data = snap.data();
        const configValue = normalizeThermostatConfig(data?.config);
        res.status(200).json({
          deviceId,
          config: configValue,
          serverTime: Date.now()
        });
        return;
      } catch (err) {
        logger.error("Thermostat config fetch failed", err as Error);
        res.status(500).json({ error: "Failed to load thermostat config" });
        return;
      }
    }

    if (req.method === "POST") {
      const body = (req.body ?? {}) as ThermostatIngestRequest;
      const deviceId = (body.deviceId || "").trim();
      if (!deviceId) {
        res.status(400).json({ error: "Missing deviceId" });
        return;
      }
      try {
        const ref = db.collection("thermostats").doc(deviceId);
        const snap = await ref.get();
        const existing = snap.exists ? snap.data() : undefined;
        const merged = normalizeThermostatConfig(body.config, existing?.config);
        await ref.set(
          {
            config: merged,
            configUpdatedAt: FieldValue.serverTimestamp()
          },
          { merge: true }
        );
        res.status(200).json({ status: "ok", deviceId });
        return;
      } catch (err) {
        logger.error("Thermostat config update failed", err as Error);
        res.status(500).json({ error: "Failed to update thermostat config" });
        return;
      }
    }

    res.set("Allow", "GET, POST");
    res.status(405).json({ error: "Method not allowed" });
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

function normalizeThermostatStatus(body: ThermostatIngestRequest): ThermostatStatus {
  const ts = parseTimestamp(body.ts) ?? Timestamp.fromMillis(Date.now());
  return {
    ts,
    tempF: toNullableNumber(body.tempF),
    humidity: toNullableNumber(body.humidity),
    heatIndexF: toNullableNumber(body.heatIndexF),
    setpointF: toNumber(body.setpointF, DEFAULT_THERMOSTAT_CONFIG.setpointF),
    diffF: toNumber(body.diffF, DEFAULT_THERMOSTAT_CONFIG.diffF),
    mode: normalizeThermostatMode(body.mode ?? DEFAULT_THERMOSTAT_CONFIG.mode),
    heatOn: toBoolean(body.heatOn, false),
    coolOn: toBoolean(body.coolOn, false),
    fanOn: toBoolean(body.fanOn, false),
    fanUntil: toNumber(body.fanUntil, DEFAULT_THERMOSTAT_CONFIG.fanUntil),
    wifi: {
      ssid: body.ssid ? String(body.ssid) : null,
      rssi: toNullableNumber(body.rssi),
      ip: body.ip ? String(body.ip) : null
    },
    uptimeSec: toNumber(body.uptimeSec, 0),
    sensorOk: toBoolean(body.sensorOk, false),
    sdOk: toBoolean(body.sdOk, false),
    sdError: body.sdError ? String(body.sdError) : null,
    scheduleActive: toBoolean(body.scheduleActive, false),
    scheduleSetpoint: toNullableNumber(body.scheduleSetpoint),
    overrideActive: toBoolean(body.overrideActive, false)
  };
}

function normalizeThermostatHistory(body: ThermostatIngestRequest): ThermostatHistoryPoint[] {
  const points: ThermostatHistoryPoint[] = [];
  const history = Array.isArray(body.history) ? body.history : [];
  history.forEach((raw) => {
    const ts = parseTimestamp(raw.ts);
    if (!ts) return;
    const tempF = toNullableNumber(raw.tempF);
    const setpointF = toNullableNumber(raw.setpointF);
    points.push({ ts, tempF, setpointF });
  });

  if (!points.length) {
    const ts = parseTimestamp(body.ts);
    const tempF = toNullableNumber(body.tempF);
    const setpointF = toNullableNumber(body.setpointF);
    if (ts && (tempF !== null || setpointF !== null)) {
      points.push({ ts, tempF, setpointF });
    }
  }

  return points;
}

function normalizeThermostatConfig(
  input: unknown,
  fallback?: unknown
): ThermostatConfigShape {
  const base = (fallback || DEFAULT_THERMOSTAT_CONFIG) as ThermostatConfigShape;
  const cfg = (input || {}) as Record<string, unknown>;
  return {
    setpointF: toNumber(cfg.setpointF, base.setpointF),
    diffF: toNumber(cfg.diffF, base.diffF),
    mode: normalizeThermostatMode(cfg.mode ?? base.mode),
    fanUntil: toNumber(cfg.fanUntil, base.fanUntil),
    schedule: normalizeThermostatSchedule(cfg.schedule, base.schedule)
  };
}

function normalizeThermostatSchedule(
  input: unknown,
  fallback?: Array<Array<number | null>>
): Array<Array<number | null>> {
  const out: Array<Array<number | null>> = [];
  const source = Array.isArray(input) ? input : Array.isArray(fallback) ? fallback : [];
  for (let d = 0; d < 7; d++) {
    const row: Array<number | null> = [];
    const day = Array.isArray(source[d]) ? (source[d] as unknown[]) : [];
    for (let h = 0; h < 24; h++) {
      const value = toNullableNumber(day[h]);
      row.push(Number.isFinite(value) ? value : null);
    }
    out.push(row);
  }
  return out;
}

function normalizeThermostatMode(raw: unknown): string {
  const value = String(raw || "").toLowerCase();
  if (value === "heat" || value === "cool" || value === "fan" || value === "off") {
    return value;
  }
  return DEFAULT_THERMOSTAT_CONFIG.mode;
}

function toBoolean(value: unknown, fallback = false): boolean {
  if (value === true || value === false) return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (v === "true" || v === "1" || v === "yes" || v === "on") return true;
    if (v === "false" || v === "0" || v === "no" || v === "off") return false;
  }
  return fallback;
}
