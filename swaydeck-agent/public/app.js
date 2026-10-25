/* =========================================================
   SwayDeck — phone deck UI logic
   Behaviour is unchanged from the previous single-file build.
   The wiring is now null-safe, delegated and step-guarded so a
   single missing element can never take the other controls down
   with it (which is how a deck ends up "Connected" but dead).
   ========================================================= */

/* ---------- Tiny DOM helpers ----------
   $()   lookup (may return null)
   on()  attach a listener only if the id exists
   sel() attach a listener to every match of a selector
   txt() write textContent only if the id exists                */
const $ = (id) => document.getElementById(id);
const on = (id, ev, fn, opts) => {
  const el = $(id);
  if (el) el.addEventListener(ev, fn, opts);
  return el;
};
const sel = (selector, ev, fn, opts) => {
  const els = document.querySelectorAll(selector);
  els.forEach((el) => el.addEventListener(ev, fn, opts));
  return els.length;
};
const txt = (id, value) => {
  const el = $(id);
  if (el) el.textContent = value;
  return el;
};
const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };

// One init step runs in isolation: a failure is logged and the
// remaining steps still run.
function step(name, fn) {
  try {
    fn();
  } catch (err) {
    console.error("[swaydeck] init step failed:", name, err);
  }
}

// =========================================================
// Pairing: the token arrives once in the URL hash, is stored,
// then the hash is removed.
// =========================================================
const KEY = "swaydeck_token";
const hashMatch = location.hash.match(/^#t=([\w-]+)$/);
if (hashMatch) lsSet(KEY, hashMatch[1]);
const token = lsGet(KEY);

// =========================================================
// Live state (declared before anything can read it)
// =========================================================
let socket = null, delay = 500, nextId = 1;
let linkOpen = false;     // phone <-> agent socket is open
let canRun = false;       // extension connected + workspace open
let toastTimer = null;
let audioCtx = null;
let clipEnabled = false;

let hapticOn = lsGet("swaydeck_haptic") !== "0";
let wantAwake = lsGet("swaydeck_awake") === "1";
let wakeLock = null;

let sleepArmed = false, sleepTimer = null, sleepTickTimer = null;

const STATS_POLL_MS = 2000;
let statsTimer = null, statsWaiting = false, statsReqId = null, statsKnown = false, statsAt = 0;

const PING_MS = 5000;
let pingTimer = null, pingSentAt = 0, pingManual = false, lastLatencyMs = null;

// =========================================================
// System Monitor: stats are polled only while the System screen is active
// =========================================================
function systemActive() {
  const el = $("screen-system");
  return !!(el && el.classList.contains("active"));
}
function statsColor(p) {
  // These resolve to the tokens declared once in style.css :root.
  if (p === null) return "var(--dim)";
  if (p < 70) return "var(--ok)";
  if (p <= 90) return "var(--warn)";
  return "var(--crit)";
}
function levelClass(p) {
  if (p === null) return "";
  if (p < 70) return "ok";
  if (p <= 90) return "warn";
  return "crit";
}
function cpuLevel(p) {
  if (p === null) return "--";
  if (p < 70) return "Normal";
  if (p <= 90) return "High";
  return "Critical";
}
function ramLevel(p) {
  if (p === null) return "--";
  if (p < 70) return "Stable";
  if (p <= 90) return "High";
  return "Critical";
}
function fmtUptime(sec) {
  if (!Number.isFinite(sec)) return "--";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  // Display only: at most the two most significant units, so the
  // value can never wrap on a short landscape screen.
  if (d > 0) return d + "d " + h + "h";
  if (h > 0) return h + "h " + m + "m";
  if (m > 0) return m + "m " + s + "s";
  return s + "s";
}
const pct = (v) => (v === null ? "--" : v + "%");

function setBar(id, value) {
  const el = $(id);
  if (!el) return;
  el.style.width = (value === null ? 0 : Math.max(0, Math.min(100, value))) + "%";
  el.style.background = statsColor(value);
}
function setGauge(id, value) {
  const el = $(id);
  if (!el) return;
  const v = value === null ? 0 : Math.max(0, Math.min(100, value));
  // The gauge arc is a 36x36 viewBox path whose total length is 100 units
  el.style.strokeDasharray = v.toFixed(2) + ", 100";
  el.style.stroke = statsColor(value);
}
function setBadge(id, text, value) {
  const el = $(id);
  if (!el) return;
  el.textContent = text;
  el.className = "tbadge " + levelClass(value);
}

function renderStatsAge() {
  if (!statsKnown) return;
  const s = Math.round((Date.now() - statsAt) / 1000);
  txt("statsAge", s < 3 ? "Updated just now" : "Updated " + s + "s ago");
}

function renderStats(s) {
  statsKnown = true;
  statsAt = Date.now();
  const body = $("statsBody");
  if (body) { body.classList.remove("offline"); body.classList.remove("loading"); }

  txt("cpuVal", pct(s.cpuPercent));
  setBar("cpuBar", s.cpuPercent);
  setGauge("cpuGauge", s.cpuPercent);
  setBadge("cpuBadge", cpuLevel(s.cpuPercent), s.cpuPercent);

  txt("ramVal", pct(s.ramPercent));
  setBar("ramBar", s.ramPercent);
  setBadge("ramBadge", ramLevel(s.ramPercent), s.ramPercent);
  txt(
    "ramMeta",
    (s.ramUsedGB === null ? "--" : s.ramUsedGB.toFixed(1)) + " / " +
      (s.ramTotalGB === null ? "--" : s.ramTotalGB.toFixed(1)) + " GB"
  );

  txt("uptimeVal", fmtUptime(s.uptimeSeconds));
  txt("tempVal", s.tempC === null ? "N/A" : s.tempC + "\u00b0C");
  txt("tempNote", s.tempC === null ? "No temperature sensor exposed" : "");

  txt(
    "sub-system",
    s.cpuPercent === null || s.ramPercent === null
      ? "CPU, RAM, uptime"
      : "CPU " + pct(s.cpuPercent) + " \u00b7 RAM " + pct(s.ramPercent)
  );
  setBadge("hsysBadge", cpuLevel(s.cpuPercent), s.cpuPercent);

  renderStatsAge();
}

function renderStatsState() {
  const body = $("statsBody");
  if (!linkOpen) {
    if (body) { body.classList.add("offline"); body.classList.remove("loading"); }
    txt("statsAge", "PC disconnected");
    return;
  }
  if (body) body.classList.remove("offline");
  if (statsKnown) {
    if (body) body.classList.remove("loading");
    renderStatsAge();
  } else {
    // Skeleton placeholders until the first reading arrives.
    if (body) body.classList.add("loading");
    txt("statsAge", "Waiting for stats...");
  }
}

function statsTick() {
  renderStatsAge();
  if (statsWaiting || !linkOpen) return;
  statsWaiting = true;
  statsReqId = String(nextId++);
  sendMsg({ type: "get_stats", id: statsReqId });
}
function statsNow() {
  if (!linkOpen) return;
  statsWaiting = false;
  statsTick();
}
function startStats() {
  if (statsTimer) return;
  statsTick();
  statsTimer = setInterval(statsTick, STATS_POLL_MS);
}
function stopStats() {
  if (statsTimer) clearInterval(statsTimer);
  statsTimer = null;
}
function syncStats() {
  if (systemActive() && linkOpen) startStats();
  else stopStats();
  renderStatsState();
}
function statsReply(data) {
  // A failed stats request also comes back as a "result" carrying our id,
  // so we must clear the in-flight flag for it too, not only for "stats".
  if (data.type !== "stats" && data.id !== statsReqId) return;
  statsWaiting = false;
  statsReqId = null;
  if (data.type === "stats") renderStats(data);
}
function statsDisconnected() {
  linkOpen = false;
  statsWaiting = false;
  statsReqId = null;
  stopStats();
  renderStatsState();
  renderLink();
}

// =========================================================
// Navigation: the rail switches screens (Android back returns Home)
// =========================================================
const SCREENS = ["home", "dev", "pc", "desk", "music", "system"];
function render(s) {
  if (!SCREENS.includes(s)) s = "home";
  document.querySelectorAll(".screen").forEach((el) => el.classList.toggle("active", el.id === "screen-" + s));
  document.querySelectorAll(".railbtn[data-screen]").forEach((b) => b.classList.toggle("active", b.dataset.screen === s));
  window.scrollTo(0, 0);
  syncStats(); // polling follows the System screen in and out of view
}
function openScreen(s) {
  history.pushState({ screen: s }, "");
  render(s);
}
function goBack() {
  if (history.state && history.state.screen && history.state.screen !== "home") history.back();
  else render("home");
}

// =========================================================
// Clock (header + Smart Desk)
// =========================================================
function renderClock() {
  const now = new Date();
  const hm = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  txt("hdrClock", hm);

  const clock = $("clock");
  if (clock) {
    const sec = String(now.getSeconds()).padStart(2, "0");
    clock.textContent = hm + " ";
    const small = document.createElement("small");
    small.textContent = sec;
    clock.append(small);
  }
  txt("date", now.toLocaleDateString([], { weekday: "long", day: "numeric", month: "short" }));
}

// =========================================================
// Pomodoro — configurable focus / short break / long break.
// The countdown is driven by an absolute end timestamp, never by
// subtracting a tick, so it stays exact across reloads, tab
// switches and reconnects.
// =========================================================
const POMO_KEY = "swaydeck_pomo";
const POMO_CFG_KEY = "swaydeck_pomo_cfg";

const PHASES = { focus: "Focus", short: "Short break", long: "Long break" };
const PHASE_COLOR = { focus: "var(--ok)", short: "var(--warn)", long: "var(--primary)" };
const PHASE_DEF = { focus: 25, short: 5, long: 15, sessions: 4 };
const PHASE_LIMITS = { focus: [5, 90], short: [1, 30], long: [5, 60], sessions: [2, 8] };
const PHASE_STEP = { focus: 5, short: 1, long: 5, sessions: 1 };
const PRESETS = {
  classic: { focus: 25, short: 5, long: 15 },
  deep: { focus: 50, short: 10, long: 20 },
};

// ?pomo=<seconds> shrinks the focus phase so the whole cycle can be watched quickly.
const testSecs = Number(new URLSearchParams(location.search).get("pomo"));
const TEST_MODE = Number.isInteger(testSecs) && testSecs >= 1 && testSecs <= 3600;

function loadCfg() {
  let raw = null;
  try { raw = JSON.parse(lsGet(POMO_CFG_KEY)); } catch {}
  const src = raw && typeof raw === "object" ? raw : {};
  const out = {};
  Object.keys(PHASE_DEF).forEach((k) => {
    const [lo, hi] = PHASE_LIMITS[k];
    let v = Number(src[k]);
    if (!Number.isFinite(v)) v = PHASE_DEF[k];
    out[k] = Math.max(lo, Math.min(hi, Math.round(v)));
  });
  out.auto = src.auto === true;      // default off
  out.sound = src.sound !== false;   // default on
  out.vibrate = src.vibrate !== false; // default on
  return out;
}
let cfg = loadCfg();
const saveCfg = () => lsSet(POMO_CFG_KEY, JSON.stringify(cfg));

function phaseMs(phase) {
  if (phase === "focus" && TEST_MODE) return testSecs * 1000;
  return cfg[phase] * 60 * 1000;
}

function dayKey() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

const STATUSES = ["idle", "running", "paused"];
function loadState() {
  // Old builds stored {state, endsAt} — none of those keys match, so an
  // outdated value safely degrades to a fresh idle focus session.
  const st = { phase: "focus", status: "idle", endAt: null, remainingMs: null, sessionIndex: 1, completedToday: 0, dayKey: dayKey() };
  let raw = null;
  try { raw = JSON.parse(lsGet(POMO_KEY)); } catch {}
  if (raw && typeof raw === "object") {
    if (PHASES[raw.phase]) st.phase = raw.phase;
    if (STATUSES.indexOf(raw.status) !== -1) st.status = raw.status;
    if (Number.isFinite(raw.endAt)) st.endAt = raw.endAt;
    if (Number.isFinite(raw.remainingMs) && raw.remainingMs > 0) st.remainingMs = raw.remainingMs;
    if (Number.isFinite(raw.sessionIndex)) st.sessionIndex = Math.round(raw.sessionIndex);
    if (Number.isFinite(raw.completedToday)) st.completedToday = Math.max(0, Math.round(raw.completedToday));
    if (typeof raw.dayKey === "string") st.dayKey = raw.dayKey;
  }
  if (st.dayKey !== dayKey()) { st.completedToday = 0; st.dayKey = dayKey(); }
  st.sessionIndex = Math.max(1, Math.min(cfg.sessions, st.sessionIndex || 1));
  if (st.status === "running" && !Number.isFinite(st.endAt)) st.status = "idle";
  if (st.status === "paused" && !Number.isFinite(st.remainingMs)) st.status = "idle";
  if (st.status === "idle") { st.endAt = null; st.remainingMs = phaseMs(st.phase); }
  return st;
}
let pomo = loadState();
let phaseDone = false; // a phase has finished and its overlay is up (not persisted)

const saveState = () => lsSet(POMO_KEY, JSON.stringify({
  phase: pomo.phase,
  status: pomo.status,
  endAt: Number.isFinite(pomo.endAt) ? pomo.endAt : null,
  remainingMs: Number.isFinite(pomo.remainingMs) ? pomo.remainingMs : null,
  sessionIndex: pomo.sessionIndex,
  completedToday: pomo.completedToday,
  dayKey: pomo.dayKey,
}));

function remainingMs() {
  if (pomo.status === "running" && Number.isFinite(pomo.endAt)) return Math.max(0, pomo.endAt - Date.now());
  if (pomo.status === "paused" && Number.isFinite(pomo.remainingMs)) return Math.max(0, pomo.remainingMs);
  return phaseMs(pomo.phase);
}
const fmt = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
};

