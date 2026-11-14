import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createServer, type Server as HttpServer } from "node:http";
import net, { type AddressInfo } from "node:net";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";

import {
  SessionStore,
  createMcpRequestHandler,
  bearerTokenMatches,
  hostnameFromHeader,
  isLoopbackHost,
  originAllowed,
  parseArgs,
  resolveAllowedHosts,
  resolveAllowedOrigins,
} from "../shared/transport.js";
import { ToolRegistry, MAX_TOOL_PAGE_SIZE } from "../plex/tool-registry.js";
import { createArrToolRegistry } from "../arr/tool-registry.js";
import { createTraktToolRegistry } from "../trakt/tool-registry.js";
import { ARR_WRITE_TOOLS, TRAKT_WRITE_TOOLS } from "../shared/write-tools.js";
import { PLEX_MUTATIVE_OPS_ENV_VAR } from "../plex/constants.js";
import { posterUrlProblem } from "../shared/utils.js";
import { PlexTools } from "../plex/tools.js";
import { PlexClient as RealPlexClient } from "../plex/client.js";
import type { PlexClient } from "../plex/client.js";
import { TraktMCPFunctions } from "../trakt/mcp-functions.js";
import { loadTraktTokens, saveTraktTokens } from "../trakt/token-store.js";
import type { TraktConfig, TraktTokens } from "../trakt/types.js";

const savedMutative = process.env[PLEX_MUTATIVE_OPS_ENV_VAR];
afterEach(() => {
  if (savedMutative === undefined) delete process.env[PLEX_MUTATIVE_OPS_ENV_VAR];
  else process.env[PLEX_MUTATIVE_OPS_ENV_VAR] = savedMutative;
});

// ── HTTP transport ───────────────────────────────────────────────────────────

const INIT_BODY = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } },
});
const MCP_HEADERS = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };

async function startHandler(options: Partial<Parameters<typeof createMcpRequestHandler>[0]> = {}) {
  const store = new SessionStore({ maxSessions: 4 });
  const handler = createMcpRequestHandler({
    getServer: () => new Server({ name: "t", version: "1" }, { capabilities: { tools: {} } }),
    serverName: "t",
    store,
    ...options,
  });
  const httpServer: HttpServer = createServer(handler);
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address() as AddressInfo;
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    close: async () => {
      store.closeAll();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

/** Send a raw request so headers fetch would normalise can be malformed. */
function rawRequest(port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => socket.write(request));
    let data = "";
    socket.on("data", (chunk) => {
      data += chunk.toString();
    });
    socket.on("end", () => resolve(data));
    socket.on("error", reject);
    setTimeout(() => {
      socket.destroy();
      resolve(data);
    }, 1000);
  });
}

