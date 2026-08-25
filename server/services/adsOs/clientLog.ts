/**
 * Ads OS — client log ("Optimizations & Ideas") reader + AI summary for the
 * client profile. Port of backend/app/client_log.py.
 *
 * Each client's log is a private Google Sheet (URL on the ClickUp Client List
 * task's "Client Log" field). The sheet must be shared view-only with the
 * app's Google service account (the same one the Drive integration uses); we
 * read the named tab via the Sheets API, then summarize the recent entries
 * with OpenAI. Summaries are cached in the store per sheet for ~a day; the
 * profile's Regenerate button forces a refresh.
 *
 * Strictly read-only against Google Sheets. Degrades gracefully at every step
 * — each failure maps to a distinct `state` the UI renders as plain English,
 * and a refresh failure never clobbers a previously good summary (returned
 * marked stale instead).
 */

import { CHEAP_MODEL, reasoningEffortFor } from "../../aiModels";
import { getSheetsAccessToken } from "../googleDriveIntegration";
import {
  CLIENT_LOG_SUMMARY_TTL_SECONDS,
  CLIENT_LOG_TAB,
  CLIENT_LOG_WINDOW_DAYS,
  getOpenAiKey,
  getOpenAiBaseUrl,
  isOpenAiConfigured,
} from "./config";
import { getClientLogSummary as loadStoredSummary, putClientLogSummary } from "./store";
import { createOpenAiClient } from "../ai/openAiClient";
const MAX_LINES = 120; // non-empty rows handed to the model (both ends kept)
const MAX_CELL = 300; // per-cell char cap
const MAX_CELLS = 20; // per-row cell cap
const MAX_CHARS = 60_000; // total budget for the rows block
const OMITTED = "[… middle rows omitted …]";
const MAX_ENTRIES = 10; // summary bullets shown on the profile

export type ClientLogState =
  | "ok"
  | "no_log"
  | "no_credentials"
  | "no_access"
  | "api_disabled"
  | "not_found"
  | "tab_missing"
  | "empty"
  | "no_recent"
  | "no_openai"
  | "fetch_failed"
  | "summarize_failed";

export interface ClientLogEntry {
  date: string;
  text: string;
}

/** API payload (snake_case, matches the source app + the profile UI). */
export interface ClientLogSummary {
  state: ClientLogState;
  entries?: ClientLogEntry[];
  row_count?: number;
  window_days?: number;
  generated_at?: string;
  log_url?: string | null;
  stale?: boolean;
  refresh_error?: string;
}

export function sheetIdFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = url.match(/\/spreadsheets\/d\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

class LogFetchError extends Error {
  state: ClientLogState;
  constructor(state: ClientLogState, message = "") {
    super(message || state);
    this.state = state;
  }
}

// ─── Date parsing (formats seen in the team's logs) ─────────────────────────

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

function mkDate(y: number, mo: number, d: number): Date | null {
  if (mo < 0 || mo > 11 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, mo, d));
  return date.getUTCMonth() === mo && date.getUTCDate() === d ? date : null;
}

function fullYear(yy: number): number {
  return yy < 100 ? 2000 + yy : yy;
}

/**
 * Parse a date from one cell, tolerating surrounding whitespace and a trailing
 * period. Formats: 29.Mar.26 / 29.Mar.2026 / 29 Mar 26 / 29 Mar 2026 /
 * Mar 29, 2026 / Mar 29 2026 / 2026-03-29 / 3/29/2026 / 3/29/26, plus the
 * yearless forms (Mar 29 / 29 Mar / 29.Mar / 3/29) which assume the current
 * year (rolled back one year if that would land more than a month in the
 * future).
 */
