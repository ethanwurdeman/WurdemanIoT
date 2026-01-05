# TrackerAttempt2 (LilyGO T-SIM7080G S3)

Minimal, repeatable baseline firmware for the T-SIM7080G S3 (SIM7080G + ESP32-S3) using PlatformIO + Arduino. It brings up the PMU, proves UART/AT communication, verifies SIM/registration, exercises PDP attach, and alternates cellular and GNSS (never at the same time).

## Hardware pins
- Modem UART: RX=4, TX=5 @ 115200 baud
- Modem PWRKEY/enable: GPIO41 (active high pulse)
- PMU (AXP2101) I2C: SDA=15, SCL=7
- GNSS antenna rail: PMU BLDO2 (software-controlled)
- BLDO1 is kept ON to avoid the rail being shut off during bring-up

## Build and flash
```
pio run
pio run -t upload
pio device monitor -b 115200
```

## Configuration
- Edit `include/config.h` for APN/user/pass, timing, and AT debug (`ENABLE_AT_DEBUG`).
- PlatformIO env: `platformio.ini` → env `trackerattempt2` (esp32-s3-devkitc-1, Arduino, TinyGSM, XPowersLib).

## Runtime behavior
1) Boot: prints board + pin map, initializes PMU (DC3, BLDO1 on; BLDO2 staged for GNSS), starts Serial1 on RX4/TX5, pulses PWRKEY (GPIO41), retries AT with backoff.  
2) Cellular phase: GNSS off, CFUN=1, CPIN?, CSQ, CEREG/CREG/COPS, waits for registration, sets APN, attaches/activates PDP, prints IP, holds PDP ~10s, then detaches.  
3) GNSS phase: PDP disconnected, CFUN=0, enables BLDO2 + GNSS, waits up to 120s for fix, prints lat/lon/alt/sats/hdop/UTC, disables GNSS + BLDO2.  
4) Loops between phases with configurable delays; non-blocking except bounded waits/timeouts.

## Expected serial output (happy path)
```
Board: LilyGO T-SIM7080G S3
Pin map:
  MODEM RXD: 4
  MODEM TXD: 5
  MODEM PWR: 41
  I2C SDA  : 15
  I2C SCL  : 7
PMU rails: DC3=ON (3000 mV), BLDO1=ON (3300 mV)
Bringing up modem UART...
AT response OK
CPIN: +CPIN: READY
CSQ: 18
CEREG/CREG status: 1
AT+CEREG?: +CEREG: 0,1
AT+CREG?: +CREG: 0,1
Operator: +COPS: 0,0,"<carrier>",9
Network registration OK
PDP active. IP: 10.x.x.x
PDP deactivated and detached.
=== GNSS mode ===
GNSS on. Waiting for fix...
GNSS fix acquired:
  Lat: ...
  Lon: ...
  Alt: ...
  Speed: ...
  Sats(v/u): 16/9
  HDOP/acc: 1.2
  UTC: 2025-01-03 18:23:05
GNSS off.
```

## Troubleshooting
- AT timeouts: confirm UART pins (RX=4, TX=5), monitor shows AT retries; check USB serial wiring; ensure PMU init succeeded and DC3 is on. Power-pulse modem (GPIO41) and verify BLDO1 stays enabled (default in code).
- No SIM / CPIN errors: reseat SIM, ensure no PIN lock.
- Registration stuck: check antenna, signal (CSQ), and verify APN; try moving outdoors for NB/Cat-M1 coverage.
- GNSS never fixes: ensure PDP is disconnected first, GNSS antenna connected, clear view of sky; BLDO2 is toggled on only during GNSS phase.
