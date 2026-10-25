import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import * as vscode from "vscode";
import { buildWorkspacePayload, log } from "./extension";
import { findOnPath } from "./pathCheck";
import { getTrackedServer, startStaticServer } from "./staticServer";
import { ProjectType, RunResult, RunStatus, WorkspacePayload } from "./types";

/**
 * The only two strings this extension ever passes to Terminal.sendText.
 * They are fixed literals: no agent message, package.json content, or file name
 * is ever used to build a command.
 */
const NODE_COMMAND = "npm run dev";
const PYTHON_COMMAND = "python main.py";

const NPM_NAMES = ["npm.cmd", "npm.exe", "npm"];
const PYTHON_NAMES = ["python.exe", "python"];

const MAX_MESSAGE_CHARS = 200;
const MAX_OPTIONS = 5;

/** VS Code Marketplace id of the Live Server extension. */
const LIVE_SERVER_EXTENSION_ID = "ritwickdey.LiveServer";
const LIVE_SERVER_PORT_MIN = 1024;
const LIVE_SERVER_PORT_MAX = 65535;
const LIVE_SERVER_PROBE_TIMEOUT_MS = 800;
const LIVE_SERVER_PROBE_ATTEMPTS = 6;
const LIVE_SERVER_PROBE_INTERVAL_MS = 500;

let runInProgress = false;

/**
 * Starts the detected project in a VS Code terminal.
 *
 * Detection and reporting of the workspace stay untouched; this only decides
 * whether a fixed, hard-coded command can be started and then runs it through
 * the terminal API. It never executes a process directly.
 */
