import { initializeApp } from "firebase/app";
import { getDatabase, ref, set, get, onValue, remove, update, push, query, orderByChild, limitToLast } from "firebase/database";
import { getAuth, signInAnonymously, onAuthStateChanged } from "firebase/auth";

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FB_API_KEY || "",
  authDomain: process.env.NEXT_PUBLIC_FB_AUTH_DOMAIN || "",
  databaseURL: process.env.NEXT_PUBLIC_FB_DB_URL || "https://laundryhub-4e35b-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: process.env.NEXT_PUBLIC_FB_PROJECT_ID || "",
  storageBucket: process.env.NEXT_PUBLIC_FB_STORAGE || "",
  messagingSenderId: process.env.NEXT_PUBLIC_FB_SENDER_ID || "",
  appId: process.env.NEXT_PUBLIC_FB_APP_ID || "",
};

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

// Anonymous sign-in so Realtime Database rules can gate on `auth != null`.
// Required for the app to read any auth-protected path once rules are
// published. Enable Anonymous sign-in in Firebase Console -> Authentication
// -> Sign-in method -> Anonymous.
if (typeof window !== "undefined") {
  const auth = getAuth(app);
  onAuthStateChanged(auth, (u) => {
    if (!u) {
      signInAnonymously(auth).catch((e) => {
        console.warn("Firebase anonymous auth failed:", e?.code || e?.message || e);
      });
    }
  });
}

const DB = {
  // ── Users ──
  async getUsers() { const s = await get(ref(db, "users")); return s.exists() ? Object.values(s.val()) : []; },
  async addUser(user) { await set(ref(db, `users/${user.id}`), user); },
  async updateUser(id, data) { await update(ref(db, `users/${id}`), data); },
  async removeUser(id) { await remove(ref(db, `users/${id}`)); },
  onUsersChange(cb) { return onValue(ref(db, "users"), s => cb(s.exists() ? Object.values(s.val()) : [])); },

  // ── Machine ──
  async getMachine() { const s = await get(ref(db, "machine")); return s.exists() ? s.val() : { running: false }; },
  async setMachine(state) { await set(ref(db, "machine"), state); },
  onMachineChange(cb) { return onValue(ref(db, "machine"), s => cb(s.exists() ? s.val() : { running: false })); },

  // ── Schedule ──
  async addScheduleEntry(entry) { await set(ref(db, `schedule/${entry.id}`), entry); },
  async updateScheduleEntry(entry) { await set(ref(db, `schedule/${entry.id}`), entry); },
  async removeScheduleEntry(id) { await remove(ref(db, `schedule/${id}`)); },
  async clearSchedule() { await remove(ref(db, "schedule")); },
  onScheduleChange(cb) {
    return onValue(ref(db, "schedule"), s => {
      if (!s.exists()) return cb([]);
      cb(Object.values(s.val()).sort((a, b) => (a.dateTime || "").localeCompare(b.dateTime || "")));
    });
  },

  // ── Config ──
  async getConfig() { const s = await get(ref(db, "config")); return s.exists() ? s.val() : null; },
  async setConfig(config) { await set(ref(db, "config"), config); },
  onConfigChange(cb) { return onValue(ref(db, "config"), s => cb(s.exists() ? s.val() : null)); },

  // ── ESP32 Status ──
  onEsp32Status(cb) { return onValue(ref(db, "esp32_status"), s => cb(s.exists() ? s.val() : null)); },
  async sendEspCommand(cmd) { await set(ref(db, "esp32_command"), cmd); },

  // ── Emergency reset (for when Hisense is stuck in "running" state) ──
  // 1. Wipes /machine to a clean idle state
  // 2. Sets /hisense/muteUntil so the poller temporarily stops mirroring (so it
  //    doesn't immediately re-mirror the ghost "running" state back)
  // 3. Sends "off" to the ESP32 so the relay opens immediately
  async emergencyReset({ reason = "admin_reset", muteMinutes = 10 } = {}) {
    const now = Date.now();
    const muteUntil = now + muteMinutes * 60 * 1000;
    await set(ref(db, "machine"), {
      running: false,
      forceResetAt: now,
      stoppedBy: reason,
      finishedAt: now,
    });
    // Mute Hisense mirroring for N minutes — poller checks this before mirroring
    await update(ref(db, "hisense"), { muteUntil, mutedBy: reason });
    // Open the relay immediately (don't wait for ESP32's debounce)
    await set(ref(db, "esp32_command"), { type: "off", ts: now });
    return { muteUntil };
  },
  async clearHisenseMute() {
    await update(ref(db, "hisense"), { muteUntil: 0, mutedBy: null });
  },

  // ── Active poller switch ─────────────────────────────────────
  // /config/activePoller = "fly" | "pc". Both poller instances read this every
  // cycle and only the matching one writes to Firebase.
  async setActivePoller(which) {
    await update(ref(db, "config"), { activePoller: which });
  },

  // ── Hisense (written by hisense-poller/poller.py) ──
  onHisense(cb) { return onValue(ref(db, "hisense"), s => cb(s.exists() ? s.val() : null)); },
  onNotifications(cb, count = 20) {
    const q = query(ref(db, "notifications"), orderByChild("ts"), limitToLast(count));
    return onValue(q, s => {
      if (!s.exists()) return cb([]);
      cb(Object.values(s.val()).sort((a, b) => (a.ts || 0) - (b.ts || 0)));
    });
  },

  // ── Wash History ──
  async addWashRecord(record) { await set(ref(db, `history/${record.id}`), record); },
  async clearHistory() { await remove(ref(db, "history")); },
  onHistoryChange(cb) {
    return onValue(ref(db, "history"), s => {
      if (!s.exists()) return cb([]);
      cb(Object.values(s.val()).sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0)));
    });
  },

  // ── Cleaning roster ──
  // Stored at /cleaning/config: { enabled, participantIds[5], tasks[5], baseMonday }
  // Completions at /cleaning/completions/{weekMondayMs}/{userId} = timestamp
  async setCleaning(c) { await set(ref(db, "cleaning/config"), c); },
  onCleaning(cb) { return onValue(ref(db, "cleaning/config"), s => cb(s.exists() ? s.val() : null)); },
  async markCleaningDone(weekKey, userId, done) {
    const path = `cleaning/completions/${weekKey}/${userId}`;
    if (done) await set(ref(db, path), Date.now());
    else await remove(ref(db, path));
  },
  onCleaningCompletions(cb) { return onValue(ref(db, "cleaning/completions"), s => cb(s.exists() ? s.val() : {})); },

  // ── Chat / Messages ──
  async sendMessage(msg) {
    const msgRef = push(ref(db, "chat"));
    await set(msgRef, { ...msg, timestamp: Date.now() });
  },
  async deleteMessage(key) { await remove(ref(db, `chat/${key}`)); },
  async editMessage(key, text) { await update(ref(db, `chat/${key}`), { text, edited: true, editedAt: Date.now() }); },
  onChatMessages(cb, count = 50) {
    const q = query(ref(db, "chat"), orderByChild("timestamp"), limitToLast(count));
    return onValue(q, s => {
      if (!s.exists()) return cb([]);
      const entries = Object.entries(s.val()).map(([k, v]) => ({ ...v, _key: k }));
      cb(entries.sort((a, b) => a.timestamp - b.timestamp));
    });
  },
};

export default DB;
