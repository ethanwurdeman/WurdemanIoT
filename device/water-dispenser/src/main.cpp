#include <Arduino.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <EEPROM.h>
#include <string.h>

// -------- Pins --------
const uint8_t PIN_PUSH    = 2;
const uint8_t PIN_CONFIRM = 3;
const uint8_t PIN_BACK    = 4;
const uint8_t PIN_UP      = 5;
const uint8_t PIN_DOWN    = 6;
const uint8_t PIN_RELAY   = 12;

// -------- Display --------
#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
Adafruit_SSD1306 oled(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, -1);
const uint8_t OLED_ADDR = 0x3C; // change to 0x3D if needed

// -------- Timing / Behavior --------
const unsigned long DEBOUNCE_MS     = 30;
const unsigned long RECAL_HOLD_MS   = 5000;
const unsigned long BACK_SHUT_MS    = 10000;
const unsigned long CONFIRM_BOOT_MS = 5000;
const uint8_t       MAX_SAMPLES     = 10;

// -------- State --------
enum Mode { CALIBRATING, UNIT_SELECT, AMOUNT_SELECT, POURING, STANDBY, SHUTDOWN };
Mode mode = CALIBRATING;

enum Unit { TSP, TBSP, CUP, OZ, GAL, UNIT_COUNT };
const char* UNIT_NAMES[UNIT_COUNT] = { "tsp", "Tbsp", "Cup", "oz", "Gal" };
const float UNIT_TO_CUPS[UNIT_COUNT] = {
  1.0f / 48.0f,
  1.0f / 16.0f,
  1.0f,
  1.0f / 8.0f,
  16.0f
};

float msPerCup = 1000.0f;
bool calMeasured = false;
unsigned long calTotalMs = 0;
bool hasCalibration = false;

Unit selectedUnit = CUP;
uint16_t amountQuarter = 4; // 1.00 in quarter units

unsigned long lastActivity = 0;
unsigned long pourEnd = 0;
bool relayActive = false;

// -------- Buttons --------
struct Button {
  explicit Button(uint8_t p) : pin(p) {}
  uint8_t pin;
  bool lastReading = false;
  bool stable = false;
  unsigned long lastChange = 0;
  bool pressedEvent = false;
  bool releasedEvent = false;
  unsigned long pressedAt = 0;
} btnPush{PIN_PUSH}, btnConfirm{PIN_CONFIRM}, btnBack{PIN_BACK},
  btnUp{PIN_UP}, btnDown{PIN_DOWN};

void updateButton(Button &b) {
  bool reading = digitalRead(b.pin) == LOW; // active-low
  unsigned long now = millis();
  if (reading != b.lastReading) {
    b.lastChange = now;
    b.lastReading = reading;
  }
  if ((now - b.lastChange) > DEBOUNCE_MS && reading != b.stable) {
    b.stable = reading;
    if (b.stable) {
      b.pressedEvent = true;
      b.pressedAt = now;
    } else {
      b.releasedEvent = true;
    }
  }
}

void clearEvents() {
  btnPush.pressedEvent = btnPush.releasedEvent = false;
  btnConfirm.pressedEvent = btnConfirm.releasedEvent = false;
  btnBack.pressedEvent = btnBack.releasedEvent = false;
  btnUp.pressedEvent = btnUp.releasedEvent = false;
  btnDown.pressedEvent = btnDown.releasedEvent = false;
}

// -------- Helpers --------
void setRelay(bool on) {
  relayActive = on;
  digitalWrite(PIN_RELAY, on ? HIGH : LOW); // flip logic if your relay is active-low
}

void resetInactivity() { lastActivity = millis(); }

float cupsForSelection() {
  return UNIT_TO_CUPS[selectedUnit] * (amountQuarter / 4.0f);
}

// Pause handling for pouring
bool pourPaused = false;
unsigned long remainingPourMs = 0;
uint8_t pourPushCount = 0;
unsigned long pourDurationMs = 0;
unsigned long pourStartMs = 0;
unsigned long lastPourDraw = 0;
unsigned long highlightUpUntil = 0;
unsigned long highlightDownUntil = 0;
bool calPrompt = false;

