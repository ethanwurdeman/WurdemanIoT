#include <Arduino.h>
#include <Wire.h>
#include <cstdio>
#include <ctime>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

#define XPOWERS_CHIP_AXP2101
#include <XPowersLib.h>

#include "config.h"

#define SerialMon Serial
#define SerialAT Serial1

#define TINY_GSM_MODEM_SIM7080
#include <TinyGsmClient.h>

#define ANSI_GREEN "\x1b[32m"
#define ANSI_CYAN "\x1b[36m"
#define ANSI_RESET "\x1b[0m"

#if ENABLE_AT_DEBUG
#include <StreamDebugger.h>
StreamDebugger debugger(SerialAT, SerialMon);
TinyGsm modem(debugger);
#else
TinyGsm modem(SerialAT);
#endif

TinyGsmClient netClient(modem);
WiFiClient wifiClient;
XPowersPMU pmu;

struct FixPayload
{
    bool hasFix = false;
    float lat = 0;
    float lon = 0;
    float hdop = 0;
    int sats = 0;
    uint64_t tsMs = 0;
};

static FixPayload lastFix;
static uint64_t cellTxBytes = 0;
static uint64_t cellRxBytes = 0;
static unsigned long nextGnssAt = 0;

enum class TrackerMode
{
    Home,
    Nearby,
    Roaming
};

static TrackerMode currentMode = TrackerMode::Home;

// Home base geofence (degrees) and radii (meters)
constexpr double HOME_LAT = 41.74570242514908;
constexpr double HOME_LON = -103.36769502711984;
constexpr double HOME_RADIUS_M = 76.2;   // 250 ft
constexpr double NEARBY_RADIUS_M = 228.6; // 750 ft

// Cadence per mode
constexpr uint32_t HOME_INTERVAL_MS = 5UL * 60UL * 1000UL;
constexpr uint32_t NEARBY_INTERVAL_MS = 2UL * 60UL * 1000UL;
constexpr uint32_t ROAM_INTERVAL_MS = 15UL * 1000UL;

bool connectWiFiIfConfigured() { return false; }
int readBatteryPercent()
{
    if (!pmu.isBatteryConnect())
    {
        return -1;
    }
    return pmu.getBatteryPercent();
}

bool readChargingStatus()
{
    return pmu.isCharging();
}

void printModeHeader(const char *label, const char *color)
{
    SerialMon.print(color);
    SerialMon.print("\n=== ");
    SerialMon.print(label);
    SerialMon.println(" ===");
    SerialMon.print(ANSI_RESET);
}

time_t portableTimegm(struct tm *t)
{
#if defined(_WIN32)
    return _mkgmtime(t);
#else
    // Approximate timegm using mktime and offset between localtime and gmtime
    time_t local = mktime(t);
    if (local == static_cast<time_t>(-1))
    {
        return static_cast<time_t>(-1);
    }
    struct tm *gt = gmtime(&local);
    if (!gt)
    {
        return static_cast<time_t>(-1);
    }
    time_t utc = mktime(gt);
    if (utc == static_cast<time_t>(-1))
    {
        return static_cast<time_t>(-1);
    }
    double offset = difftime(local, utc);
    return local + static_cast<time_t>(offset);
#endif
}

