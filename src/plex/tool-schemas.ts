/**
 * MCP tool schema definitions for Plex tools.
 * Defined once, used by both servers.
 */

import { PLEX_TYPE_IDS } from "./constants.js";

/** Every media type the server resolves to a Plex type id, so the schemas cannot drift from PLEX_TYPE_IDS. */
const MEDIA_TYPES = Object.keys(PLEX_TYPE_IDS);

const GET_LIBRARIES_SCHEMA = {
  name: "get_libraries",
  description: "Get all Plex libraries",
  inputSchema: {
    type: "object" as const,
    properties: {},
  },
};

const GET_LIBRARY_ITEMS_SCHEMA = {
  name: "get_library_items",
  description: "List items in a library with pagination (useful for large libraries)",
  inputSchema: {
    type: "object" as const,
    properties: {
      libraryKey: { type: "string", description: "Library section key" },
      type: {
        type: "string",
        description: `Media type (${MEDIA_TYPES.join(", ")})`,
        enum: MEDIA_TYPES,
      },
      limit: { type: "number", description: "Number of items to return (default: 1000)", default: 1000 },
      offset: { type: "number", description: "Zero-based offset for pagination (default: 0)", default: 0 },
      sort: { type: "string", description: "Sort order (optional, e.g., titleSort:asc)" },
    },
    required: ["libraryKey"],
  },
};

const EXPORT_LIBRARY_SCHEMA = {
  name: "export_library",
  description: "Export a full library to a JSON file (within ./exports)",
  inputSchema: {
    type: "object" as const,
    properties: {
      libraryKey: { type: "string", description: "Library section key" },
      type: {
        type: "string",
        description: `Media type (${MEDIA_TYPES.join(", ")})`,
        enum: MEDIA_TYPES,
      },
      outputPath: {
        type: "string",
        description:
          "Optional relative path under ./exports (default: library_{key}_{timestamp}.json)",
      },
      pageSize: { type: "number", description: "Items per page for export (default: 500)", default: 500 },
    },
    required: ["libraryKey"],
  },
};

const SEARCH_MEDIA_SCHEMA = {
  name: "search_media",
  description: "Search for media in Plex libraries",
  inputSchema: {
    type: "object" as const,
    properties: {
      query: { type: "string", description: "Search query" },
      type: {
        type: "string",
        description: `Media type (${MEDIA_TYPES.join(", ")})`,
        enum: MEDIA_TYPES,
      },
      libraryKey: { type: "string", description: "Library section key to restrict search (optional)" },
      limit: { type: "number", description: "Number of items to return (default: 500)", default: 500 },
      offset: { type: "number", description: "Zero-based offset for pagination (default: 0)", default: 0 },
    },
    required: ["query"],
  },
};

const GET_RECENTLY_ADDED_SCHEMA = {
  name: "get_recently_added",
  description:
    "Get recently added media across all libraries. TV is grouped by season, so a new episode of an existing season is not listed; " +
    "pass type and libraryKey to list items of one type (e.g. episode) newest first.",
  inputSchema: {
    type: "object" as const,
    properties: {
      limit: { type: "number", description: "Number of items to return (default: 50)", default: 50 },
      type: {
        type: "string",
        description: "List only this media type, newest first (requires libraryKey)",
        enum: MEDIA_TYPES,
      },
      libraryKey: { type: "string", description: "Library section key to list from (required with type)" },
    },
  },
};

const GET_ON_DECK_SCHEMA = {
  name: "get_on_deck",
  description: "Get on deck (continue watching) items",
  inputSchema: {
    type: "object" as const,
    properties: {},
  },
};

const GET_MEDIA_DETAILS_SCHEMA = {
  name: "get_media_details",
  description: "Get detailed information about a specific media item",
  inputSchema: {
    type: "object" as const,
    properties: {
      ratingKey: { type: "string", description: "The rating key of the media item" },
    },
    required: ["ratingKey"],
  },
};

const GET_ACTIVE_SESSIONS_SCHEMA = {
  name: "get_active_sessions",
  description:
    "Get currently active Plex streams — who is watching what right now, " +
    "including player state, session location, transcode decisions and media quality",
  inputSchema: {
    type: "object" as const,
    properties: {},
  },
};

const GET_EDITABLE_FIELDS_SCHEMA = {
  name: "get_editable_fields",
  description: "Get editable fields, available tags and locked fields for a media item",
  inputSchema: {
    type: "object" as const,
    properties: {
      ratingKey: { type: "string", description: "The rating key of the media item" },
    },
    required: ["ratingKey"],
  },
};

