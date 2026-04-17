export async function GET(request) {
  const dbUrl = process.env.NEXT_PUBLIC_FB_DB_URL;
  if (!dbUrl) return Response.json({ error: "No DB URL" }, { status: 500 });

  try {
    // Read machine state
    const res = await fetch(`${dbUrl}/machine.json`);
    const machine = await res.json();

    if (!machine || !machine.running) {
      return Response.json({ status: "idle", action: "none" });
    }

    const { startTime, durationMs, userName, cycleName } = machine;
    const now = Date.now();
    const endTime = startTime + durationMs;

    if (now >= endTime) {
      // Wash expired — stop it
      const stopData = {
        running: false,
        lastUser: userName || "Unknown",
        lastCycle: cycleName || "Unknown",
        finishedAt: now,
        stoppedBy: "cloud_timer"
      };

      await fetch(`${dbUrl}/machine.json`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(stopData),
      });

      // Log to history
      const historyEntry = {
        id: String(now),
        userId: machine.userId || "",
        userName: userName || "Unknown",
        cycleName: cycleName || "Unknown",
        startTime: startTime,
        finishedAt: now,
        durationMs: durationMs,
        stoppedBy: "cloud_timer"
      };

      await fetch(`${dbUrl}/history/${now}.json`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(historyEntry),
      });

      return Response.json({ status: "stopped", action: "wash_expired", user: userName, cycle: cycleName });
    }

    const remainMin = Math.ceil((endTime - now) / 60000);
    return Response.json({ status: "running", remainMin, user: userName, cycle: cycleName });

  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
