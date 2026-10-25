#!/usr/bin/env node
/* =========================================================================
   SwayDeck — README screenshot generator (development tool, never shipped)

   FIRST RUN (once, on the machine that builds the README):
     npm install                       installs playwright (devDependency)
     npx playwright install chromium   downloads Chromium (~150 MB, dev only)
   THEN:
     npm run screenshots               writes docs/screenshots/*.png

   Everything the screenshots show is FAKE:
     - a dummy pairing token (the real .swaydeck-token is never read)
     - a mocked phone WebSocket (server.js is NOT started, nothing is forwarded)
     - a fictional workspace ("swaydeck-demo" in C:\demo\swaydeck-demo)
     - four harmless clipboard snippets
     - fake system stats (CPU 23%, RAM 48%, no temperature sensor)
   It never touches the real clipboard, the real agent, the real VS Code
   workspace or a real project path.

   The app's public/ folder is served from a tiny local static server on
   127.0.0.1 so the PWA runs exactly as it does on the phone. Navigation is
   done by clicking the real rail buttons and controls (never internal
   functions), so a successful run is also a smoke test of the deck UI.

   Every shot is taken only after a layout guard passes: no page scrolling,
   no control hanging over the edge of the viewport, no text cut off by an
   ellipsis (unless the element opts out with data-allow-truncate), the timer
   settings modal fully inside the viewport and the active screen not clipping
   its content. Every screen is captured twice — once at 915x412 and once at
   the shortest supported height, 915x360 (01b … 09b) — because the deck must
   stay intact from 360px to 450px in height.
   ========================================================================= */

"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");
const { pathToFileURL } = require("url");

/* ------------------------------------------------------------------ paths */
const ROOT = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT, "swaydeck-agent", "public");
const OUT_DIR = path.join(ROOT, "docs", "screenshots");

/* ---------------------------------------------------------------- tuning */
const VIEWPORT = { width: 915, height: 412 };
const SMALL_HEIGHT = 360; // the shortest landscape height the deck must survive
const DEVICE_SCALE = 2;
const SETTLE_MS = 700; // let screen/panel transitions finish before a shot
const MINUTE = 60 * 1000;

// Dummy value only: app.js reads the token from localStorage["swaydeck_token"].
const DEMO_TOKEN = "swaydeck-demo-token";

/* --------------------------------------------------- demo data (all fake) */
function demoClockBase() {
  const d = new Date();
  d.setHours(10, 42, 0, 0); // every shot is taken at a fixed 10:42
  return d.getTime();
}
const CLOCK_AT = demoClockBase();
const POMO_EXPECTED = "24:57"; // 25:00 focus minus the 3 s we advance

/* The mocked pong's simulated LAN round trip.
   app.js measures the latency as Date.now() - pingSentAt, and
   page.clock.setFixedTime() freezes Date.now() while the real timers keep
   running — so a pong delivered without moving the page's clock would always
   read as a hard 0 ms. Moving the fixed clock by LATENCY_MS before each pong
   is delivered gives a realistic 14 ms in the header and on the System
   screen, and no app code has to change. */
const LATENCY_MS = 14;
let clockNow = CLOCK_AT; // the fixed clock's current value, moved by hand
let clockFixed = false;  // true once page.clock.setFixedTime() is installed

async function setClockTo(value) {
  clockNow = value;
  if (!page || !clockFixed) return;
  try {
    await page.clock.setFixedTime(clockNow);
  } catch {}
}
async function advanceClock(ms) {
  await setClockTo(clockNow + ms);
}

// Clipboard timestamps are anchored to whatever clock the page really uses,
// so "4m ago" stays honest even if the fake clock could not be installed.
let clipBase = Date.now();

const DEMO_WORKSPACE = {
  open: true,
  name: "swaydeck-demo",
  path: "C:\\demo\\swaydeck-demo", // fictional path, never touched
  multiRoot: false,
  trusted: true,
  projectType: "node",
  folders: [{ name: "swaydeck-demo", path: "C:\\demo\\swaydeck-demo" }],
  detected: [{ type: "node", evidence: "package.json" }],
  details: { hasPackageJson: true, hasDevScript: true, hasMainPy: false, hasIndexHtml: false },
  activeFile: "server.js",
};