// Audio is unlocked by the Start tap (browsers require a user gesture)
function unlockAudio() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
  } catch {}
}
function beep() {
  if (!audioCtx) return;
  const t = audioCtx.currentTime;
  [0, 0.28, 0.56].forEach((off) => {
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = "sine";
    o.frequency.value = 660;
    g.gain.setValueAtTime(0.0001, t + off);
    g.gain.exponentialRampToValueAtTime(0.22, t + off + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + off + 0.2);
    o.connect(g).connect(audioCtx.destination);
    o.start(t + off);
    o.stop(t + off + 0.24);
  });
}
function playAlerts() {
  if (cfg.sound) beep();
  if (cfg.vibrate) haptic([220, 120, 220, 120, 320]);
}

function showOverlay(finished, next, silent) {
  txt("overlayTitle", finished === "focus" ? "Focus complete" : "Break over");
  txt(
    "overlaySub",
    PHASES[next] + " \u00b7 " + fmt(phaseMs(next)) +
      (silent ? " \u00b7 this finished while the page was closed" : "")
  );
  txt("overlayOk", "Start " + PHASES[next]);
  phaseDone = true;
  const ov = $("overlay");
  if (ov) ov.hidden = false;
  renderPomo();
}
function hideOverlay() {
  const ov = $("overlay");
  if (ov) ov.hidden = true;
  phaseDone = false;
}

