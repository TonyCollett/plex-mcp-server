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
  resolveAllowedHosts,
} from "../shared/transport.js";
import { ToolRegistry, MAX_TOOL_PAGE_SIZE } from "../plex/tool-registry.js";
import { createArrToolRegistry } from "../arr/tool-registry.js";
import { createTraktToolRegistry } from "../trakt/tool-registry.js";
import { ARR_WRITE_TOOLS, TRAKT_WRITE_TOOLS } from "../shared/write-tools.js";
import { PLEX_MUTATIVE_OPS_ENV_VAR } from "../plex/constants.js";
import { posterUrlProblem } from "../shared/utils.js";
import { PlexTools } from "../plex/tools.js";
import type { PlexClient } from "../plex/client.js";
import { TraktMCPFunctions } from "../trakt/mcp-functions.js";
import { loadTraktTokens, saveTraktTokens } from "../trakt/token-store.js";

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

  it("never returns tokens in the tool result", async () => {
    delete process.env.TRAKT_TOKEN_FILE;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await authedTrakt().traktCompleteAuth("code");
    errSpy.mockRestore();

    expect(result.success).toBe(true);
    const text = JSON.stringify(result);
    expect(text).not.toContain("ACCESS-123");
    expect(text).not.toContain("REFRESH-456");
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
