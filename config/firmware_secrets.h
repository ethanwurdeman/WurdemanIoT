#pragma once

// Shared firmware secrets for WurdemanIoT devices
// Keep this file private. Used by: device/thermostat, device/tyee.

// --- WiFi ---
#define WIFI_SSID "Wurdeman Starlink 2.4"
#define WIFI_PASSWORD "Koda2020"
#define AUTHORIZED_SSID "WurdemanIoT"
#define AP_SSID "Thermostat-Setup"
#define AP_PASSWORD ""

// --- Thermostat local auth ---
#define ADMIN_USER "admin"
#define ADMIN_PASSWORD "password"

// --- Thermostat (ESP32 Nano) ---
#define THERMOSTAT_DEVICE_ID "home"
#define THERMOSTAT_DEVICE_TOKEN "lksdg28722ln46llns7sdf"  // set to your thermostat token
#define THERMOSTAT_INGEST_URL "https://us-central1-wurdemaniot.cloudfunctions.net/thermostatIngest"
#define THERMOSTAT_CONFIG_URL "https://us-central1-wurdemaniot.cloudfunctions.net/thermostatConfig"
#define THERMOSTAT_DEFAULT_SETPOINT_F 70.0
#define THERMOSTAT_DEFAULT_DIFF_F 1.0
#define THERMOSTAT_DEFAULT_MODE "heat"  // heat, cool, fan, off

// --- Weather Underground (outside data) ---
#define WEATHER_STATION_ID ""      // e.g., "KNEBAYAR10"
#define WEATHER_API_KEY ""         // weather underground API key (leave blank and set via env where possible)

// --- Tyee tracker (T-SIM7080G-S3) ---
#define DEVICE_ID "Tyee"
#define TYEE_DEVICE_TOKEN "b7c9e2a41fd64e7d9f13c8a5"  // tracker ingest token (server secret TYEE_TOKEN)
#define TYEE_INGEST_URL "https://us-central1-wurdemaniot.cloudfunctions.net/tyee_ingest"
#define TYEE_CONFIG_URL "https://us-central1-wurdemaniot.cloudfunctions.net/tyee_config"
// Backward-compat aliases for older firmware references
#define DEVICE_TOKEN TYEE_DEVICE_TOKEN
#define INGEST_BASE_URL TYEE_INGEST_URL
#define CELL_APN "hologram"
#define CELL_APN_USER ""
#define CELL_APN_PASS ""