// Begin a phase. auto=true means "run it now", otherwise it waits for Start.
function startPhase(phase, auto) {
  pomo.phase = phase;
  const ms = phaseMs(phase);
  pomo.status = auto ? "running" : "idle";
  pomo.endAt = auto ? Date.now() + ms : null;
  pomo.remainingMs = auto ? null : ms;
  saveState();
  renderPomo();
}

// Long break replaces the short one once "sessions" focus rounds are done.
function nextPhaseAfter(cur) {
  if (cur !== "focus") return "focus";
  return pomo.sessionIndex >= cfg.sessions ? "long" : "short";
}
function enterNext(cur, auto) {
  const next = nextPhaseAfter(cur);
  if (next === "focus") {
    pomo.sessionIndex = cur === "long" ? 1 : Math.min(cfg.sessions, pomo.sessionIndex + 1);
  }
  startPhase(next, auto);
  return next;
}

function finishPhase(silent) {
  if (pomo.phase === "focus") pomo.completedToday += 1;
  const finished = pomo.phase;
  hideOverlay();
  const auto = !silent && cfg.auto;
  const next = enterNext(finished, auto);
  if (silent) {
    // Replayed once after a reload: no sound, no vibration, no repeat.
    showOverlay(finished, next, true);
    return;
  }
  playAlerts();
  if (auto) showFeedback(PHASES[finished] + " done \u2014 " + PHASES[next] + " started", true);
  else showOverlay(finished, next, false);
}

function checkPhaseDone() {
  if (pomo.status !== "running" || !Number.isFinite(pomo.endAt)) return;
  if (Date.now() < pomo.endAt) return;
  finishPhase(false);
}

function pomoMain() {
  unlockAudio();
  hideOverlay();
  if (pomo.status === "running") {
    pomo.remainingMs = Math.max(1000, remainingMs());
    pomo.status = "paused";
    pomo.endAt = null;
  } else if (pomo.status === "paused") {
    pomo.endAt = Date.now() + Math.max(1000, pomo.remainingMs);
    pomo.status = "running";
    pomo.remainingMs = null;
  } else {
    pomo.endAt = Date.now() + phaseMs(pomo.phase);
    pomo.status = "running";
    pomo.remainingMs = null;
  }
  saveState();
  renderPomo();
}
function pomoReset() {
  hideOverlay();
  pomo.status = "idle";
  pomo.endAt = null;
  pomo.remainingMs = phaseMs(pomo.phase);
  saveState();
  renderPomo();
}
// Skip jumps to the next phase without counting a focus session.
function pomoSkip() {
  hideOverlay();
  enterNext(pomo.phase, false);
}

// The ring is driven by the real remaining fraction of the current phase
const RING_R = 52;
const RING_C = 2 * Math.PI * RING_R;