uint64_t toEpochMs(int year, int month, int day, int hour, int minute, int second)
{
    if (year < 1970 || month < 1 || day < 1)
    {
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
    if (ts < 0)
    {
        return millis();
    }
    return static_cast<uint64_t>(ts) * 1000ULL;
}

double distanceMeters(double lat1, double lon1, double lat2, double lon2)
{
    constexpr double kEarthRadiusM = 6371000.0;
    auto toRad = [](double deg) { return deg * M_PI / 180.0; };
    double dLat = toRad(lat2 - lat1);
    double dLon = toRad(lon2 - lon1);
    double a = sin(dLat / 2) * sin(dLat / 2) +
               cos(toRad(lat1)) * cos(toRad(lat2)) * sin(dLon / 2) * sin(dLon / 2);
    double c = 2 * atan2(sqrt(a), sqrt(1 - a));
    return kEarthRadiusM * c;
}

bool sendIngestIfReady()
{
    if (!lastFix.hasFix)
    {
        SerialMon.println("No GNSS fix available to send.");
        return false;
    }

    const char *host = "us-central1-wurdemaniot.cloudfunctions.net";
    const uint16_t port = 443;
    const char *path = "/ingest";

    const bool wifiUp = WiFi.isConnected();
    Client *client = wifiUp ? static_cast<Client *>(&wifiClient) : static_cast<Client *>(&netClient);

    if (!client->connect(host, port))
    {
        SerialMon.println("HTTP connect failed.");
        return false;
    }

    const int battPct = readBatteryPercent();
    const bool charging = readChargingStatus();

    auto makeBody = [&](size_t txBytesVal) {
        String body;
        body.reserve(256);
        body += "{";
        body += "\"deviceId\":\"Tyee\",";
        body += "\"name\":\"Tyee\",";
    body += "\"type\":\"pet\",";
        body += "\"lat\":";
        body += String(lastFix.lat, 6);
        body += ",\"lon\":";
        body += String(lastFix.lon, 6);
        body += ",\"ts\":";
        body += String(lastFix.tsMs);
        body += ",\"battery\":";
        body += (battPct >= 0 ? String(battPct) : "null");
        body += ",\"charging\":";
        body += (charging ? "true" : "false");
        body += ",\"network\":\"";
        body += (wifiUp ? "wifi" : "cell");
        body += "\"";
        body += ",\"txBytes\":";
        body += String(txBytesVal);
        body += ",\"rxBytes\":null";
        body += ",\"sats\":";
        body += String(lastFix.sats);
        body += ",\"hdop\":";
        body += String(lastFix.hdop, 2);
        body += ",\"enabled\":true}";
        return body;
    };

    auto makeHeaders = [&](size_t contentLength) {
        String headers;
        headers.reserve(256);
        headers += "POST ";
        headers += path;
        headers += " HTTP/1.1\r\n";
        headers += "Host: ";
        headers += host;
        headers += "\r\nContent-Type: application/json\r\n";
        headers += "Content-Length: ";
        headers += contentLength;
        headers += "\r\nConnection: close\r\n\r\n";
        return headers;
    };

    // two-pass to avoid content-length mismatch after inserting txBytes
    String body = makeBody(0);
    String headers = makeHeaders(body.length());
    size_t txLen = headers.length() + body.length();
    body = makeBody(txLen);
    headers = makeHeaders(body.length());
    txLen = headers.length() + body.length();

    client->print(headers);
    client->print(body);

    bool ok = false;
    String status;
    size_t rxLen = 0;
    unsigned long start = millis();
    while (millis() - start < 10000UL)
    {
        while (client->available())
        {
            char c = client->read();
            rxLen++;
            if (c == '\n')
            {
                if (status.startsWith("HTTP/1.1 200") || status.startsWith("HTTP/1.0 200"))
                {
                    ok = true;
                }
                start = millis();
            }
            else if (c != '\r')
            {
                status += c;
            }
        }
        if (!client->connected())
        {
            break;
        }
        delay(10);
    }
    client->stop();

    SerialMon.printf("Ingest POST status: %s\n", status.c_str());

    if (!wifiUp)
    {
        cellTxBytes += txLen;
        cellRxBytes += rxLen;
        SerialMon.printf("Cellular usage this send: tx=%u rx=%u bytes (total tx=%llu rx=%llu)\n",
                         static_cast<unsigned>(txLen),
                         static_cast<unsigned>(rxLen),
                         static_cast<unsigned long long>(cellTxBytes),
                         static_cast<unsigned long long>(cellRxBytes));
    }

    return ok;
}

void printPins()
{
    SerialMon.println("Board: LilyGO T-SIM7080G S3");
    SerialMon.println("Pin map:");
    SerialMon.printf("  MODEM RXD: %d\n", MODEM_SERIAL_RX);
    SerialMon.printf("  MODEM TXD: %d\n", MODEM_SERIAL_TX);
    SerialMon.printf("  MODEM PWR: %d\n", MODEM_PWRKEY_PIN);
    SerialMon.printf("  I2C SDA  : %d\n", I2C_SDA_PIN);
    SerialMon.printf("  I2C SCL  : %d\n", I2C_SCL_PIN);
}

void logHint(const char *msg)
{
    SerialMon.println(msg);
}

bool initPMU()
{
    Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN);
    if (!pmu.begin(Wire, AXP2101_SLAVE_ADDRESS, I2C_SDA_PIN, I2C_SCL_PIN))
    {
        SerialMon.println("PMU init failed (AXP2101 not found). Check I2C wiring.");
        return false;
    }

    // Restart modem rail on fresh power-up
    if (esp_sleep_get_wakeup_cause() == ESP_SLEEP_WAKEUP_UNDEFINED)
    {
        pmu.disableDC3();
        delay(200);
    }

    pmu.setSysPowerDownVoltage(2600);

    pmu.disableDC2();
    pmu.disableDC4();
    pmu.disableDC5();

    pmu.disableALDO1();
    pmu.disableALDO2();
    pmu.disableALDO3();
    pmu.disableALDO4();

    pmu.disableBLDO2();
    pmu.setBLDO1Voltage(3300);
    pmu.enableBLDO1(); // Keep BLDO1 on per LilyGO guidance

    pmu.disableCPUSLDO();
    pmu.disableDLDO1();
    pmu.disableDLDO2();

    // Main modem rail
    pmu.setDC3Voltage(3000);
    pmu.enableDC3();

    // GNSS antenna rail (enabled only during GNSS phase)
    pmu.setBLDO2Voltage(3300);

    pmu.setALDO1Voltage(1800);
    pmu.setALDO2Voltage(2800);
    pmu.setALDO3Voltage(3300);
    pmu.setALDO4Voltage(3000);

    pmu.disableTSPinMeasure();
    pmu.enableBattVoltageMeasure();
    pmu.enableVbusVoltageMeasure();
    pmu.enableSystemVoltageMeasure();
    pmu.disableTemperatureMeasure();

    SerialMon.printf("PMU rails: DC3=%s (%u mV), BLDO1=%s (%u mV)\n",
                     pmu.isEnableDC3() ? "ON" : "OFF", pmu.getDC3Voltage(),
                     pmu.isEnableBLDO1() ? "ON" : "OFF", pmu.getBLDO1Voltage());
    return true;
}

