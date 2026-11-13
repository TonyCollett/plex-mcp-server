import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import axios from "axios";
import { PlexTools } from "../plex/tools.js";
import { PlexClient, DEFAULT_REQUEST_TIMEOUT_MS } from "../plex/client.js";
import { createPlexToolRegistry } from "../plex/tool-registry.js";

vi.mock("axios");

const MACHINE_ID = "machine-abc";

function parse(response: { content: Array<{ text: string }> }) {
  return JSON.parse(response.content[0].text);
}

function mockClient() {
  return {
    makeRequest: vi.fn(),
    rateMedia: vi.fn(),
    getPlexTypeId: vi.fn((type: string) => PlexClient.prototype.getPlexTypeId.call(null, type)),
  } as unknown as PlexClient;
}

const ORIGINAL_MUTATIVE = process.env.PLEX_ENABLE_MUTATIVE_OPS;
beforeEach(() => {
  process.env.PLEX_ENABLE_MUTATIVE_OPS = "true";
});
afterEach(() => {
  if (ORIGINAL_MUTATIVE === undefined) delete process.env.PLEX_ENABLE_MUTATIVE_OPS;
  else process.env.PLEX_ENABLE_MUTATIVE_OPS = ORIGINAL_MUTATIVE;
  vi.restoreAllMocks();
});

describe("PlexClient request timeout and logging", () => {
  it("sends a timeout with every Plex request (default 30s)", async () => {
    const axiosMock = vi.mocked(axios) as unknown as ReturnType<typeof vi.fn>;
    axiosMock.mockResolvedValue({ data: { ok: true } });
    const client = new PlexClient({ baseUrl: "http://plex:32400", token: "t" });

    await client.makeRequest("/library/sections");

    expect(axiosMock).toHaveBeenCalledWith(
      "http://plex:32400/library/sections",
      expect.objectContaining({ timeout: DEFAULT_REQUEST_TIMEOUT_MS })
    );
  });

  it("honours a configured timeout", async () => {
    const axiosMock = vi.mocked(axios) as unknown as ReturnType<typeof vi.fn>;
    axiosMock.mockResolvedValue({ data: {} });
    const client = new PlexClient({ baseUrl: "http://plex:32400", token: "t", requestTimeoutMs: 5000 });

    await client.makeRequest("/identity");

    expect(axiosMock).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ timeout: 5000 }));
  });

  it("logs a timed-out request by path only, without params, and rethrows", async () => {
    const axiosMock = vi.mocked(axios) as unknown as ReturnType<typeof vi.fn>;
    axiosMock.mockRejectedValue(Object.assign(new Error("timeout"), { code: "ECONNABORTED" }));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = new PlexClient({ baseUrl: "http://plex:32400", token: "t", requestTimeoutMs: 1000 });

    await expect(client.makeRequest("/search", { query: "secret title" })).rejects.toThrow("timeout");

    const line = String(log.mock.calls[0][0]);
    expect(line).toContain("GET /search FAILED timed out after 1000ms");
    expect(line).not.toContain("secret");
  });

  it("stays quiet for fast successful requests", async () => {
    const axiosMock = vi.mocked(axios) as unknown as ReturnType<typeof vi.fn>;
    axiosMock.mockResolvedValue({ data: {} });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = new PlexClient({ baseUrl: "http://plex:32400", token: "t" });

    await client.makeRequest("/identity");

    expect(log).not.toHaveBeenCalled();
  });
});

describe("add_to_playlist", () => {
  function wire(client: PlexClient, putResponse: Record<string, unknown>, playlistItems: string[] = []) {
    const mock = client.makeRequest as ReturnType<typeof vi.fn>;
    mock.mockImplementation(async (endpoint: string, _params: unknown, method?: string) => {
      if (endpoint === "/identity") return { MediaContainer: { machineIdentifier: MACHINE_ID } };
      if (endpoint === "/playlists/7/items" && method === "PUT") return putResponse;
      if (endpoint === "/playlists/7/items") {
        return { MediaContainer: { Metadata: playlistItems.map((ratingKey) => ({ ratingKey })) } };
      }
      throw new Error(`Unexpected ${method ?? "GET"} ${endpoint}`);
    });
    return mock;
  }

  it("adds many items with one PUT and no re-read when Plex reports leafCountAdded", async () => {
    const client = mockClient();
    const mock = wire(client, { MediaContainer: { leafCountAdded: 3 } });

    const result = parse(await new PlexTools(client).addToPlaylist("7", ["11", "12", "13"]));

    const playlistCalls = mock.mock.calls.filter(([endpoint]) => endpoint === "/playlists/7/items");
    expect(playlistCalls).toHaveLength(1);
    expect(playlistCalls[0]).toEqual([
      "/playlists/7/items",
      { uri: `server://${MACHINE_ID}/com.plexapp.plugins.library/library/metadata/11,12,13` },
      "PUT",
    ]);
    expect(result).toMatchObject({ added: true, requested: 3, addedCount: 3 });
  });

  it("never sends a POST", async () => {
    const client = mockClient();
    const mock = wire(client, { MediaContainer: { leafCountAdded: 1 } });

    await new PlexTools(client).addToPlaylist("7", "11");

    expect(mock.mock.calls.some(([, , method]) => method === "POST")).toBe(false);
  });

  it("re-reads the playlist once when Plex doesn't report a count, and names missing items", async () => {
    const client = mockClient();
    const mock = wire(client, {}, ["11"]);

    const result = parse(await new PlexTools(client).addToPlaylist("7", ["11", "12"]));

    const reads = mock.mock.calls.filter(([endpoint, , method]) => endpoint === "/playlists/7/items" && method !== "PUT");
    expect(reads).toHaveLength(1);
    expect(result).toMatchObject({ addedCount: 1, notFoundAfterAdd: ["12"] });
  });

  it("fails loudly when Plex adds nothing", async () => {
    const client = mockClient();
    wire(client, { MediaContainer: { leafCountAdded: 0 } });

    await expect(new PlexTools(client).addToPlaylist("7", ["11"])).rejects.toThrow(/added none/);
  });

  it("rejects an empty key list", async () => {
    const client = mockClient();
    wire(client, {});

    await expect(new PlexTools(client).addToPlaylist("7", [])).rejects.toThrow(/ratingKey/);
  });

  it("registry prefers ratingKeys over ratingKey", async () => {
    const tools = { addToPlaylist: vi.fn().mockResolvedValue({ content: [] }) } as unknown as PlexTools;
    const registry = createPlexToolRegistry(tools);

    await registry.handle("add_to_playlist", { playlistId: "7", ratingKey: "1", ratingKeys: ["2", "3"] });

    expect(tools.addToPlaylist).toHaveBeenCalledWith("7", ["2", "3"]);
  });
});

