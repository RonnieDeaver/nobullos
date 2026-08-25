// Task #4337 — first-touch UTM/referrer capture for the marketing site.
// Task #5106 — extended to preserve bounded first AND latest touch UTMs,
//              referrer, privacy-scrubbed landing URL, permitted ad click IDs,
//              and an opaque per-tab session ID (no PII).
//
// On every page init, if the URL carries utm_* parameters or the document
// referrer is external, and no record is stored yet, the touch is persisted
// to localStorage (write-once for first-touch; always-write for latest-touch).
// Form submissions attach the stored record so the lead's original source
// survives multi-page browsing and return visits.
//
// First-touch: write-once — the very first tagged/referred visit wins and
// subsequent visits do NOT overwrite it. A parameterless direct visit stores
// NOTHING (rather than "direct") so a later tagged/referred visit can still
// claim first touch — otherwise one stray direct hit would permanently mask
// the real campaign. The server degrades absent data to "direct" at lead-stamp
// time.
//
// Latest-touch: always-write — updated on every page view that carries signal.
// A parameterless direct visit also stores NOTHING for latest-touch so brief
// mid-funnel untagged browsing doesn't discard the real campaign.
//
// Session ID: a random key created once per browser session (sessionStorage).
//   Used to group page views within one visit. Contains no PII.
//
// No persistent cross-session device identifier is created here. Landing and
// referrer URLs are reduced to public origin/path plus approved campaign
// parameters so capability tokens, emails, or arbitrary query values are never
// copied into attribution storage or API requests.

const STORAGE_KEY = "nb_first_touch_v1";
const LATEST_TOUCH_KEY = "nb_latest_touch_v1";
const SESSION_ID_STORAGE_KEY = "nb_session_id_v1";

// Server-side caps (shared/models/campaigns.ts publicAttributionSchema) —
// truncated here too so a legitimate visitor can never trip the endpoint's
// validation.
const UTM_MAX = 200;
const REFERRER_MAX = 1000;
const URL_MAX = 2000;
const CLICK_ID_MAX = 256;

export interface StoredAttribution {
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmTerm?: string;
  utmContent?: string;
  referrer?: string;
  // Extended fields (Task #5106)
  landingUrl?: string;
  gclid?: string;
  gbraid?: string;
  wbraid?: string;
  fbclid?: string;
  sessionId?: string;
}

interface TouchRecord extends StoredAttribution {
  capturedAt?: string; // ISO timestamp of when the touch was stored
}

const UTM_PARAMS: ReadonlyArray<
  readonly [param: string, key: keyof StoredAttribution]
> = [
  ["utm_source", "utmSource"],
  ["utm_medium", "utmMedium"],
  ["utm_campaign", "utmCampaign"],
  ["utm_term", "utmTerm"],
  ["utm_content", "utmContent"],
];

const CLICK_ID_PARAMS: ReadonlyArray<
  readonly [param: string, key: keyof StoredAttribution]
> = [
  ["gclid", "gclid"],
  ["gbraid", "gbraid"],
  ["wbraid", "wbraid"],
  ["fbclid", "fbclid"],
];

function clean(value: string | null | undefined, max: number): string | undefined {
  const v = (value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, max);
  return v || undefined;
}

function looksSensitive(value: string): boolean {
  const candidates = [value];
  try {
    const decoded = decodeURIComponent(value.replace(/\+/g, " "));
    if (decoded !== value) candidates.push(decoded);
  } catch {
    return true;
  }
  return candidates.some((candidate) => {
    if (/[^\s@]+@[^\s@]+\.[^\s@]+/.test(candidate)) return true;
    if (
      /\b(?:bearer|password|secret|access[_-]?token|api[_-]?key|private[_-]?key)\b/i.test(
        candidate,
      )
    ) {
      return true;
    }
    if (/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/.test(candidate)) {
      return true;
    }
    if (/(?:^|[^a-z0-9])(?:sk|rk)_(?:live|test)_[a-z0-9_-]{8,}/i.test(candidate)) {
      return true;
    }
    const digits = candidate.replace(/\D/g, "");
    return (
      /^\+?[\d(). -]+$/.test(candidate) &&
      digits.length >= 10 &&
      digits.length <= 19
    );
  });
}

function cleanCampaignValue(value: string | null | undefined): string | undefined {
  const cleaned = clean(value, UTM_MAX);
  if (!cleaned || looksSensitive(cleaned)) return undefined;
  try {
    const decoded = decodeURIComponent(cleaned.replace(/\+/g, " "));
    if (!/^[A-Za-z0-9][A-Za-z0-9._~+%:-]*$/.test(decoded)) return undefined;
  } catch {
    return undefined;
  }
  return /^[A-Za-z0-9][A-Za-z0-9._~+%:-]*$/.test(cleaned)
    ? cleaned
    : undefined;
}

function cleanClickId(value: string | null | undefined): string | undefined {
  const cleaned = clean(value, CLICK_ID_MAX);
  return cleaned &&
    !looksSensitive(cleaned) &&
    /^[A-Za-z0-9._~-]+$/.test(cleaned)
    ? cleaned
    : undefined;
}

function cleanSessionId(value: string | null | undefined): string | undefined {
  const cleaned = clean(value, 128);
  return cleaned &&
    cleaned.length >= 8 &&
    !looksSensitive(cleaned) &&
    /^[A-Za-z0-9._~-]+$/.test(cleaned)
    ? cleaned
    : undefined;
}

