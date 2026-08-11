"""
Read-only Connect Life diagnostic monitor.

Does NOT touch Firebase and does NOT send any command to the machine —
authenticates, polls get_appliances() on a timer, and logs what Connect
Life reports so you can correlate it against what the machine is
actually doing in person. Safe to run any time, including alongside the
real poller.py or with the ESP32 relay disconnected/dummy.

Reuses normalize_state()/pick_washer() from poller.py so the fields
match exactly what production would compute — nothing is reimplemented
or approximated here.

What it adds beyond poller.py's normal write:
  - appliance.seq  (a counter from the gateway) and appliance.offline_state,
    which the current poller never looks at.
  - a fingerprint of the raw statusList so you can see whether a given
    read is actually NEW data or Connect Life repeating the last thing
    it told us (the cache-fallback behavior in the connectlife library).
  - "secondsSinceChange" — how long the fingerprint has been unchanged.
  - a SUSPECT_STALE flag: running/paused reported true but nothing about
    the read has changed in a suspiciously long time.

Run:
    python monitor.py

Reads the same .env as poller.py (CONNECTLIFE_USERNAME/PASSWORD,
HISENSE_DEVICE_ID). Add MONITOR_INTERVAL_SECONDS to override the poll
interval independently of poller.py's own POLL_INTERVAL_SECONDS.

Output:
  - one concise line per poll to stdout, for watching live while you
    operate the machine by hand.
  - the same data appended as JSONL to monitor_log.jsonl, for later
    analysis (e.g. "how many minutes did seq sit still while
    running=true before it actually changed").
"""

import asyncio
import hashlib
import json
import os
import signal
import sys
import time

from dotenv import load_dotenv

try:
    from connectlife.api import ConnectLifeApi
except ImportError:
    print("Missing dependency: pip install -r requirements.txt", file=sys.stderr)
    raise

from poller import normalize_state, pick_washer

load_dotenv()

USERNAME = os.environ.get("CONNECTLIFE_USERNAME", "").strip()
PASSWORD = os.environ.get("CONNECTLIFE_PASSWORD", "").strip()
DEVICE_ID_FILTER = os.environ.get("HISENSE_DEVICE_ID", "").strip()
POLL_SECONDS = max(5, int(os.environ.get("MONITOR_INTERVAL_SECONDS", "10") or "10"))
STALE_SUSPECT_SECONDS = max(60, int(os.environ.get("MONITOR_STALE_SECONDS", "300") or "300"))
LOG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "monitor_log.jsonl")


def raw_fingerprint(raw: dict) -> str:
    """Stable hash of the raw statusList — changes only when Connect Life's
    payload for this appliance actually differs from the previous read."""
    try:
        blob = json.dumps(raw, sort_keys=True, default=str)
    except Exception:
        blob = str(raw)
    return hashlib.sha256(blob.encode()).hexdigest()[:12]


async def main() -> None:
    if not USERNAME or not PASSWORD:
        print("CONNECTLIFE_USERNAME and CONNECTLIFE_PASSWORD must be set in .env", file=sys.stderr)
        sys.exit(1)

    api = ConnectLifeApi(username=USERNAME, password=PASSWORD)
    print(f"Authenticating with Connect Life ({USERNAME})...")
    await api.authenticate()
    print(f"OK. Polling every {POLL_SECONDS}s (read-only, no Firebase, no commands).")
    print(f"Logging to {LOG_PATH}")
    print(f"SUSPECT_STALE fires when running/paused=true and nothing changes for >{STALE_SUSPECT_SECONDS}s\n")

    stop = asyncio.Event()

    def _sig(*_):
        print("\nShutting down")
        stop.set()

    for s in (signal.SIGINT, signal.SIGTERM):
        try:
            signal.signal(s, _sig)
        except Exception:
            pass

    last_fingerprint = None
    last_change_at = time.time()
    last_seq = None

    with open(LOG_PATH, "a", encoding="utf-8") as log_file:
        while not stop.is_set():
            row = {"ts": int(time.time() * 1000), "iso": time.strftime("%Y-%m-%d %H:%M:%S")}
            try:
                appliances = await api.get_appliances()
                washer = pick_washer(appliances)
                if washer is None:
                    row["error"] = "no appliances on account"
                    print(f"{row['iso']}  NO APPLIANCES")
                else:
                    state = normalize_state(washer)
                    fp = raw_fingerprint(state.get("raw", {}))
                    changed = fp != last_fingerprint
                    now = time.time()
                    if changed:
                        last_change_at = now
                        last_fingerprint = fp
                    seconds_since_change = int(now - last_change_at)

                    seq = getattr(washer, "seq", None)
                    offline_state = getattr(washer, "offline_state", None)
                    seq_changed = seq != last_seq
                    last_seq = seq

                    active = bool(state.get("running") or state.get("paused"))
                    suspect_stale = active and seconds_since_change > STALE_SUSPECT_SECONDS

                    row.update({
                        "running": state.get("running"),
                        "paused": state.get("paused"),
                        "ended": state.get("ended"),
                        "remainingMin": state.get("remainingMin"),
                        "totalMin": state.get("totalMin"),
                        "phase": state.get("phase"),
                        "phaseName": state.get("phaseName"),
                        "workStatusRaw": state.get("workStatusRaw"),
                        "doorLocked": state.get("doorLocked"),
                        "onlineAttrPresent": hasattr(washer, "online"),
                        "offlineState": offline_state,
                        "seq": seq,
                        "seqChanged": seq_changed,
                        "fingerprint": fp,
                        "fingerprintChanged": changed,
                        "secondsSinceChange": seconds_since_change,
                        "suspectStale": suspect_stale,
                    })

                    flag = " ⚠ SUSPECT_STALE" if suspect_stale else ""
                    print(
                        f"{row['iso']}  running={state.get('running')!s:<5} "
                        f"paused={state.get('paused')!s:<5} remaining={state.get('remainingMin')}m "
                        f"seq={seq}({'new' if seq_changed else 'same'}) "
                        f"offlineState={offline_state} "
                        f"unchanged={seconds_since_change}s{flag}"
                    )
            except Exception as e:
                row["error"] = str(e)
                print(f"{row['iso']}  POLL FAILED: {e}")

            log_file.write(json.dumps(row) + "\n")
            log_file.flush()

            try:
                await asyncio.wait_for(stop.wait(), timeout=POLL_SECONDS)
            except asyncio.TimeoutError:
                pass


if __name__ == "__main__":
    asyncio.run(main())
