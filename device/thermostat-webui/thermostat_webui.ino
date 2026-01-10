#include <Arduino.h>
#include <WiFi.h>
#include <WebServer.h>
#include <Preferences.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <time.h>
#include "DHT.h"
#include <SPI.h>
#include <SD.h>

// === User config ===
const char *WIFI_SSID     = "Wurdeman Starlink 2.4";
const char *WIFI_PASSWORD = "Koda2020";
const char *AUTHORIZED_SSID = "WurdemanIoT"; // network required for control changes
const char *ADMIN_USER = "admin";
const char *ADMIN_PASSWORD = "change-me";
const char *AP_SSID = "Thermostat-Setup";
const char *AP_PASSWORD = "";
const char *HEADER_KEYS[] = {"Cookie"};
const size_t HEADER_KEYS_COUNT = 1;

// Pins (board labels)
const int HEAT_PIN = D12; // heat relay output (moved from D5)
const int COOL_PIN = D6;  // cool relay output
const int FAN_PIN  = D7;  // fan relay output
const int DHT_PIN  = D10; // DHT22 data
const int I2C_SDA  = A4;  // OLED SDA
const int I2C_SCL  = A5;  // OLED SCL

// Buttons (active LOW, INPUT_PULLUP)
const int BTN_OK   = D2;
const int BTN_BACK = D3;
const int BTN_UP   = D4;
const int BTN_DOWN = D5;

// Relay polarity: set to true if HIGH turns the relay ON, false if LOW turns it ON
const bool RELAY_ACTIVE_HIGH = true;

// Time config (seconds offset from UTC); defaults to 0, set dynamically from web client
long tzOffsetSec = 0;
int dstOffsetSec = 0;

const unsigned long WIFI_CONNECT_TIMEOUT_MS = 15000;
const unsigned long WIFI_RECONNECT_INTERVAL_MS = 30000;

// Control defaults
float setpointF = 70.0; // target temperature in Fahrenheit
float diffF     = 1.0;  // hysteresis differential
String mode     = "heat"; // heat, cool, fan, off
uint8_t fanRequestMinutes = 0; // pending fan timer request (minutes)

// Anti-short-cycle timings (ms)
const unsigned long MIN_ON_TIME_MS  = 600000;  // 10 minutes minimum ON
const unsigned long MIN_OFF_TIME_MS = 1800000; // 30 minutes minimum OFF
// SD card (SPI) wiring: CS=D8, SCK=D13, MOSI=D11, MISO=D9
const int SD_CS   = 8;
const int SD_SCK  = 13;
const int SD_MOSI = 11;
const int SD_MISO = 9;
bool sdReady = false;
const bool DEBUG_SERIAL = true;
const unsigned long HEALTH_LOG_INTERVAL_MS = 30000;
const unsigned long SENSOR_FAIL_LOG_INTERVAL_MS = 10000;
unsigned long lastHealthLog = 0;
unsigned long lastSensorFailLog = 0;
unsigned long lastSdWriteMs = 0;
bool lastSdWriteOk = true;
const char* lastSdError = "none";
unsigned long sdWriteFailures = 0;

// OLED setup
#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, -1);
bool displayReady = false;

// DHT setup
DHT dht(DHT_PIN, DHT22);

WebServer server(80);
Preferences prefs;

String wifiSsid;
String wifiPass;
bool wifiConnected = false;
bool apMode = false;
String wifiIpStr = "0.0.0.0";
unsigned long lastWifiReconnect = 0;

String sessionToken;
unsigned long sessionStartMs = 0;
const unsigned long SESSION_TTL_MS = 12UL * 60UL * 60UL * 1000UL;

// State
bool heatOn = false;
bool coolOn = false;
bool fanOn  = false;
unsigned long lastHeatToggle = 0;
unsigned long lastCoolToggle = 0;
unsigned long fanRunUntil = 0;
float lastTempF = NAN;
float lastHumidity = NAN;
float lastHeatIndexF = NAN;
unsigned long lastRead = 0;
const unsigned long READ_INTERVAL_MS = 2000;
unsigned long lastDisplay = 0;
const unsigned long DISPLAY_INTERVAL_MS = 300; // quicker display refresh to reduce button lag perception
float scheduleSP[7][24]; // NaN means no schedule entry
int lastScheduleHour = -1;
bool overrideUntilNextSchedule = false;
int overrideStartHour = -1;
// History logging (setpoint vs control temperature, 1-min samples, up to 7 days)
const unsigned long HISTORY_INTERVAL_MS = 60000;
const int HIST_MAX = 10080; // 7 days at 1-minute resolution
float histTemp[HIST_MAX];
float histSet[HIST_MAX];
uint32_t histTs[HIST_MAX];
int histCount = 0;
int histIndex = 0;
unsigned long lastHistLog = 0;

String fmtBytes(uint64_t b) {
  if (b >= (1ULL << 30)) return String((float)b / (1 << 30), 2) + " GB";
  if (b >= (1ULL << 20)) return String((float)b / (1 << 20), 1) + " MB";
  if (b >= (1ULL << 10)) return String((float)b / (1 << 10), 1) + " KB";
  return String((unsigned long)b) + " B";
}

// Menu / buttons
enum MenuState { VIEW, MENU_MODE, MENU_SET, MENU_DIFF };
MenuState menuState = VIEW;
int modeIndex = 0; // 0 heat,1 cool,2 fan,3 off
const char* modes[] = {"heat","cool","fan","off"};
bool lastOk = HIGH, lastBack = HIGH, lastUp = HIGH, lastDown = HIGH;
unsigned long lastBtnChange = 0;
const unsigned long DEBOUNCE_MS = 50;

void handleThermostat();
void handleSchedule();
void handleScheduleData();
void handleHistory();
void handleHistoryData();
void handleSystemStatus();
void handleSystemStatusData();
void handleSet();
void handleStatus();
void handleTz();
void handleWifiPage();
void handleWifiSave();
void handleLogin();
void handleLogout();
void setOutput(int pin, bool on);
void updateDisplay();
void handleButtons();
void cycleMode(int dir);
void logHealth();
void logSdCardInfo(const char* context);
void sdWriteTest();
const char* sdTypeToString(uint8_t type);
void loadWifiCredentials();
bool connectWiFiWithTimeout(unsigned long timeoutMs);
void startWiFi();
void startAp();
void updateWiFiStatus();
bool isAuthenticated();
bool onAuthorizedNetwork();
bool canControl();
bool requireControlAuth();
String makeToken();

