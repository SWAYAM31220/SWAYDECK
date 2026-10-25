const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");
const { ACTIONS } = require("./actions");
const clip = require("./clipboard");
const monitor = require("./monitor");

const PORT = 3000;
const HOST = "127.0.0.1";
const ALLOWED_ORIGINS = [`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`];
const TOKEN_FILE = path.join(__dirname, ".swaydeck-token");

// ---- Pairing token ----
function loadToken() {
  if (fs.existsSync(TOKEN_FILE)) return fs.readFileSync(TOKEN_FILE, "utf8").trim();
  const t = crypto.randomBytes(24).toString("base64url");
  fs.writeFileSync(TOKEN_FILE, t, { mode: 0o600 });
  return t;
}
const TOKEN = loadToken();
const TOKEN_BUF = Buffer.from(TOKEN);

function tokenOk(candidate) {
  if (typeof candidate !== "string") return false;
  const a = Buffer.from(candidate);
  return a.length === TOKEN_BUF.length && crypto.timingSafeEqual(a, TOKEN_BUF);
}

// ---- Failed-auth lockout: 5 failures in 60s ----
let failTimes = [];
function lockedOut() {
  const now = Date.now();
  failTimes = failTimes.filter((t) => now - t < 60000);
  return failTimes.length >= 5;
}

// ---- Shared state ----
const phones = new Set();
let extensionSocket = null;
let latestWorkspace = null;
let refreshCounter = 0;
function broadcastClip() {
  for (const p of phones) send(p, clip.stateMessage());
}
const pendingRuns = new Map(); // agentId -> { socket, phoneId, timer }
let runCounter = 0;
const RUN_STATUSES = ["started", "already_running", "ambiguous", "error"];

// ---- HTTP ----
const app = express();
const server = http.createServer(app);
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/status", (req, res) => {
  const h = req.headers.authorization || "";
  if (!h.startsWith("Bearer ") || !tokenOk(h.slice(7))) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  res.json({
    ok: true,
    uptimeSeconds: Math.round(process.uptime()),
    phones: phones.size,
    extensionConnected: !!extensionSocket,
  });
});

// ---- WebSocket: /ws = phone, /ext = VS Code extension ----
const wss = new WebSocketServer({ noServer: true, maxPayload: 16384 });

server.on("upgrade", (req, socket, head) => {
  let pathname;
  try {
    pathname = new URL(req.url, "http://localhost").pathname;
  } catch {
    return socket.destroy();
  }
  const origin = req.headers.origin;
  let role = null;
  if (pathname === "/ws" && (!origin || ALLOWED_ORIGINS.includes(origin))) role = "phone";
  // The extension is not a browser, so it sends no Origin. Browsers always do, so web pages are refused.
  else if (pathname === "/ext" && !origin) role = "extension";

  if (!role) {
    socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.role = role;
    wss.emit("connection", ws, req);
  });
});

function send(socket, obj) {
  if (socket && socket.readyState === socket.OPEN) socket.send(JSON.stringify(obj));
}
function currentState() {
  return { type: "state", extensionConnected: !!extensionSocket, workspace: latestWorkspace };
}
function broadcastState() {
  for (const p of phones) send(p, currentState());
}

// ---- Sanitize what the extension reports (never trust, never pass through raw) ----
const PROJECT_TYPES = ["node", "python", "static", "ambiguous", "unknown", "none"];
const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : null);
const bool = (v) => v === true;

function sanitizeWorkspace(w) {
  if (!w || typeof w !== "object") return null;
  const d = w.details && typeof w.details === "object" ? w.details : {};
  return {
    open: bool(w.open),
    name: str(w.name, 200),
    path: str(w.path, 1000),
    multiRoot: bool(w.multiRoot),
    trusted: bool(w.trusted),
    projectType: PROJECT_TYPES.includes(w.projectType) ? w.projectType : "unknown",
    folders: Array.isArray(w.folders)
      ? w.folders.slice(0, 20).map((f) => ({ name: str(f && f.name, 200), path: str(f && f.path, 1000) }))
      : [],
    detected: Array.isArray(w.detected)
      ? w.detected.slice(0, 10).map((x) => ({ type: str(x && x.type, 20), evidence: str(x && x.evidence, 100) }))
      : [],
    details: {
      hasPackageJson: bool(d.hasPackageJson),
      hasDevScript: bool(d.hasDevScript),
      hasMainPy: bool(d.hasMainPy),
      hasIndexHtml: bool(d.hasIndexHtml),
    },
    activeFile: str(w.activeFile, 260),
  };
}