const GET_PLAYLIST_ITEMS_SCHEMA = {
  name: "get_playlist_items",
  description:
    "Get items in a Plex playlist. Tracks include album and artist names. " +
    "Pass limit/offset to page through large playlists.",
  inputSchema: {
    type: "object" as const,
    properties: {
      playlistId: { type: "string", description: "Playlist rating key" },
      limit: { type: "number", description: "Max items to return (optional; default: all)" },
      offset: { type: "number", description: "Zero-based offset, used with limit (default: 0)" },
    },
    required: ["playlistId"],
  },
};

const GET_CHILDREN_SCHEMA = {
  name: "get_children",
  description:
    "List an item's direct children: an artist's albums, an album's tracks (all discs), " +
    "a show's seasons or a season's episodes",
  inputSchema: {
    type: "object" as const,
    properties: {
      ratingKey: { type: "string", description: "Rating key of the artist, album, show or season" },
      limit: { type: "number", description: "Max items to return (optional; default: all)" },
      offset: { type: "number", description: "Zero-based offset (default: 0)" },
    },
    required: ["ratingKey"],
  },
};

const GET_PLAYLISTS_SCHEMA = {
  name: "get_playlists",
  description: "Get all Plex playlists",
  inputSchema: {
    type: "object" as const,
    properties: {},
  },
};

const GET_WATCHLIST_SCHEMA = {
  name: "get_watchlist",
  description: "Get the user's Plex watchlist",
  inputSchema: {
    type: "object" as const,
    properties: {},
  },
};

const GET_RECENTLY_WATCHED_SCHEMA = {
  name: "get_recently_watched",
  description: "Get recently watched movies and shows",
  inputSchema: {
    type: "object" as const,
    properties: {
      limit: { type: "number", description: "Number of items to return (default: 100)", default: 100 },
      mediaType: {
        type: "string",
        description: "Filter by media type (movie, show, episode, all)",
        enum: ["movie", "show", "episode", "all"],
        default: "all",
      },
    },
  },
};

const GET_WATCH_HISTORY_SCHEMA = {
  name: "get_watch_history",
  description: "Get detailed watch history with session information",
  inputSchema: {
    type: "object" as const,
    properties: {
      limit: { type: "number", description: "Number of sessions to return (default: 500)", default: 500 },
      userId: { type: "string", description: "Filter by specific user ID (optional)" },
      mediaType: {
        type: "string",
        description: "Filter by media type",
        enum: ["movie", "show", "episode", "all"],
        default: "all",
      },
    },
  },
};

const GET_FULLY_WATCHED_SCHEMA = {
  name: "get_fully_watched",
  description: "Get all fully watched movies and shows from a library",
  inputSchema: {
    type: "object" as const,
    properties: {
      libraryKey: { type: "string", description: "Library section key (optional, searches all if not provided)" },
      mediaType: {
        type: "string",
        description: "Filter by media type (movie, show, all)",
        enum: ["movie", "show", "all"],
        default: "all",
      },
      limit: { type: "number", description: "Number of items to return (default: 500)", default: 500 },
    },
  },
};

const GET_WATCH_STATS_SCHEMA = {
  name: "get_watch_stats",
  description: "Get comprehensive watch statistics (Tautulli-style analytics)",
  inputSchema: {
    type: "object" as const,
    properties: {
      timeRange: { type: "number", description: "Time range in days (default: 30)", default: 30 },
      statType: {
        type: "string",
        description: "Type of statistics to retrieve",
        enum: ["plays", "duration", "users", "libraries", "platforms"],
        default: "plays",
      },
    },
  },
};

const GET_USER_STATS_SCHEMA = {
  name: "get_user_stats",
  description: "Get user-specific watch statistics",
  inputSchema: {
    type: "object" as const,
    properties: {
      timeRange: { type: "number", description: "Time range in days (default: 30)", default: 30 },
    },
  },
};

const GET_LIBRARY_STATS_SCHEMA = {
  name: "get_library_stats",
  description: "Get library-specific statistics",
  inputSchema: {
    type: "object" as const,
    properties: {
      libraryKey: { type: "string", description: "Library section key (optional)" },
    },
  },
};

