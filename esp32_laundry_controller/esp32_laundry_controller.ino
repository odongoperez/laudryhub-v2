/*
 * LaundryHub ESP32 v7.3 — Self-healing + relay debounce
 *
 *  Polls  /machine/running  every 1 second  (fast response)
 *  Reports /esp32_status   every 15 seconds (heartbeat)
 *
 *  SAFETY / SELF-HEAL:
 *    • Force reboot if WiFi stays disconnected > 5 min
 *    • Force reboot if no successful Firebase contact > 5 min
 *    • Auto reboot every 24h to prevent heap fragmentation
 *    • Relay OFF if wash runs longer than durationMs + 1 min
 *    • Brief WiFi/FB glitches leave the relay alone (wash continues)
 *
 *  v7.3 fixes (vs v7):
 *    • CRASH RECOVERY: if /machine/running is true on boot, close the
 *      relay IMMEDIATELY instead of waiting for the 3-tick debounce —
 *      minimizes power interruption after a crash/brownout mid-wash.
 *
 *  v7.2 fixes (vs v7):
 *    • Removed aggressive "5 fails = relay off" and the "3-min no FB =
 *      relay off" watchdog — both were cutting the relay mid-wash on
 *      weak WiFi (-78 dBm was enough to trigger them). On silent WiFi
 *      failure it's SAFER to leave the relay alone and let the wash
 *      continue. The 5-min reboot watchdog remains as the only
 *      emergency recovery path.
 *    • 3-tick debounce on /machine/running — single bad reads no
 *      longer click the relay.
 *    • Failed reads (empty body) leave the relay alone.
 *    • Boot-time command baseline retries 5x and is gated until
 *      verified — prevents accidentally firing the previous
 *      reboot/toggle command on every boot.
 *
 *  WIRING:
 *    ESP32 GPIO 2   →  Relay IN
 *    ESP32 GND      →  Relay GND
 *    ESP32 VIN (5V) →  Relay VCC
 *    Relay COM      →  Mains Live (from breaker/fuse)
 *    Relay NO       →  Washing Machine Live wire
 *    Mains Neutral  →  Washing Machine Neutral (unchanged)
 *
 *  ⚠ Disconnect mains before wiring. Use a junction box.
 */

#include <WiFi.h>
#include <HTTPClient.h>

#define WIFI_SSID      "Stechbahn 18 01"
#define WIFI_PASSWORD  "Stechbahn1801!"
#define FIREBASE_URL   "https://laundryhub-4e35b-default-rtdb.europe-west1.firebasedatabase.app"
#define RELAY_PIN       2
#define RELAY_ACTIVE_LOW false

// Self-heal thresholds (milliseconds)
const unsigned long WIFI_DEAD_REBOOT_MS    = 5UL * 60UL * 1000UL;   // 5 min
const unsigned long FB_DEAD_REBOOT_MS      = 5UL * 60UL * 1000UL;   // 5 min
const unsigned long DAILY_REBOOT_MS        = 24UL * 60UL * 60UL * 1000UL;  // 24 h

bool relayState = false;
unsigned long lastRead = 0;
unsigned long lastStatus = 0;
unsigned long lastCmdCheck = 0;
unsigned long lastSuccess = 0;          // last successful Firebase contact
unsigned long lastWifiOk = 0;           // last time we saw WiFi connected
unsigned long bootTime = 0;             // millis() at boot
unsigned long washStartedAt = 0;
String lastCmdTs = "0";                 // last seen /esp32_command/ts
bool cmdBaselineOk = false;             // true once we've established the baseline ts
int failCount = 0;

// Debounce: only flip the relay after we see the SAME state from Firebase
// this many ticks in a row. Prevents single-read glitches from flapping.
const int DEBOUNCE_TICKS = 3;
String pendingState = "";       // candidate new state (e.g. "true"/"false"/"null")
int pendingCount = 0;

void setRelay(bool on) {
  if (relayState == on) return;
  relayState = on;
  if (RELAY_ACTIVE_LOW) digitalWrite(RELAY_PIN, on ? LOW : HIGH);
  else digitalWrite(RELAY_PIN, on ? HIGH : LOW);
  Serial.printf("[RELAY] %s\n", on ? "=== ON ===" : "--- OFF ---");
}

String fbGet(String path) {
  HTTPClient http;
  http.begin(String(FIREBASE_URL) + path + ".json");
  http.setTimeout(6000);
  int code = http.GET();
  String r = "";
  if (code == 200) {
    r = http.getString();
    r.trim();
    failCount = 0;
    lastSuccess = millis();
  } else {
    failCount++;
    if (failCount <= 3) Serial.printf("[FB] GET %s -> %d\n", path.c_str(), code);
  }
  http.end();
  return r;
}

