import { Readable } from "stream";
import { storage } from "../storage";
import {
  ObjectNotFoundError,
  ObjectStorageService,
  objectStorageClient,
} from "../replit_integrations/object_storage";
import {
  auditedDelete,
  auditedDownload,
  auditedGetFiles,
} from "../replit_integrations/object_storage/audit";

const PANDADOC_API_BASE = "https://api.pandadoc.com/public/v1";
const SETTINGS_KEY_API_KEY = "pandadoc_api_key";

// In-process "last good" API key. Task #2101 (follows the Task #2099
// Stripe fix): the key is read from `system_settings` through a
// read-through Redis cache that falls back to a DB query. Under
// production DB-pool saturation that read can THROW (timeout / dropped
// connection). A read that *couldn't complete* must never be mistaken
// for "the operator removed the key" — that mis-resolution is what
// flapped integration cards to "Not Connected" while a valid credential
// sat in the DB. We only overwrite this on a *definitive* read (a real
// value, or a confirmed-empty/absent row); a thrown read falls back to
// the last value we positively saw in this process.
let cachedApiKey: string | null = null;

// Discriminated lookup result so callers can tell "confirmed no key"
// apart from "couldn't determine". Only `empty` may surface as
// `no_api_key`; `unknown` must never downgrade the badge.
type PandadocKeyResolution =
  | { status: "found"; key: string }
  | { status: "empty" }
  | { status: "unknown"; error: string };

async function resolvePandadocApiKey(): Promise<PandadocKeyResolution> {
  try {
    const setting = await storage.getSystemSetting(SETTINGS_KEY_API_KEY);
    const value = setting?.value?.trim() || "";
    if (value) {
      cachedApiKey = value;
      return { status: "found", key: value };
    }
    // The lookup definitively succeeded and the row is absent/blank —
    // a real disconnect, so drop any stale last-good too.
    cachedApiKey = null;
    return { status: "empty" };
  } catch (err: any) {
    // The settings read couldn't complete (DB timeout / dropped conn).
    // Prefer the last value we positively saw in this process; never
    // downgrade to "no key" off a failed read.
    if (cachedApiKey) return { status: "found", key: cachedApiKey };
    return { status: "unknown", error: err?.message ?? "settings_read_failed" };
  }
}

// Test seam (Task #2101): clear the in-process last-good so a test can
// exercise the "no last-good + read throws" path deterministically.
// Production code never calls this.
export function __resetPandadocKeyCacheForTest(): void {
  cachedApiKey = null;
}

async function getApiKey(): Promise<string> {
  const resolution = await resolvePandadocApiKey();
  if (resolution.status === "found") return resolution.key;
  if (resolution.status === "unknown") {
    throw new Error(`PandaDoc credential lookup failed: ${resolution.error}`);
  }
  throw new Error("PandaDoc not connected. Please add your API key via Settings → Integrations.");
}

const PANDADOC_MAX_429_RETRIES = 5;