function renderPomo() {
  const phase = pomo.phase;
  const rem = remainingMs();
  const total = phaseMs(phase);
  const frac = total > 0 ? Math.max(0, Math.min(1, rem / total)) : 0;

  const wrap = $("pomowrap");
  if (wrap) wrap.className = "pomowrap p-" + phase + (pomo.status === "paused" ? " paused" : "");

  txt("pomolabel", PHASES[phase] + (TEST_MODE && phase === "focus" ? " (test)" : ""));
  const t = $("pomotime");
  if (t) t.textContent = fmt(rem);

  const ring = $("pomoRing");
  if (ring) {
    ring.style.strokeDasharray = RING_C.toFixed(2);
    ring.style.strokeDashoffset = (RING_C * (1 - frac)).toFixed(2);
  }
  const bar = $("hdeskBar");
  if (bar) {
    bar.style.width = (frac * 100).toFixed(1) + "%";
    bar.style.background = PHASE_COLOR[phase];
  }

  txt(
    "pomoMain",
    phaseDone ? "Start " + PHASES[phase]
      : pomo.status === "running" ? "Pause \u00b7 " + fmt(rem)
      : pomo.status === "paused" ? "Resume \u00b7 " + fmt(rem)
      : "Start \u00b7 " + fmt(rem)
  );
  const pristine = pomo.status === "idle" && !phaseDone && rem >= total;
  const reset = $("pomoReset");
  if (reset) reset.disabled = pristine;
  const skip = $("pomoSkip");
  if (skip) skip.disabled = pristine;

  txt("pomoSession", "Session " + Math.max(1, Math.min(cfg.sessions, pomo.sessionIndex)) + "/" + cfg.sessions);
  txt("pomoToday", "Today: " + pomo.completedToday + (pomo.completedToday === 1 ? " session" : " sessions"));

  const state = phaseDone ? "done" : pomo.status;
  document.querySelectorAll(".pill").forEach((p) => p.classList.toggle("on", p.dataset.state === state));

  txt(
    "hdeskBadge",
    phaseDone ? "Done"
      : pomo.status === "paused" ? "Paused"
      : pomo.status === "running" ? (phase === "focus" ? "Focus" : "Break")
      : "Idle"
  );
  txt(
    "sub-desk",
    phaseDone ? "Ready for " + PHASES[phase]
      : pomo.status === "paused" ? "Paused \u00b7 " + fmt(rem)
      : PHASES[phase] + " \u00b7 " + fmt(rem)
  );

  document.title = pomo.status === "running" ? fmt(rem) + " \u00b7 SwayDeck" : "SwayDeck";
}

// =========================================================
// Pomodoro settings (presets, steppers, toggles)
// =========================================================
function activePreset() {
  const keys = Object.keys(PRESETS);
  for (let i = 0; i < keys.length; i++) {
    const p = PRESETS[keys[i]];
    if (p.focus === cfg.focus && p.short === cfg.short && p.long === cfg.long) return keys[i];
  }
  return "custom";
}
function renderCfg() {
  txt("valFocus", cfg.focus + "m");
  txt("valShort", cfg.short + "m");
  txt("valLong", cfg.long + "m");
  txt("valSessions", String(cfg.sessions));
  txt("pomoAuto", "Auto-start: " + (cfg.auto ? "on" : "off"));
  txt("pomoSound", "Sound: " + (cfg.sound ? "on" : "off"));
  txt("pomoVibrate", "Vibrate: " + (cfg.vibrate ? "on" : "off"));
  const act = activePreset();
  document.querySelectorAll(".chipbtn[data-preset]").forEach((b) => b.classList.toggle("on", b.dataset.preset === act));
}
// An idle phase picks up a new length right away; a running one is left alone.
function syncIdleLength() {
  if (pomo.status !== "idle" || phaseDone) return;
  pomo.remainingMs = phaseMs(pomo.phase);
  saveState();
}
function bump(field, dir) {
  if (!PHASE_LIMITS[field]) return;
  const lo = PHASE_LIMITS[field][0], hi = PHASE_LIMITS[field][1];
  const next = Math.max(lo, Math.min(hi, cfg[field] + dir * PHASE_STEP[field]));
  if (next === cfg[field]) return;
  cfg[field] = next;
  saveCfg();
  if (field === "sessions") pomo.sessionIndex = Math.max(1, Math.min(cfg.sessions, pomo.sessionIndex));
  syncIdleLength();
  renderCfg();
  renderPomo();
}

// =========================================================
// Full-screen flip clock
// =========================================================
const FLIP_KEY = "swaydeck_flip";
const REDUCED_MOTION = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

function loadFlipCfg() {
  let raw = null;
  try { raw = JSON.parse(lsGet(FLIP_KEY)); } catch {}
  const src = raw && typeof raw === "object" ? raw : {};
  return { h12: src.h12 === true, secs: src.secs === true };
}
let flipCfg = loadFlipCfg();
const saveFlipCfg = () => lsSet(FLIP_KEY, JSON.stringify(flipCfg));

let flipOpen = false, flipTimer = null, flipCtlTimer = null, flipMinute = -1, burnIdx = -1;
let flipWakeForced = false;

function setDigit(id, value, instant) {
  const card = $(id);
  if (!card) return;
  const top = card.querySelector(".ftop span");
  const bot = card.querySelector(".fbot span");
  const tf = card.querySelector(".ftop-flap span");
  const bf = card.querySelector(".fbot-flap span");
  if (!top || !bot) return;

  if (instant || !tf || !bf) {
    card.querySelectorAll(".fhalf span, .fflap span").forEach((s) => { s.textContent = value; });
    card.classList.remove("flipping", "fading");
    return;
  }

  const cur = top.textContent;
  if (cur === value) return;

  if (REDUCED_MOTION) {
    bot.textContent = value;
    top.textContent = value;
    card.classList.remove("fading");
    void card.offsetWidth;
    card.classList.add("fading");
    return;
  }

  top.textContent = value;  // revealed as the old top flap falls away
  tf.textContent = cur;     // outgoing flap keeps the old value
  bf.textContent = value;   // incoming flap carries the new value
  card.classList.remove("flipping");
  void card.offsetWidth;    // restart the animation
  card.classList.add("flipping");

  const seq = (card._seq = (card._seq || 0) + 1);
  setTimeout(() => {
    if (card._seq === seq) bot.textContent = value;
  }, 560);
}

const BURN_OFFS = [[3, 3], [-3, 3], [3, -3]];
function burnShift() {
  const face = $("flipFace");
  if (!face) return;
  burnIdx += 1;
  const off = BURN_OFFS[burnIdx % BURN_OFFS.length];
  face.style.transform = "translate(" + off[0] + "px," + off[1] + "px)";
}