void setup() {
  Serial.begin(115200);
  pinMode(HEAT_PIN, OUTPUT);
  pinMode(COOL_PIN, OUTPUT);
  pinMode(FAN_PIN, OUTPUT);
  pinMode(BTN_OK, INPUT_PULLUP);
  pinMode(BTN_BACK, INPUT_PULLUP);
  pinMode(BTN_UP, INPUT_PULLUP);
  pinMode(BTN_DOWN, INPUT_PULLUP);
  setOutput(HEAT_PIN, false);
  setOutput(COOL_PIN, false);
  setOutput(FAN_PIN, false);
  lastHeatToggle = millis() - MIN_OFF_TIME_MS; // allow first cycle immediately
  lastCoolToggle = millis() - MIN_OFF_TIME_MS;

  // Sync mode index
  for (int i = 0; i < 4; i++) {
    if (mode == modes[i]) { modeIndex = i; break; }
  }
  for (int d = 0; d < 7; d++) {
    for (int h = 0; h < 24; h++) scheduleSP[d][h] = NAN;
  }
  for (int i = 0; i < HIST_MAX; i++) {
    histTemp[i] = NAN;
    histSet[i] = NAN;
    histTs[i] = 0;
  }

  dht.begin();

  Wire.begin(I2C_SDA, I2C_SCL);
  Serial.println("I2C scan...");
  for (byte addr = 1; addr < 127; addr++) {
    Wire.beginTransmission(addr);
    if (Wire.endTransmission() == 0) {
      Serial.print("Found I2C device at 0x");
      Serial.println(addr, HEX);
    }
  }
  if (display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {
    displayReady = true;
    display.clearDisplay();
    display.setTextSize(1);
    display.setTextColor(SSD1306_WHITE);
    display.setCursor(0, 0);
    display.println("Thermostat booting");
    display.display();
  } else {
    Serial.println("SSD1306 init failed (check wiring/address)");
  }

  prefs.begin("wifi", false);
  loadWifiCredentials();
  startWiFi();

  // SD card init (using explicit SPI pins)
  SPI.begin(SD_SCK, SD_MISO, SD_MOSI, SD_CS);
  if (DEBUG_SERIAL) {
    Serial.printf("SD SPI pins: CS=%d SCK=%d MISO=%d MOSI=%d\n", SD_CS, SD_SCK, SD_MISO, SD_MOSI);
  }
  if (SD.begin(SD_CS)) {
    sdReady = true;
    Serial.println("SD card mounted");
    logSdCardInfo("SD init");
    sdWriteTest();
  } else {
    sdReady = false;
    Serial.println("SD init failed (check wiring/format)");
  }

  server.on("/", [](){ server.sendHeader("Location", "/thermostat"); server.send(302, "text/plain", ""); });
  server.on("/thermostat", handleThermostat);
  server.on("/schedule", handleSchedule);
  server.on("/schedule_data", handleScheduleData);
  server.on("/history", handleHistory);
  server.on("/history_data", handleHistoryData);
  server.on("/system_status", handleSystemStatus);
  server.on("/system_status_data", handleSystemStatusData);
  server.on("/set", handleSet);
  server.on("/status", handleStatus);
  server.on("/tz", handleTz);
  server.on("/wifi", HTTP_GET, handleWifiPage);
  server.on("/wifi", HTTP_POST, handleWifiSave);
  server.on("/login", HTTP_GET, handleLogin);
  server.on("/login", HTTP_POST, handleLogin);
  server.on("/logout", handleLogout);
  server.collectHeaders(HEADER_KEYS, HEADER_KEYS_COUNT);
  server.begin();
}

void loop() {
  server.handleClient();
  updateWiFiStatus();

  unsigned long now = millis();
  if (now - lastRead >= READ_INTERVAL_MS) {
    lastRead = now;
    float t = dht.readTemperature(true); // true = Fahrenheit
    float h = dht.readHumidity();
    if (DEBUG_SERIAL && (isnan(t) || isnan(h))) {
      if (now - lastSensorFailLog >= SENSOR_FAIL_LOG_INTERVAL_MS) {
        Serial.printf("[SENSOR] DHT read failed. t=%s h=%s\n",
                      isnan(t) ? "NaN" : String(t, 1).c_str(),
                      isnan(h) ? "NaN" : String(h, 1).c_str());
        lastSensorFailLog = now;
      }
    }
    if (!isnan(t)) lastTempF = t;
    if (!isnan(h)) lastHumidity = h;
    if (!isnan(lastTempF) && !isnan(lastHumidity)) {
      lastHeatIndexF = dht.computeHeatIndex(lastTempF, lastHumidity, true); // real feel
    } else {
      lastHeatIndexF = NAN;
    }

    // Apply schedule setpoint if available (respect manual override until next schedule block)
    struct tm timeinfo;
    if (getLocalTime(&timeinfo)) {
      int d = timeinfo.tm_wday; // 0=Sunday
      int h = timeinfo.tm_hour;
      if (d >= 0 && d < 7 && h >= 0 && h < 24) {
        float sp = scheduleSP[d][h];
        if (overrideUntilNextSchedule) {
          if (overrideStartHour < 0) overrideStartHour = h;
          if (!isnan(sp) && h != overrideStartHour) {
            setpointF = sp;
            lastScheduleHour = h;
            overrideUntilNextSchedule = false;
          }
        } else {
          if (!isnan(sp) && (lastScheduleHour != h)) {
            setpointF = sp;
            lastScheduleHour = h;
          }
        }
      }
    }

    // Control temperature: prefer real-feel, fall back to actual
    float ctlTemp = !isnan(lastHeatIndexF) ? lastHeatIndexF : lastTempF;

    // Hysteresis thresholds (half the diff)
    float onThresholdHeat  = setpointF - (diffF * 0.5f);
    float offThresholdHeat = setpointF + (diffF * 0.5f);
    float onThresholdCool  = setpointF + (diffF * 0.5f);
    float offThresholdCool = setpointF - (diffF * 0.5f);

    // Heat control
    if (mode == "heat" && !isnan(ctlTemp)) {
      if (!heatOn && ctlTemp <= onThresholdHeat && (now - lastHeatToggle) >= MIN_OFF_TIME_MS) {
        heatOn = true;
        lastHeatToggle = now;
      } else if (heatOn && ctlTemp >= offThresholdHeat && (now - lastHeatToggle) >= MIN_ON_TIME_MS) {
        heatOn = false;
        lastHeatToggle = now;
      }
    } else {
      heatOn = false;
    }

    // Cool control
    if (mode == "cool" && !isnan(ctlTemp)) {
      if (!coolOn && ctlTemp >= onThresholdCool && (now - lastCoolToggle) >= MIN_OFF_TIME_MS) {
        coolOn = true;
        lastCoolToggle = now;
      } else if (coolOn && ctlTemp <= offThresholdCool && (now - lastCoolToggle) >= MIN_ON_TIME_MS) {
        coolOn = false;
        lastCoolToggle = now;
      }
    } else {
      coolOn = false;
    }

    // Fan timer (manual fan mode)
    if (mode == "fan" && fanRequestMinutes > 0) {
      fanRunUntil = now + (unsigned long)fanRequestMinutes * 60000UL;
      fanRequestMinutes = 0; // consume request
    }
    if (fanRunUntil > 0 && now >= fanRunUntil) {
      fanRunUntil = 0;
    }

    fanOn = (fanRunUntil > 0) || heatOn || coolOn;

    setOutput(HEAT_PIN, heatOn);
    setOutput(COOL_PIN, coolOn);
    setOutput(FAN_PIN, fanOn);
    if (DEBUG_SERIAL) {
      static bool lastHeat = false;
      static bool lastCool = false;
      static bool lastFan = false;
      if (heatOn != lastHeat || coolOn != lastCool || fanOn != lastFan) {
        Serial.printf("[OUTPUT] Heat %s -> %s | Cool %s -> %s | Fan %s -> %s\n",
                      lastHeat ? "ON" : "OFF", heatOn ? "ON" : "OFF",
                      lastCool ? "ON" : "OFF", coolOn ? "ON" : "OFF",
                      lastFan ? "ON" : "OFF", fanOn ? "ON" : "OFF");
        lastHeat = heatOn;
        lastCool = coolOn;
        lastFan = fanOn;
      }
    }

    Serial.printf("Mode: %s | Temp: %s F | Hum: %s %% | RealFeel: %s F | Heat: %s | Cool: %s | Fan: %s | Set: %.1f | Diff: %.1f\n",
                  mode.c_str(),
                  isnan(lastTempF) ? "NaN" : String(lastTempF, 2).c_str(),
                  isnan(lastHumidity) ? "NaN" : String(lastHumidity, 1).c_str(),
                  isnan(lastHeatIndexF) ? "NaN" : String(lastHeatIndexF, 2).c_str(),
                  heatOn ? "ON" : "OFF",
                  coolOn ? "ON" : "OFF",
                  fanOn ? "ON" : "OFF",
                  setpointF, diffF);

    // Log history once per interval (stores setpoint and control temperature)
    if (now - lastHistLog >= HISTORY_INTERVAL_MS) {
      lastHistLog = now;
      float ctl = !isnan(lastHeatIndexF) ? lastHeatIndexF : lastTempF;
      histTemp[histIndex] = ctl;
      histSet[histIndex] = setpointF;
      uint32_t ts = (uint32_t)time(nullptr);
      if (ts == 0) ts = millis() / 1000; // fallback if no NTP yet
      histTs[histIndex] = ts;
      histIndex = (histIndex + 1) % HIST_MAX;
      if (histCount < HIST_MAX) histCount++;
      // SD append: timestamp, temperature, setpoint
      if (sdReady) {
        File f = SD.open("/history.csv", FILE_APPEND);
        if (f) {
          int written = f.printf("%lu,%.2f,%.2f\n", (unsigned long)ts, ctl, setpointF);
          f.close();
          lastSdWriteMs = now;
          if (written > 0) {
            lastSdWriteOk = true;
            lastSdError = "ok";
          } else {
            lastSdWriteOk = false;
            lastSdError = "write failed";
            sdWriteFailures++;
            Serial.println("SD write returned 0 bytes");
          }
        } else {
          lastSdWriteMs = now;
          lastSdWriteOk = false;
          lastSdError = "open failed";
          sdWriteFailures++;
          sdReady = false; // stop trying until reboot
          Serial.println("SD open failed; disabling SD logging");
        }
      }
    }

    if (displayReady && (millis() - lastDisplay >= DISPLAY_INTERVAL_MS)) {
      lastDisplay = millis();
      updateDisplay();
    }
  }

  handleButtons();
  logHealth();
}

String makeToken() {
  uint32_t a = esp_random();
  uint32_t b = esp_random();
  char buf[17];
  snprintf(buf, sizeof(buf), "%08lx%08lx", (unsigned long)a, (unsigned long)b);
  return String(buf);
}

bool isAuthenticated() {
  if (sessionToken.length() == 0) return false;
  if ((unsigned long)(millis() - sessionStartMs) >= SESSION_TTL_MS) return false;
  String cookie = server.header("Cookie");
  if (cookie.length() == 0) return false;
  int idx = cookie.indexOf("session=");
  if (idx < 0) return false;
  int start = idx + 8;
  int end = cookie.indexOf(';', start);
  String value = (end < 0) ? cookie.substring(start) : cookie.substring(start, end);
  value.trim();
  return value == sessionToken;
}

bool onAuthorizedNetwork() {
  if (WiFi.status() != WL_CONNECTED) return false;
  if (AUTHORIZED_SSID[0] == '\0') return true;
  return WiFi.SSID() == String(AUTHORIZED_SSID);
}

bool canControl() {
  return isAuthenticated() && onAuthorizedNetwork();
}

bool requireControlAuth() {
  if (canControl()) return true;
  if (server.method() == HTTP_GET) {
    server.sendHeader("Location", "/login");
    server.send(302, "text/plain", "login required");
  } else {
    server.send(401, "text/plain", "unauthorized");
  }
  return false;
}

void loadWifiCredentials() {
  wifiSsid = prefs.getString("ssid", WIFI_SSID);
  wifiPass = prefs.getString("pass", WIFI_PASSWORD);
}

bool connectWiFiWithTimeout(unsigned long timeoutMs) {
  if (wifiSsid.length() == 0) return false;
  WiFi.mode(apMode ? WIFI_AP_STA : WIFI_STA);
  WiFi.begin(wifiSsid.c_str(), wifiPass.c_str());
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && (millis() - start) < timeoutMs) {
    delay(300);
  }
  if (WiFi.status() == WL_CONNECTED) {
    wifiConnected = true;
    apMode = false;
    wifiIpStr = WiFi.localIP().toString();
    WiFi.softAPdisconnect(true);
    configTime(tzOffsetSec, dstOffsetSec, "pool.ntp.org", "time.nist.gov", "time.google.com");
    Serial.printf("\nWiFi connected: %s (%s)\n", WiFi.SSID().c_str(), wifiIpStr.c_str());
    return true;
  }
  wifiConnected = false;
  return false;
}

