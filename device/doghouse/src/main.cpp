#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include "firmware_secrets.h"

static const char *DEVICE_ID = DOGHOUSE_DEVICE_ID;
static const char *TOKEN = DOGHOUSE_DEVICE_TOKEN;
static const char *INGEST_URL = DOGHOUSE_INGEST_URL;

void connectWifi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 15000) {
    delay(250);
  }
}

void postStatus() {
  if (WiFi.status() != WL_CONNECTED) return;
  HTTPClient http;
  http.begin(INGEST_URL);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Device-Id", DEVICE_ID);
  http.addHeader("X-Device-Token", TOKEN);
  // Minimal payload scaffold; replace with real sensors.
  String body = String("{\"deviceId\":\"") + DEVICE_ID + "\",\"token\":\"" + TOKEN + "\",\"status\":{"
                "\"tempF\":0,\"humidity\":0,\"heatIndexF\":0,"
                "\"doorOpen\":false,\"fanOn\":false,\"heaterOn\":false,"
                "\"ts\":" + String((uint64_t) (millis() + 1700000000000ULL)) + "}}";
  http.POST(body);
  http.end();
}

void setup() {
  Serial.begin(115200);
  connectWifi();
}

void loop() {
  static unsigned long last = 0;
  if (millis() - last > 120000) { // 2 min heartbeat
    postStatus();
    last = millis();
  }
  delay(100);
}