void powerPulseModem()
{
    pinMode(MODEM_PWRKEY_PIN, OUTPUT);
    digitalWrite(MODEM_PWRKEY_PIN, LOW);
    delay(100);
    digitalWrite(MODEM_PWRKEY_PIN, HIGH);
    delay(1000);
    digitalWrite(MODEM_PWRKEY_PIN, LOW);
}

bool waitForModem()
{
    int retry = 0;
    while (!modem.testAT(AT_WAIT_MS))
    {
        SerialMon.print(".");
        if (++retry >= AT_RETRY_LIMIT)
        {
            SerialMon.println("\nAT timeout. UART/modem power issue?");
            return false;
        }
        if (retry % 5 == 0)
        {
            SerialMon.println("\nRetrying modem power pulse...");
            powerPulseModem();
        }
        delay(500);
    }
    SerialMon.println("\nAT response OK");
    return true;
}

bool checkSimReady()
{
    SerialMon.println("Checking SIM (CPIN)...");
    const unsigned long start = millis();

    while (millis() - start < 60000UL) // 60s overall timeout
    {
        modem.sendAT("+CPIN?");

        // Prefer token matching over capturing raw text
        // Returns:
        //  1 if "READY" matched
        //  2 if "SIM PIN" matched
        //  3 if "NOT INSERTED" matched
        //  0 or -1 on timeout/error
        int8_t r = modem.waitResponse(2000, "READY", "SIM PIN", "NOT INSERTED");

        if (r == 1)
        {
            SerialMon.println("CPIN: READY");
            return true;
        }
        if (r == 2)
        {
            logHint("CPIN: SIM PIN (SIM is locked). Unlock SIM or disable PIN.");
            return false;
        }
        if (r == 3)
        {
            logHint("CPIN: NOT INSERTED (SIM not detected). Reseat SIM.");
            return false;
        }

        SerialMon.println("CPIN not ready yet... retrying");
        delay(2000);
    }

    logHint("CPIN check timed out. Modem/SIM init still not ready.");
    return false;
}


