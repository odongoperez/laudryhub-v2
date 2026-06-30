"""
Hisense Connect Life -> Firebase poller.

Logs in to the Connect Life cloud using the oyvindwe/connectlife Python
library, polls the washing machine's properties every N seconds, and writes
a normalized snapshot to Firebase Realtime Database at /hisense.

The Next.js LaundryHub app subscribes to /hisense and uses it to:
  - show the actual remaining time from the machine,
  - detect real start / pause / end,
  - cut the ESP32 relay 5 minutes after a wash ends,
  - cut the relay if the machine sits idle for 5 minutes after relay ON.

Run:
    python poller.py

Environment variables are read from .env (see .env.example).
"""

import asyncio
import logging
import os
import signal
import sys
import time
from typing import Any

from dotenv import load_dotenv

try:
    from connectlife.api import ConnectLifeApi
except ImportError:
    print("Missing dependency: pip install -r requirements.txt", file=sys.stderr)
    raise

import firebase_admin
from firebase_admin import credentials, db


load_dotenv()

USERNAME = os.environ.get("CONNECTLIFE_USERNAME", "").strip()
PASSWORD = os.environ.get("CONNECTLIFE_PASSWORD", "").strip()
FIREBASE_URL = os.environ.get("FIREBASE_DATABASE_URL", "").strip()
SERVICE_ACCOUNT = os.environ.get("FIREBASE_SERVICE_ACCOUNT", "./service-account.json").strip()
DEVICE_ID_FILTER = os.environ.get("HISENSE_DEVICE_ID", "").strip()
POLL_SECONDS = max(8, int(os.environ.get("POLL_INTERVAL_SECONDS", "10") or "10"))
GRACE_SECONDS = max(0, int(os.environ.get("GRACE_MINUTES", "5") or "5")) * 60
IDLE_SECONDS = max(0, int(os.environ.get("IDLE_CUTOFF_MINUTES", "5") or "5")) * 60
# POLLER_ID identifies this instance ("fly" on Fly.io, "pc" when running locally).
# Both instances can run simultaneously — they coordinate via /config/activePoller
# in Firebase. Only the one whose ID matches activePoller writes data; the other
# stays in standby (still authenticates + polls so it's ready to take over).
POLLER_ID = (os.environ.get("POLLER_ID") or "fly").strip().lower()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("hisense-poller")


def init_firebase() -> Any:
    if not FIREBASE_URL:
        raise RuntimeError("FIREBASE_DATABASE_URL is not set")

    # Credential resolution order for portability across shells and hosts:
    #   1) FIREBASE_SERVICE_ACCOUNT_B64  — base64-encoded JSON (safest for
    #      Windows PowerShell / Fly secrets, no quote escaping issues).
    #   2) FIREBASE_SERVICE_ACCOUNT_JSON — inline JSON string.
    #   3) Local file at SERVICE_ACCOUNT (default: ./service-account.json)
    #      for dev.
    import json, base64
    sa_b64 = os.environ.get("FIREBASE_SERVICE_ACCOUNT_B64", "").strip()
    sa_json = os.environ.get("FIREBASE_SERVICE_ACCOUNT_JSON", "").strip()
    info = None
    if sa_b64:
        try:
            info = json.loads(base64.b64decode(sa_b64).decode("utf-8"))
        except Exception as e:
            raise RuntimeError(f"FIREBASE_SERVICE_ACCOUNT_B64 could not be decoded: {e}")
    elif sa_json:
        try:
            info = json.loads(sa_json)
        except json.JSONDecodeError as e:
            raise RuntimeError(f"FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON: {e}")

    if info is not None:
        cred = credentials.Certificate(info)
    elif os.path.exists(SERVICE_ACCOUNT):
        cred = credentials.Certificate(SERVICE_ACCOUNT)
    else:
        raise RuntimeError(
            f"Firebase service account not found. Set FIREBASE_SERVICE_ACCOUNT_B64 "
            f"(recommended for Fly/Windows), FIREBASE_SERVICE_ACCOUNT_JSON, OR "
            f"put the JSON at {SERVICE_ACCOUNT} (dev)."
        )
    firebase_admin.initialize_app(cred, {"databaseURL": FIREBASE_URL})
    return {
        "hisense": db.reference("hisense"),
        "machine": db.reference("machine"),
        "notifications": db.reference("notifications"),
        "history": db.reference("history"),
        "config": db.reference("config"),
    }