export async function runProject(): Promise<RunResult> {
  if (runInProgress) {
    return makeResult(false, "error", "A run is already in progress.", "none");
  }
  runInProgress = true;

  let projectType: ProjectType = "none";
  try {
    // Fresh payload at call time: the workspace may have changed since connect.
    const payload = buildWorkspacePayload();
    projectType = payload.projectType;

    if (!payload.open) {
      return makeResult(
        false,
        "error",
        "No project is open in VS Code. Open a project folder first.",
        projectType
      );
    }

    if (!payload.trusted) {
      return makeResult(
        false,
        "error",
        "This workspace is not trusted. Trust it in VS Code first.",
        projectType
      );
    }

    if (projectType === "ambiguous") {
      return makeResult(
        false,
        "ambiguous",
        "More than one project type detected. Pick one manually.",
        projectType,
        payload.detected.map((signal) => signal.type).slice(0, MAX_OPTIONS)
      );
    }

    if (projectType === "unknown") {
      return makeResult(
        false,
        "error",
        "No supported project found. Looking for package.json, main.py or index.html in the project root.",
        projectType
      );
    }

    if (projectType === "static") {
      // The static path runs no terminal command at all; it only starts a local
      // file server. The await keeps the re-entrancy guard held until it is done.
      return await runStatic(payload);
    }

    if (projectType === "node") {
      if (!findOnPath(NPM_NAMES)) {
        return makeResult(
          false,
          "error",
          "npm was not found on PATH. Install Node.js from nodejs.org.",
          projectType
        );
      }
      if (!payload.details.hasDevScript) {
        return makeResult(
          false,
          "error",
          'package.json has no "dev" script.',
          projectType
        );
      }
      if (!payload.path || !isDirectory(path.join(payload.path, "node_modules"))) {
        // npm install is never run automatically.
        return makeResult(
          false,
          "error",
          "Dependencies are not installed. Run npm install in the VS Code terminal first.",
          projectType
        );
      }
      return startInTerminal(payload, NODE_COMMAND);
    }

    if (projectType === "python") {
      const pythonPath = findOnPath(PYTHON_NAMES);
      if (!pythonPath) {
        return makeResult(
          false,
          "error",
          "Python was not found on PATH. Install Python from python.org and tick Add to PATH.",
          projectType
        );
      }
      if (pythonPath.toLowerCase().includes("windowsapps")) {
        return makeResult(
          false,
          "error",
          "Python looks like the Microsoft Store shortcut, not a real install. Install Python from python.org.",
          projectType
        );
      }
      return startInTerminal(payload, PYTHON_COMMAND);
    }

    // Only reachable when a folder is open but no signal matched, which the
    // detection layer reports as "unknown" above.
    return makeResult(
      false,
      "error",
      "No supported project found. Looking for package.json, main.py or index.html in the project root.",
      projectType
    );
  } catch (err) {
    log(`Run project failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    return makeResult(false, "error", "Failed to start the project.", projectType);
  } finally {
    runInProgress = false;
  }
}

/**
 * Serves a "static" project.
 *
 * Order: (A) a built-in server that is already running for this workspace,
 * (B) the Live Server extension, (C) the built-in static server as a fallback.
 * No terminal command is ever sent here.
 */
async function runStatic(payload: WorkspacePayload): Promise<RunResult> {
  const root = payload.path;
  if (!root) {
    return makeResult(
      false,
      "error",
      "No project folder path was detected.",
      payload.projectType
    );
  }

  // A. Built-in server already running for this workspace path.
  const tracked = getTrackedServer(root);
  if (tracked) {
    return makeResult(
      true,
      "already_running",
      `Already running at ${tracked.url}.`,
      payload.projectType,
      [],
      tracked.url
    );
  }

  // B. Live Server, only when the extension is installed and its port is usable.
  let prefix = "";
  const liveServer = vscode.extensions.getExtension(LIVE_SERVER_EXTENSION_ID);
  const liveServerPort = getLiveServerPort();
  if (liveServer && liveServerPort !== undefined) {
    if (await probeHttp(liveServerPort)) {
      const url = `http://localhost:${liveServerPort}`;
      return makeResult(
        true,
        "already_running",
        `A server is already running at ${url}. If it belongs to another project, stop it and tap again.`,
        payload.projectType,
        [],
        url
      );
    }

    try {
      await openIndexHtml(root);
      await vscode.commands.executeCommand("extension.liveServer.goOnline");

      let listening = false;
      for (let attempt = 0; attempt < LIVE_SERVER_PROBE_ATTEMPTS; attempt += 1) {
        await delay(LIVE_SERVER_PROBE_INTERVAL_MS);
        if (await probeHttp(liveServerPort)) {
          listening = true;
          break;
        }
      }

      if (listening) {
        const url = `http://localhost:${liveServerPort}`;
        return makeResult(
          true,
          "started",
          `Started Live Server at ${url}.`,
          payload.projectType,
          [],
          url
        );
      }
      prefix = "Live Server did not start. ";
    } catch (err) {
      log(
        `Live Server path failed: ${
          err instanceof Error ? err.stack ?? err.message : String(err)
        }`
      );
    }
  }

  // C. Built-in static server fallback.
  const info = await startStaticServer(root);
  if (!info) {
    return makeResult(
      false,
      "error",
      `${prefix}Could not start a local server: no free port in 5600-5610.`,
      payload.projectType
    );
  }

  try {
    await vscode.env.openExternal(vscode.Uri.parse(info.url));
  } catch (err) {
    log(
      `Failed to open ${info.url}: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  return makeResult(
    true,
    "started",
    `${prefix}Started built-in static server at ${info.url}. (Live Server not used.)`,
    payload.projectType,
    [],
    info.url
  );
}

/**
 * Reads liveServer.settings.port. Returns it only when it is an integer in
 * 1024-65535; 0 or anything else means the URL would be unpredictable.
 */
function getLiveServerPort(): number | undefined {
  let raw: unknown;
  try {
    raw = vscode.workspace
      .getConfiguration("liveServer.settings")
      .get<number>("port", 5500);
  } catch {
    return undefined;
  }
  if (
    typeof raw !== "number" ||
    !Number.isInteger(raw) ||
    raw < LIVE_SERVER_PORT_MIN ||
    raw > LIVE_SERVER_PORT_MAX
  ) {
    return undefined;
  }
  return raw;
}

/** Any HTTP response (even a 404) means something is listening on the port. */
function probeHttp(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };

    let request: http.ClientRequest;
    try {
      request = http.get(
        {
          host: "127.0.0.1",
          port,
          path: "/",
          timeout: LIVE_SERVER_PROBE_TIMEOUT_MS,
        },
        (response) => {
          response.resume();
          finish(true);
        }
      );
    } catch {
      finish(false);
      return;
    }

    request.on("timeout", () => {
      request.destroy();
      finish(false);
    });
    request.on("error", () => {
      finish(false);
    });
  });
}

async function openIndexHtml(root: string): Promise<void> {
  const document = await vscode.workspace.openTextDocument(
    vscode.Uri.file(path.join(root, "index.html"))
  );
  await vscode.window.showTextDocument(document, { preview: false });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Shows the existing "SwayDeck: <name>" terminal, or creates it and sends the
 * fixed command. The command argument is always one of the two literals above.
 */
function startInTerminal(payload: WorkspacePayload, command: string): RunResult {
  if (!payload.path) {
    return makeResult(
      false,
      "error",
      "No project folder path was detected.",
      payload.projectType
    );
  }

  const terminalName = `SwayDeck: ${payload.name}`;
  const existing = vscode.window.terminals.find(
    (terminal) => terminal.name === terminalName && terminal.exitStatus === undefined
  );

  if (existing) {
    existing.show(true);
    return makeResult(
      true,
      "already_running",
      `Already running in terminal "${terminalName}". Close that terminal if the server has stopped.`,
      payload.projectType
    );
  }

  const terminal = vscode.window.createTerminal({
    name: terminalName,
    cwd: payload.path,
  });
  terminal.show(true);
  terminal.sendText(command);
  return makeResult(
    true,
    "started",
    `Started ${command} in VS Code terminal.`,
    payload.projectType
  );
}

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function makeResult(
  ok: boolean,
  status: RunStatus,
  message: string,
  projectType: ProjectType,
  options: string[] = [],
  url: string | null = null
): RunResult {
  return {
    ok,
    status,
    message:
      message.length > MAX_MESSAGE_CHARS ? message.slice(0, MAX_MESSAGE_CHARS) : message,
    projectType,
    options,
    url,
  };
}
