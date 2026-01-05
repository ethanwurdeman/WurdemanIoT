# TrackerPortal

Single-page Firebase Hosting app for monitoring multiple trackers with Firestore-backed data and a Cloud Function ingest endpoint.

## Stack
- Firebase Hosting + Firestore
- Firebase Auth (email/password) using modular Web SDK v9+
- Leaflet + OpenStreetMap tiles
- Cloud Functions (TypeScript, Node 20, firebase-functions v2 onRequest)

## Routes
- `#/home` (default): device grid from `devices` collection with online/stale indicator and dog-card deep links.
- `#/dog/{deviceId}`: live listener for `devices/{id}` last position, stats, and 200-point history polyline from `devices/{id}/points`.
- `#/vehicles`, `#/pets`, `#/kids`: placeholder “Coming soon”.

## Firestore data model
- `devices/{deviceId}` fields: `name` (string), `type` (string), `enabled` (bool), `updatedAt` (serverTimestamp), `last` `{lat, lon, ts, battery, sats, hdop}`.
- `devices/{deviceId}/points/{autoId}` fields: `lat, lon, ts, battery, sats, hdop, createdAt (serverTimestamp)`.

## Setup
1) Copy `public/firebase-config.js` and fill with your Firebase config (API key, project ID, etc.).
2) Install Hosting + Functions deps:
   ```
   cd TrackerPortal/functions
   npm install
   npm run build
   ```
3) (Optional) Use emulators:
   ```
   firebase emulators:start
   ```
4) Deploy when ready:
   ```
   firebase deploy --only hosting,functions
   ```

## Cloud Function ingest
POST `/ingest` with JSON:
```
{
  "deviceId": "dog-1",
  "name": "Collar A",
  "type": "dog",
  "lat": 37.1,
  "lon": -122.1,
  "ts": 1700000000000,
  "battery": 90,
  "sats": 10,
  "hdop": 1.2
}
```
The function upserts `devices/{deviceId}`, sets `last`, updates `updatedAt`, and appends to `devices/{deviceId}/points`.

## Notes
- Project alias is set to `trackerportal` in `.firebaserc`; replace with your actual Firebase project ID before deploying.
- Auth UI is built-in (email/password). An “Add device” button is present as an admin placeholder.
