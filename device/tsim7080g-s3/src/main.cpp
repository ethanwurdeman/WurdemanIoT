#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>

#define TINY_GSM_MODEM_SIM7080
#include <TinyGsmClient.h>

#include <ArduinoJson.h>
#include <SD.h>
#include <SPI.h>
#include <time.h>
#include <vector>
#include <math.h>

#include "secrets.h"



#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

#define SerialMon Serial
#define SerialAT Serial1

constexpr uint32_t MODEM_BAUD = 115200;
constexpr uint8_t MODEM_RX_PIN = 4;
constexpr uint8_t MODEM_TX_PIN = 5;
constexpr uint8_t MODEM_PWRKEY_PIN = 41;

// Adjust these if your TF/SD wiring differs on the T-SIM7080G-S3.
constexpr uint8_t SD_CS_PIN = 10;

TinyGsm modem(SerialAT);
TinyGsmClientSecure modemClient(modem);
WiFiClientSecure wifiClient;

struct DeviceConfig {
  bool hasHome = false;
  double homeLat = 0;
  double homeLon = 0;
  uint32_t innerFt = 250;
  uint32_t outerFt = 750;
  int wifiRssiMin = -72;
  uint32_t pingHomeSec = 900;
  uint32_t pingNearbySec = 120;
  uint32_t pingRoamingSec = 15;
  uint8_t batteryUploadThreshold = 25;
  uint64_t forceRoamUntilMs = 0;
};

struct Point {
  double lat = 0;
  double lon = 0;
  uint64_t ts = 0;
  int battery = -1;
  int sats = -1;
  float hdop = -1;
  float speedMph = 0;
  float headingDeg = 0;
  String mode;
  String netKind;
  int rssi = 0;
  int csq = 0;
};

enum class TrackerMode { Home, Nearby, Roaming, Force };

static DeviceConfig currentConfig;
static std::vector<Point> unsent;
static uint64_t lastConfigFetchMs = 0;
static uint64_t nextPingDueMs = 0;
static uint64_t lastKnownTsMs = 0;
static bool sdReady = false;
static bool wifiReady = false;
static bool cellReady = false;
static uint64_t lastSendMs = 0;
static bool lastSendOk = false;
static TrackerMode lastMode = TrackerMode::Home;

// Forward declarations
bool ensureWifi();
void disconnectWifi();
bool ensureCellular();
void disconnectCellular();
bool fetchConfig(bool allowCellFallback);
bool wifiHasInternet();
Point captureGpsPoint();
bool postCurrentOverCell(const Point &pt);
bool postBatchOverWifi();
void appendPoint(const Point &pt);
void persistQueue();
void loadQueue();
double distanceFeet(double lat1, double lon1, double lat2, double lon2);
String modeToString(TrackerMode m);
void logStatus(const Point &pt, double distanceFt);
uint64_t toEpochMs(int year, int month, int day, int hour, int minute, int second);

int batteryPercent() {
  int pct = modem.getBattPercent();
  if (pct < 0 || pct > 100) return -1;
  return pct;
}

void powerPulseModem() {
  pinMode(MODEM_PWRKEY_PIN, OUTPUT);
  digitalWrite(MODEM_PWRKEY_PIN, LOW);
  delay(100);
  digitalWrite(MODEM_PWRKEY_PIN, HIGH);
  delay(1200);
  digitalWrite(MODEM_PWRKEY_PIN, LOW);
}

void setup() {
  SerialMon.begin(115200);
  delay(200);
  SerialMon.println("\nWurdemanIoT T-SIM7080G-S3 firmware starting...");

  wifiClient.setInsecure();

  SerialAT.begin(MODEM_BAUD, SERIAL_8N1, MODEM_RX_PIN, MODEM_TX_PIN);
  powerPulseModem();

  if (!modem.restart()) {
    SerialMon.println("Modem restart failed, continuing anyway.");
  }

  modemClient.setTimeout(15000);

  if (SD.begin(SD_CS_PIN)) {
    sdReady = true;
    SerialMon.println("SD card ready.");
    loadQueue();
  } else {
    SerialMon.println("SD init failed; running without SD logging.");
  }

  fetchConfig(true);
  lastSendMs = millis();
  nextPingDueMs = millis();
}

