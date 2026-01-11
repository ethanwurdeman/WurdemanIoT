# Water Dispenser (ESP32)

PlatformIO project for the water dispenser firmware (ESP32 Nano form factor).

## Hardware
- ESP32 Nano (arduino_nano_esp32)
- Buttons (active-low):
  - Push: D2
  - Confirm: D3
  - Back: D4
  - Up: D5
  - Down: D6
- Relay: D12
- OLED SSD1306 I2C at 0x3C (SDA/SCL default)

## Build / Upload
`
cd device/water-dispenser
pio run
pio run -t upload   # flash
pio device monitor -b 115200
`

## Notes
- Calibration stored in EEPROM: hold Up+Down 5s to save after filling.
- Amount selection supports tsp/Tbsp/cup/oz/gal (converted to cups internally).
- Original source: rduino_water_dispenser.ino (imported to PlatformIO here).