function renderFlip(instant) {
  const now = new Date();
  const h24 = now.getHours();
  const h = flipCfg.h12 ? ((h24 % 12) || 12) : h24;
  const hs = String(h).padStart(2, "0");
  const ms = String(now.getMinutes()).padStart(2, "0");
  const sss = String(now.getSeconds()).padStart(2, "0");

  setDigit("fh1", hs[0], instant);
  setDigit("fh2", hs[1], instant);
  setDigit("fm1", ms[0], instant);
  setDigit("fm2", ms[1], instant);

  const clock = $("flipClock");
  const secGroup = $("flipSecGroup");
  const secSep = $("flipSepSec");
  if (clock) clock.classList.toggle("withsecs", flipCfg.secs);
  if (secGroup) secGroup.hidden = !flipCfg.secs;
  if (secSep) secSep.hidden = !flipCfg.secs;
  if (flipCfg.secs) {
    setDigit("fs1", sss[0], instant);
    setDigit("fs2", sss[1], instant);
  }

  const ampm = $("flipAmPm");
  if (ampm) {
    ampm.hidden = !flipCfg.h12;
    ampm.textContent = h24 < 12 ? "AM" : "PM";
  }

  txt("flipDate", now.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" }));

  // OLED burn-in protection: nudge the whole face once per minute.
  const m = now.getMinutes();
  if (flipMinute >= 0 && m !== flipMinute) burnShift();
  flipMinute = m;
}

function renderFlipCtl() {
  txt("flipFmt", flipCfg.h12 ? "12h" : "24h");
  txt("flipSecs", "Secs: " + (flipCfg.secs ? "on" : "off"));
}
function showFlipCtl() {
  const ctl = $("flipCtl");
  if (ctl) ctl.classList.remove("hide");
  clearTimeout(flipCtlTimer);
  flipCtlTimer = setTimeout(() => { const c = $("flipCtl"); if (c) c.classList.add("hide"); }, 3000);
}
function startFlipTicker() {
  if (flipTimer) return;
  flipTimer = setInterval(() => {
    try { renderFlip(false); } catch (err) { console.error("[swaydeck] flip tick failed:", err); }
  }, 200);
}
function stopFlipTicker() {
  if (flipTimer) clearInterval(flipTimer);
  flipTimer = null;
}

function enterFullscreen() {
  try {
    if (document.documentElement.requestFullscreen) {
      const p = document.documentElement.requestFullscreen();
      if (p && p.catch) p.catch(() => {});
    }
  } catch {}
  // The landscape lock is best-effort: it needs fullscreen first, and many
  // browsers do not implement it at all, so it must never block the toggle.
  try {
    if (screen.orientation && screen.orientation.lock) {
      const p = screen.orientation.lock("landscape");
      if (p && p.catch) p.catch(() => {});
    }
  } catch {}
}
function exitFullscreen() {
  try {
    if (document.fullscreenElement && document.exitFullscreen) {
      const p = document.exitFullscreen();
      if (p && p.catch) p.catch(() => {});
    }
  } catch {}
}
// An app launched from the home-screen icon is already fullscreen, so the
// in-page fallback button is pointless there.
function isStandaloneApp() {
  try {
    return (
      window.matchMedia("(display-mode: fullscreen)").matches ||
      window.matchMedia("(display-mode: standalone)").matches
    );
  } catch {
    return false;
  }
}
// Both fullscreen controls mirror the browser's real state.
function renderFullscreen() {
  const isFs = !!document.fullscreenElement;
  document.body.classList.toggle("fs-on", isFs);
  const label = isFs ? "Exit fullscreen" : "Fullscreen";
  const btn = $("fsBtn");
  if (btn) {
    btn.title = label;
    btn.setAttribute("aria-label", label);
    btn.setAttribute("aria-pressed", isFs ? "true" : "false");
  }
  const setBtn = $("fsSet");
  if (setBtn) {
    setBtn.textContent = label;
    setBtn.setAttribute("aria-pressed", isFs ? "true" : "false");
  }
}
function toggleFullscreen() {
  if (document.fullscreenElement) exitFullscreen();
  else enterFullscreen();
}
// The clock borrows the wake lock and hands the previous state back on close.
async function flipWakeOn() {
  if (!("wakeLock" in navigator) || document.visibilityState !== "visible" || wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    flipWakeForced = true;
    wakeLock.addEventListener("release", () => { wakeLock = null; });
  } catch {}
}
async function flipWakeOff() {
  if (flipWakeForced && wakeLock) {
    try { await wakeLock.release(); } catch {}
    wakeLock = null;
  }
  flipWakeForced = false;
  if (wantAwake) applyWake();
}

function openFlip() {
  const el = $("flip");
  if (!el || !el.hidden) return;
  flipOpen = true;
  flipMinute = -1;
  burnIdx = -1;
  const face = $("flipFace");
  if (face) face.style.transform = "translate(0px,0px)";
  el.hidden = false;
  renderFlip(true);
  renderFlipCtl();
  showFlipCtl();
  enterFullscreen();
  flipWakeOn();
  if (!(history.state && history.state.flip)) history.pushState({ flip: true }, "");
  startFlipTicker();
}
function closeFlip() {
  const el = $("flip");
  if (!el || el.hidden) return;
  el.hidden = true;
  flipOpen = false;
  stopFlipTicker();
  clearTimeout(flipCtlTimer);
  exitFullscreen();
  flipWakeOff();
  renderPomo();
}
function requestCloseFlip() {
  if (history.state && history.state.flip) history.back();
  else closeFlip();
}

// =========================================================
// Haptics (real, remembered; hidden when unsupported)
// =========================================================
function haptic(pattern) {
  if (!hapticOn || !navigator.vibrate) return;
  try { navigator.vibrate(pattern); } catch {}
}
function renderHaptic() {
  txt("haptic", "Haptic: " + (hapticOn ? "on" : "off"));
}

// =========================================================
// Keep screen awake (optional, remembered)
// =========================================================
async function applyWake() {
  try {
    if (wantAwake && "wakeLock" in navigator && document.visibilityState === "visible" && !wakeLock) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    } else if (!wantAwake && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {}
}
function renderAwake() {
  txt("awake", "Screen awake: " + (wantAwake ? "on" : "off"));
}

// =========================================================
// PC connection (WebSocket, status, actions)
// =========================================================
const extEl = $("ext"), projEl = $("proj");
const runBtn = $("run"), runInfo = $("runinfo"), openProj = $("openproj");

function setStatus(text, cls, hint) {
  document.querySelectorAll(".statusText").forEach((e) => { e.textContent = text; e.className = "statusText " + (cls || ""); });
  document.querySelectorAll(".dot").forEach((d) => { d.className = "dot " + (cls || ""); });
  txt("statusHint", hint || "");
}

// Rebuilt from the live DOM each time so it always matches the current markup
function connButtons() {
  return [
    ...document.querySelectorAll(".act"),
    ...document.querySelectorAll(".needconn"),
    $("ping"), $("refresh"), $("refreshStats"),
  ].filter(Boolean);
}
function setButtons(enabled) {
  connButtons().forEach((b) => { b.disabled = !enabled; });
}

function showFeedback(text, ok) {
  const t = $("toast");
  if (!t) return;
  t.textContent = text;
  t.className = "show " + (ok ? "ok" : "fail");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ""; }, 2500);
}

