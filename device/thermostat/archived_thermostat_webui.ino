// NanoESP32_UsbStabilityDiag.ino
// Operator checklist (recovery steps):
// 1) Hold BOOT while plugging in USB to force ROM/bootloader mode if needed.
// 2) Reflash this diagnostic sketch.
// 3) Windows Device Manager -> Universal Serial Bus controllers -> USB Root Hub (USB 3.0/2.0)
//    -> Power Management tab -> uncheck "Allow the computer to turn off this device to save power".
//
// DFU/USB CDC notes and best practices:
// - Serial Monitor must be opened at 115200 baud.
// - After DFU upload, the board re-enumerates from DFU to CDC; wait 3-5 seconds before opening Serial Monitor.
// - Double reset may enter bootloader; single reset runs sketch.
// - If Serial Monitor is flaky, close it, wait a few seconds, then reopen.
//
// Optional compile-time flags (OFF by default):
// #define ENABLE_WDT_TEST   // Intentionally triggers a watchdog reset after N seconds.
// #define ENABLE_HEAP_STRESS // Alloc/free pattern to catch instability.

#include <Arduino.h>
#include <esp_system.h>
#include <esp_spi_flash.h>
#include <esp_chip_info.h>
#include <esp_heap_caps.h>
#include <esp_task_wdt.h>

// Config
static const uint32_t SERIAL_BAUD = 115200;
static const uint32_t SERIAL_ENUM_DELAY_MS = 2500;
static const uint32_t SERIAL_WAIT_TIMEOUT_MS = 5000;
static const uint32_t HEARTBEAT_INTERVAL_MS = 1000;
static const uint32_t LOW_HEAP_THRESHOLD_BYTES = 80 * 1024;

#ifdef ENABLE_WDT_TEST
static const uint32_t WDT_TRIGGER_AFTER_SEC = 20;
#endif

#ifdef ENABLE_HEAP_STRESS
static const size_t HEAP_STRESS_BLOCKS = 16;
static const size_t HEAP_STRESS_BLOCK_SIZE = 1024;
static uint8_t *heapBlocks[HEAP_STRESS_BLOCKS] = {0};
#endif

static uint32_t bootMillis = 0;
static uint32_t lastBeatMillis = 0;

static const char *resetReasonToString(esp_reset_reason_t reason) {
  switch (reason) {
    case ESP_RST_POWERON: return "POWERON";
    case ESP_RST_EXT: return "EXTERNAL";
    case ESP_RST_SW: return "SW";
    case ESP_RST_PANIC: return "PANIC";
    case ESP_RST_INT_WDT: return "INT_WDT";
    case ESP_RST_TASK_WDT: return "TASK_WDT";
    case ESP_RST_WDT: return "WDT";
    case ESP_RST_DEEPSLEEP: return "DEEPSLEEP";
    case ESP_RST_BROWNOUT: return "BROWNOUT";
    case ESP_RST_SDIO: return "SDIO";
    default: return "UNKNOWN";
  }
}

static void printSystemInfo() {
  esp_chip_info_t chipInfo;
  esp_chip_info(&chipInfo);

  uint32_t flashSize = 0;
  if (esp_flash_get_size(NULL, &flashSize) != ESP_OK) {
    flashSize = 0;
  }

  Serial.println();
  Serial.println(F("=== Nano ESP32 USB Stability Diagnostic ==="));
  Serial.printf("Chip model: ESP32-S3 (cores: %u)\n", chipInfo.cores);
  Serial.printf("Chip revision: %u\n", chipInfo.revision);
  Serial.printf("Flash size: %u bytes\n", flashSize);
  Serial.printf("CPU frequency: %u MHz\n", getCpuFrequencyMhz());
  Serial.printf("Free heap: %u bytes\n", ESP.getFreeHeap());
  Serial.printf("Min heap ever: %u bytes\n", heap_caps_get_minimum_free_size(MALLOC_CAP_8BIT));
  Serial.printf("Temperature: %.2f C\n", temperatureRead());
  Serial.println(F("=========================================="));
  Serial.println();
}

