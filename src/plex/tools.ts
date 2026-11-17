/**
 * Plex tool implementations.
 * All Plex MCP tools with typed args and no `as any` casts.
 */

import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { createWriteStream } from "node:fs";
import { lstat, mkdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { PlexClient } from "./client.js";
import { MCPResponse, LibraryMovieRecord, TasteProfile } from "./types.js";
import {
  DEFAULT_LIMITS,
  COMPLETION_THRESHOLD,
  PLEX_CONTAINER_SIZE,
  PLEX_FILTERED_SCAN_MAX_PAGES,
  SUMMARY_PREVIEW_LENGTH,
  PLEX_MUTATIVE_OPS_ENV_VAR,
  isMutativeOpsEnabled,
  isContentCompleted,
  RECENCY_HALF_LIFE_DAYS,
  TASTE_TOP_GENRES,
  TASTE_TOP_DIRECTORS,
  TASTE_TOP_ACTORS,
  MIN_WATCHED_FOR_RECOMMENDATIONS,
  SMART_PLAYLIST_LIBTYPE_IDS,
  PLEX_TAGGABLE_TYPE_IDS,
} from "./constants.js";
import { chunkArray, truncate, validatePlexId, sanitizeSearchQuery, validatePlexMediaContainer, validatePlexTotalSize, posterUrlProblem } from "../shared/utils.js";
import { formatToolPayload } from "../shared/output-format.js";

/**
 * Helper: the paging pair for a request that wants the first `size` items.
 * Plex ignores X-Plex-Container-Size unless X-Plex-Container-Start is sent with it.
 */
function firstPage(size: number) {
  return { "X-Plex-Container-Start": 0, "X-Plex-Container-Size": size };
}

/**
 * Helper: rows to ask one library for when the caller keeps its `limit` most recently
 * viewed, merged across libraries. Any one library may hold the whole top `limit`, so at
 * least `limit`; doubled as headroom for in-progress rows, which sort among the views and
 * are filtered out afterwards. A heuristic: more in-progress rows than `limit` still cost
 * slots, but the cost stays one request per library.
 */
function recencyPageSize(limit: number) {
  return Math.max(1, limit) * 2;
}

/** Helper: wrap a JSON value as an MCP text response */
function jsonResponse(data: unknown): MCPResponse {
  return { content: [{ type: "text", text: formatToolPayload(data, 2) }] };
}

/** Helper: "/library/metadata/32820" -> "32820"; undefined for any other shape. */
function ratingKeyFromKey(key: unknown): string | undefined {
  return typeof key === "string" ? key.match(/^\/library\/metadata\/(\d+)$/)?.[1] : undefined;
}

/**
 * Helper: the fields that tie an episode or season to its show.
 * Plex's raw parent/grandparent fields change meaning with the item type
 * (an episode's parentTitle is "Season 1", a season's is the show name), so
 * they are normalised here. Empty for movies and shows, so nothing is added.
 */
function showContext(item: Record<string, unknown>) {
  if (item.type === "episode") {
    return {
      showTitle: item.grandparentTitle,
      // History entries carry grandparentKey ("/library/metadata/<id>") but no grandparentRatingKey.
      showRatingKey: item.grandparentRatingKey ?? ratingKeyFromKey(item.grandparentKey),
      seasonNumber: item.parentIndex,
      episodeNumber: item.index,
    };
  }
  if (item.type === "season") {
    return {
      showTitle: item.parentTitle,
      showRatingKey: item.parentRatingKey,
      seasonNumber: item.index,
    };
  }
  if (item.type === "track") {
    return {
      albumTitle: item.parentTitle,
      albumRatingKey: item.parentRatingKey ?? ratingKeyFromKey(item.parentKey),
      artistTitle: item.grandparentTitle,
      // Track-level artist when it differs from the album artist (features, compilations).
      trackArtist: item.originalTitle && item.originalTitle !== item.grandparentTitle ? item.originalTitle : undefined,
      discNumber: item.parentIndex,
      trackNumber: item.index,
    };
  }
  if (item.type === "album") {
    return {
      artistTitle: item.parentTitle,
      artistRatingKey: item.parentRatingKey ?? ratingKeyFromKey(item.parentKey),
    };
  }
  return {};
}

/**
 * Helper: whether a result of the unwatched=0 query is fully watched.
 * Plex is exact for items without children (movies, episodes). It also lets
 * partly watched shows and seasons through, and those carry leafCount and
 * viewedLeafCount, so they are checked here.
 */
function isFullyWatched(item: Record<string, unknown>): boolean {
  if (typeof item.leafCount !== "number") return true;
  return item.leafCount > 0 && ((item.viewedLeafCount as number | undefined) ?? 0) >= item.leafCount;
}

/**
 * Helper: percent watched for a library item. Uses the playback offset when there is
 * one; shows and seasons have none, so they use the share of episodes watched. Items
 * with neither are finished, since Plex omits viewOffset once something is watched.
 */
function progressPercent(item: Record<string, unknown>): number {
  if ((item.viewOffset as number) && (item.duration as number)) {
    return Math.round(((item.viewOffset as number) / (item.duration as number)) * 100);
  }
  if (typeof item.leafCount === "number" && item.leafCount > 0) {
    return Math.round((((item.viewedLeafCount as number | undefined) ?? 0) / item.leafCount) * 100);
  }
  return 100;
}

/** The history row type each history filter matches. TV shows appear as their episodes. */
const HISTORY_ROW_TYPES: Record<string, string> = { movie: "movie", show: "episode", episode: "episode", track: "track" };

/** Helper: the history row type for a mediaType, or undefined for "all". Throws on anything else. */
function historyRowType(mediaType: string): string | undefined {
  if (mediaType === "all") return undefined;
  if (!Object.hasOwn(HISTORY_ROW_TYPES, mediaType)) {
    throw new Error(
      `Unknown media type "${mediaType}" for watch history. Expected one of: all, ${Object.keys(HISTORY_ROW_TYPES).join(", ")}`
    );
  }
  return HISTORY_ROW_TYPES[mediaType];
}

type MetadataUpdateInput = {
  ratingKey: string;
  title?: string;
  sortTitle?: string;
  originalTitle?: string;
  summary?: string;
  year?: number;
  contentRating?: string;
  rating?: number;
  tagline?: string;
  studio?: string;
  originallyAvailableAt?: string;
  trackNumber?: number;
  discNumber?: number;
  genres?: unknown[];
  collections?: unknown[];
  roles?: unknown[];
  directors?: unknown[];
  styles?: unknown[];
  moods?: unknown[];
  labels?: unknown[];
};

type EditableTagType = "genre" | "collection" | "role" | "director" | "style" | "mood" | "label";

/** Tool input key for each tag list, paired with the Plex tag name it edits. */
const TAG_INPUTS = [
  ["genres", "genre"],
  ["collections", "collection"],
  ["roles", "role"],
  ["directors", "director"],
  ["styles", "style"],
  ["moods", "mood"],
  ["labels", "label"],
] as const satisfies ReadonlyArray<readonly [keyof MetadataUpdateInput, EditableTagType]>;

/** The Metadata key Plex lists each tag type under (Genre, Style, ...). */
const TAG_CONTAINER_KEYS: Record<EditableTagType, string> = {
  genre: "Genre",
  collection: "Collection",
  role: "Role",
  director: "Director",
  style: "Style",
  mood: "Mood",
  label: "Label",
};

/** Tags a bulk edit may add or remove. Roles and directors are per-item credits, so they're left out. */
const BULK_TAG_INPUTS = TAG_INPUTS.filter(([, tag]) => tag !== "role" && tag !== "director");

/** Most items one bulk edit or merge touches, so one call can't rewrite a whole library. */
export const MAX_BULK_EDIT_ITEMS = 500;
export const MAX_MERGE_SOURCES = 50;
/** Ids per Plex request, so query strings stay well under typical URL limits. */
const BULK_REQUEST_CHUNK = 100;

/** Plain fields a bulk edit may set: tool input key -> Plex field name. Titles and track numbers are per item. */
const BULK_FIELD_INPUTS = {
  originalTitle: "originalTitle",
  summary: "summary",
  year: "year",
  originallyAvailableAt: "originallyAvailableAt",
  contentRating: "contentRating",
  tagline: "tagline",
  studio: "studio",
  discNumber: "parentIndex",
} as const;

export type BulkMetadataInput = {
  ratingKeys?: string[];
  parentRatingKey?: string;
  fields?: Partial<Record<keyof typeof BULK_FIELD_INPUTS, string | number>>;
  addTags?: Partial<Record<(typeof BULK_TAG_INPUTS)[number][0], unknown[]>>;
  removeTags?: Partial<Record<(typeof BULK_TAG_INPUTS)[number][0], unknown[]>>;
  dryRun?: boolean;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Turn the music-specific inputs into Plex field edits, or explain why one is invalid. */
function musicFieldParams(
  input: { originallyAvailableAt?: unknown; trackNumber?: unknown; discNumber?: unknown },
  params: Record<string, string | number>
): void {
  if (input.originallyAvailableAt !== undefined) {
    const date = String(input.originallyAvailableAt).trim();
    if (!DATE_RE.test(date) || Number.isNaN(Date.parse(date))) {
      throw new McpError(ErrorCode.InvalidRequest, "originallyAvailableAt must be a date in YYYY-MM-DD form");
    }
    params.originallyAvailableAt = date;
  }
  for (const [key, field] of [["trackNumber", "index"], ["discNumber", "parentIndex"]] as const) {
    const value = input[key];
    if (value === undefined) continue;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0) {
      throw new McpError(ErrorCode.InvalidRequest, `${key} must be a whole number of 0 or more`);
    }
    params[field] = n;
  }
}

export class PlexTools {
  private machineIdentifier?: string;

  constructor(private client: PlexClient) {}

  // ── Core tools ──────────────────────────────────────────────

  async getLibraries(): Promise<MCPResponse> {
    const data = await this.client.makeRequest("/library/sections");
    const validated = validatePlexMediaContainer(data);
    const libraries = (validated.MediaContainer as Record<string, unknown> | undefined)?.Directory as Record<string, unknown>[] || [];

    return jsonResponse({
      libraries: libraries.map((lib) => ({
        key: lib.key,
        title: lib.title,
        type: lib.type,
        scannedAt: lib.scannedAt,
        count: lib.count,
      })),
    });
  }

  async getLibraryItems(
    libraryKey: string,
    type?: string,
    limit: number = DEFAULT_LIMITS.libraryItems,
    offset: number = 0,
    sort?: string
  ): Promise<MCPResponse> {
    validatePlexId(libraryKey, "libraryKey");

    const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_LIMITS.libraryItems;
    const safeOffset = Number.isFinite(offset) && offset >= 0 ? Math.floor(offset) : 0;
    const params: Record<string, string | number> = {
      "X-Plex-Container-Start": safeOffset,
      "X-Plex-Container-Size": safeLimit,
    };

    if (type) {
      params.type = this.client.getPlexTypeId(type);
    }
    if (sort) {
      params.sort = sort;
    }

    const data = await this.client.makeRequest(`/library/sections/${libraryKey}/all`, params);
    const container = validatePlexTotalSize(data);
    const items = container.MediaContainer?.Metadata || [];
    const totalSize = container.MediaContainer?.totalSize || 0;

    // Defensive: warn if offset exceeds total size
    const warning =
      safeOffset > totalSize
        ? `offset (${safeOffset}) exceeds total size (${totalSize}); returning empty results`
        : undefined;

    return jsonResponse({
      libraryKey,
      offset: safeOffset,
      limit: safeLimit,
      totalSize,
      ...(warning ? { warning } : {}),
      items: items.map((item) => ({
        ratingKey: item.ratingKey,
        title: item.title,
        originalTitle: item.originalTitle,
        year: item.year,
        type: item.type,
        ...showContext(item),
        guid: item.guid,
        editionTitle: item.editionTitle,
      })),
    });
  }

  async exportLibrary(
    libraryKey: string,
    type?: string,
    outputPath?: string,
    pageSize: number = DEFAULT_LIMITS.exportPageSize
  ): Promise<MCPResponse> {
    validatePlexId(libraryKey, "libraryKey");

    const baseExportDir = path.resolve(process.env.PLEX_EXPORT_DIR?.trim() || path.join(process.cwd(), "exports"));
    let exportPath: string;
    if (outputPath) {
      if (path.isAbsolute(outputPath)) {
        throw new McpError(ErrorCode.InvalidRequest, "Absolute paths are not allowed for outputPath");
      }

      const resolvedPath = path.resolve(baseExportDir, outputPath);
      const basePrefix = `${baseExportDir}${path.sep}`;
      if (resolvedPath !== baseExportDir && !resolvedPath.startsWith(basePrefix)) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          "outputPath must be within the exports directory and must not contain path traversal"
        );
      }
      exportPath = resolvedPath;
    } else {
      exportPath = path.join(baseExportDir, `library_${libraryKey}_${Date.now()}.json`);
    }

    // The string check above can't see symlinks: exports/link -> /etc would
    // pass it. Resolve real paths, and do it before creating anything, since
    // mkdir would follow the link and create directories outside the base.
    // The base itself is operator configuration, so it is created as given.
    await mkdir(baseExportDir, { recursive: true });
    const realBase = await realpath(baseExportDir);
    const assertInsideBase = (realDir: string) => {
      if (realDir !== realBase && !realDir.startsWith(`${realBase}${path.sep}`)) {
        throw new McpError(ErrorCode.InvalidRequest, "outputPath must resolve inside the exports directory");
      }
    };
    const exportDir = path.dirname(exportPath);
    assertInsideBase(await this.realpathOfDeepestExisting(exportDir));
    await mkdir(exportDir, { recursive: true });
    // Checked again in case a link was swapped in while the directories were made.
    assertInsideBase(await realpath(exportDir));

    const safePageSize =
      Number.isFinite(pageSize) && pageSize > 0 ? Math.floor(pageSize) : DEFAULT_LIMITS.exportPageSize;
    // "wx": never replace an existing file. With O_EXCL this also refuses a
    // symlink planted at the target name.
    const stream = createWriteStream(exportPath, { encoding: "utf8", flags: "wx" });
    let streamError: Error | null = null;
    let created = false;
    stream.once("open", () => {
      created = true;
    });
    stream.once("error", (error) => {
      streamError = error as Error;
    });

    let offset = 0;
    let totalSize = 0;
    let totalExported = 0;
    let isFirst = true;

    try {
      // Fail before paging through Plex if the file can't be created.
      await new Promise<void>((resolve, reject) => {
        stream.once("open", () => resolve());
        stream.once("error", reject);
      });
      await this.writeToStream(stream, "[\n");

      while (true) {
        const params: Record<string, string | number> = {
          "X-Plex-Container-Start": offset,
          "X-Plex-Container-Size": safePageSize,
        };
        if (type) {
          params.type = this.client.getPlexTypeId(type);
        }

        const data = await this.client.makeRequest(`/library/sections/${libraryKey}/all`, params);
        const container = data as {
          MediaContainer?: { Metadata?: Record<string, unknown>[]; totalSize?: number };
        };
        const items = container.MediaContainer?.Metadata || [];
        totalSize = typeof container.MediaContainer?.totalSize === "number" ? container.MediaContainer.totalSize : totalSize;

        for (const item of items) {
          if (!isFirst) {
            await this.writeToStream(stream, ",\n");
          }

          await this.writeToStream(
            stream,
            JSON.stringify({
              ratingKey: item.ratingKey,
              title: item.title,
              year: item.year,
              type: item.type,
              ...showContext(item),
              guid: item.guid,
              originalTitle: item.originalTitle,
              editionTitle: item.editionTitle,
            })
          );
          isFirst = false;
          totalExported += 1;
        }

        offset += items.length;
        if (items.length === 0 || (totalSize > 0 && offset >= totalSize)) {
          break;
        }
      }

      await this.writeToStream(stream, "\n]\n");
      await this.finishStream(stream);
    } catch (error) {
      stream.destroy();
      // Only clean up a file this call created — never one that was already there.
      if (created) {
        await rm(exportPath, { force: true }).catch(() => undefined);
      }
      if (error instanceof McpError) {
        throw error;
      }
      if ((streamError as NodeJS.ErrnoException | null)?.code === "EEXIST") {
        throw new McpError(
          ErrorCode.InvalidRequest,
          `An export already exists at ${exportPath}; choose a different outputPath`
        );
      }
      const message = this.getErrorMessage(streamError || error);
      throw new McpError(ErrorCode.InternalError, `Failed to export library: ${message}`);
    }

    return jsonResponse({
      exported: true,
      libraryKey,
      type: type || "all",
      outputPath: exportPath,
      totalExported,
      totalSize: totalSize || totalExported,
    });
  }

  async searchMedia(
    query: string,
    type?: string,
    libraryKey?: string,
    limit: number = DEFAULT_LIMITS.searchMedia,
    offset: number = 0
  ): Promise<MCPResponse> {
    const sanitizedQuery = sanitizeSearchQuery(query);

    const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_LIMITS.searchMedia;
    const safeOffset = Number.isFinite(offset) && offset >= 0 ? Math.floor(offset) : 0;
    const params: Record<string, string | number> = {
      query: sanitizedQuery,
      "X-Plex-Container-Start": safeOffset,
      "X-Plex-Container-Size": safeLimit,
    };
    if (type) {
      params.type = this.client.getPlexTypeId(type);
    }

    if (libraryKey) {
      validatePlexId(libraryKey, "libraryKey");
    }
    const endpoint = libraryKey ? `/library/sections/${libraryKey}/search` : "/search";
    const data = await this.client.makeRequest(endpoint, params);
    const container = data as { MediaContainer?: { Metadata?: Record<string, unknown>[] } };
    const results = container.MediaContainer?.Metadata || [];

    return jsonResponse({
      query: sanitizedQuery,
      libraryKey: libraryKey || "all",
      offset: safeOffset,
      limit: safeLimit,
      results: results.map((item) => ({
        ratingKey: item.ratingKey,
        title: item.title,
        type: item.type,
        ...showContext(item),
        year: item.year,
        summary: item.summary ? truncate(String(item.summary), SUMMARY_PREVIEW_LENGTH) : undefined,
        rating: item.rating,
      })),
    });
  }

  async getPlaylists(): Promise<MCPResponse> {
    const data = await this.client.makeRequest("/playlists");
    const container = data as { MediaContainer?: { Metadata?: Record<string, unknown>[] } };
    const playlists = container.MediaContainer?.Metadata || [];

    return jsonResponse({
      playlists: playlists.map((playlist) => ({
        ratingKey: playlist.ratingKey,
        key: playlist.key,
        title: playlist.title,
        type: playlist.type,
        playlistType: playlist.playlistType,
        smart: playlist.smart,
        leafCount: playlist.leafCount,
        duration: playlist.duration,
        summary: playlist.summary ? truncate(String(playlist.summary), SUMMARY_PREVIEW_LENGTH) : undefined,
        updatedAt: playlist.updatedAt,
        addedAt: playlist.addedAt,
      })),
    });
  }

  /**
   * List an item's direct children: an artist's albums, an album's tracks,
   * a show's seasons or a season's episodes. One request, paged.
   */
  async getChildren(ratingKey: string, limit?: number, offset: number = 0): Promise<MCPResponse> {
    validatePlexId(ratingKey, "ratingKey");
    const safeOffset = Number.isFinite(offset) && offset >= 0 ? Math.floor(offset) : 0;
    const params: Record<string, string | number> = { "X-Plex-Container-Start": safeOffset };
    if (limit !== undefined && Number.isFinite(limit) && limit > 0) {
      params["X-Plex-Container-Size"] = Math.floor(limit);
    }

    const data = await this.client.makeRequest(`/library/metadata/${ratingKey}/children`, params);
    const mc = (data as { MediaContainer?: Record<string, unknown> }).MediaContainer || {};
    const items = (mc.Metadata as Record<string, unknown>[] | undefined) || [];

    return jsonResponse({
      ratingKey,
      // Plex's container titles: title2 is the item itself, title1 its parent (e.g. album, artist).
      title: mc.title2 ?? mc.parentTitle,
      parentTitle: mc.title1,
      totalSize: (mc.totalSize as number | undefined) ?? (mc.size as number | undefined) ?? items.length,
      offset: safeOffset,
      items: items.map((item) => ({
        ratingKey: item.ratingKey,
        title: item.title,
        type: item.type,
        ...showContext(item),
        index: item.type === "track" || item.type === "episode" ? undefined : item.index,
        year: item.year,
        duration: item.duration,
        viewCount: item.viewCount,
        userRating: item.userRating,
      })),
    });
  }

  async getPlaylistItems(playlistId: string, limit?: number, offset: number = 0): Promise<MCPResponse> {
    validatePlexId(playlistId, "playlistId");

    const safeOffset = Number.isFinite(offset) && offset >= 0 ? Math.floor(offset) : 0;
    const params: Record<string, string | number> = {};
    if (limit !== undefined && Number.isFinite(limit) && limit > 0) {
      params["X-Plex-Container-Start"] = safeOffset;
      params["X-Plex-Container-Size"] = Math.floor(limit);
    }

    const data = await this.client.makeRequest(`/playlists/${playlistId}/items`, params);
    const container = data as { MediaContainer?: { Metadata?: Record<string, unknown>[]; totalSize?: number } };
    const items = container.MediaContainer?.Metadata || [];
    const paged = params["X-Plex-Container-Size"] !== undefined;

    return jsonResponse({
      playlistId,
      ...(paged ? { offset: safeOffset, totalSize: container.MediaContainer?.totalSize } : {}),
      items: items.map((item) => ({
        playlistItemID: item.playlistItemID,
        ratingKey: item.ratingKey,
        title: item.title,
        type: item.type,
        ...showContext(item),
        year: item.year,
        duration: item.duration,
        summary: item.summary ? truncate(String(item.summary), SUMMARY_PREVIEW_LENGTH) : undefined,
      })),
    });
  }

  async getWatchlist(): Promise<MCPResponse> {
    const data = await this.client.makeDiscoverRequest(
      "/library/sections/watchlist/all",
      { includeCollections: 1, includeExternalMedia: 1 },
      "GET"
    );
    const container = data as { MediaContainer?: { Metadata?: Record<string, unknown>[] } };
    const watchlist = container.MediaContainer?.Metadata || [];
    return jsonResponse({
      watchlist: watchlist.map((item) => ({
        ratingKey: item.ratingKey,
        guid: item.guid,
        title: item.title,
        type: item.type,
        year: item.year,
        summary: item.summary ? truncate(String(item.summary), SUMMARY_PREVIEW_LENGTH) : undefined,
        addedAt: item.watchlistedAt ?? item.addedAt,
      })),
      source: "Plex Discover account watchlist",
    });
  }

  async getEditableFields(ratingKey: string): Promise<MCPResponse> {
    validatePlexId(ratingKey, "ratingKey");

    const data = await this.client.makeRequest(`/library/metadata/${ratingKey}`);
    const container = data as { MediaContainer?: { Metadata?: Record<string, unknown>[] } };
    const item = container.MediaContainer?.Metadata?.[0];

    if (!item) {
      throw new McpError(ErrorCode.InvalidRequest, `Media item not found: ${ratingKey}`);
    }

    const isMusic = item.type === "artist" || item.type === "album" || item.type === "track";
    const availableTags: Record<string, string[]> = {
      genres: this.getCurrentTags(item, "genre"),
      collections: this.getCurrentTags(item, "collection"),
      roles: this.getCurrentTags(item, "role"),
      directors: this.getCurrentTags(item, "director"),
      ...(isMusic
        ? {
            styles: this.getCurrentTags(item, "style"),
            moods: this.getCurrentTags(item, "mood"),
            labels: this.getCurrentTags(item, "label"),
          }
        : {}),
    };

    const editableFields = [
      "title",
      "sortTitle",
      "originalTitle",
      "summary",
      "year",
      "contentRating",
      "rating",
      "tagline",
      "studio",
      ...(item.type === "album" ? ["originallyAvailableAt"] : []),
      ...(item.type === "track" ? ["trackNumber", "discNumber"] : []),
    ];

    const editableTags = Object.keys(availableTags).filter((key) => availableTags[key].length > 0);

    // Plex lists a field in `Field` only while it is locked against metadata refreshes.
    const lockedFields = (
      (item.Field as Array<{ name?: string; locked?: boolean }> | undefined) ?? []
    )
      .filter((field) => field.locked && field.name)
      .map((field) => field.name as string);

    return jsonResponse({
      ratingKey,
      type: item.type,
      title: item.title,
      librarySectionID: item.librarySectionID,
      editableFields,
      editableTags,
      availableTags,
      lockedFields,
      notes: [
        "Roles/directors availability depends on agent/library type.",
        ...(item.type === "track"
          ? ["For a track, originalTitle is the track artist. Which album a track is on comes from the file's tags and can't be edited here."]
          : []),
        "If a tag array is empty, Plex likely won't accept edits for that tag type.",
        "lockedFields uses Plex's own field names (e.g. genre, collection) and lists only fields locked against metadata refreshes.",
      ],
    });
  }

  async getRecentlyAdded(
    limit: number = DEFAULT_LIMITS.recentlyAdded,
    type?: string,
    libraryKey?: string
  ): Promise<MCPResponse> {
    if (Boolean(type) !== Boolean(libraryKey)) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        "type and libraryKey must be given together to list recently added items of one type"
      );
    }

    const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_LIMITS.recentlyAdded;
    const params: Record<string, string | number> = {
      "X-Plex-Container-Start": 0,
      "X-Plex-Container-Size": safeLimit,
    };
    let endpoint = "/library/recentlyAdded";
    if (type && libraryKey) {
      // /library/recentlyAdded groups episodes under their season and sorts by the season's addedAt,
      // so a new episode of an existing season never shows up. Listing one type sorts by its own addedAt.
      validatePlexId(libraryKey, "libraryKey");
      endpoint = `/library/sections/${libraryKey}/all`;
      params.type = this.client.getPlexTypeId(type);
      params.sort = "addedAt:desc";
    }

    const data = await this.client.makeRequest(endpoint, params);
    const container = data as { MediaContainer?: { Metadata?: Record<string, unknown>[] } };
    const items = container.MediaContainer?.Metadata || [];

    return jsonResponse({
      recentlyAdded: items.map((item) => ({
        ratingKey: item.ratingKey,
        title: item.title,
        type: item.type,
        ...showContext(item),
        year: item.year,
        addedAt: item.addedAt,
        summary: item.summary ? truncate(String(item.summary), SUMMARY_PREVIEW_LENGTH) : undefined,
      })),
    });
  }

  async getOnDeck(): Promise<MCPResponse> {
    const data = await this.client.makeRequest("/library/onDeck");
    const container = data as { MediaContainer?: { Metadata?: Record<string, unknown>[] } };
    const items = container.MediaContainer?.Metadata || [];

    return jsonResponse({
      onDeck: items.map((item) => ({
        ratingKey: item.ratingKey,
        title: item.title,
        type: item.type,
        ...showContext(item),
        viewOffset: item.viewOffset,
        duration: item.duration,
        lastViewedAt: item.lastViewedAt,
      })),
    });
  }

  async getActiveSessions(): Promise<MCPResponse> {
    const data = await this.client.makeRequest("/status/sessions");
    const container = data as { MediaContainer?: { Metadata?: Record<string, unknown>[] } };
    const items = container.MediaContainer?.Metadata ?? [];

    return jsonResponse({
      activeSessions: items.map((item) => {
        // Plex returns Media as a list (python-plexapi: "media (List<Media>)").
        // The first entry describes the stream actually being played.
        const media = (item.Media as Record<string, unknown>[] | undefined)?.[0];
        const player = item.Player as Record<string, unknown> | undefined;
        const session = item.Session as Record<string, unknown> | undefined;
        const transcode = item.TranscodeSession as Record<string, unknown> | undefined;

        return {
          ratingKey: item.ratingKey,
          sessionKey: item.sessionKey,
          title: item.title,
          type: item.type,
          grandparentTitle: item.grandparentTitle,
          parentTitle: item.parentTitle,
          summary: item.summary
            ? truncate(String(item.summary), SUMMARY_PREVIEW_LENGTH)
            : undefined,
          duration: item.duration,
          viewOffset: item.viewOffset,
          user: (item.User as Record<string, unknown> | undefined)?.title ?? null,
          player: player
            ? { title: player.title, state: player.state, platform: player.platform }
            : null,
          session: session ? { location: session.location } : null,
          transcode: transcode
            ? {
                videoDecision: transcode.videoDecision,
                audioDecision: transcode.audioDecision,
              }
            : null,
          media: media
            ? {
                videoResolution: media.videoResolution,
                videoCodec: media.videoCodec,
                audioCodec: media.audioCodec,
              }
            : null,
        };
      }),
      // Derived from what we actually return — MediaContainer.size can be
      // stale or reflect paging rather than the sessions in this payload.
      sessionCount: items.length,
    });
  }

  async getMediaDetails(ratingKey: string): Promise<MCPResponse> {
    validatePlexId(ratingKey, "ratingKey");
    const data = await this.client.makeRequest(`/library/metadata/${ratingKey}`);
    const container = data as { MediaContainer?: { Metadata?: Record<string, unknown>[] } };
    const item = container.MediaContainer?.Metadata?.[0];

    if (!item) {
      throw new McpError(ErrorCode.InvalidRequest, `Media item not found: ${ratingKey}`);
    }

    return jsonResponse({
      details: {
        ratingKey: item.ratingKey,
        title: item.title,
        type: item.type,
        ...showContext(item),
        year: item.year,
        summary: item.summary,
        rating: item.rating,
        duration: item.duration,
        genres: (item.Genre as Array<{ tag: string }> | undefined)?.map((g) => g.tag) || [],
        actors: (item.Role as Array<{ tag: string }> | undefined)?.map((r) => r.tag) || [],
        directors: (item.Director as Array<{ tag: string }> | undefined)?.map((d) => d.tag) || [],
        writers: (item.Writer as Array<{ tag: string }> | undefined)?.map((w) => w.tag) || [],
        studios: (item.Studio as Array<{ tag: string }> | undefined)?.map((s) => s.tag) || [],
        addedAt: item.addedAt,
        updatedAt: item.updatedAt,
        viewCount: item.viewCount,
        lastViewedAt: item.lastViewedAt,
      },
    });
  }

  // ── Mutative tools (opt-in) ─────────────────────────────────

  async updateMetadata(input: MetadataUpdateInput): Promise<MCPResponse> {
    this.requireMutativeOpsEnabled("update_metadata");
    validatePlexId(input.ratingKey, "ratingKey");

    // Plex field names, keyed to the values requested. `rating` is the user's
    // star rating, which Plex sets through its rate endpoint, not a field edit.
    const params: Record<string, string | number> = {};
    if (input.title !== undefined) params.title = input.title;
    if (input.sortTitle !== undefined) params.titleSort = input.sortTitle;
    if (input.originalTitle !== undefined) params.originalTitle = input.originalTitle;
    if (input.summary !== undefined) params.summary = input.summary;
    if (input.year !== undefined) params.year = input.year;
    if (input.contentRating !== undefined) params.contentRating = input.contentRating;
    if (input.tagline !== undefined) params.tagline = input.tagline;
    if (input.studio !== undefined) params.studio = input.studio;
    // Music: release date, and track/disc numbers (Plex's index/parentIndex).
    musicFieldParams(input, params);
    const ratingRequested = input.rating !== undefined;

    const requestedTags = TAG_INPUTS.filter(([key]) => input[key] !== undefined);
    const hasTagUpdates = requestedTags.length > 0;

    if (Object.keys(params).length === 0 && !hasTagUpdates && !ratingRequested) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        "At least one metadata field must be provided"
      );
    }

    const warnings: string[] = [];
    let anySuccess = false;
    let verifiedFields: string[] | undefined;

    if (Object.keys(params).length > 0) {
      try {
        verifiedFields = await this.editFieldsVerified(input.ratingKey, params, warnings);
        if (verifiedFields.length > 0) anySuccess = true;
      } catch (error) {
        warnings.push(`Basic metadata update failed: ${this.getErrorMessage(error)}`);
      }
    }

    if (ratingRequested) {
      const rating = Number(input.rating);
      if (!Number.isFinite(rating) || rating < 0 || rating > 10) {
        warnings.push("rating must be between 0 and 10; not applied");
      } else {
        try {
          await this.client.rateMedia(input.ratingKey, rating);
          anySuccess = true;
        } catch (error) {
          warnings.push(`Rating update failed: ${this.getErrorMessage(error)}`);
        }
      }
    }

    const tagResults: Array<Record<string, unknown>> = [];
    for (const [key, tag] of requestedTags) {
      const result = await this.replaceTagsSafely(
        input.ratingKey,
        tag,
        this.normalizeTagList(input[key] as unknown[] | undefined)
      );
      if (result.success) anySuccess = true;
      tagResults.push(result);
    }

    return jsonResponse({
      updated: anySuccess,
      ratingKey: input.ratingKey,
      fields: params,
      verifiedFields,
      tagResults: tagResults.length > 0 ? tagResults : undefined,
      warnings: warnings.length > 0 ? warnings : undefined,
    });
  }

  async updateMetadataFromJson(
    ratingKey: string,
    metadata: Record<string, unknown>,
    setPosterFromUrl: boolean = false
  ): Promise<MCPResponse> {
    this.requireMutativeOpsEnabled("update_metadata_from_json");
    validatePlexId(ratingKey, "ratingKey");
    if (!metadata || typeof metadata !== "object") {
      throw new McpError(ErrorCode.InvalidRequest, "metadata object is required");
    }

    const mapped: MetadataUpdateInput = { ratingKey };
    const normalizeNullable = (value: unknown) => (value === null ? undefined : value);

    if ("title" in metadata) mapped.title = normalizeNullable(metadata.title) as string | undefined;
    if ("sortTitle" in metadata) mapped.sortTitle = normalizeNullable(metadata.sortTitle) as string | undefined;
    if ("originalTitle" in metadata) {
      mapped.originalTitle = normalizeNullable(metadata.originalTitle) as string | undefined;
    }
    if ("summary" in metadata) mapped.summary = normalizeNullable(metadata.summary) as string | undefined;
    if ("year" in metadata && metadata.year !== null && metadata.year !== undefined) mapped.year = metadata.year as number;
    if ("contentRating" in metadata) {
      mapped.contentRating = normalizeNullable(metadata.contentRating) as string | undefined;
    }
    if ("rating" in metadata && metadata.rating !== null && metadata.rating !== undefined) mapped.rating = metadata.rating as number;
    if ("tagline" in metadata) mapped.tagline = normalizeNullable(metadata.tagline) as string | undefined;
    if ("studio" in metadata) mapped.studio = normalizeNullable(metadata.studio) as string | undefined;
    for (const key of ["originallyAvailableAt", "trackNumber", "discNumber"] as const) {
      const value = normalizeNullable(metadata[key]);
      if (value !== undefined) (mapped as Record<string, unknown>)[key] = value;
    }
    for (const [key] of TAG_INPUTS) {
      if (key in metadata) mapped[key] = metadata[key] as unknown[];
    }

    const warnings: string[] = [];
    let metadataUpdated = false;
    let posterUpdated = false;

    try {
      const response = await this.updateMetadata(mapped);
      const parsed = this.parseResponseText(response);
      metadataUpdated = Boolean(parsed && (parsed.updated as boolean));
    } catch (error) {
      warnings.push(`Update failed: ${this.getErrorMessage(error)}`);
    }

    if (setPosterFromUrl) {
      const posterUrl =
        ((metadata.images as { posters?: Array<{ url?: string }> } | undefined)?.posters?.[0]?.url as string | undefined);
      if (!posterUrl) {
        warnings.push("Poster update skipped: metadata.images.posters[0].url not found");
      } else {
        const posterResult = await this.setPosterFromUrl(ratingKey, posterUrl);
        posterUpdated = posterResult.success;
        if (posterResult.error) {
          warnings.push(posterResult.error);
        }
      }
    }

    const supportedKeys = new Set([
      "title",
      "sortTitle",
      "originalTitle",
      "summary",
      "year",
      "contentRating",
      "rating",
      "tagline",
      "studio",
      "genres",
      "collections",
      "roles",
      "directors",
      "images",
    ]);
    const ignoredFields = Object.keys(metadata).filter((key) => !supportedKeys.has(key));

    return jsonResponse({
      updated: metadataUpdated || posterUpdated,
      ratingKey,
      appliedFields: Object.fromEntries(
        Object.entries(mapped).filter(([key]) => key !== "ratingKey")
      ),
      ignoredFields,
      warnings: warnings.length > 0 ? warnings : undefined,
    });
  }

  /**
   * Apply one set of edits to many items at once: a list of rating keys, or every
   * child of a parent (an album's tracks, an artist's albums, a season's episodes).
   * Uses the same multi-item edit Plex Web sends when you select several items and
   * click Edit, so it is one request per 100 items. Edited fields are locked so a
   * metadata refresh doesn't undo them. Each item is re-read afterwards and any
   * edit Plex didn't save is reported, since Plex answers 200 even when it ignores one.
   */
  async bulkUpdateMetadata(input: BulkMetadataInput): Promise<MCPResponse> {
    this.requireMutativeOpsEnabled("bulk_update_metadata");

    const keysGiven = Array.isArray(input.ratingKeys) && input.ratingKeys.length > 0;
    const parentGiven = typeof input.parentRatingKey === "string" && input.parentRatingKey !== "";
    if (keysGiven === parentGiven) {
      throw new McpError(ErrorCode.InvalidRequest, "Pass either ratingKeys or parentRatingKey (not both)");
    }

    const fields = this.parseBulkFields(input.fields);
    const adds = this.parseBulkTags(input.addTags, "addTags");
    const removes = this.parseBulkTags(input.removeTags, "removeTags");
    if (Object.keys(fields).length === 0 && adds.length === 0 && removes.length === 0) {
      throw new McpError(ErrorCode.InvalidRequest, "Nothing to change: pass fields, addTags or removeTags");
    }
    for (const add of adds) {
      const removal = removes.find((r) => r.tag === add.tag);
      const both = removal ? add.values.filter((v) => removal.values.includes(v)) : [];
      if (both.length > 0) {
        throw new McpError(ErrorCode.InvalidRequest, `Can't both add and remove ${add.tag} "${both[0]}"`);
      }
    }

    let ratingKeys: string[];
    if (parentGiven) {
      ratingKeys = await this.childRatingKeys(input.parentRatingKey as string, MAX_BULK_EDIT_ITEMS);
      if (ratingKeys.length === 0) {
        throw new McpError(ErrorCode.InvalidRequest, `Item ${input.parentRatingKey} has no children to edit`);
      }
    } else {
      ratingKeys = [...new Set((input.ratingKeys as unknown[]).map((key) => String(key).trim()))];
      ratingKeys.forEach((key) => validatePlexId(key, "ratingKeys"));
    }
    if (ratingKeys.length > MAX_BULK_EDIT_ITEMS) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `A bulk edit can touch at most ${MAX_BULK_EDIT_ITEMS} items; this one would touch more`
      );
    }

    const before = await this.fetchItemsByKey(ratingKeys);
    const { type, libraryKey } = this.requireOneTypeAndLibrary(ratingKeys, before);
    const typeId = this.getTaggableTypeId(type);

    const touchedFields = Object.keys(fields);
    const describe = (item: Record<string, unknown>) => ({
      ratingKey: String(item.ratingKey),
      title: item.title,
      current: Object.fromEntries(touchedFields.map((field) => [field, item[field]])),
      currentTags:
        adds.length + removes.length > 0
          ? Object.fromEntries(
              [...new Set([...adds, ...removes].map((edit) => edit.tag))].map((tag) => [
                tag,
                this.getCurrentTags(item, tag),
              ])
            )
          : undefined,
    });
    const summary = {
      itemCount: ratingKeys.length,
      type,
      librarySectionID: libraryKey,
      fields: touchedFields.length > 0 ? fields : undefined,
      addTags: adds.length > 0 ? Object.fromEntries(adds.map((a) => [a.tag, a.values])) : undefined,
      removeTags: removes.length > 0 ? Object.fromEntries(removes.map((r) => [r.tag, r.values])) : undefined,
    };

    if (input.dryRun) {
      return jsonResponse({
        dryRun: true,
        ...summary,
        items: ratingKeys.map((key) => describe(before.get(key) as Record<string, unknown>)),
        message: "Nothing was changed. Run again without dryRun to apply these edits.",
      });
    }

    const warnings: string[] = [];
    for (const chunk of chunkArray(ratingKeys, BULK_REQUEST_CHUNK)) {
      const base = { type: typeId, id: chunk.join(",") };
      // Fields and additions first, removals second, so a failed removal never loses data.
      const firstPass: Record<string, string | number> = { ...base };
      for (const [field, value] of Object.entries(fields)) {
        firstPass[`${field}.value`] = value;
        firstPass[`${field}.locked`] = 1;
      }
      for (const add of adds) Object.assign(firstPass, this.buildTagParams(add.tag, add.values, true, false));
      if (Object.keys(firstPass).length > 2) {
        try {
          await this.client.makeRequest(`/library/sections/${libraryKey}/all`, firstPass, "PUT");
        } catch (error) {
          warnings.push(`Edit failed for items ${chunk[0]}..${chunk[chunk.length - 1]}: ${this.getErrorMessage(error)}`);
          continue;
        }
      }
      for (const removal of removes) {
        try {
          await this.client.makeRequest(
            `/library/sections/${libraryKey}/all`,
            { ...base, ...this.buildTagParams(removal.tag, removal.values, true, true) },
            "PUT"
          );
        } catch (error) {
          warnings.push(`Removing ${removal.tag} tags failed for items ${chunk[0]}..${chunk[chunk.length - 1]}: ${this.getErrorMessage(error)}`);
        }
      }
    }

    const after = await this.fetchItemsByKey(ratingKeys);
    const failed: Array<{ ratingKey: string; title: unknown; problems: string[] }> = [];
    for (const key of ratingKeys) {
      const item = after.get(key);
      if (!item) {
        failed.push({ ratingKey: key, title: before.get(key)?.title, problems: ["no longer found after the edit"] });
        continue;
      }
      const problems: string[] = [];
      for (const [field, value] of Object.entries(fields)) {
        const now = String(item[field] ?? "").trim();
        if (now !== String(value).trim()) problems.push(`${field} still reads "${now}"`);
      }
      const tagsNow = new Map<EditableTagType, string[]>();
      const tagsOf = (tag: EditableTagType) => {
        if (!tagsNow.has(tag)) tagsNow.set(tag, this.getCurrentTags(item, tag));
        return tagsNow.get(tag) as string[];
      };
      for (const add of adds) {
        const missing = add.values.filter((v) => !tagsOf(add.tag).includes(v));
        if (missing.length > 0) problems.push(`${add.tag} missing: ${missing.join(", ")}`);
      }
      for (const removal of removes) {
        const left = removal.values.filter((v) => tagsOf(removal.tag).includes(v));
        if (left.length > 0) problems.push(`${removal.tag} still has: ${left.join(", ")}`);
      }
      if (problems.length > 0) failed.push({ ratingKey: key, title: item.title, problems });
    }

    return jsonResponse({
      updated: ratingKeys.length - failed.length,
      ...summary,
      failed: failed.length > 0 ? failed : undefined,
      warnings: warnings.length > 0 ? warnings : undefined,
    });
  }

  /**
   * Merge duplicate items into one, the way Plex Web's Merge does: the target keeps
   * its metadata and gains the sources' media files, and the sources disappear.
   * Works for movies, shows, artists and albums in the same library. Previews unless
   * confirm is true. Plex Web's Split on the merged item undoes it.
   */
  async mergeItems(targetRatingKey: string, sourceRatingKeys: string[], confirm: boolean = false): Promise<MCPResponse> {
    this.requireMutativeOpsEnabled("merge_items");
    validatePlexId(targetRatingKey, "targetRatingKey");
    if (!Array.isArray(sourceRatingKeys) || sourceRatingKeys.length === 0) {
      throw new McpError(ErrorCode.InvalidRequest, "sourceRatingKeys must list at least one item to merge in");
    }
    const sources = [...new Set(sourceRatingKeys.map((key) => String(key).trim()))];
    sources.forEach((key) => validatePlexId(key, "sourceRatingKeys"));
    if (sources.includes(targetRatingKey)) {
      throw new McpError(ErrorCode.InvalidRequest, "The target can't also be one of the sources");
    }
    if (sources.length > MAX_MERGE_SOURCES) {
      throw new McpError(ErrorCode.InvalidRequest, `At most ${MAX_MERGE_SOURCES} items can be merged in one call`);
    }

    const allKeys = [targetRatingKey, ...sources];
    const items = await this.fetchItemsByKey(allKeys);
    const { type } = this.requireOneTypeAndLibrary(allKeys, items);
    if (!["movie", "show", "artist", "album"].includes(type)) {
      throw new McpError(ErrorCode.InvalidRequest, `Plex can merge movies, shows, artists and albums, not ${type}s`);
    }

    const describe = (key: string) => {
      const item = items.get(key) as Record<string, unknown>;
      return {
        ratingKey: key,
        title: item.title,
        parentTitle: item.parentTitle,
        year: item.year,
        childCount: item.leafCount ?? item.childCount,
      };
    };

    if (!confirm) {
      return jsonResponse({
        preview: true,
        confirmationRequired: true,
        type,
        target: describe(targetRatingKey),
        sources: sources.map(describe),
        message:
          "Set confirm=true to merge. The target keeps its metadata and gains the sources' files; " +
          "the sources stop existing as separate items. Split in Plex Web undoes a merge.",
      });
    }

    await this.client.makeRequest(`/library/metadata/${targetRatingKey}/merge`, { ids: sources.join(",") }, "PUT");

    const remaining = await this.fetchItemsByKey(sources);
    const stillListed = sources.filter((key) => remaining.has(key));
    return jsonResponse({
      merged: stillListed.length === 0,
      type,
      target: describe(targetRatingKey),
      mergedSources: sources.filter((key) => !remaining.has(key)),
      warnings:
        stillListed.length > 0
          ? [`Plex still lists ${stillListed.join(", ")} as separate items; check them in Plex Web`]
          : undefined,
    });
  }

  /**
   * Start a library scan, like "Scan Library Files" in Plex Web: Plex looks for new,
   * changed and missing files. `path` limits the scan to one folder inside the library.
   * `force` is "Refresh All Metadata" instead, which re-fetches metadata for every item
   * (locked fields are kept). Plex runs either in the background and returns at once.
   */
  async scanLibrary(libraryId: string, options: { path?: string; force?: boolean } = {}): Promise<MCPResponse> {
    this.requireMutativeOpsEnabled("scan_library");
    const library = await this.getLibrarySection(libraryId);
    const force = options.force === true;
    const scanPath = options.path === undefined ? undefined : this.requireLibraryPath(library, options.path);
    if (force && scanPath !== undefined) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        "force refreshes metadata for the whole library and can't be limited to a path; pass one or the other"
      );
    }

    const params: Record<string, string | number> = {};
    if (scanPath !== undefined) params.path = scanPath;
    if (force) params.force = 1;
    await this.client.makeRequest(`/library/sections/${library.key}/refresh`, params);

    return jsonResponse({
      started: true,
      library: { key: library.key, title: library.title, type: library.type },
      scope: force ? "refresh all metadata" : scanPath !== undefined ? "folder" : "whole library",
      path: scanPath,
      alreadyScanning: library.refreshing === true || library.refreshing === 1 || library.refreshing === "1" || undefined,
      message:
        "Plex scans in the background. get_libraries shows the library's scannedAt time, " +
        "and get_recently_added shows what the scan found.",
    });
  }

  /**
   * Empty a library's trash, like "Empty Trash" in Plex Web: items whose files Plex can
   * no longer find are removed for good, with their watch history and ratings. Plex
   * can't undo this. Previews unless confirm is true.
   */
  async emptyTrash(libraryId: string, confirm: boolean = false): Promise<MCPResponse> {
    this.requireMutativeOpsEnabled("empty_trash");
    const library = await this.getLibrarySection(libraryId);
    const summary = { key: library.key, title: library.title, type: library.type };

    if (!confirm) {
      return jsonResponse({
        preview: true,
        confirmationRequired: true,
        library: summary,
        locations: library.locations,
        message:
          "Set confirm=true to empty this library's trash. Items whose files are missing are removed for good, " +
          "with their watch history and ratings, and Plex can't undo it. If a drive or network share holding " +
          "this library is offline, its items look missing too and would be removed: check the locations " +
          "above are reachable first.",
      });
    }

    await this.client.makeRequest(`/library/sections/${library.key}/emptyTrash`, {}, "PUT");
    return jsonResponse({ emptied: true, library: summary });
  }

  /** One library section by key, with its folders; an unknown key is an invalid request. */
  private async getLibrarySection(
    libraryId: string
  ): Promise<{ key: string; title: unknown; type: unknown; refreshing: unknown; locations: string[] }> {
    validatePlexId(libraryId, "libraryId");
    const data = validatePlexMediaContainer(await this.client.makeRequest("/library/sections"));
    const sections =
      ((data.MediaContainer as Record<string, unknown> | undefined)?.Directory as Record<string, unknown>[]) || [];
    const section = sections.find((s) => String(s.key) === String(libraryId));
    if (!section) {
      throw new McpError(ErrorCode.InvalidRequest, `No library with key ${libraryId}; get_libraries lists them`);
    }
    return {
      key: String(section.key),
      title: section.title,
      type: section.type,
      refreshing: section.refreshing,
      locations: ((section.Location as Array<{ path?: unknown }> | undefined) ?? [])
        .map((loc) => loc.path)
        .filter((p): p is string => typeof p === "string" && p.length > 0),
    };
  }

  /**
   * A scan path must sit inside one of the library's own folders, so a scan can't be
   * pointed at an arbitrary place on the server. Returned without a trailing separator.
   */
  private requireLibraryPath(library: { title: unknown; locations: string[] }, value: unknown): string {
    if (typeof value !== "string" || value.trim() === "") {
      throw new McpError(ErrorCode.InvalidRequest, "path must be a folder path inside the library");
    }
    if (/[\u0000-\u001f]/.test(value)) {
      throw new McpError(ErrorCode.InvalidRequest, "path contains control characters");
    }
    const trimEnd = (p: string) => (p.length > 1 ? p.replace(/[\\/]+$/, "") : p);
    const scanPath = trimEnd(value.trim());
    if (scanPath.split(/[\\/]/).includes("..")) {
      throw new McpError(ErrorCode.InvalidRequest, "path can't contain '..'");
    }
    const inside = library.locations.some((location) => {
      const root = trimEnd(location);
      return scanPath === root || scanPath.startsWith(`${root}/`) || scanPath.startsWith(`${root}\\`);
    });
    if (!inside) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `path must be inside one of ${String(library.title)}'s folders: ${library.locations.join(", ") || "(none listed)"}`
      );
    }
    return scanPath;
  }

  async createPlaylist(
    title: string,
    type: string,
    options: {
      ratingKeys?: string[];
      smart?: boolean;
      librarySectionId?: string;
      libtype?: string;
      smartFilter?: string;
    } = {}
  ): Promise<MCPResponse> {
    this.requireMutativeOpsEnabled("create_playlist");
    if (!title) {
      throw new McpError(ErrorCode.InvalidRequest, "title is required");
    }
    if (!type) {
      throw new McpError(ErrorCode.InvalidRequest, "type is required");
    }

    const { ratingKeys, smart, librarySectionId, libtype, smartFilter } = options;
    const isSmart = smart === true;

    // Reject mixing modes — Plex treats these as distinct creation paths.
    if (isSmart && ratingKeys && ratingKeys.length > 0) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        "smart and ratingKeys are mutually exclusive; cannot specify both when creating a playlist"
      );
    }

    const playlistType = this.getPlaylistType(type);
    const machineIdentifier = await this.getMachineIdentifier();
    const uriRoot = `server://${machineIdentifier}/com.plexapp.plugins.library`;

    let uri: string;
    if (isSmart) {
      // Smart playlist — requires a library section to filter against.
      // Plex does not support creating a smart playlist without a section URI.
      if (!librarySectionId) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          "librarySectionId is required when smart=true; smart playlists filter a library section"
        );
      }
      validatePlexId(librarySectionId, "librarySectionId");

      const resolvedLibtype = libtype ?? this.defaultLibtypeFor(playlistType);
      const libtypeId = SMART_PLAYLIST_LIBTYPE_IDS[resolvedLibtype];
      if (libtypeId === undefined) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          `Unknown libtype "${resolvedLibtype}". Valid values: ${Object.keys(SMART_PLAYLIST_LIBTYPE_IDS).join(", ")}`
        );
      }

      const filterSuffix = smartFilter ? `&${smartFilter.replace(/^&/, "")}` : "";
      uri = `${uriRoot}/library/sections/${librarySectionId}/all?type=${libtypeId}${filterSuffix}`;
    } else {
      // Regular playlist — must be seeded with at least one existing library item.
      // Plex API rejects playlist creation with no uri parameter (issue #48).
      if (!ratingKeys || ratingKeys.length === 0) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          "ratingKeys is required (at least one item) to create a playlist; Plex does not support creating empty playlists via this endpoint"
        );
      }
      // python-plexapi comma-joins all rating keys in a single POST, seeding
      // the playlist fully without follow-up addToPlaylist calls.
      ratingKeys.forEach((k) => validatePlexId(k, "ratingKey"));
      uri = `${uriRoot}/library/metadata/${ratingKeys.join(",")}`;
    }

    const params: Record<string, string | number> = {
      title,
      type: playlistType,
      smart: isSmart ? 1 : 0,
      uri,
    };

    const data = await this.client.makeRequest("/playlists", params, "POST");
    const container = data as { MediaContainer?: { Metadata?: Array<Record<string, unknown>> } };
    const playlist = container.MediaContainer?.Metadata?.[0];

    return jsonResponse({
      created: true,
      smart: isSmart,
      playlist: playlist
        ? {
            ratingKey: playlist.ratingKey,
            title: playlist.title,
            type: playlist.type,
            playlistType: playlist.playlistType,
            smart: playlist.smart,
            leafCount: playlist.leafCount,
          }
        : {
            title,
            type: playlistType,
            leafCount: isSmart ? undefined : ratingKeys?.length,
          },
    });
  }

  /**
   * Add one or more items to a playlist in a single request.
   *
   * Plex's endpoint is PUT /playlists/{id}/items with a library URI whose
   * metadata path takes a comma-joined key list, so any number of items costs
   * one round trip. Plex reports `leafCountAdded` in the response; only when it
   * doesn't do we fall back to re-reading the playlist to confirm.
   */
  async addToPlaylist(playlistId: string, ratingKeys: string | string[]): Promise<MCPResponse> {
    this.requireMutativeOpsEnabled("add_to_playlist");
    validatePlexId(playlistId, "playlistId");

    const keys = (Array.isArray(ratingKeys) ? ratingKeys : [ratingKeys])
      .map((k) => String(k ?? "").trim())
      .filter((k) => k.length > 0);
    if (keys.length === 0) {
      throw new McpError(ErrorCode.InvalidRequest, "Provide ratingKey or a non-empty ratingKeys array");
    }
    keys.forEach((k) => validatePlexId(k, "ratingKey"));

    const machineIdentifier = await this.getMachineIdentifier();
    const uri = `server://${machineIdentifier}/com.plexapp.plugins.library/library/metadata/${keys.join(",")}`;
    const endpoint = `/playlists/${playlistId}/items`;

    let data: Record<string, unknown>;
    try {
      data = await this.client.makeRequest(endpoint, { uri }, "PUT");
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Unable to add ${keys.length} item(s) to playlist ${playlistId}: ${this.getErrorMessage(error)}`
      );
    }

    const container = (data as { MediaContainer?: { leafCountAdded?: number | string } })?.MediaContainer;
    const reported = container?.leafCountAdded !== undefined ? Number(container.leafCountAdded) : NaN;

    let addedCount: number;
    let missing: string[] = [];
    if (Number.isFinite(reported)) {
      addedCount = reported;
    } else {
      const present = await this.playlistRatingKeys(playlistId);
      missing = keys.filter((k) => !present.has(k));
      addedCount = keys.length - missing.length;
    }

    if (addedCount === 0) {
      throw new McpError(
        ErrorCode.InternalError,
        `Plex accepted the request but added none of the ${keys.length} item(s) to playlist ${playlistId}`
      );
    }

    return jsonResponse({
      added: true,
      playlistId,
      requested: keys.length,
      addedCount,
      ratingKeys: keys,
      ...(missing.length > 0 ? { notFoundAfterAdd: missing } : {}),
    });
  }

  /** Rating keys currently in a playlist (one paged read). */
  private async playlistRatingKeys(playlistId: string): Promise<Set<string>> {
    const data = await this.client.makeRequest(`/playlists/${playlistId}/items`, {
      "X-Plex-Container-Start": 0,
      "X-Plex-Container-Size": 5000,
    });
    const items = (data as { MediaContainer?: { Metadata?: Array<Record<string, unknown>> } })
      .MediaContainer?.Metadata || [];
    return new Set(items.map((item) => String(item.ratingKey)));
  }

  async removeFromPlaylist(playlistId: string, playlistItemId: string): Promise<MCPResponse> {
    this.requireMutativeOpsEnabled("remove_from_playlist");
    validatePlexId(playlistId, "playlistId");
    validatePlexId(playlistItemId, "playlistItemId");

    await this.client.makeRequest(`/playlists/${playlistId}/items/${playlistItemId}`, {}, "DELETE");
    return jsonResponse({
      removed: true,
      playlistId,
      playlistItemId,
    });
  }

  async clearPlaylist(playlistId: string, confirm: boolean = false): Promise<MCPResponse> {
    this.requireMutativeOpsEnabled("clear_playlist");
    validatePlexId(playlistId, "playlistId");

    const data = await this.client.makeRequest(`/playlists/${playlistId}/items`);
    const container = data as { MediaContainer?: { Metadata?: Array<Record<string, unknown>> } };
    const items = container.MediaContainer?.Metadata || [];
    const itemCount = items.length;

    if (!confirm) {
      return jsonResponse({
        preview: true,
        playlistId,
        itemCount,
        confirmationRequired: true,
        message: "Set confirm=true to clear this playlist",
      });
    }

    await this.client.makeRequest(`/playlists/${playlistId}/items`, {}, "DELETE");
    return jsonResponse({
      cleared: true,
      playlistId,
      removedCount: itemCount,
    });
  }

  async deletePlaylist(playlistId: string): Promise<MCPResponse> {
    this.requireMutativeOpsEnabled("delete_playlist");
    validatePlexId(playlistId, "playlistId");

    await this.client.makeRequest(`/playlists/${playlistId}`, {}, "DELETE");
    return jsonResponse({
      deleted: true,
      playlistId,
      mediaRetained: true,
      message: "Deleted the playlist only; underlying Plex media was not removed",
    });
  }

  async addToWatchlist(ratingKey: string): Promise<MCPResponse> {
    this.requireMutativeOpsEnabled("add_to_watchlist");
    validatePlexId(ratingKey, "ratingKey");
    const plexGuid = await this.getPlexGuid(ratingKey);

    await this.client.makeDiscoverRequest(
      "/actions/addToWatchlist",
      { ratingKey: this.getGlobalRatingKey(plexGuid) },
      "PUT"
    );
    return jsonResponse({ updated: true, action: "add_to_watchlist", ratingKey, plexGuid });
  }

  async removeFromWatchlist(
    input: string | { ratingKey?: string; plexGuid?: string }
  ): Promise<MCPResponse> {
    this.requireMutativeOpsEnabled("remove_from_watchlist");
    const normalized = typeof input === "string" ? { ratingKey: input } : input;
    if (Boolean(normalized.ratingKey) === Boolean(normalized.plexGuid)) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        "Provide exactly one of ratingKey or plexGuid"
      );
    }
    const plexGuid = normalized.plexGuid
      ? this.validatePlexGuid(normalized.plexGuid)
      : await this.getPlexGuid(validatePlexId(normalized.ratingKey, "ratingKey"));

    await this.client.makeDiscoverRequest(
      "/actions/removeFromWatchlist",
      { ratingKey: this.getGlobalRatingKey(plexGuid) },
      "PUT"
    );
    return jsonResponse({
      updated: true,
      action: "remove_from_watchlist",
      ratingKey: normalized.ratingKey,
      plexGuid,
    });
  }

  async markWatched(ratingKey: string): Promise<MCPResponse> {
    this.requireMutativeOpsEnabled("mark_watched");
    validatePlexId(ratingKey, "ratingKey");
    await this.client.markAsWatched(ratingKey);
    return jsonResponse({ updated: true, watched: true, ratingKey });
  }

  async markUnwatched(ratingKey: string): Promise<MCPResponse> {
    this.requireMutativeOpsEnabled("mark_unwatched");
    validatePlexId(ratingKey, "ratingKey");
    await this.client.markAsUnwatched(ratingKey);
    return jsonResponse({ updated: true, watched: false, ratingKey });
  }

  async rateMedia(ratingKey: string, rating: number): Promise<MCPResponse> {
    this.requireMutativeOpsEnabled("rate_media");
    validatePlexId(ratingKey, "ratingKey");
    if (!Number.isFinite(rating) || rating < 0 || rating > 10) {
      throw new McpError(ErrorCode.InvalidRequest, "rating must be between 0 and 10");
    }
    await this.client.rateMedia(ratingKey, rating);
    return jsonResponse({ updated: true, ratingKey, rating });
  }

  async getRecentlyWatched(limit: number = DEFAULT_LIMITS.recentlyWatched, mediaType: string = "all"): Promise<MCPResponse> {
    // Resolved before the try so an unknown type isn't swallowed by the fallback below.
    const rowType = historyRowType(mediaType);

    // Primary: use watch history endpoint
    try {
      const history = await this.fetchWatchHistory(limit, undefined, rowType);

      return jsonResponse({
        recentlyWatched: history.watchHistory,
        totalCount: history.totalSessions,
        ...(history.scanCapped && { scanCapped: true }),
        note: "Retrieved from watch history data",
      });
    } catch (error) {
      console.error(`get_recently_watched: watch history failed, using library metadata: ${this.getErrorMessage(error)}`);
      // Fallback: library metadata approach
      try {
        return await this.getRecentlyWatchedFromLibraries(limit, mediaType);
      } catch (fallbackError) {
        console.error(`get_recently_watched: library fallback failed: ${this.getErrorMessage(fallbackError)}`);
        return jsonResponse({
          recentlyWatched: [],
          totalCount: 0,
          error: "Recently watched data not available",
          message: "Unable to retrieve recently watched content from this Plex server",
        });
      }
    }
  }

  /**
   * Page through a listing, keeping rows that pass `keep`, until `limit` are kept or the
   * listing ends. For filters Plex can't apply itself. Stops on a short page, on Plex's
   * totalSize, on a page identical to the last (Plex ignored the offset), or after
   * PLEX_FILTERED_SCAN_MAX_PAGES. The last two are reported as scanCapped, since the
   * listing may hold more matches.
   */
  private async collectFiltered(
    endpoint: string,
    params: Record<string, string | number>,
    pageSize: number,
    keep: (row: Record<string, unknown>) => boolean,
    limit: number
  ): Promise<{ rows: Record<string, unknown>[]; scanCapped: boolean }> {
    const kept: Record<string, unknown>[] = [];
    let received = 0;
    let previousKeys: string | undefined;
    let finished = false;

    for (let page = 0; page < PLEX_FILTERED_SCAN_MAX_PAGES; page++) {
      const data = await this.client.makeRequest(endpoint, {
        ...params,
        "X-Plex-Container-Start": received,
        "X-Plex-Container-Size": pageSize,
      });
      const container = (data as { MediaContainer?: { Metadata?: Record<string, unknown>[]; totalSize?: unknown } })
        .MediaContainer;
      const rows = container?.Metadata || [];

      const keys = JSON.stringify(rows.map((row) => row.historyKey ?? row.ratingKey));
      if (keys === previousKeys) {
        break;
      }
      previousKeys = keys;

      kept.push(...rows.filter(keep));
      received += rows.length;

      const totalSize = container?.totalSize;
      if (kept.length >= limit || rows.length < pageSize || (typeof totalSize === "number" && received >= totalSize)) {
        finished = true;
        break;
      }
    }

    return { rows: kept.slice(0, limit), scanCapped: !finished };
  }

  /**
   * Session history from Plex's history endpoint, as data. Throws if the
   * endpoint fails; callers choose their own fallback. Callers that need data
   * use this and not getWatchHistory, whose text may be TOON instead of JSON.
   */
  private async fetchWatchHistory(
    limit: number,
    userId: string | undefined,
    rowType: string | undefined
  ): Promise<{ watchHistory: Record<string, unknown>[]; totalSessions: number; scanCapped?: boolean }> {
    const endpoint = "/status/sessions/history/all";
    const params: Record<string, string | number> = { sort: "viewedAt:desc" };
    if (userId) {
      params.accountID = userId;
    }

    let sessions: Record<string, unknown>[];
    let scanCapped = false;
    if (rowType === undefined) {
      // Plex ignores X-Plex-Container-Size here unless X-Plex-Container-Start is sent too.
      const data = await this.client.makeRequest(endpoint, {
        ...params,
        "X-Plex-Container-Start": 0,
        "X-Plex-Container-Size": limit,
      });
      const container = data as { MediaContainer?: { Metadata?: Record<string, unknown>[] } };
      sessions = container.MediaContainer?.Metadata || [];
    } else {
      // The type filter is ours, not Plex's, so page until there are enough matches.
      const pageLimit = Math.max(1, limit);
      ({ rows: sessions, scanCapped } = await this.collectFiltered(
        endpoint,
        params,
        Math.max(pageLimit, 100),
        (session) => session.type === rowType,
        pageLimit
      ));
    }

    return {
      ...(scanCapped && { scanCapped: true }),
      watchHistory: sessions.map((session) => ({
        sessionKey: session.sessionKey,
        ratingKey: session.ratingKey,
        title: session.title,
        type: session.type,
        ...showContext(session),
        year: session.year,
        viewedAt: session.viewedAt,
        duration: session.duration,
        viewOffset: session.viewOffset,
        user: (session.User as { title?: string } | undefined)?.title,
        player: (session.Player as { title?: string } | undefined)?.title,
        platform: (session.Player as { platform?: string } | undefined)?.platform,
        progress:
          (session.viewOffset as number) && (session.duration as number)
            ? Math.round(((session.viewOffset as number) / (session.duration as number)) * 100)
            : 0,
        completed: isContentCompleted(
          session.duration as number | undefined,
          session.viewOffset as number | undefined,
          1 // viewCount always > 0 for watched items
        ),
      })),
      totalSessions: sessions.length,
    };
  }

  async getWatchHistory(
    limit: number = DEFAULT_LIMITS.watchHistory,
    userId?: string,
    mediaType: string = "all"
  ): Promise<MCPResponse> {
    // Resolved before the try so an unknown type isn't swallowed by the fallback below.
    const rowType = historyRowType(mediaType);

    try {
      // Primary: session history endpoint
      return jsonResponse(await this.fetchWatchHistory(limit, userId, rowType));
    } catch (error) {
      console.error(`get_watch_history: watch history failed, using library metadata: ${this.getErrorMessage(error)}`);
      // Fallback: build pseudo-history from library metadata
      try {
        return await this.getWatchHistoryFromLibraries(limit, userId, mediaType);
      } catch (fallbackError) {
        console.error(`get_watch_history: library fallback failed: ${this.getErrorMessage(fallbackError)}`);
        return jsonResponse({
          error: "Watch history not available",
          message: "Unable to retrieve watch history from this Plex server",
          suggestion: "This feature may require Plex Pass or detailed logging to be enabled",
          watchHistory: [],
        });
      }
    }
  }

  // ── Extended / analytics tools ──────────────────────────────

  async getFullyWatched(
    libraryKey?: string,
    mediaType: string = "all",
    limit: number = DEFAULT_LIMITS.fullyWatched
  ): Promise<MCPResponse> {
    // Resolved before the try so an unknown type isn't swallowed by the fallback below.
    const typeId = mediaType !== "all" ? this.client.getPlexTypeId(mediaType) : undefined;

    try {
      let endpoint = "/library/all";
      // Plex omits viewOffset from finished items, so completion can't be judged from the
      // returned items. Ask Plex instead, with the query behind its own "Recently Watched"
      // hub: watched at least once (unwatched=0) and not in progress (viewOffset=0).
      const params: Record<string, string | number> = {
        sort: "lastViewedAt:desc",
        unwatched: 0,
        viewOffset: 0,
      };

      if (libraryKey) {
        validatePlexId(libraryKey, "libraryKey");
        endpoint = `/library/sections/${libraryKey}/all`;
      }
      if (typeId !== undefined) {
        params.type = typeId;
      }

      // isFullyWatched can still drop partly watched shows, so page in twice the limit
      // until enough survive.
      const pageLimit = Math.max(1, limit);
      const { rows: items, scanCapped } = await this.collectFiltered(endpoint, params, pageLimit * 2, isFullyWatched, pageLimit);

      return jsonResponse({
        ...(scanCapped && { scanCapped: true }),
        fullyWatched: items.map((item) => ({
          ratingKey: item.ratingKey,
          title: item.title,
          type: item.type,
          ...showContext(item),
          year: item.year,
          viewCount: item.viewCount,
          lastViewedAt: item.lastViewedAt,
          duration: item.duration,
          viewOffset: item.viewOffset,
          completionPercent:
            (item.duration as number) && (item.viewOffset as number)
              ? Math.round(((item.viewOffset as number) / (item.duration as number)) * 100)
              : 100,
          rating: item.rating,
          summary: truncate((item.summary as string) || "", SUMMARY_PREVIEW_LENGTH),
        })),
        totalCount: items.length,
        libraryKey: libraryKey || "all",
        mediaType,
      });
    } catch {
      // Fallback: iterate libraries
      try {
        return await this.getFullyWatchedFromLibraries(libraryKey, mediaType, limit);
      } catch {
        return jsonResponse({
          error: "Fully watched data not available",
          message: "Unable to retrieve watched content from this Plex server",
          suggestion: "Check server permissions and ensure libraries are accessible",
          fullyWatched: [],
        });
      }
    }
  }

  async getWatchStats(timeRange: number = 30, statType: string = "plays"): Promise<MCPResponse> {
    const fromDate = Math.floor((Date.now() - timeRange * 24 * 60 * 60 * 1000) / 1000);

    try {
      // Plex filters by time and the pages are walked until the range is exhausted. An
      // unsorted history comes back oldest first, so a fixed cap would drop the range.
      const sessions = await this.client.fetchAllPages("/status/sessions/history/all", { "viewedAt>": fromDate });

      const filteredSessions = sessions.filter(
        (session) => (session.viewedAt as number) && (session.viewedAt as number) >= fromDate
      );

      let stats: Record<string, unknown>;
      switch (statType) {
        case "plays":
          stats = this.calculatePlayStats(filteredSessions);
          break;
        case "duration":
          stats = this.calculateDurationStats(filteredSessions);
          break;
        case "users":
          stats = this.calculateUserStats(filteredSessions);
          break;
        case "libraries":
          stats = this.calculateLibraryStats(filteredSessions);
          break;
        case "platforms":
          stats = this.calculatePlatformStats(filteredSessions);
          break;
        default:
          stats = this.calculatePlayStats(filteredSessions);
      }

      return jsonResponse({
        timeRange: `${timeRange} days`,
        statType,
        totalSessions: filteredSessions.length,
        stats,
      });
    } catch {
      return await this.getBasicStats(timeRange, statType);
    }
  }

  async getUserStats(timeRange: number = 30): Promise<MCPResponse> {
    try {
      const data = await this.client.makeRequest("/accounts");
      const container = data as { MediaContainer?: { Account?: Record<string, unknown>[] } };
      const users = container.MediaContainer?.Account || [];

      return jsonResponse({
        users: users.map((user) => ({
          id: user.id,
          name: user.name,
          email: user.email,
        })),
        totalUsers: users.length,
      });
    } catch {
      return jsonResponse({
        message: "User statistics not available",
        error: "Unable to access user data",
      });
    }
  }

  async getLibraryStats(libraryKey?: string): Promise<MCPResponse> {
    if (libraryKey) {
      validatePlexId(libraryKey, "libraryKey");
      const data = await this.client.makeRequest(`/library/sections/${libraryKey}`);
      const container = data as { MediaContainer?: { Directory?: Record<string, unknown>[] } };
      const library = container.MediaContainer?.Directory?.[0];

      if (!library) {
        throw new McpError(ErrorCode.InvalidRequest, `Library not found: ${libraryKey}`);
      }

      return jsonResponse({
        library: {
          key: library.key,
          title: library.title,
          type: library.type,
          count: library.count,
          scannedAt: library.scannedAt,
          updatedAt: library.updatedAt,
          language: library.language,
          locations: (library.Location as Array<{ path: string }> | undefined)?.map((loc) => loc.path) || [],
        },
      });
    } else {
      const data = await this.client.makeRequest("/library/sections");
      const container = data as { MediaContainer?: { Directory?: Record<string, unknown>[] } };
      const libraries = container.MediaContainer?.Directory || [];

      return jsonResponse({
        libraries: libraries.map((lib) => ({
          key: lib.key,
          title: lib.title,
          type: lib.type,
          count: lib.count,
          scannedAt: lib.scannedAt,
        })),
        totalLibraries: libraries.length,
      });
    }
  }

  async getPopularContent(
    timeRange: number = 30,
    metric: string = "plays",
    mediaType: string = "all",
    limit: number = DEFAULT_LIMITS.popularContent
  ): Promise<MCPResponse> {
    try {
      const librariesData = await this.client.makeRequest("/library/sections");
      const libContainer = librariesData as { MediaContainer?: { Directory?: Record<string, unknown>[] } };
      const libraries = libContainer.MediaContainer?.Directory || [];

      let allContent: Record<string, unknown>[] = [];
      const typeId = mediaType !== "all" ? this.client.getPlexTypeId(mediaType) : undefined;
      // The merge keeps the top `limit`, which one library may hold entirely, so each library
      // is asked for at least `limit` rows. One request per library; the doubling is headroom
      // for in-progress rows that the filter below drops (a heuristic).
      const pageSize = Math.max(recencyPageSize(limit), PLEX_CONTAINER_SIZE);

      for (const library of libraries) {
        try {
          const params: Record<string, string | number> = {
            ...firstPage(pageSize),
            sort: metric === "plays" ? "viewCount:desc" : "lastViewedAt:desc",
          };
          if (typeId !== undefined) {
            params.type = typeId;
          }

          const contentData = await this.client.makeRequest(`/library/sections/${library.key}/all`, params);
          const container = contentData as { MediaContainer?: { Metadata?: Record<string, unknown>[] } };
          allContent.push(...(container.MediaContainer?.Metadata || []));
        } catch {
          continue;
        }
      }

      let filteredContent = allContent.filter((item) => (item.viewCount as number) > 0);

      if (metric === "plays") {
        filteredContent.sort((a, b) => ((b.viewCount as number) || 0) - ((a.viewCount as number) || 0));
      } else {
        filteredContent.sort((a, b) => ((b.lastViewedAt as number) || 0) - ((a.lastViewedAt as number) || 0));
      }

      filteredContent = filteredContent.slice(0, limit);

      return jsonResponse({
        metric,
        mediaType,
        timeRange: `${timeRange} days`,
        popularContent: filteredContent.map((item) => ({
          ratingKey: item.ratingKey,
          title: item.title,
          type: item.type,
          ...showContext(item),
          year: item.year,
          viewCount: item.viewCount,
          lastViewedAt: item.lastViewedAt,
          rating: item.rating,
          duration: item.duration,
        })),
      });
    } catch (error) {
      throw new McpError(ErrorCode.InternalError, `Error getting popular content: ${error}`);
    }
  }

  // ── Private helpers ─────────────────────────────────────────

  /**
   * Real path of the deepest part of `dir` that already exists. An entry that
   * exists but can't be resolved (a dangling symlink) is refused rather than
   * skipped: mkdir would otherwise create its target.
   */
  private async realpathOfDeepestExisting(dir: string): Promise<string> {
    let probe = dir;
    for (;;) {
      try {
        await lstat(probe);
      } catch (error) {
        const parent = path.dirname(probe);
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || parent === probe) throw error;
        probe = parent;
        continue;
      }
      try {
        return await realpath(probe);
      } catch {
        throw new McpError(ErrorCode.InvalidRequest, "outputPath must resolve inside the exports directory");
      }
    }
  }

  private async writeToStream(stream: ReturnType<typeof createWriteStream>, chunk: string): Promise<void> {
    if (stream.write(chunk)) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const onDrain = () => {
        stream.off("error", onError);
        resolve();
      };
      const onError = (error: unknown) => {
        stream.off("drain", onDrain);
        reject(error);
      };

      stream.once("drain", onDrain);
      stream.once("error", onError);
    });
  }

  private async finishStream(stream: ReturnType<typeof createWriteStream>): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      stream.once("finish", () => resolve());
      stream.once("error", (error) => reject(error));
      stream.end();
    });
  }

  private requireMutativeOpsEnabled(toolName: string): void {
    if (isMutativeOpsEnabled()) {
      return;
    }
    throw new McpError(
      ErrorCode.InvalidRequest,
      `${toolName} is disabled. Set ${PLEX_MUTATIVE_OPS_ENV_VAR}=true to enable mutative Plex tools.`
    );
  }

  private getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private parseResponseText(response: MCPResponse): Record<string, unknown> | undefined {
    const text = response.content?.[0]?.text;
    if (!text) return undefined;
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }

  private normalizeTagList(input: unknown[] | undefined): string[] {
    if (!input || !Array.isArray(input)) return [];
    return input
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object" && typeof (item as { tag?: unknown }).tag === "string") {
          return (item as { tag: string }).tag;
        }
        return "";
      })
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0);
  }

  /**
   * Edit plain fields the way Plex's own clients do — PUT /library/sections/{id}/all
   * with the item's type id and `field.value` / `field.locked=1` — then re-read the
   * item and report which fields actually changed. Plex answers a wrong or missing
   * type with 200 and writes nothing, so the re-read is what tells success apart.
   * Locking keeps a later refresh or rescan from overwriting the edit.
   */
  private async editFieldsVerified(
    ratingKey: string,
    fields: Record<string, string | number>,
    warnings: string[]
  ): Promise<string[]> {
    const { item, libraryKey } = await this.getMediaContext(ratingKey);
    validatePlexId(libraryKey, "libraryKey");

    const body: Record<string, string | number> = {
      id: ratingKey,
      type: this.getTaggableTypeId(item.type as string),
    };
    for (const [field, value] of Object.entries(fields)) {
      body[`${field}.value`] = value;
      body[`${field}.locked`] = 1;
    }
    await this.client.makeRequest(`/library/sections/${libraryKey}/all`, body, "PUT");

    const { item: after } = await this.getMediaContext(ratingKey);
    const applied: string[] = [];
    for (const [field, value] of Object.entries(fields)) {
      const now = String(after[field] ?? "").trim();
      if (now === String(value).trim()) {
        applied.push(field);
      } else {
        warnings.push(`Plex did not save ${field}: it still reads "${now}"`);
      }
    }
    return applied;
  }

  private async replaceTagsSafely(
    ratingKey: string,
    tag: EditableTagType,
    desiredTags: string[]
  ): Promise<Record<string, unknown>> {
    const { item, libraryKey } = await this.getMediaContext(ratingKey);
    const currentTags = this.getCurrentTags(item, tag);

    const desiredSet = new Set(desiredTags);
    const currentSet = new Set(currentTags);
    const toAdd = desiredTags.filter((value) => !currentSet.has(value));
    const toRemove = currentTags.filter((value) => !desiredSet.has(value));
    const warnings: string[] = [];
    let success = false;
    // Lock the field only if tags remain. Decided once from the final set so the removal
    // in a replace doesn't drop the lock the add just set, and an emptied field isn't pinned.
    const locked = desiredTags.length > 0;

    // Add first, remove second to avoid data loss on partial failures.
    let addFailed = false;
    if (toAdd.length > 0) {
      try {
        await this.editTagsForItem(ratingKey, libraryKey, item.type as string, tag, toAdd, false, locked);
        success = true;
      } catch (error) {
        addFailed = true;
        warnings.push(`Failed adding ${tag} tags: ${this.getErrorMessage(error)}`);
      }
    }

    // If the add failed, removing now could leave the field empty (and locked), losing the old tags.
    let removed = toRemove;
    if (toRemove.length > 0 && addFailed) {
      removed = [];
      warnings.push(`Skipped removing ${tag} tags because adding the new ones failed`);
    } else if (toRemove.length > 0) {
      try {
        await this.editTagsForItem(ratingKey, libraryKey, item.type as string, tag, toRemove, true, locked);
        success = true;
      } catch (error) {
        warnings.push(`Failed removing ${tag} tags: ${this.getErrorMessage(error)}`);
      }
    }

    // An empty field can still be locked (e.g. by an edit made before #205 was fixed). With nothing
    // to add or remove, clear the lock on its own so a refresh can fill the field again. This only
    // fires when Plex reports the lock under the same name the tool edits.
    let unlocked = false;
    if (desiredTags.length === 0 && toAdd.length === 0 && toRemove.length === 0 && this.isFieldLocked(item, tag)) {
      try {
        await this.editTagsForItem(ratingKey, libraryKey, item.type as string, tag, [], false, false);
        success = true;
        unlocked = true;
      } catch (error) {
        warnings.push(`Failed unlocking ${tag}: ${this.getErrorMessage(error)}`);
      }
    }

    return {
      tag,
      success,
      added: toAdd,
      removed,
      unlocked: unlocked || undefined,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  private isFieldLocked(item: Record<string, unknown>, field: string): boolean {
    const fields = Array.isArray(item.Field) ? (item.Field as Array<{ name?: string; locked?: boolean }>) : [];
    // Same test as getEditableFields' lockedFields, so the two never disagree about a field.
    return fields.some((entry) => entry.name === field && Boolean(entry.locked));
  }

  private getCurrentTags(item: Record<string, unknown>, tag: EditableTagType): string[] {
    const list = item[TAG_CONTAINER_KEYS[tag]] as Array<{ tag: string }> | undefined;
    return (Array.isArray(list) ? list : []).map((entry) => entry.tag).filter(Boolean);
  }

  private async editTagsForItem(
    ratingKey: string,
    libraryKey: string,
    itemType: string,
    tag: EditableTagType,
    items: string[],
    remove: boolean,
    locked: boolean
  ): Promise<void> {
    validatePlexId(libraryKey, "libraryKey");
    const params: Record<string, string | number> = {
      id: ratingKey,
      type: this.getTaggableTypeId(itemType),
      ...this.buildTagParams(tag, items, locked, remove),
    };

    await this.client.makeRequest(`/library/sections/${libraryKey}/all`, params, "PUT");
  }

  private getTaggableTypeId(itemType: string): number {
    if (!Object.hasOwn(PLEX_TAGGABLE_TYPE_IDS, itemType)) {
      throw new Error(
        `Unknown media type "${itemType}". Expected one of: ${Object.keys(PLEX_TAGGABLE_TYPE_IDS).join(", ")}`
      );
    }
    return PLEX_TAGGABLE_TYPE_IDS[itemType];
  }

  private buildTagParams(tag: string, items: string[], locked: boolean, remove: boolean): Record<string, string | number> {
    const data: Record<string, string | number> = {
      [`${tag}.locked`]: locked ? 1 : 0,
    };

    if (remove) {
      data[`${tag}[].tag.tag-`] = items.join(",");
      return data;
    }

    items.forEach((item, index) => {
      data[`${tag}[${index}].tag.tag`] = item;
    });
    return data;
  }

  private async getMediaContext(ratingKey: string): Promise<{ item: Record<string, unknown>; libraryKey: string }> {
    validatePlexId(ratingKey, "ratingKey");
    const data = await this.client.makeRequest(`/library/metadata/${ratingKey}`);
    const container = data as { MediaContainer?: { Metadata?: Array<Record<string, unknown>> } };
    const item = container.MediaContainer?.Metadata?.[0];
    if (!item) {
      throw new McpError(ErrorCode.InvalidRequest, `Media item not found: ${ratingKey}`);
    }

    const libraryKey = this.libraryKeyOf(item);
    if (!libraryKey) {
      throw new McpError(
        ErrorCode.InternalError,
        "Unable to determine library section key for the media item"
      );
    }

    return { item, libraryKey };
  }

  private libraryKeyOf(item: Record<string, unknown>): string | undefined {
    const key =
      (item.librarySectionID as string | number | undefined) ||
      (item.librarySectionKey as string | number | undefined) ||
      ((item.librarySection as { key?: string | number } | undefined)?.key as string | number | undefined);
    return key ? String(key) : undefined;
  }

  /** Fetch many items in one request per 100 (GET /library/metadata/1,2,3), keyed by rating key. */
  private async fetchItemsByKey(ratingKeys: string[]): Promise<Map<string, Record<string, unknown>>> {
    const found = new Map<string, Record<string, unknown>>();
    for (const chunk of chunkArray(ratingKeys, BULK_REQUEST_CHUNK)) {
      chunk.forEach((key) => validatePlexId(key, "ratingKey"));
      let data: Record<string, unknown>;
      try {
        data = await this.client.makeRequest(`/library/metadata/${chunk.join(",")}`);
      } catch (error) {
        // Plex answers 404 when none of the ids exist; that just means nothing was found.
        if ((error as { response?: { status?: number } }).response?.status === 404) continue;
        throw error;
      }
      const items = (data as { MediaContainer?: { Metadata?: Array<Record<string, unknown>> } }).MediaContainer?.Metadata ?? [];
      for (const item of items) found.set(String(item.ratingKey), item);
    }
    return found;
  }

  /** Every item must exist and share one type and one library: Plex's multi-item endpoints take one of each. */
  private requireOneTypeAndLibrary(
    ratingKeys: string[],
    items: Map<string, Record<string, unknown>>
  ): { type: string; libraryKey: string } {
    const missing = ratingKeys.filter((key) => !items.has(key));
    if (missing.length > 0) {
      throw new McpError(ErrorCode.InvalidRequest, `Media items not found: ${missing.join(", ")}`);
    }
    const types = new Set(ratingKeys.map((key) => String(items.get(key)?.type)));
    if (types.size > 1) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `All items must be the same type; these are a mix of ${[...types].join(", ")}`
      );
    }
    const libraries = new Set(ratingKeys.map((key) => this.libraryKeyOf(items.get(key) as Record<string, unknown>)));
    if (libraries.size > 1) {
      throw new McpError(ErrorCode.InvalidRequest, "All items must be in the same library");
    }
    const [libraryKey] = libraries;
    if (!libraryKey) {
      throw new McpError(ErrorCode.InternalError, "Unable to determine the library section for these items");
    }
    validatePlexId(libraryKey, "libraryKey");
    return { type: [...types][0], libraryKey };
  }

  /** Rating keys of an item's children, paged, stopping once there are more than `max`. */
  private async childRatingKeys(parentRatingKey: string, max: number): Promise<string[]> {
    validatePlexId(parentRatingKey, "parentRatingKey");
    const keys: string[] = [];
    const pageSize = 200;
    for (let start = 0; keys.length <= max; start += pageSize) {
      const data = await this.client.makeRequest(`/library/metadata/${parentRatingKey}/children`, {
        "X-Plex-Container-Start": start,
        "X-Plex-Container-Size": pageSize,
      });
      const mc = (data as { MediaContainer?: Record<string, unknown> }).MediaContainer ?? {};
      const page = (mc.Metadata as Array<Record<string, unknown>> | undefined) ?? [];
      for (const item of page) {
        if (item.ratingKey !== undefined) keys.push(String(item.ratingKey));
      }
      const total = (mc.totalSize as number | undefined) ?? (mc.size as number | undefined);
      if (page.length < pageSize || (total !== undefined && start + page.length >= total)) break;
    }
    return keys;
  }

  private parseBulkFields(raw: unknown): Record<string, string | number> {
    const fields: Record<string, string | number> = {};
    if (raw === undefined || raw === null) return fields;
    if (typeof raw !== "object" || Array.isArray(raw)) {
      throw new McpError(ErrorCode.InvalidRequest, "fields must be an object");
    }
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!Object.hasOwn(BULK_FIELD_INPUTS, key)) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          `fields.${key} can't be set in bulk. Allowed: ${Object.keys(BULK_FIELD_INPUTS).join(", ")}`
        );
      }
      if (value === undefined || value === null) continue;
      if (key === "originallyAvailableAt" || key === "discNumber") {
        musicFieldParams({ [key]: value }, fields);
      } else if (key === "year") {
        const year = Number(value);
        if (!Number.isInteger(year) || year < 0) {
          throw new McpError(ErrorCode.InvalidRequest, "fields.year must be a whole number");
        }
        fields.year = year;
      } else {
        fields[BULK_FIELD_INPUTS[key as keyof typeof BULK_FIELD_INPUTS]] = String(value);
      }
    }
    return fields;
  }

  private parseBulkTags(raw: unknown, name: string): Array<{ tag: EditableTagType; values: string[] }> {
    if (raw === undefined || raw === null) return [];
    if (typeof raw !== "object" || Array.isArray(raw)) {
      throw new McpError(ErrorCode.InvalidRequest, `${name} must be an object such as { "genres": ["Jazz"] }`);
    }
    const edits: Array<{ tag: EditableTagType; values: string[] }> = [];
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      const match = BULK_TAG_INPUTS.find(([input]) => input === key);
      if (!match) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          `${name}.${key} isn't supported. Allowed: ${BULK_TAG_INPUTS.map(([input]) => input).join(", ")}`
        );
      }
      if (value !== undefined && value !== null && !Array.isArray(value)) {
        throw new McpError(ErrorCode.InvalidRequest, `${name}.${key} must be a list of tags`);
      }
      const values = [...new Set(this.normalizeTagList(value as unknown[] | undefined))];
      if (values.length > 0) edits.push({ tag: match[1], values });
    }
    return edits;
  }

  private async getPlexGuid(ratingKey: string): Promise<string> {
    const data = await this.client.makeRequest(`/library/metadata/${ratingKey}`);
    const container = data as { MediaContainer?: { Metadata?: Array<Record<string, unknown>> } };
    return this.validatePlexGuid(container.MediaContainer?.Metadata?.[0]?.guid);
  }

  private validatePlexGuid(value: unknown): string {
    if (typeof value !== "string" || !/^plex:\/\/(movie|show)\/[^/?#]+$/.test(value)) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        "Watchlist items must be matched with the Plex Movie or Plex TV Series agent"
      );
    }
    return value;
  }

  private getGlobalRatingKey(plexGuid: string): string {
    return plexGuid.slice(plexGuid.lastIndexOf("/") + 1);
  }

  private async setPosterFromUrl(
    ratingKey: string,
    url: string
  ): Promise<{ success: boolean; error?: string }> {
    validatePlexId(ratingKey, "ratingKey");
    if (!url) {
      return { success: false, error: "Poster update skipped: poster url is required" };
    }
    const refused = posterUrlProblem(url);
    if (refused) {
      return { success: false, error: `Poster update skipped: ${refused}` };
    }

    const attempts = [
      { endpoint: `/library/metadata/${ratingKey}/posters`, method: "POST", label: "POST /posters" },
      { endpoint: `/library/metadata/${ratingKey}/posters`, method: "PUT", label: "PUT /posters" },
    ];
    const errors: string[] = [];

    for (const attempt of attempts) {
      try {
        await this.client.makeRequest(attempt.endpoint, { url }, attempt.method);
        return { success: true };
      } catch (error) {
        errors.push(`${attempt.label}: ${this.getErrorMessage(error)}`);
      }
    }

    return { success: false, error: `Poster update failed. Attempts: ${errors.join(" | ")}` };
  }

  private async getMachineIdentifier(): Promise<string> {
    if (this.machineIdentifier) {
      return this.machineIdentifier;
    }

    const data = await this.client.makeRequest("/identity");
    const machineIdentifier = (data as { MediaContainer?: { machineIdentifier?: string } })
      .MediaContainer?.machineIdentifier;
    if (!machineIdentifier) {
      throw new McpError(
        ErrorCode.InternalError,
        "Unable to determine Plex machine identifier. Check server access and token."
      );
    }
    this.machineIdentifier = machineIdentifier;
    return machineIdentifier;
  }

  private getPlaylistType(type: string): "video" | "audio" | "photo" {
    if (type === "video" || type === "audio" || type === "photo") {
      return type;
    }
    const map: Record<string, "video" | "audio"> = {
      movie: "video",
      show: "video",
      episode: "video",
      artist: "audio",
      album: "audio",
      track: "audio",
    };
    return map[type] || "video";
  }

  /**
   * Default libtype for a smart playlist when the caller didn't specify one.
   * Maps the outer playlist type to a sensible leaf content type.
   */
  private defaultLibtypeFor(playlistType: "video" | "audio" | "photo"): string {
    if (playlistType === "audio") return "track";
    if (playlistType === "photo") return "photo";
    return "movie";
  }

  /**
   * One library's most recently viewed items with a completed view, in one request of
   * recencyPageSize(limit) rows. The merged top `limit` may come from this library alone.
   */
  private async viewedByRecency(
    endpoint: string,
    params: Record<string, string | number>,
    limit: number
  ): Promise<Record<string, unknown>[]> {
    const data = await this.client.makeRequest(endpoint, {
      ...params,
      ...firstPage(recencyPageSize(limit)),
      sort: "lastViewedAt:desc",
    });
    const rows = (data as { MediaContainer?: { Metadata?: Record<string, unknown>[] } }).MediaContainer?.Metadata || [];
    return rows.filter((item) => item.lastViewedAt && (item.viewCount as number) > 0);
  }

  private async getRecentlyWatchedFromLibraries(limit: number, mediaType: string): Promise<MCPResponse> {
    const librariesData = await this.client.makeRequest("/library/sections");
    const libContainer = librariesData as { MediaContainer?: { Directory?: Record<string, unknown>[] } };
    const libraries = libContainer.MediaContainer?.Directory || [];

    let allRecentItems: Record<string, unknown>[] = [];
    // Resolved outside the loop, whose catch would otherwise skip every library for a bad type.
    const typeId = mediaType !== "all" ? this.client.getPlexTypeId(mediaType) : undefined;

    for (const library of libraries) {
      try {
        const params: Record<string, string | number> = {};
        if (typeId !== undefined) {
          params.type = typeId;
        }

        allRecentItems.push(...(await this.viewedByRecency(`/library/sections/${library.key}/all`, params, limit)));
      } catch {
        continue;
      }
    }

    allRecentItems.sort((a, b) => ((b.lastViewedAt as number) || 0) - ((a.lastViewedAt as number) || 0));
    allRecentItems = allRecentItems.slice(0, limit);

    return jsonResponse({
      recentlyWatched: allRecentItems.map((item) => ({
        ratingKey: item.ratingKey,
        title: item.title,
        type: item.type,
        ...showContext(item),
        year: item.year,
        lastViewedAt: item.lastViewedAt,
        viewCount: item.viewCount,
        duration: item.duration,
        viewOffset: item.viewOffset || 0,
        progress: progressPercent(item),
      })),
      totalCount: allRecentItems.length,
      note: "Retrieved from library metadata",
    });
  }

  private async getWatchHistoryFromLibraries(
    limit: number,
    userId?: string,
    mediaType: string = "all"
  ): Promise<MCPResponse> {
    const librariesData = await this.client.makeRequest("/library/sections");
    const libContainer = librariesData as { MediaContainer?: { Directory?: Record<string, unknown>[] } };
    const libraries = libContainer.MediaContainer?.Directory || [];

    let allViewedItems: Record<string, unknown>[] = [];
    // Resolved outside the loop, whose catch would otherwise skip every library for a bad type.
    const typeId = mediaType !== "all" ? this.client.getPlexTypeId(mediaType) : undefined;

    for (const library of libraries) {
      try {
        const params: Record<string, string | number> = {};
        if (typeId !== undefined) {
          params.type = typeId;
        }

        const viewedContent = await this.viewedByRecency(`/library/sections/${library.key}/all`, params, limit);

        const historyItems = viewedContent.map((item) => ({
          ratingKey: item.ratingKey,
          title: item.title,
          type: item.type,
          ...showContext(item),
          year: item.year,
          lastViewedAt: item.lastViewedAt,
          viewCount: item.viewCount,
          duration: item.duration,
          viewOffset: item.viewOffset || 0,
          library: library.title,
          // Judged here, from the raw item: shows and seasons need their leaf counts.
          completed:
            isFullyWatched(item) &&
            isContentCompleted(item.duration as number | undefined, item.viewOffset as number | undefined, item.viewCount as number | undefined),
          progress: progressPercent(item),
        }));

        allViewedItems.push(...historyItems);
      } catch {
        continue;
      }
    }

    allViewedItems.sort((a, b) => ((b.lastViewedAt as number) || 0) - ((a.lastViewedAt as number) || 0));
    allViewedItems = allViewedItems.slice(0, limit);

    return jsonResponse({
      // Already shaped (incl. showContext, completed and progress) by the historyItems map above.
      watchHistory: allViewedItems,
      totalSessions: allViewedItems.length,
      note: "Generated from library metadata (fallback method)",
    });
  }

  private async getFullyWatchedFromLibraries(
    libraryKey: string | undefined,
    mediaType: string,
    limit: number
  ): Promise<MCPResponse> {
    const librariesData = await this.client.makeRequest("/library/sections");
    const libContainer = librariesData as { MediaContainer?: { Directory?: Record<string, unknown>[] } };
    const libraries = libContainer.MediaContainer?.Directory || [];

    let allWatchedItems: Record<string, unknown>[] = [];
    // Resolved outside the loop, whose catch would otherwise skip every library for a bad type.
    const typeId = mediaType !== "all" ? this.client.getPlexTypeId(mediaType) : undefined;

    for (const library of libraries) {
      try {
        if (libraryKey && library.key !== libraryKey) continue;

        // Ranked by plays, as the merge below is, so one library's first `limit` rows hold
        // every row of its own that can reach the merged top `limit`. Unwatched rows sort last.
        const params: Record<string, string | number> = {
          ...firstPage(Math.max(1, limit)),
          sort: "viewCount:desc",
        };
        if (typeId !== undefined) {
          params.type = typeId;
        }

        const contentData = await this.client.makeRequest(`/library/sections/${library.key}/all`, params);
        const container = contentData as { MediaContainer?: { Metadata?: Record<string, unknown>[] } };
        const content = container.MediaContainer?.Metadata || [];

        const watchedContent = content.filter(
          (item) => (item.viewCount as number) > 0
        );
        allWatchedItems.push(...watchedContent);
      } catch {
        continue;
      }
    }

    allWatchedItems.sort((a, b) => ((b.viewCount as number) || 0) - ((a.viewCount as number) || 0));
    allWatchedItems = allWatchedItems.slice(0, limit);

    return jsonResponse({
      fullyWatched: allWatchedItems.map((item) => ({
        ratingKey: item.ratingKey,
        title: item.title,
        type: item.type,
        ...showContext(item),
        year: item.year,
        viewCount: item.viewCount,
        lastViewedAt: item.lastViewedAt,
        duration: item.duration,
        rating: item.rating,
        summary: truncate((item.summary as string) || "", SUMMARY_PREVIEW_LENGTH),
      })),
      totalCount: allWatchedItems.length,
      note: "Retrieved using fallback method - showing items with any view count",
    });
  }

  private async getBasicStats(timeRange: number, statType: string): Promise<MCPResponse> {
    const librariesData = await this.client.makeRequest("/library/sections");
    const libContainer = librariesData as { MediaContainer?: { Directory?: Record<string, unknown>[] } };
    const libraries = libContainer.MediaContainer?.Directory || [];

    return jsonResponse({
      message: "Detailed statistics not available, showing library overview",
      libraries: libraries.map((lib) => ({
        title: lib.title,
        type: lib.type,
        count: lib.count,
        scannedAt: lib.scannedAt,
      })),
    });
  }

  private calculatePlayStats(sessions: Record<string, unknown>[]) {
    const playsByDay: Record<string, number> = {};
    const playsByType: Record<string, number> = {};

    sessions.forEach((session) => {
      const date = new Date((session.viewedAt as number) * 1000).toISOString().split("T")[0];
      playsByDay[date] = (playsByDay[date] || 0) + 1;
      playsByType[session.type as string] = (playsByType[session.type as string] || 0) + 1;
    });

    return {
      totalPlays: sessions.length,
      playsByDay,
      playsByType,
      averagePlaysPerDay: sessions.length / Object.keys(playsByDay).length || 0,
    };
  }

  private calculateDurationStats(sessions: Record<string, unknown>[]) {
    let totalDuration = 0;
    const durationByType: Record<string, number> = {};

    sessions.forEach((session) => {
      const duration = (session.duration as number) || 0;
      totalDuration += duration;
      durationByType[session.type as string] = (durationByType[session.type as string] || 0) + duration;
    });

    return {
      totalDuration,
      totalDurationHours: Math.round(totalDuration / 3600000),
      durationByType,
      averageSessionDuration: sessions.length > 0 ? totalDuration / sessions.length : 0,
    };
  }

  private calculateUserStats(sessions: Record<string, unknown>[]) {
    const userCounts: Record<string, number> = {};
    const userDuration: Record<string, number> = {};

    sessions.forEach((session) => {
      const user = (session.User as { title?: string } | undefined)?.title || "Unknown";
      userCounts[user] = (userCounts[user] || 0) + 1;
      userDuration[user] = (userDuration[user] || 0) + ((session.duration as number) || 0);
    });

    return {
      uniqueUsers: Object.keys(userCounts).length,
      userPlayCounts: userCounts,
      userWatchTime: userDuration,
      topUsers: Object.entries(userCounts)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 10),
    };
  }

  private calculateLibraryStats(sessions: Record<string, unknown>[]) {
    const libraryCounts: Record<string, number> = {};

    sessions.forEach((session) => {
      const library = (session.librarySectionTitle as string) || "Unknown";
      libraryCounts[library] = (libraryCounts[library] || 0) + 1;
    });

    return {
      libraryPlayCounts: libraryCounts,
      topLibraries: Object.entries(libraryCounts)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 10),
    };
  }

  private calculatePlatformStats(sessions: Record<string, unknown>[]) {
    const platformCounts: Record<string, number> = {};

    sessions.forEach((session) => {
      const platform = (session.Player as { platform?: string } | undefined)?.platform || "Unknown";
      platformCounts[platform] = (platformCounts[platform] || 0) + 1;
    });

    return {
      platformPlayCounts: platformCounts,
      topPlatforms: Object.entries(platformCounts)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 10),
    };
  }

  // ──── Recommendations ────

  async getRecommendations(
    libraryKey: string,
    limit: number = DEFAULT_LIMITS.recommendations,
    userId?: string,
    qualityBias: number = 1.0,
    traktWatchedTitles?: Set<string>,
  ): Promise<MCPResponse> {
    validatePlexId(libraryKey, "libraryKey");
    const allMovies = await this.client.getLibraryMoviesWithMeta(libraryKey, userId);

    // Merge Plex and Trakt watched data — Trakt catches off-Plex watches
    const isWatched = (m: LibraryMovieRecord): boolean => {
      if (m.viewCount > 0) return true;
      if (traktWatchedTitles && m.year) {
        return traktWatchedTitles.has(`${m.title.toLowerCase()}|${m.year}`);
      }
      return false;
    };

    const watched = allMovies.filter(isWatched);
    const unwatched = allMovies.filter((m) => !isWatched(m));
    const traktOnlyCount = traktWatchedTitles
      ? watched.filter((m) => m.viewCount === 0).length
      : 0;

    if (watched.length < MIN_WATCHED_FOR_RECOMMENDATIONS) {
      return jsonResponse({
        success: false,
        watchedCount: watched.length,
        message: `Not enough watch history to generate recommendations (watched: ${watched.length}). Watch at least ${MIN_WATCHED_FOR_RECOMMENDATIONS} movies first.`,
      });
    }

    if (unwatched.length === 0) {
      return jsonResponse({
        success: false,
        watchedCount: watched.length,
        message: "You've watched every movie in this library!",
      });
    }

    const profile = this.buildTasteProfile(watched);

    const scored = unwatched
      .map((movie) => this.scoreMovie(movie, profile, qualityBias))
      .sort((a, b) => b.score - a.score);

    const diverse = this.applyDiversityPenalty(scored, limit);

    const topGenres = [...profile.genreScores.entries()]
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([g]) => g);
    const topDirectors = [...profile.directorCounts.entries()]
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3)
      .map(([d]) => d);
    const topActors = [...profile.actorCounts.entries()]
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3)
      .map(([a]) => a);

    return jsonResponse({
      success: true,
      libraryKey,
      watchedCount: watched.length,
      unwatchedCount: unwatched.length,
      traktExtraWatched: traktOnlyCount > 0 ? traktOnlyCount : undefined,
      userId: userId || "server_owner",
      tasteProfile: {
        topGenres,
        topDirectors,
        topActors,
        avgRating: Math.round(profile.weightedAvgRating * 10) / 10,
      },
      traktEnhanced: qualityBias !== 1.0 || traktOnlyCount > 0,
      recommendations: diverse.slice(0, limit).map((m) => ({
        ratingKey: m.ratingKey,
        title: m.title,
        year: m.year,
        genres: m.genres,
        rating: m.rating,
        score: parseFloat(m.score.toFixed(3)),
        reasons: m.reasons,
      })),
    });
  }

  private buildTasteProfile(watched: LibraryMovieRecord[]): TasteProfile {
    const genreScores = new Map<string, number>();
    const directorCounts = new Map<string, number>();
    const actorCounts = new Map<string, number>();
    const now = Date.now() / 1000;
    let ratingSum = 0;
    let ratingWeight = 0;
    const years: number[] = [];

    for (const movie of watched) {
      const daysSince = movie.lastViewedAt ? (now - movie.lastViewedAt) / 86400 : 365;
      const recencyWeight = Math.exp(-Math.LN2 * daysSince / RECENCY_HALF_LIFE_DAYS);
      const viewWeight = Math.log1p(movie.viewCount);
      const itemWeight = recencyWeight * viewWeight;

      for (const genre of movie.genres) {
        genreScores.set(genre, (genreScores.get(genre) || 0) + itemWeight);
      }
      for (const director of movie.directors) {
        directorCounts.set(director, (directorCounts.get(director) || 0) + 1);
      }
      for (const actor of movie.actors) {
        actorCounts.set(actor, (actorCounts.get(actor) || 0) + 1);
      }
      if (movie.rating !== undefined) {
        ratingSum += movie.rating * itemWeight;
        ratingWeight += itemWeight;
      }
      if (movie.year) years.push(movie.year);
    }

    // Normalize genre scores to 0–1
    const maxGenre = Math.max(...genreScores.values(), 1);
    for (const [g, v] of genreScores) genreScores.set(g, v / maxGenre);

    const weightedAvgRating = ratingWeight > 0 ? ratingSum / ratingWeight : 5;
    const yearMean = years.length > 0 ? years.reduce((a, b) => a + b, 0) / years.length : 2000;
    const yearStdDev = years.length > 1
      ? Math.sqrt(years.reduce((sum, y) => sum + (y - yearMean) ** 2, 0) / years.length)
      : 20;

    return { genreScores, directorCounts, actorCounts, weightedAvgRating, yearMean, yearStdDev };
  }

  private scoreMovie(
    movie: LibraryMovieRecord,
    profile: TasteProfile,
    qualityBias: number,
  ): LibraryMovieRecord & { score: number; reasons: string[] } {
    const reasons: string[] = [];

    // Genre match: average across genres to prevent single-genre dominance
    let genreScore = 0;
    for (const genre of movie.genres) {
      const gs = profile.genreScores.get(genre) || 0;
      if (gs > 0.3) reasons.push(`You love ${genre}`);
      genreScore += gs;
    }
    // Normalize: divide by genre count to avoid multi-genre penalty
    genreScore = movie.genres.length > 0 ? (genreScore / movie.genres.length) * 0.8 + 0.2 : 0.2;

    // Rating bonus: normalize to 0–1 range (accounting for qualityBias)
    const ratingScore = movie.rating !== undefined ? Math.min((movie.rating / 10) * qualityBias, 1.0) : 0.5;
    if (movie.rating !== undefined && movie.rating >= 7) {
      reasons.push(`Highly rated (${movie.rating}/10)`);
    }

    // Director match: cap at 1.0 for single strong match
    let directorScore = 0;
    for (const director of movie.directors) {
      const count = profile.directorCounts.get(director) || 0;
      if (count > 0) {
        directorScore = Math.min(count / 3, 1.0);
        reasons.push(`Director: ${director} (watched ${count} films)`);
        break;
      }
    }

    // Actor match: normalized to 0–1
    let actorScore = 0;
    const topActors = [...profile.actorCounts.entries()]
      .sort(([, a], [, b]) => b - a)
      .slice(0, TASTE_TOP_ACTORS);
    for (const actor of movie.actors) {
      const entry = topActors.find(([a]) => a === actor);
      if (entry) {
        actorScore = Math.min(entry[1] / 5, 1.0);
        reasons.push(`Cast: ${actor} (in ${entry[1]} of your watched films)`);
        break;
      }
    }

    // Era match: normalized to 0–1
    let eraScore = 0.5;
    if (movie.year && profile.yearStdDev > 0) {
      eraScore = Math.exp(-((movie.year - profile.yearMean) ** 2) / (2 * profile.yearStdDev ** 2));
    }

    // Weighted sum: all components now normalized to 0–1 range
    const score =
      genreScore * 0.40 +
      ratingScore * 0.30 +
      directorScore * 0.15 +
      actorScore * 0.10 +
      eraScore * 0.05;

    return { ...movie, score, reasons: [...new Set(reasons)].slice(0, 4) };
  }

  private applyDiversityPenalty(
    scored: Array<LibraryMovieRecord & { score: number; reasons: string[] }>,
    limit: number,
  ): Array<LibraryMovieRecord & { score: number; reasons: string[] }> {
    const candidates = scored.slice(0, limit * 3);
    const genreCounts = new Map<string, number>();
    const result: typeof candidates = [];

    for (const movie of candidates) {
      const topGenre = movie.genres[0] || "Unknown";
      const count = genreCounts.get(topGenre) || 0;
      const penalty = count >= 2 ? 0.15 * (count - 1) : 0;
      const adjustedScore = movie.score - penalty;
      genreCounts.set(topGenre, count + 1);
      result.push({ ...movie, score: adjustedScore });
    }

    return result.sort((a, b) => b.score - a.score);
  }
}