def get_grace_seconds(refs: dict) -> int:
    """Read the admin-configured grace period (in min) from /config/gracePoweroffMin
    on every call. Falls back to the env-var default if config is missing.
    Cached for 30s to avoid excessive reads."""
    global _GRACE_CACHE, _GRACE_CACHE_AT
    now = time.time()
    if now - _GRACE_CACHE_AT < 30:
        return _GRACE_CACHE
    try:
        v = refs["config"].child("gracePoweroffMin").get()
        if v is not None and int(v) > 0:
            _GRACE_CACHE = int(v) * 60
        else:
            _GRACE_CACHE = GRACE_SECONDS
    except Exception:
        _GRACE_CACHE = GRACE_SECONDS
    _GRACE_CACHE_AT = now
    return _GRACE_CACHE


_GRACE_CACHE = 300  # 5 min default
_GRACE_CACHE_AT = 0.0


def cut_relay(refs: dict, reason: str, note: str) -> None:
    """Set /machine.running=false and log a notification the app will toast."""
    try:
        machine = refs["machine"].get() or {}
        if machine.get("running"):
            machine["running"] = False
            machine["stoppedBy"] = reason
            machine["finishedAt"] = int(time.time() * 1000)
            refs["machine"].set(machine)
            log.info("relay CUT (%s): %s", reason, note)
        refs["notifications"].push({
            "type": reason,
            "text": note,
            "ts": int(time.time() * 1000),
        })
    except Exception as e:
        log.warning("cut_relay failed: %s", e)


