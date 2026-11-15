import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PlexTools, MAX_BULK_EDIT_ITEMS } from "../plex/tools.js";
import { PlexClient } from "../plex/client.js";
import { withAnnotations } from "../shared/tool-annotations.js";
import { PLEX_MUTATIVE_TOOL_SCHEMAS } from "../plex/tool-schemas.js";

type Item = Record<string, unknown> & { ratingKey: string };

const TAG_KEYS: Record<string, string> = {
  genre: "Genre",
  style: "Style",
  mood: "Mood",
  collection: "Collection",
  label: "Label",
};

/**
 * A small in-memory Plex that applies edits the way the real server does, so the
 * tests check what ends up saved rather than only which requests went out.
 */
function fakePlex(items: Item[], children: Record<string, string[]> = {}) {
  const store = new Map(items.map((item) => [item.ratingKey, structuredClone(item)]));
  const calls: Array<{ endpoint: string; params: Record<string, string | number>; method: string }> = [];
  const ignoreFields = new Set<string>();

  const makeRequest = vi.fn(
    async (endpoint: string, params: Record<string, string | number> = {}, method: string = "GET") => {
      calls.push({ endpoint, params, method });

      const kids = endpoint.match(/^\/library\/metadata\/(\d+)\/children$/);
      if (kids) {
        const keys = children[kids[1]] ?? [];
        const start = Number(params["X-Plex-Container-Start"] ?? 0);
        const size = Number(params["X-Plex-Container-Size"] ?? keys.length);
        const page = keys.slice(start, start + size).map((key) => ({ ratingKey: key }));
        return { MediaContainer: { totalSize: keys.length, size: page.length, Metadata: page } };
      }

      const merge = endpoint.match(/^\/library\/metadata\/(\d+)\/merge$/);
      if (merge && method === "PUT") {
        for (const id of String(params.ids).split(",")) store.delete(id);
        return {};
      }

      const meta = endpoint.match(/^\/library\/metadata\/([\d,]+)$/);
      if (meta && method === "GET") {
        const found = meta[1].split(",").map((id) => store.get(id)).filter(Boolean);
        if (found.length === 0) throw Object.assign(new Error("Not Found"), { response: { status: 404 } });
        return { MediaContainer: { Metadata: structuredClone(found) } };
      }

      if (/^\/library\/sections\/\d+\/all$/.test(endpoint) && method === "PUT") {
        for (const id of String(params.id).split(",")) {
          const item = store.get(id);
          if (!item) continue;
          for (const [key, value] of Object.entries(params)) {
            const field = key.match(/^(\w+)\.value$/);
            if (field && !ignoreFields.has(field[1])) item[field[1]] = value;
            const add = key.match(/^(\w+)\[\d+\]\.tag\.tag$/);
            if (add) {
              const list = ((item[TAG_KEYS[add[1]]] as Array<{ tag: string }>) ??= []);
              if (!list.some((t) => t.tag === value)) list.push({ tag: String(value) });
            }
            const remove = key.match(/^(\w+)\[\]\.tag\.tag-$/);
            if (remove) {
              const drop = new Set(String(value).split(","));
              item[TAG_KEYS[remove[1]]] = ((item[TAG_KEYS[remove[1]]] as Array<{ tag: string }>) ?? []).filter(
                (t) => !drop.has(t.tag)
              );
            }
          }
        }
        return {};
      }

      throw new Error(`unexpected request ${method} ${endpoint}`);
    }
  );

  const client = { makeRequest, rateMedia: vi.fn() } as unknown as PlexClient;
  return { client, store, calls, ignoreFields, makeRequest };
}

function parse(response: { content: Array<{ text: string }> }) {
  return JSON.parse(response.content[0].text);
}

const track = (key: string, extra: Record<string, unknown> = {}): Item => ({
  ratingKey: key,
  type: "track",
  title: `Track ${key}`,
  librarySectionID: 3,
  originalTitle: "Old Artist",
  Genre: [{ tag: "Rock" }],
  ...extra,
});

