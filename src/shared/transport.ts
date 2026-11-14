/**
 * Shared transport factory for MCP servers.
 * Supports stdio (default) and HTTP transports via --transport flag.
 *
 * Multi-session HTTP mode: each client connection gets its own
 * StreamableHTTPServerTransport backed by its own Server instance, keyed by
 * session ID. A single Server cannot back multiple transports — its
 * initialization state is per-connection — so sharing one across clients makes
 * the second client fail with "already initialized".
 */

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

type TransportMode = "stdio" | "http";

/** URL path the MCP endpoint is served on unless --path or MCP_PATH says otherwise. */
export const DEFAULT_MCP_PATH = "/mcp";

/** Fixed health-check path. The MCP path may not shadow it. */
const HEALTH_PATH = "/health";

/** Largest accepted JSON-RPC request body. Guards against memory exhaustion
 *  from an unauthenticated POST to the MCP path. */
export const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;

/** Close a session after this long with no traffic. */
export const DEFAULT_SESSION_IDLE_MS = 300_000;

/** Ceiling on concurrent sessions. Each session holds a Server instance, so
 *  this bounds memory against a client that never reuses its session ID. */
export const DEFAULT_MAX_SESSIONS = 64;

/** Address the HTTP transport binds to unless --host or MCP_HOST says otherwise.
 *  Loopback by default: the endpoint exposes every tool, so listening on all
 *  interfaces has to be asked for (the Docker image sets MCP_HOST=0.0.0.0). */
export const DEFAULT_HTTP_HOST = "127.0.0.1";

/** Host header names accepted when bound to loopback with no explicit allow-list. */
const LOOPBACK_HOSTNAMES = ["localhost", "127.0.0.1", "[::1]"];

/** How often the idle sweeper runs. */
export const SESSION_SWEEP_INTERVAL_MS = 30_000;

export class BodyTooLargeError extends Error {
  constructor(limit: number) {
    super(`Request body exceeds ${limit} bytes`);
    this.name = "BodyTooLargeError";
  }
}

export class SessionLimitError extends Error {
  constructor(limit: number) {
    super(`Maximum of ${limit} concurrent sessions reached`);
    this.name = "SessionLimitError";
  }
}

/**
 * Read a request body, refusing anything over `maxBytes`.
 *
 * Length is tracked in bytes across chunks rather than trusting
 * Content-Length, which a client controls and may understate.
 */
export function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;

    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        // Pause rather than destroy: the caller still needs the socket open
        // long enough to write a 413 the client can actually read.
        req.pause();
        reject(new BodyTooLargeError(maxBytes));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** The subset of StreamableHTTPServerTransport the store depends on. */
interface SessionTransport {
  sessionId?: string;
  close(): Promise<void>;
  onclose?: (() => void) | undefined;
}

interface SessionEntry {
  transport: SessionTransport;
  lastActivity: number;
}

export interface SessionStoreOptions {
  maxSessions?: number;
  idleTimeoutMs?: number;
  /** Injectable clock — keeps idle-expiry behaviour testable. */
  now?: () => number;
}

/**
 * Tracks live HTTP sessions and expires idle ones.
 *
 * A single sweeper timer scans the map rather than one timer per session:
 * per-session timers leak whenever a session is dropped by a path that does
 * not own its timer.
 */
export class SessionStore {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly maxSessions: number;
  private readonly idleTimeoutMs: number;
  private readonly now: () => number;
  private sweeper?: ReturnType<typeof setInterval>;

  constructor(options: SessionStoreOptions = {}) {
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_SESSION_IDLE_MS;
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.sessions.size;
  }

  isFull(): boolean {
    return this.sessions.size >= this.maxSessions;
  }

  has(id: string): boolean {
    return this.sessions.has(id);
  }

  /** Register a session. Throws SessionLimitError when at capacity. */
  add(transport: SessionTransport): void {
    const id = transport.sessionId;
    if (!id) throw new Error("Cannot register a transport with no session ID");
    if (!this.sessions.has(id) && this.isFull()) {
      throw new SessionLimitError(this.maxSessions);
    }
    this.sessions.set(id, { transport, lastActivity: this.now() });
  }

  /** Look up a session, recording the lookup as activity. */
  get(id: string): SessionTransport | undefined {
    const entry = this.sessions.get(id);
    if (!entry) return undefined;
    entry.lastActivity = this.now();
    return entry.transport;
  }

  close(id: string): void {
    const entry = this.sessions.get(id);
    if (!entry) return;

    this.sessions.delete(id);
    // Detach before closing: the transport's own close path fires onclose,
    // which would otherwise re-enter here.
    entry.transport.onclose = undefined;
    void entry.transport.close().catch(() => {});
  }