void printSignalAndReg()
{
    int16_t csq = modem.getSignalQuality();
    SerialMon.printf("CSQ: %d\n", csq);

    String resp;
    modem.sendAT("+CEREG?");
    modem.waitResponse(2000, resp);
    SerialMon.print("AT+CEREG?: ");
    SerialMon.println(resp);

    resp = "";
    modem.sendAT("+CREG?");
    modem.waitResponse(2000, resp);
    SerialMon.print("AT+CREG?: ");
    SerialMon.println(resp);

    resp = "";
    modem.sendAT("+COPS?");
    modem.waitResponse(2000, resp);
    SerialMon.print("Operator: ");
    SerialMon.println(resp);
}

int readRegStatus()
{
    String resp;
    modem.sendAT("+CEREG?");
    modem.waitResponse(2000, resp);
    int stat = -1;
    int mode = 0;
    if (sscanf(resp.c_str(), "+CEREG: %d,%d", &mode, &stat) == 2)
    {
        return stat;
    }
    resp = "";
    modem.sendAT("+CREG?");
    modem.waitResponse(2000, resp);
    if (sscanf(resp.c_str(), "+CREG: %d,%d", &mode, &stat) == 2)
    {
        return stat;
    }
    return -1;
}


bool waitForRegistration()
{
    SerialMon.println("Waiting for network registration (CEREG)...");
    const unsigned long start = millis();

    while (millis() - start < REGISTRATION_TIMEOUT)
    {
        // Ask explicitly each loop
        modem.sendAT("+CEREG?");

        // Match the “registered” states:
        // 0,1 = home registered
        // 0,5 = roaming registered
        int8_t r = modem.waitResponse(3000, "+CEREG: 0,1", "+CEREG: 0,5");

        int16_t csq = modem.getSignalQuality();
        SerialMon.printf("Reg check: %s  CSQ: %d\n",
                         (r == 1) ? "HOME" : (r == 2) ? "ROAM" : "NOT YET",
                         csq);

        if (r == 1 || r == 2)
        {
            SerialMon.println("Network registration OK");
            return true;
        }

        delay(3000);
    }

    logHint("Registration timeout. Check antenna/SIM/coverage.");
    return false;
}


void ensureGnssOff()
{
    modem.disableGPS();
    modem.sendAT("+CGNSPWR=0");
    modem.waitResponse(2000);
    pmu.disableBLDO2();
}

int getCgattState()
{
    String resp;
    modem.sendAT("+CGATT?");
    int8_t r = modem.waitResponse(5000, resp);
    SerialMon.print("AT+CGATT?: ");
    SerialMon.println(resp);
    if (r != 1)
    {
        return -1;
    }
    int state = -1;
    int idx = resp.indexOf("+CGATT:");
    if (idx >= 0)
    {
        if (sscanf(resp.substring(idx).c_str(), "+CGATT: %d", &state) != 1)
        {
            state = -1;
        }
    }
    return state;
}

bool waitForCgattState(int target, uint32_t timeoutMs)
{
    unsigned long start = millis();
    while (millis() - start < timeoutMs)
    {
        int state = getCgattState();
        if (state == target)
        {
            return true;
        }
        delay(1000);
    }
    return false;
}

bool parseCNACT(const String &resp, bool &cid1Active, String &ip)
{
    cid1Active = false;
    ip = "0.0.0.0";
    int search = 0;
    while (true)
    {
        int idx = resp.indexOf("+CNACT:", search);
        if (idx < 0)
        {
            break;
        }
        int lineEnd = resp.indexOf('\n', idx);
        String line = lineEnd >= 0 ? resp.substring(idx, lineEnd) : resp.substring(idx);
        int cid = 0, state = 0;
        char ipBuf[32] = {0};
        if (sscanf(line.c_str(), "+CNACT: %d,%d,\"%31[^\"]\"", &cid, &state, ipBuf) == 3 ||
            sscanf(line.c_str(), "+CNACT: %d,%d,%31s", &cid, &state, ipBuf) == 3)
        {
            if (cid == 1)
            {
                cid1Active = (state == 1);
                ip = String(ipBuf);
                return true;
            }
        }
        else if (sscanf(line.c_str(), "+CNACT: %d,%d", &cid, &state) == 2)
        {
            if (cid == 1)
            {
                cid1Active = (state == 1);
                ip = "0.0.0.0";
                return true;
            }
        }
        search = idx + 1;
    }
    return false;
}

