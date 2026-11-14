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

/** True for an IPv4 address in a loopback, private, link-local, CGNAT or unspecified range. */
function isNonPublicIPv4(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

function isNonPublicIPv6(ip: string): boolean {
  const h = ip.toLowerCase();
  if (h === "::" || h === "::1") return true;
  // IPv4-mapped (::ffff:a.b.c.d). URL parsing rewrites the dotted part as
  // two hex groups, e.g. ::ffff:7f00:1 for 127.0.0.1, so accept both forms.
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
  if (dotted) return isNonPublicIPv4(dotted[1]);
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return isNonPublicIPv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || h.startsWith("ff");
}

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
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return "poster url must point at a public host";
  }
  const family = isIP(host);
  if ((family === 4 && isNonPublicIPv4(host)) || (family === 6 && isNonPublicIPv6(host))) {
    return "poster url must point at a public address";
  }
  return undefined;
}