function handleExtensionMessage(socket, msg) {
  if (msg.type === "workspace") {
    const ws = sanitizeWorkspace(msg.workspace);
    if (!ws) return;
    latestWorkspace = ws;
    console.log(`[ext] workspace: ${ws.name || "(none open)"} -> ${ws.projectType}`);
    broadcastState();
  }
    if (msg.type === "run_result") {
    const entry = typeof msg.id === "string" ? pendingRuns.get(msg.id) : null;
    if (!entry) return;
    clearTimeout(entry.timer);
    pendingRuns.delete(msg.id);
    const out = {
      type: "run_result",
      id: entry.phoneId,
      ok: msg.ok === true,
      status: RUN_STATUSES.includes(msg.status) ? msg.status : "error",
      message: str(msg.message, 300) || "No details",
      projectType: PROJECT_TYPES.includes(msg.projectType) ? msg.projectType : "unknown",
      options: Array.isArray(msg.options) ? msg.options.slice(0, 5).map((o) => str(o, 60)).filter(Boolean) : [],
            url: typeof msg.url === "string" && /^http:\/\/(localhost|127\.0\.0\.1):\d{2,5}(\/[^\s]{0,100})?$/.test(msg.url) ? msg.url : null,
    };
    console.log(`[run] result: ${out.status}`);
    send(entry.socket, out);
    return;
  }
  // all other extension message types are ignored
}

async function handlePhoneMessage(socket, msg) {
  const id = typeof msg.id === "string" && msg.id.length <= 64 ? msg.id : null;

  if (msg.type === "ping") {
    return send(socket, { type: "pong", message: "Instant response from your PC!" });
  }

  if (msg.type === "get_stats") {
    if (!id) return send(socket, { type: "result", id, ok: false, message: "Invalid request" });
    try {
      const stats = await monitor.getStats();
      send(socket, { type: "stats", id, ...stats });
    } catch (err) {
      console.log(`[stats] failed (${err.code || err.message})`);
      send(socket, { type: "result", id, ok: false, message: "Could not read system stats" });
    }
    return;
  }

  if (msg.type === "refresh_workspace") {
    if (!extensionSocket) {
      return send(socket, { type: "result", id, ok: false, message: "VS Code extension not connected" });
    }
    send(extensionSocket, { type: "get_workspace", id: `agent-${++refreshCounter}` });
    return send(socket, { type: "result", id, ok: true, message: "Refresh requested" });
  }
    if (msg.type === "run_project") {
    const fail = (message) =>
      send(socket, { type: "run_result", id, ok: false, status: "error", message, projectType: "unknown", options: [] });
    if (!extensionSocket) return fail("VS Code is not connected. Open VS Code with the SwayDeck extension.");
    if (pendingRuns.size > 0) return fail("A run is already in progress. Please wait.");
    const agentId = `run-${++runCounter}`;
    const timer = setTimeout(() => {
      pendingRuns.delete(agentId);
      fail("VS Code did not respond in time.");
    }, 8000);
    pendingRuns.set(agentId, { socket, phoneId: id, timer });
    console.log("[run] Run Project requested");
    return send(extensionSocket, { type: "run_project", id: agentId });
  }

  if (msg.type === "clip_set" || msg.type === "clip_grab" || msg.type === "clip_clear" || msg.type === "clip_delete") {
    if (!id) return send(socket, { type: "result", id, ok: false, message: "Invalid request" });
    try {
      let message;
      if (msg.type === "clip_set") message = clip.setEnabled(msg.enabled);
      else if (msg.type === "clip_grab") message = await clip.grab();
      else if (msg.type === "clip_clear") message = clip.clear();
      else message = clip.remove(msg.itemId);
      broadcastClip();
      send(socket, { type: "result", id, ok: true, message });
    } catch (err) {
      send(socket, { type: "result", id, ok: false, message: err.userMessage || "Clipboard action failed" });
    }
    return;
  }

  if (msg.type === "action") {
    const name = typeof msg.action === "string" ? msg.action : null;
    if (!id || !name || !Object.hasOwn(ACTIONS, name)) {
      return send(socket, { type: "result", id, ok: false, message: "Unknown or invalid action" });
    }
        try {
      const def = ACTIONS[name];
      const args = def.validate ? def.validate(msg.args) : {};
      const message = await def.run(args, { getWorkspace: () => latestWorkspace });
      console.log(`[action] ${name}: ok`);
      send(socket, { type: "result", id, ok: true, message });
    } catch (err) {
      console.log(`[action] ${name}: failed (${err.userMessage || err.code || err.message})`);
      send(socket, {
        type: "result",
        id,
        ok: false,
        message: err.userMessage || `Failed: ${err.code || "error"}`,
      });
    }
    return;
  }

  send(socket, { type: "error", message: "Unknown message type" });
}

