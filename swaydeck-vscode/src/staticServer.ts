import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { log } from "./extension";

/**
 * Built-in static file server used as the fallback for "static" projects when
 * Live Server is not installed or did not start.
 *
 * Security model:
 *  - binds 127.0.0.1 only, never 0.0.0.0 and never a LAN address;
 *  - only GET and HEAD are answered;
 *  - the Host header must name this exact port (DNS rebinding protection);
 *  - no directory listings, no CORS headers, X-Content-Type-Options: nosniff;
 *  - dot-prefixed path segments (.env, .git, .vscode, ...) and node_modules are
 *    never served;
 *  - the real path of the served file must stay inside the workspace root, so
 *    symlinks cannot escape the project;
 *  - nothing about file contents is ever logged.
 */

const STATIC_PORT_MIN = 5600;
const STATIC_PORT_MAX = 5610;

/** Only ever bound to the loopback interface. */
const BIND_HOST = "127.0.0.1";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
};

const DEFAULT_CONTENT_TYPE = "application/octet-stream";

export interface StaticServerInfo {
  server: http.Server;
  port: number;
  url: string;
}

/** Built-in servers keyed by workspace path. */
const servers = new Map<string, StaticServerInfo>();

/**
 * Returns the built-in server tracked for a workspace path, or undefined.
 * A tracked server that is no longer listening is dropped from the map.
 */
export function getTrackedServer(workspacePath: string): StaticServerInfo | undefined {
  const info = servers.get(workspacePath);
  if (!info) {
    return undefined;
  }
  if (!info.server.listening) {
    servers.delete(workspacePath);
    return undefined;
  }
  return info;
}

/**
 * Starts a built-in static server for `root` on the first free port in
 * 5600-5610, or returns undefined when none of them is free.
 */
export async function startStaticServer(
  root: string
): Promise<StaticServerInfo | undefined> {
  const existing = getTrackedServer(root);
  if (existing) {
    return existing;
  }

  for (let port = STATIC_PORT_MIN; port <= STATIC_PORT_MAX; port += 1) {
    const server = http.createServer();
    server.on("request", (req, res) => {
      const address = server.address();
      const listeningPort =
        address && typeof address === "object" ? address.port : port;
      handleRequest(root, listeningPort, req, res);
    });

    if (await tryListen(server, port)) {
      const info: StaticServerInfo = {
        server,
        port,
        url: `http://localhost:${port}`,
      };
      servers.set(root, info);
      log(`static server started on ${port}`);
      return info;
    }

    // Not listening: throw the half-open server away and try the next port.
    try {
      server.close();
    } catch {
      // Ignore: the server never started listening.
    }
  }

  return undefined;
}

/** Closes the built-in server for a workspace path. Returns true when one was closed. */
export function stopStaticServer(workspacePath: string): boolean {
  const info = servers.get(workspacePath);
  if (!info) {
    return false;
  }
  servers.delete(workspacePath);
  closeQuietly(info);
  return true;
}

/** Closes every built-in server. Used by deactivate(). */
export function stopAllStaticServers(): void {
  for (const info of servers.values()) {
    closeQuietly(info);
  }
  servers.clear();
}

function closeQuietly(info: StaticServerInfo): void {
  try {
    info.server.close();
  } catch {
    // Ignore: the server is already gone.
  }
  log(`static server stopped on ${info.port}`);
}

function tryListen(server: http.Server, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const onError = (): void => {
      cleanup();
      resolve(false);
    };
    const onListening = (): void => {
      cleanup();
      resolve(true);
    };
    const cleanup = (): void => {
      server.removeListener("error", onError);
      server.removeListener("listening", onListening);
    };

    server.once("error", onError);
    server.once("listening", onListening);
    try {
      server.listen(port, BIND_HOST);
    } catch {
      cleanup();
      resolve(false);
    }
  });
}