const GET_POPULAR_CONTENT_SCHEMA = {
  name: "get_popular_content",
  description: "Get most popular content by plays or duration",
  inputSchema: {
    type: "object" as const,
    properties: {
      timeRange: { type: "number", description: "Time range in days (default: 30)", default: 30 },
      metric: {
        type: "string",
        description: "Sort by plays or total duration",
        enum: ["plays", "duration"],
        default: "plays",
      },
      mediaType: {
        type: "string",
        description: "Filter by media type",
        enum: ["movie", "show", "episode", "all"],
        default: "all",
      },
      limit: { type: "number", description: "Number of items to return (default: 50)", default: 50 },
    },
  },
};

/** Core tools shared by both servers (13 tools) */
const UPDATE_METADATA_SCHEMA = {
  name: "update_metadata",
  description: "Update metadata fields for a media item (requires PLEX_ENABLE_MUTATIVE_OPS=true)",
  inputSchema: {
    type: "object" as const,
    properties: {
      ratingKey: { type: "string", description: "The rating key of the media item to update" },
      title: { type: "string", description: "New title (optional)" },
      sortTitle: { type: "string", description: "New sort title (optional)" },
      originalTitle: {
        type: "string",
        description: "New original title (optional). For a music track this is the track artist",
      },
      summary: { type: "string", description: "New summary/description (optional)" },
      year: { type: "number", description: "New year (optional)" },
      contentRating: { type: "string", description: "New content rating (optional)" },
      rating: { type: "number", description: "New user rating (optional)" },
      tagline: { type: "string", description: "New tagline (optional)" },
      studio: { type: "string", description: "New studio (optional). For a music album this is the record label" },
      originallyAvailableAt: {
        type: "string",
        description: "Release date as YYYY-MM-DD (optional), e.g. an album's release date",
      },
      trackNumber: { type: "number", description: "Track number, for a music track (optional)" },
      discNumber: { type: "number", description: "Disc number, for a music track (optional)" },
      genres: { type: "array", description: "Replace genres with these tags (optional)", items: { type: "string" } },
      styles: {
        type: "array",
        description: "Replace music styles with these tags (optional; artists and albums)",
        items: { type: "string" },
      },
      moods: {
        type: "array",
        description: "Replace music moods with these tags (optional; artists, albums and tracks)",
        items: { type: "string" },
      },
      labels: { type: "array", description: "Replace labels with these tags (optional)", items: { type: "string" } },
      collections: {
        type: "array",
        description: "Replace collections with these tags (optional)",
        items: { type: "string" },
      },
      roles: { type: "array", description: "Replace roles/actors with these tags (optional)", items: { type: "string" } },
      directors: {
        type: "array",
        description: "Replace directors with these tags (optional)",
        items: { type: "string" },
      },
    },
    required: ["ratingKey"],
  },
};

const UPDATE_METADATA_FROM_JSON_SCHEMA = {
  name: "update_metadata_from_json",
  description: "Update metadata from a JSON payload (requires PLEX_ENABLE_MUTATIVE_OPS=true)",
  inputSchema: {
    type: "object" as const,
    properties: {
      ratingKey: { type: "string", description: "The rating key of the media item to update" },
      metadata: { type: "object", description: "Metadata payload to apply" },
      setPosterFromUrl: {
        type: "boolean",
        description: "Attempt to set poster from metadata.images.posters[0].url",
        default: false,
      },
    },
    required: ["ratingKey", "metadata"],
  },
};

const BULK_TAG_LISTS = {
  type: "object",
  properties: {
    genres: { type: "array", items: { type: "string" } },
    styles: { type: "array", items: { type: "string" } },
    moods: { type: "array", items: { type: "string" } },
    collections: { type: "array", items: { type: "string" } },
    labels: { type: "array", items: { type: "string" } },
  },
  additionalProperties: false,
};

