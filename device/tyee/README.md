# Tyee Tracker Firmware

PlatformIO Arduino sketch for LilyGo T-SIM7080G-S3 (ESP32-S3 + SIM7080G + GNSS + SD). Device name: Tyee.

## Setup
1) Install PlatformIO Core or VS Code + PlatformIO extension.
2) Copy `include/secrets.h` and fill:
   - `WIFI_SSID` / `WIFI_PASS`
   - `DEVICE_ID` and `DEVICE_TOKEN` (must match Functions secret)
   - `INGEST_BASE_URL` (e.g. `https://us-central1-wurdemaniot.cloudfunctions.net/ingest`)
   - `CELL_APN` credentials for your SIM
3) Adjust pins if your board revision differs (see `MODEM_*` and `SD_CS_PIN` in `src/main.cpp`).

## Build / Upload
```
cd device/tyee
pio run          # build
pio run -t upload  # flash
pio device monitor -b 115200  # serial logs
```

## Behavior
- Pulls config from `/config` at boot and every 10 minutes.
- Modes: force (time-bound), home, nearby, roaming based on geofence radii (ft).
- Home: Wi-Fi only; logs locally if Wi-Fi unavailable.
- Nearby: Wi-Fi preferred; if RSSI < `wifiRssiMin` or no internet, sends current point over cellular.
- Roaming/force: cellular only.
- GNSS and cellular never run at the same time (GNSS on → fix → off → bring up data).
- Logs every point to `/logs/YYYYMMDD.jsonl`; unsent queue persisted at `/logs/unsent.jsonl`.
- Batch uploads (<=200 points) happen only on Wi-Fi and when battery >= `batteryUploadThreshold`; cellular sends only the current point.