function handleRequest(
  root: string,
  port: number,
  req: http.IncomingMessage,
  res: http.ServerResponse
): void {
  try {
    const method = req.method ?? "";
    if (method !== "GET" && method !== "HEAD") {
      respondText(res, 405, "Method Not Allowed");
      return;
    }

    // DNS rebinding protection: the Host header must name this exact port.
    const host = req.headers.host;
    if (
      typeof host !== "string" ||
      (host !== `localhost:${port}` && host !== `127.0.0.1:${port}`)
    ) {
      respondText(res, 403, "Forbidden");
      return;
    }

    const rawUrl = req.url ?? "/";
    const queryIndex = rawUrl.search(/[?#]/);
    const rawPath = queryIndex === -1 ? rawUrl : rawUrl.slice(0, queryIndex);

    let decoded: string;
    try {
      decoded = decodeURIComponent(rawPath);
    } catch {
      respondText(res, 400, "Bad Request");
      return;
    }

    if (decoded.includes("\0") || decoded.includes("\\")) {
      respondText(res, 400, "Bad Request");
      return;
    }

    const segments = decoded.split("/").filter((segment) => segment.length > 0);
    for (const segment of segments) {
      // Blocks .env, .git, .vscode, "..", and dependencies.
      if (segment.startsWith(".") || segment === "node_modules") {
        respondText(res, 404, "Not Found");
        return;
      }
    }

    const targetPath = path.join(root, ...segments);
    const filePath = resolveFile(targetPath);
    if (!filePath) {
      respondText(res, 404, "Not Found");
      return;
    }

    serveFile(root, filePath, req, res);
  } catch (err) {
    log(
      `Static server request failed: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    respondText(res, 500, "Internal Server Error");
  }
}

/**
 * Turns a request path into a file to serve: a directory serves its
 * index.html, anything else that is not a file is not found.
 */
function resolveFile(targetPath: string): string | undefined {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(targetPath);
  } catch {
    return undefined;
  }

  if (stat.isDirectory()) {
    const indexPath = path.join(targetPath, "index.html");
    try {
      if (!fs.statSync(indexPath).isFile()) {
        return undefined;
      }
    } catch {
      return undefined;
    }
    return indexPath;
  }

  return stat.isFile() ? targetPath : undefined;
}

function serveFile(
  root: string,
  filePath: string,
  req: http.IncomingMessage,
  res: http.ServerResponse
): void {
  let realRoot: string;
  let realFile: string;
  let stat: fs.Stats;
  try {
    realRoot = fs.realpathSync(root);
    realFile = fs.realpathSync(filePath);
    stat = fs.statSync(realFile);
  } catch {
    respondText(res, 404, "Not Found");
    return;
  }

  // Symlink escapes are rejected here, not just at the path level.
  const relative = path.relative(realRoot, realFile);
  if (relative.startsWith("..") || path.isAbsolute(relative) || !stat.isFile()) {
    respondText(res, 404, "Not Found");
    return;
  }

  const contentType =
    CONTENT_TYPES[path.extname(realFile).toLowerCase()] ?? DEFAULT_CONTENT_TYPE;

  res.statusCode = 200;
  res.setHeader("Content-Type", contentType);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Length", String(stat.size));

  if (req.method === "HEAD") {
    res.end();
    return;
  }

  const stream = fs.createReadStream(realFile);
  let started = false;
  stream.on("open", () => {
    started = true;
    stream.pipe(res);
  });
  stream.on("error", (err) => {
    log(`Static server stream failed: ${err.message}`);
    if (started) {
      res.destroy();
    } else {
      respondText(res, 500, "Internal Server Error");
    }
  });
}

function respondText(res: http.ServerResponse, status: number, text: string): void {
  const body = Buffer.from(text, "utf8");
  try {
    res.writeHead(status, {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Length": String(body.length),
    });
  } catch {
    res.destroy();
    return;
  }
  res.end(body);
}