async function pandadocApiRequest(path: string, method = "GET", attempt = 0): Promise<any> {
  const apiKey = await getApiKey();
  const res = await fetch(`${PANDADOC_API_BASE}${path}`, {
    method,
    headers: {
      "Authorization": `API-Key ${apiKey}`,
      "Accept": "application/json",
    },
  });

  if (res.status === 429) {
    // Audit Track B (Task #1572): cap recursion. Prior code recursed
    // indefinitely on persistent 429, risking stack exhaustion and
    // hung workers when PandaDoc's daily quota was exhausted.
    if (attempt >= PANDADOC_MAX_429_RETRIES) {
      throw new Error(`PandaDoc rate-limited after ${PANDADOC_MAX_429_RETRIES} retries`);
    }
    const retryAfter = Number(res.headers.get("Retry-After") || 5);
    console.log(`[PandaDoc] Rate limited (attempt ${attempt + 1}/${PANDADOC_MAX_429_RETRIES}), retrying in ${retryAfter}s`);
    await new Promise(r => setTimeout(r, retryAfter * 1000));
    return pandadocApiRequest(path, method, attempt + 1);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PandaDoc API error: ${res.status} ${text}`);
  }

  return res.json();
}

export async function isConnected(): Promise<boolean> {
  return (await resolvePandadocApiKey()).status === "found";
}

// Task #1888 — outcome-aware probe contract (matches Slack/Front).
export type PandadocProbeOutcome = "connected" | "unauthorized" | "probe_failed";
export interface PandadocProbeResult {
  outcome: PandadocProbeOutcome;
  status?: number;
  reason?: string;
}

export async function probeConnection(): Promise<PandadocProbeResult> {
  const resolution = await resolvePandadocApiKey();
  if (resolution.status === "unknown") {
    // The key lookup itself couldn't complete (degraded DB). This is NOT
    // evidence the key is missing — surface it as a transient probe
    // failure so the route preserves the last known badge instead of
    // flipping the card to "Not Connected". (Task #2101)
    return {
      outcome: "probe_failed",
      reason: `key_lookup_failed: ${resolution.error}`.slice(0, 120),
    };
  }
  if (resolution.status === "empty") return { outcome: "unauthorized", reason: "no_api_key" };
  const apiKey = resolution.key;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(`${PANDADOC_API_BASE}/documents?count=1`, {
      method: "GET",
      headers: {
        "Authorization": `API-Key ${apiKey}`,
        "Accept": "application/json",
      },
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) {
      return { outcome: "unauthorized", status: res.status, reason: `http_${res.status}` };
    }
    if (res.status === 429 || res.status >= 500) {
      return { outcome: "probe_failed", status: res.status, reason: `http_${res.status}` };
    }
    if (!res.ok) {
      return { outcome: "probe_failed", status: res.status, reason: `http_${res.status}` };
    }
    return { outcome: "connected", status: res.status };
  } catch (err: any) {
    const aborted = err?.name === "AbortError";
    return {
      outcome: "probe_failed",
      reason: aborted ? "network_timeout" : `network_error: ${(err?.message ?? "unknown").slice(0, 120)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

export const PANDADOC_API_KEY_SETTING_KEY = SETTINGS_KEY_API_KEY;

// Task #1977 — mirror the Slack transient-vs-terminal split. Only a
// confirmed terminal PandaDoc auth rejection (HTTP 401 / 403) earns a
// credential wipe in the connect handler; transient probe failures
// (429, 5xx, timeouts, network errors) preserve the saved key.
export function isTerminalPandadocAuthReason(reason: string | null | undefined): boolean {
  return reason === "http_401" || reason === "http_403";
}

export type PandadocKeyClearTrigger =
  | "manual_disconnect"
  | "connect_terminal_auth_error";

// Persist the API key without an up-front blocking validation. The
// connect handler probes afterwards (Slack pattern) so a transient
// PandaDoc outage can't reject an otherwise-valid key.
export async function setApiKey(apiKey: string, updatedBy?: string): Promise<void> {
  await storage.setSystemSetting(SETTINGS_KEY_API_KEY, apiKey, updatedBy ?? "system");
  try {
    await storage.recordAdminSettingChange({
      settingKey: SETTINGS_KEY_API_KEY,
      scope: "connect",
      changedBy: updatedBy && updatedBy !== "system" ? updatedBy : null,
      oldValues: null,
      newValues: { event: "connect" },
    });
  } catch (err: any) {
    console.error("[PandaDoc] connect audit insert failed:", err?.message);
  }
}

export async function connect(apiKey: string, updatedBy?: string): Promise<{ ok: boolean }> {
  const testRes = await fetch(`${PANDADOC_API_BASE}/documents?count=1`, {
    headers: {
      "Authorization": `API-Key ${apiKey}`,
      "Accept": "application/json",
    },
  });

  if (!testRes.ok) {
    const text = await testRes.text();
    throw new Error(`Invalid API key or connection failed: ${testRes.status} ${text}`);
  }

  await storage.setSystemSetting(SETTINGS_KEY_API_KEY, apiKey, updatedBy ?? "system");
  return { ok: true };
}

export async function disconnect(
  updatedBy?: string,
  options?: { trigger?: PandadocKeyClearTrigger; reason?: string | null; notes?: string | null },
): Promise<void> {
  const trigger: PandadocKeyClearTrigger = options?.trigger ?? "manual_disconnect";
  await storage.setSystemSetting(SETTINGS_KEY_API_KEY, "", updatedBy ?? "system");
  // Task #1977 — every credential clear leaves a scoped audit breadcrumb
  // so admins can tell a manual disconnect apart from the connect
  // handler's terminal-auth self-wipe.
  try {
    await storage.recordAdminSettingChange({
      settingKey: SETTINGS_KEY_API_KEY,
      scope: trigger,
      changedBy: updatedBy && updatedBy !== "system" ? updatedBy : null,
      oldValues: null,
      newValues: {
        event: "disconnect",
        trigger,
        reason: options?.reason ?? null,
        notes: options?.notes ?? null,
      },
    });
  } catch (err: any) {
    console.error("[PandaDoc] disconnect audit insert failed:", err?.message);
  }
}

export async function listDocuments(options?: { q?: string; status?: string; count?: number; page?: number }): Promise<any> {
  const params = new URLSearchParams();
  if (options?.q) params.set("q", options.q);
  if (options?.status) params.set("status", options.status);
  params.set("count", String(options?.count || 50));
  params.set("page", String(options?.page || 1));

  const data = await pandadocApiRequest(`/documents?${params.toString()}`);
  return data;
}

export async function getDocumentDetails(documentId: string): Promise<any> {
  return pandadocApiRequest(`/documents/${documentId}/details`);
}

const PANDADOC_APP_BASE = "https://app.pandadoc.com";

export function buildDocumentAppUrl(documentId: string): string {
  return `${PANDADOC_APP_BASE}/a/#/documents/${encodeURIComponent(documentId)}`;
}

export class PandadocDocumentNotReadyError extends Error {
  constructor(message = "PandaDoc is still preparing this document, try again in a moment.") {
    super(message);
    this.name = "PandadocDocumentNotReadyError";
  }
}

const PANDADOC_PDF_MAX_NOT_READY_RETRIES = 4;
const PANDADOC_PDF_NOT_READY_DELAY_MS = 1500;

const PANDADOC_PDF_CACHE_PREFIX = "pandadoc-pdf-cache";

function sanitizeCacheSegment(value: string): string {
  return encodeURIComponent(value).replace(/[^A-Za-z0-9._%-]/g, "_");
}

function cacheKeyFor(documentId: string, lastSyncedAt: Date | string | null | undefined): string | null {
  if (!documentId) return null;
  const ts = lastSyncedAt ? new Date(lastSyncedAt).getTime() : NaN;
  if (!Number.isFinite(ts)) return null;
  return `${PANDADOC_PDF_CACHE_PREFIX}/${sanitizeCacheSegment(documentId)}/${ts}.pdf`;
}

function cachePrefixFor(documentId: string): string | null {
  if (!documentId) return null;
  return `${PANDADOC_PDF_CACHE_PREFIX}/${sanitizeCacheSegment(documentId)}/`;
}

// Resolves the private-object-dir base path (bucket + prefix) without
// throwing on a missing env var — caching is best-effort and must not
// break the underlying PDF download when object storage is unconfigured.
function getPrivateBase(): { bucketName: string; basePrefix: string } | null {
  const dir = process.env.PRIVATE_OBJECT_DIR || "";
  if (!dir) return null;
  const trimmed = dir.endsWith("/") ? dir.slice(0, -1) : dir;
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const parts = withSlash.split("/").filter(Boolean);
  if (parts.length < 1) return null;
  const bucketName = parts[0];
  const basePrefix = parts.slice(1).join("/");
  return { bucketName, basePrefix };
}

function fullObjectName(basePrefix: string, key: string): string {
  return basePrefix ? `${basePrefix}/${key}` : key;
}

async function readCachedPdf(objectKey: string): Promise<Buffer | null> {
  try {
    const svc = new ObjectStorageService();
    const file = await svc.getPrivateObjectFileByKey(objectKey);
    const [buf] = await auditedDownload(file);
    return buf;
  } catch (err: any) {
    if (err instanceof ObjectNotFoundError) return null;
    console.warn(`[PandaDoc] PDF cache read failed for ${objectKey}: ${err?.message || err}`);
    return null;
  }
}

async function writeCachedPdf(objectKey: string, buffer: Buffer): Promise<void> {
  try {
    const svc = new ObjectStorageService();
    const body = Readable.from(buffer);
    await svc.streamUploadToPrivateKey(objectKey, body, "application/pdf");
  } catch (err: any) {
    console.warn(`[PandaDoc] PDF cache write failed for ${objectKey}: ${err?.message || err}`);
  }
}

// Best-effort deletion of every cached PDF for a documentId. Used when
// the document is unlinked from a client so a stale copy can't leak via
// the cache. Failures are logged but never thrown — cache invalidation
// is non-authoritative.
export async function invalidatePdfCache(documentId: string): Promise<void> {
  const prefix = cachePrefixFor(documentId);
  if (!prefix) return;
  const base = getPrivateBase();
  if (!base) return;
  try {
    const fullPrefix = fullObjectName(base.basePrefix, prefix);
    const [files] = await auditedGetFiles(
      objectStorageClient.bucket(base.bucketName),
      { prefix: fullPrefix },
    );
    await Promise.all(files.map((f) => auditedDelete(f, { ignoreNotFound: true }).catch((err: any) => {
      console.warn(`[PandaDoc] Failed to delete cached PDF ${f.name}: ${err?.message || err}`);
    })));
  } catch (err: any) {
    console.warn(`[PandaDoc] PDF cache invalidation failed for ${documentId}: ${err?.message || err}`);
  }
}

export async function getDocumentPdfCached(
  documentId: string,
  lastSyncedAt: Date | string | null | undefined,
): Promise<{ buffer: Buffer; contentType: string; cached: boolean }> {
  const key = cacheKeyFor(documentId, lastSyncedAt);
  if (key) {
    const cached = await readCachedPdf(key);
    if (cached) {
      return { buffer: cached, contentType: "application/pdf", cached: true };
    }
  }

  const fresh = await getDocumentPdf(documentId);
  if (key) {
    await writeCachedPdf(key, fresh.buffer);
  }
  return { ...fresh, cached: false };
}

export async function getDocumentPdf(documentId: string): Promise<{ buffer: Buffer; contentType: string }> {
  const apiKey = await getApiKey();
  let lastBodyText = "";

  for (let attempt = 0; attempt <= PANDADOC_PDF_MAX_NOT_READY_RETRIES; attempt++) {
    const res = await fetch(`${PANDADOC_API_BASE}/documents/${encodeURIComponent(documentId)}/download`, {
      headers: {
        "Authorization": `API-Key ${apiKey}`,
        "Accept": "application/pdf",
      },
    });

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("Retry-After") || 5);
      console.log(`[PandaDoc] PDF download rate limited, retrying in ${retryAfter}s`);
      await new Promise(r => setTimeout(r, retryAfter * 1000));
      continue;
    }

    const contentType = res.headers.get("Content-Type") || "";
    if (res.ok && contentType.toLowerCase().includes("pdf")) {
      const arrayBuf = await res.arrayBuffer();
      return { buffer: Buffer.from(arrayBuf), contentType: "application/pdf" };
    }

    const bodyText = await res.text();
    lastBodyText = bodyText;

    const notReady =
      res.status === 202 ||
      (res.status >= 400 && /document.*(not\s+generated|still\s+generat|not\s+ready|in\s+progress|processing)/i.test(bodyText));
    if (notReady && attempt < PANDADOC_PDF_MAX_NOT_READY_RETRIES) {
      console.log(`[PandaDoc] Document ${documentId} not ready (status ${res.status}), retrying ${attempt + 1}/${PANDADOC_PDF_MAX_NOT_READY_RETRIES}`);
      await new Promise(r => setTimeout(r, PANDADOC_PDF_NOT_READY_DELAY_MS));
      continue;
    }

    if (notReady) {
      throw new PandadocDocumentNotReadyError();
    }

    if (res.status === 404) {
      throw new Error("Document not found in PandaDoc");
    }

    throw new Error(`PandaDoc PDF download error: ${res.status} ${bodyText}`);
  }

  throw new PandadocDocumentNotReadyError(
    lastBodyText
      ? "PandaDoc is still preparing this document, try again in a moment."
      : "PandaDoc is still preparing this document, try again in a moment.",
  );
}

export async function getDocumentContent(documentId: string): Promise<string> {
  const apiKey = await getApiKey();

  try {
    const res = await fetch(`${PANDADOC_API_BASE}/documents/${documentId}/content`, {
      headers: {
        "Authorization": `API-Key ${apiKey}`,
        "Accept": "application/json",
      },
    });

    if (!res.ok) {
      const errorBody = await res.text();
      console.warn(`[PandaDoc] Content endpoint returned ${res.status} for document ${documentId}: ${errorBody}`);
      if (res.status === 404 || res.status === 403) {
        console.log(`[PandaDoc] Falling back to /details endpoint for document ${documentId}`);
        return await getDocumentContentFromDetails(documentId);
      }
      throw new Error(`PandaDoc content fetch error: ${res.status} ${errorBody}`);
    }

    const contentData = await res.json();
    console.log(`[PandaDoc] Raw /content response keys for ${documentId}: ${JSON.stringify(Object.keys(contentData || {}))}`);

    const extracted = extractTextFromContent(contentData);
    if (!extracted) {
      console.warn(`[PandaDoc] extractTextFromContent returned empty for document ${documentId}, trying /details fallback`);
      return await getDocumentContentFromDetails(documentId);
    }

    return extracted;
  } catch (err: any) {
    console.warn(`[PandaDoc] Content fetch failed for ${documentId}: ${err.message}, trying /details fallback`);
    return await getDocumentContentFromDetails(documentId);
  }
}

async function getDocumentContentFromDetails(documentId: string): Promise<string> {
  try {
    const details = await getDocumentDetails(documentId);
    console.log(`[PandaDoc] Raw /details response keys for ${documentId}: ${JSON.stringify(Object.keys(details || {}))}`);
    return extractTextFromDetails(details);
  } catch (err: any) {
    console.warn(`[PandaDoc] Details fallback also failed for document ${documentId}: ${err.message}`);
    return "";
  }
}

function extractTextFromDetails(details: any): string {
  if (!details) return "";
  const parts: string[] = [];

  if (details.name) {
    parts.push(`# ${details.name}`);
  }

  if (details.tokens && Array.isArray(details.tokens)) {
    for (const token of details.tokens) {
      const name = token.name || token.label || "";
      const value = token.value ?? "";
      if (name && value) {
        parts.push(`${name}: ${value}`);
      }
    }
  }

  if (details.fields && Array.isArray(details.fields)) {
    for (const field of details.fields) {
      const name = field.name || field.title || field.label || field.api_id || "";
      const value = field.value ?? field.default_value ?? "";
      if (name && String(value)) {
        parts.push(`${name}: ${value}`);
      }
    }
  } else if (details.fields && typeof details.fields === "object") {
    for (const [key, val] of Object.entries(details.fields)) {
      if (val && typeof val === "object" && (val as any).value != null) {
        parts.push(`${key}: ${(val as any).value}`);
      } else if (val && typeof val === "string") {
        parts.push(`${key}: ${val}`);
      }
    }
  }

  if (details.pricing && Array.isArray(details.pricing.tables)) {
    for (const table of details.pricing.tables) {
      if (table.name) parts.push(`\n## ${table.name}`);
      if (Array.isArray(table.items)) {
        for (const item of table.items) {
          const desc = item.name || item.description || "";
          const price = item.price ?? "";
          const qty = item.qty ?? item.quantity ?? "";
          if (desc) {
            const line = [desc, qty ? `Qty: ${qty}` : "", price ? `Price: ${price}` : ""].filter(Boolean).join(" | ");
            parts.push(line);
          }
        }
      }
    }
  }

  if (details.metadata && typeof details.metadata === "object") {
    for (const [key, val] of Object.entries(details.metadata)) {
      if (val) parts.push(`${key}: ${val}`);
    }
  }

  const text = parts.filter(Boolean).join("\n\n");
  if (!text) {
    console.warn(`[PandaDoc] extractTextFromDetails returned empty for document ${details?.id || "unknown"}`);
  }
  return text;
}

function extractTextFromContent(contentData: any): string {
  if (typeof contentData === "string") return contentData;
  if (!contentData) return "";

  const parts: string[] = [];

  if (Array.isArray(contentData)) {
    for (const item of contentData) {
      extractFromNode(item, parts);
    }
  } else if (typeof contentData === "object") {
    if (contentData.results && Array.isArray(contentData.results)) {
      for (const item of contentData.results) {
        extractFromNode(item, parts);
      }
    }

    if (contentData.sections && Array.isArray(contentData.sections)) {
      for (const section of contentData.sections) {
        if (section.title) parts.push(`## ${section.title}`);
        if (section.content) parts.push(extractTextFromContent(section.content));
        if (section.text) parts.push(section.text);
        if (section.children) parts.push(extractTextFromContent(section.children));
      }
    }

    if (contentData.fields) {
      if (Array.isArray(contentData.fields)) {
        for (const field of contentData.fields) {
          const name = field.name || field.title || field.label || field.api_id || "";
          const value = field.value ?? field.default_value ?? "";
          if (name && String(value)) {
            parts.push(`${name}: ${value}`);
          }
        }
      } else if (typeof contentData.fields === "object") {
        for (const [key, val] of Object.entries(contentData.fields)) {
          if (val && typeof val === "object" && (val as any).value != null) {
            parts.push(`${key}: ${(val as any).value}`);
          } else if (val && typeof val === "string") {
            parts.push(`${key}: ${val}`);
          }
        }
      }
    }

    if (contentData.tokens && Array.isArray(contentData.tokens)) {
      for (const token of contentData.tokens) {
        const name = token.name || token.label || "";
        const value = token.value ?? "";
        if (name && value) {
          parts.push(`${name}: ${value}`);
        }
      }
    }

    if (contentData.items && Array.isArray(contentData.items)) {
      for (const item of contentData.items) {
        extractFromNode(item, parts);
      }
    }

    if (contentData.pages && Array.isArray(contentData.pages)) {
      for (const page of contentData.pages) {
        if (page.content) parts.push(extractTextFromContent(page.content));
        if (page.blocks) {
          for (const block of page.blocks) {
            extractFromNode(block, parts);
          }
        }
      }
    }

    if (contentData.text) parts.push(contentData.text);
    if (contentData.value && typeof contentData.value === "string") parts.push(contentData.value);
    if (contentData.content && typeof contentData.content === "string") parts.push(contentData.content);
    if (contentData.content && typeof contentData.content !== "string") {
      parts.push(extractTextFromContent(contentData.content));
    }
  }

  return parts.filter(Boolean).join("\n\n");
}

function extractFromNode(node: any, parts: string[]): void {
  if (!node || typeof node !== "object") {
    if (typeof node === "string" && node.trim()) parts.push(node);
    return;
  }

  if (node.text) parts.push(node.text);
  if (node.value && typeof node.value === "string") parts.push(node.value);
  if (node.title) parts.push(`## ${node.title}`);
  if (node.name && node.value) parts.push(`${node.name}: ${node.value}`);
  if (node.content) {
    if (typeof node.content === "string") parts.push(node.content);
    else parts.push(extractTextFromContent(node.content));
  }
  if (node.children && Array.isArray(node.children)) {
    for (const child of node.children) {
      extractFromNode(child, parts);
    }
  }
  if (node.items && Array.isArray(node.items)) {
    for (const subItem of node.items) {
      extractFromNode(subItem, parts);
    }
  }
  if (node.blocks && Array.isArray(node.blocks)) {
    for (const block of node.blocks) {
      extractFromNode(block, parts);
    }
  }
}

export interface SyncResult {
  total: number;
  created: number;
  updated: number;
  errors: string[];
}

async function listDocumentsWithRetry(options: { count: number; page: number }): Promise<any> {
  try {
    return await listDocuments(options);
  } catch (err: any) {
    console.warn(`[PandaDoc] listDocuments failed for page ${options.page}, retrying in 2s: ${err.message}`);
    await new Promise(r => setTimeout(r, 2000));
    return await listDocuments(options);
  }
}

export async function syncDocuments(): Promise<SyncResult> {
  const result: SyncResult = { total: 0, created: 0, updated: 0, errors: [] };

  let page = 1;
  const maxPages = 10;

  while (page <= maxPages) {
    let data: any;
    try {
      data = await listDocumentsWithRetry({ count: 50, page });
    } catch (err: any) {
      const msg = `Failed to fetch document list page ${page}: ${err.message}`;
      console.error(`[PandaDoc] ${msg}`);
      result.errors.push(msg);
      break;
    }

    const docs = data.results || [];
    result.total += docs.length;

    for (const doc of docs) {
      try {
        let contentText = "";
        try {
          contentText = await getDocumentContent(doc.id);
        } catch (contentErr: any) {
          console.warn(`[PandaDoc] Could not fetch content for ${doc.id}: ${contentErr.message}`);
        }

        const recipients = doc.recipients || [];
        const existing = await storage.getPandadocDocumentByDocumentId(doc.id);

        const docData = {
          documentId: doc.id,
          title: doc.name || "Untitled",
          status: doc.status || "unknown",
          createdDate: doc.date_created ? new Date(doc.date_created) : null,
          completedDate: doc.date_completed ? new Date(doc.date_completed) : null,
          expirationDate: doc.expiration_date ? new Date(doc.expiration_date) : null,
          recipientsJson: recipients,
          contentText: contentText || existing?.contentText || null,
          linkedClientId: existing?.linkedClientId || null,
          lastSyncedAt: new Date(),
        };

        let docRowId: string;
        let oldStatus: string | null = null;
        let statusChanged: boolean;
        if (existing) {
          await storage.updatePandadocDocument(existing.id, docData);
          result.updated++;
          docRowId = existing.id;
          oldStatus = existing.status;
          statusChanged = existing.status !== docData.status;
        } else {
          const createdRow = await storage.createPandadocDocument(docData);
          result.created++;
          docRowId = createdRow.id;
          statusChanged = true; // first observation counts as a transition
        }

        // Task #4332 — native PandaDoc deal trigger. This poll loop is the
        // ONLY status writer, so a compare-on-write here observes every
        // transition; replay-safe via pandadoc_status:<documentId>:<status>
        // (re-observations of the same status dedupe at the event key).
        // Best-effort: a trigger failure must never fail the sync.
        if (statusChanged) {
          try {
            const { emitPandadocStatusTrigger } = await import("./dealTriggers");
            await emitPandadocStatusTrigger({
              docRowId,
              documentId: docData.documentId,
              title: docData.title,
              oldStatus,
              newStatus: docData.status,
              linkedDealId: existing?.linkedDealId ?? null,
              linkedClientId: docData.linkedClientId ?? null,
            });
          } catch (triggerErr: any) {
            console.warn(
              `[PandaDoc] deal-trigger emit failed for ${doc.id}: ${triggerErr?.message ?? triggerErr}`,
            );
          }
        }
      } catch (err: any) {
        result.errors.push(`${doc.id}: ${err.message}`);
      }
    }

    if (docs.length < 50) break;
    page++;
  }

  return result;
}