// Matches monitor.js /server.js: { type:"stats", id, ...stats }
const DEMO_STATS = {
  cpuPercent: 23,
  ramPercent: 48,
  ramUsedGB: 15.4,
  ramTotalGB: 32,
  uptimeSeconds: 307800, // 3d 13h 30m
  tempC: null, // no sensor -> the real "N/A" state
};

// The exact success strings actions.js returns to the phone.
const DEMO_ACTION_MESSAGE = {
  open_calculator: "Calculator opened",
  open_vscode: "VS Code opened",
  open_chrome: "Chrome opened",
  open_project_in_vscode: "Opened project in VS Code",
  volume_up: "Volume up",
  volume_down: "Volume down",
  volume_mute: "Mute toggled",
  media_play_pause: "Play/pause sent",
  media_next: "Next track sent",
  media_prev: "Previous track sent",
  lock_pc: "PC locked",
  sleep_pc: "Going to sleep",
};

function demoClipItems() {
  return [
    { id: 1, text: "npm run dev", at: clipBase - 4 * MINUTE },
    { id: 2, text: 'git commit -m "add flip clock"', at: clipBase - 9 * MINUTE },
    { id: 3, text: "https://example.com/docs", at: clipBase - 15 * MINUTE },
    { id: 4, text: "SELECT * FROM users LIMIT 10;", at: clipBase - 22 * MINUTE },
  ];
}

/* ------------------------------------------------------------------ noise */
const log = (msg) => console.log("[screenshots] " + msg);
const warn = (msg) => console.warn("[screenshots] !! " + msg);

/* ------------------------------------------------------- static file server */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

// Serves swaydeck-agent/public only, on a free port, bound to 127.0.0.1.
function startStaticServer() {
  const server = http.createServer((req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname);
    } catch {
      res.writeHead(400).end("Bad request");
      return;
    }
    const rel = pathname.endsWith("/") ? pathname + "index.html" : pathname;
    const filePath = path.resolve(PUBLIC_DIR, "." + rel);
    if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
      res.writeHead(403).end("Forbidden");
      return;
    }
    fs.readFile(filePath, (err, buf) => {
      if (err) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
        return;
      }
      res.writeHead(200, {
        "Content-Type": MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream",
        "Cache-Control": "no-store",
      });
      res.end(buf);
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

/* ------------------------------------------------------ mocked phone socket */
let mockClipEnabled = false;
const mockErrors = [];

function mockClipState() {
  return {
    type: "clip_state",
    enabled: mockClipEnabled,
    items: mockClipEnabled ? demoClipItems() : [],
  };
}

// Reproduces server.js + actions.js + clipboard.js + projectRunner.js replies.
function mockPhoneSocket(ws) {
  ws.onMessage((raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      mockErrors.push("app sent a message that is not JSON: " + String(raw).slice(0, 120));
      return;
    }
    const send = (obj) => ws.send(JSON.stringify(obj));

    switch (msg.type) {
      case "auth":
        if (msg.token !== DEMO_TOKEN) {
          mockErrors.push("app authenticated with an unexpected token (expected the dummy demo token)");
        }
        // server.js order: welcome, state, clip_state
        send({ type: "welcome", message: "Paired and connected" });
        send({ type: "state", extensionConnected: true, workspace: DEMO_WORKSPACE });
        send(mockClipState());
        break;

      case "ping":
        // The pong has to move the frozen fake clock before it is delivered,
        // otherwise app.js measures a 0 ms round trip.
        setTimeout(async () => {
          await advanceClock(LATENCY_MS);
          send({ type: "pong", message: "Instant response from your PC!" });
        }, 8);
        break;

      case "get_stats":
        send({ type: "stats", id: msg.id, ...DEMO_STATS });
        break;

      case "get_workspace": // only the extension receives this, never the phone
        break;

      case "refresh_workspace":
        send({ type: "result", id: msg.id, ok: true, message: "Refresh requested" });
        send({ type: "state", extensionConnected: true, workspace: DEMO_WORKSPACE });
        break;

      case "run_project":
        // projectRunner.ts -> "started" for a node workspace with a dev script
        send({
          type: "run_result",
          id: msg.id,
          ok: true,
          status: "started",
          message: "Started npm run dev in VS Code terminal.",
          projectType: "node",
          options: [],
          url: null,
        });
        break;

      case "clip_set":
        mockClipEnabled = msg.enabled === true;
        send(mockClipState());
        send({
          type: "result",
          id: msg.id,
          ok: true,
          message: mockClipEnabled ? "Clipboard sync on" : "Clipboard sync off",
        });
        break;

      case "clip_grab":
        send(mockClipState());
        send({ type: "result", id: msg.id, ok: true, message: "Snippet saved" });
        break;

      case "clip_clear":
        send(mockClipState());
        send({ type: "result", id: msg.id, ok: true, message: "Snippets cleared" });
        break;

      case "clip_delete":
        send(mockClipState());
        send({ type: "result", id: msg.id, ok: true, message: "Snippet removed" });
        break;

      case "action":
        send({
          type: "result",
          id: msg.id,
          ok: true,
          message: DEMO_ACTION_MESSAGE[msg.action] || "Done",
        });
        break;

      default:
        mockErrors.push("app sent an unexpected message type: " + msg.type);
        send({ type: "error", message: "Unknown message type" });
    }
  });
}