def apply_control_logic(refs: dict, state: dict, memo: dict) -> None:
    """Decide whether to let the relay stay on based on real machine state.

    memo is a dict persisted across poll ticks:
      last_running_at: timestamp when machine last reported running
      last_ended_at:   timestamp of ended->observed transition
      grace_until:     timestamp when we plan to cut the relay (post-wash)
      last_relay_on:   timestamp we first saw mac.running=true this session
    """
    now = int(time.time() * 1000)
    try:
        machine = refs["machine"].get() or {}
    except Exception:
        return

    relay_on = bool(machine.get("running"))
    running = bool(state.get("running"))
    paused = bool(state.get("paused"))
    ended = bool(state.get("ended"))

    # Check if admin has muted Hisense mirroring (because Connect Life was stuck
    # reporting a ghost wash). While muted, we skip mirror logic so the cleared
    # /machine state stays clean.
    mute_until = 0
    try:
        existing_hs = refs["hisense"].get() or {}
        mute_until = int(existing_hs.get("muteUntil") or 0)
    except Exception:
        pass
    muted = mute_until > now

    # Mirror Hisense -> /machine when the machine is actually active but the
    # relay flag is off (e.g. user pressed Start on the panel without going
    # through the app). The ESP32 then keeps the relay closed throughout the
    # wash automatically. Skipped while admin-muted.
    if (running or paused) and not relay_on and not muted:
        try:
            info = dict(machine) if machine else {}
            info["running"] = True
            info["userId"] = info.get("userId") or "machine"
            info["userName"] = info.get("userName") or "Machine"
            info["cycleName"] = info.get("cycleName") or f"Program {state.get('programId', '?')}"
            info["startTime"] = info.get("startTime") or now
            total_ms = int(state.get("totalMin", 60)) * 60000
            info["durationMs"] = info.get("durationMs") or total_ms
            refs["machine"].set(info)
            machine = info
            relay_on = True
            log.info("mirrored Hisense->machine: wash detected, relay stays on")
        except Exception as e:
            log.warning("failed to mirror running state: %s", e)
    elif muted and (running or paused) and not relay_on:
        log.info(
            "skipping mirror — Hisense mirroring muted by admin (%ds left)",
            int((mute_until - now) / 1000),
        )

    # Track relay-on start
    if relay_on and not memo.get("last_relay_on"):
        memo["last_relay_on"] = now
    if not relay_on:
        memo["last_relay_on"] = 0
        memo["grace_until"] = 0
        memo["last_ended_at"] = 0
        memo["last_running_at"] = 0
        memo["was_active"] = False

    # Track last-running timestamp (resets idle timer). Pause also counts as
    # "active" so we don't cut the relay mid-cycle while user has it paused.
    if running or paused:
        memo["last_running_at"] = now
        memo["was_active"] = True

    was_active = bool(memo.get("was_active"))

    # Remember peak consumption during the wash (Hisense keeps incrementing
    # these; once the machine powers off they reset to 0, so we snapshot).
    if running or paused:
        if state.get("waterLiters"):
            memo["peak_water"] = max(memo.get("peak_water", 0), state["waterLiters"])
        if state.get("energyKwh"):
            memo["peak_energy"] = max(memo.get("peak_energy", 0), state["energyKwh"])
        if state.get("programId") is not None:
            memo["last_program"] = state["programId"]
        if state.get("totalMin"):
            memo["last_total_min"] = state["totalMin"]

    # Start grace period when wash truly ends. Two signals qualify:
    #   - ended flag from Hisense, OR
    #   - we *were* active (running or paused), now neither and not ended-yet
    #     (machine went back to idle/off). Pure pause does NOT trigger this.
    # Read admin-configured grace period (falls back to env default if unset).
    grace_seconds = get_grace_seconds(refs)

    if grace_seconds > 0 and not memo.get("grace_until"):
        if (ended or (was_active and not running and not paused)) and not memo.get("history_logged"):
            # Write a history record with final consumption snapshot.
            machine_info = machine or {}
            try:
                hid = str(int(time.time() * 1000))
                rec = {
                    "id": hid,
                    "userId": machine_info.get("userId") or "machine",
                    "userName": machine_info.get("userName") or "Machine",
                    "cycleName": machine_info.get("cycleName") or f"Program {memo.get('last_program','?')}",
                    "startTime": machine_info.get("startTime") or (now - (memo.get("last_total_min", 0) * 60000)),
                    "finishedAt": now,
                    "durationMs": (memo.get("last_total_min", 0) * 60000) or 0,
                    "waterLiters": memo.get("peak_water", 0),
                    "energyKwh": memo.get("peak_energy", 0),
                    "programId": memo.get("last_program"),
                    "source": "hisense",
                }
                refs["history"].child(hid).set(rec)
                log.info("history recorded: %.1fL %.3fkWh", rec["waterLiters"], rec["energyKwh"])
                memo["history_logged"] = True
                memo["last_end_summary"] = rec
            except Exception as e:
                log.warning("failed to write history: %s", e)
        if relay_on and (ended or (was_active and not running and not paused)):
            memo["grace_until"] = now + grace_seconds * 1000
            log.info("grace period started (%ds)", grace_seconds)

    # If the cycle restarts (running again), cancel any pending grace.
    if running and memo.get("grace_until"):
        memo["grace_until"] = 0
        log.info("grace period cancelled — machine running again")

    # Apply grace cut
    if memo.get("grace_until") and now >= memo["grace_until"]:
        cut_relay(refs, "post_wash_grace",
                  f"Cut relay {grace_seconds // 60}m after wash ended")
        memo["grace_until"] = 0
        memo["was_active"] = False
        memo["peak_water"] = 0
        memo["peak_energy"] = 0
        memo["history_logged"] = False

    # Idle cutoff: relay has been on for IDLE_SECONDS but the machine was
    # never active (running or paused) during that window.
    if (
        relay_on
        and IDLE_SECONDS > 0
        and not was_active
        and memo.get("last_relay_on")
        and now - memo["last_relay_on"] >= IDLE_SECONDS * 1000
    ):
        cut_relay(refs, "idle_timeout",
                  f"Machine powered {IDLE_SECONDS // 60}m with no wash started — relay cut")
        memo["last_relay_on"] = 0

    memo["was_running"] = running


def pick_washer(appliances: list) -> Any:
    """Pick the washing machine from the list. If HISENSE_DEVICE_ID is set,
    match on puid/device_id/device_nickname; otherwise find the first washer."""
    if not appliances:
        return None

    if DEVICE_ID_FILTER:
        for a in appliances:
            props = a.device_properties if hasattr(a, "device_properties") else a
            pid = getattr(a, "puid", None) or getattr(a, "device_id", None)
            nick = getattr(a, "device_nickname", "") or ""
            if DEVICE_ID_FILTER in str(pid or "") or DEVICE_ID_FILTER.lower() in nick.lower():
                return a
        log.warning("HISENSE_DEVICE_ID=%r did not match any appliance", DEVICE_ID_FILTER)

    # Heuristic fallback: pick the one whose device_type_code or properties
    # look like a washer.
    for a in appliances:
        type_code = (getattr(a, "device_type_code", "") or "").lower()
        nick = (getattr(a, "device_nickname", "") or "").lower()
        if any(k in type_code for k in ("wash", "wf", "launder")) or "wash" in nick:
            return a
    return appliances[0]


