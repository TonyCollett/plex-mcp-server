/**
 * Shared Plex types used across both servers
 */

export interface PlexConfig {
  baseUrl: string;
  token: string;
  clientIdentifier?: string;
  /** Abort a Plex request after this many ms (default 30000). */
  requestTimeoutMs?: number;
  /** Log requests slower than this many ms to stderr (default 2000). */
  slowRequestMs?: number;
  /** Log every Plex request with its timing, not just slow or failed ones. */
  logAllRequests?: boolean;
}

export interface MCPResponse {
  [key: string]: unknown;
  content: Array<{ type: string; text: string }>;
}

export interface LibraryMovieRecord {
  ratingKey: string;
  title: string;
  year: number | undefined;
  viewCount: number;
  lastViewedAt: number | undefined;
  rating: number | undefined;
  genres: string[];
  directors: string[];
  actors: string[];
}

export interface TasteProfile {
  genreScores: Map<string, number>;
  directorCounts: Map<string, number>;
  actorCounts: Map<string, number>;
  weightedAvgRating: number;
  yearMean: number;
  yearStdDev: number;
}