/* ------------------------------------------------------------ page helpers */
let page = null;
const pageErrors = [];
let reportedErrors = 0;

function assertClean(name) {
  const problems = pageErrors.slice(reportedErrors).concat(mockErrors);
  reportedErrors = pageErrors.length;
  mockErrors.length = 0;
  if (problems.length) {
    throw new Error("[" + name + "] the page/socket reported a problem:\n  - " + problems.join("\n  - "));
  }
}

async function expectVisible(name, selector, timeout = 5000) {
  try {
    await page.locator(selector).first().waitFor({ state: "visible", timeout });
  } catch {
    throw new Error("[" + name + "] expected element is missing or hidden: " + selector);
  }
}

async function expectText(name, selector, expected, timeout = 5000) {
  try {
    await page.waitForFunction(
      ([sel, want]) => {
        const el = document.querySelector(sel);
        return !!el && el.textContent.trim() === want;
      },
      [selector, expected],
      { timeout }
    );
  } catch {
    throw new Error('[' + name + '] ' + selector + ' never showed "' + expected + '"');
  }
}

async function maybeText(selector, expected, timeout) {
  try {
    await page.waitForFunction(
      ([sel, want]) => {
        const el = document.querySelector(sel);
        return !!el && el.textContent.trim() === want;
      },
      [selector, expected],
      { timeout }
    );
    return true;
  } catch {
    return false;
  }
}

async function expectCount(name, selector, n, timeout = 5000) {
  try {
    await page.waitForFunction(
      ([sel, want]) => document.querySelectorAll(sel).length === want,
      [selector, n],
      { timeout }
    );
  } catch {
    throw new Error("[" + name + "] expected " + n + " elements matching " + selector);
  }
}

// Taps a real control with a real mouse press. Nothing internal is called and
// nothing is forced, so the tap goes through the same hit-testing a finger
// would. One deck control (the Pomodoro Start button) sits beside a purely
// decorative, rotated SVG ring whose rendered box reaches over the button's
// exact centre, so when dead centre is covered we tap another point that is
// still inside the same control.
const CLICK_SPOTS = [
  [0.5, 0.5],
  [0.75, 0.5],
  [0.5, 0.3],
  [0.5, 0.7],
  [0.85, 0.5],
  [0.25, 0.5],
  [0.15, 0.5],
  [0.5, 0.15],
  [0.5, 0.85],
];