void formatAmount(char* out, size_t sz, uint16_t q, Unit unit) {
  if (unit == OZ) {
    uint16_t wholeOz = q / 4;
    snprintf(out, sz, "%u", wholeOz);
    return;
  }
  uint16_t whole = q / 4;
  uint8_t rem = q % 4;
  if (whole > 0 && rem > 0) {
    snprintf(out, sz, "%u %u/4", whole, rem);
  } else if (whole > 0) {
    snprintf(out, sz, "%u", whole);
  } else {
    snprintf(out, sz, "%u/4", rem);
  }
}

void formatQuarter(char* out, size_t sz, uint16_t q) {
  uint16_t whole = q / 4;
  uint8_t rem = q % 4;
  if (whole > 0 && rem > 0) {
    snprintf(out, sz, "%u %u/4", whole, rem);
  } else if (whole > 0) {
    snprintf(out, sz, "%u", whole);
  } else {
    snprintf(out, sz, "%u/4", rem);
  }
}

unsigned long loadCalibration() {
  unsigned long stored;
  EEPROM.get(0, stored);
  // Treat 0xFFFFFFFF or 0 as "not set" or if absurdly large (> 10 minutes)
  if (stored == 0xFFFFFFFF || stored == 0 || stored > 600000) {
    hasCalibration = false;
    return 0;
  }
  hasCalibration = true;
  return stored;
}

void saveCalibration(unsigned long ms) {
  EEPROM.put(0, ms);
  hasCalibration = true;
}

void drawText(const char* line1, const char* line2) {
  oled.clearDisplay();
  oled.setTextSize(1);
  oled.setTextColor(SSD1306_WHITE);
  oled.setCursor(0, 0);
  oled.print(line1);
  oled.setCursor(0, 16);
  oled.print(line2);
  oled.display();
}

void drawStatus(const char* status) {
  char top[16];
  char amt[12];
  formatAmount(amt, sizeof(amt), amountQuarter, selectedUnit);
  snprintf(top, sizeof(top), "%s %s", amt, UNIT_NAMES[selectedUnit]);
  drawText(top, status);
}

void showUnitScreen(unsigned long now = 0) {
  if (now == 0) now = millis();
  oled.clearDisplay();
  oled.setTextSize(3);
  oled.setTextColor(SSD1306_WHITE);
  const char* unit = UNIT_NAMES[selectedUnit];
  uint8_t len = strlen(unit);
  uint8_t textW = len * 6 * 3; // font width * size
  int16_t x = (SCREEN_WIDTH - textW) / 2;
  if (x < 0) x = 0;
  oled.setCursor(x, 18);
  oled.print(unit);
  oled.display();
}

void drawPourProgress(float pct, unsigned long now) {
  if (pct < 0) pct = 0;
  if (pct > 1) pct = 1;
  static uint8_t phase = 0;
  phase = (uint8_t)((now / 100) & 0xFF);
  oled.clearDisplay();
  int height = (int)(pct * 60); // fill up to 60px height
  int yStart = SCREEN_HEIGHT - 1 - height;
  oled.fillRect(0, yStart, SCREEN_WIDTH, height, SSD1306_WHITE);
  oled.drawRect(0, 0, SCREEN_WIDTH, SCREEN_HEIGHT, SSD1306_WHITE);
  char buf[16];
  snprintf(buf, sizeof(buf), "%3d%%", (int)(pct * 100));
  // Large, centered text; switch to black if the fill reaches it
  uint8_t textSize = 2;
  uint8_t textW = strlen(buf) * 6 * textSize;
  uint8_t textH = 8 * textSize;
  int16_t textX = (SCREEN_WIDTH - textW) / 2;
  int16_t textY = (SCREEN_HEIGHT - textH) / 2;
  bool fillOverText = yStart <= (textY + textH);
  oled.setTextSize(textSize);
  oled.setTextColor(fillOverText ? SSD1306_BLACK : SSD1306_WHITE);
  oled.setCursor(textX, textY);
  oled.print(buf);
  // Vertical stream to the right of the % text
  int streamLeftBound = textX + textW + 4;
  if (streamLeftBound < SCREEN_WIDTH - 4) {
    int streamRightBound = SCREEN_WIDTH - 4;
    int streamCenter = (streamLeftBound + streamRightBound) / 2;
    int centerX = streamCenter + (int)(3 * sin((float)phase * 0.15f));
    int streamTop = 0;
    int streamBottom = max(0, yStart - 4);
    oled.drawLine(centerX, streamTop, centerX, streamBottom, SSD1306_WHITE);
    // Localized slashes near the stream on the surface
    int waveBase = yStart - 1;
    for (int x = centerX - 10; x <= centerX + 10; x += 6) {
      int wiggle = ((phase + x) % 6) - 2; // -2..3 px wiggle
      oled.drawLine(x, waveBase + wiggle, x + 4, waveBase - wiggle, SSD1306_WHITE);
    }
  }
  oled.display();
}