describe("HTTP transport hardening", () => {
  let server: Awaited<ReturnType<typeof startHandler>> | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  // Regression: a Host header that fails to parse made `new URL` throw inside
  // the async request listener, an unhandled rejection that killed the process.
  it("survives a malformed Host header", async () => {
    server = await startHandler();
    await rawRequest(server.port, "GET /health HTTP/1.1\r\nHost: [\r\nConnection: close\r\n\r\n");
    const res = await fetch(`${server.baseUrl}/health`);
    expect(res.status).toBe(200);
  });

  it("requires the bearer token when one is configured", async () => {
    server = await startHandler({ authToken: "s3cret" });

    const missing = await fetch(`${server.baseUrl}/mcp`, { method: "POST", headers: MCP_HEADERS, body: INIT_BODY });
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toMatch(/^Bearer/);

    const wrong = await fetch(`${server.baseUrl}/mcp`, {
      method: "POST",
      headers: { ...MCP_HEADERS, Authorization: "Bearer nope" },
      body: INIT_BODY,
    });
    expect(wrong.status).toBe(401);

    const ok = await fetch(`${server.baseUrl}/mcp`, {
      method: "POST",
      headers: { ...MCP_HEADERS, Authorization: "Bearer s3cret" },
      body: INIT_BODY,
    });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("mcp-session-id")).toBeTruthy();
  });

  it("keeps the health check open when a token is configured", async () => {
    server = await startHandler({ authToken: "s3cret" });
    expect((await fetch(`${server.baseUrl}/health`)).status).toBe(200);
  });

  it("refuses a Host outside the allow-list", async () => {
    server = await startHandler({ allowedHosts: ["localhost", "127.0.0.1", "[::1]"] });
    const response = await rawRequest(
      server.port,
      `POST /mcp HTTP/1.1\r\nHost: evil.example:${server.port}\r\nContent-Type: application/json\r\n` +
        `Accept: application/json, text/event-stream\r\nContent-Length: ${INIT_BODY.length}\r\nConnection: close\r\n\r\n${INIT_BODY}`
    );
    expect(response.split("\r\n")[0]).toContain("403");

    const allowed = await fetch(`${server.baseUrl}/mcp`, { method: "POST", headers: MCP_HEADERS, body: INIT_BODY });
    expect(allowed.status).toBe(200);
  });

  it("bounds sessionless requests in flight", async () => {
    server = await startHandler({ maxStatelessInFlight: 0 });
    const res = await fetch(`${server.baseUrl}/mcp`, {
      method: "POST",
      headers: MCP_HEADERS,
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    expect(res.status).toBe(503);
  });

  // Regression: the in-flight slot was only released by a close handler
  // registered after getServer(), so a throwing getServer() leaked it and
  // eventually every sessionless request got 503.
  it("releases the sessionless slot when getServer throws", async () => {
    server = await startHandler({
      maxStatelessInFlight: 1,
      getServer: () => {
        throw new Error("PLEX_TOKEN environment variable is required");
      },
    });
    const call = () =>
      fetch(`${server!.baseUrl}/mcp`, {
        method: "POST",
        headers: MCP_HEADERS,
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      });
    for (let i = 0; i < 3; i++) {
      const res = await call();
      expect(res.status).toBe(500);
      await res.text();
      // Let the response's close event run before the next request.
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  });

  it("refuses a browser Origin that isn't local or allowed, even with no Host check", async () => {
    // Simulates the Docker default: bound to 0.0.0.0, so no Host allow-list.
    server = await startHandler({ allowedHosts: undefined });
    const rebound = await fetch(`${server.baseUrl}/mcp`, {
      method: "POST",
      headers: { ...MCP_HEADERS, Origin: "http://evil.example:3000" },
      body: INIT_BODY,
    });
    expect(rebound.status).toBe(403);
    expect(await rebound.text()).toMatch(/MCP_ALLOWED_ORIGINS/);

    const local = await fetch(`${server.baseUrl}/mcp`, {
      method: "POST",
      headers: { ...MCP_HEADERS, Origin: "http://localhost:6274" },
      body: INIT_BODY,
    });
    expect(local.status).toBe(200);
  });

  it("accepts an Origin listed in allowedOrigins", async () => {
    server = await startHandler({ allowedOrigins: ["https://app.example.com"] });
    const res = await fetch(`${server.baseUrl}/mcp`, {
      method: "POST",
      headers: { ...MCP_HEADERS, Origin: "https://app.example.com" },
      body: INIT_BODY,
    });
    expect(res.status).toBe(200);
  });
});

describe("parseArgs", () => {
  it("lets an explicit flag beat the environment", () => {
    const env = { MCP_HOST: "0.0.0.0", MCP_PORT: "4000", MCP_PATH: "/env" };
    expect(parseArgs(["--host", "127.0.0.1", "--port", "5000", "--path", "/flag"], env)).toMatchObject({
      host: "127.0.0.1",
      port: 5000,
      mcpPath: "/flag",
    });
  });

  it("falls back to the environment, then the defaults", () => {
    expect(parseArgs([], { MCP_HOST: " 0.0.0.0 ", MCP_PORT: "4000" })).toMatchObject({ host: "0.0.0.0", port: 4000 });
    expect(parseArgs([], {})).toMatchObject({ host: "127.0.0.1", port: 3000, mcpPath: "/mcp", transport: "stdio" });
  });
});

describe("originAllowed", () => {
  it("lets requests without an Origin through", () => {
    expect(originAllowed(undefined, [], undefined)).toBe(true);
  });

  it("accepts loopback origins and allowed hosts", () => {
    expect(originAllowed("http://127.0.0.1:5173", [], undefined)).toBe(true);
    expect(originAllowed("http://[::1]:8080", [], undefined)).toBe(true);
    expect(originAllowed("https://plex-mcp.example.com", [], ["plex-mcp.example.com"])).toBe(true);
  });

  it("refuses other origins, including the opaque null origin", () => {
    expect(originAllowed("http://evil.example", [], undefined)).toBe(false);
    expect(originAllowed("null", [], undefined)).toBe(false);
    expect(originAllowed("https://app.example.com:8443", ["https://app.example.com"], undefined)).toBe(false);
  });

  it("honours * and normalises configured origins", () => {
    expect(originAllowed("http://anything.example", ["*"], undefined)).toBe(true);
    expect(resolveAllowedOrigins(" https://App.Example.com/ , *, nonsense ")).toEqual([
      "https://app.example.com",
      "*",
    ]);
  });
});

describe("transport helpers", () => {
  it("recognises loopback addresses", () => {
    for (const h of ["127.0.0.1", "127.1.2.3", "localhost", "::1", "[::1]"]) expect(isLoopbackHost(h)).toBe(true);
    for (const h of ["0.0.0.0", "192.168.1.5", "::", "example.com"]) expect(isLoopbackHost(h)).toBe(false);
  });

  it("parses Host headers to a bare hostname", () => {
    expect(hostnameFromHeader("Example.com:3000")).toBe("example.com");
    expect(hostnameFromHeader("[::1]:3000")).toBe("[::1]");
    expect(hostnameFromHeader("[")).toBeUndefined();
    expect(hostnameFromHeader(undefined)).toBeUndefined();
  });

  it("only restricts Host by default on a loopback bind", () => {
    expect(resolveAllowedHosts("127.0.0.1")).toEqual(["localhost", "127.0.0.1", "[::1]"]);
    expect(resolveAllowedHosts("0.0.0.0")).toBeUndefined();
    expect(resolveAllowedHosts("0.0.0.0", " Plex.Example.com:443 , localhost ")).toEqual([
      "plex.example.com",
      "localhost",
    ]);
  });

  it("matches bearer tokens exactly", () => {
    expect(bearerTokenMatches("Bearer abc", "abc")).toBe(true);
    expect(bearerTokenMatches("bearer abc", "abc")).toBe(true);
    expect(bearerTokenMatches("Bearer abcd", "abc")).toBe(false);
    expect(bearerTokenMatches("Basic abc", "abc")).toBe(false);
    expect(bearerTokenMatches(undefined, "abc")).toBe(false);
    expect(bearerTokenMatches("Bearer", "abc")).toBe(false);
    expect(bearerTokenMatches("Bearer    ", "abc")).toBe(false);
    expect(bearerTokenMatches("Bearer   abc  ", "abc")).toBe(true);
    expect(bearerTokenMatches("Bearer\tabc", "abc")).toBe(true);
  });

  // Regression for CodeQL js/polynomial-redos: the old /^Bearer\s+(.+)$/i
  // backtracked polynomially on long runs of whitespace.
  it("handles a pathological Authorization header quickly", () => {
    const header = "bearer " + " ".repeat(200_000) + "!";
    const started = Date.now();
    expect(bearerTokenMatches(header, "abc")).toBe(false);
    expect(Date.now() - started).toBeLessThan(100);
  });
});

// ── Write-tool gating and limits ─────────────────────────────────────────────

describe("non-Plex write tools", () => {
  const arrFunctions = new Proxy({}, { get: () => vi.fn().mockResolvedValue({ success: true }) });
  const traktFunctions = new Proxy({}, { get: () => vi.fn().mockResolvedValue({ success: true }) });
  const arr = createArrToolRegistry(arrFunctions as never);
  const trakt = createTraktToolRegistry(traktFunctions as never);

  it("registers every name on the write lists", () => {
    for (const name of ARR_WRITE_TOOLS) expect(arr.has(name)).toBe(true);
    for (const name of TRAKT_WRITE_TOOLS) expect(trakt.has(name)).toBe(true);
  });

  it("refuses them while write operations are disabled", async () => {
    delete process.env[PLEX_MUTATIVE_OPS_ENV_VAR];
    for (const name of ARR_WRITE_TOOLS) await expect(arr.handle(name, {})).rejects.toBeInstanceOf(McpError);
    for (const name of TRAKT_WRITE_TOOLS) await expect(trakt.handle(name, {})).rejects.toBeInstanceOf(McpError);
  });

  it("runs them once write operations are enabled", async () => {
    process.env[PLEX_MUTATIVE_OPS_ENV_VAR] = "true";
    await expect(arr.handle("sonarr_delete_tag", { id: 1 })).resolves.toBeDefined();
    await expect(trakt.handle("trakt_sync_to_trakt", {})).resolves.toBeDefined();
  });

  it("leaves read tools alone", async () => {
    delete process.env[PLEX_MUTATIVE_OPS_ENV_VAR];
    await expect(arr.handle("sonarr_get_tags", {})).resolves.toBeDefined();
    await expect(trakt.handle("trakt_sync_from_trakt", {})).resolves.toBeDefined();
  });
});

describe("ToolRegistry write gating", () => {
  it("guards the handlers named in writeTools and nothing else", async () => {
    delete process.env[PLEX_MUTATIVE_OPS_ENV_VAR];
    const registry = new ToolRegistry({ writeTools: ["w"] });
    registry.register("w", async () => ({ content: [] }));
    registry.register("r", async () => ({ content: [] }));
    await expect(registry.handle("w")).rejects.toBeInstanceOf(McpError);
    await expect(registry.handle("r")).resolves.toBeDefined();

    process.env[PLEX_MUTATIVE_OPS_ENV_VAR] = "true";
    await expect(registry.handle("w")).resolves.toBeDefined();
  });
});

describe("ToolRegistry page-size ceiling", () => {
  it("clamps limit and pageSize", async () => {
    const registry = new ToolRegistry();
    const seen: Record<string, unknown>[] = [];
    registry.register("t", async (args) => {
      seen.push(args);
      return { content: [] };
    });

    await registry.handle("t", { limit: 1e9, pageSize: 50_000, other: 1e9 });
    await registry.handle("t", { limit: 25 });

    expect(seen[0]).toEqual({ limit: MAX_TOOL_PAGE_SIZE, pageSize: MAX_TOOL_PAGE_SIZE, other: 1e9 });
    expect(seen[1]).toEqual({ limit: 25 });
  });
});

// ── Plex input validation ────────────────────────────────────────────────────

describe("posterUrlProblem", () => {
  it.each([
    "https://image.tmdb.org/t/p/original/abc.jpg",
    "http://example.com/poster.png",
    "https://8.8.8.8/x.jpg",
    "https://example.com./x.jpg",
    "http://[2606:4700:4700::1111]/x.jpg",
    "http://[64:ff9b::808:808]/x.jpg",
  ])("accepts %s", (url) => {
    expect(posterUrlProblem(url)).toBeUndefined();
  });

  it.each([
    "file:///etc/passwd",
    "ftp://example.com/x.jpg",
    "http://localhost:8080/admin",
    "http://127.0.0.1/",
    "http://10.0.0.1/",
    "http://172.20.0.1/",
    "http://192.168.1.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/",
    "http://[fd00::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://router.local/",
    // Trailing dots still name the same host.
    "http://localhost./",
    "http://foo.localhost./",
    "http://127.0.0.1./",
    // Single-label and LAN-only names.
    "http://router/",
    "http://nas.lan/",
    "http://printer.home.arpa/",
    // IPv6 forms that embed an internal IPv4 address.
    "http://[::127.0.0.1]/",
    "http://[::7f00:1]/",
    "http://[64:ff9b::169.254.169.254]/",
    "http://[2002:c0a8:101::1]/",
    "http://[2001:0:4136:e378::1]/",
    "http://[fe80::1]/",
    // Reserved IPv4 ranges.
    "http://192.0.0.1/",
    "http://198.18.0.1/",
    "http://0x7f.1/",
    "http://user:pw@example.com/x.jpg",
    "not a url",
  ])("refuses %s", (url) => {
    expect(posterUrlProblem(url)).toBeDefined();
  });
});

function mockPlexClient() {
  return {
    makeRequest: vi.fn().mockResolvedValue({ MediaContainer: { totalSize: 1, Metadata: [{ ratingKey: "1", title: "A" }] } }),
    makeDiscoverRequest: vi.fn(),
    getPlexTypeId: vi.fn().mockReturnValue(1),
    getLibraryMoviesWithMeta: vi.fn().mockResolvedValue([]),
  };
}

describe("Plex ID validation", () => {
  it("get_recommendations rejects a libraryKey that is not numeric", async () => {
    const client = mockPlexClient();
    const tools = new PlexTools(client as unknown as PlexClient);
    await expect(tools.getRecommendations("../../accounts?x=")).rejects.toBeInstanceOf(McpError);
    expect(client.getLibraryMoviesWithMeta).not.toHaveBeenCalled();
  });

  it("create_playlist rejects a non-numeric smart librarySectionId", async () => {
    process.env[PLEX_MUTATIVE_OPS_ENV_VAR] = "true";
    const client = mockPlexClient();
    const tools = new PlexTools(client as unknown as PlexClient);
    await expect(
      tools.createPlaylist("p", "video", { smart: true, librarySectionId: "1/../../x" })
    ).rejects.toBeInstanceOf(McpError);
  });
});

describe("Plex requests and redirects", () => {
  let servers: HttpServer[] = [];
  afterEach(async () => {
    await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
    servers = [];
  });

  async function listen(handler: Parameters<typeof createServer>[1]) {
    const s = createServer(handler);
    servers.push(s);
    await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  }

  it("does not follow a redirect, so the token never reaches its target", async () => {
    const seenTokens: unknown[] = [];
    const elsewhere = await listen((req, res) => {
      seenTokens.push(req.headers["x-plex-token"]);
      res.end("{}");
    });
    const plex = await listen((_req, res) => {
      res.writeHead(302, { Location: `${elsewhere}/steal?x=secret` });
      res.end();
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = new RealPlexClient({ baseUrl: plex, token: "PLEX-TOKEN" });

    const failure = client.makeRequest("/library/sections");
    await expect(failure).rejects.toThrow(/redirect \(HTTP 302\) to http:\/\/127\.0\.0\.1:\d+\/steal/);
    await expect(failure).rejects.not.toThrow(/secret/);
    errSpy.mockRestore();
    expect(seenTokens).toEqual([]);
  });
});

// ── export_library file safety ───────────────────────────────────────────────

describe("export_library", () => {
  let dir: string;
  const savedExportDir = process.env.PLEX_EXPORT_DIR;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "plex-export-"));
    process.env.PLEX_EXPORT_DIR = path.join(dir, "exports");
  });

  afterEach(async () => {
    if (savedExportDir === undefined) delete process.env.PLEX_EXPORT_DIR;
    else process.env.PLEX_EXPORT_DIR = savedExportDir;
    await rm(dir, { recursive: true, force: true });
  });

  it("writes into PLEX_EXPORT_DIR", async () => {
    const tools = new PlexTools(mockPlexClient() as unknown as PlexClient);
    await tools.exportLibrary("1", undefined, "out.json");
    const written = JSON.parse(await readFile(path.join(dir, "exports", "out.json"), "utf8"));
    expect(written[0]).toMatchObject({ ratingKey: "1" });
  });

  it("refuses to overwrite an existing file and leaves it intact", async () => {
    await mkdir(path.join(dir, "exports"), { recursive: true });
    const existing = path.join(dir, "exports", "keep.json");
    await writeFile(existing, "precious");
    const client = mockPlexClient();
    const tools = new PlexTools(client as unknown as PlexClient);

    await expect(tools.exportLibrary("1", undefined, "keep.json")).rejects.toThrow(/already exists/);
    expect(await readFile(existing, "utf8")).toBe("precious");
    // It fails before paging through Plex.
    expect(client.makeRequest).not.toHaveBeenCalled();
  });

  it("refuses a path that escapes through a symlinked directory", async () => {
    await mkdir(path.join(dir, "exports"), { recursive: true });
    await mkdir(path.join(dir, "outside"));
    await symlink(path.join(dir, "outside"), path.join(dir, "exports", "link"));
    const tools = new PlexTools(mockPlexClient() as unknown as PlexClient);

    await expect(tools.exportLibrary("1", undefined, "link/x.json")).rejects.toThrow(/inside the exports directory/);
    await expect(stat(path.join(dir, "outside", "x.json"))).rejects.toThrow();
  });

  // Regression: mkdir ran before the symlink check, so it created directories
  // under the link's target before the request was refused.
  it("creates nothing outside the base when refusing a symlinked path", async () => {
    await mkdir(path.join(dir, "exports"), { recursive: true });
    await mkdir(path.join(dir, "outside"));
    await symlink(path.join(dir, "outside"), path.join(dir, "exports", "link"));
    const tools = new PlexTools(mockPlexClient() as unknown as PlexClient);

    await expect(tools.exportLibrary("1", undefined, "link/a/b/x.json")).rejects.toThrow(/inside the exports directory/);
    await expect(stat(path.join(dir, "outside", "a"))).rejects.toThrow();
  });

  it("refuses a path through a dangling symlink without creating its target", async () => {
    await mkdir(path.join(dir, "exports"), { recursive: true });
    await symlink(path.join(dir, "nowhere"), path.join(dir, "exports", "dangling"));
    const tools = new PlexTools(mockPlexClient() as unknown as PlexClient);

    await expect(tools.exportLibrary("1", undefined, "dangling/x.json")).rejects.toThrow(/inside the exports directory/);
    await expect(stat(path.join(dir, "nowhere"))).rejects.toThrow();
  });

  it("creates nested directories inside the base", async () => {
    const tools = new PlexTools(mockPlexClient() as unknown as PlexClient);
    await tools.exportLibrary("1", undefined, "nested/deeper/out.json");
    expect((await stat(path.join(dir, "exports", "nested", "deeper", "out.json"))).isFile()).toBe(true);
  });
});