function publicUrl(raw: string, includeCampaignParams: boolean): string | undefined {
  try {
    const source = new URL(raw);
    if (source.protocol !== "https:" && source.protocol !== "http:") return undefined;
    if (source.username || source.password) return undefined;
    let pathname = source.pathname;
    try {
      const decodedPath = decodeURIComponent(pathname);
      if (
        looksSensitive(decodedPath) ||
        decodedPath.split("/").some((segment) => segment.length > 128)
      ) {
        pathname = "/";
      }
    } catch {
      pathname = "/";
    }
    const safe = new URL(pathname, source.origin);
    if (includeCampaignParams) {
      for (const [param] of [...UTM_PARAMS, ...CLICK_ID_PARAMS]) {
        const value = source.searchParams.get(param);
        const cleaned = CLICK_ID_PARAMS.some(([clickParam]) => clickParam === param)
          ? cleanClickId(value)
          : cleanCampaignValue(value);
        if (cleaned) safe.searchParams.set(param, cleaned);
      }
    }
    return safe.toString().slice(0, URL_MAX);
  } catch {
    return undefined;
  }
}

/** The referrer, only when it points at another site — in-site navigation
    must not count as "where they came from". */
function externalReferrer(): string | undefined {
  const raw = document.referrer;
  if (!raw) return undefined;
  try {
    const host = new URL(raw).hostname;
    if (!host || host === window.location.hostname) return undefined;
    return publicUrl(raw, false)?.slice(0, REFERRER_MAX);
  } catch {
    return undefined;
  }
}

/** Build a touch record from the current page URL and referrer. Returns null
    when there is no signal (bare direct visit with no params). */
function buildTouchRecord(): TouchRecord | null {
  const params = new URLSearchParams(window.location.search);
  const record: TouchRecord = {};

  for (const [param, key] of UTM_PARAMS) {
    const value = cleanCampaignValue(params.get(param));
    if (value) record[key] = value;
  }

  for (const [param, key] of CLICK_ID_PARAMS) {
    const value = cleanClickId(params.get(param));
    if (value) record[key] = value;
  }

  const referrer = externalReferrer();
  if (referrer) record.referrer = referrer;

  if (Object.keys(record).length === 0) return null;

  // Include landing URL and timestamp when there IS signal.
  record.landingUrl = publicUrl(window.location.href, true);
  record.sessionId = getOrCreateSessionId();
  record.capturedAt = new Date().toISOString();

  return record;
}

/** Capture once per browser: write-only-if-absent (first touch wins). */
export function captureFirstTouchAttribution(): void {
  try {
    if (window.localStorage.getItem(STORAGE_KEY)) return;
    const record = buildTouchRecord();
    if (!record) return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(record));
  } catch {
    // Storage unavailable (private-mode restrictions etc.) — capture is
    // best-effort; the server degrades absent data to "direct".
  }
}

/** Capture latest-touch: always overwrite when there is signal. */
export function captureLatestTouchAttribution(): void {
  try {
    const record = buildTouchRecord();
    if (!record) return;
    window.localStorage.setItem(LATEST_TOUCH_KEY, JSON.stringify(record));
  } catch {
    // Best-effort.
  }
}

/** Capture both first and latest touch in a single call. */
export function captureAttribution(): void {
  captureFirstTouchAttribution();
  captureLatestTouchAttribution();
}

/** Ensure a session ID exists in sessionStorage and return it.
 *  The ID is a random opaque key with NO PII. */
export function getOrCreateSessionId(): string {
  try {
    const stored = window.sessionStorage.getItem(SESSION_ID_STORAGE_KEY);
    const validated = cleanSessionId(stored);
    if (validated) return validated;
    const id = _generateId();
    window.sessionStorage.setItem(SESSION_ID_STORAGE_KEY, id);
    return id;
  } catch {
    return _generateId();
  }
}

function _generateId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback for environments without randomUUID (old Safari, SSR tests).
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const bytes = crypto.getRandomValues(new Uint8Array(18));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

function parseRecord<T extends StoredAttribution>(raw: string, urlMax: number): T {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const out: StoredAttribution = {};
  for (const [, key] of UTM_PARAMS) {
    const value = parsed[key];
    if (typeof value === "string") {
      const v = cleanCampaignValue(value);
      if (v) out[key] = v;
    }
  }
  for (const [, key] of CLICK_ID_PARAMS) {
    const value = parsed[key];
    if (typeof value === "string") {
      const v = cleanClickId(value);
      if (v) out[key] = v;
    }
  }
  const sessionId = parsed.sessionId;
  if (typeof sessionId === "string") {
    const v = cleanSessionId(sessionId);
    if (v) out.sessionId = v;
  }
  const referrer = parsed.referrer;
  if (typeof referrer === "string") {
    const v = publicUrl(referrer, false)?.slice(0, REFERRER_MAX);
    if (v) out.referrer = v;
  }
  const landingUrl = parsed.landingUrl;
  if (typeof landingUrl === "string") {
    const v = publicUrl(landingUrl, true)?.slice(0, urlMax);
    if (v) out.landingUrl = v;
  }
  return out as T;
}

/** Stored first-touch record (empty object when none). */
export function getStoredAttribution(): StoredAttribution {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return parseRecord<StoredAttribution>(raw, URL_MAX);
  } catch {
    return {};
  }
}

/** Stored latest-touch record (empty object when none). */
export function getLatestTouchAttribution(): StoredAttribution {
  try {
    const raw = window.localStorage.getItem(LATEST_TOUCH_KEY);
    if (!raw) return {};
    return parseRecord<StoredAttribution>(raw, URL_MAX);
  } catch {
    return {};
  }
}

/** Stored session ID, or undefined when none exists yet. */
export function getStoredSessionId(): string | undefined {
  try {
    return cleanSessionId(window.sessionStorage.getItem(SESSION_ID_STORAGE_KEY));
  } catch {
    return undefined;
  }
}
