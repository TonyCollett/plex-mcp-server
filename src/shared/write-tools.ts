/**
 * Non-Plex tools that change state somewhere: Sonarr/Radarr (adding media,
 * starting downloads, editing tags) and Trakt (writing watch history,
 * scrobbling, and the OAuth flow, which replaces the Trakt account every
 * session uses and overwrites TRAKT_TOKEN_FILE).
 *
 * They sit behind the same PLEX_ENABLE_MUTATIVE_OPS switch as the Plex write
 * tools, so "write operations disabled" means disabled everywhere: hidden from
 * tools/list and refused if called anyway. Plex's own write tools are listed in
 * PLEX_MUTATIVE_TOOL_SCHEMAS.
 */

export const ARR_WRITE_TOOLS: readonly string[] = [
  "sonarr_add_series",
  "sonarr_trigger_search",
  "sonarr_create_tag",
  "sonarr_update_tag",
  "sonarr_delete_tag",
  "radarr_add_movie",
  "radarr_trigger_search",
  "radarr_create_tag",
  "radarr_update_tag",
  "radarr_delete_tag",
];

export const TRAKT_WRITE_TOOLS: readonly string[] = [
  "trakt_authenticate",
  "trakt_complete_auth",
  "trakt_sync_to_trakt",
  "trakt_start_scrobbling",
];

const NON_PLEX_WRITE_TOOLS = new Set([...ARR_WRITE_TOOLS, ...TRAKT_WRITE_TOOLS]);

export function isNonPlexWriteTool(name: string): boolean {
  return NON_PLEX_WRITE_TOOLS.has(name);
}