const BULK_UPDATE_METADATA_SCHEMA = {
  name: "bulk_update_metadata",
  description:
    "Apply the same edits to many items at once, e.g. every track on an album or every album by an artist " +
    "(requires PLEX_ENABLE_MUTATIVE_OPS=true). Pass ratingKeys, or parentRatingKey to edit all of an item's children. " +
    "Items must share one type and library. Edited fields are locked against metadata refreshes. " +
    "Tags are added or removed, leaving each item's other tags alone. Run with dryRun=true first to preview. " +
    "To rename an album, edit the album itself with update_metadata; a track's album comes from its file tags and can't be changed here.",
  inputSchema: {
    type: "object" as const,
    properties: {
      ratingKeys: {
        type: "array",
        description: "Rating keys of the items to edit (at most 500)",
        items: { type: "string" },
      },
      parentRatingKey: {
        type: "string",
        description: "Edit every child of this item instead: an album's tracks, an artist's albums, a season's episodes",
      },
      fields: {
        type: "object",
        description: "Fields to set on every item",
        properties: {
          originalTitle: { type: "string", description: "Track artist, for tracks; original title otherwise" },
          summary: { type: "string" },
          year: { type: "number" },
          originallyAvailableAt: { type: "string", description: "Release date, YYYY-MM-DD" },
          contentRating: { type: "string" },
          tagline: { type: "string" },
          studio: { type: "string", description: "Record label, for albums" },
          discNumber: { type: "number", description: "Disc number, for tracks" },
        },
        additionalProperties: false,
      },
      addTags: { ...BULK_TAG_LISTS, description: "Tags to add to every item" },
      removeTags: { ...BULK_TAG_LISTS, description: "Tags to remove from every item" },
      dryRun: {
        type: "boolean",
        description: "List the items and their current values without changing anything",
        default: false,
      },
    },
  },
};

const MERGE_ITEMS_SCHEMA = {
  name: "merge_items",
  description:
    "Merge duplicate movies, shows, artists or albums into one, like Merge in Plex Web " +
    "(requires PLEX_ENABLE_MUTATIVE_OPS=true). The target keeps its metadata and gains the sources' media; " +
    "the sources stop existing as separate items. All must be the same type in the same library. " +
    "Returns a preview unless confirm=true. Split in Plex Web undoes a merge.",
  inputSchema: {
    type: "object" as const,
    properties: {
      targetRatingKey: { type: "string", description: "The item to keep" },
      sourceRatingKeys: {
        type: "array",
        description: "Items to merge into the target (at most 50)",
        items: { type: "string" },
      },
      confirm: { type: "boolean", description: "Set true to perform the merge", default: false },
    },
    required: ["targetRatingKey", "sourceRatingKeys"],
  },
};

const SCAN_LIBRARY_SCHEMA = {
  name: "scan_library",
  description:
    "Scan a library for new, changed and missing files, like Scan Library Files in Plex Web " +
    "(requires PLEX_ENABLE_MUTATIVE_OPS=true). Pass path to scan one folder inside the library, " +
    "or force=true to refresh all metadata instead (locked fields are kept). " +
    "Plex scans in the background and the call returns at once.",
  inputSchema: {
    type: "object" as const,
    properties: {
      libraryId: { type: "string", description: "Library key, from get_libraries" },
      path: {
        type: "string",
        description: "Only scan this folder. Must be inside one of the library's folders, as Plex sees them",
      },
      force: {
        type: "boolean",
        description: "Refresh all metadata for the whole library instead of scanning files. Slow on large libraries",
        default: false,
      },
    },
    required: ["libraryId"],
  },
};

const EMPTY_TRASH_SCHEMA = {
  name: "empty_trash",
  description:
    "Empty a library's trash, like Empty Trash in Plex Web (requires PLEX_ENABLE_MUTATIVE_OPS=true). " +
    "Items whose files are missing are removed for good, with their watch history and ratings; Plex can't undo it. " +
    "If a drive holding the library is offline its items count as missing too. Returns a preview unless confirm=true.",
  inputSchema: {
    type: "object" as const,
    properties: {
      libraryId: { type: "string", description: "Library key, from get_libraries" },
      confirm: { type: "boolean", description: "Set true to empty the trash", default: false },
    },
    required: ["libraryId"],
  },
};

const CREATE_PLAYLIST_SCHEMA = {
  name: "create_playlist",
  description:
    "Create a new Plex playlist (requires PLEX_ENABLE_MUTATIVE_OPS=true). " +
    "For regular playlists, ratingKeys is required — Plex does not support creating empty playlists. " +
    "For smart playlists, set smart=true and provide librarySectionId (and optionally libtype / smartFilter).",
  inputSchema: {
    type: "object" as const,
    properties: {
      title: { type: "string", description: "Playlist title" },
      type: {
        type: "string",
        description: "Playlist type (video, audio, photo) or media type (movie, show, episode, artist, album, track)",
        enum: ["video", "audio", "photo", "movie", "show", "episode", "artist", "album", "track"],
      },
      ratingKeys: {
        type: "array",
        description:
          "Rating keys to seed the playlist with. REQUIRED for non-smart playlists (>=1). " +
          "All items are sent in a single POST, comma-joined in the playlist URI. " +
          "Mutually exclusive with smart=true.",
        items: { type: "string" },
      },
      smart: {
        type: "boolean",
        description: "Create a smart playlist filtered from a library section (default: false)",
        default: false,
      },
      librarySectionId: {
        type: "string",
        description:
          "Smart playlists only: library section ID to filter (e.g. '1'). REQUIRED when smart=true.",
      },
      libtype: {
        type: "string",
        description:
          "Smart playlists only: content type to filter for. Defaults based on playlist type " +
          "(audio->track, video->movie, photo->photo).",
        enum: ["movie", "show", "season", "episode", "artist", "album", "track", "photo", "photoalbum"],
      },
      smartFilter: {
        type: "string",
        description:
          "Smart playlists only: raw Plex filter query string, e.g. " +
          "'genre=Drama&year>=2020&sort=titleSort:asc&limit=100'. Appended to the section URI.",
      },
    },
    required: ["title", "type"],
  },
};

