#!/usr/bin/env node
"use strict";

/**
 * SwayDeck pairing helper: `npm run pair`.
 *
 * 1. Reads (or creates) the shared pairing token next to server.js.
 * 2. Checks that adb is on PATH (prints the platform-tools download link if not).
 * 3. Runs `adb reverse tcp:3000 tcp:3000` so the phone can reach the agent over USB.
 * 4. Opens the pairing URL on the phone with the same intent the agent prints on startup.
 *
 * This does not change how the agent works; the agent itself must already be
 * running (`npm start`) for the phone to connect after pairing.
 */

const { spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PORT = 3000;
const PLATFORM_TOOLS_URL = "https://developer.android.com/tools/releases/platform-tools";

// Must resolve to the same file server.js reads: swaydeck-agent/.swaydeck-token
const TOKEN_FILE = path.join(__dirname, "..", ".swaydeck-token");

/**
 * Identical logic to loadToken() in server.js: read the token if it exists,
 * otherwise create one with the same size/encoding/mode. Kept in sync on purpose.
 */
function loadToken() {
  if (fs.existsSync(TOKEN_FILE)) return fs.readFileSync(TOKEN_FILE, "utf8").trim();
  const t = crypto.randomBytes(24).toString("base64url");
  fs.writeFileSync(TOKEN_FILE, t, { mode: 0o600 });
  return t;
}

/** Finds adb on PATH (filesystem lookup only; nothing is spawned to probe). */
function findAdb() {
  const names = process.platform === "win32" ? ["adb.exe", "adb"] : ["adb"];
  const dirs = (process.env.PATH || "").split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    for (const name of names) {
      try {
        if (fs.existsSync(path.join(dir, name))) return path.join(dir, name);
      } catch {
        // Ignore unreadable or invalid PATH entries.
      }
    }
  }
  return null;
}

function runAdb(adb, args) {
  // Array args, shell: false: nothing is interpreted by a shell.
  return spawnSync(adb, args, { stdio: "inherit", shell: false });
}

function fail(message) {
  console.error(`\n${message}`);
  process.exit(1);
}

function main() {
  const adb = findAdb();
  if (!adb) {
    console.error("Could not find adb on your PATH.");
    console.error("Install Android platform-tools and add the folder to PATH:");
    console.error(`  ${PLATFORM_TOOLS_URL}`);
    console.error("\nThen plug in your phone (USB debugging on) and run `npm run pair` again.");
    process.exit(1);
  }

  const token = loadToken();
  console.log(`Pairing token file: ${TOKEN_FILE}`);

  const reverse = runAdb(adb, ["reverse", `tcp:${PORT}`, `tcp:${PORT}`]);
  if (reverse.status !== 0) {
    fail(
      "adb reverse failed. Check that your phone is connected with USB debugging on and visible:\n  adb devices"
    );
  }
  console.log(`USB tunnel ready: adb reverse tcp:${PORT} tcp:${PORT}`);

  const url = `http://localhost:${PORT}/#t=${token}`;
  const open = runAdb(adb, [
    "shell",
    "am",
    "start",
    "-a",
    "android.intent.action.VIEW",
    "-d",
    url,
  ]);
  if (open.status !== 0) {
    fail(`Could not open the pairing link on the phone. Open this URL in Chrome:\n  ${url}`);
  }

  console.log("Opened the pairing link on your phone.");
  console.log("If Chrome did not open, visit this URL on the phone:");
  console.log(`  ${url}`);
}

main();