static void printResetReason() {
  esp_reset_reason_t rr = esp_reset_reason();
  Serial.printf("Reset reason: %s (%d)\n", resetReasonToString(rr), (int)rr);
}

static void printHelp() {
  Serial.println(F("Commands:"));
  Serial.println(F("  ? or h - help"));
  Serial.println(F("  i      - system info"));
  Serial.println(F("  b      - reset reason"));
  Serial.println(F("  r      - reboot"));
}

static void waitForSerial(uint32_t timeoutMs) {
  uint32_t start = millis();
  while (!Serial && (millis() - start) < timeoutMs) {
    delay(10);
  }
}

static void handleSerialCommands() {
  while (Serial.available() > 0) {
    int c = Serial.read();
    if (c < 0) {
      break;
    }
    if (c == '\n' || c == '\r') {
      continue;
    }

    switch (c) {
      case '?':
      case 'h':
      case 'H':
        printHelp();
        break;
      case 'i':
      case 'I':
        printSystemInfo();
        break;
      case 'b':
      case 'B':
        printResetReason();
        break;
      case 'r':
      case 'R':
        Serial.println(F("Rebooting..."));
        Serial.flush();
        delay(50);
        ESP.restart();
        break;
      default:
        break;
    }
  }
}

#ifdef ENABLE_HEAP_STRESS
static void heapStressStep() {
  // Simple alloc/free pattern to surface heap instability.
  for (size_t i = 0; i < HEAP_STRESS_BLOCKS; ++i) {
    if (!heapBlocks[i]) {
      heapBlocks[i] = (uint8_t *)malloc(HEAP_STRESS_BLOCK_SIZE);
      if (heapBlocks[i]) {
        memset(heapBlocks[i], 0xA5, HEAP_STRESS_BLOCK_SIZE);
      }
    }
  }
  for (size_t i = 0; i < HEAP_STRESS_BLOCKS; ++i) {
    if (heapBlocks[i]) {
      free(heapBlocks[i]);
      heapBlocks[i] = nullptr;
    }
  }
}
#endif

void setup() {
  Serial.begin(SERIAL_BAUD);
  delay(SERIAL_ENUM_DELAY_MS);
  waitForSerial(SERIAL_WAIT_TIMEOUT_MS);

  bootMillis = millis();
  printSystemInfo();
  printResetReason();

#ifdef ENABLE_WDT_TEST
  // Configure task watchdog to trigger if loop blocks too long.
  esp_task_wdt_init(5, true); // 5 second timeout, panic on trigger.
  esp_task_wdt_add(NULL);
#endif
}

void loop() {
  handleSerialCommands();
  uint32_t now = millis();

#ifdef ENABLE_WDT_TEST
  if ((now - bootMillis) > (WDT_TRIGGER_AFTER_SEC * 1000UL)) {
    // Stop feeding WDT to intentionally trigger a reset for diagnostics.
    while (true) {
      delay(1000);
    }
  } else {
    esp_task_wdt_reset();
  }
#endif

#ifdef ENABLE_HEAP_STRESS
  heapStressStep();
#endif

  if (now - lastBeatMillis >= HEARTBEAT_INTERVAL_MS) {
    lastBeatMillis = now;
    uint32_t uptimeSec = (now - bootMillis) / 1000UL;
    uint32_t freeHeap = ESP.getFreeHeap();
    float tempC = temperatureRead();

    Serial.printf("[HB] uptime=%lus free_heap=%uB temp=%.2fC\n",
                  (unsigned long)uptimeSec, freeHeap, tempC);

    if (freeHeap < LOW_HEAP_THRESHOLD_BYTES) {
      Serial.printf("[WARN] Low heap: %uB (threshold=%uB)\n",
                    freeHeap, LOW_HEAP_THRESHOLD_BYTES);
    }
  }
}
