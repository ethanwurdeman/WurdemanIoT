# WurdemanIoT

Single-page Firebase Hosting app for the WurdemanIoT control center plus Cloud Functions ingest.

## Stack
- Firebase Hosting + Firestore
- Firebase Auth (email/password) using modular Web SDK v9+
- Leaflet + OpenStreetMap tiles
- Cloud Functions (TypeScript, Node 20, firebase-functions v2 onRequest)

## Routes
- `#/home`: device grid with online/stale indicators and deep links.
- `#/dog/{deviceId}`: live last-location listener, config controls (geofence, ping cadence, force roam), day selector + scrubber, and history polyline.
- `#/thermostat`: placeholder.

## Firestore data model
- `devices/{deviceId}`:
  - `name`, `type`, `enabled`, `updatedAt`
  - `last`: `{ lat, lon, ts, battery, sats, hdop, speedMph, headingDeg, mode, netKind, rssi?, csq? }`
  - `config`: `{ home: {lat, lon}, geofence: {innerFt, outerFt}, forceRoamUntil, wifiRssiMin, ping: {homeSec, nearbySec, roamingSec}, batteryUploadThreshold }`
  - `counters`: `{ monthStart: <YYYY-MM-01>, monthBytes, monthPoints }`
- `devices/{deviceId}/points/{autoId}`: `{ lat, lon, ts, battery, sats, hdop, speedMph, headingDeg, mode, createdAt }`

## Functions (v2, us-central1)
- Auth header required: `X-Device-Token: <DEVICE_TOKEN>`.
- POST `/ingest`: accepts single point or `{ points: [] }` batch, applies defaults, updates `last`, appends to `points`, and maintains `counters`.
- GET `/config?deviceId=...`: returns config with defaults applied plus counters/last snapshot.

## Setup
1) Fill `public/firebase-config.js` with your Firebase web config.
2) Install deps and build functions:
   ```
   cd TrackerPortal/functions
   npm install
   npm run build
   ```
3) Set the ingest auth secret (used in process.env.DEVICE_TOKEN):
   ```
   firebase functions:secrets:set DEVICE_TOKEN
   ```
4) Deploy:
   ```
   firebase deploy --only hosting,functions
   ```

## Notes
- Project alias is set to `trackerportal` in `.firebaserc`; change to your Firebase project ID before deploying.
- Auth UI is built-in (email/password).