void startWiFi() {
  Serial.printf("Connecting to WiFi SSID: %s\n", wifiSsid.c_str());
  if (!connectWiFiWithTimeout(WIFI_CONNECT_TIMEOUT_MS)) {
    Serial.println("WiFi not connected; starting AP");
    startAp();
  }
}

void startAp() {
  WiFi.mode(WIFI_AP_STA);
  if (AP_PASSWORD[0] != '\0') {
    WiFi.softAP(AP_SSID, AP_PASSWORD);
  } else {
    WiFi.softAP(AP_SSID);
  }
  apMode = true;
  wifiIpStr = WiFi.softAPIP().toString();
  Serial.printf("AP started: %s (IP %s)\n", AP_SSID, wifiIpStr.c_str());
}

void updateWiFiStatus() {
  static unsigned long lastCheck = 0;
  unsigned long now = millis();
  if (now - lastCheck < 1000) return;
  lastCheck = now;

  if (WiFi.status() == WL_CONNECTED) {
    if (!wifiConnected) {
      wifiConnected = true;
      apMode = false;
      wifiIpStr = WiFi.localIP().toString();
      WiFi.softAPdisconnect(true);
      configTime(tzOffsetSec, dstOffsetSec, "pool.ntp.org", "time.nist.gov", "time.google.com");
      Serial.printf("WiFi reconnected: %s (%s)\n", WiFi.SSID().c_str(), wifiIpStr.c_str());
    }
    return;
  }

  if (wifiConnected) {
    wifiConnected = false;
    Serial.println("WiFi disconnected");
  }
  if (!apMode) startAp();
  if (apMode) wifiIpStr = WiFi.softAPIP().toString();

  if (wifiSsid.length() > 0 && (now - lastWifiReconnect) >= WIFI_RECONNECT_INTERVAL_MS) {
    WiFi.mode(WIFI_AP_STA);
    WiFi.begin(wifiSsid.c_str(), wifiPass.c_str());
    lastWifiReconnect = now;
  }
}

void handleLogin() {
  String msg;
  if (server.method() == HTTP_POST) {
    String user = server.arg("user");
    String pass = server.arg("pass");
    if (user == ADMIN_USER && pass == ADMIN_PASSWORD) {
      sessionToken = makeToken();
      sessionStartMs = millis();
      String cookie = "session=" + sessionToken + "; Path=/; HttpOnly; SameSite=Strict; Max-Age=" + String(SESSION_TTL_MS / 1000);
      server.sendHeader("Set-Cookie", cookie);
      server.sendHeader("Location", "/thermostat");
      server.send(303, "text/plain", "signed in");
      return;
    }
    msg = "Invalid credentials.";
  }

  bool signedIn = isAuthenticated();
  bool onNet = onAuthorizedNetwork();
  String netLabel = onNet ? "Authorized network" : "Not on authorized network";

  String page;
  page += F("<!doctype html><html><head><meta charset='UTF-8'><meta name='viewport' content='width=device-width,initial-scale=1'>");
  page += F("<style>body{font-family:'Segoe UI',sans-serif;background:#0e1117;color:#e6e9f0;display:flex;justify-content:center;align-items:flex-start;min-height:100vh;padding:16px;} .card{background:#171b23;border-radius:18px;box-shadow:0 12px 30px rgba(0,0,0,0.45);width:460px;padding:20px;} h1{font-size:1.2rem;margin:0 0 8px;} .nav{display:flex;gap:10px;margin:8px 0 12px;} .nav a{background:#232a36;color:#e6e9f0;text-decoration:none;padding:8px 12px;border-radius:10px;box-shadow:0 6px 12px rgba(0,0,0,0.25);} .nav a.active{background:#2f74ff;} .pill{background:#232a36;border-radius:14px;padding:10px;display:flex;align-items:center;justify-content:space-between;margin:8px 0;} label{display:block;margin:6px 0 4px;} input{width:100%;padding:10px;border-radius:10px;border:1px solid #2b3442;background:#0f141c;color:#e6e9f0;} button{border:none;border-radius:10px;background:#2f74ff;color:#fff;padding:10px 14px;font-size:1rem;cursor:pointer;box-shadow:0 6px 12px rgba(0,0,0,0.25);width:100%;margin-top:10px;} .hint{color:#8a93a8;font-size:0.85rem;} a{color:#8fb3ff;} </style>");
  page += F("</head><body><div class='card'>");
  page += F("<div class='row'><h1>Sign In</h1><div></div></div>");
  page += "<div class='nav'><a href='/thermostat'>Thermostat</a><a href='/schedule'>Schedule</a><a href='/history'>History</a><a href='/system_status'>System</a><a href='/wifi'>WiFi</a><a class='active' href='/login'>Sign in</a></div>";
  page += "<div class='pill'><label>Status</label><div>" + String(signedIn ? "Signed in" : "Signed out") + " | " + netLabel + "</div></div>";
  if (msg.length() > 0) {
    page += "<div class='hint'>" + msg + "</div>";
  }
  if (signedIn) {
    page += "<div class='pill'><label>Session</label><div><a href='/logout'>Sign out</a></div></div>";
  }
  page += F("<form method='POST' action='/login'>");
  page += F("<label for='user'>User</label><input id='user' name='user' autocomplete='username' required>");
  page += F("<label for='pass'>Password</label><input id='pass' name='pass' type='password' autocomplete='current-password' required>");
  page += F("<button type='submit'>Sign in</button>");
  page += F("</form>");
  page += F("<div class='hint'>Only signed-in users on the authorized network can change settings.</div>");
  page += F("</div></body></html>");
  server.send(200, "text/html", page);
}

void handleLogout() {
  sessionToken = "";
  sessionStartMs = 0;
  server.sendHeader("Set-Cookie", "session=; Max-Age=0; Path=/");
  server.sendHeader("Location", "/thermostat");
  server.send(303, "text/plain", "signed out");
}

void handleWifiPage() {
  bool connected = (WiFi.status() == WL_CONNECTED);
  bool allowEdit = !connected || canControl();
  String modeLabel = connected ? "Connected" : (apMode ? "AP mode" : "Offline");
  String ssidLabel = connected ? WiFi.SSID() : (apMode ? String(AP_SSID) : String(""));
  String ipLabel = connected ? WiFi.localIP().toString() : (apMode ? WiFi.softAPIP().toString() : String("0.0.0.0"));

  String page;
  page += F("<!doctype html><html><head><meta charset='UTF-8'><meta name='viewport' content='width=device-width,initial-scale=1'>");
  page += F("<style>body{font-family:'Segoe UI',sans-serif;background:#0e1117;color:#e6e9f0;display:flex;justify-content:center;align-items:flex-start;min-height:100vh;padding:16px;} .card{background:#171b23;border-radius:18px;box-shadow:0 12px 30px rgba(0,0,0,0.45);width:460px;padding:20px;} h1{font-size:1.2rem;margin:0 0 8px;} .nav{display:flex;gap:10px;margin:8px 0 12px;} .nav a{background:#232a36;color:#e6e9f0;text-decoration:none;padding:8px 12px;border-radius:10px;box-shadow:0 6px 12px rgba(0,0,0,0.25);} .nav a.active{background:#2f74ff;} .pill{background:#232a36;border-radius:14px;padding:10px;display:flex;align-items:center;justify-content:space-between;margin:8px 0;} label{display:block;margin:6px 0 4px;} input{width:100%;padding:10px;border-radius:10px;border:1px solid #2b3442;background:#0f141c;color:#e6e9f0;} button{border:none;border-radius:10px;background:#2f74ff;color:#fff;padding:10px 14px;font-size:1rem;cursor:pointer;box-shadow:0 6px 12px rgba(0,0,0,0.25);width:100%;margin-top:10px;} button:disabled{opacity:0.6;cursor:not-allowed;} .hint{color:#8a93a8;font-size:0.85rem;} a{color:#8fb3ff;} </style>");
  page += F("</head><body><div class='card'>");
  page += F("<div class='row'><h1>WiFi Setup</h1><div></div></div>");
  page += "<div class='nav'><a href='/thermostat'>Thermostat</a><a href='/schedule'>Schedule</a><a href='/history'>History</a><a href='/system_status'>System</a><a class='active' href='/wifi'>WiFi</a><a href='/login'>Sign in</a></div>";
  page += "<div class='pill'><label>Status</label><div class='val'>" + modeLabel + "</div></div>";
  if (ssidLabel.length() > 0) {
    page += "<div class='pill'><label>SSID</label><div class='val'>" + ssidLabel + "</div></div>";
  }
  page += "<div class='pill'><label>IP</label><div class='val'>" + ipLabel + "</div></div>";
  if (!allowEdit && connected) {
    page += "<div class='hint'>Sign in on the authorized network to change WiFi settings.</div>";
  } else if (!connected) {
    page += "<div class='hint'>Connect to the AP and enter WiFi credentials to join your network.</div>";
  }
  page += F("<form method='POST' action='/wifi'>");
  page += "<label for='ssid'>SSID</label><input id='ssid' name='ssid' value='" + wifiSsid + "'" + String(allowEdit ? "" : " disabled") + ">";
  page += "<label for='pass'>Password</label><input id='pass' name='pass' type='password' value='' " + String(allowEdit ? "" : " disabled") + ">";
  page += "<button type='submit'" + String(allowEdit ? "" : " disabled") + ">Save and connect</button>";
  page += F("</form>");
  page += F("<div class='hint'>Saved credentials persist across reboots.</div>");
  page += F("</div></body></html>");
  server.send(200, "text/html", page);
}

