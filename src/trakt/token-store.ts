/**
 * Optional on-disk store for Trakt OAuth tokens (TRAKT_TOKEN_FILE).
 *
 * Without it, tokens obtained by trakt_complete_auth or by a refresh only live
 * in memory: Trakt refresh tokens are single-use, so after the first refresh
 * the TRAKT_REFRESH_TOKEN in the environment is dead and a restart loses the
 * login. With it, every new token pair is written here and read back on start.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface StoredTraktTokens {
  accessToken: string;
  refreshToken: string;
  createdAt?: number;
  expiresIn?: number;
}

export function traktTokenFilePath(): string | undefined {
  const raw = process.env.TRAKT_TOKEN_FILE?.trim();
  return raw ? path.resolve(raw) : undefined;
}

/** Read tokens from the file, or undefined when it is missing or unreadable. */
export function loadTraktTokens(file: string): StoredTraktTokens | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<StoredTraktTokens>;
    if (typeof parsed.accessToken === "string" && typeof parsed.refreshToken === "string") {
      return parsed as StoredTraktTokens;
    }
    console.error(`[trakt] ${file} has no accessToken/refreshToken; ignoring it`);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      console.error(`[trakt] could not read ${file}: ${(error as Error).message}`);
    }
  }
  return undefined;
}

/**
 * Write tokens atomically (temp file + rename) and readable by the owner only.
 * Errors are logged, not thrown: a failed save must not fail the tool call
 * that produced the tokens.
 */
export function saveTraktTokens(file: string, tokens: StoredTraktTokens): boolean {
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(tokens, null, 2), { mode: 0o600 });
    renameSync(tmp, file);
    return true;
  } catch (error) {
    console.error(`[trakt] could not save tokens to ${file}: ${(error as Error).message}`);
    return false;
  }
}
