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
- TYEE_TOKEN (ingest) env: set via Functions secret (matches TYEE_DEVICE_TOKEN)
- THERMOSTAT_TOKEN env: set to match thermostat device token

## Web client config
- File: TrackerPortal/public/firebase-config.js
  - firebaseConfig.* matches Firebase above
  - ingestConfig.url: https://us-central1-wurdemaniot.cloudfunctions.net/tyee_ingest
  - ingestConfig.deviceId: Tyee
  - ingestConfig.deviceToken: b7c9e2a41fd64e7d9f13c8a5
  - ingestConfig.thermostatId: home

## Thermostat device (ESP32 Nano) - folder device/thermostat
- WiFi primary SSID/PASS: Wurdeman Starlink 2.4 / Koda2020
- Authorized SSID for control: WurdemanIoT
- Admin login (local web UI): user admin, pass change-me
- AP SSID/PASS: Thermostat-Setup / (blank)
- Firmware defaults (setpoint/diff/mode): 70.0 F / 1.0 F / heat
- Timezone: default UTC; browser sets offset via /tz
- Control defaults: setpoint 70.0 F, diff 1.0 F, mode heat
- Fan timer epoch: stored in firmware (updates via cloud config)
- Cloud endpoints: THERMOSTAT_INGEST_URL=https://us-central1-wurdemaniot.cloudfunctions.net/thermostatIngest, THERMOSTAT_CONFIG_URL=https://us-central1-wurdemaniot.cloudfunctions.net/thermostatConfig
- Device token: THERMOSTAT_DEVICE_TOKEN (set in config/firmware_secrets.h)
- Firmware config source: config/firmware_secrets.h (shared; includes WiFi/admin/AP/auth tokens/defaults; included via PlatformIO build flags)
- Firmware source: device/thermostat/src/main.cpp; PlatformIO device/thermostat/platformio.ini
- Archived old .ino: device/thermostat/archived_thermostat_webui.ino

## Tyee tracker (cellular/Wi-Fi) - folder device/tyee
- Ingest URL: https://us-central1-wurdemaniot.cloudfunctions.net/tyee_ingest
- Config URL: https://us-central1-wurdemaniot.cloudfunctions.net/tyee_config
- Device ID: Tyee
- Device token: TYEE_DEVICE_TOKEN set in config/firmware_secrets.h (matches TYEE_TOKEN secret)
- WiFi SSID/PASS: set in config/firmware_secrets.h
- APN: hologram, user/pass blank
- Firmware source: (not present in repo; only build artifacts in .pio). Re-add source when available.
- Firmware secrets source: config/firmware_secrets.h (shared; included via PlatformIO build flags)

## Water Dispenser (ESP32 Nano) - folder device/water-dispenser
- No network creds needed (offline)
- Firmware source: device/water-dispenser/src/main.cpp
- PlatformIO config: device/water-dispenser/platformio.ini

## Dog House (ESP32, new)
- Firestore layout (planned): doghouse/main (state/config), doghouse/main/history/*, doghouse/main/food/*, doghouse/main/water/*
- Token: DOGHOUSE_DEVICE_TOKEN (config/firmware_secrets.h) must match Cloud Run env DOGHOUSE_TOKEN (non-secret, long token)
- Safety defaults: door open + fan off if temp > 200 F; door open if real feel > 100 F; fan on if real feel > 80 F; heater on if real feel < 50 F
- Outside data: reuse WU KNEBAYAR10 already ingested for thermostat
- UI route: #/doghouse (linked from Pets)
- Camera: placeholder for Wyze cam integration later

## Defaults (app / devices)
- Thermostat setpoint/diff defaults: 70 F / 1.0 F (see thermostat firmware)
- Thermostat schedule: empty by default (manual)
- Tyee geofence defaults (app DEFAULT_CONFIG): innerFt=250, outerFt=750, wifiRssiMin=-72; ping: homeSec=900, nearbySec=120, roamingSec=15; batteryUploadThreshold=25

## Paths to flash
- Thermostat: device/thermostat (PlatformIO: pio run -t upload)
- Tyee: device/tyee (add source; then PlatformIO build/upload)
- Water Dispenser: device/water-dispenser (PlatformIO: pio run -t upload)
- Dog House: device/doghouse (to be added; ESP32 DevKit)

## Notes
- Keep this file updated when tokens/keys/SSIDs change.
- Functions env vars must match device tokens (TYEE_TOKEN for Tyee tracker, THERMOSTAT_TOKEN for thermostat, DOGHOUSE_TOKEN for doghouse).
- Shared firmware secrets live in config/firmware_secrets.h.
