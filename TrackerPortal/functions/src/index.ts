import { onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";

admin.initializeApp();
const db = admin.firestore();
const { Timestamp, FieldValue } = admin.firestore;

interface IngestBody {
  deviceId?: string;
  name?: string;
  type?: string;
  lat?: number | string;
  lon?: number | string;
  ts?: number | string | admin.firestore.Timestamp;
  battery?: number | string;
  sats?: number | string;
  hdop?: number | string;
  enabled?: boolean;
}

export const ingest = onRequest(
  {
    cors: true,
    region: "us-central1",
    concurrency: 8
  },
  async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }

    if (req.method !== "POST") {
      res.set("Allow", "POST");
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    const body = (req.body ?? {}) as IngestBody;
    const parseNum = (v: unknown) => {
      if (v === null || v === undefined || v === "") return undefined;
      const n = typeof v === "number" ? v : Number(v);
      return Number.isFinite(n) ? n : undefined;
    };

    const deviceId = body.deviceId?.trim();
    const lat = parseNum(body.lat);
    const lon = parseNum(body.lon);
    const battery = parseNum(body.battery);
    const sats = parseNum(body.sats);
    const hdop = parseNum(body.hdop);
    const tsDate = parseTimestamp(body.ts);

    if (!deviceId || lat === undefined || lon === undefined || !tsDate) {
      res.status(400).json({
        error: "Missing or invalid deviceId, lat, lon, or ts"
      });
      return;
    }

    const ts = Timestamp.fromDate(tsDate);
    const deviceRef = db.collection("devices").doc(deviceId);
    const pointRef = deviceRef.collection("points").doc();

    const payload = {
      lat,
      lon,
      ts,
      battery: battery ?? null,
      sats: sats ?? null,
      hdop: hdop ?? null
    };

    try {
      await db.runTransaction(async (tx) => {
        tx.set(
          deviceRef,
          {
            name: body.name ?? deviceId,
            type: body.type ?? "dog",
            enabled: body.enabled ?? true,
            updatedAt: FieldValue.serverTimestamp(),
            last: payload
          },
          { merge: true }
        );

        tx.set(pointRef, {
          ...payload,
          createdAt: FieldValue.serverTimestamp()
        });
      });

      logger.info("Ingested point", { deviceId, lat, lon });
      res.status(200).json({ status: "ok", deviceId });
      return;
    } catch (err) {
      logger.error("Ingest failure", err);
      res.status(500).json({ error: "Failed to ingest point" });
      return;
    }
  }
);

function parseTimestamp(input: IngestBody["ts"]): Date | null {
  if (!input && input !== 0) return null;
  if (input instanceof Date) return input;
  if (typeof input === "number") return new Date(input);
  if (typeof input === "string") {
    const num = Number(input);
    if (!Number.isNaN(num)) return new Date(num);
    const d = new Date(input);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  // Firestore Timestamp
  if ((input as admin.firestore.Timestamp)?.toDate) {
    return (input as admin.firestore.Timestamp).toDate();
  }
  return null;
}