function renderLink() {
  const b = $("hpcBadge");
  if (b) {
    b.textContent = linkOpen ? "Online" : "Offline";
    b.className = "tbadge " + (linkOpen ? "ok" : "crit");
  }
  renderLatency();
}

function renderState(s) {
  canRun = !!(s.extensionConnected && s.workspace && s.workspace.open);
  if (runBtn) runBtn.disabled = !canRun;
  if (openProj) openProj.disabled = !canRun;

  if (extEl) {
    extEl.textContent = s.extensionConnected ? "VS Code: connected" : "VS Code: not connected";
    extEl.className = "extline " + (s.extensionConnected ? "on" : "off");
  }
  const hdrExt = $("hdrExt");
  if (hdrExt) {
    hdrExt.textContent = s.extensionConnected ? "VS Code: connected" : "VS Code: not connected";
    hdrExt.className = "chip " + (s.extensionConnected ? "on" : "off");
  }

  const w = s.workspace;
  const open = !!(s.extensionConnected && w && w.open);

  const projChip = $("hdrProj");
  if (projChip) {
    if (open) {
      projChip.hidden = false;
      projChip.textContent = (w.name || "Project") + " \u00b7 " + w.projectType;
    } else {
      projChip.hidden = true;
      projChip.textContent = "";
    }
  }

  // Home tile
  txt("sub-dev", !s.extensionConnected ? "VS Code offline" : open ? (w.name || "Project open") : "No project open");
  txt("hprojBadge", open ? w.projectType : "None");
  const dot = $("hprojDot");
  if (dot) dot.className = "extdot " + (s.extensionConnected ? "on" : "off");
  txt("openprojSub", open ? (w.name || "Project open") : "No project open");

  // Project screen
  const typeBadge = $("projTypeBadge"), trustBadge = $("projTrustBadge"), fileEl = $("projFile");
  const subEl = $("projSub"), detEl = $("projDetected");

  // The "Detected" list is built from the workspace details only: a tick for
  // a file that is really there, a dash for one that is not. Nothing is
  // invented and no row is shown without matching data.
  const setDetected = (rows) => {
    if (!detEl) return;
    detEl.textContent = "";
    rows.forEach((r) => {
      const row = document.createElement("div");
      row.className = "detrow " + (r.found ? "ok" : "miss");
      const mark = document.createElement("span");
      mark.className = "detmark";
      mark.textContent = r.found ? "" : "\u2013";
      const label = document.createElement("span");
      label.className = "detlabel";
      label.textContent = r.label;
      row.append(mark, label);
      detEl.append(row);
    });
  };

  if (!open) {
    if (projEl) projEl.textContent = s.extensionConnected && w ? "No project open in VS Code" : "";
    if (subEl) subEl.textContent = "";
    if (typeBadge) { typeBadge.textContent = "--"; typeBadge.className = "tbadge"; }
    if (trustBadge) { trustBadge.textContent = "--"; trustBadge.className = "tbadge"; }
    if (fileEl) fileEl.textContent = "";
    setDetected([]);
    return;
  }

  // Title is the workspace name; the VS Code connection is the chip on the
  // right and the project type / dev-script hint reads as a subtitle.
  if (projEl) projEl.textContent = w.name || "(unnamed)";
  if (subEl) {
    let sub = w.projectType;
    if (w.projectType === "ambiguous") sub += " (" + w.detected.map((d) => d.type).join(" + ") + ")";
    if (w.projectType === "node") sub += w.details.hasDevScript ? " \u00b7 dev script found" : " \u00b7 no dev script";
    subEl.textContent = sub;
  }

  if (typeBadge) { typeBadge.textContent = w.projectType; typeBadge.className = "tbadge"; }
  if (trustBadge) {
    trustBadge.textContent = w.trusted ? "TRUSTED" : "UNTRUSTED";
    trustBadge.className = "tbadge " + (w.trusted ? "ok" : "warn");
  }

  const det = w.details || {};
  const detRows = [
    { label: "package.json", found: !!det.hasPackageJson },
    { label: "dev script", found: !!det.hasDevScript },
    { label: "main.py", found: !!det.hasMainPy },
    { label: "index.html", found: !!det.hasIndexHtml },
  ];
  // Only a multi-root workspace gets a folder tally.
  if (w.multiRoot && w.folders) detRows.push({ label: w.folders.length + (w.folders.length === 1 ? " folder" : " folders"), found: true });
  setDetected(detRows);

  const meta = [];
  if (w.activeFile) meta.push("File: " + w.activeFile);
  if (w.multiRoot) meta.push("Folders: " + w.folders.length);
  else if (w.folders && w.folders.length) meta.push("Folder: " + (w.folders[0].name || "(unnamed)"));
  if (fileEl) fileEl.textContent = meta.join("  \u00b7  ");
}

function renderRun(r) {
  if (runInfo) {
    runInfo.textContent = r.message || "";
    runInfo.className = r.status === "started" ? "ok" : r.status === "error" ? "fail" : "warn";
  }

  const opts = $("runOptions");
  if (opts) {
    opts.replaceChildren();
    (r.options || []).forEach((o) => {
      const chip = document.createElement("span");
      chip.className = "optchip";
      chip.textContent = o;
      opts.append(chip);
    });
  }

  const url = $("runUrl");
  if (url) {
    if (r.url) {
      url.href = r.url;
      url.textContent = r.url;
      url.hidden = false;
    } else {
      url.hidden = true;
      url.removeAttribute("href");
      url.textContent = "";
    }
  }

  if (runBtn) runBtn.disabled = !canRun;
}

// =========================================================
// Latency: a real ping/pong round trip every few seconds
// =========================================================
function renderLatency() {
  const show = linkOpen && lastLatencyMs !== null;
  const text = show ? lastLatencyMs + "ms" : "";
  document.querySelectorAll(".latency").forEach((el) => { el.textContent = text; });
  const hdr = $("hdrLat");
  if (hdr) hdr.hidden = !show;
  const sys = $("sysLatWrap");
  if (sys) sys.hidden = !show;
}
function pingTick() {
  if (!linkOpen) return;
  pingSentAt = Date.now();
  sendMsg({ type: "ping" });
}
function startPing() {
  if (pingTimer) return;
  pingTick();
  pingTimer = setInterval(pingTick, PING_MS);
}
function stopPing() {
  if (pingTimer) clearInterval(pingTimer);
  pingTimer = null;
  pingSentAt = 0;
  lastLatencyMs = null;
  renderLatency();
}

