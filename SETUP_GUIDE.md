# LaundryHub — Complete Setup Guide

## System Overview

LaundryHub is a shared washing machine control system with two parts:

1. **Web App** (the `.jsx` file) — runs in your browser, manages users, scheduling, and machine control
2. **ESP32 Firmware** (the `.ino` file) — runs on an ESP32 microcontroller, physically switches the relay

The web app sends HTTP requests to the ESP32 over your local WiFi to turn the relay ON/OFF.

---

## What You Need

### Hardware
| Item | Purpose | Approx. Cost |
|------|---------|-------------|
| ESP32 dev board (e.g. ESP32-WROOM-32) | WiFi controller | ~€5 |
| 5V Relay module (rated 230V/10A for EU) | Switches mains power | ~€3 |
| Jumper wires (3x male-to-female) | Connect ESP32 to relay | ~€1 |
| USB cable (Micro-USB or USB-C) | Power the ESP32 | ~€2 |
| USB power adapter (5V/1A+) | Permanent power for ESP32 | ~€3 |
| Junction box / enclosure | Safety housing for mains wiring | ~€5 |

**Total: ~€19**

### Software
- Arduino IDE (free) — [arduino.cc/en/software](https://www.arduino.cc/en/software)
- ESP32 board support for Arduino

---

## Step 1: Wire the Hardware

```
                    ┌──────────────────┐
   ESP32            │   RELAY MODULE   │      MAINS
  ┌──────┐          │                  │    ┌────────────┐
  │ GPIO 26 ───────►│ IN          COM ─┼───►│ Live (from │
  │       │          │                  │    │  breaker)  │
  │  GND  ──────────►│ GND         NO ──┼───►│ To washing │
  │       │          │                  │    │  machine   │
  │  VIN  ──────────►│ VCC             │    └────────────┘
  └──────┘          └──────────────────┘
```

### Connection Table
| ESP32 Pin | Relay Pin | Notes |
|-----------|-----------|-------|
| GPIO 26 | IN | Signal wire (controls relay) |
| GND | GND | Common ground |
| VIN (5V) | VCC | Powers the relay module |

### Mains Wiring (⚠ CAREFUL!)
| Relay Terminal | Connection |
|---------------|------------|
| COM (Common) | Mains Live wire FROM your breaker/wall |
| NO (Normally Open) | Live wire TO washing machine |
| Neutral | Passes through unchanged (not through relay) |

> **⚠ CRITICAL SAFETY:**
> - TURN OFF the breaker before touching any mains wiring
> - Use a relay rated for your voltage (230V for Germany/EU)
> - Enclose all mains connections in a proper junction box
> - If you're not comfortable with mains wiring, get an electrician — it's a 15-minute job for them

---

## Step 2: Flash the ESP32

1. **Install Arduino IDE** from arduino.cc

2. **Add ESP32 Board Support:**
   - Open Arduino IDE → File → Preferences
   - In "Additional Board Manager URLs" add:
     ```
     https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json
     ```
   - Go to Tools → Board → Boards Manager → Search "ESP32" → Install

3. **Open the firmware file** (`esp32_laundry_controller.ino`)

4. **Edit WiFi credentials** (lines 42-43):
   ```cpp
   const char* WIFI_SSID = "YOUR_WIFI_NAME";
   const char* WIFI_PASS = "YOUR_WIFI_PASSWORD";
   ```

5. **Select your board:**
   - Tools → Board → ESP32 Arduino → "ESP32 Dev Module"
   - Tools → Port → Select the COM port your ESP32 is on

6. **Upload** — Click the arrow button (→)

7. **Open Serial Monitor** (115200 baud) — you'll see:
   ```
   ╔══════════════════════════════════╗
   ║   LaundryHub ESP32 Controller    ║
   ╚══════════════════════════════════╝
   [WIFI] Connected! IP: 192.168.1.xxx
   [HTTP] Server started on port 80
   ```

8. **Note the IP address** — you'll enter this in the web app

9. **Test it:** Open a browser and go to `http://192.168.1.xxx/on` — you should hear the relay click!

---

## Step 3: Set Up the Web App

The web app (laundry-hub.jsx) is a React app that runs right in Claude Artifacts. Here's how to use it:

### First-Time Admin Setup

1. **Open the app** — it shows a login screen
2. **Switch to "Admin"** tab
3. **Enter password:** `1234`
4. **Go to "Users" tab** — add your 5 housemates:
   - Enter each person's name and a 4-digit PIN
   - Click "+ Add"
5. **Go to "ESP32" tab:**
   - Enter the IP address from Step 2
   - Click "Test Connection" to verify
   - Click "Save IP"
6. **Go to "UI Config" tab** (optional):
   - Change app name, colors, alert timing
   - Click "Save Configuration"

### How Users Use It

1. Open the app → log in with name + PIN
2. **To wash:** Select a cycle → click "Start"
3. **To schedule:** Pick date/time/cycle → click "Schedule Wash"
4. **Alerts:** You'll get a notification ~5 min before your wash ends
5. **Visibility:** Everyone can see who's washing and upcoming schedules

---

## Step 4: Deploy Online (Recommended)

For everyone to access the app from their phone, you have a few options:

### Option A: Keep Using Claude Artifact (Simplest)
The app already works as a Claude artifact with persistent storage. Share the conversation link with your housemates. Everyone opens it on their phone.

### Option B: Deploy to Vercel (Best for a proper URL)
1. Create a Next.js project and paste the React code
2. Push to GitHub
3. Deploy on Vercel (free tier)
4. Everyone accesses via `your-app.vercel.app`

> **Note on ESP32 access:** The ESP32 runs on your local WiFi. The web app can only reach it when you're on the same WiFi network. For remote access, you'd need to set up port forwarding on your router or use a service like ngrok.

---

## How It All Fits Together

```
   Phone/Laptop                  Your WiFi Router              ESP32 + Relay
  ┌───────────┐                 ┌──────────────┐              ┌──────────┐
  │           │   WiFi          │              │   WiFi       │          │
  │  Web App  │ ──────────────► │    Router    │ ───────────► │  HTTP    │
  │ (browser) │  HTTP request   │ 192.168.1.1  │              │  Server  │
  │           │  /on or /off    │              │              │          │
  └───────────┘                 └──────────────┘              │  GPIO 26 │
                                                              │    │     │
                                                              │  RELAY   │
                                                              │    │     │
                                                              │ MACHINE  │
                                                              └──────────┘
```

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| ESP32 won't connect to WiFi | Double-check SSID/password. Move closer to router. |
| Relay doesn't click | Check wiring. Try GPIO 25 instead of 26. Verify 5V on VIN. |
| Web app can't reach ESP32 | Ensure phone/laptop is on same WiFi. Check IP address. |
| Machine doesn't turn on | Verify mains wiring. Check relay NO terminal (not NC). |
| Serial monitor shows garbage | Set baud rate to 115200. |

---

## Feature Summary

### User Features
- Start/stop wash cycles (Quick, Normal, Heavy, Delicates, Bedding)
- Schedule future washes so others know your slot
- See who's currently washing and time remaining
- Get alerts when wash is almost done
- View all upcoming scheduled washes

### Admin Features
- Add/remove up to 5 users with name + PIN
- Force-stop the machine remotely
- Configure ESP32 IP address
- Customize app colors, name, and alert timing
- Clear all schedules
- View machine status and connection info