const ADD_TO_PLAYLIST_SCHEMA = {
  name: "add_to_playlist",
  description:
    "Add one or more media items to a playlist in a single request (requires PLEX_ENABLE_MUTATIVE_OPS=true). " +
    "Pass ratingKeys to add many items at once; items are appended in the order given.",
  inputSchema: {
    type: "object" as const,
    properties: {
      playlistId: { type: "string", description: "Playlist rating key" },
      ratingKey: { type: "string", description: "A single media rating key to add" },
      ratingKeys: {
        type: "array",
        items: { type: "string" },
        description: "Several media rating keys to add in one request (takes precedence over ratingKey)",
      },
    },
    required: ["playlistId"],
  },
};

const REMOVE_FROM_PLAYLIST_SCHEMA = {
  name: "remove_from_playlist",
  description: "Remove an item from a playlist (requires PLEX_ENABLE_MUTATIVE_OPS=true)",
  inputSchema: {
    type: "object" as const,
    properties: {
      playlistId: { type: "string", description: "Playlist rating key" },
      playlistItemId: { type: "string", description: "Playlist item ID to remove" },
    },
    required: ["playlistId", "playlistItemId"],
  },
};

const CLEAR_PLAYLIST_SCHEMA = {
  name: "clear_playlist",
  description: "Clear all items from a playlist (preview unless confirm=true; requires PLEX_ENABLE_MUTATIVE_OPS=true)",
  inputSchema: {
    type: "object" as const,
    properties: {
      playlistId: { type: "string", description: "Playlist rating key" },
      confirm: { type: "boolean", description: "Set true to execute clear after preview", default: false },
    },
    required: ["playlistId"],
  },
};

const DELETE_PLAYLIST_SCHEMA = {
  name: "delete_playlist",
  description: "Delete a Plex playlist without deleting the underlying media (requires PLEX_ENABLE_MUTATIVE_OPS=true)",
  inputSchema: {
    type: "object" as const,
    properties: {
      playlistId: { type: "string", description: "Playlist rating key" },
    },
    required: ["playlistId"],
  },
};

const ADD_TO_WATCHLIST_SCHEMA = {
  name: "add_to_watchlist",
  description: "Add a local Plex movie or show to the account watchlist (requires PLEX_ENABLE_MUTATIVE_OPS=true)",
  inputSchema: {
    type: "object" as const,
    properties: {
      ratingKey: { type: "string", description: "Local Plex rating key for a matched movie or show" },
    },
    required: ["ratingKey"],
  },
};

const REMOVE_FROM_WATCHLIST_SCHEMA = {
  name: "remove_from_watchlist",
  description: "Remove a movie or show from the account watchlist by global Plex GUID or local rating key (requires PLEX_ENABLE_MUTATIVE_OPS=true)",
  inputSchema: {
    type: "object" as const,
    properties: {
      plexGuid: { type: "string", description: "Global Plex GUID returned by get_watchlist, such as plex://movie/abc123" },
      ratingKey: { type: "string", description: "Local numeric Plex rating key; resolved to a global GUID before removal" },
    },
    oneOf: [
      { required: ["plexGuid"], not: { required: ["ratingKey"] } },
      { required: ["ratingKey"], not: { required: ["plexGuid"] } },
    ],
  },
};

const MARK_WATCHED_SCHEMA = {
  name: "mark_watched",
  description: "Mark a Plex media item as watched (requires PLEX_ENABLE_MUTATIVE_OPS=true)",
  inputSchema: {
    type: "object" as const,
    properties: {
      ratingKey: { type: "string", description: "The local Plex rating key of the media item" },
    },
    required: ["ratingKey"],
  },
};