  /** Close every session idle beyond the timeout. Returns the closed IDs. */
  sweep(): string[] {
    const deadline = this.now() - this.idleTimeoutMs;
    const expired: string[] = [];

    for (const [id, entry] of this.sessions) {
      if (entry.lastActivity < deadline) expired.push(id);
    }
    for (const id of expired) this.close(id);

    return expired;
  }

  closeAll(): void {
    for (const id of [...this.sessions.keys()]) this.close(id);
    this.stopSweeper();
  }

  startSweeper(intervalMs: number = SESSION_SWEEP_INTERVAL_MS): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => {
      for (const id of this.sweep()) {
        console.error(`Session ${id} expired after ${this.idleTimeoutMs}ms idle`);
      }
    }, intervalMs);
    // Do not hold the event loop open on this timer.
    this.sweeper.unref?.();
  }

  stopSweeper(): void {
    if (!this.sweeper) return;
    clearInterval(this.sweeper);
    this.sweeper = undefined;
  }
}

/**
 * Validate a configured MCP path and strip any trailing slash, so "/plex/" and
 * "/plex" serve the same endpoint. Throws on anything that is not a plain path.
 * Non-ASCII is refused because request paths arrive percent-encoded, so a
 * configured "/plëx" could never match.
 */
export function normalizeMcpPath(raw: string): string {
  if (!raw.startsWith("/") || /[?#]|[^\x21-\x7e]/.test(raw)) {
    throw new Error(
      `Invalid MCP path: "${raw}". It must start with "/" and contain only printable ASCII, with no query, fragment or whitespace.`
    );
  }
  const path = stripTrailingSlashes(raw);
  if (path === HEALTH_PATH) {
    throw new Error(`Invalid MCP path: "${raw}" is reserved for the health check.`);
  }
  return path;
}

function stripTrailingSlashes(path: string): string {
  return path.replace(/\/+$/, "") || "/";
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

/** True when a JSON-RPC body (single message or batch) carries an initialize request. */
function containsInitialize(body: unknown): boolean {
  return Array.isArray(body) ? body.some((m) => isInitializeRequest(m)) : isInitializeRequest(body);
}

function sendRpcError(res: ServerResponse, status: number, code: number, message: string): void {
  sendJson(res, status, { jsonrpc: "2.0", error: { code, message }, id: null });
}

/** True for an address that only accepts connections from this machine. */
export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/**
 * Hostname from a Host header, lowercased and without its port, or undefined
 * when the header is missing or does not parse. IPv6 keeps its brackets.
 */
export function hostnameFromHeader(header: string | undefined): string | undefined {
  if (!header) return undefined;
  try {
    return new URL(`http://${header}`).hostname.toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Which Host header names the MCP endpoint answers to, or undefined for "any".
 *
 * An explicit list always wins. Without one, a loopback bind only answers to
 * loopback names: that is what stops DNS rebinding, where a web page points
 * its own hostname at 127.0.0.1 and then talks to this server as same-origin.
 * A bind on a real interface is reached under whatever name the network gives
 * it, so it accepts any Host unless MCP_ALLOWED_HOSTS narrows it.
 */
export function resolveAllowedHosts(bindHost: string, configured?: string): string[] | undefined {
  const list = (configured ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean)
    .map((h) => hostnameFromHeader(h) ?? h.toLowerCase());
  if (list.length > 0) return list;
  return isLoopbackHost(bindHost) ? LOOPBACK_HOSTNAMES : undefined;
}

/** Constant-time check of an `Authorization: Bearer <token>` header. */
export function bearerTokenMatches(header: string | undefined, expected: string): boolean {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? "");
  if (!match) return false;
  // Hash both sides so the comparison is fixed-length and leaks nothing about
  // the token's length.
  const a = createHash("sha256").update(match[1].trim()).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export interface McpHandlerOptions {
  /** Called once per new session to build a dedicated Server instance. */
  getServer: () => Server;
  serverName: string;
  store: SessionStore;
  maxBodyBytes?: number;
  /** Path the MCP endpoint is served on. Defaults to DEFAULT_MCP_PATH. */
  mcpPath?: string;
  /** When set, every MCP request must send `Authorization: Bearer <authToken>`. */
  authToken?: string;
  /** Host header names to accept (lowercase, no port). Undefined accepts any. */
  allowedHosts?: string[];
  /** Ceiling on sessionless requests being served at once. Defaults to the session cap. */
  maxStatelessInFlight?: number;
}

/**
 * Build the node:http request handler for HTTP transport mode.
 *
 * Exposed separately from startServer so it can be exercised against an
 * ephemeral port without going through argv parsing.
 */
export function createMcpRequestHandler(options: McpHandlerOptions) {
  const { getServer, serverName, store } = options;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const mcpPath = normalizeMcpPath(options.mcpPath ?? DEFAULT_MCP_PATH);
  const { authToken, allowedHosts } = options;
  const maxStatelessInFlight = options.maxStatelessInFlight ?? DEFAULT_MAX_SESSIONS;
  let statelessInFlight = 0;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Fixed base: only the path is wanted here, and a client-supplied Host
    // header that fails to parse (e.g. "[") would otherwise throw.
    const url = new URL(req.url || "/", "http://localhost");

    if (url.pathname === HEALTH_PATH && req.method === "GET") {
      sendJson(res, 200, { status: "ok", server: serverName, sessions: store.size });
      return;
    }

    // Reverse proxies often forward the prefix with a trailing slash.
    if (stripTrailingSlashes(url.pathname) !== mcpPath) {
      sendJson(res, 404, {
        error: "Not Found",
        message: `Use POST ${mcpPath} for MCP requests, or GET ${HEALTH_PATH} for health check`,
      });
      return;
    }

    if (allowedHosts) {
      const hostname = hostnameFromHeader(req.headers.host);
      if (!hostname || !allowedHosts.includes(hostname)) {
        sendRpcError(res, 403, -32000, "Host not allowed");
        return;
      }
    }

    if (authToken && !bearerTokenMatches(req.headers.authorization, authToken)) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="mcp"');
      sendRpcError(res, 401, -32001, "Unauthorized");
      return;
    }

    const rawSessionId = req.headers["mcp-session-id"];
    const sessionId = typeof rawSessionId === "string" ? rawSessionId : undefined;

    // GET (SSE stream) and DELETE (session teardown) carry no body and always
    // belong to an existing session.
    if (req.method !== "POST") {
      if (!sessionId) {
        sendRpcError(res, 400, -32000, "Missing mcp-session-id header");
        return;
      }
      const transport = store.get(sessionId);
      if (!transport) {
        sendRpcError(res, 404, -32001, "Session not found or expired");
        return;
      }
      await (transport as StreamableHTTPServerTransport).handleRequest(req, res);
      return;
    }

    let rawBody: string;
    try {
      rawBody = await readBody(req, maxBodyBytes);
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        // Close the connection once the 413 is flushed — we are deliberately
        // not draining the rest of an oversized upload.
        res.setHeader("Connection", "close");
        res.once("finish", () => req.destroy());
        sendRpcError(res, 413, -32600, error.message);
        return;
      }
      sendRpcError(res, 400, -32600, "Failed to read request body");
      return;
    }

    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      sendRpcError(res, 400, -32700, "Parse error");
      return;
    }

    // ── Existing session ──────────────────────────────────────────────────
    if (sessionId) {
      const transport = store.get(sessionId);
      if (!transport) {
        sendRpcError(res, 404, -32001, "Session not found or expired");
        return;
      }
      await (transport as StreamableHTTPServerTransport).handleRequest(req, res, body);
      return;
    }

    // ── Sessionless request ───────────────────────────────────────────────
    // A request with no session ID that isn't an initialize can only be
    // answered statelessly. Some hosted MCP clients send tool calls this way
    // after the server restarts or their session expires, instead of
    // re-initializing; stateful mode would reject them with a 400 ("Server not
    // initialized") and the client gives up. Serve it with a throwaway Server
    // and transport that are closed once the response is sent.
    if (!containsInitialize(body)) {
      // These bypass the session store, so bound them separately: each one
      // builds a Server of its own.
      if (statelessInFlight >= maxStatelessInFlight) {
        sendRpcError(res, 503, -32000, "Server busy, try again later");
        return;
      }
      statelessInFlight++;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        statelessInFlight--;
      };
      const stateless = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      const server = getServer();
      res.on("close", () => {
        release();
        void stateless.close().catch(() => {});
        void server.close().catch(() => {});
      });
      await server.connect(stateless);
      await stateless.handleRequest(req, res, body);
      return;
    }

    // ── New session ───────────────────────────────────────────────────────
    if (store.isFull()) {
      sendRpcError(res, 503, -32000, "Server at session capacity, try again later");
      return;
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
    });

    transport.onclose = () => {
      if (transport.sessionId) store.close(transport.sessionId);
    };

    // A dedicated Server per session — the whole point of the session map.
    await getServer().connect(transport);
    await transport.handleRequest(req, res, body);

    // sessionId is only assigned once the initialize request has been handled.
    if (transport.sessionId) {
      try {
        store.add(transport);
        console.error(`Session ${transport.sessionId} initialized (total: ${store.size})`);
      } catch (error) {
        if (error instanceof SessionLimitError) {
          transport.onclose = undefined;
          void transport.close().catch(() => {});
          return;
        }
        throw error;
      }
    }
  }

  // An exception escaping an async request listener is an unhandled
  // rejection, which terminates the process. Answer 500 instead.
  return async function safeHandle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      await handle(req, res);
    } catch (error) {
      console.error("HTTP handler error:", error instanceof Error ? error.message : error);
      if (!res.headersSent) {
        sendRpcError(res, 500, -32603, "Internal server error");
      } else {
        res.destroy();
      }
    }
  };
}