void handleWifiSave() {
  if (wifiConnected && !canControl()) {
    server.sendHeader("Location", "/login");
    server.send(302, "text/plain", "login required");
    return;
  }
  String ssid = server.arg("ssid");
  String pass = server.arg("pass");
  ssid.trim();
  if (ssid.length() == 0) {
    server.send(400, "text/plain", "ssid required");
    return;
  }
  wifiSsid = ssid;
  wifiPass = pass;
  prefs.putString("ssid", wifiSsid);
  prefs.putString("pass", wifiPass);

  bool ok = connectWiFiWithTimeout(WIFI_CONNECT_TIMEOUT_MS);
  if (!ok) startAp();
  String targetIp = ok ? WiFi.localIP().toString() : (apMode ? WiFi.softAPIP().toString() : wifiIpStr);

  String page;
  page += F("<!doctype html><html><head><meta charset='UTF-8'><meta name='viewport' content='width=device-width,initial-scale=1'>");
  page += F("<style>body{font-family:'Segoe UI',sans-serif;background:#0e1117;color:#e6e9f0;display:flex;justify-content:center;align-items:flex-start;min-height:100vh;padding:16px;} .card{background:#171b23;border-radius:18px;box-shadow:0 12px 30px rgba(0,0,0,0.45);width:460px;padding:20px;} h1{font-size:1.2rem;margin:0 0 8px;} .pill{background:#232a36;border-radius:14px;padding:10px;display:flex;align-items:center;justify-content:space-between;margin:8px 0;} a{color:#8fb3ff;} </style>");
  page += F("</head><body><div class='card'>");
  page += F("<div class='row'><h1>WiFi Update</h1><div></div></div>");
  page += "<div class='pill'><label>Status</label><div class='val'>" + String(ok ? "Connected" : "Not connected") + "</div></div>";
  page += "<div class='pill'><label>IP</label><div class='val'>" + targetIp + "</div></div>";
  if (ok) {
    page += "<div>Open <a href='http://" + targetIp + "/thermostat'>http://" + targetIp + "/thermostat</a></div>";
  } else {
    page += "<div>Stay on the AP and try again.</div>";
  }
  page += F("</div></body></html>");
  server.send(200, "text/html", page);
}

void handleThermostat() {
  // Determine schedule/manual status for display
  String schedLabel = "Manual";
  String schedVal = String(setpointF, 1) + " F";
  struct tm timeinfo;
  if (getLocalTime(&timeinfo)) {
    int d = timeinfo.tm_wday;
    int h = timeinfo.tm_hour;
    if (d >= 0 && d < 7 && h >= 0 && h < 24) {
      float sp = scheduleSP[d][h];
      if (!overrideUntilNextSchedule && !isnan(sp)) {
        schedLabel = "Scheduled";
        schedVal = String(sp, 1) + " F";
      } else {
        schedLabel = "Manual";
        schedVal = String(setpointF, 1) + " F";
      }
    }
  }

  bool signedIn = isAuthenticated();
  bool onNet = onAuthorizedNetwork();
  bool canEdit = signedIn && onNet;
  String authNote;
  if (!signedIn) authNote = "Read-only. <a href='/login'>Sign in</a>.";
  else if (!onNet) {
    if (WiFi.status() != WL_CONNECTED) authNote = "Signed in, but WiFi is offline.";
    else authNote = "Signed in, but not on " + String(AUTHORIZED_SSID) + ".";
  }
  else authNote = "Signed in. <a href='/logout'>Sign out</a>.";
  String wifiLine;
  if (wifiConnected) wifiLine = "WiFi: " + WiFi.SSID() + " | IP: " + wifiIpStr;
  else if (apMode) wifiLine = "AP: " + String(AP_SSID) + " | IP: " + wifiIpStr;
  else wifiLine = "WiFi: disconnected";

  String page;
  page += F("<!doctype html><html><head><meta charset='UTF-8'><meta name='viewport' content='width=device-width,initial-scale=1'>");
  page += F("<style>body{font-family:'Segoe UI',sans-serif;background:#0e1117;color:#e6e9f0;display:flex;justify-content:center;align-items:flex-start;min-height:100vh;padding:16px;} .card{background:#171b23;border-radius:18px;box-shadow:0 12px 30px rgba(0,0,0,0.45);width:460px;padding:20px;} h1{font-size:1.2rem;margin:0 0 8px;} .row{display:flex;align-items:center;justify-content:space-between;margin:6px 0;} .badge{padding:6px 10px;border-radius:12px;font-size:0.9rem;background:#232a36;} .big-temp{font-size:3.2rem;font-weight:700;text-align:center;margin:6px 0;} .mini{font-size:0.9rem;color:#a9b3c6;text-align:center;} .controls{display:flex;justify-content:space-around;margin:12px 0;} button.adj{width:68px;height:68px;border-radius:50%;border:none;font-size:2rem;color:#fefefe;background:#2f74ff;box-shadow:0 8px 18px rgba(47,116,255,0.35);cursor:pointer;} button.adj.minus{background:#334155;} .pill{background:#232a36;border-radius:14px;padding:10px;display:flex;align-items:center;justify-content:space-between;margin:8px 0;} .pill label{margin:0;font-size:0.95rem;} .pill .val{font-size:1.1rem;font-weight:600;} .hiddenField{display:none;} .footer{margin-top:14px;font-size:0.85rem;color:#8a93a8;text-align:center;} a{color:#8fb3ff;} .mode-buttons{display:flex;gap:8px;margin:8px 0;} .mode-buttons button{flex:1;padding:12px;border:none;border-radius:10px;font-size:1rem;font-weight:600;color:#fefefe;cursor:pointer;background:#232a36;} .mode-buttons button.active{background:#2f74ff;} .led{display:inline-block;width:10px;height:10px;border-radius:50%;margin-left:6px;background:#444;} .led.on{background:#30d158;} .nav{display:flex;gap:10px;margin:8px 0 12px;} .nav a{background:#232a36;color:#e6e9f0;text-decoration:none;padding:8px 12px;border-radius:10px;box-shadow:0 6px 12px rgba(0,0,0,0.25);} .nav a.active{background:#2f74ff;} .hide{display:none;} </style>");
  page += F("<script>let setVal=");
  page += String(setpointF, 1);
  page += F(", diffVal=");
  page += String(diffF, 1);
  page += F(", fanVal=0; const canControl=");
  page += String(canEdit ? "true" : "false");
  page += F("; let warned=false; let fanHold=null, fanHoldTimeout=null; function guard(){if(canControl)return true; if(!warned){alert('Sign in to change settings.'); warned=true;} return false;} function updateInputs(){document.getElementById('setVal').textContent=setVal.toFixed(1);document.getElementById('diffVal').textContent=diffVal.toFixed(1);document.getElementById('fanVal').textContent=fanVal.toFixed(0);document.getElementById('setpointInput').value=setVal.toFixed(1);document.getElementById('diffInput').value=diffVal.toFixed(1);document.getElementById('fanInput').value=fanVal.toFixed(0);} function adjust(type,delta,min,max){if(!guard())return; if(type==='set'){setVal=Math.min(Math.max(setVal+delta,min),max);}else if(type==='diff'){diffVal=Math.min(Math.max(diffVal+delta,min),max);}else if(type==='fan'){fanVal=Math.min(Math.max(fanVal+delta,min),max);}updateInputs();} function startFanHold(delta){if(!guard())return; stopFanHold();fanHoldTimeout=setTimeout(()=>{fanHold=setInterval(()=>adjust('fan',delta,0,60),500);},1000);} function stopFanHold(){clearTimeout(fanHoldTimeout);fanHoldTimeout=null;clearInterval(fanHold);fanHold=null;} function quickMode(m){if(!guard())return; document.getElementsByName('mode')[0].value=m; if(m==='fan'){let v=prompt('Fan minutes (0-60)','5'); if(v===null)return; fanVal=Math.min(Math.max(parseInt(v)||0,0),60); updateInputs();} document.forms[0].submit();} async function refresh(){try{const r=await fetch('/status');if(!r.ok)return;const d=await r.json();['mode','temp','hum','feel','heat','cool','fan'].forEach(id=>{const el=document.getElementById(id);if(el)el.textContent=d[id];}); document.getElementById('modeBadge').textContent=d.mode; document.getElementById('mode').textContent=d.mode; const led=document.getElementById('led'); const active = (d.heat==='ON'||d.cool==='ON'||d.fan==='ON'); if(led){led.className = 'led' + (active ? ' on' : '');} const fanRow=document.getElementById('fanRow'); const fanPill=document.getElementById('fanPill'); if(fanRow)fanRow.style.display = d.mode==='fan' ? 'block' : 'none'; if(fanPill)fanPill.style.display = d.mode==='fan' ? 'flex' : 'none'; }catch(e){}} async function sendTz(){if(!canControl)return; try{const offsetSec = -new Date().getTimezoneOffset()*60; await fetch('/tz?offset=' + offsetSec);}catch(e){}} setInterval(refresh,1000);window.onload=function(){updateInputs();refresh();sendTz(); if(!canControl){document.querySelectorAll('button.adj, .mode-buttons button, form button[type=submit]').forEach(b=>b.disabled=true);} };</script>");
  page += F("</head><body><div class='card'>");
  page += F("<div class='row'><h1>Thermostat</h1><div class='badge' id='modeBadge'>");
  page += mode + "</div></div>";
  page += "<div class='nav'><a class='active' href='/thermostat'>Thermostat</a><a href='/schedule'>Schedule</a><a href='/history'>History</a><a href='/system_status'>System</a><a href='/wifi'>WiFi</a></div>";
  page += "<div class='mini'>" + wifiLine + "</div>";
  page += "<div class='mini'>" + authNote + "</div>";
  page += "<div class='mini'>Temp: <span id='temp'>--</span></div>";
  page += "<div class='big-temp'><span id='feel'>--</span></div>";
  page += "<div class='mini'>Humidity: <span id='hum'>--</span> | Mode: <span id='mode'>" + mode + "</span> <span id='led' class='led" + String((heatOn||coolOn||fanOn) ? " on" : "") + "'></span></div>";
  page += "<div class='controls'>";
  page += "<button class='adj minus' type='button' onclick=\"adjust('set',-0.5,40,90)\">&#8722;</button>";
  page += "<div style='text-align:center'><div class='mini'>Setpoint (&deg;F)</div><div style='font-size:2rem;font-weight:700;' id='setVal'>" + String(setpointF, 1) + "</div><div class='mini'>Diff: <span id='diffVal'>" + String(diffF, 1) + "</span></div><div class='mini' id='fanRow'>Fan: <span id='fanVal'>0</span> min</div></div>";
  page += "<button class='adj' type='button' onclick=\"adjust('set',0.5,40,90)\">&#43;</button>";
  page += "</div>";
  page += "<div class='pill'><label>Diff (&deg;F)</label><div><button class='adj minus' type='button' onclick=\"adjust('diff',-0.5,0.1,10)\">&#8722;</button><button class='adj' type='button' onclick=\"adjust('diff',0.5,0.1,10)\">&#43;</button></div></div>";
  page += "<div class='pill' id='fanPill'><label>Fan runtime (minutes, Mode=Fan)</label><div><button class='adj minus' type='button' ontouchstart=\"startFanHold(-1)\" onmousedown=\"startFanHold(-1)\" ontouchend=\"stopFanHold()\" onmouseup=\"stopFanHold()\" onmouseleave=\"stopFanHold()\" onclick=\"adjust('fan',-1,0,60)\">&#8722;</button><button class='adj' type='button' ontouchstart=\"startFanHold(1)\" onmousedown=\"startFanHold(1)\" ontouchend=\"stopFanHold()\" onmouseup=\"stopFanHold()\" onmouseleave=\"stopFanHold()\" onclick=\"adjust('fan',1,0,60)\">&#43;</button></div></div>";

  page += "<div class='mode-buttons'>";
  page += "<button type='button' class='modeBtn" + String(mode == "heat" ? " active" : "") + "' onclick=\"quickMode('heat')\">Heat</button>";
  page += "<button type='button' class='modeBtn" + String(mode == "cool" ? " active" : "") + "' onclick=\"quickMode('cool')\">Cool</button>";
  page += "<button type='button' class='modeBtn" + String(mode == "fan" ? " active" : "") + "' onclick=\"quickMode('fan')\">Fan</button>";
  page += "<button type='button' class='modeBtn" + String(mode == "off" ? " active" : "") + "' onclick=\"quickMode('off')\">Off</button>";
  page += "</div>";

  page += F("<form action='/set' method='GET'>");
  page += "<select name='mode' class='hiddenField'>";
  page += "<option value='heat'" + String(mode == "heat" ? " selected" : "") + ">Heat</option>";
  page += "<option value='cool'" + String(mode == "cool" ? " selected" : "") + ">Cool</option>";
  page += "<option value='fan'"  + String(mode == "fan"  ? " selected" : "") + ">Fan (timer)</option>";
  page += "<option value='off'"  + String(mode == "off"  ? " selected" : "") + ">Off</option>";
  page += "</select>";
  page += "<input type='hidden' class='hiddenField' id='setpointInput' name='setpoint' value='" + String(setpointF, 1) + "'>";
  page += "<input type='hidden' class='hiddenField' id='diffInput' name='diff' value='" + String(diffF, 1) + "'>";
  page += "<input type='hidden' class='hiddenField' id='fanInput' name='fan' value='0'>";
  page += "<div class='pill'><label>Control source</label><div class='val'>" + schedLabel + " &ndash; " + schedVal + "</div></div>";

  page += "<button type='submit' style='width:100%;padding:12px;font-size:1.1rem;margin-top:8px;'" + String(canEdit ? "" : " disabled") + ">Update</button>";
  page += F("</form>");
  page += F("<div class='footer'>Controls stay put; live data refreshes every second. For data logging/remote access, see notes in code.</div>");
  page += F("</div></body></html>");
  server.send(200, "text/html", page);
}