async function clickEnabled(name, selector) {
  const loc = page.locator(selector).first();
  await expectVisible(name, selector);
  if (await loc.isDisabled()) {
    throw new Error("[" + name + "] " + selector + " is disabled (is the mocked socket connected?)");
  }
  const box = await loc.boundingBox();
  if (!box) throw new Error("[" + name + "] " + selector + " has no layout box");
  const offset = await page.evaluate(
    ([sel, b, spots]) => {
      const el = document.querySelector(sel);
      for (const [fx, fy] of spots) {
        const x = b.x + b.width * fx;
        const y = b.y + b.height * fy;
        const at = document.elementFromPoint(x, y);
        if (at && (at === el || el.contains(at))) return { x: b.width * fx, y: b.height * fy };
      }
      return null;
    },
    [selector, box, CLICK_SPOTS]
  );
  if (!offset) throw new Error("[" + name + "] " + selector + " is covered by another element everywhere");
  await loc.click({ position: offset });
}

async function openRail(name, screen) {
  await clickEnabled(name, '#rail .railbtn[data-screen="' + screen + '"]');
}

const shotFiles = [];

// A toast hangs around for 2.5 s, bottom-right, and would sit on top of the
// content in 04-smart-desk and in hero.png. Wait until it has faded out.
// (#toast is only visible while it carries the "show" class.)
async function waitForToastClear(name) {
  try {
    await page.waitForFunction(
      () => {
        const t = document.getElementById("toast");
        return !t || !t.classList.contains("show");
      },
      null,
      { timeout: 6000 }
    );
  } catch {
    throw new Error("[" + name + "] the toast never cleared before the screenshot");
  }
}

