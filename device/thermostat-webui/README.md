# Thermostat Web UI Firmware

Arduino sketch for an ESP32 thermostat with DHT22, OLED, relay control, scheduling, SD logging, and a built-in web UI.

## Hardware
- ESP32 (Arduino core)
- DHT22 on D10
- Relays: Heat D12, Cool D6, Fan D7
- OLED I2C: SDA A4, SCL A5
- Buttons (INPUT_PULLUP): OK D2, Back D3, Up D4, Down D5
- SD (SPI): CS D8, SCK D13, MOSI D11, MISO D9

## Build / Upload
1) Open `thermostat_webui.ino` in the Arduino IDE.
2) Update WiFi credentials and pins if needed.
3) Select your ESP32 board and flash.

## Notes
- Web UI endpoints: `/thermostat`, `/status`, `/set`, `/schedule`, `/history`, `/system_status`.
- Serial logging includes SD diagnostics and health snapshots for debugging.