def normalize_state(appliance: Any) -> dict:
    """Map raw Connect Life properties into a small, stable schema the app can
    rely on. The field names vary by device model; we try a handful of known
    aliases. Unknown properties are preserved under `raw` for debugging."""
    props = {}
    raw = getattr(appliance, "status_list", None) or getattr(appliance, "device_properties", None) or {}
    if hasattr(raw, "items"):
        props = {str(k): v for k, v in raw.items()}
    else:
        try:
            props = dict(raw)
        except Exception:
            props = {}

    def first(*keys, default=None):
        for k in keys:
            if k in props and props[k] not in (None, "", "null"):
                return props[k]
            # case-insensitive
            for pk in props.keys():
                if pk.lower() == k.lower() and props[pk] not in (None, "", "null"):
                    return props[pk]
        return default

    def to_int(v, default=0):
        try:
            return int(v)
        except (TypeError, ValueError):
            return default

    work_status = first(
        "machine_status", "workStatus", "work_status",
        "washingStatus", "status", "runState", default=None,
    )
    remaining_min = to_int(first(
        "Selected_program_remaining_time_in_minutes",
        "remainingTime", "remaining_time", "leftTime", "timeRemaining",
        default=0,
    ))
    total_min = to_int(first(
        "Selected_program_total_time_in_minutes",
        "totalTime", "total_time", default=0,
    ))
    phase_raw = to_int(first("Current_program_phase", "phase", default=0), 0)
    PHASE_NAMES = {
        0: "Idle", 1: "Pre-wash", 2: "Wash", 3: "Main wash",
        4: "Rinse", 5: "Softener", 6: "Drain", 7: "Spin",
        8: "Dry", 9: "Anti-crease",
    }
    phase_name = PHASE_NAMES.get(phase_raw, f"Phase {phase_raw}")
    program_id = first(
        "Selected_program_ID", "programId", "program",
        "selectedProgram", "selected_program_id", default=None,
    )
    door_status = first("Door_status", "doorLock", "door_lock", "doorStatus", default=None)
    power = first("power", "standby", "onOff", default=None)
    error = first("errorCode", "error", "faultCode", default=None)

    # Consumption: values are split into int/decimal (decimal is hundredths).
    water_int = to_int(first("Water_consumption_int", default=0), 0)
    water_dec = to_int(first("Water_consumption_decimal", default=0), 0)
    water_l = round(water_int + water_dec / 100.0, 2)
    elec_int = to_int(first("Electricit_consumption_int", default=0), 0)
    elec_dec = to_int(first("Electricit_consumption_decimal", default=0), 0)
    energy_kwh = round(elec_int + elec_dec / 100.0, 3)

    # Hisense machine_status values (WF3S8043BB3):
    #   2 = running / working, 3 = paused, 4 = ended/finished, 1/0 = idle.
    ms = to_int(work_status, -1)
    status_str = str(work_status).lower() if work_status is not None else ""
    running = ms == 2 or status_str in ("running", "run", "start", "work", "washing")
    paused = ms == 3 or status_str in ("pause", "paused")
    ended = ms == 4 or status_str in ("end", "ended", "finish", "finished", "complete")

    # Door_status: typically 3 = locked, 2 = closed, 1 = open/unlocked.
    door_locked = to_int(door_status, 0) == 3 if door_status is not None else None

    online = bool(getattr(appliance, "online", True))

    return {
        "updatedAt": int(time.time() * 1000),
        "online": online,
        "deviceId": str(getattr(appliance, "puid", None) or getattr(appliance, "device_id", "") or ""),
        "nickname": getattr(appliance, "device_nickname", "") or "",
        "power": bool(power) if power is not None else None,
        "running": running,
        "paused": paused,
        "ended": ended,
        "remainingMin": remaining_min,
        "totalMin": total_min,
        "phase": phase_raw,
        "phaseName": phase_name,
        "programId": program_id,
        "doorLocked": door_locked,
        "workStatusRaw": work_status,
        "waterLiters": water_l,
        "energyKwh": energy_kwh,
        "error": error,
        "raw": props,
    }