export function cellDate(text: string, now: Date = new Date()): Date | null {
  const token = text.trim().replace(/\.$/, "").trim();
  if (!token || token.length > 24) return null;

  let m: RegExpMatchArray | null;
  // ISO 2026-03-29
  if ((m = token.match(/^(\d{4})-(\d{2})-(\d{2})$/))) {
    return mkDate(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }
  // US slashes 3/29/2026 or 3/29/26
  if ((m = token.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/))) {
    return mkDate(fullYear(Number(m[3])), Number(m[1]) - 1, Number(m[2]));
  }
  // 29.Mar.26 / 29.Mar.2026 / 29 Mar 26 / 29 Mar 2026
  if ((m = token.match(/^(\d{1,2})[. ]([A-Za-z]{3,})[. ](\d{2}|\d{4})$/))) {
    const mo = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (mo === undefined) return null;
    return mkDate(fullYear(Number(m[3])), mo, Number(m[1]));
  }
  // Mar 29, 2026 / Mar 29 2026
  if ((m = token.match(/^([A-Za-z]{3,}) (\d{1,2}),? (\d{4})$/))) {
    const mo = MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (mo === undefined) return null;
    return mkDate(Number(m[3]), mo, Number(m[2]));
  }

  // Yearless forms — assume current year, roll back if far-future.
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const yearless = (mo: number, d: number): Date | null => {
    const cand = mkDate(today.getUTCFullYear(), mo, d);
    if (!cand) return null;
    const monthAhead = new Date(today.getTime() + 31 * 86400_000);
    return cand.getTime() > monthAhead.getTime()
      ? mkDate(today.getUTCFullYear() - 1, mo, d)
      : cand;
  };
  // Mar 29 / 29 Mar / 29.Mar
  if ((m = token.match(/^([A-Za-z]{3,}) (\d{1,2})$/))) {
    const mo = MONTHS[m[1].slice(0, 3).toLowerCase()];
    return mo === undefined ? null : yearless(mo, Number(m[2]));
  }
  if ((m = token.match(/^(\d{1,2})[. ]([A-Za-z]{3,})$/))) {
    const mo = MONTHS[m[2].slice(0, 3).toLowerCase()];
    return mo === undefined ? null : yearless(mo, Number(m[1]));
  }
  // 3/29
  if ((m = token.match(/^(\d{1,2})\/(\d{1,2})$/))) {
    return yearless(Number(m[1]) - 1, Number(m[2]));
  }
  return null;
}

/** The row's entry date — the first parseable date anywhere in the row. */
function rowDate(cells: string[], now: Date): Date | null {
  for (const cell of cells) {
    const d = cellDate(cell, now);
    if (d) return d;
  }
  return null;
}

// ─── Sheet fetch ─────────────────────────────────────────────────────────────

