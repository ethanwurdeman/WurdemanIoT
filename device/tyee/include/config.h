#pragma once

// Board pin map for LilyGO T-SIM7080G S3 (adjust if your revision differs)
#ifndef MODEM_SERIAL_TX
#define MODEM_SERIAL_TX 5  // LilyGo T-SIM7080G S3 default
#endif
#ifndef MODEM_SERIAL_RX
#define MODEM_SERIAL_RX 4
#endif
#ifndef MODEM_PWRKEY_PIN
#define MODEM_PWRKEY_PIN 41
#endif
#ifndef MODEM_DTR_PIN
#define MODEM_DTR_PIN 42
#endif
#ifndef MODEM_RI_PIN
#define MODEM_RI_PIN 3
#endif
#ifndef MODEM_BAUD
#define MODEM_BAUD 115200
#endif

#ifndef I2C_SDA_PIN
#define I2C_SDA_PIN 15
#endif
#ifndef I2C_SCL_PIN
#define I2C_SCL_PIN 7
#endif

// GNSS / modem timing
#ifndef AT_WAIT_MS
#define AT_WAIT_MS 2000
#endif
#ifndef AT_RETRY_LIMIT
#define AT_RETRY_LIMIT 20
#endif
#ifndef REGISTRATION_TIMEOUT
#define REGISTRATION_TIMEOUT 60000UL
#endif
#ifndef PDP_ACTIVE_MS
#define PDP_ACTIVE_MS 3000UL
#endif
#ifndef GNSS_FIX_TIMEOUT_MS
#define GNSS_FIX_TIMEOUT_MS 60000UL
#endif

// APN (Hologram default)
#ifndef APN
#define APN "hologram"
#endif

// Wi-Fi creds (fallback if not provided via firmware_secrets.h)
#ifndef WIFI_SSID
#define WIFI_SSID "Wurdeman Starlink 2.4"
#endif
#ifndef WIFI_PASSWORD
#define WIFI_PASSWORD "Koda2020"
#endif

// Device identity/token (replace with your values or include firmware_secrets.h)
#ifndef DEVICE_ID
#define DEVICE_ID "Tyee"
#endif
#ifndef DEVICE_TOKEN
#define DEVICE_TOKEN "b7c9e2a41fd64e7d9f13c8a5"
#endif

// Ingest URL
#ifndef INGEST_BASE_URL
#define INGEST_BASE_URL "https://us-central1-wurdemaniot.cloudfunctions.net/tyee_ingest"
#endif

// Enable AT debug (0/1)
#ifndef ENABLE_AT_DEBUG
#define ENABLE_AT_DEBUG 0
#endif