async def main() -> None:
    if not USERNAME or not PASSWORD:
        log.error("CONNECTLIFE_USERNAME and CONNECTLIFE_PASSWORD must be set in .env")
        sys.exit(1)

    refs = init_firebase()
    api = ConnectLifeApi(username=USERNAME, password=PASSWORD)

    log.info("=== Poller instance ID: '%s' ===", POLLER_ID)
    log.info("Authenticating with Connect Life (%s)", USERNAME)
    await api.authenticate()
    log.info(
        "OK. Polling every %ds. grace=%ds idle=%ds",
        POLL_SECONDS, GRACE_SECONDS, IDLE_SECONDS,
    )

    stop = asyncio.Event()

    def _sig(*_):
        log.info("Shutting down")
        stop.set()

    for s in (signal.SIGINT, signal.SIGTERM):
        try:
            signal.signal(s, _sig)
        except Exception:
            pass

    memo: dict = {}
    last_warn = 0
    invalid_login_streak = 0
    while not stop.is_set():
        try:
            appliances = await api.get_appliances()
            washer = pick_washer(appliances)
            if washer is None:
                if time.time() - last_warn > 60:
                    log.warning("No appliances on account yet")
                    last_warn = time.time()
            else:
                state = normalize_state(washer)

                # Check who is the active poller — if it's not us, skip all writes.
                # The "loser" still polls Hisense so it's warm and ready to take over
                # the moment admin flips the switch back.
                try:
                    active = refs["config"].child("activePoller").get() or "fly"
                except Exception:
                    active = "fly"
                active = str(active).strip().lower()
                am_active = (active == POLLER_ID)

                if am_active:
                    apply_control_logic(refs, state, memo)
                    state["graceUntil"] = int(memo.get("grace_until") or 0)
                    # Preserve admin-set mute flag across writes so emergency reset
                    # actually keeps the mirror logic disabled for its full window.
                    try:
                        existing = refs["hisense"].get() or {}
                        mu = int(existing.get("muteUntil") or 0)
                        if mu > int(time.time() * 1000):
                            state["muteUntil"] = mu
                            state["mutedBy"] = existing.get("mutedBy")
                    except Exception:
                        pass
                    state["pollerSource"] = POLLER_ID
                    refs["hisense"].set(state)
                    log.info(
                        "[ACTIVE:%s] state: running=%s paused=%s ended=%s remaining=%dm door=%s",
                        POLLER_ID, state["running"], state["paused"], state["ended"],
                        state["remainingMin"], state["doorLocked"],
                    )
                    raw = state.get("raw", {})
                    nonzero = {k: v for k, v in raw.items() if v not in (None, "", 0, "0", "null")}
                    log.info("raw (non-empty): %s", nonzero)
                else:
                    log.info(
                        "[STANDBY:%s] active poller is '%s' — skipping write. running=%s remaining=%dm",
                        POLLER_ID, active, state["running"], state["remainingMin"],
                    )

                invalid_login_streak = 0
        except Exception as e:
            msg = str(e)
            log.warning("poll failed: %s", e)
            # Back off hard on auth errors to avoid triggering Connect Life's
            # lockout. Stop after 3 in a row so the secret can be fixed.
            if "Invalid LoginID" in msg or "403042" in msg:
                invalid_login_streak += 1
                if invalid_login_streak >= 3:
                    log.error(
                        "Invalid credentials %d times in a row — stopping to "
                        "protect the account from lockout. Update "
                        "CONNECTLIFE_PASSWORD and restart the machine.",
                        invalid_login_streak,
                    )
                    return
                log.warning("Credentials rejected (%d/3). Waiting 60s.", invalid_login_streak)
                try:
                    await asyncio.wait_for(stop.wait(), timeout=60)
                except asyncio.TimeoutError:
                    pass
                continue
            if "Locked Out" in msg or "403120" in msg:
                log.error("Account locked out. Waiting 5 minutes.")
                try:
                    await asyncio.wait_for(stop.wait(), timeout=300)
                except asyncio.TimeoutError:
                    pass
                continue
            # try to re-auth if the token died
            try:
                await api.login()
            except Exception as e2:
                log.warning("re-auth failed: %s", e2)

        try:
            await asyncio.wait_for(stop.wait(), timeout=POLL_SECONDS)
        except asyncio.TimeoutError:
            pass


def _supervisor() -> None:
    """Self-healing outer loop. Any crash or natural exit from main() is
    caught and main() is re-started after a short back-off. The process
    never exits on its own, so Fly never marks the machine 'stopped'."""
    backoff = 5
    while True:
        try:
            asyncio.run(main())
            # main() returned cleanly (e.g. credentials rejected 3x). Wait
            # longer before retrying so a bad secret doesn't spam the API.
            log.warning("main() exited cleanly — restarting in 60s")
            time.sleep(60)
            backoff = 5
        except KeyboardInterrupt:
            log.info("KeyboardInterrupt — exiting")
            return
        except Exception as e:
            log.exception("UNCAUGHT in main(): %s", e)
            log.info("restarting in %ds", backoff)
            time.sleep(backoff)
            backoff = min(backoff * 2, 300)


if __name__ == "__main__":
    _supervisor()