// Layout guard: the deck is landscape-only and must never clip or scroll
// between 360px and 450px in height. Checked immediately before every shot.
async function assertLayout(name) {
  const problems = await page.evaluate(() => {
    const out = [];
    const de = document.documentElement;

    if (de.scrollHeight > window.innerHeight + 1) {
      out.push("page scrolls vertically: " + de.scrollHeight + "px of content in " + window.innerHeight + "px");
    }
    if (de.scrollWidth > window.innerWidth + 1) {
      out.push("page scrolls horizontally: " + de.scrollWidth + "px of content in " + window.innerWidth + "px");
    }

    const label = (el) =>
      (el.id ? "#" + el.id : el.tagName.toLowerCase() + "." + String(el.className || "").trim().split(/\s+/)[0]) +
      ' "' + (el.textContent || "").trim().slice(0, 40) + '"';

    const isVisible = (el) =>
      typeof el.checkVisibility === "function"
        ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
        : true;

    // Inside an element that really scrolls, a control may legitimately sit
    // below the fold; it is reachable, not clipped.
    const inScroller = (el) => {
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const cs = getComputedStyle(p);
        if (!/auto|scroll/.test(cs.overflowY + " " + cs.overflowX)) continue;
        if (p.scrollHeight > p.clientHeight + 1 || p.scrollWidth > p.clientWidth + 1) return true;
      }
      return false;
    };

    // Every button, rail key and input must sit fully inside the viewport.
    // This is the guard that catches a control clipped by the bottom edge of a
    // short landscape viewport (the Settings key at 915x360).
    document.querySelectorAll("button, input, select, textarea, a.btn").forEach((el) => {
      if (el.namespaceURI !== "http://www.w3.org/1999/xhtml") return;
      if (!isVisible(el)) return;
      if (inScroller(el)) return;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return; // not rendered
      if (r.left < -1 || r.top < -1 || r.right > window.innerWidth + 1 || r.bottom > window.innerHeight + 1) {
        out.push(
          "control outside the viewport: " + label(el) + " " +
          [r.left, r.top, r.right, r.bottom].map((n) => Math.round(n)).join(",") +
          " in " + window.innerWidth + "x" + window.innerHeight
        );
      }
    });

    // No visible element may have its text cut off by an ellipsis unless it is
    // explicitly allowed to truncate.
    document.querySelectorAll("*").forEach((el) => {
      if (el.namespaceURI !== "http://www.w3.org/1999/xhtml") return;
      const cs = getComputedStyle(el);
      if (cs.textOverflow !== "ellipsis") return;
      if (el.hasAttribute("data-allow-truncate") || el.closest("[data-allow-truncate]")) return;
      if (cs.display === "inline") return;
      if (el.clientWidth < 1) return; // not rendered
      if (!isVisible(el)) return;
      if (el.scrollWidth > el.clientWidth + 1) {
        out.push("text is cut off by an ellipsis: " + label(el) +
                 " (" + el.scrollWidth + " > " + el.clientWidth + ")");
      }
    });

    document.querySelectorAll("*").forEach((el) => {
      if (el.namespaceURI !== "http://www.w3.org/1999/xhtml") return;
      const cs = getComputedStyle(el);
      if (cs.whiteSpace !== "nowrap") return;
      if (cs.textOverflow === "ellipsis") return; // covered by the check above
      if (cs.display === "inline") return;
      if (el.clientWidth < 1) return; // not rendered
      if (el.scrollWidth > el.clientWidth + 1) {
        out.push("nowrap text is wider than its box: " + label(el) +
                 " (" + el.scrollWidth + " > " + el.clientWidth + ")");
      }
    });

    // ...and the visible screen must not clip or spill its own content.
    document.querySelectorAll(".screen.active, .flipface").forEach((el) => {
      if (el.scrollHeight > el.clientHeight + 1) {
        out.push("clipped content: " + label(el) + " needs " + el.scrollHeight + "px in " + el.clientHeight + "px");
      }
      if (el.scrollWidth > el.clientWidth + 1) {
        out.push("clipped content: " + label(el) + " needs " + el.scrollWidth + "px in " + el.clientWidth + "px");
      }
    });

    // The timer settings modal must be fully inside the viewport, header
    // included, with its Close control reachable.
    const panel = document.getElementById("pomoPanel");
    if (panel && !panel.hidden) {
      const card = panel.querySelector(".pomocard") || panel;
      const r = card.getBoundingClientRect();
      if (r.left < -1 || r.top < -1 || r.right > window.innerWidth + 1 || r.bottom > window.innerHeight + 1) {
        out.push(
          "the timer settings modal is not fully inside the viewport: " +
          [r.left, r.top, r.right, r.bottom].map((n) => Math.round(n)).join(",") +
          " in " + window.innerWidth + "x" + window.innerHeight
        );
      }
    }
    return out;
  });

  if (problems.length) {
    throw new Error("[" + name + "] layout check failed:\n  - " + problems.join("\n  - "));
  }
}

async function shoot(name) {
  await page.waitForTimeout(SETTLE_MS);
  await waitForToastClear(name);
  assertClean(name);
  await assertLayout(name);
  const file = path.join(OUT_DIR, name + ".png");
  await page.screenshot({ path: file, animations: "disabled" });
  shotFiles.push(name + ".png");
  log("saved docs/screenshots/" + name + ".png");
}

// The same screen at the shortest supported landscape height (915x360).
// Everything is already set up, so only the viewport changes.
async function shortShot(name) {
  await page.setViewportSize({ width: VIEWPORT.width, height: SMALL_HEIGHT });
  try {
    await shoot(name);
  } finally {
    await page.setViewportSize(VIEWPORT);
  }
}

/* ------------------------------------------------------------- hero image */
const HERO_TILES = ["01-home.png", "02-pc-control.png", "04-smart-desk.png", "07-system-monitor.png"];

