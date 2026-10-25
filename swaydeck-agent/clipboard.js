const { spawn } = require("child_process");
const path = require("path");

class ClipError extends Error {
  constructor(userMessage) {
    super(userMessage);
    this.userMessage = userMessage;
  }
}

const MAX_ITEMS = 20;
const MAX_CHARS = 2000;
const POWERSHELL = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
// Fixed script. Nothing from the phone is ever put into it.
const READ_SCRIPT = "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-Clipboard -Raw";

let enabled = false; // off by default
let nextId = 1;
let items = []; // newest first, memory only (never written to disk)
let grabbing = false;

// ---- Sensitive-text filter (best effort; it errs on the side of skipping) ----
const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/, // JWT
  /\bsk-[\w-]{16,}/, // API keys like sk-...
  /\bgh[pousr]_\w{20,}/, // GitHub tokens
  /\bgithub_pat_\w{20,}/,
  /\bxox[abprs]-[\w-]{10,}/, // Slack tokens
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\bAIza[\w-]{30,}/, // Google API key
  /\bBearer\s+[\w.~+\/=-]{16,}/i,
  /\b(password|passwd|pwd|passcode|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|otp|pin)\b\s*[:=]/i,
  /\b(password|passwd|passcode|otp|pin)\s+is\b/i,
];

function luhn(digits) {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

function sensitiveReason(text) {
  for (const re of SECRET_PATTERNS) if (re.test(text)) return "secret pattern";

  if (/^\d{4,8}$/.test(text)) return "otp or pin";
  if (/^\d{4}[ -]?\d{4}[ -]?\d{4}$/.test(text)) return "12-digit id";

  // Card numbers (Luhn check) anywhere in the text
  const runs = text.match(/\d(?:[ -]?\d){12,18}/g) || [];
  for (const r of runs) {
    const digits = r.replace(/[ -]/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) return "card number";
  }

  // A single "word" with no spaces: could be a password or a random token
  if (!/\s/.test(text)) {
    if (/^https?:\/\/\S+$/i.test(text)) {
      return /[?&#](token|key|secret|password|sig|signature|auth|access_token|code)=/i.test(text) ? "url with secret" : null;
    }
    if (/^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$/.test(text)) return null; // email address
    if (/^[A-Za-z]:\\/.test(text)) return null; // Windows path
    const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(text)).length;
    if (text.length >= 8 && classes >= 3) return "password-like";
    if (text.length >= 24 && classes >= 2) return "long random token";
  }
  return null;
}

// ---- Read the PC clipboard (fixed PowerShell script, output size and time capped) ----
function readClipboard() {
  return new Promise((resolve, reject) => {
    const child = spawn(POWERSHELL, ["-NoProfile", "-NonInteractive", "-Command", READ_SCRIPT], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
      shell: false,
    });
    let out = "";
    let tooBig = false;
    const timer = setTimeout(() => {
      child.kill();
      reject(new ClipError("Timed out reading the clipboard"));
    }, 5000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => {
      out += d;
      if (out.length > 20000) {
        tooBig = true;
        child.kill();
      }
    });
    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (tooBig) return reject(new ClipError("Clipboard text is too long (max 2000 characters)"));
      if (code !== 0) return reject(new ClipError("Could not read the clipboard"));
      resolve(out);
    });
  });
}

// ---- Public API used by server.js ----
function stateMessage() {
  return { type: "clip_state", enabled, items: items.map(({ id, text, at }) => ({ id, text, at })) };
}

function setEnabled(value) {
  if (typeof value !== "boolean") throw new ClipError("Invalid value");
  enabled = value;
  console.log(`[clip] sync ${enabled ? "on" : "off"}`);
  return enabled ? "Clipboard sync on" : "Clipboard sync off";
}

async function grab() {
  if (!enabled) throw new ClipError("Clipboard sync is off. Turn it on first.");
  if (grabbing) throw new ClipError("Already reading the clipboard");
  grabbing = true;
  try {
    const raw = await readClipboard();
    const text = raw.replace(/\r\n/g, "\n").replace(/^\s*\n/, "").trimEnd();
    if (!text) throw new ClipError("Clipboard has no text");
    if (text.length > MAX_CHARS) throw new ClipError("Clipboard text is too long (max 2000 characters)");
    const reason = sensitiveReason(text);
    if (reason) {
      console.log(`[clip] skipped (${reason})`); // never log the text itself
      throw new ClipError("Skipped: this looks sensitive");
    }
    if (items[0] && items[0].text === text) return "Already saved";
    items.unshift({ id: nextId++, text, at: Date.now() });
    if (items.length > MAX_ITEMS) items.length = MAX_ITEMS;
    console.log(`[clip] saved snippet (${text.length} chars)`);
    return "Snippet saved";
  } finally {
    grabbing = false;
  }
}

function clear() {
  items = [];
  console.log("[clip] cleared");
  return "Snippets cleared";
}

function remove(itemId) {
  if (!Number.isInteger(itemId)) throw new ClipError("Invalid snippet");
  items = items.filter((it) => it.id !== itemId);
  return "Snippet removed";
}

module.exports = { stateMessage, setEnabled, grab, clear, remove, _sensitiveReason: sensitiveReason };