function connect() {
  if (!token) {
    setStatus("Not paired", "off", "Not paired: open the pairing link once to pair this phone.");
    return;
  }
  socket = new WebSocket("ws://" + location.host + "/ws");

  socket.onopen = () => socket.send(JSON.stringify({ type: "auth", token }));

  socket.onmessage = (e) => {
    const data = JSON.parse(e.data);
    if (data.type === "welcome") {
      delay = 500;
      setStatus("Connected", "on", "");
      setButtons(true);
      linkOpen = true;
      renderLink();
      startPing();
      syncStats();
    } else if (data.type === "state") {
      renderState(data);
    } else if (data.type === "result") {
      statsReply(data);
      showFeedback(data.message, data.ok);
    } else if (data.type === "run_result") {
      renderRun(data);
    } else if (data.type === "clip_state") {
      renderClip(data);
    } else if (data.type === "stats") {
      statsReply(data);
    } else if (data.type === "pong") {
      const rtt = pingSentAt ? Date.now() - pingSentAt : null;
      if (rtt !== null) { lastLatencyMs = rtt; renderLatency(); }
      pingSentAt = 0;
      if (pingManual) {
        pingManual = false;
        showFeedback(rtt !== null ? "Round trip " + rtt + "ms" : (data.message || "Pong"), true);
      }
    }
  };

  socket.onclose = (e) => {
    statsDisconnected();
    stopPing();
    setButtons(false);
    renderState({ extensionConnected: false, workspace: null });
    if (e.code === 4001) { setStatus("Pairing rejected", "off", "Re-pair this phone from your PC."); return; }
    if (e.code === 4002) { setStatus("Locked out", "off", "Too many attempts. Wait a moment."); return; }
    setStatus("PC disconnected", "off", "Retrying...");
    setTimeout(connect, delay);
    delay = Math.min(delay * 2, 8000);
  };
}

function sendMsg(obj) {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(obj));
}

// Sleep PC is armed by the first tap and sent by a second tap within 3 seconds
function sleepDisarm(btn) {
  sleepArmed = false;
  clearTimeout(sleepTimer);
  clearInterval(sleepTickTimer);
  if (btn) btn.classList.remove("armed");
  txt("sleepLabel", "Sleep PC");
  txt("sleepSub", "Tap twice to confirm");
}
function armSleep(btn) {
  if (sleepArmed) {
    sleepDisarm(btn);
    return true;
  }
  sleepArmed = true;
  let left = 3;
  if (btn) btn.classList.add("armed");
  txt("sleepLabel", "Tap again to sleep");
  txt("sleepSub", left + "s");
  sleepTickTimer = setInterval(() => {
    left -= 1;
    if (left > 0) txt("sleepSub", left + "s");
  }, 1000);
  sleepTimer = setTimeout(() => sleepDisarm(btn), 3000);
  return false;
}

// =========================================================
// Clipboard snippets
// =========================================================
function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
  const ta = document.createElement("textarea");
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand("copy");
  ta.remove();
  return ok ? Promise.resolve() : Promise.reject(new Error("copy failed"));
}

function timeAgo(at) {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return s + "s ago";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h ago";
  return Math.floor(h / 24) + "d ago";
}

function renderClipAge() {
  document.querySelectorAll("#cliplist .snipmeta").forEach((el) => {
    el.textContent = timeAgo(Number(el.dataset.at)) + " \u00b7 " + el.dataset.len + " chars";
  });
}

function renderClip(s) {
  clipEnabled = !!s.enabled;
  txt("clipToggle", "Sync: " + (clipEnabled ? "on" : "off"));
  const grab = $("clipGrab");
  if (grab) grab.disabled = !clipEnabled;
  const clear = $("clipClear");
  if (clear) clear.disabled = s.items.length === 0;
  const state = $("clipState");
  if (state) {
    state.textContent = clipEnabled ? "Sync on" : "Sync off";
    state.className = "tbadge " + (clipEnabled ? "ok" : "");
  }

  const list = $("cliplist");
  if (!list) return;
  list.replaceChildren();

  if (!s.items.length) {
    const empty = document.createElement("div");
    empty.className = "clipempty";
    empty.textContent = clipEnabled ? "Nothing saved yet. Grab the PC clipboard." : "Sync is off. Nothing is saved.";
    list.append(empty);
    return;
  }

  s.items.forEach((it) => {
    const card = document.createElement("div");
    card.className = "snip";

    const meta = document.createElement("div");
    meta.className = "snipmeta";
    meta.dataset.at = it.at;
    meta.dataset.len = it.text.length;
    meta.textContent = timeAgo(it.at) + " \u00b7 " + it.text.length + " chars";

    const t = document.createElement("button");
    t.type = "button";
    t.className = "txt";
    t.textContent = it.text;
    t.addEventListener("click", () =>
      copyText(it.text).then(() => showFeedback("Copied to phone", true), () => showFeedback("Copy failed", false))
    );

    const del = document.createElement("button");
    del.type = "button";
    del.className = "del";
    del.textContent = "\u00d7";
    del.setAttribute("aria-label", "Delete snippet");
    del.addEventListener("click", () => sendMsg({ type: "clip_delete", id: String(nextId++), itemId: it.id }));

    card.append(meta, t, del);
    list.append(card);
  });
}

// =========================================================
// Initialisation — every step is isolated, so one failure is
// logged and the rest of the wiring still gets installed.
// =========================================================
step("navigation", () => {
  history.replaceState({ screen: "home" }, "", location.pathname + location.search); // also strips #t=...
  window.addEventListener("popstate", (ev) => {
    // Android back closes the full-screen clock first.
    if (flipOpen) { closeFlip(); return; }
    render(ev.state && ev.state.screen);
  });
  sel(".mtile", "click", (ev) => openScreen(ev.currentTarget.dataset.screen));
  sel(".railbtn[data-screen]", "click", (ev) => openScreen(ev.currentTarget.dataset.screen));
  render("home");
});

