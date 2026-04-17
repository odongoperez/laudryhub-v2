import { useState, useEffect, useCallback, useRef } from "react";

// ─── Constants & Config ───
const DEFAULT_CONFIG = {
  primaryColor: "#0F766E",
  accentColor: "#F59E0B",
  appName: "LaundryHub",
  esp32Ip: "192.168.1.100",
  esp32Connected: false,
  washCycles: [
    { name: "Quick Wash", minutes: 30 },
    { name: "Normal", minutes: 45 },
    { name: "Heavy Duty", minutes: 60 },
    { name: "Delicates", minutes: 25 },
    { name: "Bedding", minutes: 75 },
  ],
  alertMinutesBefore: 5,
};

const ADMIN_PASSWORD = "1234";

// ─── Persistent Storage Helpers ───
async function loadData(key, fallback) {
  try {
    if (!window.storage) return fallback;
    const res = await window.storage.get(key);
    if (res && res.value != null) {
      return JSON.parse(res.value);
    }
    return fallback;
  } catch {
    return fallback;
  }
}
async function saveData(key, data) {
  try {
    if (!window.storage) { console.warn("Storage not available"); return false; }
    const result = await window.storage.set(key, JSON.stringify(data));
    if (!result) { console.error("Storage write failed for", key); return false; }
    return true;
  } catch (e) {
    console.error("Storage error:", key, e);
    return false;
  }
}