// Transient Sheets failures (5xx / network blips) get a couple of quick
// retries before we surface fetch_failed; deterministic errors (403/404/400)
// never retry. Delays are short — this runs inline on a profile page load.
const FETCH_RETRY_DELAYS_MS = process.env.NODE_ENV === "test" ? [1, 1] : [500, 1500];

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function fetchLogRows(sheetId: string): Promise<string[][]> {
  let token: string;
  try {
    token = await getSheetsAccessToken();
  } catch (err: any) {
    console.warn(`[AdsOsV2] client log: no Google credentials: ${err?.message ?? err}`);
    throw new LogFetchError("no_credentials");
  }

  const rng = encodeURIComponent(`'${CLIENT_LOG_TAB}'`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${rng}?majorDimension=ROWS`;

  for (let attempt = 0; ; attempt++) {
    const retriesLeft = attempt < FETCH_RETRY_DELAYS_MS.length;
    let res: Response;
    try {
      res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    } catch (err: any) {
      console.warn(
        `[AdsOsV2] client log: sheets fetch failed (attempt ${attempt + 1}): ${err?.message ?? err}`,
      );
      if (retriesLeft) {
        await sleep(FETCH_RETRY_DELAYS_MS[attempt]);
        continue;
      }
      throw new LogFetchError("fetch_failed");
    }
    if (!res.ok) {
      let detail = "";
      try {
        detail = ((await res.json()) as any)?.error?.message ?? "";
      } catch {
        // ignore
      }
      console.warn(
        `[AdsOsV2] client log: sheets fetch HTTP ${res.status} (attempt ${attempt + 1}) ${detail.slice(0, 200)}`,
      );
      if (res.status === 403) {
        // Same status for "API not enabled" and "sheet not shared with the
        // service account" — tell them apart for an actionable message.
        const state: ClientLogState =
          detail.includes("has not been used") || detail.includes("is disabled")
            ? "api_disabled"
            : "no_access";
        throw new LogFetchError(state, detail);
      }
      if (res.status === 404) throw new LogFetchError("not_found", detail);
      if (res.status === 400) throw new LogFetchError("tab_missing", detail); // no such tab
      // 5xx / 429 — transient; retry with a short backoff.
      if (retriesLeft) {
        await sleep(FETCH_RETRY_DELAYS_MS[attempt]);
        continue;
      }
      throw new LogFetchError("fetch_failed", detail);
    }
    const payload = (await res.json()) as any;
    return (payload?.values ?? []) as string[][];
  }
}

// ─── Row shaping ─────────────────────────────────────────────────────────────

function rowLine(row: string[]): string {
  const cells = row.slice(0, MAX_CELLS).map((c) => String(c).trim().slice(0, MAX_CELL));
  return cells.filter(Boolean).join(" | ");
}

/**
 * Bound a line list in rows and total characters. When over a cap we keep
 * BOTH ends and drop the middle (a log may be newest-at-top or newest-at-
 * bottom, so trimming one end could silently cut the newest entries).
 */
export function capLines(lines: string[]): string[] {
  const twoEnded = (items: string[], keep: number): string[] => {
    if (items.length <= keep) return items;
    const half = Math.max(Math.floor(keep / 2), 1);
    return [...items.slice(0, half), OMITTED, ...items.slice(items.length - half)];
  };
  let out = twoEnded(lines, MAX_LINES);
  while (out.length > 3 && out.reduce((a, l) => a + l.length + 1, 0) > MAX_CHARS) {
    out = twoEnded(out.filter((l) => l !== OMITTED), out.length - 3);
  }
  return out;
}

/**
 * (lines dated within the trailing window, whether ANY row carried a
 * parseable date). An undated row directly after an in-window dated row is
 * kept too (wrapped/multi-line entries continue below their dated first row).
 */
export function recentLines(rows: string[][], windowDays: number): { lines: string[]; datedAny: boolean } {
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const cutoff = new Date(today.getTime() - windowDays * 86400_000);
  const tomorrow = new Date(today.getTime() + 86400_000);
  const lines: string[] = [];
  let datedAny = false;
  let keeping = false;
  for (const row of rows) {
    const cells = row.slice(0, MAX_CELLS).map((c) => String(c).trim());
    const d = rowDate(cells, now);
    if (d) {
      datedAny = true;
      keeping = d.getTime() >= cutoff.getTime() && d.getTime() <= tomorrow.getTime();
    }
    if (keeping) {
      const line = rowLine(row);
      if (line) lines.push(line);
    }
  }
  return { lines, datedAny };
}

// ─── OpenAI summarization ────────────────────────────────────────────────────

function systemPrompt(windowDays: number): string {
  const today = new Date().toISOString().slice(0, 10);
  const cutoff = new Date(Date.now() - windowDays * 86400_000).toISOString().slice(0, 10);
  return (
    "You summarize a marketing agency's internal client log for a per-client overview " +
    "page read by the ads team. The log records changes and optimizations made to the " +
    "client's Google Ads and Local Services Ads accounts, plus occasional ideas.\n" +
    `TODAY'S DATE IS ${today}. Include ONLY entries dated within the last ` +
    `${windowDays} days (on or after ${cutoff}); exclude anything older, ` +
    "and return an empty list if no entry qualifies.\n" +
    `From the raw sheet rows, extract up to ${MAX_ENTRIES} of the most significant ` +
    "qualifying entries, newest first. The sheet may list entries newest-first or " +
    `oldest-first (and a '${OMITTED}' marker may appear where middle rows were ` +
    "trimmed) — use the entry dates, not row order, to determine recency. " +
    "Prefer completed changes over ideas; prefix a clearly not-yet-actioned idea with " +
    "'Idea:'. Skip header/template rows, blank boilerplate, and anything that isn't a " +
    "log entry. Keep each entry to one factual sentence; keep concrete numbers, " +
    "campaign names and keywords. Never invent entries.\n" +
    'Respond with JSON: {"entries": [{"date": "<the entry\'s date exactly as written ' +
    "in the log, or empty string>\", \"text\": \"<one plain factual sentence>\"}]}"
  );
}

