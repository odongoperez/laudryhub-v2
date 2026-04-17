# 🫧 LaundryHub — Setup & Deploy Guide

A shared washing machine control system with Firebase Realtime DB + Vercel + ESP32.

**What it does:** 5 housemates share one washing machine. The web app lets anyone start/schedule washes, see who's using it, and get alerts. An ESP32 + relay physically controls the machine's power.

---

## Architecture

```
┌──────────────┐     ┌──────────────────┐     ┌──────────────┐
│  Phones /    │────►│  Vercel          │────►│  Firebase    │
│  Browsers    │     │  (Next.js app)   │     │  Realtime DB │
└──────────────┘     └──────────────────┘     └──────────────┘
       │                                             │
       │         ┌──────────────────┐                │
       └────────►│  ESP32 + Relay   │◄── reads state │
                 │  (local WiFi)    │                │
                 └───────┬──────────┘
                         │
                 ┌───────▼──────────┐
                 │ Washing Machine  │
                 └──────────────────┘
```

---

## Step 1: Create Firebase Project (5 minutes)

1. Go to [console.firebase.google.com](https://console.firebase.google.com)
2. Click **"Create a project"**
3. Name it `laundryhub` → Continue
4. Disable Google Analytics (not needed) → Create Project

### Enable Realtime Database:
5. In the left sidebar, click **Build → Realtime Database**
6. Click **"Create Database"**
7. Choose location: **Europe (eu-central1)** ← closest to you in Germany
8. Start in **Test mode** (we'll secure it later)
9. Click **Enable**

### Get your config:
10. Click the **gear icon ⚙️** → **Project settings**
11. Scroll down to "Your apps" → Click the **web icon** `</>`
12. Register app name: `laundryhub-web`
13. **Copy the firebaseConfig object** — you need these values:

```
apiKey: "AIza..."
authDomain: "laundryhub-xxxxx.firebaseapp.com"
databaseURL: "https://laundryhub-xxxxx-default-rtdb.europe-west1.firebasedatabase.app"
projectId: "laundryhub-xxxxx"
storageBucket: "laundryhub-xxxxx.appspot.com"
messagingSenderId: "1234567890"
appId: "1:1234567890:web:abcdef..."
```

### Set security rules:
14. Go to **Realtime Database → Rules tab**
15. Paste these rules:

```json
{
  "rules": {
    "users": { ".read": true, ".write": true },
    "machine": { ".read": true, ".write": true },
    "schedule": { ".read": true, ".write": true },
    "config": { ".read": true, ".write": true }
  }
}
```

16. Click **Publish**

> These rules allow open read/write — fine for a small household app on a private URL. For more security, you can add Firebase Auth later.

---

## Step 2: Deploy to Vercel (5 minutes)

### Push to GitHub first:

```bash
cd laundryhub
git init
git add .
git commit -m "LaundryHub initial commit"
```

Create a repo on GitHub called `laundryhub`, then:

```bash
git remote add origin https://github.com/YOUR_USERNAME/laundryhub.git
git branch -M main
git push -u origin main
```

### Connect to Vercel:

1. Go to [vercel.com](https://vercel.com) → Sign in with GitHub
2. Click **"Add New Project"**
3. Import your `laundryhub` repo
4. **Before deploying**, click **"Environment Variables"**
5. Add each variable from your Firebase config:

| Key | Value |
|-----|-------|
| `NEXT_PUBLIC_FB_API_KEY` | Your apiKey |
| `NEXT_PUBLIC_FB_AUTH_DOMAIN` | Your authDomain |
| `NEXT_PUBLIC_FB_DB_URL` | Your databaseURL |
| `NEXT_PUBLIC_FB_PROJECT_ID` | Your projectId |
| `NEXT_PUBLIC_FB_STORAGE` | Your storageBucket |
| `NEXT_PUBLIC_FB_SENDER_ID` | Your messagingSenderId |
| `NEXT_PUBLIC_FB_APP_ID` | Your appId |

6. Click **Deploy**
7. Wait ~60 seconds → Your app is live at `laundryhub.vercel.app` 🎉

---

## Step 3: First-Time Setup

1. Open your Vercel URL on your phone
2. Login as **Admin** (password: `1234`)
3. Go to **Users** tab → Add your 5 housemates (name + 4-digit PIN each)
4. Go to **ESP32** tab → Enter your ESP32's IP address
5. Go to **UI Config** → Customize colors and app name if you want
6. **Share the URL** with your housemates — they login with their name + PIN

---

## Step 4: ESP32 Hardware Setup

### What you need (~€19):
- ESP32 dev board (ESP32-WROOM-32)
- 5V Relay module (230V/10A rated for EU)
- 3 jumper wires
- USB power adapter
- Junction box for safety

### Wiring:

```
ESP32 GPIO 26  ──►  Relay IN
ESP32 GND      ──►  Relay GND
ESP32 VIN (5V) ──►  Relay VCC
Relay COM      ──►  Mains Live (from wall/breaker)
Relay NO       ──►  Washing Machine Live wire
Neutral wire   ──►  passes through unchanged
```

⚠️ **DISCONNECT MAINS BEFORE WIRING. If unsure, ask an electrician.**

### Flash the ESP32:

1. Install [Arduino IDE](https://www.arduino.cc/en/software)
2. Add ESP32 support: File → Preferences → Additional Board URLs:
   ```
   https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json
   ```
3. Tools → Board → Boards Manager → search "ESP32" → Install
4. Open `esp32_laundry_controller.ino`
5. Edit lines 42-43 with your WiFi name/password
6. Select board: "ESP32 Dev Module"
7. Upload → Open Serial Monitor (115200 baud)
8. Note the IP address shown → enter it in Admin panel

### Test:
- Browse to `http://[ESP32_IP]/on` — relay clicks ON
- Browse to `http://[ESP32_IP]/off` — relay clicks OFF

---

## How Users Use It

1. **Open the URL** on your phone (bookmark it / add to home screen)
2. **Login** with your name + PIN
3. **Start a wash**: Pick cycle → tap Start
4. **Schedule a wash**: Pick date/time/cycle → tap Schedule
5. **When someone else is washing**: You see their name, cycle, and time remaining
6. **Alerts**: Browser notification ~5 min before your wash finishes
7. **Upcoming washes**: See everyone's scheduled slots — avoid conflicts

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| "Connecting..." forever | Check Firebase config values in Vercel env vars |
| Users not saving | Verify Firebase Realtime DB is in test mode |
| Can't login after creating account | Make sure PIN is exactly what admin set |
| ESP32 won't connect | Double-check WiFi SSID/password, move closer to router |
| Relay doesn't click | Check wiring, try different GPIO pin |
| No browser notifications | Allow notifications when prompted, or check browser settings |

---

## Project Structure

```
laundryhub/
├── app/
│   ├── firebase.js     ← Firebase config + database API
│   ├── globals.css     ← Base styles
│   ├── layout.js       ← HTML layout + fonts
│   └── page.js         ← Full app (login, user dash, admin panel)
├── public/
├── .env.local.example  ← Template for env vars
├── .gitignore
├── firebase-rules.json ← Security rules to paste in Firebase console
├── next.config.js
├── package.json
└── README.md
```

---

## Data in Firebase

The Realtime DB stores 4 nodes:

```
laundryhub-db/
├── users/          ← { id, name, pin, created }
├── machine/        ← { running, userId, userName, cycleName, startTime, durationMs }
├── schedule/       ← { id, userId, userName, cycleName, minutes, dateTime }
└── config/         ← { primaryColor, accentColor, appName, esp32Ip, ... }
```

All data syncs in realtime — when one person starts a wash, everyone sees it instantly.
