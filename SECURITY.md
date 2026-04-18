# Going public — security checklist

Follow these steps **before** deploying the app to a public URL. Without them
anyone on the internet can read your Firebase database if they find the URL.

## 1. Enable Anonymous sign-in

Firebase Console → **Authentication** → **Sign-in method** → **Anonymous**
→ Enable → Save.

The app ([app/firebase.js](app/firebase.js)) now signs every visitor in
anonymously so rules can gate on `auth != null`. Without this step the app
will log `Firebase anonymous auth failed` in the console and database reads
will fail.

## 2. Publish the locked-down rules

Firebase Console → **Realtime Database** → **Rules** tab. Paste the
contents of [firebase-rules.json](firebase-rules.json), click **Publish**.

What changes:

| Path | Read | Write | Why |
|---|---|---|---|
| `/users` | auth | auth | stores PINs |
| `/config` | auth | auth | stores admin password + theme |
| `/schedule` | auth | auth | reservations (privacy) |
| `/history` | auth | auth | wash history (privacy) |
| `/chat` | auth | auth | messages |
| `/machine` | public | public | read by ESP32 firmware, which has no Firebase Auth |
| `/esp32_status` | public | public | ESP32 writes heartbeat |
| `/esp32_command` | public | **auth** | ESP32 reads, only authenticated app may send commands |
| `/hisense` | auth | **denied** | only the Python poller (service account) writes here |
| `/notifications` | auth | **denied** | same |
| anything else | **denied** | **denied** | default closed |

## 3. Secrets — never commit these

- `hisense-poller/.env` (already in `.gitignore`)
- `hisense-poller/service-account.json` (already in `.gitignore`)
- Firebase project config values in `.env.local` when deploying to Vercel

For Vercel deploys, put them in **Project Settings → Environment Variables**
(`NEXT_PUBLIC_FB_*`). For the Python poller host (Fly.io / Oracle / Pi),
pass them as environment variables, never bake them into the image.

## 4. Known caveats

The app predates proper auth — PINs and the admin password sit as plaintext
under `/users/*/pin` and `/config/adminPassword`. With the new rules, only
anonymously-authenticated users can read these, but **any** anonymous user
can still sign up and fetch them. To close this fully you would need to:

1. Store only salted hashes of PINs/passwords.
2. Verify them server-side via Firebase Cloud Functions (a tiny HTTPS
   endpoint that returns `{ok: true/false}` and never the hash).
3. The client never reads the hash directly.

That's a non-trivial refactor. The anonymous-auth gate is the 80/20 win for
now — it closes the door against drive-by scrapers who find your database
URL and try the REST API without credentials.

## 5. Also check

- **Do not publicly share your Firebase database URL** or the value in
  `NEXT_PUBLIC_FB_DB_URL`. It's technically embedded in the browser bundle,
  but don't shout it from the rooftops.
- If someone leaves the household, remove their user record; their PIN
  stops working immediately once the record is gone.
- Rotate the admin password (Settings → Admin password) whenever a trusted
  admin leaves.
- When you retire the ESP32 device, delete `/esp32_status` and
  `/esp32_command` so stale values don't linger.