step("pomodoro", () => {
  // A phase that ended while the page was closed is replayed exactly once, silently.
  if (pomo.status === "running" && Number.isFinite(pomo.endAt) && Date.now() >= pomo.endAt) {
    finishPhase(true);
  }
  on("pomoMain", "click", pomoMain);
  on("pomoReset", "click", pomoReset);
  on("pomoSkip", "click", pomoSkip);
  on("overlayOk", "click", () => { hideOverlay(); startPhase(pomo.phase, true); });
  on("overlayDismiss", "click", () => { hideOverlay(); renderPomo(); });
  renderClock();
  renderPomo();
});

step("pomodoro-settings", () => {
  on("pomoSettings", "click", () => { const p = $("pomoPanel"); if (p) p.hidden = !p.hidden; });
  on("pomoPanelClose", "click", () => { const p = $("pomoPanel"); if (p) p.hidden = true; });
  on("pomoAuto", "click", () => { cfg.auto = !cfg.auto; saveCfg(); renderCfg(); });
  on("pomoSound", "click", () => {
    cfg.sound = !cfg.sound;
    saveCfg();
    renderCfg();
    if (cfg.sound) { unlockAudio(); beep(); }
  });
  on("pomoVibrate", "click", () => { cfg.vibrate = !cfg.vibrate; saveCfg(); renderCfg(); });
  sel(".chipbtn[data-preset]", "click", (ev) => {
    const key = ev.currentTarget.dataset.preset;
    if (PRESETS[key]) Object.assign(cfg, PRESETS[key]);
    saveCfg();
    syncIdleLength();
    renderCfg();
    renderPomo();
  });
  sel("[data-inc]", "click", (ev) => bump(ev.currentTarget.dataset.inc, 1));
  sel("[data-dec]", "click", (ev) => bump(ev.currentTarget.dataset.dec, -1));
  const vib = $("pomoVibrate");
  if (vib && !navigator.vibrate) vib.hidden = true;
  renderCfg();
});

step("flipclock", () => {
  on("clock", "click", openFlip);
  on("clockExpand", "click", openFlip);
  const clockEl = $("clock");
  if (clockEl) {
    clockEl.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); openFlip(); }
    });
  }
  on("flipClose", "click", requestCloseFlip);
  on("flipFmt", "click", () => {
    flipCfg.h12 = !flipCfg.h12;
    saveFlipCfg();
    renderFlipCtl();
    renderFlip(true);
    showFlipCtl();
  });
  on("flipSecs", "click", () => {
    flipCfg.secs = !flipCfg.secs;
    saveFlipCfg();
    renderFlipCtl();
    renderFlip(true);
    showFlipCtl();
  });
  on("flip", "click", showFlipCtl);
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && flipOpen) requestCloseFlip();
  });
  renderFlipCtl();
});

step("ticker", () => {
  setInterval(() => {
    try {
      checkPhaseDone();
      renderPomo();
      renderClock();
      renderClipAge();
    } catch (err) {
      console.error("[swaydeck] tick failed:", err);
    }
  }, 500);
});

step("haptics", () => {
  const el = $("haptic");
  if (el && !navigator.vibrate) el.hidden = true;
  on("haptic", "click", () => { hapticOn = !hapticOn; lsSet("swaydeck_haptic", hapticOn ? "1" : "0"); renderHaptic(); });
  renderHaptic();
  document.addEventListener("click", (ev) => {
    const t = ev.target;
    if (t instanceof Element && t.closest("button, a")) haptic(10);
  });
});

step("settings", () => {
  on("railSettings", "click", () => { const p = $("settingsPanel"); if (p) p.hidden = !p.hidden; });
  on("settingsClose", "click", () => { const p = $("settingsPanel"); if (p) p.hidden = true; });
  txt("hostChip", location.host);
});

step("fullscreen", () => {
  const supported = !!document.documentElement.requestFullscreen;

  // The Settings fallback only makes sense in a browser tab: an installed
  // app is already fullscreen, and an unsupported browser would show a
  // dead key. Everywhere else it stays hidden.
  const setBtn = $("fsSet");
  if (setBtn && supported && !isStandaloneApp()) setBtn.hidden = false;

  // No element-fullscreen support (iOS Safari): hide the dead control.
  if (!supported) {
    const btn = $("fsBtn");
    if (btn) btn.hidden = true;
    return;
  }
  on("fsBtn", "click", toggleFullscreen);
  on("fsSet", "click", toggleFullscreen);
  document.addEventListener("fullscreenchange", renderFullscreen);
  renderFullscreen();
});

step("awake", () => {
  on("awake", "click", () => { wantAwake = !wantAwake; lsSet("swaydeck_awake", wantAwake ? "1" : "0"); renderAwake(); applyWake(); });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") applyWake(); });
  renderAwake();
  applyWake();
});

step("actions", () => {
  // Delegated so a tap on the icon/span inside a tile can never miss the handler.
  document.addEventListener("click", (ev) => {
    const t = ev.target;
    const el = t instanceof Element ? t.closest("[data-action]") : null;
    if (!el || el.disabled) return;
    const action = el.dataset.action;
    if (action === "sleep_pc" && !armSleep(el)) return;
    const msg = { type: "action", id: String(nextId++), action };
    if (el.dataset.steps) msg.args = { steps: Number(el.dataset.steps) };
    sendMsg(msg);
  });
});

step("controls", () => {
  if (runBtn) {
    runBtn.addEventListener("click", () => {
      runBtn.disabled = true;
      if (runInfo) { runInfo.textContent = "Starting..."; runInfo.className = "warn"; }
      sendMsg({ type: "run_project", id: String(nextId++) });
    });
  }
  on("refresh", "click", () => sendMsg({ type: "refresh_workspace", id: String(nextId++) }));
  on("ping", "click", () => { pingManual = true; pingSentAt = Date.now(); sendMsg({ type: "ping" }); });
  on("refreshStats", "click", statsNow);
});

step("clipboard", () => {
  on("clipToggle", "click", () => sendMsg({ type: "clip_set", id: String(nextId++), enabled: !clipEnabled }));
  on("clipGrab", "click", () => sendMsg({ type: "clip_grab", id: String(nextId++) }));
  on("clipClear", "click", () => sendMsg({ type: "clip_clear", id: String(nextId++) }));
  renderClip({ enabled: false, items: [] });
});

step("boot", () => {
  txt("statsPoll", "Poll: " + STATS_POLL_MS + "ms");
  renderLink();
  renderStatsState();
  connect();
});

// =========================================================
// Service worker — registered last, after all init, so a failure
// here can never take the app down. sw.js caches nothing; see that
// file for why. Only needed so the app is installable.
// =========================================================
try {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }
} catch {}