function parseArgs(): { transport: TransportMode; port: number; mcpPath: string; host: string } {
  const args = process.argv.slice(2);
  let transport: TransportMode = "stdio";
  let port = 3000;
  let host = DEFAULT_HTTP_HOST;
  let mcpPath = DEFAULT_MCP_PATH;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--transport" && args[i + 1]) {
      const value = args[i + 1];
      if (value !== "stdio" && value !== "http") {
        throw new Error(`Invalid transport: ${value}. Must be "stdio" or "http".`);
      }
      transport = value;
      i++;
    }
    if (args[i] === "--port" && args[i + 1]) {
      port = parseInt(args[i + 1], 10);
      if (!Number.isFinite(port) || port < 1 || port > 65535) {
        throw new Error(`Invalid port: ${args[i + 1]}`);
      }
      i++;
    }
    if (args[i] === "--host" && args[i + 1]) {
      host = args[i + 1];
      i++;
    }
    if (args[i] === "--path" && args[i + 1]) {
      mcpPath = normalizeMcpPath(args[i + 1]);
      i++;
    }
  }

  if (process.env.MCP_PORT) {
    const envPort = parseInt(process.env.MCP_PORT, 10);
    if (Number.isFinite(envPort) && envPort >= 1 && envPort <= 65535) {
      port = envPort;
    }
  }

  if (process.env.MCP_PATH) {
    mcpPath = normalizeMcpPath(process.env.MCP_PATH);
  }

  if (process.env.MCP_HOST) {
    host = process.env.MCP_HOST.trim();
  }

  return { transport, port, mcpPath, host };
}