// ── Trakt tokens ─────────────────────────────────────────────────────────────

describe("Trakt token handling", () => {
  let dir: string;
  const savedTokenFile = process.env.TRAKT_TOKEN_FILE;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "trakt-tokens-"));
    process.env.TRAKT_CLIENT_ID = "id";
    process.env.TRAKT_CLIENT_SECRET = "secret";
  });

  afterEach(async () => {
    if (savedTokenFile === undefined) delete process.env.TRAKT_TOKEN_FILE;
    else process.env.TRAKT_TOKEN_FILE = savedTokenFile;
    await rm(dir, { recursive: true, force: true });
  });

  function authedTrakt() {
    const trakt = new TraktMCPFunctions({} as never);
    // @ts-expect-error — force init for test
    trakt.isInitialized = true;
    // @ts-expect-error — mock traktClient
    trakt.traktClient = {
      exchangeCodeForToken: vi.fn().mockResolvedValue({
        access_token: "ACCESS-123",
        refresh_token: "REFRESH-456",
        expires_in: 7776000,
        scope: "public",
        created_at: 1,
      }),
      getCurrentUser: vi.fn().mockResolvedValue({ username: "u", name: "U", vip: false }),
    };
    return trakt;
  }

  it("never returns or logs tokens", async () => {
    delete process.env.TRAKT_TOKEN_FILE;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await authedTrakt().traktCompleteAuth("code");
    const logged = JSON.stringify([...errSpy.mock.calls, ...logSpy.mock.calls]);
    errSpy.mockRestore();
    logSpy.mockRestore();

    expect(result.success).toBe(true);
    expect(result.tokenStorage).toBe("memory");
    const text = JSON.stringify(result);
    for (const secret of ["ACCESS-123", "REFRESH-456"]) {
      expect(text).not.toContain(secret);
      expect(logged).not.toContain(secret);
    }
  });

  /** A real client config (so onTokensUpdated is wired) with the HTTP calls mocked. */
  function traktWithTokenFile(file: string) {
    process.env.TRAKT_TOKEN_FILE = file;
    const trakt = new TraktMCPFunctions({} as never);
    // @ts-expect-error — private init
    trakt.initializeTraktClient();
    // Private client, reached into for the test.
    const client = (trakt as unknown as { traktClient: Record<string, unknown> & { config: TraktConfig } }).traktClient;
    const tokens: TraktTokens = {
      access_token: "ACCESS-123",
      refresh_token: "REFRESH-456",
      token_type: "bearer",
      expires_in: 1,
      scope: "public",
      created_at: 1,
    };
    client.exchangeCodeForToken = vi.fn(async () => {
      client.config.onTokensUpdated?.(tokens);
      return tokens;
    });
    client.getCurrentUser = vi.fn().mockResolvedValue({ username: "u", name: "U", vip: false });
    return trakt;
  }

  it("reports file storage when the token file was written", async () => {
    const file = path.join(dir, "tokens.json");
    const result = await traktWithTokenFile(file).traktCompleteAuth("code");
    expect(result.tokenStorage).toBe("file");
    expect(loadTraktTokens(file)).toMatchObject({ accessToken: "ACCESS-123", refreshToken: "REFRESH-456" });
  });

  // Regression: the result said "Tokens were saved" even when the write failed.
  it("says so when the token file could not be written", async () => {
    await writeFile(path.join(dir, "not-a-dir"), "x");
    const file = path.join(dir, "not-a-dir", "tokens.json");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await traktWithTokenFile(file).traktCompleteAuth("code");
    errSpy.mockRestore();

    expect(result.success).toBe(true);
    expect(result.tokenStorage).toBe("memory");
    expect(String(result.message)).toMatch(/could not be saved/);
  });

  it("saves and reloads tokens with owner-only permissions", async () => {
    const file = path.join(dir, "nested", "tokens.json");
    expect(saveTraktTokens(file, { accessToken: "a", refreshToken: "r" })).toBe(true);
    expect(loadTraktTokens(file)).toEqual({ accessToken: "a", refreshToken: "r" });
    if (process.platform !== "win32") {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    }
  });

  it("prefers the token file over the environment", async () => {
    const file = path.join(dir, "tokens.json");
    saveTraktTokens(file, { accessToken: "from-file", refreshToken: "file-refresh" });
    process.env.TRAKT_TOKEN_FILE = file;
    process.env.TRAKT_ACCESS_TOKEN = "from-env";

    const trakt = new TraktMCPFunctions({} as never);
    // @ts-expect-error — private init
    trakt.initializeTraktClient();
    // @ts-expect-error — inspect private client config
    expect(trakt.traktClient.config.accessToken).toBe("from-file");

    delete process.env.TRAKT_ACCESS_TOKEN;
  });
});