void handleSchedule() {
  static const char* dayNames[7] = {"Sun","Mon","Tue","Wed","Thu","Fri","Sat"};
  bool canEdit = canControl();
  String authNote = canEdit ? "" : "Read-only. <a href='/login'>Sign in</a> to edit schedule.";
  String page;
  page += F("<!doctype html><html><head><meta charset='UTF-8'><meta name='viewport' content='width=device-width,initial-scale=1'>");
  page += F("<style>body{font-family:'Segoe UI',sans-serif;background:#0e1117;color:#e6e9f0;display:flex;justify-content:center;align-items:flex-start;min-height:100vh;padding:16px;} .card{background:#171b23;border-radius:18px;box-shadow:0 12px 30px rgba(0,0,0,0.45);width:100%;max-width:960px;padding:20px;} h1{font-size:1.2rem;margin:0 0 8px;} .nav{display:flex;gap:10px;margin:8px 0 12px;} .nav a{background:#232a36;color:#e6e9f0;text-decoration:none;padding:8px 12px;border-radius:10px;box-shadow:0 6px 12px rgba(0,0,0,0.25);} .nav a.active{background:#2f74ff;} .legend{font-size:0.9rem;color:#a9b3c6;margin:6px 0;} .dayrow{display:flex;align-items:center;gap:10px;margin:8px 0;} .dayname{width:60px;font-weight:700;text-align:right;color:#e6e9f0;} .bar{flex:1;position:relative;height:26px;background:#11161f;border-radius:12px;overflow:hidden;box-shadow:inset 0 0 0 1px #222a35;} .seg{position:absolute;top:0;bottom:0;border-radius:10px;opacity:0.9;} .seg span{position:absolute;left:6px;top:4px;font-size:0.8rem;color:#fff;} .controls{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;} button{border:none;border-radius:10px;background:#2f74ff;color:#fff;padding:10px 14px;font-size:1rem;cursor:pointer;box-shadow:0 6px 12px rgba(0,0,0,0.25);} button.secondary{background:#334155;} .hint{color:#8a93a8;font-size:0.85rem;margin-top:6px;} </style>");
  page += F("</head><body><div class='card'>");
  page += F("<div class='row'><h1>Schedule</h1><div></div></div>");
  page += "<div class='nav'><a href='/thermostat'>Thermostat</a><a class='active' href='/schedule'>Schedule</a><a href='/history'>History</a><a href='/system_status'>System</a><a href='/wifi'>WiFi</a></div>";
  if (authNote.length() > 0) page += "<div class='legend'>" + authNote + "</div>";
  page += "<div class='legend'>Long-press a day's bar to add a setpoint block. Manual changes hold until the next scheduled block; when a day has no blocks it follows the manual setpoint.</div>";
  page += "<div id='schedule'></div>";
  page += "<div class='controls'><button onclick='reloadSchedule()'>Refresh</button><button class='secondary' onclick='clearAll()'" + String(canEdit ? "" : " disabled") + ">Clear all days</button></div>";
  page += "<div class='hint'>Blocks are inclusive of the end hour. Example: start 8, end 10 covers 8,9,10. Clear all if you want to stay manual-only.</div>";
  page += "<script>";
  page += "const dayNames=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];const dayOrder=[1,2,3,4,5,6,0];const canControl=";
  page += String(canEdit ? "true" : "false");
  page += ";let warned=false;function guard(){if(canControl)return true; if(!warned){alert('Sign in to edit schedule.'); warned=true;} return false;} let schedule=[];let pressTimer=null;";
  page += "function colorForSet(sp){const base=170-Math.min(Math.max((sp-60)*3,0),120);return `rgb(47,116,255,0.85)`;}";
  page += "function ensureSchedule(){if(!Array.isArray(schedule)||schedule.length<7){const filled=[];for(let i=0;i<7;i++){const hrs=new Array(24).fill(NaN);filled.push(hrs);}schedule=filled;}}";
  page += "function render(){ensureSchedule();const wrap=document.getElementById('schedule');wrap.innerHTML='';dayOrder.forEach((dayIdx,displayIdx)=>{const hours=schedule[dayIdx];const row=document.createElement('div');row.className='dayrow';row.innerHTML=`<div class='dayname'>${dayNames[displayIdx]}</div><div class='bar' data-day='${dayIdx}'></div>`;const bar=row.querySelector('.bar');bar.addEventListener('pointerdown',e=>startPress(e,dayIdx,bar));bar.addEventListener('pointerup',cancelPress);bar.addEventListener('pointerleave',cancelPress);let start=-1,lastSp=NAN;for(let h=0;h<25;h++){const sp=h<24?hours[h]:NAN;if(!isnan(sp)&&isnan(lastSp)){start=h;lastSp=sp;}else if((isnan(sp)&&!isnan(lastSp))||(!isnan(sp)&&!isnan(lastSp)&&fabs(sp-lastSp)>0.01)){addSeg(bar,start,h-1,lastSp);start=isnan(sp)?-1:h;lastSp=sp;}else if(h==24&&!isnan(lastSp)){addSeg(bar,start,23,lastSp);} }wrap.appendChild(row);});}";
  page += "function addSeg(bar,start,end,sp){if(start<0||end<start)return;const seg=document.createElement('div');const left=(start/24)*100;const width=((end-start+1)/24)*100;seg.className='seg';seg.style.left=left+'%';seg.style.width=width+'%';seg.style.background=colorForSet(sp);seg.innerHTML=`<span>${sp.toFixed(0)}°</span>`;bar.appendChild(seg);}";
  page += "function startPress(ev,day,bar){if(!guard())return; cancelPress();pressTimer=setTimeout(()=>{pressTimer=null;createBlock(ev,day,bar);},500);}function cancelPress(){if(pressTimer){clearTimeout(pressTimer);pressTimer=null;}}";
  page += "function createBlock(ev,day,bar){const rect=bar.getBoundingClientRect();const pct=Math.max(0,Math.min(1,(ev.clientX-rect.left)/rect.width));const start=Math.floor(pct*24);const duration=parseInt(prompt(`Duration hours (1-24) starting at ${start}:00`,`2`)||'0');if(!duration||duration<1||duration>24)return;const end=(start+duration-1)%24;const sp=parseFloat(prompt('Setpoint °F','70'))||70;applyBlock(day,start,end,sp);} ";
  page += "async function applyBlock(day,start,end,sp){const qs=new URLSearchParams({sch_apply:'1',sch_day:day,sch_start:start,sch_end:end,sch_setpoint:sp.toFixed(1)});await fetch('/set?'+qs.toString());reloadSchedule();}";
  page += "async function clearDay(day){if(!guard())return; await fetch('/set?'+new URLSearchParams({sch_clear:'1',sch_day:day}).toString());reloadSchedule();}";
  page += "async function clearAll(){if(!guard())return; for(let d=0;d<7;d++){await clearDay(d);} }";
  page += "async function reloadSchedule(){const r=await fetch('/schedule_data');if(!r.ok)return;const data=await r.json();schedule=data.schedule||[];ensureSchedule();render();}";
  page += "function fabs(x){return x<0?-x:x;} function isnan(x){return x!==x;}";
  page += "reloadSchedule();";
  page += "</script>";
  page += F("<div class='footer'>Use /thermostat for live controls. Schedule persists until you clear a day.</div>");
  page += F("</div></body></html>");
  server.send(200, "text/html", page);
}

