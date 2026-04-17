import { initializeApp } from "firebase/app";
import { getDatabase, ref, set, get, onValue, remove, update, push, query, orderByChild, limitToLast } from "firebase/database";

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

  // ── Wash History ──
  async addWashRecord(record) { await set(ref(db, `history/${record.id}`), record); },
  onHistoryChange(cb) {
    return onValue(ref(db, "history"), s => {
      if (!s.exists()) return cb([]);
      cb(Object.values(s.val()).sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0)));
    });
  },

  // ── Chat / Messages ──
  async sendMessage(msg) {
    const msgRef = push(ref(db, "chat"));
    await set(msgRef, { ...msg, timestamp: Date.now() });
  },
  onChatMessages(cb, count = 50) {
    const q = query(ref(db, "chat"), orderByChild("timestamp"), limitToLast(count));
    return onValue(q, s => {
      if (!s.exists()) return cb([]);
      cb(Object.values(s.val()).sort((a, b) => a.timestamp - b.timestamp));
    });
  },
};

export default DB;