void enterCalibration(bool clear) {
  if (clear) {
    msPerCup = 1000.0f;
    calMeasured = false;
    calTotalMs = 0;
  }
  mode = CALIBRATING;
  setRelay(false);
  drawText("CALIBRATION", "Hold D2 to 1c");
}

void enterUnitSelect() {
  mode = UNIT_SELECT;
  showUnitScreen();
  calMeasured = true; // allow amount entry even after power-on with stored calibration
}

void showAmountScreen(unsigned long now = 0) {
  if (now == 0) now = millis();
  oled.clearDisplay();
  oled.setTextSize(3);
  oled.setTextColor(SSD1306_WHITE);
  // Amount on top line, unit on bottom, centered in remaining space
  oled.setTextSize(3);
  char amt[16];
  formatAmount(amt, sizeof(amt), amountQuarter, selectedUnit);
  const char* unit = UNIT_NAMES[selectedUnit];
  uint8_t amtW = strlen(amt) * 6 * 3;
  uint8_t unitW = strlen(unit) * 6 * 3;
  int16_t amtX = (SCREEN_WIDTH - amtW) / 2;
  int16_t unitX = (SCREEN_WIDTH - unitW) / 2;
  if (amtX < 0) amtX = 0;
  if (unitX < 0) unitX = 0;
  oled.setCursor(amtX, 10);
  oled.print(amt);
  oled.setCursor(unitX, 36);
  oled.print(unit);
  oled.display();
}

void enterAmountSelect() {
  mode = AMOUNT_SELECT;
  // Align to whole for ounces
  if (selectedUnit == OZ) {
    if (amountQuarter < 4) amountQuarter = 4;
    amountQuarter = (amountQuarter / 4) * 4;
  }
  showAmountScreen();
}

void enterStandby() {
  // Standby temporarily disabled; keep UI unchanged.
}

// Shutdown flow removed; Back now navigates instead of shutting down.

void startPour() {
  float duration = cupsForSelection() * msPerCup;
  pourEnd = millis() + (unsigned long)duration;
  pourDurationMs = (unsigned long)duration;
  pourStartMs = millis();
  mode = POURING;
  pourPaused = false;
  pourPushCount = 0;
  lastPourDraw = 0;
  setRelay(true);
  drawPourProgress(0.0f, millis());
}

void setup() {
  pinMode(PIN_PUSH, INPUT_PULLUP);
  pinMode(PIN_CONFIRM, INPUT_PULLUP);
  pinMode(PIN_BACK, INPUT_PULLUP);
  pinMode(PIN_UP, INPUT_PULLUP);
  pinMode(PIN_DOWN, INPUT_PULLUP);
  pinMode(PIN_RELAY, OUTPUT);
  setRelay(false);

  if (!oled.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR)) {
    // Display init failed; blink relay pin as error indicator
    while (true) {
      digitalWrite(PIN_RELAY, HIGH);
      delay(200);
      digitalWrite(PIN_RELAY, LOW);
      delay(200);
    }
  }

  oled.clearDisplay();
  oled.display();

  // Splash: drop falling into a cup
  oled.clearDisplay();
  oled.setTextSize(1);
  oled.setTextColor(SSD1306_WHITE);
  oled.setCursor(80, 0);
  oled.print("Dispense");
  oled.setCursor(80, 10);
  oled.print("Ready");
  // Cup outline
  oled.drawRect(32, 40, 32, 20, SSD1306_WHITE);
  oled.display();
  // Animate drop and fill
  for (uint8_t y = 0; y < 32; y += 4) {
    oled.fillRect(48, 8, 4, y + 1, SSD1306_WHITE); // drop column
    if (y > 8) oled.drawLine(32, 60, 63, 60, SSD1306_WHITE); // floor stays
    oled.display();
    delay(80);
    oled.fillRect(48, 8, 4, y + 1, SSD1306_BLACK); // clear drop trail
  }
  // Fill cup
  for (int h = 0; h <= 18; h += 3) {
    oled.fillRect(33, 58 - h, 30, 1, SSD1306_WHITE);
    oled.display();
    delay(60);
  }
  delay(400);

  resetInactivity();
  unsigned long stored = loadCalibration();
  if (hasCalibration && stored > 0) {
    msPerCup = stored;
    enterUnitSelect();
  } else {
    enterCalibration(true);
  }
}