void handleScheduleData() {
  String json = "{ \"schedule\":[";
  for (int d = 0; d < 7; d++) {
    json += "[";
    for (int h = 0; h < 24; h++) {
      float sp = scheduleSP[d][h];
      json += isnan(sp) ? "null" : String(sp, 1);
      if (h < 23) json += ",";
    }
    json += "]";
    if (d < 6) json += ",";
  }
  json += "]}";
  server.send(200, "application/json", json);
}

void handleHistoryData() {
  String json = "{ \"points\":[";
  int count = histCount;
  int start = (histIndex - count + HIST_MAX) % HIST_MAX;
  for (int i = 0; i < count; i++) {
    int idx = (start + i) % HIST_MAX;
    json += "{";
    json += "\"ts\":" + String(histTs[idx]) + ",";
    json += "\"temp\":" + (isnan(histTemp[idx]) ? String("null") : String(histTemp[idx], 2)) + ",";
    json += "\"set\":" + (isnan(histSet[idx]) ? String("null") : String(histSet[idx], 2));
    json += "}";
    if (i < count - 1) json += ",";
  }
  json += "]}";
  server.send(200, "application/json", json);
}

void handleSystemStatusData() {
  unsigned long nowMs = millis();
  bool sensorFresh = (nowMs - lastRead) < 5000 && !isnan(lastTempF) && !isnan(lastHumidity);
  bool sensorOk = sensorFresh;
  bool relayOk = true; // assume OK if we can set outputs
  bool wifiOk = (WiFi.status() == WL_CONNECTED);
  uint64_t sdTotal = 0;
  String sdType = "none";
  if (sdReady) {
    uint8_t t = SD.cardType();
    if (t == CARD_NONE) {
      sdReady = false;
    } else {
      sdTotal = SD.cardSize();
      if (t == CARD_MMC) sdType = "MMC";
      else if (t == CARD_SD) sdType = "SDSC";
      else if (t == CARD_SDHC) sdType = "SDHC/SDXC";
      else sdType = "SD";
    }
  }
  // Schedule context
  bool scheduled = false;
  float scheduledSp = NAN;
  struct tm timeinfo;
  if (getLocalTime(&timeinfo)) {
    int d = timeinfo.tm_wday;
    int h = timeinfo.tm_hour;
    if (d >= 0 && d < 7 && h >= 0 && h < 24) {
      float sp = scheduleSP[d][h];
      if (!isnan(sp) && !overrideUntilNextSchedule) {
        scheduled = true;
        scheduledSp = sp;
      }
    }
  }

  String json = "{";
  json += "\"uptime_s\":" + String(nowMs / 1000) + ",";
  json += "\"wifi\":{\"ok\":" + String(wifiOk ? "true" : "false") + ",\"ip\":\"" + WiFi.localIP().toString() + "\",\"rssi\":" + String(WiFi.RSSI()) + "},";
  json += "\"sensor\":{\"ok\":" + String(sensorOk ? "true" : "false") + ",\"temp\":" + (isnan(lastTempF) ? String("null") : String(lastTempF, 1)) + ",\"hum\":" + (isnan(lastHumidity) ? String("null") : String(lastHumidity, 1)) + "},";
  json += "\"relays\":{\"ok\":" + String(relayOk ? "true" : "false") + ",\"heat\":\"" + (heatOn ? "ON" : "OFF") + "\",\"cool\":\"" + (coolOn ? "ON" : "OFF") + "\",\"fan\":\"" + (fanOn ? "ON" : "OFF") + "\"},";
  json += "\"mode\":\"" + mode + "\",";
  json += "\"schedule\":{\"active\":" + String(scheduled ? "true" : "false") + ",\"setpoint\":" + (isnan(scheduledSp) ? String("null") : String(scheduledSp, 1)) + ",\"override\":" + String(overrideUntilNextSchedule ? "true" : "false") + "},";
  json += "\"sd\":{\"ok\":" + String(sdReady ? "true" : "false") + ",\"type\":\"" + sdType + "\",\"total_bytes\":" + String((unsigned long long)sdTotal) + "}";
  json += "}";
  server.send(200, "application/json", json);
}

void handleSet() {
  if (!requireControlAuth()) return;
  bool updated = false;
  bool manualChange = false;
  if (server.hasArg("setpoint")) {
    setpointF = server.arg("setpoint").toFloat();
    if (setpointF < 40.0f) setpointF = 40.0f;
    if (setpointF > 90.0f) setpointF = 90.0f;
    updated = true;
    manualChange = true;
  }
  if (server.hasArg("diff")) {
    diffF = server.arg("diff").toFloat();
    if (diffF < 0.1f) diffF = 0.1f;
    if (diffF > 10.0f) diffF = 10.0f;
    updated = true;
    manualChange = true;
  }
  if (server.hasArg("mode")) {
    String m = server.arg("mode");
    m.toLowerCase();
    if (m == "heat" || m == "cool" || m == "fan" || m == "off") {
      mode = m;
      updated = true;
      manualChange = true;
    }
  }
  if (server.hasArg("fan")) {
    int minutes = server.arg("fan").toInt();
    if (minutes < 0) minutes = 0;
    if (minutes > 60) minutes = 60;
    fanRequestMinutes = (uint8_t)minutes;
    updated = true;
  }
  // Schedule apply/clear
  if (server.hasArg("sch_apply") && server.hasArg("sch_day") && server.hasArg("sch_start") && server.hasArg("sch_end") && server.hasArg("sch_setpoint")) {
    int d = server.arg("sch_day").toInt();
    int startH = server.arg("sch_start").toInt();
    int endH = server.arg("sch_end").toInt();
    float sp = server.arg("sch_setpoint").toFloat();
    if (d >= 0 && d < 7 && startH >= 0 && startH < 24 && endH >= 0 && endH < 24) {
      int h = startH;
      while (true) {
        scheduleSP[d][h] = sp;
        if (h == endH) break; // inclusive end
        h = (h + 1) % 24;
        if (h == startH) break; // safety to avoid infinite loop
      }
      updated = true;
    }
  }
  if (server.hasArg("sch_clear") && server.hasArg("sch_day")) {
    int d = server.arg("sch_day").toInt();
    if (d >= 0 && d < 7) {
      for (int h = 0; h < 24; h++) scheduleSP[d][h] = NAN;
      updated = true;
    }
  }
  if (manualChange) {
    overrideUntilNextSchedule = true;
    struct tm timeinfo;
    if (getLocalTime(&timeinfo)) {
      overrideStartHour = timeinfo.tm_hour;
      lastScheduleHour = overrideStartHour;
    } else {
      overrideStartHour = -1;
    }
  }
  String msg = updated ? "Updated" : "No changes";
  server.sendHeader("Location", "/");
  server.send(303, "text/plain", msg);
}

