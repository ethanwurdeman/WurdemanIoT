#pragma once

// APN credentials for cellular attach/PDP context
static const char *APN        = "hologram";
static const char *APN_USER   = "";
static const char *APN_PASS   = "";

// Serial settings
constexpr uint32_t MODEM_BAUD           = 115200;
constexpr uint8_t  MODEM_SERIAL_RX      = 4;
constexpr uint8_t  MODEM_SERIAL_TX      = 5;
constexpr uint8_t  MODEM_PWRKEY_PIN     = 41;

// I2C pins for the AXP2101 PMU on the T-SIM7080G S3
constexpr uint8_t I2C_SDA_PIN = 15;
constexpr uint8_t I2C_SCL_PIN = 7;

// Timing knobs
constexpr uint32_t AT_WAIT_MS           = 1000;
constexpr uint8_t  AT_RETRY_LIMIT       = 15;
constexpr uint32_t REGISTRATION_TIMEOUT = 120000;  // ms to wait for network registration
constexpr uint32_t PDP_ACTIVE_MS        = 10000;   // how long to hold PDP up before teardown
constexpr uint32_t GNSS_FIX_TIMEOUT_MS  = 120000;  // timeout while waiting for a fix
constexpr uint32_t CYCLE_PAUSE_MS       = 5000;    // idle delay between cycles
constexpr uint32_t CELLULAR_PERIOD_MS   = 60000;   // delay after cellular cycle before GNSS
constexpr uint32_t GNSS_PERIOD_MS       = 60000;   // delay after GNSS cycle before cellular

// Enable verbose AT logging to the USB serial console
#define ENABLE_AT_DEBUG 0