function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Start the server on the transport selected by argv.
 *
 * Takes a factory rather than an instance: HTTP mode needs a fresh Server per
 * session, and only the caller knows how to build one.
 */
export async function startServer(
  getServer: () => Server,
  serverName: string
): Promise<void> {
  const { transport, port, mcpPath, host } = parseArgs();

  if (transport === "stdio") {
    // One process, one client, one session — no session tracking needed.
    await getServer().connect(new StdioServerTransport());
    console.error(`${serverName} running on stdio`);
    return;
  }

  const store = new SessionStore({
    maxSessions: positiveIntFromEnv("MCP_MAX_SESSIONS", DEFAULT_MAX_SESSIONS),
    idleTimeoutMs:
      positiveIntFromEnv("SESSION_TIMEOUT_SECONDS", DEFAULT_SESSION_IDLE_MS / 1000) * 1000,
  });
  store.startSweeper();

  const authToken = process.env.MCP_AUTH_TOKEN?.trim() || undefined;
  const allowedHosts = resolveAllowedHosts(host, process.env.MCP_ALLOWED_HOSTS);

  if (!authToken && !isLoopbackHost(host)) {
    console.error(
      `WARNING: listening on ${host} with no MCP_AUTH_TOKEN set. Anyone who can reach ` +
        `port ${port} can use every tool, including your Plex token and any configured ` +
        `Sonarr/Radarr/Trakt credentials. Set MCP_AUTH_TOKEN, or keep the server behind ` +
        `something that authenticates.`
    );
  }

  const httpServer = createServer(
    createMcpRequestHandler({
      getServer,
      serverName,
      store,
      mcpPath,
      authToken,
      allowedHosts,
      maxStatelessInFlight: positiveIntFromEnv("MCP_MAX_SESSIONS", DEFAULT_MAX_SESSIONS),
    })
  );

  const shutdown = () => {
    store.closeAll();
    httpServer.close(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  httpServer.listen(port, host, () => {
    const shown = host.includes(":") ? `[${host}]` : host;
    console.error(`${serverName} running on http://${shown}:${port}${mcpPath}`);
    console.error(
      `  auth: ${authToken ? "bearer token required" : "none"}; ` +
        `Host check: ${allowedHosts ? allowedHosts.join(", ") : "off"}`
    );
  });
}
