import WebSocket from "ws";
import { RunResult, WorkspacePayload } from "./types";

const BACKOFF_START_MS = 500;
const BACKOFF_MAX_MS = 8000;

/** Incoming messages at or above this size are dropped. */
const MAX_INCOMING_BYTES = 4 * 1024;

/** Maximum accepted length of a `run_project` request id. */
const MAX_ID_CHARS = 64;

/** Agent close code meaning "the pairing token was rejected". */
const CLOSE_TOKEN_REJECTED = 4001;

/** Agent close code meaning "another VS Code window took this socket over". */
const CLOSE_REPLACED = 4003;

export type ConnectionState =
  | "connected"
  | "offline"
  | "not-paired"
  | "rejected"
  /** Another VS Code window is the active one; this window is not retrying. */
  | "standby";

export interface AgentClientDeps {
  /** Reads the pairing token from SecretStorage. */
  getToken: () => Promise<string | undefined>;
  /** Builds the current workspace payload. Must never throw. */
  getWorkspacePayload: () => WorkspacePayload;
  /** Returns a validated agent URL, or undefined when the configured URL is not allowed. */
  getAgentUrl: () => string | undefined;
  /** Runs the detected project. Never throws; always resolves with a result. */
  runProject: () => Promise<RunResult>;
  /** Appends a line to the output channel. Never receives the token. */
  log: (message: string) => void;
  onStateChange: (state: ConnectionState) => void;
  /** Called when the agent rejects the pairing token (close code 4001). */
  onTokenRejected: () => void;
  /**
   * Called when another VS Code window replaced this socket (close code 4003).
   * Reconnection is not automatic here: the window decides whether it should
   * take the socket back.
   */
  onReplaced: () => void;
}

/**
 * Single-socket WebSocket client for the local SwayDeck PC agent.
 *
 * Responsibilities:
 *  - authenticate with the stored token,
 *  - report the workspace payload on welcome and on every detected change,
 *  - answer `get_workspace` requests,
 *  - reconnect with exponential backoff (except on token rejection, and except
 *    when another window replaced this one).
 *
 * It never executes commands, spawns processes, or reads file contents.
 */
export class AgentClient {
  private socket: WebSocket | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private reconnectDelay = BACKOFF_START_MS;
  private welcomed = false;
  private connecting = false;
  private disposed = false;
  private state: ConnectionState = "offline";

  constructor(private readonly deps: AgentClientDeps) {}

  public getState(): ConnectionState {
    return this.state;
  }

  /** Initial entry point: connects only when a token is stored. */
  public async start(): Promise<void> {
    await this.tryConnect();
  }

  /** Forces an immediate reconnect, resetting the backoff. */
  public async reconnect(): Promise<void> {
    this.deps.log("Manual reconnect requested.");
    this.clearReconnectTimer();
    this.reconnectDelay = BACKOFF_START_MS;
    this.closeSocket();
    await this.tryConnect();
  }

  /**
   * Connects immediately when this window is standing by or offline.
   *
   * Does nothing when already connected, when a connect attempt is in flight,
   * when the window was disposed, or when the pairing token was rejected
   * (close code 4001) - a rejected window must not hammer the agent.
   */
  public async activate(): Promise<void> {
    if (this.state !== "standby" && this.state !== "offline") {
      return;
    }
    if (this.disposed || this.socket || this.connecting) {
      return;
    }
    this.clearReconnectTimer();
    this.reconnectDelay = BACKOFF_START_MS;
    await this.tryConnect();
  }

  /** Sends the current workspace payload if the socket is welcomed and open. */
  public sendWorkspace(): void {
    if (!this.socket || !this.welcomed) {
      return;
    }
    this.sendJson(this.socket, {
      type: "workspace",
      workspace: this.deps.getWorkspacePayload(),
    });
  }