bool queryCNACTStatus(bool &cid1Active, String &ip)
{
    String resp;
    modem.sendAT("+CNACT?");
    modem.waitResponse(5000, resp);
    SerialMon.print("AT+CNACT?: ");
    SerialMon.println(resp);
    return parseCNACT(resp, cid1Active, ip);
}

bool detachPdpWithFallback()
{
    SerialMon.println("Detaching PDP/CGATT...");
    bool detached = false;
    for (int attempt = 0; attempt < 3 && !detached; ++attempt)
    {
        modem.sendAT("+CGACT=0,1");
        modem.waitResponse(5000);

        modem.sendAT("+CGATT=0");
        modem.waitResponse(5000);

        detached = waitForCgattState(0, 10000);
        if (!detached)
        {
            SerialMon.println("CGATT detach pending, retry...");
        }
    }

    if (!detached)
    {
        SerialMon.println("CGATT detach failed, toggling CFUN...");
        modem.sendAT("+CFUN=0");
        modem.waitResponse(5000);
        delay(5000);
        modem.sendAT("+CFUN=1");
        modem.waitResponse(5000);
        detached = waitForCgattState(0, 10000);
    }

    bool cid1Active = false;
    String ip;
    queryCNACTStatus(cid1Active, ip);
    if (cid1Active)
    {
        SerialMon.printf("CID1 still active, IP: %s\n", ip.c_str());
    }
    else
    {
        SerialMon.println("CID1 inactive.");
    }

    if (!detached)
    {
        logHint("Detach failed. CGATT stayed 1.");
    }
    return detached;
}

bool activatePdp(String &ipOut)
{
    SerialMon.println("=== Cellular attach + PDP ===");
    ensureGnssOff();

    modem.sendAT("+CFUN=1");
    modem.waitResponse(5000);

    modem.sendAT("+CGNSPWR=0");
    modem.waitResponse(2000);

    String apnCmd = String("+CGDCONT=1,\"IP\",\"") + APN + "\"";
    modem.sendAT(apnCmd.c_str());
    modem.waitResponse(5000);

    modem.sendAT("+CGATT=1");
    modem.waitResponse(5000);

    if (!waitForCgattState(1, 60000))
    {
        logHint("CGATT did not reach 1.");
        return false;
    }

    String resp;
    modem.sendAT("+CNACT=1,1");
    modem.waitResponse(10000, resp);
    SerialMon.print("AT+CNACT=1,1 -> ");
    SerialMon.println(resp);

    bool cid1Active = false;
    String ip;
    queryCNACTStatus(cid1Active, ip);

    if (!cid1Active || ip == "0.0.0.0")
    {
        logHint("CNACT did not show active IP for CID1.");
        ipOut = ip;
        return false;
    }

    ipOut = ip;
    SerialMon.printf("PDP active. IP: %s\n", ip.c_str());
    return true;
}

void runCellularCycle()
{
    printModeHeader("Cellular mode", ANSI_GREEN);

    ensureGnssOff();
    modem.sendAT("+CFUN=1");
    modem.waitResponse(5000);

    printSignalAndReg();

    if (!checkSimReady())
        return;

    modem.sendAT("+COPS=0");
    modem.waitResponse(10000);


    if (!waitForRegistration())
        return;

    printSignalAndReg();

    String ip;
    if (!activatePdp(ip))
    {
        logHint("PDP activation failed.");
        return;
    }

    sendIngestIfReady();

    delay(PDP_ACTIVE_MS);
    detachPdpWithFallback();
}