void loop() {
  unsigned long now = millis();

  updateButton(btnPush);
  updateButton(btnConfirm);
  updateButton(btnBack);
  updateButton(btnUp);
  updateButton(btnDown);

  // Activity tick (standby disabled)
  if (btnPush.pressedEvent || btnPush.releasedEvent ||
      btnConfirm.pressedEvent || btnConfirm.releasedEvent ||
      btnBack.pressedEvent || btnBack.releasedEvent ||
      btnUp.pressedEvent || btnDown.pressedEvent) {
    resetInactivity();
  }

  // Global combo: hold D5 + D6 >= 5s to prompt calibration (except while already calibrating)
  if (!calPrompt && mode != CALIBRATING && btnUp.stable && btnDown.stable) {
    unsigned long heldFor = now - min(btnUp.pressedAt, btnDown.pressedAt);
    if (heldFor > RECAL_HOLD_MS) {
      calPrompt = true;
      drawText("Calibrate?", "D5 OK D6 Back");
      clearEvents();
      return;
    }
  }

  // Handle calibration prompt
  if (calPrompt) {
    if (btnUp.pressedEvent) {
      calPrompt = false;
      enterCalibration(true);
    } else if (btnDown.pressedEvent) {
      calPrompt = false;
      // redraw current screen
      if (mode == UNIT_SELECT) showUnitScreen(now);
      else if (mode == AMOUNT_SELECT) showAmountScreen(now);
    }
    clearEvents();
    return;
  }

  // Mode logic
  switch (mode) {
    case CALIBRATING: {
      static bool filling = false;
      static unsigned long fillStart = 0;
      static unsigned long lastDisplay = 0;

      if (btnPush.pressedEvent && !filling) {
        setRelay(true);
        filling = true;
        fillStart = now;
        lastDisplay = 0;
        drawText("Filling...", "0 ms");
      }
      if (filling && (now - lastDisplay) > 100) {
        unsigned long elapsed = now - fillStart;
        char line2[16];
        snprintf(line2, sizeof(line2), "%lu ms", elapsed);
        drawText("Filling...", line2);
        lastDisplay = now;
      }
      if (filling && btnPush.releasedEvent) {
        setRelay(false);
        filling = false;
        unsigned long elapsed = now - fillStart;
        calTotalMs += elapsed;
        msPerCup = (float)calTotalMs;
        calMeasured = true;
        char line1[16];
        char line2[16];
        snprintf(line1, sizeof(line1), "Total %lums", calTotalMs);
        snprintf(line2, sizeof(line2), "Hold D5+D6 save");
        drawText(line1, line2);
      }
      if (!filling && calMeasured && btnPush.pressedEvent) {
        // Add more fill; handled by pressedEvent above
      }
      if (!filling && calMeasured && btnUp.stable && btnDown.stable) {
        unsigned long held = now - min(btnUp.pressedAt, btnDown.pressedAt);
        if (held > RECAL_HOLD_MS) {
          saveCalibration(calTotalMs);
          drawText("Cal Saved", "");
          delay(3000);
          enterUnitSelect();
          clearEvents();
          break;
        }
      }
      if (!filling && btnBack.pressedEvent) {
        if (hasCalibration) {
          enterUnitSelect();
        } else {
          enterCalibration(true);
        }
      }
      break;
    }

    case UNIT_SELECT: {
      if (btnUp.pressedEvent) {
        selectedUnit = (Unit)((selectedUnit + 1) % UNIT_COUNT);
        highlightUpUntil = now + 200;
        showUnitScreen(now);
      }
      if (btnDown.pressedEvent) {
        selectedUnit = (Unit)((selectedUnit + UNIT_COUNT - 1) % UNIT_COUNT);
        highlightDownUntil = now + 200;
        showUnitScreen(now);
      }
      if (btnPush.pressedEvent || btnConfirm.pressedEvent) {
        enterAmountSelect();
      }
      if (btnBack.pressedEvent) {
        enterCalibration(true);
      }
      break;
    }

    case AMOUNT_SELECT: {
      uint8_t step = (selectedUnit == OZ) ? 4 : 1; // whole oz steps, otherwise quarter
      static unsigned long lastRepeatUp = 0;
      static unsigned long lastRepeatDown = 0;

      auto show = [&]() { showAmountScreen(now); };
      auto bumpUp = [&]() {
        if (amountQuarter <= 4000 - step) {
          amountQuarter += step;
          show();
        }
      };
      auto bumpDown = [&]() {
        if (amountQuarter > step) {
          amountQuarter -= step;
          show();
        }
      };

      if (btnUp.pressedEvent) {
        bumpUp();
        highlightUpUntil = now + 200;
        lastRepeatUp = now;
      }
      if (btnDown.pressedEvent) {
        bumpDown();
        highlightDownUntil = now + 200;
        lastRepeatDown = now;
      }
      // Auto-repeat when holding >2s, every 250ms
      if (btnUp.stable && (now - btnUp.pressedAt > 2000) && (now - lastRepeatUp > 250)) {
        bumpUp();
        lastRepeatUp = now;
      }
      if (!btnUp.stable && btnUp.releasedEvent) {
        lastRepeatUp = 0;
      }
      if (btnDown.stable && (now - btnDown.pressedAt > 2000) && (now - lastRepeatDown > 250)) {
        bumpDown();
        lastRepeatDown = now;
      }
      if (!btnDown.stable && btnDown.releasedEvent) {
        lastRepeatDown = 0;
      }
      if (btnPush.pressedEvent) {
        startPour();
      }
      if (btnBack.pressedEvent) {
        enterUnitSelect();
      }
      break;
    }

    case POURING: {
      if (!pourPaused && btnPush.pressedEvent) {
        pourPushCount++;
        if (pourPushCount >= 3) {
          // Pause dispensing
          pourPaused = true;
          remainingPourMs = (pourEnd > now) ? (pourEnd - now) : 0;
          setRelay(false);
          drawText("Paused", "Up Cont Dn Cancel");
        }
      }
      if (pourPaused) {
        if (btnUp.pressedEvent) { // Up continue
          pourEnd = millis() + remainingPourMs;
          pourStartMs = millis() - (pourDurationMs - remainingPourMs);
          lastPourDraw = 0;
          pourPaused = false;
          pourPushCount = 0;
          setRelay(true);
          drawPourProgress((float)(pourDurationMs - remainingPourMs) / (float)pourDurationMs, now);
        } else if (btnDown.pressedEvent) { // Down cancel
          pourPaused = false;
          setRelay(false);
          enterUnitSelect();
        }
      } else {
        if ((now - lastPourDraw) > 100 && pourDurationMs > 0) {
          unsigned long remaining = (pourEnd > now) ? (pourEnd - now) : 0;
          unsigned long elapsed = (pourDurationMs > remaining) ? (pourDurationMs - remaining) : 0;
          float pct = (float)elapsed / (float)pourDurationMs;
          drawPourProgress(pct, now);
          lastPourDraw = now;
        }
        if (now >= pourEnd) {
          setRelay(false);
          drawStatus("Dispensed");
          delay(1500);
          enterUnitSelect();
        }
      }
      break;
    }

    case STANDBY:
      break;

    case SHUTDOWN:
      break;
  }

  clearEvents();
}

