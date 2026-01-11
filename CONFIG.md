# Configuration Reference (WurdemanIoT)

Single place to see/change secrets, defaults, and paths. Keep this file updated when values change.

## Firebase (project-wide)
- projectId: wurdemaniot
- authDomain: wurdemaniot.firebaseapp.com
- apiKey: AIzaSyCMy6XXX2r5gutvqymecbinONj0ZYX0Heg
- storageBucket: wurdemaniot.firebasestorage.app
- messagingSenderId: 326690015446
- appId: 1:326690015446:web:d298e396baa08a71d9e177
- measurementId: G-L4PVSKNPXC
- Firestore rules file: TrackerPortal/firestore.rules

## Cloud Functions auth
- DEVICE_TOKEN (ingest) env: currently set via Functions secret (keep same token as below)
- THERMOSTAT_TOKEN env: set to match thermostat device token (fill in)

## Web client config
- File: TrackerPortal/public/firebase-config.js
  - firebaseConfig.* matches Firebase above
  - ingestConfig.url: https://us-central1-wurdemaniot.cloudfunctions.net/ingest
  - ingestConfig.deviceId: Tyee
  - ingestConfig.deviceToken: 7c9e2a41fd64e7d9f13c8a5
  - ingestConfig.thermostatId: home

## Thermostat device (ESP32 Nano) — folder device/thermostat
- WiFi primary SSID/PASS: Wurdeman Starlink 2.4 / Koda2020
- Authorized SSID for control: WurdemanIoT
- Admin login (local web UI): user dmin, pass change-me
- AP SSID/PASS: Thermostat-Setup / ` (blank)
- Timezone: default UTC; browser sets offset via /tz
- Control defaults: setpoint 70.0 F, diff 1.0 F, mode heat
- Fan timer epoch: stored in firmware (updates via cloud config)
- Cloud endpoints: THERMOSTAT_INGEST_URL=https://us-central1-wurdemaniot.cloudfunctions.net/thermostatIngest, THERMOSTAT_CONFIG_URL=https://us-central1-wurdemaniot.cloudfunctions.net/thermostatConfig
- Device token: THERMOSTAT_DEVICE_TOKEN (fill in actual token; currently REPLACE_ME in include/secrets.h)
- Secrets file: device/thermostat/include/secrets.h (set WiFi + token + endpoints)
- Firmware source: device/thermostat/src/main.cpp; PlatformIO device/thermostat/platformio.ini
- Archived old .ino: device/thermostat/archived_thermostat_webui.ino

## Tyee tracker (cellular/Wi-Fi) — folder device/tyee
- Ingest base URL: https://ingest-dwoseol4ba-uc.a.run.app
- Device ID: Tyee
- Device token: in device/tyee/include/secrets.h (currently REPLACE_ME)
- WiFi SSID/PASS: in device/tyee/include/secrets.h (currently REPLACE_ME)
- APN: hologram, user/pass blank
- Firmware source: (not present in repo; only build artifacts in .pio). Re-add source when available.

## Water Dispenser (ESP32 Nano) — folder device/water-dispenser
- No network creds needed (offline)
- Firmware source: device/water-dispenser/src/main.cpp
- PlatformIO config: device/water-dispenser/platformio.ini

## Defaults (app / devices)
- Thermostat setpoint/diff defaults: 70 F / 1.0 F (see thermostat firmware)
- Thermostat schedule: empty by default (manual)
- Tyee geofence defaults (app DEFAULT_CONFIG): innerFt=250, outerFt=750, wifiRssiMin=-72; ping: homeSec=900, nearbySec=120, roamingSec=15; batteryUploadThreshold=25

## Paths to flash
- Thermostat: device/thermostat (PlatformIO: pio run -t upload)
- Tyee: device/tyee (source missing; once added, use PlatformIO per board)
- Water Dispenser: device/water-dispenser (PlatformIO: pio run -t upload)

## Notes
- Keep this file updated when tokens/keys/SSIDs change.
- Functions env vars must match device tokens (DEVICE_TOKEN for trackers, THERMOSTAT_TOKEN for thermostat).