void loop() {
  const uint64_t now = millis();

  if (now >= lastConfigFetchMs + 10UL * 60UL * 1000UL) {
    fetchConfig(false);
  }

  if (now < nextPingDueMs) {
    delay(100);
    return;
  }

  Point pt = captureGpsPoint();

  TrackerMode mode = TrackerMode::Roaming;
  double distanceFt = 0.0;
  if (currentConfig.hasHome && pt.lat != 0 && pt.lon != 0) {
    distanceFt = distanceFeet(pt.lat, pt.lon, currentConfig.homeLat, currentConfig.homeLon);
  }

  if (pt.ts) {
    lastKnownTsMs = pt.ts;
  }
  const uint64_t nowEpoch = lastKnownTsMs ? lastKnownTsMs : millis();
  const uint64_t nowMs = millis();
  if (currentConfig.forceRoamUntilMs > nowEpoch) {
    mode = TrackerMode::Force;
  } else if (currentConfig.hasHome && distanceFt <= currentConfig.innerFt) {
    mode = TrackerMode::Home;
  } else if (currentConfig.hasHome && distanceFt <= currentConfig.outerFt) {
    mode = TrackerMode::Nearby;
  } else {
    mode = TrackerMode::Roaming;
  }
  lastMode = mode;

  uint32_t intervalSec = currentConfig.pingRoamingSec;
  if (mode == TrackerMode::Home) intervalSec = currentConfig.pingHomeSec;
  else if (mode == TrackerMode::Nearby) intervalSec = currentConfig.pingNearbySec;
  nextPingDueMs = nowMs + (uint64_t)intervalSec * 1000ULL;

  pt.mode = modeToString(mode);
  bool useCell = false;
  if (mode == TrackerMode::Home) {
    wifiReady = ensureWifi();
    useCell = !wifiReady;
  } else if (mode == TrackerMode::Nearby) {
    wifiReady = ensureWifi();
    useCell = !(wifiReady && WiFi.RSSI() >= currentConfig.wifiRssiMin && wifiHasInternet());
  } else {
    useCell = true;
  }

  pt.netKind = useCell ? "cell" : "wifi";
  pt.rssi = WiFi.status() == WL_CONNECTED ? WiFi.RSSI() : 0;
  appendPoint(pt);

  bool sent = false;
  if (mode == TrackerMode::Home && useCell) {
    SerialMon.println("Home mode but Wi-Fi unavailable; logging only.");
  } else if (useCell) {
    disconnectWifi();
    sent = postCurrentOverCell(pt);
  } else {
    sent = postBatchOverWifi();
  }

  if (sent) {
    lastSendMs = millis();
  }
  lastSendOk = sent;

  persistQueue();
  logStatus(pt, distanceFt);
}

bool ensureWifi() {
  if (WiFi.status() == WL_CONNECTED) {
    return true;
  }
  WiFi.disconnect(true);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);

  unsigned long start = millis();
  while (millis() - start < 10000UL) {
    if (WiFi.status() == WL_CONNECTED) {
      SerialMon.printf("Wi-Fi connected. RSSI: %d\n", WiFi.RSSI());
      return true;
    }
    delay(250);
  }
  SerialMon.println("Wi-Fi connect timeout.");
  return false;
}

void disconnectWifi() {
  WiFi.disconnect(true);
}

bool wifiHasInternet() {
  if (WiFi.status() != WL_CONNECTED) return false;

  HTTPClient http;
  http.setTimeout(4000);

  String url = String(INGEST_BASE_URL) + "/config?deviceId=" + DEVICE_ID + "&ping=1";
  if (!http.begin(url)) {
    return false;
  }
  int code = http.sendRequest("HEAD");
  http.end();
  return code > 0;
}

bool ensureCellular() {
  if (cellReady && modem.isNetworkConnected() && modem.isGprsConnected()) {
    return true;
  }

  modem.gprsDisconnect();
  if (!modem.waitForNetwork(60000L)) {
    SerialMon.println("Network attach failed.");
    return false;
  }
  if (!modem.gprsConnect(CELL_APN, CELL_APN_USER, CELL_APN_PASS)) {
    SerialMon.println("GPRS connect failed.");
    return false;
  }
  cellReady = true;
  return true;
}