function heroHtml() {
  return [
    "<!DOCTYPE html>",
    '<html lang="en"><head><meta charset="utf-8"><title>SwayDeck</title>',
    "<style>",
    "html,body{margin:0;background:#0b0b0f;}",
    ".grid{display:grid;grid-template-columns:915px 915px;grid-template-rows:412px 412px;}",
    "img{display:block;width:915px;height:412px;}",
    "</style></head><body>",
    '<div class="grid">',
    ...HERO_TILES.map((f) => '<img src="' + f + '" alt="' + f + '">'),
    "</div></body></html>",
    "",
  ].join("\n");
}

async function buildHero(browser) {
  if (!HERO_TILES.every((f) => fs.existsSync(path.join(OUT_DIR, f)))) return false;

  // Rendered from a temporary file next to the PNGs so the <img> sources are
  // plain relative paths (no extra dependency, no server needed).
  const tmp = path.join(OUT_DIR, ".hero-source.html");
  fs.writeFileSync(tmp, heroHtml());
  let context = null;
  try {
    context = await browser.newContext({
      viewport: { width: 1830, height: 824 },
      deviceScaleFactor: 2,
      colorScheme: "dark",
    });
    const heroPage = await context.newPage();
    await heroPage.goto(pathToFileURL(tmp).href, { waitUntil: "load" });
    await heroPage.waitForFunction(() => Array.from(document.images).every((i) => i.complete && i.naturalWidth > 0));
    await heroPage.waitForTimeout(300);
    await heroPage.screenshot({ path: path.join(OUT_DIR, "hero.png"), animations: "disabled" });
    shotFiles.push("hero.png");
    log("saved docs/screenshots/hero.png (2x2 grid of 01, 02, 04, 07)");
    return true;
  } finally {
    if (context) await context.close();
    fs.rmSync(tmp, { force: true });
  }
}