const MARK_UNWATCHED_SCHEMA = {
  name: "mark_unwatched",
  description: "Mark a Plex media item as unwatched (requires PLEX_ENABLE_MUTATIVE_OPS=true)",
  inputSchema: {
    type: "object" as const,
    properties: {
      ratingKey: { type: "string", description: "The local Plex rating key of the media item" },
    },
    required: ["ratingKey"],
  },
};

const RATE_MEDIA_SCHEMA = {
  name: "rate_media",
  description: "Set the user's Plex rating for a media item (requires PLEX_ENABLE_MUTATIVE_OPS=true)",
  inputSchema: {
    type: "object" as const,
    properties: {
      ratingKey: { type: "string", description: "The local Plex rating key of the media item" },
      rating: {
        type: "number",
        description: "User rating from 0 to 10",
        minimum: 0,
        maximum: 10,
      },
    },
    required: ["ratingKey", "rating"],
  },
};
export const PLEX_CORE_TOOL_SCHEMAS = [
  GET_LIBRARIES_SCHEMA,
  GET_LIBRARY_ITEMS_SCHEMA,
  EXPORT_LIBRARY_SCHEMA,
  SEARCH_MEDIA_SCHEMA,
  GET_RECENTLY_ADDED_SCHEMA,
  GET_ON_DECK_SCHEMA,
  GET_MEDIA_DETAILS_SCHEMA,
  GET_EDITABLE_FIELDS_SCHEMA,
  GET_PLAYLIST_ITEMS_SCHEMA,
  GET_CHILDREN_SCHEMA,
  GET_PLAYLISTS_SCHEMA,
  GET_WATCHLIST_SCHEMA,
  GET_RECENTLY_WATCHED_SCHEMA,
  GET_WATCH_HISTORY_SCHEMA,
  GET_ACTIVE_SESSIONS_SCHEMA,
];

const GET_RECOMMENDATIONS_SCHEMA = {
  name: "get_recommendations",
  description:
    "Get personalized movie recommendations from your Plex library based on watch history. " +
    "Analyzes genres, directors, and actors you've watched to score unwatched films. " +
    "Supports per-user recommendations for multi-user Plex servers. " +
    "If Trakt is configured, uses your rating profile to further refine scores.",
  inputSchema: {
    type: "object" as const,
    properties: {
      libraryKey: {
        type: "string",
        description: "Library section key (required — use get_libraries to find it)",
      },
      limit: {
        type: "number",
        description: "Number of recommendations to return (default: 10)",
        default: 10,
      },
      userId: {
        type: "string",
        description:
          "Plex account ID for per-user recommendations. " +
          "Omit to use the server owner. Use get_user_stats to find user IDs.",
      },
    },
    required: ["libraryKey"],
  },
};

/** Extended analytics tools (6 tools) */
const PLEX_EXTENDED_TOOL_SCHEMAS = [
  GET_FULLY_WATCHED_SCHEMA,
  GET_WATCH_STATS_SCHEMA,
  GET_USER_STATS_SCHEMA,
  GET_LIBRARY_STATS_SCHEMA,
  GET_POPULAR_CONTENT_SCHEMA,
  GET_RECOMMENDATIONS_SCHEMA,
];

/** All Plex tool schemas */
/** Mutative tools (16 tools) — registered only when opt-in is enabled */
export const PLEX_MUTATIVE_TOOL_SCHEMAS = [
  UPDATE_METADATA_SCHEMA,
  UPDATE_METADATA_FROM_JSON_SCHEMA,
  BULK_UPDATE_METADATA_SCHEMA,
  MERGE_ITEMS_SCHEMA,
  SCAN_LIBRARY_SCHEMA,
  EMPTY_TRASH_SCHEMA,
  CREATE_PLAYLIST_SCHEMA,
  ADD_TO_PLAYLIST_SCHEMA,
  REMOVE_FROM_PLAYLIST_SCHEMA,
  CLEAR_PLAYLIST_SCHEMA,
  DELETE_PLAYLIST_SCHEMA,
  ADD_TO_WATCHLIST_SCHEMA,
  REMOVE_FROM_WATCHLIST_SCHEMA,
  RATE_MEDIA_SCHEMA,
  MARK_WATCHED_SCHEMA,
  MARK_UNWATCHED_SCHEMA,
];
export const PLEX_TOOL_SCHEMAS = [
  ...PLEX_CORE_TOOL_SCHEMAS,
  ...PLEX_EXTENDED_TOOL_SCHEMAS,
];