wss.on("connection", (socket) => {
  socket.authed = false;
  const authTimer = setTimeout(() => {
    if (!socket.authed) socket.close(4001, "auth timeout");
  }, 3000);

  socket.on("message", async (raw) => {
    if (socket.role === "phone" && raw.length > 4096) return socket.close(1009, "message too large");

    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return send(socket, { type: "error", message: "Invalid message" });
    }
    if (!msg || typeof msg !== "object" || typeof msg.type !== "string") {
      return send(socket, { type: "error", message: "Invalid message" });
    }

    // Before auth, the ONLY accepted message is "auth"
    if (!socket.authed) {
      if (lockedOut()) return socket.close(4002, "locked out");
      if (msg.type === "auth" && tokenOk(msg.token)) {
        socket.authed = true;
        clearTimeout(authTimer);
        if (socket.role === "phone") {
          phones.add(socket);
          console.log("[ws] phone authenticated");
          send(socket, { type: "welcome", message: "Paired and connected" });
          send(socket, currentState());
          send(socket, clip.stateMessage());
        } else {
          if (extensionSocket && extensionSocket !== socket) extensionSocket.close(4003, "replaced");
          extensionSocket = socket;
          console.log("[ext] VS Code extension authenticated");
          send(socket, { type: "welcome", message: "Extension connected" });
          broadcastState();
        }
        return;
      }
      failTimes.push(Date.now());
      console.log(`[${socket.role}] rejected unauthenticated client`);
      return socket.close(4001, "unauthorized");
    }

    if (socket.role === "extension") return handleExtensionMessage(socket, msg);
    return handlePhoneMessage(socket, msg);
  });

  socket.on("close", () => {
    clearTimeout(authTimer);
    if (socket.role === "phone") {
      phones.delete(socket);
      console.log("[ws] phone disconnected");
    } else if (socket === extensionSocket) {
      extensionSocket = null;
            for (const [key, entry] of pendingRuns) {
        clearTimeout(entry.timer);
        send(entry.socket, { type: "run_result", id: entry.phoneId, ok: false, status: "error", message: "VS Code disconnected.", projectType: "unknown", options: [] });
        pendingRuns.delete(key);
      }
      latestWorkspace = null;
      console.log("[ext] extension disconnected");
      broadcastState();
    }
  });
});

server.listen(PORT, HOST, () => {
  if (process.platform !== "win32") {
    console.warn(
      "Warning: SwayDeck PC actions are Windows-only. The agent will start, but app, volume, media, lock and sleep actions will fail on this platform."
    );
  }
  console.log(`SwayDeck running at http://${HOST}:${PORT}`);
  console.log("\nTo pair your phone, run this (keep the token private):");
  console.log(`adb shell am start -a android.intent.action.VIEW -d "http://localhost:${PORT}/#t=${TOKEN}"\n`);
});