/* -------------------------------------------------------------------- main */
async function main() {
  log("SwayDeck screenshot generator — demo data only, the real agent is never used.");
  log("If this is your first run: npm install && npx playwright install chromium (~150 MB, dev only).");

  fs.mkdirSync(OUT_DIR, { recursive: true });
  if (!fs.existsSync(path.join(PUBLIC_DIR, "index.html"))) {
    throw new Error("could not find the app UI at " + PUBLIC_DIR);
  }

  let chromium;
  try {
    ({ chromium } = require("playwright"));
  } catch {
    throw new Error("Playwright is not installed. Run `npm install`, then `npx playwright install chromium`.");
  }

  const { server, port } = await startStaticServer();
  const origin = "http://127.0.0.1:" + port;
  log("serving " + path.relative(ROOT, PUBLIC_DIR) + " (static only) at " + origin);

  let browser = null;
  try {
    try {
      browser = await chromium.launch();
    } catch (err) {
      throw new Error(
        "could not launch Chromium — run `npx playwright install chromium` first.\n" + (err && err.message)
      );
    }

    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: DEVICE_SCALE,
      isMobile: true,
      hasTouch: true,
      colorScheme: "dark",
      locale: "en-US",
      timezoneId: "Asia/Kolkata",
      serviceWorkers: "block", // no sw.js registration for this run
      reducedMotion: "reduce", // stable captures
    });

    page = await context.newPage();
    page.on("console", (msg) => {
      if (msg.type() === "error") pageErrors.push("console: " + msg.text());
    });
    page.on("pageerror", (err) => pageErrors.push("pageerror: " + ((err && err.stack) || err)));
    // The "not paired" guard: a dummy token under the exact key app.js uses.
    await page.addInitScript((token) => {
      try {
        window.localStorage.setItem("swaydeck_token", token);
      } catch {}
    }, DEMO_TOKEN);

    // Every phone WebSocket is mocked locally; nothing is forwarded anywhere.
    await page.routeWebSocket(/\/ws$/, mockPhoneSocket);

    // Fix the clock at 10:42 when page.clock exists; otherwise keep real time.
    if (page.clock && typeof page.clock.setFixedTime === "function") {
      try {
        await page.clock.setFixedTime(CLOCK_AT); // fixed Date, timers keep running
        clockFixed = true;
        clipBase = CLOCK_AT;
      } catch (err) {
        warn("page.clock.setFixedTime failed, continuing with the real clock: " + err.message);
      }
    } else {
      warn("page.clock is not available in this Playwright version, skipping the fixed clock.");
    }

    await page.goto(origin + "/", { waitUntil: "load" });

    /* ------------------------------------------------ 01 home */
    try {
      await page.waitForFunction(() => {
        const el = document.querySelector(".statusText");
        return !!el && el.textContent.trim() === "Connected";
      }, null, { timeout: 8000 });
    } catch {
      throw new Error("[01-home] the deck never reported Connected (mocked auth failed?)");
    }
    await expectText("01-home", "#hdrExt", "VS Code: connected");
    // The first ping goes out as soon as the agent says welcome, so the
    // latency chip must already read the simulated round trip.
    await expectVisible("01-home", "#hdrLat", 6000);
    await expectText("01-home", "#hdrLat", LATENCY_MS + "ms");
    await shoot("01-home");
    await shortShot("01b-home");

    /* ------------------------------------------------ 02 pc control */
    await openRail("02-pc-control", "pc");
    await expectVisible("02-pc-control", "#screen-pc.active");
    // Real click on a real action tile: proves the action round trip works.
    await clickEnabled("02-pc-control", '.tile[data-action="open_calculator"]');
    await expectText("02-pc-control", "#toast", "Calculator opened");
    await page.waitForFunction(
      () => document.getElementById("toast").className === "",
      null,
      { timeout: 6000 }
    );
    await shoot("02-pc-control");
    await shortShot("02b-pc-control");

    /* ------------------------------------------------ 03 sleep confirm */
    await clickEnabled("03-sleep-confirm", "#sleepBtn");
    await expectText("03-sleep-confirm", "#sleepLabel", "Tap again to sleep", 2500);
    await shoot("03-sleep-confirm"); // the arm window is only 3 s
    // 03b re-arms at 360: wait for the 3 s window to lapse (the label returns
    // to "Sleep PC") before tapping again, because a second tap while still
    // armed would really send sleep_pc.
    await page.setViewportSize({ width: VIEWPORT.width, height: SMALL_HEIGHT });
    try {
      await page.waitForFunction(
        () => {
          const el = document.getElementById("sleepLabel");
          return !!el && el.textContent.trim() === "Sleep PC";
        },
        null,
        { timeout: 8000 }
      );
      await clickEnabled("03b-sleep-confirm", "#sleepBtn");
      await expectText("03b-sleep-confirm", "#sleepLabel", "Tap again to sleep", 2500);
      await shoot("03b-sleep-confirm");
    } finally {
      await page.setViewportSize(VIEWPORT);
    }

    /* ------------------------------------------------ 04 smart desk */
    await openRail("04-smart-desk", "desk");
    await expectVisible("04-smart-desk", "#screen-desk.active");
    await clickEnabled("04-smart-desk", "#clipToggle"); // sync on -> demo snippets
    await expectText("04-smart-desk", "#clipToggle", "Sync: on");
    await expectCount("04-smart-desk", "#cliplist .snip", 4);
    await clickEnabled("04-smart-desk", "#pomoMain"); // start the focus phase
    const pomoStart = clockNow; // the phase's own start, as the page sees it
    if (clockFixed) {
      // Absolute target, so a pong's clock nudge cannot shift the reading:
      // 3 s after the phase started is exactly 24:57.
      await setClockTo(pomoStart + 3000); // 25:00 -> 24:57
    } else {
      await page.waitForTimeout(3100);
    }
    if (!(await maybeText("#pomotime", POMO_EXPECTED, 4000))) {
      warn("04-smart-desk: #pomotime did not reach " + POMO_EXPECTED + " (fixed / advanced clock unavailable).");
    }
    await shoot("04-smart-desk");
    await shortShot("04b-smart-desk");

    /* ------------------------------------------------ 05 pomodoro settings */
    await clickEnabled("05-pomodoro-settings", "#pomoSettings");
    await expectVisible("05-pomodoro-settings", "#pomoPanel");
    await shoot("05-pomodoro-settings");

    /* ------------------------------ 05b the same modal at 915x360 (short) */
    await page.setViewportSize({ width: VIEWPORT.width, height: SMALL_HEIGHT });
    await shoot("05b-pomodoro-settings");
    await page.setViewportSize(VIEWPORT);
    await clickEnabled("05-pomodoro-settings", "#pomoPanelClose");
    await page.locator("#pomoPanel").waitFor({ state: "hidden", timeout: 4000 }).catch(() => {
      throw new Error("[05-pomodoro-settings] the timer settings modal did not close");
    });

    /* ------------------------------------------------ 06 flip clock */
    await clickEnabled("06-flip-clock", "#clockExpand");
    await expectVisible("06-flip-clock", "#flip");
    await expectVisible("06-flip-clock", "#flipClock");
    await shoot("06-flip-clock");

    /* --------------------------- 06b the same clock at 915x360 (short) */
    await page.locator("#flipFace").click({ timeout: 3000 }).catch(() => {}); // tap re-shows the bar
    // Opening the clock also asks for document fullscreen (app behaviour) and
    // Chromium refuses to resize a fullscreen window, so step out of it first.
    // Nothing else changes: the deck already fills the window.
    await page.evaluate(async () => {
      if (document.fullscreenElement && document.exitFullscreen) {
        try { await document.exitFullscreen(); } catch {}
      }
    });
    await page.setViewportSize({ width: VIEWPORT.width, height: SMALL_HEIGHT });
    await shoot("06b-flip-clock");
    await page.setViewportSize(VIEWPORT);

    // The control bar auto-hides after 3 s; a tap on the face brings it back.
    await page.locator("#flipFace").click({ timeout: 3000 }).catch(() => {});
    try {
      await page.locator("#flipClose").click({ timeout: 3000 });
    } catch {
      await page.keyboard.press("Escape"); // same close path (history back)
    }
    await page.locator("#flip").waitFor({ state: "hidden", timeout: 4000 }).catch(() => {
      throw new Error("[06-flip-clock] the full-screen clock did not close");
    });

    /* ------------------------------------------------ 07 system monitor */
    await openRail("07-system-monitor", "system");
    await expectVisible("07-system-monitor", "#screen-system.active");
    await expectText("07-system-monitor", "#cpuVal", "23%");
    await expectText("07-system-monitor", "#ramVal", "48%");
    await expectText("07-system-monitor", "#tempVal", "N/A");
    await expectText("07-system-monitor", "#ramMeta", "15.4 / 32.0 GB");
    await expectText("07-system-monitor", "#sysLatency", LATENCY_MS + "ms");
    await shoot("07-system-monitor");
    await shortShot("07b-system-monitor");

    /* ------------------------------------------------ 08 project */
    await openRail("08-project", "dev");
    await expectVisible("08-project", "#screen-dev.active");
    await expectText("08-project", "#ext", "VS Code: connected");
    await expectText("08-project", "#proj", "swaydeck-demo");
    await expectText("08-project", "#projSub", "node \u00b7 dev script found");
    await expectText("08-project", "#projTrustBadge", "TRUSTED");
    await clickEnabled("08-project", "#run");
    await expectText("08-project", "#runinfo", "Started npm run dev in VS Code terminal.");
    await shoot("08-project");
    await shortShot("08b-project");

    /* ------------------------------------------------ 09 music */
    await openRail("09-music", "music");
    await expectVisible("09-music", "#screen-music.active");
    await shoot("09-music");
    await shortShot("09b-music");

    /* ------------------------------------------------ hero.png */
    await buildHero(browser);

    assertClean("final");
    log("done — " + shotFiles.length + " image(s) in docs/screenshots/: " + shotFiles.join(", "));
  } finally {
    if (browser) await browser.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((err) => {
  console.error("\n[screenshots] FAILED: " + ((err && err.message) || err) + "\n");
  process.exitCode = 1;
});
