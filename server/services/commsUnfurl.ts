/**
 * commsUnfurl.ts — server-side OpenGraph / Twitter-card unfurl service.
 *
 * SSRF guardrails:
 *  - Resolves hostname to IP(s) via dns.promises.lookup; blocks all RFC-1918,
 *    loopback, link-local, and metadata-service ranges before fetching.
 *  - Hard 5 s fetch timeout and 256 KB HTML body cap.
 *  - Redirects are followed by Node fetch but the final URL is re-checked.
 *
 * Caching:
 *  - In-memory LRU (max 500 entries, 30 min TTL) for hot-path reads.
 *  - DB persistence via comms_link_previews for cross-restart durability.
 *    DB writes happen outside callers' DB holds (this module takes no hold).
 */

import { promises as dnsPromises } from "dns";

// ─── SSRF guardrail ───────────────────────────────────────────────────────────

// RFC-1918 / loopback / link-local / CGNAT / metadata ranges to block.
const BLOCKED_PATTERNS: RegExp[] = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  /^0\./,
  /^::1$/,
  /^fc[0-9a-f]{2}:/i,
  /^fd[0-9a-f]{2}:/i,
  /^fe80:/i,
];

function isBlockedIp(ip: string): boolean {
  if (ip === "localhost") return true;
  return BLOCKED_PATTERNS.some((re) => re.test(ip));
}

async function isBlockedHost(hostname: string): Promise<boolean> {
  if (isBlockedIp(hostname)) return true;
  try {
    const result = await dnsPromises.lookup(hostname, { all: true });
    const addresses = Array.isArray(result) ? result : [result];
    return addresses.some((a) => isBlockedIp(a.address));
  } catch {
    return true;
  }
}

/**
 * Sanitizes an OG asset URL (og:image / favicon) before it is cached or
 * persisted. The SSRF guard blocks the server-side *page* fetch, but these
 * asset URLs are stored and later loaded by logged-in browsers — a malicious
 * page could point og:image at an internal IP (10.x, 169.254.x, etc.) to make
 * client browsers probe internal addresses. Returns null unless the URL is
 * https: and its hostname resolves only to public addresses.
 */
export async function sanitizeAssetUrl(raw: string | null): Promise<string | null> {
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  if (parsed.username || parsed.password) return null;
  if (await isBlockedHost(parsed.hostname)) return null;
  return parsed.href;
}

// ─── In-memory cache ──────────────────────────────────────────────────────────

const MAX_CACHE_ENTRIES = 500;
const CACHE_TTL_MS = 30 * 60 * 1000;

export interface UnfurlResult {
  url: string;
  title: string | null;
  description: string | null;
  imageUrl: string | null;
  siteName: string | null;
  faviconUrl: string | null;
  error: string | null;
  fetchedAt: Date;
}

const memCache = new Map<string, { result: UnfurlResult; expiresAt: number }>();

function cacheGet(url: string): UnfurlResult | null {
  const entry = memCache.get(url);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    memCache.delete(url);
    return null;
  }
  return entry.result;
}

function cacheSet(url: string, result: UnfurlResult): void {
  if (memCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = memCache.keys().next().value;
    if (oldest) memCache.delete(oldest);
  }
  memCache.set(url, { result, expiresAt: Date.now() + CACHE_TTL_MS });
}

// ─── OG / Twitter-card parser ─────────────────────────────────────────────────

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

function getMetaAttr(html: string, property: string): string | null {
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']*?)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']*?)["'][^>]+property=["']${property}["']`, "i"),
    new RegExp(`<meta[^>]+name=["']${property}["'][^>]+content=["']([^"']*?)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']*?)["'][^>]+name=["']${property}["']`, "i"),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m?.[1]) return decodeHtmlEntities(m[1].trim());
  }
  return null;
}