void disconnectCellular() {
  modem.gprsDisconnect();
  cellReady = false;
}

bool fetchConfig(bool allowCellFallback) {
  HTTPClient http;
  String url = String(INGEST_BASE_URL) + "/config?deviceId=" + DEVICE_ID;

  bool usedWifi = ensureWifi();
  bool usedCell = false;

  if (!usedWifi && allowCellFallback) {
    disconnectWifi();
    if (!ensureCellular()) {
      SerialMon.println("Config fetch skipped (no network).");
      return false;
    }
    usedCell = true;
  } else if (!usedWifi && !allowCellFallback) {
    return false;
  }

  Client *client = usedWifi ? (Client *)&wifiClient : (Client *)&modemClient;
  if (!usedWifi && usedCell) {
    modemClient.setTimeout(15000);
  }
  if (!http.begin(url)) {
    SerialMon.println("HTTP begin failed for config.");
    return false;
  }
  http.addHeader("X-Device-Token", DEVICE_TOKEN);
  int code = http.GET();
  if (code == HTTP_CODE_OK) {
    DynamicJsonDocument doc(1024);
    DeserializationError err = deserializeJson(doc, http.getStream());
    if (!err) {
      JsonObject cfg = doc["config"].as<JsonObject>();
      if (!cfg.isNull()) {
     JsonObject geofence = cfg["geofence"].as<JsonObject>();
     if (!geofence.isNull()) {
     currentConfig.innerFt = geofence["innerFt"] | currentConfig.innerFt;
     currentConfig.outerFt = geofence["outerFt"] | currentConfig.outerFt;
     }

     JsonObject home = cfg["home"].as<JsonObject>();
      if (!home.isNull() && home["lat"].is<double>() && home["lon"].is<double>()) {
     currentConfig.homeLat = home["lat"].as<double>();
      currentConfig.homeLon = home["lon"].as<double>();
      currentConfig.hasHome = true;
     }

     currentConfig.wifiRssiMin = cfg["wifiRssiMin"] | currentConfig.wifiRssiMin;

     JsonObject ping = cfg["ping"].as<JsonObject>();
     if (!ping.isNull()) {
     currentConfig.pingHomeSec   = ping["homeSec"]   | currentConfig.pingHomeSec;
      currentConfig.pingNearbySec = ping["nearbySec"] | currentConfig.pingNearbySec;
     currentConfig.pingRoamingSec= ping["roamingSec"]| currentConfig.pingRoamingSec;
     }

       currentConfig.batteryUploadThreshold =
      cfg["batteryUploadThreshold"] | currentConfig.batteryUploadThreshold;

      if (cfg["forceRoamUntil"].is<int64_t>()) {
        currentConfig.forceRoamUntilMs = (uint64_t)cfg["forceRoamUntil"].as<int64_t>();
      } else {
      currentConfig.forceRoamUntilMs = 0;
    }

      SerialMon.println("Config updated from server.");
    }

    } else {
      SerialMon.printf("Config JSON parse error: %s\n", err.c_str());
    }
  } else {
    SerialMon.printf("Config fetch failed: %d\n", code);
  }
  http.end();
  lastConfigFetchMs = millis();
  if (usedCell) {
    disconnectCellular();
  }
  return true;
}

Point captureGpsPoint() {
  Point pt;
  disconnectCellular(); // ensure GNSS alone

  modem.enableGPS();
  unsigned long start = millis();
  float lat = 0, lon = 0, speed = 0, alt = 0, hdop = 0;
  int vsat = 0, usat = 0;
  int year = 0, month = 0, day = 0, hour = 0, minute = 0, second = 0;
  bool gotFix = false;

  while (millis() - start < 20000UL) {
    if (modem.getGPS(&lat, &lon, &speed, &alt, &vsat, &usat, &hdop, &year, &month, &day, &hour, &minute, &second)) {
      gotFix = true;
      break;
    }
    delay(500);
  }

  modem.disableGPS();

  if (gotFix) {
    pt.lat = lat;
    pt.lon = lon;
    pt.sats = usat;
    pt.hdop = hdop;
    pt.speedMph = speed * 1.15078f;
    pt.ts = toEpochMs(year, month, day, hour, minute, second);
  } else {
    pt.ts = millis();
  }
  pt.battery = batteryPercent();
  pt.csq = modem.getSignalQuality();
  return pt;
}

