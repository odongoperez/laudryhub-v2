# Hisense Connect Life → Firebase poller

Bridges the Hisense `WF3S8043BB3` (or any Connect Life washing machine) to
the LaundryHub app. Every ~10 seconds the script logs in to the Connect Life
cloud, reads the machine's current state, and writes a normalized snapshot
to Firebase Realtime Database at `/hisense`. The Next.js app subscribes to
that path.

**Why a separate service**: the Connect Life API uses OAuth + Gigya + RSA
request signing that only the community Python library (`connectlife`)
currently implements. We don't reimplement it — we run the proven library.

## What the app gets from it

- `running` / `paused` / `ended` — real machine state (not a timer).
- `remainingMin` — minutes left as reported by the machine.
- `programId`, `doorLocked`, `error` — for UI detail / troubleshooting.
- `online`, `updatedAt` — freshness.

## Setup

1. **Bind your machine to Connect Life** (if you haven't already) using the
   Connect Life mobile app. Confirm the washing cycle state shows up in that
   app — the poller reads whatever the Connect Life app can see.

2. **Create a Firebase service account**

   - Firebase Console → Project Settings → Service accounts →
     **Generate new private key**.
   - Save the downloaded JSON as `hisense-poller/service-account.json`.
   - This file is a secret — it's already covered by `.gitignore`.

3. **Install Python deps**

   ```
   cd hisense-poller
   python -m pip install -r requirements.txt
   ```

   Requires Python 3.10+.

4. **Create `.env`**

   ```
   cp .env.example .env
   ```

   Edit `.env` and fill in `CONNECTLIFE_USERNAME`, `CONNECTLIFE_PASSWORD`,
   and `FIREBASE_DATABASE_URL`. Leave `HISENSE_DEVICE_ID` blank if you only
   have one washing machine on the account.

5. **Run**

   ```
   python poller.py
   ```

   You should see `state: running=False ...` lines every 10 seconds. Start a
   wash on the machine — within ~10s `running=True` and `remainingMin=NN`.

## Keeping it running

For development, just leave the script open in a terminal.

### Deploy to Fly.io (100% free tier, recommended)

The repo already includes `Dockerfile` + `fly.toml` + `.dockerignore`.

1. Install flyctl: https://fly.io/docs/hands-on/install-flyctl/
2. From the `hisense-poller/` directory:

   ```
   flyctl auth login
   flyctl launch --no-deploy
   flyctl secrets set \
     CONNECTLIFE_USERNAME="you@example.com" \
     CONNECTLIFE_PASSWORD="yourpass" \
     FIREBASE_DATABASE_URL="https://laundryhub-XXXX.europe-west1.firebasedatabase.app" \
     FIREBASE_SERVICE_ACCOUNT_JSON="$(cat service-account.json)"
   flyctl deploy
   ```

3. Watch logs live: `flyctl logs`.

Secrets are encrypted at rest in Fly — `service-account.json` stays on
your machine, its contents live in Fly's secret store. The container
reads `FIREBASE_SERVICE_ACCOUNT_JSON` at boot (see `init_firebase()` in
`poller.py`). No file is mounted.

### Run on a Raspberry Pi / any Linux box

Sample `systemd` unit:

```ini
[Unit]
Description=Hisense Connect Life poller
After=network-online.target

[Service]
WorkingDirectory=/home/pi/laundryhub/hisense-poller
ExecStart=/usr/bin/python3 /home/pi/laundryhub/hisense-poller/poller.py
Restart=always
RestartSec=15
EnvironmentFile=/home/pi/laundryhub/hisense-poller/.env

[Install]
WantedBy=multi-user.target
```

## If the field names don't match your machine

Hisense uses different property keys across models. If `running` stays
`False` while your machine is clearly washing, inspect the raw payload:

```
python -m connectlife.dump --username EMAIL --password PASSWORD
```

Copy the property names your washer uses (e.g. `workMode`, `remainTime`)
and add them to the relevant `first(...)` call in `normalize_state()` in
`poller.py`. The `raw` field in Firebase already contains every raw
property — check it in the Firebase console while a cycle is running.

## Security notes

- `.env` and `service-account.json` stay on disk, never in git.
- The Python process has full write access to `/hisense`. Restrict other
  writers via Firebase rules — the app only reads this path.