void handleSystemStatus() {
  String page;
  page += F("<!doctype html><html><head><meta charset='UTF-8'><meta name='viewport' content='width=device-width,initial-scale=1'>");
  page += F("<style>body{font-family:'Segoe UI',sans-serif;background:#0e1117;color:#e6e9f0;display:flex;justify-content:center;align-items:flex-start;min-height:100vh;padding:16px;} .card{background:#171b23;border-radius:18px;box-shadow:0 12px 30px rgba(0,0,0,0.45);width:100%;max-width:960px;padding:20px;} h1{font-size:1.2rem;margin:0 0 8px;} .nav{display:flex;gap:10px;margin:8px 0 12px;} .nav a{background:#232a36;color:#e6e9f0;text-decoration:none;padding:8px 12px;border-radius:10px;box-shadow:0 6px 12px rgba(0,0,0,0.25);} .nav a.active{background:#2f74ff;} .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin-top:10px;} .tile{background:#11161f;border-radius:12px;padding:12px;box-shadow:inset 0 0 0 1px #222a35;} .label{font-size:0.9rem;color:#8a93a8;margin-bottom:4px;} .value{font-size:1rem;font-weight:700;} .pill{display:inline-block;padding:4px 10px;border-radius:999px;font-size:0.9rem;font-weight:700;} .go{background:#123821;color:#30d158;} .nogo{background:#3d1b1b;color:#ff6b6b;} .detail{font-size:0.9rem;color:#a9b3c6;margin-top:4px;} </style>");
  page += F("</head><body><div class='card'>");
  page += F("<div class='row'><h1>System Status</h1><div></div></div>");
  page += "<div class='nav'><a href='/thermostat'>Thermostat</a><a href='/schedule'>Schedule</a><a href='/history'>History</a><a class='active' href='/system_status'>System</a><a href='/wifi'>WiFi</a></div>";
  page += "<div id='grid' class='grid'></div>";
  page += "<div class='detail'>Shows live health for sensors, relays, WiFi, SD, and schedule/manual state.</div>";
  page += "<script>";
  page += "function badge(ok){return `<span class='pill ${ok?'go':'nogo'}'>${ok?'GO':'NO-GO'}</span>`;} ";
  page += "function load(){fetch('/system_status_data').then(r=>r.json()).then(d=>{const g=document.getElementById('grid');if(!d){g.innerHTML='No data';return;}const rows=[];rows.push(`<div class='tile'><div class='label'>WiFi</div><div class='value'>${badge(d.wifi.ok)} ${d.wifi.ip}</div><div class='detail'>RSSI ${d.wifi.rssi} dBm</div></div>`);rows.push(`<div class='tile'><div class='label'>Sensor</div><div class='value'>${badge(d.sensor.ok)} T: ${d.sensor.temp??'--'} F / H: ${d.sensor.hum??'--'}%</div><div class='detail'>Fresh if reading updated recently.</div></div>`);rows.push(`<div class='tile'><div class='label'>Relays</div><div class='value'>${badge(d.relays.ok)} Heat ${d.relays.heat} | Cool ${d.relays.cool} | Fan ${d.relays.fan}</div><div class='detail'>Mode ${d.mode}</div></div>`);rows.push(`<div class='tile'><div class='label'>Schedule</div><div class='value'>${d.schedule.active?'Scheduled':'Manual'} ${d.schedule.setpoint?d.schedule.setpoint+' F':''}</div><div class='detail'>Override: ${d.schedule.override?'Yes':'No'}</div></div>`);rows.push(`<div class='tile'><div class='label'>SD Card</div><div class='value'>${badge(d.sd.ok)} ${d.sd.type}</div><div class='detail'>Size: ${d.sd.total_bytes ? (d.sd.total_bytes/(1024*1024*1024)).toFixed(2)+' GB' : 'n/a'}</div></div>`);rows.push(`<div class='tile'><div class='label'>Uptime</div><div class='value'>${(d.uptime_s/3600).toFixed(2)} h</div><div class='detail'>${(d.uptime_s/86400).toFixed(2)} days</div></div>`);g.innerHTML=rows.join('');}).catch(()=>{});} load(); setInterval(load, 5000);";
  page += "</script>";
  page += F("<div class='footer'>Refreshes every 5 seconds; use SD status to confirm logging.</div>");
  page += F("</div></body></html>");
  server.send(200, "text/html", page);
}

void handleHistory() {
  String page;
  page += F("<!doctype html><html><head><meta charset='UTF-8'><meta name='viewport' content='width=device-width,initial-scale=1'>");
  page += F("<style>body{font-family:'Segoe UI',sans-serif;background:#0e1117;color:#e6e9f0;display:flex;justify-content:center;align-items:flex-start;min-height:100vh;padding:16px;} .card{background:#171b23;border-radius:18px;box-shadow:0 12px 30px rgba(0,0,0,0.45);width:100%;max-width:960px;padding:20px;} h1{font-size:1.2rem;margin:0 0 8px;} .nav{display:flex;gap:10px;margin:8px 0 12px;} .nav a{background:#232a36;color:#e6e9f0;text-decoration:none;padding:8px 12px;border-radius:10px;box-shadow:0 6px 12px rgba(0,0,0,0.25);} .nav a.active{background:#2f74ff;} .controls{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0;} button{border:none;border-radius:10px;background:#2f74ff;color:#fff;padding:10px 14px;font-size:1rem;cursor:pointer;box-shadow:0 6px 12px rgba(0,0,0,0.25);} button.secondary{background:#334155;} .hint{color:#8a93a8;font-size:0.85rem;} canvas{background:#0b0f16;border-radius:12px;width:100%;height:360px;box-shadow:inset 0 0 0 1px #222a35;} .legend{display:flex;gap:10px;font-size:0.9rem;margin-top:6px;} .swatch{width:14px;height:14px;border-radius:4px;display:inline-block;margin-right:4px;} </style>");
  page += F("</head><body><div class='card'>");
  page += F("<div class='row'><h1>History</h1><div></div></div>");
  page += "<div class='nav'><a href='/thermostat'>Thermostat</a><a href='/schedule'>Schedule</a><a class='active' href='/history'>History</a><a href='/system_status'>System</a><a href='/wifi'>WiFi</a></div>";
  page += "<div class='controls'><button onclick=\"setRange('day')\">Day</button><button onclick=\"setRange('week')\">Week</button><button onclick=\"setRange('month')\">Month</button><button class='secondary' onclick='loadHistory()'>Refresh</button></div>";
  page += "<canvas id='chart' width='900' height='360'></canvas>";
  page += "<div class='legend'><span><span class='swatch' style='background:#2f74ff'></span>Setpoint</span><span><span class='swatch' style='background:#30d158'></span>Temperature</span></div>";
  page += "<div class='hint'>Data logs every minute (in-memory, last 7 days). Month view shows whatever span is available; add SD/RTC for deeper history.</div>";
  page += "<script>";
  page += "let raw=[];let filtered=[];let currentRange='day';";
  page += "async function loadHistory(){const r=await fetch('/history_data');if(!r.ok)return;const d=await r.json();raw=d.points||[];setRange(currentRange);} ";
  page += "function setRange(range){currentRange=range;const now=Math.floor(Date.now()/1000);let cutoff=0;if(range==='day')cutoff=now-86400;else if(range==='week')cutoff=now-604800;else if(range==='month')cutoff=now-2592000;filtered=raw.filter(p=>!cutoff||p.ts>=cutoff);draw();}";
  page += "function draw(){const c=document.getElementById('chart');const ctx=c.getContext('2d');ctx.clearRect(0,0,c.width,c.height);if(!filtered.length){ctx.fillStyle='#8a93a8';ctx.fillText('No history yet',20,30);return;}const temps=filtered.map(p=>p.temp).filter(v=>v!=null);const sets=filtered.map(p=>p.set).filter(v=>v!=null);const minVal=Math.min(...temps,...sets);const maxVal=Math.max(...temps,...sets);const minTs=filtered[0].ts;const maxTs=filtered[filtered.length-1].ts;const pad=30;const h=c.height-2*pad;const w=c.width-2*pad;function y(v){if(maxVal===minVal)return c.height/2;return pad+h-(v-minVal)/(maxVal-minVal)*h;}function x(t){if(maxTs===minTs)return pad+w/2;return pad+(t-minTs)/(maxTs-minTs)*w;}function line(color,key){ctx.beginPath();ctx.strokeStyle=color;ctx.lineWidth=2;let first=true;filtered.forEach(p=>{const v=p[key];if(v==null)return;const px=x(p.ts),py=y(v);if(first){ctx.moveTo(px,py);first=false;}else ctx.lineTo(px,py);});ctx.stroke();}line('#2f74ff','set');line('#30d158','temp');ctx.strokeStyle='#222a35';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(pad,c.height-pad);ctx.lineTo(c.width-pad,c.height-pad);ctx.stroke();ctx.fillStyle='#8a93a8';ctx.textAlign='center';ctx.textBaseline='top';const ticks=5;for(let i=0;i<ticks;i++){const t=minTs+(i/(ticks-1))*(maxTs-minTs);const px=x(t);ctx.fillText(new Date(t*1000).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}),px,c.height-pad+4);ctx.beginPath();ctx.moveTo(px,c.height-pad);ctx.lineTo(px,c.height-pad-4);ctx.strokeStyle='#444d5e';ctx.stroke();}ctx.textAlign='left';ctx.fillText(new Date(minTs*1000).toLocaleDateString(),pad,8);} ";
  page += "loadHistory();";
  page += "</script>";
  page += F("<div class='footer'>History lives in RAM; add SD/RTC for deeper or power-safe logging.</div>");
  page += F("</div></body></html>");
  server.send(200, "text/html", page);
}

// JSON status for AJAX polling
void handleStatus() {
  String json = "{";
  json += "\"mode\":\"" + mode + "\",";
  json += "\"temp\":\"" + (isnan(lastTempF) ? String("NaN") : String(lastTempF, 2) + " F") + "\",";
  json += "\"hum\":\"" + (isnan(lastHumidity) ? String("NaN") : String(lastHumidity, 1) + " %") + "\",";
  json += "\"feel\":\"" + (isnan(lastHeatIndexF) ? String("NaN") : String(lastHeatIndexF, 2) + " F") + "\",";
  json += "\"heat\":\"" + String(heatOn ? "ON" : "OFF") + "\",";
  json += "\"cool\":\"" + String(coolOn ? "ON" : "OFF") + "\",";
  json += "\"fan\":\"" + String(fanOn ? "ON" : "OFF") + "\",";
  json += "\"setpoint\":\"" + String(setpointF, 1) + " F\",";
  json += "\"diff\":\"" + String(diffF, 1) + " F\"";
  json += "}";
  server.send(200, "application/json", json);
}

// Set timezone offset (seconds) from client
void handleTz() {
  if (!requireControlAuth()) return;
  if (server.hasArg("offset")) {
    tzOffsetSec = server.arg("offset").toInt();
    configTime(tzOffsetSec, dstOffsetSec, "pool.ntp.org", "time.nist.gov", "time.google.com");
    server.send(200, "text/plain", "tz updated");
  } else {
    server.send(400, "text/plain", "offset required");
  }
}