describe("update_metadata field edits", () => {
  function wire(client: PlexClient, before: Record<string, unknown>, after: Record<string, unknown>) {
    let reads = 0;
    const mock = client.makeRequest as ReturnType<typeof vi.fn>;
    mock.mockImplementation(async (endpoint: string) => {
      if (endpoint === "/library/metadata/140400") {
        reads += 1;
        return { MediaContainer: { Metadata: [reads === 1 ? before : after] } };
      }
      if (endpoint === "/library/sections/13/all") return {};
      throw new Error(`Unexpected ${endpoint}`);
    });
    return mock;
  }

  const artist = { ratingKey: "140400", type: "artist", librarySectionID: 13, title: "Final Fantasy X & X-2 HD" };

  it("sends the item type with locked .value fields to the section endpoint", async () => {
    const client = mockClient();
    const mock = wire(client, artist, { ...artist, title: "Nobuo Uematsu", titleSort: "Uematsu, Nobuo" });

    const result = parse(
      await new PlexTools(client).updateMetadata({ ratingKey: "140400", title: "Nobuo Uematsu", sortTitle: "Uematsu, Nobuo" })
    );

    expect(mock).toHaveBeenCalledWith(
      "/library/sections/13/all",
      {
        id: "140400",
        type: 8,
        "title.value": "Nobuo Uematsu",
        "title.locked": 1,
        "titleSort.value": "Uematsu, Nobuo",
        "titleSort.locked": 1,
      },
      "PUT"
    );
    expect(result).toMatchObject({ updated: true, verifiedFields: ["title", "titleSort"] });
  });

  it("reports a silent no-op from Plex as not updated", async () => {
    const client = mockClient();
    wire(client, artist, artist);

    const result = parse(await new PlexTools(client).updateMetadata({ ratingKey: "140400", title: "Nobuo Uematsu" }));

    expect(result.updated).toBe(false);
    expect(result.verifiedFields).toEqual([]);
    expect(result.warnings.join(" ")).toMatch(/did not save title/);
  });

  it("sets the user rating through the rate endpoint", async () => {
    const client = mockClient();
    wire(client, artist, artist);

    const result = parse(await new PlexTools(client).updateMetadata({ ratingKey: "140400", rating: 8 }));

    expect(client.rateMedia).toHaveBeenCalledWith("140400", 8);
    expect(result.updated).toBe(true);
  });
});

describe("get_children and music context", () => {
  it("lists an album's tracks with album and artist names in one request", async () => {
    const client = mockClient();
    const mock = client.makeRequest as ReturnType<typeof vi.fn>;
    mock.mockResolvedValue({
      MediaContainer: {
        title1: "Nobuo Uematsu",
        title2: "Final Fantasy VIII Original Soundtrack",
        totalSize: 2,
        Metadata: [
          { ratingKey: "267931", type: "track", title: "Liberi Fatali", index: 1, parentIndex: 1,
            parentTitle: "Final Fantasy VIII Original Soundtrack", parentRatingKey: "267930",
            grandparentTitle: "Nobuo Uematsu" },
          { ratingKey: "267932", type: "track", title: "Balamb GARDEN", index: 2, parentIndex: 1,
            parentTitle: "Final Fantasy VIII Original Soundtrack", parentRatingKey: "267930",
            grandparentTitle: "Nobuo Uematsu", originalTitle: "Nobuo Uematsu" },
        ],
      },
    });

    const result = parse(await new PlexTools(client).getChildren("267930"));

    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock.mock.calls[0][0]).toBe("/library/metadata/267930/children");
    expect(result).toMatchObject({ title: "Final Fantasy VIII Original Soundtrack", parentTitle: "Nobuo Uematsu", totalSize: 2 });
    expect(result.items[0]).toMatchObject({
      ratingKey: "267931",
      albumTitle: "Final Fantasy VIII Original Soundtrack",
      albumRatingKey: "267930",
      artistTitle: "Nobuo Uematsu",
      discNumber: 1,
      trackNumber: 1,
    });
    // Same as the album artist, so not repeated.
    expect(result.items[1].trackArtist).toBeUndefined();
  });

  it("pages get_playlist_items when a limit is given", async () => {
    const client = mockClient();
    const mock = client.makeRequest as ReturnType<typeof vi.fn>;
    mock.mockResolvedValue({ MediaContainer: { totalSize: 971, Metadata: [] } });

    const result = parse(await new PlexTools(client).getPlaylistItems("255121", 100, 200));

    expect(mock).toHaveBeenCalledWith("/playlists/255121/items", {
      "X-Plex-Container-Start": 200,
      "X-Plex-Container-Size": 100,
    });
    expect(result).toMatchObject({ offset: 200, totalSize: 971 });
  });
});
