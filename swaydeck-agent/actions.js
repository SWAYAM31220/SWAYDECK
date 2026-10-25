const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

class ActionError extends Error {
  constructor(userMessage) {
    super(userMessage);
    this.userMessage = userMessage;
  }
}

// Optional config.json next to this file, written by YOU on the PC (the phone can never change it):
// { "vscodePath": "C:\\...\\Code.exe", "chromePath": "C:\\...\\chrome.exe" }
function loadConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
    return cfg && typeof cfg === "object" ? cfg : {};
  } catch {
    return {};
  }
}
const CONFIG = loadConfig();
const env = process.env;
const j = (base, ...rest) => (base ? path.join(base, ...rest) : null);

const VSCODE_CANDIDATES = [
  j(env.LOCALAPPDATA, "Programs", "Microsoft VS Code", "Code.exe"),
  j(env.ProgramFiles, "Microsoft VS Code", "Code.exe"),
  j(env["ProgramFiles(x86)"], "Microsoft VS Code", "Code.exe"),
];
const CHROME_CANDIDATES = [
  j(env.ProgramFiles, "Google", "Chrome", "Application", "chrome.exe"),
  j(env["ProgramFiles(x86)"], "Google", "Chrome", "Application", "chrome.exe"),
  j(env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
];

function resolveExe(configured, candidates) {
  if (
    typeof configured === "string" &&
    path.isAbsolute(configured) &&
    /\.exe$/i.test(configured) &&
    fs.existsSync(configured)
  ) {
    return configured;
  }
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

// Launch a fixed executable. No shell, no phone-supplied strings.
function launch(exe, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { detached: true, stdio: "ignore", shell: false });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

// ---- Volume and media keys via one fixed PowerShell snippet ----
const POWERSHELL = path.join(env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

function runPowerShell(script, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const child = spawn(POWERSHELL, ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true,
      stdio: "ignore",
      shell: false,
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new ActionError("Timed out sending the key"));
    }, timeoutMs);
    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new ActionError("Could not send the key"));
    });
  });
}

// Keys are sent one batch at a time, in order, so fast taps never overlap.
let keyQueue = Promise.resolve();
function sendKey(keyCode, times) {
  // keyCode and times are integers chosen by this file or validated below, never raw phone text
  const script = `Add-Type -Namespace K -Name Vk -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);'; 1..${times} | ForEach-Object { [K.Vk]::keybd_event(${keyCode}, 0, 1, [UIntPtr]::Zero); [K.Vk]::keybd_event(${keyCode}, 0, 3, [UIntPtr]::Zero); Start-Sleep -Milliseconds 20 }`;
  const job = keyQueue.then(() => runPowerShell(script));
  keyQueue = job.catch(() => {});
  return job;
}

function validateSteps(args) {
  const raw = args && typeof args === "object" ? args.steps : undefined;
  if (raw === undefined) return { steps: 5 };
  if (!Number.isInteger(raw) || raw < 1 || raw > 10) {
    throw new ActionError("steps must be a whole number from 1 to 10");
  }
  return { steps: raw };
}

// ---- The allowlist. The phone can only send one of these keys. ----
const ACTIONS = {
  open_calculator: {
    label: "Open Calculator",
    run: async () => {
      await launch("calc.exe");
      return "Calculator opened";
    },
  },

  open_vscode: {
    label: "Open VS Code",
    run: async () => {
      const exe = resolveExe(CONFIG.vscodePath, VSCODE_CANDIDATES);
      if (!exe) throw new ActionError("VS Code not found. Set vscodePath in config.json.");
      await launch(exe);
      return "VS Code opened";
    },
  },

  open_chrome: {
    label: "Open Chrome",
    run: async () => {
      const exe = resolveExe(CONFIG.chromePath, CHROME_CANDIDATES);
      if (!exe) throw new ActionError("Chrome not found. Set chromePath in config.json.");
      await launch(exe);
      return "Chrome opened";
    },
  },

  open_project_in_vscode: {
    label: "Open project in VS Code",
    run: async (_args, ctx) => {
      const ws = ctx.getWorkspace();
      if (!ws || !ws.open || typeof ws.path !== "string") {
        throw new ActionError("No project is open in VS Code. Open one first.");
      }
      // Must be a local drive-letter path that is a real folder (blocks options like --foo and network paths)
      if (!/^[A-Za-z]:\\/.test(ws.path)) throw new ActionError("Project path not supported");
      let isDir = false;
      try {
        isDir = fs.statSync(ws.path).isDirectory();
      } catch {}
      if (!isDir) throw new ActionError("Project folder not found");
      const exe = resolveExe(CONFIG.vscodePath, VSCODE_CANDIDATES);
      if (!exe) throw new ActionError("VS Code not found. Set vscodePath in config.json.");
      await launch(exe, [ws.path]);
      return "Opened project in VS Code";
    },
  },

  volume_up: {
    label: "Volume up",
    validate: validateSteps,
    run: async ({ steps }) => {
      await sendKey(175, steps);
      return "Volume up";
    },
  },
  volume_down: {
    label: "Volume down",
    validate: validateSteps,
    run: async ({ steps }) => {
      await sendKey(174, steps);
      return "Volume down";
    },
  },
  volume_mute: {
    label: "Mute / unmute",
    run: async () => {
      await sendKey(173, 1);
      return "Mute toggled";
    },
  },

  media_play_pause: {
    label: "Play / pause",
    run: async () => {
      await sendKey(179, 1);
      return "Play/pause sent";
    },
  },
  media_next: {
    label: "Next track",
    run: async () => {
      await sendKey(176, 1);
      return "Next track sent";
    },
  },
  media_prev: {
    label: "Previous track",
    run: async () => {
      await sendKey(177, 1);
      return "Previous track sent";
    },
  },

  lock_pc: {
    label: "Lock PC",
    run: async () => {
      await launch(path.join(env.SystemRoot || "C:\\Windows", "System32", "rundll32.exe"), ["user32.dll,LockWorkStation"]);
      return "PC locked";
    },
  },
  sleep_pc: {
    label: "Sleep PC",
    run: async () => {
      await launch(path.join(env.SystemRoot || "C:\\Windows", "System32", "rundll32.exe"), ["powrprof.dll,SetSuspendState", "0,1,0"]);
      return "Going to sleep";
    },
  },
};

module.exports = { ACTIONS, ActionError };