String pointToJson(const Point &pt) {
  String json;
  json.reserve(256);
  json += "{\"lat\":";
  json += String(pt.lat, 6);
  json += ",\"lon\":";
  json += String(pt.lon, 6);
  json += ",\"ts\":";
  json += String((uint64_t)pt.ts);
  json += ",\"battery\":";
  json += pt.battery >= 0 ? String(pt.battery) : "null";
  json += ",\"sats\":";
  json += pt.sats;
  json += ",\"hdop\":";
  json += String(pt.hdop, 2);
  json += ",\"speedMph\":";
  json += String(pt.speedMph, 2);
  json += ",\"headingDeg\":";
  json += String(pt.headingDeg, 1);
  json += ",\"netKind\":\"";
  json += pt.netKind;
  json += "\"";
  json += ",\"csq\":";
  json += pt.csq;
  json += ",\"rssi\":";
  json += pt.rssi;
  json += ",\"mode\":\"";
  json += pt.mode;
  json += "\"}";
  return json;
}

bool postJson(const String &path, const String &body) {
  HTTPClient http;
  http.setTimeout(15000);

  String url = String(INGEST_BASE_URL) + path;
  if (!http.begin(url)) {
    SerialMon.println("HTTP begin failed.");
    return false;
  }

  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Device-Token", DEVICE_TOKEN);

  int code = http.POST(body);

  if (code > 0) {
    SerialMon.printf("POST %s -> %d\n", path.c_str(), code);
  } else {
    SerialMon.printf("POST %s failed: %s\n", path.c_str(), http.errorToString(code).c_str());
  }

  bool ok = code == HTTP_CODE_OK || code == HTTP_CODE_CREATED || code == HTTP_CODE_ACCEPTED || code == HTTP_CODE_NO_CONTENT;
  http.end();
  return ok;
}

bool postCurrentOverCell(const Point &pt) {
  if (!ensureCellular()) {
    return false;
  }
  String body = "{\"deviceId\":\"";
  body += DEVICE_ID;
  body += "\",\"points\":[";
  body += pointToJson(pt);
  body += "]}";
bool ok = postJson("/ingest", body);
  if (ok && !unsent.empty()) {
    unsent.pop_back(); // remove the current point from queue
  }
  disconnectCellular();
  return ok;
}

bool postBatchOverWifi() {
  if (!ensureWifi()) return false;
  const int battery = batteryPercent();
  if (battery >= 0 && battery < currentConfig.batteryUploadThreshold) {
    SerialMon.println("Battery low; deferring batch upload.");
    return false;
  }

  size_t total = unsent.size();
  if (!total) return true;

  size_t idx = 0;
  while (idx < total) {
    size_t chunk = min<size_t>(200, total - idx);
    String body;
    body.reserve(128 + chunk * 128);
    body += "{\"deviceId\":\"";
    body += DEVICE_ID;
    body += "\",\"points\":[";
    for (size_t i = 0; i < chunk; ++i) {
      if (i) body += ",";
      body += pointToJson(unsent[idx + i]);
    }
    body += "]}";
    wifiClient.setInsecure();
    if (!postJson("/ingest", body)) {
      return false;
    }
    idx += chunk;
  }

  unsent.clear();
  return true;
}

void appendPoint(const Point &pt) {
  unsent.push_back(pt);
  if (unsent.size() > 500) {
    unsent.erase(unsent.begin());
  }

  if (sdReady) {
    char path[32];
    time_t t = pt.ts / 1000;
    tm *utc = gmtime(&t);
    snprintf(path, sizeof(path), "/logs/%04d%02d%02d.jsonl",
             utc ? utc->tm_year + 1900 : 1970,
             utc ? utc->tm_mon + 1 : 1,
             utc ? utc->tm_mday : 1);
    SD.mkdir("/logs");
    File f = SD.open(path, FILE_APPEND);
    if (f) {
      f.println(pointToJson(pt));
      f.close();
    }
  }
}