const album = (key: string, extra: Record<string, unknown> = {}): Item => ({
  ratingKey: key,
  type: "album",
  title: `Album ${key}`,
  parentTitle: "Artist",
  librarySectionID: 3,
  leafCount: 10,
  ...extra,
});

describe("music and bulk metadata editing", () => {
  const original = process.env.PLEX_ENABLE_MUTATIVE_OPS;
  beforeEach(() => {
    process.env.PLEX_ENABLE_MUTATIVE_OPS = "true";
  });
  afterEach(() => {
    if (original === undefined) delete process.env.PLEX_ENABLE_MUTATIVE_OPS;
    else process.env.PLEX_ENABLE_MUTATIVE_OPS = original;
  });

  describe("update_metadata music fields", () => {
    it("sets track and disc numbers through Plex's index fields", async () => {
      const plex = fakePlex([track("11")]);
      const result = parse(
        await new PlexTools(plex.client).updateMetadata({ ratingKey: "11", trackNumber: 4, discNumber: 2 })
      );
      expect(result.updated).toBe(true);
      expect(result.verifiedFields.sort()).toEqual(["index", "parentIndex"]);
      expect(plex.store.get("11")).toMatchObject({ index: 4, parentIndex: 2 });
      const put = plex.calls.find((c) => c.method === "PUT");
      expect(put?.params).toMatchObject({ type: 10, "index.locked": 1, "parentIndex.locked": 1 });
    });

    it("replaces styles and moods on an album", async () => {
      const plex = fakePlex([album("20", { Style: [{ tag: "Grunge" }], Mood: [{ tag: "Angry" }] })]);
      await new PlexTools(plex.client).updateMetadata({ ratingKey: "20", styles: ["Shoegaze"], moods: [] });
      const saved = plex.store.get("20") as Record<string, Array<{ tag: string }>>;
      expect(saved.Style.map((t) => t.tag)).toEqual(["Shoegaze"]);
      expect(saved.Mood).toEqual([]);
    });

    it("rejects a malformed release date before any request", async () => {
      const plex = fakePlex([album("20")]);
      await expect(
        new PlexTools(plex.client).updateMetadata({ ratingKey: "20", originallyAvailableAt: "May 2001" })
      ).rejects.toThrow(/YYYY-MM-DD/);
      expect(plex.makeRequest).not.toHaveBeenCalled();
    });

    it("rejects a negative or fractional track number", async () => {
      const plex = fakePlex([track("11")]);
      await expect(new PlexTools(plex.client).updateMetadata({ ratingKey: "11", trackNumber: 1.5 })).rejects.toThrow(
        /whole number/
      );
    });

    it("lists music tags and fields in get_editable_fields for a track", async () => {
      const plex = fakePlex([track("11", { Mood: [{ tag: "Calm" }] })]);
      const result = parse(await new PlexTools(plex.client).getEditableFields("11"));
      expect(result.editableFields).toEqual(expect.arrayContaining(["trackNumber", "discNumber"]));
      expect(result.availableTags.moods).toEqual(["Calm"]);
      expect(result.editableTags).toContain("moods");
    });

    it("leaves get_editable_fields for a movie unchanged", async () => {
      const plex = fakePlex([{ ratingKey: "5", type: "movie", title: "M", librarySectionID: 1 }]);
      const result = parse(await new PlexTools(plex.client).getEditableFields("5"));
      expect(Object.keys(result.availableTags)).toEqual(["genres", "collections", "roles", "directors"]);
      expect(result.editableFields).not.toContain("trackNumber");
    });
  });

  describe("bulk_update_metadata", () => {
    it("edits every track on an album in one request and verifies each", async () => {
      const plex = fakePlex([track("11"), track("12"), track("13")], { "20": ["11", "12", "13"] });
      const result = parse(
        await new PlexTools(plex.client).bulkUpdateMetadata({
          parentRatingKey: "20",
          fields: { originalTitle: "New Artist", discNumber: 1 },
          addTags: { genres: ["Indie"], moods: ["Upbeat"] },
          removeTags: { genres: ["Rock"] },
        })
      );

      expect(result).toMatchObject({ updated: 3, itemCount: 3, type: "track", librarySectionID: "3" });
      expect(result.failed).toBeUndefined();
      for (const key of ["11", "12", "13"]) {
        const item = plex.store.get(key) as Record<string, unknown>;
        expect(item.originalTitle).toBe("New Artist");
        expect(item.parentIndex).toBe(1);
        expect((item.Genre as Array<{ tag: string }>).map((t) => t.tag)).toEqual(["Indie"]);
        expect((item.Mood as Array<{ tag: string }>).map((t) => t.tag)).toEqual(["Upbeat"]);
      }

      const puts = plex.calls.filter((c) => c.method === "PUT");
      // One pass for fields and additions, one for the removal.
      expect(puts).toHaveLength(2);
      expect(puts[0].params).toMatchObject({
        id: "11,12,13",
        type: 10,
        "originalTitle.value": "New Artist",
        "originalTitle.locked": 1,
        "parentIndex.value": 1,
        "genre[0].tag.tag": "Indie",
        "genre.locked": 1,
      });
      expect(puts[1].params).toMatchObject({ id: "11,12,13", "genre[].tag.tag-": "Rock" });
    });

    it("previews without writing when dryRun is set", async () => {
      const plex = fakePlex([track("11"), track("12")]);
      const result = parse(
        await new PlexTools(plex.client).bulkUpdateMetadata({
          ratingKeys: ["11", "12"],
          fields: { originalTitle: "New Artist" },
          addTags: { genres: ["Indie"] },
          dryRun: true,
        })
      );
      expect(result.dryRun).toBe(true);
      expect(result.items[0]).toMatchObject({
        ratingKey: "11",
        current: { originalTitle: "Old Artist" },
        currentTags: { genre: ["Rock"] },
      });
      expect(plex.calls.some((c) => c.method === "PUT")).toBe(false);
    });

    it("reports items where Plex didn't save the edit", async () => {
      const plex = fakePlex([track("11"), track("12")]);
      plex.ignoreFields.add("originalTitle");
      const result = parse(
        await new PlexTools(plex.client).bulkUpdateMetadata({
          ratingKeys: ["11", "12"],
          fields: { originalTitle: "New Artist" },
        })
      );
      expect(result.updated).toBe(0);
      expect(result.failed).toHaveLength(2);
      expect(result.failed[0].problems[0]).toMatch(/originalTitle still reads "Old Artist"/);
    });

    it("splits large edits into requests of 100 items", async () => {
      const keys = Array.from({ length: 250 }, (_, i) => String(1000 + i));
      const plex = fakePlex(keys.map((key) => track(key)));
      const result = parse(
        await new PlexTools(plex.client).bulkUpdateMetadata({ ratingKeys: keys, fields: { year: 1999 } })
      );
      expect(result.updated).toBe(250);
      const puts = plex.calls.filter((c) => c.method === "PUT");
      expect(puts.map((c) => String(c.params.id).split(",").length)).toEqual([100, 100, 50]);
    });

    it("refuses a mix of item types", async () => {
      const plex = fakePlex([track("11"), album("20")]);
      await expect(
        new PlexTools(plex.client).bulkUpdateMetadata({ ratingKeys: ["11", "20"], fields: { year: 2000 } })
      ).rejects.toThrow(/same type/);
      expect(plex.calls.some((c) => c.method === "PUT")).toBe(false);
    });

    it("refuses items from different libraries", async () => {
      const plex = fakePlex([track("11"), track("12", { librarySectionID: 4 })]);
      await expect(
        new PlexTools(plex.client).bulkUpdateMetadata({ ratingKeys: ["11", "12"], fields: { year: 2000 } })
      ).rejects.toThrow(/same library/);
    });

    it("names rating keys that don't exist", async () => {
      const plex = fakePlex([track("11")]);
      await expect(
        new PlexTools(plex.client).bulkUpdateMetadata({ ratingKeys: ["11", "99"], fields: { year: 2000 } })
      ).rejects.toThrow(/not found: 99/);
    });

    it("refuses per-item fields such as title", async () => {
      const plex = fakePlex([track("11")]);
      await expect(
        new PlexTools(plex.client).bulkUpdateMetadata({
          ratingKeys: ["11"],
          fields: { title: "Same" } as unknown as Record<string, string>,
        })
      ).rejects.toThrow(/can't be set in bulk/);
    });

    it("refuses adding and removing the same tag", async () => {
      const plex = fakePlex([track("11")]);
      await expect(
        new PlexTools(plex.client).bulkUpdateMetadata({
          ratingKeys: ["11"],
          addTags: { genres: ["Rock"] },
          removeTags: { genres: ["Rock"] },
        })
      ).rejects.toThrow(/both add and remove/);
    });

    it("needs exactly one of ratingKeys and parentRatingKey", async () => {
      const tools = new PlexTools(fakePlex([]).client);
      await expect(tools.bulkUpdateMetadata({ fields: { year: 1 } })).rejects.toThrow(/either ratingKeys or parentRatingKey/);
      await expect(
        tools.bulkUpdateMetadata({ ratingKeys: ["1"], parentRatingKey: "2", fields: { year: 1 } })
      ).rejects.toThrow(/either ratingKeys or parentRatingKey/);
    });

    it("rejects non-numeric rating keys", async () => {
      const tools = new PlexTools(fakePlex([]).client);
      await expect(tools.bulkUpdateMetadata({ ratingKeys: ["1/../2"], fields: { year: 1 } })).rejects.toThrow(
        /numeric Plex ID/
      );
    });

    it(`caps a parent's children at ${MAX_BULK_EDIT_ITEMS}`, async () => {
      const keys = Array.from({ length: MAX_BULK_EDIT_ITEMS + 5 }, (_, i) => String(5000 + i));
      const plex = fakePlex([], { "20": keys });
      await expect(
        new PlexTools(plex.client).bulkUpdateMetadata({ parentRatingKey: "20", fields: { year: 1 } })
      ).rejects.toThrow(/at most 500/);
    });

    it("is refused while write operations are off", async () => {
      delete process.env.PLEX_ENABLE_MUTATIVE_OPS;
      const plex = fakePlex([track("11")]);
      await expect(
        new PlexTools(plex.client).bulkUpdateMetadata({ ratingKeys: ["11"], fields: { year: 1 } })
      ).rejects.toThrow();
      expect(plex.makeRequest).not.toHaveBeenCalled();
    });
  });

  describe("merge_items", () => {
    it("previews without merging unless confirmed", async () => {
      const plex = fakePlex([album("20"), album("21")]);
      const result = parse(await new PlexTools(plex.client).mergeItems("20", ["21"]));
      expect(result).toMatchObject({ preview: true, confirmationRequired: true, type: "album" });
      expect(result.sources[0]).toMatchObject({ ratingKey: "21", title: "Album 21" });
      expect(plex.calls.some((c) => c.method === "PUT")).toBe(false);
    });

    it("merges duplicate albums into the target", async () => {
      const plex = fakePlex([album("20"), album("21"), album("22")]);
      const result = parse(await new PlexTools(plex.client).mergeItems("20", ["21", "22"], true));
      expect(result).toMatchObject({ merged: true, mergedSources: ["21", "22"] });
      const put = plex.calls.find((c) => c.method === "PUT");
      expect(put).toMatchObject({ endpoint: "/library/metadata/20/merge", params: { ids: "21,22" } });
      expect(plex.store.has("20")).toBe(true);
      expect(plex.store.has("21")).toBe(false);
    });

    it("refuses tracks, which Plex can't merge", async () => {
      const plex = fakePlex([track("11"), track("12")]);
      await expect(new PlexTools(plex.client).mergeItems("11", ["12"], true)).rejects.toThrow(/not tracks/);
    });

    it("refuses a target that is also a source", async () => {
      const tools = new PlexTools(fakePlex([album("20")]).client);
      await expect(tools.mergeItems("20", ["20"], true)).rejects.toThrow(/can't also be one of the sources/);
    });

    it("is advertised as destructive", () => {
      const tools = withAnnotations(PLEX_MUTATIVE_TOOL_SCHEMAS);
      expect(tools.find((t) => t.name === "merge_items")?.annotations.destructiveHint).toBe(true);
      expect(tools.find((t) => t.name === "bulk_update_metadata")?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
      });
    });
  });
});
