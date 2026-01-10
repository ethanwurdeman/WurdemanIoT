# WurdemanIoT Tracker Portal

Single-page Firebase Hosting app for the WurdemanIoT control center plus Cloud Functions ingest.

## Project layout
- `TrackerPortal/public`: hosted web app (Firebase Hosting)
- `TrackerPortal/functions`: Cloud Functions (TypeScript, Node 20)
- `TrackerPortal/dataconnect`: schema and example data files
- `device/thermostat-webui`: ESP32 thermostat firmware (Arduino sketch)

## Setup
1) Fill `TrackerPortal/public/firebase-config.js` with your Firebase web config.
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

See `TrackerPortal/README.md` for detailed routes, data model, and function behavior.