bool fbPut(String path, String json) {
  HTTPClient http;
  http.begin(String(FIREBASE_URL) + path + ".json");
  http.addHeader("Content-Type", "application/json");
  http.setTimeout(6000);
  int code = http.PUT(json);
  http.end();
  return code == 200;
}

void stopWash() {
  Serial.println("[SAFETY] Auto-stopping wash!");
  setRelay(false);
  washStartedAt = 0;
  fbPut("/machine", "{\"running\":false,\"stoppedBy\":\"esp32_safety\"}");
}

void connectWifi() {
  Serial.printf("[WIFI] Connecting to %s", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.persistent(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  int a = 0;
  while (WiFi.status() != WL_CONNECTED && a < 30) { Serial.print("."); delay(500); a++; }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\n[WIFI] OK IP:%s RSSI:%d\n", WiFi.localIP().toString().c_str(), WiFi.RSSI());
    lastWifiOk = millis();
    lastSuccess = millis();
  } else {
    Serial.println("\n[WIFI] FAIL");
  }
}

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("\n=== LaundryHub ESP32 v7.3 (self-heal) ===");

  bootTime = millis();
  pinMode(RELAY_PIN, OUTPUT);
  if (RELAY_ACTIVE_LOW) digitalWrite(RELAY_PIN, HIGH);
  else digitalWrite(RELAY_PIN, LOW);
  relayState = false;

  connectWifi();
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[BOOT] No WiFi after init — restarting in 5s");
    delay(5000);
    ESP.restart();
  }

  String t = fbGet("/machine/running");
  Serial.printf("[FB] running=%s\n", t.c_str());

  // CRASH RECOVERY: if /machine/running was TRUE at the moment we booted,
  // a wash was in progress when we crashed / browned-out / rebooted. Close
  // the relay IMMEDIATELY (no debounce wait) so the machine doesn't lose
  // power mid-cycle for any longer than the boot took.
  if (t == "true") {
    Serial.println("[BOOT] wash in progress — restoring relay ON immediately");
    setRelay(true);
    washStartedAt = millis();
    // Pre-seed the debounce so loop() doesn't fight this decision
    pendingState = "true";
    pendingCount = DEBOUNCE_TICKS;
  }

  // Capture current command timestamp so we don't act on stale commands.
  // Retry up to 5 times — if the very first fbGet failed, we'd otherwise
  // execute the previous command on next loop tick (e.g. accidentally toggle
  // the relay or reboot in a loop).
  for (int i = 0; i < 5; i++) {
    String cts = fbGet("/esp32_command/ts");
    if (cts.length() > 0) {
      // Empty node returns "null" — that's a valid baseline (= no command yet).
      lastCmdTs = cts;
      cmdBaselineOk = true;
      break;
    }
    delay(500);
  }
  Serial.printf("[CMD] baseline ts=%s ok=%d\n", lastCmdTs.c_str(), cmdBaselineOk);

  Serial.println("=== Listening (1s poll, 15s heartbeat, self-healing) ===");
}

