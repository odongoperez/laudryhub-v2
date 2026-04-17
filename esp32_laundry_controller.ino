/*
 * ═══════════════════════════════════════════════════════════════
 *  LaundryHub ESP32 Firmware
 *  Controls a relay switch for a washing machine via WiFi
 * ═══════════════════════════════════════════════════════════════
 *
 *  WIRING:
 *    ESP32 GPIO 26  →  Relay IN
 *    ESP32 GND      →  Relay GND
 *    ESP32 VIN (5V) →  Relay VCC
 *    Relay COM      →  Mains Live (from breaker/fuse)
 *    Relay NO       →  Washing Machine Live wire
 *    Mains Neutral  →  Washing Machine Neutral (unchanged)
 *
 *  ⚠ SAFETY WARNING:
 *    - Disconnect mains power before ANY wiring work
 *    - Use a relay module rated for your mains (230V/10A for EU, 120V/15A for US)
 *    - Enclose all mains wiring in a proper junction box
 *    - If unsure, hire an electrician
 *
 *  HOW IT WORKS:
 *    1. ESP32 connects to your WiFi network
 *    2. It runs a tiny HTTP server on port 80
 *    3. The web app sends GET requests to turn relay ON/OFF
 *    4. ESP32 toggles GPIO 26 which controls the relay
 *
 *  ENDPOINTS:
 *    GET /           → Status JSON { "relay": true/false, "uptime": seconds }
 *    GET /on         → Turn relay ON  (machine gets power)
 *    GET /off        → Turn relay OFF (machine loses power)
 *    GET /toggle     → Toggle relay state
 *    GET /status     → Same as /
 *
 *  SETUP:
 *    1. Install Arduino IDE or PlatformIO
 *    2. Add ESP32 board support (URL below)
 *    3. Change WIFI_SSID and WIFI_PASS below
 *    4. Upload to your ESP32
 *    5. Open Serial Monitor at 115200 baud to see the IP address
 *    6. Enter that IP in the LaundryHub Admin → ESP32 settings
 */

#include <WiFi.h>
#include <WebServer.h>
#include <ArduinoOTA.h>

// ─── CONFIGURATION ─── Change these! ───
const char* WIFI_SSID = "YOUR_WIFI_NAME";      // ← Your WiFi network name
const char* WIFI_PASS = "YOUR_WIFI_PASSWORD";   // ← Your WiFi password
const int   RELAY_PIN = 26;                     // GPIO pin connected to relay IN
const bool  RELAY_ACTIVE_LOW = true;            // Most relay modules are active-LOW
// ────────────────────────────────────────

WebServer server(80);
bool relayState = false;
unsigned long bootTime;

// ─── Helper: Set relay ───
void setRelay(bool on) {
  relayState = on;
  if (RELAY_ACTIVE_LOW) {
    digitalWrite(RELAY_PIN, on ? LOW : HIGH);
  } else {
    digitalWrite(RELAY_PIN, on ? HIGH : LOW);
  }
  Serial.printf("[RELAY] %s\n", on ? "ON" : "OFF");
}

// ─── Helper: JSON response with CORS ───
void sendJson(int code, String json) {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  server.sendHeader("Access-Control-Allow-Headers", "Content-Type");
  server.send(code, "application/json", json);
}

// ─── Helper: Status JSON ───
String statusJson() {
  unsigned long uptime = (millis() - bootTime) / 1000;
  String json = "{";
  json += "\"relay\":" + String(relayState ? "true" : "false") + ",";
  json += "\"uptime\":" + String(uptime) + ",";
  json += "\"ip\":\"" + WiFi.localIP().toString() + "\",";
  json += "\"rssi\":" + String(WiFi.RSSI()) + ",";
  json += "\"freeHeap\":" + String(ESP.getFreeHeap());
  json += "}";
  return json;
}

// ─── Route Handlers ───
void handleRoot()    { sendJson(200, statusJson()); }
void handleStatus()  { sendJson(200, statusJson()); }

void handleOn() {
  setRelay(true);
  sendJson(200, statusJson());
}

void handleOff() {
  setRelay(false);
  sendJson(200, statusJson());
}

void handleToggle() {
  setRelay(!relayState);
  sendJson(200, statusJson());
}

void handleOptions() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  server.sendHeader("Access-Control-Allow-Headers", "Content-Type");
  server.send(204);
}

void handleNotFound() {
  sendJson(404, "{\"error\":\"Not found\"}");
}

// ─── WiFi Connection with Retry ───
void connectWiFi() {
  Serial.printf("\n[WIFI] Connecting to %s", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);

  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 40) {
    delay(500);
    Serial.print(".");
    attempts++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\n[WIFI] Connected! IP: %s\n", WiFi.localIP().toString().c_str());
    Serial.printf("[WIFI] Signal strength: %d dBm\n", WiFi.RSSI());
  } else {
    Serial.println("\n[WIFI] FAILED to connect. Restarting in 10s...");
    delay(10000);
    ESP.restart();
  }
}

// ─── Setup ───
void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("\n╔══════════════════════════════════╗");
  Serial.println("║   LaundryHub ESP32 Controller    ║");
  Serial.println("╚══════════════════════════════════╝");

  bootTime = millis();

  // Initialize relay pin
  pinMode(RELAY_PIN, OUTPUT);
  setRelay(false); // Start with machine OFF

  // Connect to WiFi
  connectWiFi();

  // Setup OTA updates (so you can update wirelessly later)
  ArduinoOTA.setHostname("laundryhub-esp32");
  ArduinoOTA.begin();

  // Setup HTTP routes
  server.on("/",        HTTP_GET,     handleRoot);
  server.on("/status",  HTTP_GET,     handleStatus);
  server.on("/on",      HTTP_GET,     handleOn);
  server.on("/off",     HTTP_GET,     handleOff);
  server.on("/toggle",  HTTP_GET,     handleToggle);

  // CORS preflight
  server.on("/",        HTTP_OPTIONS, handleOptions);
  server.on("/on",      HTTP_OPTIONS, handleOptions);
  server.on("/off",     HTTP_OPTIONS, handleOptions);
  server.on("/toggle",  HTTP_OPTIONS, handleOptions);
  server.on("/status",  HTTP_OPTIONS, handleOptions);

  server.onNotFound(handleNotFound);
  server.begin();

  Serial.println("[HTTP] Server started on port 80");
  Serial.println("──────────────────────────────────");
  Serial.printf("  Open: http://%s\n", WiFi.localIP().toString().c_str());
  Serial.println("  GET /on     → Turn ON");
  Serial.println("  GET /off    → Turn OFF");
  Serial.println("  GET /toggle → Toggle");
  Serial.println("  GET /status → JSON status");
  Serial.println("──────────────────────────────────");
}

// ─── Main Loop ───
void loop() {
  server.handleClient();
  ArduinoOTA.handle();

  // Reconnect WiFi if disconnected
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[WIFI] Lost connection, reconnecting...");
    connectWiFi();
  }

  delay(2); // Small delay to prevent watchdog issues
}