async function summarize(clientName: string, lines: string[], windowDays: number): Promise<ClientLogEntry[]> {
  const openai = createOpenAiClient({
    apiKey: getOpenAiKey(),
    ...(getOpenAiBaseUrl() ? { baseURL: getOpenAiBaseUrl() } : {}),
  });
  const effort = reasoningEffortFor(CHEAP_MODEL);
  const completion = await openai.chat.completions.create({
    model: CHEAP_MODEL,
    ...(effort ? { reasoning_effort: effort } : {}),
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt(windowDays) },
      {
        role: "user",
        content:
          `CLIENT: ${clientName}\n` +
          "LOG ROWS (top-to-bottom as they appear in the sheet; one row per line, " +
          "cells joined with ' | '):\n" +
          lines.join("\n"),
      },
    ],
  } as any);
  const raw = completion.choices[0]?.message?.content ?? "{}";
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("client log summary: model returned unparseable JSON");
  }
  const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
  return entries
    .filter((e: any) => e && typeof e.text === "string" && e.text.trim())
    .slice(0, MAX_ENTRIES)
    .map((e: any) => ({ date: typeof e.date === "string" ? e.date : "", text: e.text.trim() }));
}

// ─── Public entry point ──────────────────────────────────────────────────────

function isFresh(iso: string | null | undefined): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  return Number.isFinite(t) && Date.now() - t < CLIENT_LOG_SUMMARY_TTL_SECONDS * 1000;
}

/**
 * The cached-or-fresh AI summary of one client's log. Covers the trailing
 * CLIENT_LOG_WINDOW_DAYS: rows are date-filtered before the model sees them,
 * and the prompt is anchored to today's date so the summary can't drift to old
 * entries. A failed refresh returns the last good summary with stale: true.
 */
export async function getLogSummary(
  clientName: string,
  logUrl: string | null | undefined,
  force = false,
): Promise<ClientLogSummary> {
  const sheetId = sheetIdFromUrl(logUrl);
  if (!sheetId) return { state: "no_log" };
  const windowDays = CLIENT_LOG_WINDOW_DAYS;

  const loadCached = async (): Promise<ClientLogSummary | null> => {
    try {
      const doc = await loadStoredSummary(sheetId);
      if (!doc || typeof doc.state !== "string") return null;
      return { ...(doc as ClientLogSummary), log_url: logUrl };
    } catch {
      return null;
    }
  };

  if (!force) {
    const cached = await loadCached();
    if (cached && cached.state === "ok" && isFresh(cached.generated_at)) return cached;
  }

  const lastGood = async (refreshError: string): Promise<ClientLogSummary | null> => {
    const cached = await loadCached();
    return cached && cached.state === "ok" ? { ...cached, stale: true, refresh_error: refreshError } : null;
  };

  let rows: string[][];
  try {
    rows = await fetchLogRows(sheetId);
  } catch (err: any) {
    const state: ClientLogState = err instanceof LogFetchError ? err.state : "fetch_failed";
    return (await lastGood(state)) ?? { state, log_url: logUrl };
  }

  const persist = async (out: ClientLogSummary): Promise<ClientLogSummary> => {
    // A definitive read (tab empty / nothing recent / fresh summary): persist
    // it, overwriting any previous record so a superseded summary can't
    // resurrect from the cache.
    try {
      const { log_url: _omit, stale: _s, refresh_error: _r, ...rest } = out;
      await putClientLogSummary(sheetId, rest);
    } catch (err: any) {
      console.warn(`[AdsOsV2] client log: summary persist failed: ${err?.message ?? err}`);
    }
    return out;
  };

  if (!rows.some((r) => rowLine(r))) {
    return persist({
      state: "empty",
      window_days: windowDays,
      generated_at: new Date().toISOString(),
      log_url: logUrl,
    });
  }

  // Date-filter to the trailing window. If nothing parses as a date the
  // format is unknown — fall back to the capped whole log and let the
  // (today-anchored) prompt do the filtering.
  const { lines: recent, datedAny } = recentLines(rows, windowDays);
  if (datedAny && recent.length === 0) {
    return persist({
      state: "no_recent",
      window_days: windowDays,
      generated_at: new Date().toISOString(),
      log_url: logUrl,
    });
  }
  let lines = datedAny ? recent : rows.map(rowLine).filter(Boolean);
  lines = capLines(lines);

  if (!isOpenAiConfigured()) return { state: "no_openai", log_url: logUrl };

  let entries: ClientLogEntry[];
  try {
    entries = await summarize(clientName, lines, windowDays);
  } catch (err: any) {
    console.warn(`[AdsOsV2] client log: summarize failed: ${err?.message ?? err}`);
    return (await lastGood("summarize_failed")) ?? { state: "summarize_failed", log_url: logUrl };
  }

  return persist({
    state: "ok",
    entries,
    row_count: lines.length,
    window_days: windowDays,
    generated_at: new Date().toISOString(),
    log_url: logUrl,
  });
}