void handleButtons() {
  unsigned long now = millis();
  bool pressed = false;
  if (now - lastBtnChange < DEBOUNCE_MS) {
    lastOk = digitalRead(BTN_OK);
    lastBack = digitalRead(BTN_BACK);
    lastUp = digitalRead(BTN_UP);
    lastDown = digitalRead(BTN_DOWN);
    return;
  }

  bool ok   = digitalRead(BTN_OK);
  bool back = digitalRead(BTN_BACK);
  bool up   = digitalRead(BTN_UP);
  bool down = digitalRead(BTN_DOWN);

  bool okPress   = (lastOk == HIGH && ok == LOW);
  bool backPress = (lastBack == HIGH && back == LOW);
  bool upPress   = (lastUp == HIGH && up == LOW);
  bool downPress = (lastDown == HIGH && down == LOW);

  if (okPress) {
    if (menuState == VIEW) menuState = MENU_MODE;
    else if (menuState == MENU_MODE) menuState = MENU_SET;
    else if (menuState == MENU_SET) menuState = MENU_DIFF;
    else menuState = VIEW;
    lastBtnChange = now;
    pressed = true;
  }

  if (backPress) {
    menuState = VIEW;
    lastBtnChange = now;
    pressed = true;
  }

  if (upPress) {
    if (menuState == MENU_MODE) cycleMode(+1);
    else if (menuState == MENU_SET || menuState == VIEW) setpointF += 0.5f;
    else if (menuState == MENU_DIFF) {
      diffF += 0.5f;
      if (diffF > 10.0f) diffF = 10.0f;
    }
    lastBtnChange = now;
    pressed = true;
  }

  if (downPress) {
    if (menuState == MENU_MODE) cycleMode(-1);
    else if (menuState == MENU_SET || menuState == VIEW) setpointF -= 0.5f;
    else if (menuState == MENU_DIFF) {
      diffF -= 0.5f;
      if (diffF < 0.1f) diffF = 0.1f;
    }
    lastBtnChange = now;
    pressed = true;
  }

  if (pressed) {
    if (setpointF < 40) setpointF = 40;
    if (setpointF > 90) setpointF = 90;
    mode = modes[modeIndex];
    overrideUntilNextSchedule = true;
    struct tm timeinfo;
    if (getLocalTime(&timeinfo)) {
      overrideStartHour = timeinfo.tm_hour;
      lastScheduleHour = overrideStartHour;
    } else {
      overrideStartHour = -1;
    }
    // Immediate feedback on OLED
    updateDisplay();
    if (DEBUG_SERIAL) {
      Serial.printf("[INPUT] Buttons OK=%d BACK=%d UP=%d DOWN=%d | Mode=%s Set=%.1f Diff=%.1f\n",
                    okPress ? 1 : 0, backPress ? 1 : 0, upPress ? 1 : 0, downPress ? 1 : 0,
                    mode.c_str(), setpointF, diffF);
    }
  }

  lastOk = ok;
  lastBack = back;
  lastUp = up;
  lastDown = down;
}

void cycleMode(int dir) {
  modeIndex = (modeIndex + dir) % 4;
  if (modeIndex < 0) modeIndex = 3;
  mode = modes[modeIndex];
}

void setOutput(int pin, bool on) {
  bool level = RELAY_ACTIVE_HIGH ? on : !on;
  digitalWrite(pin, level);
}

void updateDisplay() {
  if (!displayReady) return;
  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);
  display.setTextSize(1);
  if (!wifiConnected) {
    display.setCursor(0, 0);
    display.println("WiFi disconnected");
    display.setCursor(0, 16);
    if (apMode) {
      display.print("AP: ");
      display.println(AP_SSID);
      display.print("Go to http://");
      display.println(wifiIpStr);
    } else {
      display.println("AP starting...");
      display.print("IP: ");
      display.println(wifiIpStr);
    }
    display.display();
    return;
  }
  if (menuState == VIEW) {
    display.setCursor(0, 0);
    display.print("Mode ");
    display.println(mode);

    display.setCursor(0, 16);
    display.print("T: ");
    display.print(isnan(lastTempF) ? String("--") : String(lastTempF, 1));
    display.print("F");

    display.setCursor(0, 32);
    display.print("RF: ");
    display.print(isnan(lastHeatIndexF) ? String("--") : String(lastHeatIndexF, 1));
    display.print("F");

    display.setCursor(0, 48);
    display.print("Set ");
    display.print(String(setpointF, 1));
    display.print("F");
  } else if (menuState == MENU_MODE) {
    display.setCursor(0, 0);
    display.print("> Mode");
    display.setCursor(0, 16);
    display.print(modes[modeIndex]);
    display.setCursor(0, 32);
    display.print("Up/Dn change");
    display.setCursor(0, 48);
    display.print("OK next  Back exit");
  } else if (menuState == MENU_SET) {
    display.setCursor(0, 0);
    display.print("> Setpoint");
    display.setCursor(0, 16);
    display.print(String(setpointF, 1));
    display.print("F");
    display.setCursor(0, 32);
    display.print("Up/Dn adjust");
    display.setCursor(0, 48);
    display.print("OK next  Back exit");
  } else if (menuState == MENU_DIFF) {
    display.setCursor(0, 0);
    display.print("> Diff");
    display.setCursor(0, 16);
    display.print(String(diffF, 1));
    display.print("F");
    display.setCursor(0, 32);
    display.print("Up/Dn adjust");
    display.setCursor(0, 48);
    display.print("OK end  Back exit");
  }
  display.display();
}

const char* sdTypeToString(uint8_t type) {
  if (type == CARD_MMC) return "MMC";
  if (type == CARD_SD) return "SDSC";
  if (type == CARD_SDHC) return "SDHC/SDXC";
  if (type == CARD_NONE) return "NONE";
  return "UNKNOWN";
}

void logSdCardInfo(const char* context) {
  if (!DEBUG_SERIAL) return;
  if (!sdReady) {
    Serial.printf("[SD] %s: not ready\n", context);
    return;
  }
  uint8_t type = SD.cardType();
  if (type == CARD_NONE) {
    Serial.printf("[SD] %s: no card detected\n", context);
    sdReady = false;
    lastSdError = "card missing";
    return;
  }
  uint64_t size = SD.cardSize();
  Serial.printf("[SD] %s: type=%s size=%s\n", context, sdTypeToString(type), fmtBytes(size).c_str());
}

void sdWriteTest() {
  if (!DEBUG_SERIAL || !sdReady) return;
  File f = SD.open("/sd_diag.txt", FILE_APPEND);
  if (!f) {
    lastSdWriteOk = false;
    lastSdError = "diag open failed";
    sdWriteFailures++;
    sdReady = false;
    Serial.println("[SD] diag open failed");
    return;
  }
  uint32_t ts = (uint32_t)time(nullptr);
  if (ts == 0) ts = millis() / 1000;
  int written = f.printf("diag,%lu,heap=%lu\n", (unsigned long)ts, (unsigned long)ESP.getFreeHeap());
  f.close();
  lastSdWriteMs = millis();
  if (written > 0) {
    lastSdWriteOk = true;
    lastSdError = "ok";
    Serial.printf("[SD] diag write ok (%d bytes)\n", written);
  } else {
    lastSdWriteOk = false;
    lastSdError = "diag write failed";
    sdWriteFailures++;
    Serial.println("[SD] diag write failed");
  }
  File rf = SD.open("/sd_diag.txt", FILE_READ);
  if (rf) {
    Serial.printf("[SD] diag read ok, size=%lu bytes\n", (unsigned long)rf.size());
    rf.close();
  } else {
    Serial.println("[SD] diag read failed");
  }
}

void logHealth() {
  if (!DEBUG_SERIAL) return;
  unsigned long nowMs = millis();
  if (nowMs - lastHealthLog < HEALTH_LOG_INTERVAL_MS) return;
  lastHealthLog = nowMs;

  bool wifiOk = (WiFi.status() == WL_CONNECTED);
  bool sensorFresh = (nowMs - lastRead) < 5000 && !isnan(lastTempF) && !isnan(lastHumidity);
  float ctlTemp = !isnan(lastHeatIndexF) ? lastHeatIndexF : lastTempF;
  int okBtn = digitalRead(BTN_OK);
  int backBtn = digitalRead(BTN_BACK);
  int upBtn = digitalRead(BTN_UP);
  int downBtn = digitalRead(BTN_DOWN);

  if (sdReady) {
    uint8_t type = SD.cardType();
    if (type == CARD_NONE) {
      sdReady = false;
      lastSdWriteOk = false;
      lastSdError = "card missing";
      sdWriteFailures++;
      Serial.println("[SD] card missing");
    }
  }

  Serial.printf("[HEALTH] up=%lus wifi=%s rssi=%ld ip=%s sensor=%s T=%s H=%s ctl=%s mode=%s set=%.1f diff=%.1f heat=%s cool=%s fan=%s heap=%lu\n",
                nowMs / 1000,
                wifiOk ? "OK" : "NO",
                (long)WiFi.RSSI(),
                WiFi.localIP().toString().c_str(),
                sensorFresh ? "OK" : "STALE",
                isnan(lastTempF) ? "NaN" : String(lastTempF, 1).c_str(),
                isnan(lastHumidity) ? "NaN" : String(lastHumidity, 1).c_str(),
                isnan(ctlTemp) ? "NaN" : String(ctlTemp, 1).c_str(),
                mode.c_str(),
                setpointF, diffF,
                heatOn ? "ON" : "OFF",
                coolOn ? "ON" : "OFF",
                fanOn ? "ON" : "OFF",
                (unsigned long)ESP.getFreeHeap());
  Serial.printf("[INPUT] ok=%d back=%d up=%d down=%d menu=%d\n",
                okBtn, backBtn, upBtn, downBtn, (int)menuState);
  Serial.printf("[SD] ready=%d lastWrite=%s err=%s failures=%lu age=%lus\n",
                sdReady ? 1 : 0,
                lastSdWriteOk ? "OK" : "FAIL",
                lastSdError,
                sdWriteFailures,
                lastSdWriteMs == 0 ? 0UL : (nowMs - lastSdWriteMs) / 1000UL);
}