// ─── Icons (inline SVG) ───
const Icons = {
  Power: ({ size = 20, color = "currentColor" }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round"><line x1="12" y1="2" x2="12" y2="12"/><path d="M16.24 7.76a6 6 0 1 1-8.49 0"/></svg>
  ),
  Clock: ({ size = 20 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
  ),
  Users: ({ size = 20 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
  ),
  Settings: ({ size = 20 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="3"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>
  ),
  Calendar: ({ size = 20 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
  ),
  Bell: ({ size = 20 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
  ),
  Wifi: ({ size = 20 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg>
  ),
  Logout: ({ size = 20 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
  ),
  Droplet: ({ size = 20 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"/></svg>
  ),
  Check: ({ size = 20 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>
  ),
  Trash: ({ size = 18 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
  ),
  Shield: ({ size = 20 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
  ),
};

// ─── Washing Animation Component ───
function WashingAnimation({ isRunning, progress, primaryColor }) {
  return (
    <div style={{
      width: 180, height: 180, borderRadius: "50%", position: "relative",
      background: `conic-gradient(${primaryColor} ${progress * 360}deg, #1e293b ${progress * 360}deg)`,
      display: "flex", alignItems: "center", justifyContent: "center",
      boxShadow: isRunning ? `0 0 40px ${primaryColor}44` : "0 0 20px #0002",
      transition: "box-shadow 0.5s",
    }}>
      <div style={{
        width: 156, height: 156, borderRadius: "50%", background: "#0f172a",
        display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column",
      }}>
        {isRunning ? (
          <div style={{ animation: "spin 2s linear infinite" }}>
            <Icons.Droplet size={40} color={primaryColor} />
          </div>
        ) : (
          <Icons.Power size={40} color="#64748b" />
        )}
        <div style={{ fontSize: 14, color: "#94a3b8", marginTop: 8, fontWeight: 600, letterSpacing: 1 }}>
          {isRunning ? `${Math.round(progress * 100)}%` : "IDLE"}
        </div>
      </div>
    </div>
  );
}

// ─── Toast Notification ───
function Toast({ message, type = "info", onClose }) {
  useEffect(() => { const t = setTimeout(onClose, 4000); return () => clearTimeout(t); }, [onClose]);
  const bg = type === "success" ? "#059669" : type === "error" ? "#dc2626" : type === "warning" ? "#d97706" : "#0ea5e9";
  return (
    <div style={{
      position: "fixed", top: 20, right: 20, zIndex: 9999, padding: "14px 24px",
      background: bg, color: "#fff", borderRadius: 12, fontSize: 14, fontWeight: 600,
      boxShadow: "0 8px 30px #0004", animation: "slideIn 0.3s ease",
      display: "flex", alignItems: "center", gap: 10, maxWidth: 360,
    }}>
      <Icons.Bell size={18} />
      {message}
    </div>
  );
}

// ─── Login Screen ───
function LoginScreen({ onLogin, config }) {
  const [mode, setMode] = useState("user"); // "user" | "admin"
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);

  // Load users on mount AND poll every 2s to catch admin-added users
  useEffect(() => {
    let active = true;
    const load = async () => {
      const data = await loadData("laundry_users", []);
      if (active) { setUsers(data); setLoading(false); }
    };
    load();
    const iv = setInterval(load, 2000);
    return () => { active = false; clearInterval(iv); };
  }, []);

  const handleLogin = async () => {
    setError("");
    if (mode === "admin") {
      if (password === ADMIN_PASSWORD) onLogin({ role: "admin", name: "Admin" });
      else setError("Wrong admin password");
    } else {
      // Always reload fresh from storage before checking
      const freshUsers = await loadData("laundry_users", []);
      setUsers(freshUsers);
      const user = freshUsers.find(u => u.name.toLowerCase() === username.toLowerCase() && u.pin === password);
      if (user) onLogin({ role: "user", name: user.name, id: user.id });
      else setError("Invalid username or PIN. Ask admin to create your account.");
    }
  };

  return (
    <div style={{
      minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center",
      background: "#0f172a", fontFamily: "'DM Sans', 'Segoe UI', sans-serif",
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Space+Mono:wght@700&display=swap');
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        @keyframes slideIn { from { transform: translateX(100px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
        @keyframes fadeUp { from { transform: translateY(20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        input:focus { outline: none; border-color: ${config.primaryColor} !important; }
      `}</style>
      <div style={{
        width: 400, background: "#1e293b", borderRadius: 24, padding: 40,
        boxShadow: "0 25px 60px #0006", animation: "fadeUp 0.5s ease",
      }}>
        <div style={{ textAlign: "center", marginBottom: 32 }}>
          <div style={{
            width: 64, height: 64, borderRadius: 16, background: `${config.primaryColor}22`,
            display: "inline-flex", alignItems: "center", justifyContent: "center", marginBottom: 16,
          }}>
            <Icons.Droplet size={32} color={config.primaryColor} />
          </div>
          <h1 style={{
            fontSize: 28, fontFamily: "'Space Mono', monospace", color: "#f1f5f9",
            letterSpacing: -1,
          }}>{config.appName}</h1>
          <p style={{ color: "#64748b", fontSize: 14, marginTop: 4 }}>Smart Laundry Control</p>
        </div>

        <div style={{ display: "flex", gap: 8, marginBottom: 24 }}>
          {["user", "admin"].map(m => (
            <button key={m} onClick={() => { setMode(m); setError(""); }} style={{
              flex: 1, padding: "10px 0", borderRadius: 10, border: "none", cursor: "pointer",
              background: mode === m ? config.primaryColor : "#334155", color: "#f1f5f9",
              fontWeight: 600, fontSize: 14, transition: "all 0.2s",
              fontFamily: "'DM Sans', sans-serif",
            }}>
              {m === "admin" ? "🛡️ Admin" : "👤 User"}
            </button>
          ))}
        </div>

        {mode === "user" && (
          <input value={username} onChange={e => setUsername(e.target.value)}
            placeholder="Your name" style={{
              width: "100%", padding: "14px 16px", borderRadius: 10, border: "2px solid #334155",
              background: "#0f172a", color: "#f1f5f9", fontSize: 15, marginBottom: 12,
              fontFamily: "'DM Sans', sans-serif",
            }} />
        )}

        <input value={password} onChange={e => setPassword(e.target.value)}
          type="password" placeholder={mode === "admin" ? "Admin password" : "Your PIN"}
          onKeyDown={e => e.key === "Enter" && handleLogin()}
          style={{
            width: "100%", padding: "14px 16px", borderRadius: 10, border: "2px solid #334155",
            background: "#0f172a", color: "#f1f5f9", fontSize: 15, marginBottom: 8,
            fontFamily: "'DM Sans', sans-serif",
          }} />

        {error && <p style={{ color: "#ef4444", fontSize: 13, marginBottom: 8, fontWeight: 500 }}>{error}</p>}

        <button onClick={handleLogin} style={{
          width: "100%", padding: "14px 0", borderRadius: 12, border: "none", cursor: "pointer",
          background: config.primaryColor, color: "#fff", fontWeight: 700, fontSize: 16, marginTop: 12,
          fontFamily: "'DM Sans', sans-serif", letterSpacing: 0.5,
        }}>Sign In</button>
      </div>
    </div>
  );
}

// ─── User Dashboard ───
function UserDashboard({ user, config, onLogout, showToast }) {
  const [machineState, setMachineState] = useState(null);
  const [schedule, setSchedule] = useState([]);
  const [selectedCycle, setSelectedCycle] = useState(0);
  const [scheduleDate, setScheduleDate] = useState("");
  const [scheduleTime, setScheduleTime] = useState("");
  const [now, setNow] = useState(Date.now());
  const timerRef = useRef(null);
  const alertFiredRef = useRef(false);

  useEffect(() => {
    loadData("laundry_machine", null).then(setMachineState);
    loadData("laundry_schedule", []).then(setSchedule);
    timerRef.current = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timerRef.current);
  }, []);

  // Periodically reload state
  useEffect(() => {
    const iv = setInterval(() => {
      loadData("laundry_machine", null).then(setMachineState);
      loadData("laundry_schedule", []).then(setSchedule);
    }, 3000);
    return () => clearInterval(iv);
  }, []);

  // Check if machine is almost done → alert
  useEffect(() => {
    if (machineState && machineState.running && machineState.userId === user.id) {
      const endTime = machineState.startTime + machineState.durationMs;
      const alertTime = endTime - config.alertMinutesBefore * 60000;
      if (now >= alertTime && now < endTime && !alertFiredRef.current) {
        alertFiredRef.current = true;
        showToast(`⏰ Your wash finishes in ~${config.alertMinutesBefore} min!`, "warning");
      }
      if (now >= endTime) {
        // Auto-stop
        const updated = { ...machineState, running: false };
        setMachineState(updated);
        saveData("laundry_machine", updated);
        showToast("✅ Wash cycle complete!", "success");
        alertFiredRef.current = false;
      }
    }
  }, [now, machineState, user.id, config.alertMinutesBefore, showToast]);

  const isMyWash = machineState?.running && machineState.userId === user.id;
  const isBusy = machineState?.running && machineState.userId !== user.id;
  const progress = machineState?.running
    ? Math.min(1, (now - machineState.startTime) / machineState.durationMs)
    : 0;
  const remainMs = machineState?.running ? Math.max(0, (machineState.startTime + machineState.durationMs) - now) : 0;
  const remainMin = Math.ceil(remainMs / 60000);

  const startWash = async () => {
    if (machineState?.running) return;
    const cycle = config.washCycles[selectedCycle];
    const state = {
      running: true,
      userId: user.id,
      userName: user.name,
      cycleName: cycle.name,
      startTime: Date.now(),
      durationMs: cycle.minutes * 60000,
    };
    setMachineState(state);
    await saveData("laundry_machine", state);
    alertFiredRef.current = false;
    showToast(`🚿 ${cycle.name} started — ${cycle.minutes} min`, "success");
  };

  const stopWash = async () => {
    if (!isMyWash) return;
    const state = { running: false };
    setMachineState(state);
    await saveData("laundry_machine", state);
    showToast("Machine stopped", "info");
  };

  const addSchedule = async () => {
    if (!scheduleDate || !scheduleTime) return showToast("Pick date & time", "error");
    const cycle = config.washCycles[selectedCycle];
    const entry = {
      id: Date.now().toString(),
      userId: user.id, userName: user.name,
      cycleName: cycle.name, minutes: cycle.minutes,
      dateTime: `${scheduleDate}T${scheduleTime}`,
    };
    const updated = [...schedule, entry].sort((a, b) => a.dateTime.localeCompare(b.dateTime));
    setSchedule(updated);
    await saveData("laundry_schedule", updated);
    setScheduleDate(""); setScheduleTime("");
    showToast("📅 Wash scheduled!", "success");
  };

  const removeSchedule = async (id) => {
    const updated = schedule.filter(s => s.id !== id);
    setSchedule(updated);
    await saveData("laundry_schedule", updated);
  };

  const fmt = (dt) => {
    const d = new Date(dt);
    return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }) + " " +
           d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  };

  return (
    <div style={{ minHeight: "100vh", background: "#0f172a", fontFamily: "'DM Sans', sans-serif", color: "#f1f5f9" }}>
      {/* Header */}
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        padding: "16px 24px", borderBottom: "1px solid #1e293b",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Icons.Droplet size={24} color={config.primaryColor} />
          <span style={{ fontFamily: "'Space Mono', monospace", fontWeight: 700, fontSize: 18 }}>{config.appName}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <span style={{ color: "#94a3b8", fontSize: 14 }}>👋 {user.name}</span>
          <button onClick={onLogout} style={{
            background: "none", border: "1px solid #334155", borderRadius: 8, padding: "6px 12px",
            color: "#94a3b8", cursor: "pointer", display: "flex", alignItems: "center", gap: 6, fontSize: 13,
          }}>
            <Icons.Logout size={14} /> Sign Out
          </button>
        </div>
      </div>

      <div style={{ maxWidth: 800, margin: "0 auto", padding: 24 }}>
        {/* Machine Status Card */}
        <div style={{
          background: "#1e293b", borderRadius: 20, padding: 32, marginBottom: 24,
          display: "flex", flexDirection: "column", alignItems: "center",
          border: `1px solid ${isBusy ? "#dc262644" : isMyWash ? config.primaryColor + "44" : "#334155"}`,
        }}>
          <WashingAnimation isRunning={machineState?.running} progress={progress} primaryColor={config.primaryColor} />

          {machineState?.running ? (
            <div style={{ textAlign: "center", marginTop: 20 }}>
              <div style={{
                fontSize: 13, color: isBusy ? "#f87171" : config.primaryColor,
                fontWeight: 700, letterSpacing: 2, textTransform: "uppercase",
              }}>
                {isBusy ? `🔒 ${machineState.userName} is washing` : "Your wash is running"}
              </div>
              <div style={{ fontSize: 22, fontWeight: 700, marginTop: 4 }}>{machineState.cycleName}</div>
              <div style={{ color: "#94a3b8", fontSize: 15, marginTop: 4 }}>
                ⏱️ {remainMin} min remaining
              </div>
              {isMyWash && (
                <button onClick={stopWash} style={{
                  marginTop: 16, padding: "10px 28px", borderRadius: 10, border: "none", cursor: "pointer",
                  background: "#dc2626", color: "#fff", fontWeight: 600, fontSize: 14,
                  fontFamily: "'DM Sans', sans-serif",
                }}>⏹ Stop Machine</button>
              )}
            </div>
          ) : (
            <div style={{ textAlign: "center", marginTop: 20 }}>
              <div style={{ fontSize: 13, color: "#22c55e", fontWeight: 700, letterSpacing: 2 }}>● AVAILABLE</div>
              <div style={{ color: "#94a3b8", marginTop: 4, fontSize: 14 }}>Machine is free — start a wash below</div>
            </div>
          )}
        </div>

        {/* Start Wash */}
        {!machineState?.running && (
          <div style={{
            background: "#1e293b", borderRadius: 16, padding: 24, marginBottom: 24,
            border: "1px solid #334155",
          }}>
            <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 16, display: "flex", alignItems: "center", gap: 8 }}>
              <Icons.Power size={18} color={config.primaryColor} /> Start a Wash
            </h3>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
              {config.washCycles.map((c, i) => (
                <button key={i} onClick={() => setSelectedCycle(i)} style={{
                  padding: "10px 16px", borderRadius: 10, cursor: "pointer",
                  border: selectedCycle === i ? `2px solid ${config.primaryColor}` : "2px solid #334155",
                  background: selectedCycle === i ? `${config.primaryColor}22` : "#0f172a",
                  color: "#f1f5f9", fontSize: 13, fontWeight: 600,
                  fontFamily: "'DM Sans', sans-serif",
                }}>
                  {c.name} <span style={{ color: "#64748b" }}>({c.minutes}m)</span>
                </button>
              ))}
            </div>
            <button onClick={startWash} style={{
              width: "100%", padding: "14px 0", borderRadius: 12, border: "none", cursor: "pointer",
              background: config.primaryColor, color: "#fff", fontWeight: 700, fontSize: 16,
              fontFamily: "'DM Sans', sans-serif",
            }}>▶ Start {config.washCycles[selectedCycle].name}</button>
          </div>
        )}

        {/* Schedule a Wash */}
        <div style={{
          background: "#1e293b", borderRadius: 16, padding: 24, marginBottom: 24,
          border: "1px solid #334155",
        }}>
          <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 16, display: "flex", alignItems: "center", gap: 8 }}>
            <Icons.Calendar size={18} color={config.accentColor} /> Schedule a Wash
          </h3>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
            <input type="date" value={scheduleDate} onChange={e => setScheduleDate(e.target.value)} style={{
              flex: 1, minWidth: 140, padding: "10px 12px", borderRadius: 10, border: "2px solid #334155",
              background: "#0f172a", color: "#f1f5f9", fontSize: 14, fontFamily: "'DM Sans', sans-serif",
            }} />
            <input type="time" value={scheduleTime} onChange={e => setScheduleTime(e.target.value)} style={{
              flex: 1, minWidth: 120, padding: "10px 12px", borderRadius: 10, border: "2px solid #334155",
              background: "#0f172a", color: "#f1f5f9", fontSize: 14, fontFamily: "'DM Sans', sans-serif",
            }} />
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
            {config.washCycles.map((c, i) => (
              <button key={i} onClick={() => setSelectedCycle(i)} style={{
                padding: "6px 12px", borderRadius: 8, fontSize: 12, cursor: "pointer",
                border: selectedCycle === i ? `2px solid ${config.accentColor}` : "1px solid #475569",
                background: selectedCycle === i ? `${config.accentColor}22` : "transparent",
                color: "#cbd5e1", fontFamily: "'DM Sans', sans-serif", fontWeight: 500,
              }}>{c.name}</button>
            ))}
          </div>
          <button onClick={addSchedule} style={{
            width: "100%", padding: "12px 0", borderRadius: 10, border: "none", cursor: "pointer",
            background: config.accentColor, color: "#0f172a", fontWeight: 700, fontSize: 14,
            fontFamily: "'DM Sans', sans-serif",
          }}>📅 Schedule Wash</button>
        </div>

        {/* Upcoming Schedule */}
        <div style={{
          background: "#1e293b", borderRadius: 16, padding: 24, border: "1px solid #334155",
        }}>
          <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 16, display: "flex", alignItems: "center", gap: 8 }}>
            <Icons.Clock size={18} color="#94a3b8" /> Upcoming Washes
          </h3>
          {schedule.length === 0 ? (
            <p style={{ color: "#64748b", fontSize: 14, textAlign: "center", padding: 16 }}>
              No washes scheduled yet. Be the first to book a slot!
            </p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {schedule.map(s => (
                <div key={s.id} style={{
                  display: "flex", justifyContent: "space-between", alignItems: "center",
                  padding: "12px 16px", borderRadius: 10, background: "#0f172a",
                  border: s.userId === user.id ? `1px solid ${config.primaryColor}44` : "1px solid #1e293b",
                }}>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 600 }}>
                      {s.userName} {s.userId === user.id && <span style={{ color: config.primaryColor }}>(you)</span>}
                    </div>
                    <div style={{ fontSize: 12, color: "#64748b", marginTop: 2 }}>
                      {s.cycleName} · {s.minutes}m · {fmt(s.dateTime)}
                    </div>
                  </div>
                  {s.userId === user.id && (
                    <button onClick={() => removeSchedule(s.id)} style={{
                      background: "none", border: "none", cursor: "pointer", color: "#ef4444", padding: 4,
                    }}><Icons.Trash size={16} /></button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Admin Dashboard ───
function AdminDashboard({ config, setConfig, onLogout, showToast }) {
  const [users, setUsers] = useState([]);
  const [newName, setNewName] = useState("");
  const [newPin, setNewPin] = useState("");
  const [tab, setTab] = useState("users");
  const [machineState, setMachineState] = useState(null);
  const [schedule, setSchedule] = useState([]);
  const [espIp, setEspIp] = useState(config.esp32Ip);
  const [colorPrimary, setColorPrimary] = useState(config.primaryColor);
  const [colorAccent, setColorAccent] = useState(config.accentColor);
  const [appNameEdit, setAppNameEdit] = useState(config.appName);
  const [alertMin, setAlertMin] = useState(config.alertMinutesBefore);
  const [testResult, setTestResult] = useState("");

  useEffect(() => {
    loadData("laundry_users", []).then(setUsers);
    loadData("laundry_machine", null).then(setMachineState);
    loadData("laundry_schedule", []).then(setSchedule);
  }, []);

  const addUser = async () => {
    if (!newName.trim() || !newPin.trim()) return showToast("Name and PIN required", "error");
    if (users.find(u => u.name.toLowerCase() === newName.toLowerCase()))
      return showToast("User already exists", "error");
    const u = { id: Date.now().toString(), name: newName.trim(), pin: newPin.trim(), created: new Date().toISOString() };
    const updated = [...users, u];
    const saved = await saveData("laundry_users", updated);
    if (saved) {
      setUsers(updated);
      setNewName(""); setNewPin("");
      showToast(`✅ ${u.name} added`, "success");
    } else {
      showToast("Failed to save — try again", "error");
    }
  };

  const removeUser = async (id) => {
    const updated = users.filter(u => u.id !== id);
    const saved = await saveData("laundry_users", updated);
    if (saved) {
      setUsers(updated);
      showToast("User removed", "info");
    } else {
      showToast("Failed to remove — try again", "error");
    }
  };

  const forceStop = async () => {
    await saveData("laundry_machine", { running: false });
    setMachineState({ running: false });
    showToast("Machine force-stopped", "warning");
  };

  const clearSchedule = async () => {
    setSchedule([]);
    await saveData("laundry_schedule", []);
    showToast("Schedule cleared", "info");
  };

  const saveConfig = async () => {
    const updated = {
      ...config,
      primaryColor: colorPrimary,
      accentColor: colorAccent,
      appName: appNameEdit,
      esp32Ip: espIp,
      alertMinutesBefore: Number(alertMin) || 5,
    };
    setConfig(updated);
    await saveData("laundry_config", updated);
    showToast("⚙️ Config saved!", "success");
  };

  const testEsp = async () => {
    setTestResult("Testing...");
    // In a real deployment, this would call the ESP32
    // For now we simulate it
    setTimeout(() => {
      setTestResult(`Ping to ${espIp} — ESP32 would respond here. See Setup Guide for wiring.`);
    }, 1500);
  };

  const tabs = [
    { id: "users", label: "Users", icon: <Icons.Users size={16} /> },
    { id: "machine", label: "Machine", icon: <Icons.Power size={16} /> },
    { id: "esp32", label: "ESP32", icon: <Icons.Wifi size={16} /> },
    { id: "ui", label: "UI Config", icon: <Icons.Settings size={16} /> },
  ];

  const inputStyle = {
    padding: "10px 14px", borderRadius: 10, border: "2px solid #334155",
    background: "#0f172a", color: "#f1f5f9", fontSize: 14, fontFamily: "'DM Sans', sans-serif",
    width: "100%",
  };

  return (
    <div style={{ minHeight: "100vh", background: "#0f172a", fontFamily: "'DM Sans', sans-serif", color: "#f1f5f9" }}>
      {/* Header */}
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        padding: "16px 24px", borderBottom: "1px solid #1e293b",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Icons.Shield size={24} color={config.primaryColor} />
          <span style={{ fontFamily: "'Space Mono', monospace", fontWeight: 700, fontSize: 18 }}>Admin Panel</span>
        </div>
        <button onClick={onLogout} style={{
          background: "none", border: "1px solid #334155", borderRadius: 8, padding: "6px 12px",
          color: "#94a3b8", cursor: "pointer", display: "flex", alignItems: "center", gap: 6, fontSize: 13,
        }}>
          <Icons.Logout size={14} /> Sign Out
        </button>
      </div>

      <div style={{ maxWidth: 800, margin: "0 auto", padding: 24 }}>
        {/* Tabs */}
        <div style={{ display: "flex", gap: 6, marginBottom: 24, flexWrap: "wrap" }}>
          {tabs.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)} style={{
              padding: "10px 18px", borderRadius: 10, cursor: "pointer",
              border: tab === t.id ? `2px solid ${config.primaryColor}` : "1px solid #334155",
              background: tab === t.id ? `${config.primaryColor}22` : "transparent",
              color: tab === t.id ? "#f1f5f9" : "#94a3b8", fontWeight: 600, fontSize: 13,
              display: "flex", alignItems: "center", gap: 6, fontFamily: "'DM Sans', sans-serif",
            }}>{t.icon}{t.label}</button>
          ))}
        </div>

        {/* Users Tab */}
        {tab === "users" && (
          <div style={{ background: "#1e293b", borderRadius: 16, padding: 24, border: "1px solid #334155" }}>
            <h3 style={{ fontSize: 18, fontWeight: 700, marginBottom: 20 }}>Manage Users ({users.length}/5)</h3>
            <div style={{ display: "flex", gap: 8, marginBottom: 20, flexWrap: "wrap" }}>
              <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="Name"
                style={{ ...inputStyle, flex: 2, minWidth: 140 }} />
              <input value={newPin} onChange={e => setNewPin(e.target.value)} placeholder="4-digit PIN" maxLength={4}
                style={{ ...inputStyle, flex: 1, minWidth: 100 }} />
              <button onClick={addUser} style={{
                padding: "10px 20px", borderRadius: 10, border: "none", cursor: "pointer",
                background: config.primaryColor, color: "#fff", fontWeight: 700, fontSize: 14,
                fontFamily: "'DM Sans', sans-serif", whiteSpace: "nowrap",
              }}>+ Add</button>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {users.map(u => (
                <div key={u.id} style={{
                  display: "flex", justifyContent: "space-between", alignItems: "center",
                  padding: "14px 16px", borderRadius: 10, background: "#0f172a",
                }}>
                  <div>
                    <div style={{ fontWeight: 600 }}>{u.name}</div>
                    <div style={{ fontSize: 12, color: "#64748b" }}>PIN: {u.pin} · Added: {new Date(u.created).toLocaleDateString()}</div>
                  </div>
                  <button onClick={() => removeUser(u.id)} style={{
                    background: "#dc262622", border: "none", borderRadius: 8, padding: "6px 12px",
                    color: "#ef4444", cursor: "pointer", fontSize: 12, fontWeight: 600,
                    fontFamily: "'DM Sans', sans-serif",
                  }}>Remove</button>
                </div>
              ))}
              {users.length === 0 && (
                <p style={{ color: "#64748b", textAlign: "center", padding: 20 }}>No users yet. Add up to 5 users above.</p>
              )}
            </div>
          </div>
        )}

        {/* Machine Tab */}
        {tab === "machine" && (
          <div style={{ background: "#1e293b", borderRadius: 16, padding: 24, border: "1px solid #334155" }}>
            <h3 style={{ fontSize: 18, fontWeight: 700, marginBottom: 20 }}>Machine Control</h3>
            <div style={{
              padding: 20, borderRadius: 12, background: "#0f172a", marginBottom: 16,
              border: `1px solid ${machineState?.running ? "#dc262644" : "#22c55e44"}`,
            }}>
              <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>
                Status: {machineState?.running ? `🔴 Running — ${machineState.userName} (${machineState.cycleName})` : "🟢 Idle"}
              </div>
              {machineState?.running && (
                <button onClick={forceStop} style={{
                  padding: "10px 24px", borderRadius: 10, border: "none", cursor: "pointer",
                  background: "#dc2626", color: "#fff", fontWeight: 700, fontSize: 14,
                  fontFamily: "'DM Sans', sans-serif",
                }}>⚠ Force Stop</button>
              )}
            </div>

            <h4 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>Scheduled Washes</h4>
            {schedule.length > 0 ? (
              <>
                {schedule.map(s => (
                  <div key={s.id} style={{
                    padding: "10px 14px", borderRadius: 8, background: "#0f172a", marginBottom: 6,
                    fontSize: 13,
                  }}>
                    <strong>{s.userName}</strong> — {s.cycleName} ({s.minutes}m) · {new Date(s.dateTime).toLocaleString()}
                  </div>
                ))}
                <button onClick={clearSchedule} style={{
                  marginTop: 12, padding: "8px 16px", borderRadius: 8, border: "1px solid #dc262644",
                  background: "transparent", color: "#ef4444", cursor: "pointer", fontSize: 13, fontWeight: 600,
                  fontFamily: "'DM Sans', sans-serif",
                }}>Clear All Schedules</button>
              </>
            ) : (
              <p style={{ color: "#64748b", fontSize: 14 }}>No upcoming washes.</p>
            )}
          </div>
        )}

        {/* ESP32 Tab */}
        {tab === "esp32" && (
          <div style={{ background: "#1e293b", borderRadius: 16, padding: 24, border: "1px solid #334155" }}>
            <h3 style={{ fontSize: 18, fontWeight: 700, marginBottom: 20 }}>ESP32 Connection</h3>
            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 13, color: "#94a3b8", display: "block", marginBottom: 6 }}>ESP32 IP Address</label>
              <input value={espIp} onChange={e => setEspIp(e.target.value)} style={inputStyle} placeholder="192.168.1.100" />
            </div>
            <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
              <button onClick={testEsp} style={{
                padding: "10px 20px", borderRadius: 10, border: "none", cursor: "pointer",
                background: config.primaryColor, color: "#fff", fontWeight: 600, fontSize: 14,
                fontFamily: "'DM Sans', sans-serif",
              }}><Icons.Wifi size={14} /> Test Connection</button>
              <button onClick={saveConfig} style={{
                padding: "10px 20px", borderRadius: 10, border: "1px solid #334155", cursor: "pointer",
                background: "transparent", color: "#f1f5f9", fontWeight: 600, fontSize: 14,
                fontFamily: "'DM Sans', sans-serif",
              }}>Save IP</button>
            </div>
            {testResult && (
              <div style={{ padding: 14, borderRadius: 10, background: "#0f172a", fontSize: 13, color: "#94a3b8", fontFamily: "monospace" }}>
                {testResult}
              </div>
            )}

            <div style={{
              marginTop: 24, padding: 20, borderRadius: 12, background: "#0f172a",
              border: "1px solid #334155",
            }}>
              <h4 style={{ fontSize: 15, fontWeight: 700, marginBottom: 12 }}>🔧 Wiring Guide</h4>
              <div style={{ fontSize: 13, color: "#94a3b8", lineHeight: 1.8 }}>
                <div><strong style={{ color: "#f1f5f9" }}>ESP32 GPIO 26</strong> → Relay IN</div>
                <div><strong style={{ color: "#f1f5f9" }}>ESP32 GND</strong> → Relay GND</div>
                <div><strong style={{ color: "#f1f5f9" }}>ESP32 VIN (5V)</strong> → Relay VCC</div>
                <div><strong style={{ color: "#f1f5f9" }}>Relay COM</strong> → Mains Live (from breaker)</div>
                <div><strong style={{ color: "#f1f5f9" }}>Relay NO</strong> → Washing Machine Live</div>
                <div style={{ marginTop: 8, color: "#f59e0b", fontWeight: 600 }}>
                  ⚠ SAFETY: Always disconnect mains before wiring. Use a relay rated for your mains voltage (230V/10A for EU).
                </div>
              </div>
            </div>
          </div>
        )}

        {/* UI Config Tab */}
        {tab === "ui" && (
          <div style={{ background: "#1e293b", borderRadius: 16, padding: 24, border: "1px solid #334155" }}>
            <h3 style={{ fontSize: 18, fontWeight: 700, marginBottom: 20 }}>UI Configuration</h3>
            <div style={{ display: "grid", gap: 16 }}>
              <div>
                <label style={{ fontSize: 13, color: "#94a3b8", display: "block", marginBottom: 6 }}>App Name</label>
                <input value={appNameEdit} onChange={e => setAppNameEdit(e.target.value)} style={inputStyle} />
              </div>
              <div style={{ display: "flex", gap: 16 }}>
                <div style={{ flex: 1 }}>
                  <label style={{ fontSize: 13, color: "#94a3b8", display: "block", marginBottom: 6 }}>Primary Color</label>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <input type="color" value={colorPrimary} onChange={e => setColorPrimary(e.target.value)}
                      style={{ width: 48, height: 40, border: "none", borderRadius: 8, cursor: "pointer" }} />
                    <input value={colorPrimary} onChange={e => setColorPrimary(e.target.value)} style={{ ...inputStyle }} />
                  </div>
                </div>
                <div style={{ flex: 1 }}>
                  <label style={{ fontSize: 13, color: "#94a3b8", display: "block", marginBottom: 6 }}>Accent Color</label>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <input type="color" value={colorAccent} onChange={e => setColorAccent(e.target.value)}
                      style={{ width: 48, height: 40, border: "none", borderRadius: 8, cursor: "pointer" }} />
                    <input value={colorAccent} onChange={e => setColorAccent(e.target.value)} style={{ ...inputStyle }} />
                  </div>
                </div>
              </div>
              <div>
                <label style={{ fontSize: 13, color: "#94a3b8", display: "block", marginBottom: 6 }}>Alert before wash ends (minutes)</label>
                <input type="number" value={alertMin} onChange={e => setAlertMin(e.target.value)} style={inputStyle} min="1" max="15" />
              </div>
              <div style={{
                padding: 14, borderRadius: 10, background: "#0f172a",
              }}>
                <div style={{ fontSize: 13, color: "#94a3b8", marginBottom: 8 }}>Preview</div>
                <div style={{ display: "flex", gap: 12 }}>
                  <div style={{ width: 60, height: 36, borderRadius: 8, background: colorPrimary }}></div>
                  <div style={{ width: 60, height: 36, borderRadius: 8, background: colorAccent }}></div>
                  <div style={{
                    padding: "6px 16px", borderRadius: 8, background: colorPrimary, color: "#fff",
                    fontWeight: 700, fontSize: 13, display: "flex", alignItems: "center",
                  }}>{appNameEdit}</div>
                </div>
              </div>
              <button onClick={saveConfig} style={{
                width: "100%", padding: "14px 0", borderRadius: 12, border: "none", cursor: "pointer",
                background: config.primaryColor, color: "#fff", fontWeight: 700, fontSize: 16,
                fontFamily: "'DM Sans', sans-serif",
              }}>💾 Save Configuration</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Main App ───
export default function App() {
  const [session, setSession] = useState(null);
  const [config, setConfig] = useState(DEFAULT_CONFIG);
  const [toast, setToast] = useState(null);
  const [loaded, setLoaded] = useState(false);

  const showToast = useCallback((message, type) => {
    setToast({ message, type, key: Date.now() });
  }, []);

  useEffect(() => {
    (async () => {
      const saved = await loadData("laundry_config", null);
      if (saved) setConfig({ ...DEFAULT_CONFIG, ...saved });
      setLoaded(true);
    })();
  }, []);

  if (!loaded) return (
    <div style={{
      minHeight: "100vh", background: "#0f172a", display: "flex",
      alignItems: "center", justifyContent: "center", color: "#64748b",
      fontFamily: "'DM Sans', sans-serif",
    }}>
      <div style={{ animation: "pulse 1.5s infinite" }}>Loading LaundryHub...</div>
    </div>
  );

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Space+Mono:wght@700&display=swap');
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        @keyframes slideIn { from { transform: translateX(100px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
        @keyframes fadeUp { from { transform: translateY(20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        input:focus, button:focus { outline: none; }
        body { background: #0f172a; }
      `}</style>
      {toast && <Toast {...toast} onClose={() => setToast(null)} />}
      {!session ? (
        <LoginScreen config={config} onLogin={setSession} />
      ) : session.role === "admin" ? (
        <AdminDashboard config={config} setConfig={setConfig} onLogout={() => setSession(null)} showToast={showToast} />
      ) : (
        <UserDashboard user={session} config={config} onLogout={() => setSession(null)} showToast={showToast} />
      )}
    </>
  );
}