void runGnssCycle()
{
    printModeHeader("GNSS mode", ANSI_CYAN);

    if (!detachPdpWithFallback())
    {
        logHint("Skipping GNSS because detach failed.");
        ensureGnssOff();
        return;
    }

    modem.sendAT("+CFUN=0"); // reduce RF use during GNSS
    modem.waitResponse(3000);

    pmu.enableBLDO2();
    if (!modem.enableGPS())
    {
        logHint("Failed to enable GNSS.");
        return;
    }

    SerialMon.println("GNSS on. Waiting for fix...");
    unsigned long start = millis();
    float lat = 0, lon = 0, speed = 0, alt = 0, hdop = 0;
    int vsat = 0, usat = 0;
    int year = 0, month = 0, day = 0, hour = 0, minute = 0, second = 0;

    while (millis() - start < GNSS_FIX_TIMEOUT_MS)
    {
        if (modem.getGPS(&lat, &lon, &speed, &alt, &vsat, &usat, &hdop,
                         &year, &month, &day, &hour, &minute, &second))
        {
            SerialMon.println("GNSS fix acquired:");
            SerialMon.printf("  Lat: %.6f\n", lat);
            SerialMon.printf("  Lon: %.6f\n", lon);
            SerialMon.printf("  Alt: %.2f m (%.2f ft)\n", alt, alt * 3.28084);
            SerialMon.printf("  Speed: %.2f kn (%.2f mph)\n", speed, speed * 1.15078);
            SerialMon.printf("  Sats(v/u): %d/%d\n", vsat, usat);
            SerialMon.printf("  HDOP/acc: %.2f\n", hdop);
            SerialMon.printf("  UTC: %04d-%02d-%02d %02d:%02d:%02d\n",
                             year, month, day, hour, minute, second);

            lastFix.hasFix = true;
            lastFix.lat = lat;
            lastFix.lon = lon;
            lastFix.hdop = hdop;
            lastFix.sats = usat;
            lastFix.tsMs = toEpochMs(year, month, day, hour, minute, second);

            double dist = distanceMeters(lat, lon, HOME_LAT, HOME_LON);
            TrackerMode newMode = TrackerMode::Home;
            if (dist > NEARBY_RADIUS_M)
            {
                newMode = TrackerMode::Roaming;
            }
            else if (dist > HOME_RADIUS_M)
            {
                newMode = TrackerMode::Nearby;
            }
            currentMode = newMode;
            SerialMon.printf("Mode set to %s (dist %.1f m)\n",
                             currentMode == TrackerMode::Home   ? "Home"
                             : currentMode == TrackerMode::Nearby ? "Nearby"
                                                                   : "Roaming",
                             dist);
            break;
        }
        SerialMon.println("No fix yet...");
        delay(2000);
    }

    modem.disableGPS();
    modem.sendAT("+CGNSPWR=0");
    modem.waitResponse(2000);
    pmu.disableBLDO2();
    SerialMon.println("GNSS off.");
}

void setup()
{
    SerialMon.begin(115200);
    while (!SerialMon)
    {
        delay(10);
    }
    delay(200);

    printPins();

    if (!initPMU())
    {
        logHint("PMU init failed. Holding.");
        while (true)
            delay(1000);
    }

    SerialMon.println("Bringing up modem UART...");
    SerialAT.begin(MODEM_BAUD, SERIAL_8N1, MODEM_SERIAL_RX, MODEM_SERIAL_TX);
    powerPulseModem();

    if (!waitForModem())
    {
        logHint("Modem did not respond to AT. Check UART pins or power rails.");
    }

    nextGnssAt = millis();
}

void loop()
{
    unsigned long now = millis();
    if (now < nextGnssAt)
    {
        delay(100);
        return;
    }

    runGnssCycle();

    // Send over WiFi if at home; otherwise send based on mode (cellular allowed outside home).
    if (currentMode == TrackerMode::Home)
    {
        sendIngestIfReady();
        nextGnssAt = millis() + HOME_INTERVAL_MS;
    }
    else
    {
        runCellularCycle();
        nextGnssAt = millis() + (currentMode == TrackerMode::Nearby ? NEARBY_INTERVAL_MS : ROAM_INTERVAL_MS);
    }
}