  /** Cleans up timers and the socket. Safe to call more than once. */
  public dispose(): void {
    this.disposed = true;
    this.clearReconnectTimer();
    this.closeSocket();
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) {
      return;
    }
    this.state = state;
    this.deps.onStateChange(state);
  }

  private async tryConnect(): Promise<void> {
    if (this.disposed || this.socket || this.connecting) {
      return;
    }

    // Claim the connect slot before the first await: two calls arriving in the
    // same tick (a focus event racing the takeover timer) would otherwise both
    // pass the guard above and open two sockets.
    this.connecting = true;

    const url = this.deps.getAgentUrl();
    if (!url) {
      this.connecting = false;
      this.deps.log(
        "Refusing to connect: swaydeck.agentUrl must be a ws:// URL on 127.0.0.1 or localhost."
      );
      this.setState("offline");
      return;
    }

    const token = await this.deps.getToken();
    if (this.disposed) {
      this.connecting = false;
      return;
    }
    if (!token) {
      this.connecting = false;
      this.deps.log("No pairing token stored; not connecting.");
      this.setState("not-paired");
      return;
    }

    this.deps.log(`Connecting to ${url} ...`);

    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch (err) {
      this.connecting = false;
      this.deps.log(`Failed to create socket: ${String(err)}`);
      this.setState("offline");
      this.scheduleReconnect();
      return;
    }

    this.socket = socket;

    socket.on("open", () => this.handleOpen(socket, token));
    socket.on("message", (data: WebSocket.RawData) =>
      this.handleMessage(socket, data)
    );
    socket.on("close", (code: number, reason: Buffer) =>
      this.handleClose(socket, code, reason)
    );
    socket.on("error", (err: Error) => this.handleError(err));
  }

  private handleOpen(socket: WebSocket, token: string): void {
    if (socket !== this.socket || this.disposed) {
      return;
    }
    this.connecting = false;
    this.welcomed = false;
    this.deps.log("Socket open; sending auth.");
    this.sendJson(socket, { type: "auth", role: "extension", token });
  }

  private handleMessage(socket: WebSocket, data: WebSocket.RawData): void {
    if (socket !== this.socket || this.disposed) {
      return;
    }

    const text = rawDataToString(data);
    if (text === undefined) {
      this.deps.log("Dropped incoming message: unsupported frame type.");
      return;
    }
    if (Buffer.byteLength(text, "utf8") >= MAX_INCOMING_BYTES) {
      this.deps.log("Dropped incoming message: exceeds 4 KB.");
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.deps.log("Dropped incoming message: invalid JSON.");
      return;
    }

    if (typeof parsed !== "object" || parsed === null) {
      this.deps.log("Dropped incoming message: not a JSON object.");
      return;
    }

    const message = parsed as { type?: unknown; id?: unknown };
    if (typeof message.type !== "string") {
      this.deps.log("Dropped incoming message: missing string 'type'.");
      return;
    }

    switch (message.type) {
      case "welcome":
        this.handleWelcome();
        break;
      case "get_workspace":
        this.handleGetWorkspace(message.id);
        break;
      case "run_project":
        this.handleRunProject(message.id);
        break;
      default:
        // Unknown message types are ignored on purpose.
        break;
    }
  }

  private handleWelcome(): void {
    this.welcomed = true;
    this.reconnectDelay = BACKOFF_START_MS;
    this.setState("connected");
    this.deps.log("Received welcome from agent.");
    this.sendWorkspace();
  }

  private handleGetWorkspace(id: unknown): void {
    if (!this.socket) {
      return;
    }
    if (typeof id !== "string") {
      this.deps.log("Ignored get_workspace without a string id.");
      return;
    }
    this.sendJson(this.socket, {
      type: "workspace",
      id,
      workspace: this.deps.getWorkspacePayload(),
    });
  }

  private handleRunProject(id: unknown): void {
    const socket = this.socket;
    if (!socket) {
      return;
    }
    if (typeof id !== "string" || id.length > MAX_ID_CHARS) {
      this.deps.log("Dropped run_project: id must be a string of at most 64 chars.");
      return;
    }

    void this.deps
      .runProject()
      .then((result) => {
        if (socket !== this.socket) {
          return;
        }
        this.sendJson(socket, {
          type: "run_result",
          id,
          ok: result.ok,
          status: result.status,
          message: result.message,
          projectType: result.projectType,
          options: result.options,
          url: result.url ?? null,
        });
      })
      .catch((err: unknown) => {
        this.deps.log(`run_project failed before replying: ${String(err)}`);
      });
  }

  private handleClose(socket: WebSocket, code: number, reason: Buffer): void {
    if (socket !== this.socket) {
      return;
    }
    this.socket = undefined;
    this.connecting = false;
    this.welcomed = false;

    if (this.disposed) {
      return;
    }

    const reasonText =
      reason && reason.length > 0 ? `: ${reason.toString("utf8")}` : "";
    this.deps.log(`Socket closed (code ${code}${reasonText}).`);

    if (code === CLOSE_TOKEN_REJECTED) {
      this.setState("rejected");
      this.deps.onTokenRejected();
      // Token rejection is not retried automatically.
      return;
    }

    if (code === CLOSE_REPLACED) {
      // Another window is the active one. Backing off here would make the two
      // windows kick each other out forever, so this window stands by and only
      // the window that is actually focused is allowed to take the socket back.
      this.setState("standby");
      this.deps.onReplaced();
      return;
    }

    this.setState("offline");
    this.scheduleReconnect();
  }

  private handleError(err: Error): void {
    // A close event normally follows; reconnection is handled there.
    this.deps.log(`Socket error: ${err.message}`);
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer) {
      return;
    }
    const delay = this.reconnectDelay;
    this.deps.log(`Reconnecting in ${delay} ms.`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.tryConnect();
    }, delay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, BACKOFF_MAX_MS);
  }

  private sendJson(socket: WebSocket, message: unknown): void {
    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }
    try {
      socket.send(JSON.stringify(message));
    } catch (err) {
      this.deps.log(`Failed to send message: ${String(err)}`);
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private closeSocket(): void {
    const socket = this.socket;
    this.socket = undefined;
    this.connecting = false;
    this.welcomed = false;
    if (!socket) {
      return;
    }
    try {
      // Drop listeners first so the close event cannot schedule a reconnect.
      socket.removeAllListeners();
      socket.close();
    } catch {
      // Ignore: the socket is already unusable.
    }
  }
}

function rawDataToString(data: WebSocket.RawData): string | undefined {
  try {
    if (typeof data === "string") {
      return data;
    }
    if (Buffer.isBuffer(data)) {
      return data.toString("utf8");
    }
    if (data instanceof ArrayBuffer) {
      return Buffer.from(data).toString("utf8");
    }
    if (Array.isArray(data)) {
      return Buffer.concat(data).toString("utf8");
    }
    return undefined;
  } catch {
    return undefined;
  }
}
