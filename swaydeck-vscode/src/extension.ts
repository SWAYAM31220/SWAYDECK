import * as path from "path";
import { URL } from "url";
import * as vscode from "vscode";
import { AgentClient, ConnectionState } from "./agentClient";
import { detectProject } from "./detector";
import { runProject } from "./projectRunner";
import { stopAllStaticServers, stopStaticServer } from "./staticServer";
import { WorkspaceFolderInfo, WorkspacePayload } from "./types";

const TOKEN_SECRET_KEY = "swaydeck.pairingToken";
const DEFAULT_AGENT_URL = "ws://127.0.0.1:3000/ext";
const CONFIG_SECTION = "swaydeck";
const DEBOUNCE_MS = 300;
const WATCHED_ROOT_FILES = "{package.json,main.py,index.html}";

let outputChannel: vscode.OutputChannel | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;
let client: AgentClient | undefined;

let debounceTimer: NodeJS.Timeout | undefined;
let replacedTimer: NodeJS.Timeout | undefined;
let lastPayloadJson = "";
let offeredPairingThisSession = false;

/** Delay before a focused window tries to take the socket back after a 4003. */
const TAKEOVER_DELAY_MS = 1000;

const STANDBY_TOOLTIP =
  "Another VS Code window is controlling the deck. Focus this window to take over.";

const fileWatchers: vscode.Disposable[] = [];

export function activate(context: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel("SwayDeck");
  context.subscriptions.push(outputChannel);

  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );
  statusBarItem.command = "swaydeck.showStatus";
  statusBarItem.text = "$(debug-disconnect) SwayDeck: Offline";
  statusBarItem.tooltip = "SwayDeck Bridge";
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  client = new AgentClient({
    getToken: () => Promise.resolve(context.secrets.get(TOKEN_SECRET_KEY)),
    getWorkspacePayload: buildWorkspacePayload,
    getAgentUrl: () => validateAgentUrl(getAgentUrlSetting()),
    runProject,
    log,
    onStateChange: handleStateChange,
    onTokenRejected: handleTokenRejected,
    onReplaced: handleReplaced,
  });
  context.subscriptions.push({ dispose: () => client?.dispose() });

  context.subscriptions.push(
    vscode.commands.registerCommand("swaydeck.setToken", () =>
      setPairingToken(context.secrets)
    ),
    vscode.commands.registerCommand("swaydeck.reconnect", async () => {
      await client?.reconnect();
    }),
    vscode.commands.registerCommand("swaydeck.showWorkspaceInfo", () =>
      showWorkspaceInfo()
    ),
    vscode.commands.registerCommand("swaydeck.showStatus", () => showStatus()),
    vscode.commands.registerCommand("swaydeck.runProject", () =>
      showRunResult()
    ),
    vscode.commands.registerCommand("swaydeck.stopStaticServer", () =>
      stopStaticServerCommand()
    )
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      rebuildFileWatchers();
      scheduleRefresh();
    }),
    vscode.window.onDidChangeActiveTextEditor(() => scheduleRefresh()),
    vscode.workspace.onDidGrantWorkspaceTrust(() => scheduleRefresh()),
    // The window the user just focused takes the socket over from the others.
    vscode.window.onDidChangeWindowState((windowState) => {
      if (windowState.focused) {
        void client?.activate();
      }
    })
  );

  rebuildFileWatchers();

  log("SwayDeck Bridge activated.");
  void client.start();
}

export function deactivate(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = undefined;
  }
  if (replacedTimer) {
    clearTimeout(replacedTimer);
    replacedTimer = undefined;
  }
  client?.dispose();
  client = undefined;
  disposeFileWatchers();
  stopAllStaticServers();
}

export function log(message: string): void {
  outputChannel?.appendLine(`[${new Date().toISOString()}] ${message}`);
}

function getAgentUrlSetting(): string {
  return vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .get<string>("agentUrl", DEFAULT_AGENT_URL);
}

/**
 * Accepts only ws:// URLs whose host is exactly 127.0.0.1 or localhost.
 * Returns undefined for anything else so the client refuses to connect.
 */
function validateAgentUrl(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "ws:") {
    return undefined;
  }
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
    return undefined;
  }
  return url.toString();
}

/** Picks the workspace folder that contains the active file, else the first one. */
function getPrimaryFolder(): vscode.WorkspaceFolder | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return undefined;
  }
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    const containing = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    if (containing) {
      return containing;
    }
  }
  return folders[0];
}

export function buildWorkspacePayload(): WorkspacePayload {
  const trusted = vscode.workspace.isTrusted;
  const editor = vscode.window.activeTextEditor;
  const activeFile = editor ? path.basename(editor.document.uri.fsPath) : null;
  const folders = vscode.workspace.workspaceFolders;

  if (!folders || folders.length === 0) {
    const detection = detectProject(null);
    return {
      open: false,
      name: null,
      path: null,
      multiRoot: false,
      folders: [],
      trusted,
      projectType: "none",
      detected: detection.detected,
      details: detection.details,
      activeFile,
    };
  }

  const folderInfos: WorkspaceFolderInfo[] = folders.map((folder) => ({
    name: folder.name,
    path: folder.uri.fsPath,
  }));

  const primary = getPrimaryFolder() ?? folders[0];
  const rootPath = primary.uri.fsPath;
  const detection = detectProject(rootPath);

  return {
    open: true,
    name: primary.name,
    path: rootPath,
    multiRoot: folders.length > 1,
    folders: folderInfos,
    trusted,
    projectType: detection.projectType,
    detected: detection.detected,
    details: detection.details,
    activeFile,
  };
}