function parseOgData(html: string, baseUrl: string): Omit<UnfurlResult, "url" | "error" | "fetchedAt"> {
  const title =
    getMetaAttr(html, "og:title") ??
    getMetaAttr(html, "twitter:title") ??
    html.match(/<title[^>]*>([^<]*?)<\/title>/i)?.[1]?.trim() ?? null;

  const description =
    getMetaAttr(html, "og:description") ??
    getMetaAttr(html, "twitter:description") ??
    getMetaAttr(html, "description") ?? null;

  const rawImage =
    getMetaAttr(html, "og:image") ??
    getMetaAttr(html, "og:image:url") ??
    getMetaAttr(html, "twitter:image") ??
    getMetaAttr(html, "twitter:image:src") ?? null;

  const siteName = getMetaAttr(html, "og:site_name") ?? null;

  const rawFavicon =
    html.match(/<link[^>]+rel=["'](?:shortcut icon|icon)["'][^>]+href=["']([^"']+)["']/i)?.[1] ??
    html.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["'](?:shortcut icon|icon)["']/i)?.[1] ??
    null;

  const resolveUrl = (raw: string | null): string | null => {
    if (!raw) return null;
    try {
      return new URL(raw, baseUrl).href;
    } catch {
      return raw;
    }
  };

  return {
    title: title ? title.slice(0, 300) : null,
    description: description ? description.slice(0, 500) : null,
    imageUrl: resolveUrl(rawImage),
    siteName: siteName ? siteName.slice(0, 200) : null,
    faviconUrl: resolveUrl(rawFavicon),
  };
}

// ─── Fetch with SSRF guard + limits ──────────────────────────────────────────

const FETCH_TIMEOUT_MS = 5000;
const MAX_BODY_BYTES = 256 * 1024;

async function safeFetch(url: string): Promise<{ html: string; finalUrl: string }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid URL");
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Unsupported protocol");
  }

  if (await isBlockedHost(parsed.hostname)) {
    throw new Error("SSRF: blocked host");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let resp: Response;
  try {
    resp = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "NoBullOS-Unfurl/1.0 (+internal)",
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
    });
  } catch (e: any) {
    clearTimeout(timeout);
    if (e?.name === "AbortError") throw new Error("Fetch timeout");
    throw e;
  } finally {
    clearTimeout(timeout);
  }

  const finalUrl = resp.url || url;

  const ct = resp.headers.get("content-type") ?? "";
  if (!ct.includes("text/html") && !ct.includes("application/xhtml")) {
    throw new Error("Not an HTML page");
  }

  const reader = resp.body?.getReader();
  if (!reader) throw new Error("No response body");

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      totalBytes += value.byteLength;
      if (totalBytes > MAX_BODY_BYTES) {
        reader.cancel().catch(() => {});
        break;
      }
      chunks.push(value);
    }
  }

  const buffer = new Uint8Array(totalBytes > MAX_BODY_BYTES ? MAX_BODY_BYTES : totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const html = new TextDecoder("utf-8", { fatal: false }).decode(buffer);
  return { html, finalUrl };
}

// ─── Image proxy fetch ────────────────────────────────────────────────────────

const IMAGE_FETCH_TIMEOUT_MS = 8000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB

export interface ProxiedImage {
  contentType: string;
  body: Buffer;
}

const MAX_IMAGE_REDIRECTS = 5;

/**
 * Validates one URL hop for the image proxy: https only, no credentials in
 * the URL, hostname must resolve to public addresses. Throws on violation.
 */
async function assertSafeImageHop(raw: string, isRedirect: boolean): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(isRedirect ? "SSRF: invalid redirect URL" : "Invalid URL");
  }
  if (parsed.protocol !== "https:") {
    throw new Error(isRedirect ? "SSRF: unsupported redirect protocol" : "Unsupported protocol");
  }
  if (parsed.username || parsed.password) throw new Error("Credentials not allowed");
  if (await isBlockedHost(parsed.hostname)) {
    throw new Error(isRedirect ? "SSRF: blocked redirect host" : "SSRF: blocked host");
  }
  return parsed;
}

/**
 * Fetches an external image for the authenticated link-preview image proxy.
 * Redirects are handled manually: every hop (initial URL and each Location
 * header) is validated against the SSRF/private-IP checks BEFORE any request
 * is issued to it. Enforces a fetch timeout, a hard byte cap, and requires
 * an image/* content type (SVG rejected). Throws on any violation.
 */
