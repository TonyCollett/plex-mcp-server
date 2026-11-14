/**
 * The tools advertised by tools/list.
 *
 * Write tools (Plex, Sonarr/Radarr and Trakt) are only listed when
 * PLEX_ENABLE_MUTATIVE_OPS=true. Calling one while disabled is still refused
 * by its registry; this keeps clients
 * from being offered tools that can only fail.
 */

import { PLEX_TOOL_SCHEMAS, PLEX_MUTATIVE_TOOL_SCHEMAS } from "../plex/tool-schemas.js";
import { isMutativeOpsEnabled } from "../plex/constants.js";
import { TRAKT_TOOL_SCHEMAS } from "../trakt/tool-schemas.js";
import { ARR_TOOL_SCHEMAS } from "../arr/tool-schemas.js";
import { withAnnotations } from "./tool-annotations.js";
import { isNonPlexWriteTool } from "./write-tools.js";

export function listedToolSchemas() {
  const writesEnabled = isMutativeOpsEnabled();
  const visible = <T extends { name: string }>(schemas: readonly T[]) =>
    writesEnabled ? [...schemas] : schemas.filter((s) => !isNonPlexWriteTool(s.name));

  return withAnnotations([
    ...PLEX_TOOL_SCHEMAS,
    ...(writesEnabled ? PLEX_MUTATIVE_TOOL_SCHEMAS : []),
    ...visible(TRAKT_TOOL_SCHEMAS),
    ...visible(ARR_TOOL_SCHEMAS),
  ]);
}
