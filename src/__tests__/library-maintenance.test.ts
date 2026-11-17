import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PlexTools } from "../plex/tools.js";
import { PlexClient } from "../plex/client.js";
import { withAnnotations } from "../shared/tool-annotations.js";
import { PLEX_MUTATIVE_TOOL_SCHEMAS } from "../plex/tool-schemas.js";

const SECTIONS = {
  MediaContainer: {
    Directory: [
      { key: "1", title: "Movies", type: "movie", refreshing: 0, Location: [{ path: "/data/movies" }] },
      { key: "2", title: "Music", type: "artist", refreshing: 1, Location: [{ path: "/data/music/" }, { path: "D:\\Music" }] },
    ],
  },
};

function fakePlex() {
  const calls: Array<{ endpoint: string; params: Record<string, string | number>; method: string }> = [];
  const makeRequest = vi.fn(
    async (endpoint: string, params: Record<string, string | number> = {}, method: string = "GET") => {
      calls.push({ endpoint, params, method });
      if (endpoint === "/library/sections" && method === "GET") return structuredClone(SECTIONS);
      if (/^\/library\/sections\/\d+\/refresh$/.test(endpoint) && method === "GET") return {};
      if (/^\/library\/sections\/\d+\/emptyTrash$/.test(endpoint) && method === "PUT") return {};
      throw new Error(`unexpected request ${method} ${endpoint}`);
    }
  );
  const client = { makeRequest } as unknown as PlexClient;
  const writes = () => calls.filter((c) => c.endpoint !== "/library/sections");
  return { client, calls, writes, makeRequest };
}

function parse(response: { content: Array<{ text: string }> }) {
  return JSON.parse(response.content[0].text);
}

describe("library scans and trash", () => {
  const original = process.env.PLEX_ENABLE_MUTATIVE_OPS;
  beforeEach(() => {
    process.env.PLEX_ENABLE_MUTATIVE_OPS = "true";
  });
  afterEach(() => {
    if (original === undefined) delete process.env.PLEX_ENABLE_MUTATIVE_OPS;
    else process.env.PLEX_ENABLE_MUTATIVE_OPS = original;
  });

  describe("scan_library", () => {
    it("scans the whole library", async () => {
      const plex = fakePlex();
      const result = parse(await new PlexTools(plex.client).scanLibrary("1"));
      expect(result).toMatchObject({ started: true, scope: "whole library", library: { key: "1", title: "Movies" } });
      expect(result.alreadyScanning).toBeUndefined();
      expect(plex.writes()).toEqual([{ endpoint: "/library/sections/1/refresh", params: {}, method: "GET" }]);
    });

    it("scans one folder inside the library", async () => {
      const plex = fakePlex();
      const result = parse(await new PlexTools(plex.client).scanLibrary("2", { path: "/data/music/New Album/" }));
      expect(result).toMatchObject({ scope: "folder", path: "/data/music/New Album", alreadyScanning: true });
      expect(plex.writes()[0].params).toEqual({ path: "/data/music/New Album" });
    });

    it("accepts a Windows folder inside the library", async () => {
      const plex = fakePlex();
      await new PlexTools(plex.client).scanLibrary("2", { path: "D:\\Music\\Album" });
      expect(plex.writes()[0].params).toEqual({ path: "D:\\Music\\Album" });
    });

    it("refreshes all metadata with force", async () => {
      const plex = fakePlex();
      const result = parse(await new PlexTools(plex.client).scanLibrary("1", { force: true }));
      expect(result.scope).toBe("refresh all metadata");
      expect(plex.writes()[0].params).toEqual({ force: 1 });
    });

    it.each([
      ["outside the library", "/etc"],
      ["a sibling with a shared prefix", "/data/movies-old"],
      ["a parent escape", "/data/movies/../tv"],
      ["an empty path", "  "],
    ])("refuses %s", async (_label, path) => {
      const plex = fakePlex();
      await expect(new PlexTools(plex.client).scanLibrary("1", { path })).rejects.toThrow(/path/);
      expect(plex.writes()).toEqual([]);
    });

    it("refuses force with a path", async () => {
      const plex = fakePlex();
      await expect(
        new PlexTools(plex.client).scanLibrary("1", { path: "/data/movies/A", force: true })
      ).rejects.toThrow(/can't be limited to a path/);
      expect(plex.writes()).toEqual([]);
    });

    it("refuses an unknown or malformed library", async () => {
      const plex = fakePlex();
      const tools = new PlexTools(plex.client);
      await expect(tools.scanLibrary("9")).rejects.toThrow(/No library with key 9/);
      await expect(tools.scanLibrary("1/../2")).rejects.toThrow();
      expect(plex.writes()).toEqual([]);
    });
  });

  describe("empty_trash", () => {
    it("previews without emptying unless confirmed", async () => {
      const plex = fakePlex();
      const result = parse(await new PlexTools(plex.client).emptyTrash("1"));
      expect(result).toMatchObject({
        preview: true,
        confirmationRequired: true,
        library: { key: "1", title: "Movies" },
        locations: ["/data/movies"],
      });
      expect(result.message).toMatch(/offline/);
      expect(plex.writes()).toEqual([]);
    });

    it("empties the trash when confirmed", async () => {
      const plex = fakePlex();
      const result = parse(await new PlexTools(plex.client).emptyTrash("2", true));
      expect(result).toMatchObject({ emptied: true, library: { key: "2", title: "Music" } });
      expect(plex.writes()).toEqual([{ endpoint: "/library/sections/2/emptyTrash", params: {}, method: "PUT" }]);
    });

    it("refuses an unknown library", async () => {
      const plex = fakePlex();
      await expect(new PlexTools(plex.client).emptyTrash("9", true)).rejects.toThrow(/No library/);
      expect(plex.writes()).toEqual([]);
    });
  });

  it("annotates empty_trash as destructive and scan_library as a non-destructive write", () => {
    const tools = withAnnotations(PLEX_MUTATIVE_TOOL_SCHEMAS);
    expect(tools.find((t) => t.name === "empty_trash")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
    expect(tools.find((t) => t.name === "scan_library")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
    });
  });

  it("refuses both tools when write operations are disabled", async () => {
    process.env.PLEX_ENABLE_MUTATIVE_OPS = "false";
    const plex = fakePlex();
    const tools = new PlexTools(plex.client);
    await expect(tools.scanLibrary("1")).rejects.toThrow(/scan_library is disabled/);
    await expect(tools.emptyTrash("1", true)).rejects.toThrow(/empty_trash is disabled/);
    expect(plex.makeRequest).not.toHaveBeenCalled();
  });
});