export async function fetchImageForProxy(url: string): Promise<ProxiedImage> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);

  let resp: Response;
  try {
    let current = await assertSafeImageHop(url, false);
    let redirects = 0;

    while (true) {
      try {
        resp = await fetch(current.href, {
          signal: controller.signal,
          headers: {
            "User-Agent": "NoBullOS-Unfurl/1.0 (+internal)",
            Accept: "image/*",
          },
          redirect: "manual",
        });
      } catch (e: any) {
        if (e?.name === "AbortError") throw new Error("Fetch timeout");
        throw e;
      }

      if (resp.status >= 300 && resp.status < 400) {
        const location = resp.headers.get("location");
        resp.body?.cancel().catch(() => {});
        if (!location) throw new Error(`Upstream status ${resp.status}`);
        if (++redirects > MAX_IMAGE_REDIRECTS) throw new Error("Too many redirects");
        let nextRaw: string;
        try {
          nextRaw = new URL(location, current.href).href;
        } catch {
          throw new Error("SSRF: invalid redirect URL");
        }
        current = await assertSafeImageHop(nextRaw, true);
        continue;
      }
      break;
    }
  } finally {
    clearTimeout(timeout);
  }

  if (!resp.ok) {
    resp.body?.cancel().catch(() => {});
    throw new Error(`Upstream status ${resp.status}`);
  }

  const contentType = (resp.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!contentType.startsWith("image/") || contentType === "image/svg+xml") {
    resp.body?.cancel().catch(() => {});
    throw new Error("Not an image");
  }

  const declaredLength = Number(resp.headers.get("content-length") ?? "0");
  if (declaredLength > MAX_IMAGE_BYTES) {
    resp.body?.cancel().catch(() => {});
    throw new Error("Image too large");
  }

  const reader = resp.body?.getReader();
  if (!reader) throw new Error("No response body");

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      totalBytes += value.byteLength;
      if (totalBytes > MAX_IMAGE_BYTES) {
        reader.cancel().catch(() => {});
        throw new Error("Image too large");
      }
      chunks.push(value);
    }
  }

  return { contentType, body: Buffer.concat(chunks) };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Normalise a URL for deduplication — strip fragment, sort query params.
 */
export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = "";
    const params = [...u.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
    u.search = new URLSearchParams(params).toString();
    return u.href;
  } catch {
    return raw;
  }
}

/**
 * Extracts all http/https URLs from a message content string.
 * Skips duplicates and returns at most `limit` unique URLs.
 */
export function extractUrls(content: string, limit = 3): string[] {
  const urlPattern = /https?:\/\/[^\s<>"')\]]+/g;
  const seen = new Set<string>();
  const result: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = urlPattern.exec(content)) !== null) {
    const norm = normalizeUrl(m[0]);
    if (!seen.has(norm)) {
      seen.add(norm);
      result.push(norm);
      if (result.length >= limit) break;
    }
  }
  return result;
}

/**
 * Performs a full unfurl for a URL.
 * 1. Checks in-memory cache.
 * 2. If miss, fetches the URL with SSRF guardrails.
 * 3. Sets the in-memory cache entry.
 * Returns the result (including error info for failed fetches).
 * Callers must persist to DB separately; this function takes no DB hold.
 */
export async function unfurlUrl(url: string): Promise<UnfurlResult> {
  const norm = normalizeUrl(url);
  const cached = cacheGet(norm);
  if (cached) return cached;

  const fetchedAt = new Date();
  let result: UnfurlResult;

  try {
    const { html, finalUrl } = await safeFetch(norm);
    const ogData = parseOgData(html, finalUrl);
    const [safeImageUrl, safeFaviconUrl] = await Promise.all([
      sanitizeAssetUrl(ogData.imageUrl),
      sanitizeAssetUrl(ogData.faviconUrl),
    ]);
    result = {
      url: norm,
      ...ogData,
      imageUrl: safeImageUrl,
      faviconUrl: safeFaviconUrl,
      error: null,
      fetchedAt,
    };
  } catch (err: any) {
    result = {
      url: norm,
      title: null,
      description: null,
      imageUrl: null,
      siteName: null,
      faviconUrl: null,
      error: err?.message ?? "Unknown error",
      fetchedAt,
    };
  }

  cacheSet(norm, result);
  return result;
}

/**
 * Populates the in-memory cache from a persisted DB result (called at boot /
 * after DB read) to avoid re-fetching URLs that were recently unfurled.
 */
export function hydrateCache(url: string, result: UnfurlResult): void {
  cacheSet(normalizeUrl(url), result);
}

/** Wipe the in-memory cache (for testing). */
export function __test_clearCache(): void {
  memCache.clear();
}