void loadQueue() {
  if (!sdReady) return;
  File f = SD.open("/logs/unsent.jsonl");
  if (!f) return;
  while (f.available()) {
    String line = f.readStringUntil('\n');
    if (line.length() < 5) continue;
    DynamicJsonDocument doc(256);
    if (deserializeJson(doc, line) == DeserializationError::Ok) {
      Point pt;
      pt.lat = doc["lat"] | 0.0;
      pt.lon = doc["lon"] | 0.0;
      pt.ts = doc["ts"] | 0;
      pt.battery = doc["battery"] | -1;
      pt.sats = doc["sats"] | -1;
      pt.hdop = doc["hdop"] | -1.0;
      pt.speedMph = doc["speedMph"] | 0.0;
      pt.headingDeg = doc["headingDeg"] | 0.0;
      pt.mode = String(doc["mode"] | "unknown");
      unsent.push_back(pt);
    }
  }
  f.close();
}

void persistQueue() {
  if (!sdReady) return;
  SD.mkdir("/logs");
  SD.remove("/logs/unsent.jsonl");
  File f = SD.open("/logs/unsent.jsonl", FILE_WRITE);
  if (!f) return;
  for (const auto &pt : unsent) {
    f.println(pointToJson(pt));
  }
  f.close();
}

time_t portableTimegm(struct tm *t) {
#if defined(_WIN32)
  return _mkgmtime(t);
#else
  time_t local = mktime(t);
  if (local == static_cast<time_t>(-1)) return static_cast<time_t>(-1);
  struct tm *gt = gmtime(&local);
  if (!gt) return static_cast<time_t>(-1);
  time_t utc = mktime(gt);
  if (utc == static_cast<time_t>(-1)) return static_cast<time_t>(-1);
  double offset = difftime(local, utc);
  return local + static_cast<time_t>(offset);
#endif
}

uint64_t toEpochMs(int year, int month, int day, int hour, int minute, int second) {
  if (year < 1970 || month < 1 || day < 1) {
    return millis();
  }
  struct tm t = {};
  t.tm_year = year - 1900;
  t.tm_mon = month - 1;
  t.tm_mday = day;
  t.tm_hour = hour;
  t.tm_min = minute;
  t.tm_sec = second;
  time_t ts = portableTimegm(&t);
  if (ts < 0) {
    return millis();
  }
  return static_cast<uint64_t>(ts) * 1000ULL;
}

double distanceFeet(double lat1, double lon1, double lat2, double lon2) {
  if (lat1 == 0 && lon1 == 0) return 0;
  const double R = 6371000.0;
  auto toRad = [](double deg) { return deg * M_PI / 180.0; };
  double dLat = toRad(lat2 - lat1);
  double dLon = toRad(lon2 - lon1);
  double a = sin(dLat / 2) * sin(dLat / 2) +
             cos(toRad(lat1)) * cos(toRad(lat2)) *
             sin(dLon / 2) * sin(dLon / 2);
  double c = 2 * atan2(sqrt(a), sqrt(1 - a));
  return R * c * 3.28084;
}

String modeToString(TrackerMode m) {
  switch (m) {
    case TrackerMode::Home: return "home";
    case TrackerMode::Nearby: return "nearby";
    case TrackerMode::Roaming: return "roaming";
    case TrackerMode::Force: return "force";
  }
  return "unknown";
}

void logStatus(const Point &pt, double distanceFt) {
  uint64_t now = millis();
  SerialMon.printf(
      "mode=%s dist=%.1fft wifi=%s rssi=%d cellCSQ=%d queue=%u lastSendOk=%s lastPingAgo=%lus\n",
      pt.mode.c_str(),
      distanceFt,
      WiFi.status() == WL_CONNECTED ? "on" : "off",
      WiFi.status() == WL_CONNECTED ? WiFi.RSSI() : 0,
      pt.csq,
      static_cast<unsigned>(unsent.size()),
      lastSendOk ? "yes" : "no",
      static_cast<unsigned>((now - lastSendMs) / 1000));
}
