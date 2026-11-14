/**
 * Shared utility functions used across Plex and Trakt modules
 */

import { isIP } from "node:net";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

/**
 * Validate that a value is a numeric Plex ID (ratingKey, libraryKey, playlistId, etc.)
 * Prevents path traversal and injection when interpolated into API URLs.
 */
export function validatePlexId(value: string | undefined, paramName: string): string {
  if (!value || !/^\d+$/.test(value)) {
    throw new McpError(ErrorCode.InvalidRequest, `${paramName} must be a numeric Plex ID`);
  }
  return value;
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function chunkArray<T>(array: T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += chunkSize) {
    chunks.push(array.slice(i, i + chunkSize));
  }
  return chunks;
}

export function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.substring(0, maxLen) + "...";
}

/**
 * Sanitize search query: limit length and strip control characters
 * @param query Raw search query from user
 * @param maxLength Maximum allowed length (default 500)
 * @returns Sanitized query safe for API calls
 * @throws McpError if query is empty or invalid after sanitization
 */
export function sanitizeSearchQuery(query: string | undefined, maxLength: number = 500): string {
  if (!query || typeof query !== 'string') {
    throw new McpError(ErrorCode.InvalidRequest, 'query is required and must be a string');
  }

  // Strip control characters (0x00-0x1F, 0x7F) and newlines
  let sanitized = query.replace(/[\x00-\x1F\x7F\n\r\t]/g, ' ').trim();

  if (!sanitized) {
    throw new McpError(ErrorCode.InvalidRequest, 'query cannot be empty or contain only control characters');
  }

  // Limit length
  if (sanitized.length > maxLength) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `query exceeds maximum length of ${maxLength} characters (got ${sanitized.length})`
    );
  }

  return sanitized;
}

/**
 * Validate that a Plex API MediaContainer response has expected shape.
 * Throws McpError if validation fails.
 */
export function validatePlexMediaContainer(
  data: unknown,
  expectedFields?: string[]
): { MediaContainer?: { Metadata?: Record<string, unknown>[] } } {
  if (!data || typeof data !== 'object') {
    throw new McpError(ErrorCode.InternalError, 'Invalid Plex response: not an object');
  }

  const obj = data as Record<string, unknown>;
  const container = obj.MediaContainer;

  if (container && typeof container !== 'object') {
    throw new McpError(ErrorCode.InternalError, 'Invalid Plex response: MediaContainer is not an object');
  }

  if (container) {
    const mc = container as Record<string, unknown>;
    if (mc.Metadata && !Array.isArray(mc.Metadata)) {
      throw new McpError(ErrorCode.InternalError, 'Invalid Plex response: Metadata is not an array');
    }

    // Validate expected fields if provided
    if (expectedFields) {
      for (const field of expectedFields) {
        if (!(field in mc)) {
          throw new McpError(ErrorCode.InternalError, `Invalid Plex response: missing field ${field}`);
        }
      }
    }
  }

  return obj as { MediaContainer?: { Metadata?: Record<string, unknown>[] } };
}

/**
 * Validate that a Plex API response has expected totalSize field.
 */
export function validatePlexTotalSize(
  data: unknown
): { MediaContainer?: { Metadata?: Record<string, unknown>[]; totalSize?: number } } {
  const validated = validatePlexMediaContainer(data);
  const container = (validated.MediaContainer as Record<string, unknown> | undefined);

  if (container && container.totalSize !== undefined && typeof container.totalSize !== 'number') {
    throw new McpError(ErrorCode.InternalError, 'Invalid Plex response: totalSize is not a number');
  }

  return validated as { MediaContainer?: { Metadata?: Record<string, unknown>[]; totalSize?: number } };
}

/** True for an IPv4 address that is not on the public internet: unspecified,
 *  private, loopback, CGNAT, link-local, IETF/benchmark/documentation ranges,
 *  multicast and reserved. */
function isNonPublicIPv4(ip: string): boolean {
  const [a, b, c] = ip.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

/** The eight 16-bit groups of an IPv6 address (already validated by isIP). */
function ipv6Groups(ip: string): number[] {
  let text = ip.toLowerCase();
  // A trailing dotted IPv4 part (::ffff:1.2.3.4) becomes two hex groups.
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const [, a, b, c, d] = dotted.map(Number);
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.includes("::") ? text.split("::") : [text, undefined];
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const fill = tail === undefined ? [] : Array(8 - left.length - right.length).fill("0");
  return [...left, ...fill, ...right].map((g) => parseInt(g, 16));
}

function ipv4FromGroups(hi: number, lo: number): string {
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

function isNonPublicIPv6(ip: string): boolean {
  const g = ipv6Groups(ip);
  const zeros = (n: number) => g.slice(0, n).every((x) => x === 0);

  // ::/96 covers ::, ::1 and IPv4-compatible addresses; ::ffff:0:0/96 is
  // IPv4-mapped. URL parsing turns ::127.0.0.1 into ::7f00:1, so both forms
  // arrive here as groups.
  if (zeros(6) || (zeros(5) && g[5] === 0xffff)) return isNonPublicIPv4(ipv4FromGroups(g[6], g[7]));
  // NAT64 well-known prefix 64:ff9b::/96 reaches the embedded IPv4 address.
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    return isNonPublicIPv4(ipv4FromGroups(g[6], g[7]));
  }
  // 6to4 (2002::/16) embeds the IPv4 address in groups 1-2.
  if (g[0] === 0x2002) return isNonPublicIPv4(ipv4FromGroups(g[1], g[2]));

  return (
    (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) || // 64:ff9b:1::/48 local NAT64
    (g[0] === 0x100 && zeros(4)) || // 100::/64 discard
    (g[0] === 0x2001 && g[1] === 0) || // 2001::/32 Teredo
    (g[0] === 0x2001 && g[1] === 0xdb8) || // 2001:db8::/32 documentation
    (g[0] & 0xfe00) === 0xfc00 || // fc00::/7 unique local
    (g[0] & 0xffc0) === 0xfe80 || // fe80::/10 link-local
    (g[0] & 0xffc0) === 0xfec0 || // fec0::/10 site-local (deprecated)
    (g[0] & 0xff00) === 0xff00 // ff00::/8 multicast
  );
}

/** Name suffixes that only resolve inside a private network. */
const PRIVATE_NAME_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home", ".home.arpa", ".intranet", ".corp", ".private"];

/**
 * Why a poster URL is refused, or undefined when it is acceptable.
 *
 * Plex fetches the URL itself, from inside your network, so an unchecked URL
 * lets a tool call make the Plex server request internal addresses (routers,
 * admin panels, cloud metadata). Only http(s) to a public host is allowed.
 * Hostnames are not resolved, so a public name pointing at a private address
 * still gets through; this blocks the direct cases.
 */
export function posterUrlProblem(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "poster url is not a valid URL";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "poster url must use http or https";
  }
  if (url.username || url.password) {
    return "poster url must not contain credentials";
  }
  // Drop IPv6 brackets and any trailing dots: "localhost." is still localhost.
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.+$/, "").toLowerCase();
  const family = isIP(host);
  // A name with no dot ("router", "nas") resolves through the local search
  // domain, so it is as internal as the suffixes below.
  if (
    family === 0 &&
    (host === "localhost" || !host.includes(".") || PRIVATE_NAME_SUFFIXES.some((s) => host.endsWith(s)))
  ) {
    return "poster url must point at a public host";
  }
  if ((family === 4 && isNonPublicIPv4(host)) || (family === 6 && isNonPublicIPv6(host))) {
    return "poster url must point at a public address";
  }
  return undefined;
}
