# Thermostat Web UI Firmware

Arduino sketch for an ESP32 thermostat with DHT22, OLED, relay control, scheduling, SD logging, and a built-in web UI.

## Hardware
- ESP32 (Arduino core)
- DHT22 on D2
- Relays: Heat D12, Cool D6, Fan D7
- OLED I2C: SDA A5, SCL A4
- Buttons removed (UI-only control for now)
- SD (SPI): CS D10, SCK D13, MOSI D11, MISO D12

## Build / Upload
1) Open this folder in PlatformIO.
2) Update `include/secrets.h` with WiFi credentials and device token.
3) Check `platformio.ini` for the correct board and serial port.
4) Build and upload.

## Notes
- Web UI endpoints: `/thermostat`, `/status`, `/set`, `/schedule`, `/history`, `/system_status`.
- Serial logging includes SD diagnostics and health snapshots for debugging.
- Firmware syncs status/history to Firebase and pulls config/schedule from `thermostatIngest` and `thermostatConfig`.
