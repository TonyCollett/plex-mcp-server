#!/usr/bin/env node

import "dotenv/config";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";

// Plex shared module
import {
  PlexClient,
  PlexTools,
  createPlexToolRegistry,
  DEFAULT_PLEX_URL,
} from "./plex/index.js";
import { startServer } from "./shared/transport.js";
import { SERVER_VERSION } from "./shared/version.js";
import { listedToolSchemas } from "./shared/tool-list.js";

// Trakt integration
import { TraktMCPFunctions } from "./trakt/mcp-functions.js";
import { createTraktToolRegistry } from "./trakt/tool-registry.js";

// Arr integration (Sonarr/Radarr)
import { ArrMCPFunctions } from "./arr/mcp-functions.js";
import { createArrToolRegistry } from "./arr/tool-registry.js";

function positiveIntEnv(name: string): number | undefined {
  const value = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/** One stderr line per tool call: name, outcome and duration. Off with MCP_LOG_TOOL_CALLS=false. */
function logToolCall(name: string, outcome: "ok" | "error", started: number): void {
  if (process.env.MCP_LOG_TOOL_CALLS === "false") return;
  console.error(`[tool] ${name} ${outcome} ${Date.now() - started}ms`);
}

class UnifiedMCPServer {
  /**
   * Build a fully wired Server instance.
   *
   * A factory rather than a constructor because HTTP transport needs one
   * Server per session — a single instance cannot back concurrent clients.
   */
  static createServer(): Server {
    const server = new Server(
      { name: "plex-mcp-server", version: SERVER_VERSION },
      { capabilities: { tools: {} } }
    );

    const plexToken = process.env.PLEX_TOKEN;
    if (!plexToken) {
      throw new Error("PLEX_TOKEN environment variable is required");
    }

    const plexClient = new PlexClient({
      baseUrl: process.env.PLEX_URL || DEFAULT_PLEX_URL,
      token: plexToken,
      requestTimeoutMs: positiveIntEnv("PLEX_REQUEST_TIMEOUT_MS"),
      slowRequestMs: positiveIntEnv("PLEX_SLOW_REQUEST_MS"),
      logAllRequests: process.env.PLEX_LOG_REQUESTS === "true",
    });

    const plexTools = new PlexTools(plexClient);
    const traktFunctions = new TraktMCPFunctions(plexClient);
    const plexRegistry = createPlexToolRegistry(plexTools, {
      traktFunctions,
    });
    const traktRegistry = createTraktToolRegistry(traktFunctions);
    const arrFunctions = new ArrMCPFunctions();
    const arrRegistry = createArrToolRegistry(arrFunctions);

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: listedToolSchemas(),
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const a = (args ?? {}) as Record<string, unknown>;
      const started = Date.now();

      try {
        let result;
        if (plexRegistry.has(name)) result = await plexRegistry.handle(name, a);
        else if (traktRegistry.has(name)) result = await traktRegistry.handle(name, a);
        else result = await arrRegistry.handle(name, a);
        logToolCall(name, "ok", started);
        return result;
      } catch (error) {
        logToolCall(name, "error", started);
        if (error instanceof McpError) throw error;
        const msg = error instanceof Error ? error.message : String(error);
        throw new McpError(ErrorCode.InternalError, `Error executing ${name}: ${msg}`);
      }
    });

    return server;
  }
}

export async function main() {
  await startServer(() => UnifiedMCPServer.createServer(), "Plex MCP server (unified)");
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