void loop() {
  unsigned long now = millis();

  // ── Daily preventive reboot ─────────────────────────────────────────
  if (now - bootTime > DAILY_REBOOT_MS) {
    Serial.println("[REBOOT] Daily refresh — restarting now");
    setRelay(false);
    delay(500);
    ESP.restart();
  }

  // ── WiFi watchdog ───────────────────────────────────────────────────
  if (WiFi.status() == WL_CONNECTED) {
    lastWifiOk = now;
  } else {
    Serial.println("[WIFI] disconnected — attempting reconnect");
    WiFi.disconnect();
    delay(500);
    WiFi.reconnect();
    delay(1000);
    if (WiFi.status() != WL_CONNECTED) {
      // If we've been offline > WIFI_DEAD_REBOOT_MS, hard reboot
      if (now - lastWifiOk > WIFI_DEAD_REBOOT_MS) {
        Serial.println("[REBOOT] WiFi dead too long — restarting");
        setRelay(false);
        delay(500);
        ESP.restart();
      }
      return;
    }
  }

  // ── Firebase contact watchdog ───────────────────────────────────────
  if (lastSuccess != 0 && now - lastSuccess > FB_DEAD_REBOOT_MS) {
    Serial.println("[REBOOT] No Firebase contact 5 min — restarting");
    setRelay(false);
    delay(500);
    ESP.restart();
  }

  // ── Poll machine state every 1 second for fast response ─────────────
  if (now - lastRead > 1000) {
    lastRead = now;

    String running = fbGet("/machine/running");

    // Ignore empty / failed reads — don't touch the relay on a flaky read.
    // The 5-minute FB reboot watchdog at the top of loop() catches real outages.
    if (running.length() == 0) {
      // network glitch — leave relay alone
    } else if (running == "true" || running == "false" || running == "null") {
      // Debounce: require DEBOUNCE_TICKS consecutive identical reads before
      // flipping. Prevents Firebase blips from clicking the relay on/off.
      if (running == pendingState) {
        if (pendingCount < DEBOUNCE_TICKS) pendingCount++;
      } else {
        pendingState = running;
        pendingCount = 1;
      }

      // Only act if the candidate disagrees with current relay AND it has
      // been confirmed enough times.
      bool stable = pendingCount >= DEBOUNCE_TICKS;
      bool agreesWithRelay = (running == "true") ? relayState : !relayState;

      if (stable && !agreesWithRelay) {
        if (running == "true") {
          setRelay(true);
          if (washStartedAt == 0) {
            washStartedAt = now;
            Serial.println("[WASH] Started tracking");
          }
        } else {
          setRelay(false);
          washStartedAt = 0;
        }
      } else if (running == "true" && relayState) {
        // Already on, just refresh wash tracking start
        if (washStartedAt == 0) washStartedAt = now;
      }

      // Check duration every 10 seconds (not every poll to save requests)
      if (relayState) {
        static unsigned long lastDurCheck = 0;
        if (now - lastDurCheck > 10000) {
          lastDurCheck = now;
          String dur = fbGet("/machine/durationMs");
          if (dur.length() > 0 && dur != "null") {
            unsigned long dMs = strtoul(dur.c_str(), NULL, 10);
            unsigned long ran = now - washStartedAt;
            if (dMs > 0 && ran > dMs + 60000) {
              stopWash();
            }
          }
        }
      }
    }
    // NO aggressive "lost contact = cut relay" safety. Weak WiFi caused
    // this to misfire mid-wash. If FB is truly unreachable for 5 min, the
    // top-of-loop watchdog will REBOOT the ESP32 (which opens the relay in
    // the process). That's the only emergency cut we do.
    //
    // Philosophy: on a silent WiFi failure it's SAFER to leave the relay
    // alone and let the wash continue, than to cut power mid-cycle.
  }

  // ── Remote command listener (every 5s) ─────────────────────────────
  // Admin -> Firebase /esp32_command -> { type, ts }. We act on any new ts.
  if (now - lastCmdCheck > 5000) {
    lastCmdCheck = now;
    String ts = fbGet("/esp32_command/ts");
    // Establish baseline lazily if setup couldn't reach Firebase
    if (!cmdBaselineOk) {
      if (ts.length() > 0) {
        lastCmdTs = ts;
        cmdBaselineOk = true;
        Serial.printf("[CMD] late baseline ts=%s\n", lastCmdTs.c_str());
      }
      return;  // don't act this tick — we just learned the baseline
    }
    if (ts.length() > 0 && ts != "null" && ts != lastCmdTs) {
      String type = fbGet("/esp32_command/type");
      type.replace("\"", "");
      type.trim();
      Serial.printf("[CMD] %s (ts=%s)\n", type.c_str(), ts.c_str());
      lastCmdTs = ts;
      if (type == "reboot") {
        Serial.println("[CMD] reboot — restarting in 500ms");
        setRelay(false);
        delay(500);
        ESP.restart();
      } else if (type == "toggle_relay") {
        setRelay(!relayState);
      } else if (type == "off") {
        setRelay(false);
        washStartedAt = 0;
      } else if (type == "on") {
        setRelay(true);
      }
    }
  }

  // ── Heartbeat every 15 seconds ──────────────────────────────────────
  if (now - lastStatus > 15000) {
    lastStatus = now;
    HTTPClient http;
    http.begin(String(FIREBASE_URL) + "/esp32_status.json");
    http.addHeader("Content-Type", "application/json");
    http.setTimeout(6000);
    String j = "{\"online\":true,\"ip\":\"" + WiFi.localIP().toString() +
      "\",\"rssi\":" + String(WiFi.RSSI()) +
      ",\"relay\":" + String(relayState ? "true" : "false") +
      ",\"uptime\":" + String(now / 1000) +
      ",\"freeHeap\":" + String(ESP.getFreeHeap()) +
      ",\"lastSeen\":{\".sv\":\"timestamp\"}}";
    int code = http.sendRequest("PATCH", j);
    if (code == 200) {
      lastSuccess = now;
      Serial.printf("[OK] RSSI:%d Relay:%s Up:%lus Heap:%u\n",
        WiFi.RSSI(), relayState?"ON":"OFF", now/1000, ESP.getFreeHeap());
    } else {
      Serial.printf("[FB] heartbeat failed -> %d\n", code);
    }
    http.end();
  }

  delay(50);
}