function scheduleRefresh(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }
  debounceTimer = setTimeout(() => {
    debounceTimer = undefined;
    refreshAndReport();
  }, DEBOUNCE_MS);
}

function refreshAndReport(): void {
  const payload = buildWorkspacePayload();
  const json = JSON.stringify(payload);
  if (json === lastPayloadJson) {
    return;
  }
  lastPayloadJson = json;
  log(`Workspace changed: ${json}`);
  client?.sendWorkspace();
}

function showWorkspaceInfo(): void {
  const payload = buildWorkspacePayload();
  lastPayloadJson = JSON.stringify(payload);
  log("Workspace info requested.");
  outputChannel?.appendLine(JSON.stringify(payload, null, 2));
  outputChannel?.show(true);
}

function showStatus(): void {
  void vscode.window.showInformationMessage(
    `SwayDeck: ${stateLabel(client?.getState() ?? "offline")}`
  );
}

/**
 * Runs the project locally (no agent needed) and reports the outcome. Useful for
 * testing the run flow without the phone.
 */
async function showRunResult(): Promise<void> {
  const result = await runProject();
  const message = `SwayDeck: ${result.message}`;
  switch (result.status) {
    case "started":
    case "already_running":
      void vscode.window.showInformationMessage(message);
      break;
    case "ambiguous":
      void vscode.window.showWarningMessage(message);
      break;
    default:
      void vscode.window.showErrorMessage(message);
      break;
  }
}

/**
 * Stops the built-in static server for the current workspace. Live Server is
 * never touched.
 */
function stopStaticServerCommand(): void {
  const payload = buildWorkspacePayload();
  const stopped = payload.path ? stopStaticServer(payload.path) : false;
  log(stopped ? "Built-in static server stopped." : "No built-in static server to stop.");
  void vscode.window.showInformationMessage(
    stopped
      ? "SwayDeck: Built-in static server stopped."
      : "SwayDeck: No built-in static server is running for this workspace."
  );
}

function stateLabel(state: ConnectionState): string {
  switch (state) {
    case "connected":
      return "Connected";
    case "not-paired":
      return "Not paired";
    case "rejected":
      return "Pairing rejected";
    case "standby":
      return "Standby";
    default:
      return "Offline";
  }
}

function handleStateChange(state: ConnectionState): void {
  if (statusBarItem) {
    statusBarItem.text = statusBarText(state);
    statusBarItem.tooltip = statusBarTooltip(state);
  }
  log(`Connection state: ${stateLabel(state)}.`);
  if (state === "not-paired") {
    offerPairingOnce();
  }
}

function statusBarText(state: ConnectionState): string {
  switch (state) {
    case "connected":
      return "$(plug) SwayDeck: Connected";
    case "not-paired":
      return "$(key) SwayDeck: Not paired";
    case "rejected":
      return "$(key) SwayDeck: Pairing rejected";
    case "standby":
      return "SwayDeck: Standby";
    default:
      return "$(debug-disconnect) SwayDeck: Offline";
  }
}

function statusBarTooltip(state: ConnectionState): string {
  return state === "standby" ? STANDBY_TOOLTIP : "SwayDeck Bridge";
}

/**
 * Called when another window took the socket over. Only the focused window is
 * allowed to take it back, and only once, shortly after: because exactly one
 * window can be focused, the two windows cannot keep kicking each other out.
 */
function handleReplaced(): void {
  if (!vscode.window.state.focused) {
    return;
  }
  if (replacedTimer) {
    clearTimeout(replacedTimer);
  }
  replacedTimer = setTimeout(() => {
    replacedTimer = undefined;
    void client?.activate();
  }, TAKEOVER_DELAY_MS);
}

async function setPairingToken(secrets: vscode.SecretStorage): Promise<void> {
  const token = await vscode.window.showInputBox({
    title: "SwayDeck: Set Pairing Token",
    prompt: "Enter the pairing token for the local SwayDeck agent.",
    password: true,
    ignoreFocusOut: true,
  });
  if (token === undefined) {
    return;
  }
  await secrets.store(TOKEN_SECRET_KEY, token);
  // The token value itself is never logged or displayed.
  log("Pairing token stored.");
  void vscode.window.showInformationMessage("SwayDeck: Pairing token saved.");
  await client?.reconnect();
}

function offerPairingOnce(): void {
  if (offeredPairingThisSession) {
    return;
  }
  offeredPairingThisSession = true;
  void vscode.window
    .showInformationMessage(
      "SwayDeck: Not paired with the local agent. Set a pairing token to connect.",
      "Set Pairing Token"
    )
    .then((choice) => {
      if (choice === "Set Pairing Token") {
        void vscode.commands.executeCommand("swaydeck.setToken");
      }
    });
}

function handleTokenRejected(): void {
  void vscode.window
    .showWarningMessage(
      "SwayDeck: Pairing rejected by the agent. Please set a valid pairing token.",
      "Set Pairing Token"
    )
    .then((choice) => {
      if (choice === "Set Pairing Token") {
        void vscode.commands.executeCommand("swaydeck.setToken");
      }
    });
}

function rebuildFileWatchers(): void {
  disposeFileWatchers();
  const folders = vscode.workspace.workspaceFolders ?? [];
  for (const folder of folders) {
    const pattern = new vscode.RelativePattern(folder, WATCHED_ROOT_FILES);
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    watcher.onDidCreate(() => scheduleRefresh());
    watcher.onDidChange(() => scheduleRefresh());
    watcher.onDidDelete(() => scheduleRefresh());
    fileWatchers.push(watcher);
  }
}

function disposeFileWatchers(): void {
  while (fileWatchers.length > 0) {
    fileWatchers.pop()?.dispose();
  }
}
