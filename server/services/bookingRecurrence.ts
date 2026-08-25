/**
 * Booking recurrence helpers (Task #1032A — Phase 1 of the recurring
 * meetings epic).
 *
 * Phase-1 scope: this module is the foundation that every later phase
 * (Google Calendar wrapper, Zoom translator, scheduler saga, API, UI)
 * builds on. It is NOT yet wired into any booking flow — saga work
 * lands in #1032D.
 *
 * Two responsibilities:
 *   1. `validateRecurrencePayload` — accept a raw RRULE/EXDATE/RDATE
 *      payload from the API/UI, reject anything that violates the
 *      epic-spec rules (invalid syntax, missing FREQ, missing/invalid
 *      timezone, COUNT+UNTIL conflict, EXDATE timezone mismatch, too
 *      many EXDATEs), and return a structured `NormalizedRecurrence`.
 *   2. `expandRecurrence` — given a normalized recurrence and a
 *      duration, expand it into a deterministic ordered list of
 *      occurrences honoring:
 *        - the IANA timezone of the rule (DST-safe via date-fns-tz)
 *        - the EXDATE list
 *        - the configured occurrence cap (default 100)
 *        - the configured horizon cap (default 24 months)
 *        - a 2-second wall-clock budget guard
 *
 * DST handling pattern: we feed rrule a *floating* DTSTART (a UTC
 * timestamp whose Y/M/D H/M happen to equal the desired local wall
 * clock), let rrule iterate the wall-clock instants, then convert
 * each result back through `fromZonedTime(localStr, tz)` so the
 * resulting absolute UTC instant respects DST in `tz`. This is the
 * recipe documented in the rrule README for tz-aware series.
 */

// `rrule` ships ESM that, under Node's CJS interop, only exposes the
// named exports through the default import. Pull them off the default
// to avoid `does not provide an export named 'RRule'` at runtime.
import rrulePkg from "rrule";
const { RRule, RRuleSet, rrulestr } = rrulePkg as unknown as {
  RRule: typeof import("rrule").RRule;
  RRuleSet: typeof import("rrule").RRuleSet;
  rrulestr: typeof import("rrule").rrulestr;
};
type RRule = InstanceType<typeof RRule>;
type RRuleSet = InstanceType<typeof RRuleSet>;
import { fromZonedTime, formatInTimeZone } from "date-fns-tz";
import {
  recurrencePayloadSchema,
  type RecurrencePayload,
  type NormalizedRecurrence,
  type RecurrenceErrorCode,
} from "@shared/schema";
import { PERF } from "../perfConfig";

export interface RecurrenceValidationOk {
  ok: true;
  normalized: NormalizedRecurrence;
}

export interface RecurrenceValidationErr {
  ok: false;
  code: RecurrenceErrorCode;
  message: string;
}

export type RecurrenceValidationResult =
  | RecurrenceValidationOk
  | RecurrenceValidationErr;

export interface ExpandedOccurrence {
  /** Absolute UTC start of this occurrence. */
  start: Date;
  /** Absolute UTC end (start + durationMinutes). */
  end: Date;
  /**
   * Same as `start` for the canonical occurrence — this is the
   * series-relative key the database uses to look up
   * `meeting_recurrence_exceptions`. Phase-1 expander doesn't apply
   * exception overrides yet, so `originalStartTime` always equals
   * `start`.
   */
  originalStartTime: Date;
}

export interface ExpansionWindow {
  /** Inclusive lower bound (UTC). Occurrences with start ≥ from are kept. */
  from: Date;
  /** Exclusive upper bound (UTC). Occurrences with start < to are kept. */
  to: Date;
}

export interface ExpandRecurrenceOptions extends ExpansionWindow {
  /**
   * Absolute UTC instant of the *first* occurrence — i.e. the
   * meeting's `startTimeUtc`. The expander combines this with the
   * normalized RRULE to derive every subsequent occurrence in the
   * recurrence timezone (DST-safe).
   */
  dtstart: Date;
  /** Duration of each occurrence in minutes. */
  durationMinutes: number;
  /** Override the default occurrence cap (testing). */
  maxOccurrences?: number;
  /** Override the default horizon (testing). */
  maxHorizonMonths?: number;
  /** Override the wall-clock budget in ms (testing). Default 2000ms. */
  budgetMs?: number;
  /** Override the clock for testing. */
  now?: Date;
}

export interface ExpandRecurrenceOk {
  ok: true;
  occurrences: ExpandedOccurrence[];
  /** True if the configured cap stopped iteration before the rule ended. */
  truncated: boolean;
}

export interface ExpandRecurrenceErr {
  ok: false;
  code: RecurrenceErrorCode;
  message: string;
}

export type ExpandRecurrenceResult = ExpandRecurrenceOk | ExpandRecurrenceErr;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Cheap IANA timezone validity check. `formatInTimeZone` throws a
 * `RangeError` ("Invalid time zone specified") when the tz isn't
 * known to the underlying `Intl.DateTimeFormat` impl, which is the
 * authoritative source on this Node runtime.
 */
function isValidTimezone(tz: string): boolean {
  try {
    formatInTimeZone(new Date(), tz, "yyyy");
    return true;
  } catch {
    return false;
  }
}

interface ParsedLines {
  rruleLine: string;
  exdateLines: string[];
  rdateLines: string[];
}

function classifyLines(lines: string[]): ParsedLines | null {
  let rruleLine: string | null = null;
  const exdateLines: string[] = [];
  const rdateLines: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const upper = line.toUpperCase();
    if (upper.startsWith("RRULE:") || upper.startsWith("RRULE;")) {
      if (rruleLine !== null) return null; // Only one RRULE supported.
      rruleLine = line;
    } else if (upper.startsWith("EXDATE")) {
      exdateLines.push(line);
    } else if (upper.startsWith("RDATE")) {
      rdateLines.push(line);
    } else {
      return null;
    }
  }
  if (!rruleLine) return null;
  return { rruleLine, exdateLines, rdateLines };
}

/**
 * Parse an EXDATE/RDATE line into its date list and (optional) TZID
 * parameter. Supports forms:
 *   EXDATE:20260301T090000Z
 *   EXDATE;TZID=America/Chicago:20260301T090000
 *   EXDATE;VALUE=DATE:20260301
 * Multiple comma-separated values per line are supported.
 */
function parseDateListLine(
  line: string,
): { tzid: string | null; values: string[]; isUtc: boolean } | null {
  const colonIdx = line.indexOf(":");
  if (colonIdx === -1) return null;
  const head = line.slice(0, colonIdx);
  const body = line.slice(colonIdx + 1);
  const params = head.split(";").slice(1);
  let tzid: string | null = null;
  for (const p of params) {
    const [k, v] = p.split("=");
    if (k && v && k.toUpperCase() === "TZID") tzid = v;
  }
  const values = body
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  if (!values.length) return null;
  const isUtc = values.every((v) => v.endsWith("Z"));
  return { tzid, values, isUtc };
}

/**
 * Convert one EXDATE/RDATE value to a UTC `Date` instant. If `tzid`
 * is provided, interpret the value as wall clock in that tz. If the
 * value ends in `Z`, interpret as UTC. Otherwise interpret as wall
 * clock in `defaultTz`.
 */
function dateValueToUtc(
  value: string,
  tzid: string | null,
  defaultTz: string,
): Date | null {
  // Date-only form (VALUE=DATE) — treat as midnight in the relevant tz.
  let yyyy: number, mm: number, dd: number;
  let hh = 0, mi = 0, ss = 0;
  let isUtcSuffix = false;
  if (/^\d{8}$/.test(value)) {
    yyyy = Number(value.slice(0, 4));
    mm = Number(value.slice(4, 6));
    dd = Number(value.slice(6, 8));
  } else if (/^\d{8}T\d{6}Z?$/.test(value)) {
    yyyy = Number(value.slice(0, 4));
    mm = Number(value.slice(4, 6));
    dd = Number(value.slice(6, 8));
    hh = Number(value.slice(9, 11));
    mi = Number(value.slice(11, 13));
    ss = Number(value.slice(13, 15));
    isUtcSuffix = value.endsWith("Z");
  } else {
    return null;
  }
  if (isUtcSuffix) {
    return new Date(Date.UTC(yyyy, mm - 1, dd, hh, mi, ss));
  }
  const tz = tzid || defaultTz;
  const localStr = `${pad4(yyyy)}-${pad2(mm)}-${pad2(dd)}T${pad2(hh)}:${
    pad2(mi)
  }:${pad2(ss)}`;
  try {
    return fromZonedTime(localStr, tz);
  } catch {
    return null;
  }
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}
function pad4(n: number): string {
  return String(n).padStart(4, "0");
}

/**
 * Format a floating-UTC date as the RFC 5545 DATE-TIME string used in
 * an RRULE DTSTART line, e.g. `20260106T090000Z`. We always emit the
 * `Z` suffix because the helper feeds rrule a *floating* UTC anchor —
 * the real timezone re-anchoring happens in `floatingToZoned`.
 */
function formatFloatingUtcForRrule(d: Date): string {
  return (
    `${pad4(d.getUTCFullYear())}${pad2(d.getUTCMonth() + 1)}${
      pad2(d.getUTCDate())
    }T${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${
      pad2(d.getUTCSeconds())
    }Z`
  );
}

/**
 * Build a "floating" Date for rrule input: a UTC timestamp whose
 * Y/M/D H/M components match the desired wall-clock time in `tz`.
 * Pairs with `floatingToZoned` to get DST-safe absolute UTC instants
 * back out.
 */
function zonedToFloating(realUtc: Date, tz: string): Date {
  const parts = formatInTimeZone(realUtc, tz, "yyyy-MM-dd'T'HH:mm:ss").split(
    /[-T:]/,
  );
  const [y, m, d, h, mi, s] = parts.map(Number);
  return new Date(Date.UTC(y, m - 1, d, h, mi, s));
}

function floatingToZoned(floating: Date, tz: string): Date {
  // Read components in UTC (rrule emits floating UTC), then re-anchor
  // them in `tz` via fromZonedTime so DST shifts are respected.
  const y = floating.getUTCFullYear();
  const m = floating.getUTCMonth() + 1;
  const d = floating.getUTCDate();
  const h = floating.getUTCHours();
  const mi = floating.getUTCMinutes();
  const s = floating.getUTCSeconds();
  const localStr = `${pad4(y)}-${pad2(m)}-${pad2(d)}T${pad2(h)}:${pad2(mi)}:${
    pad2(s)
  }`;
  return fromZonedTime(localStr, tz);
}

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

export function validateRecurrencePayload(
  raw: unknown,
): RecurrenceValidationResult {
  const parsed = recurrencePayloadSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      code: "recurrence_invalid_rrule",
      message: `Invalid recurrence payload: ${parsed.error.issues
        .map((i) => i.message)
        .join("; ")}`,
    };
  }
  const payload: RecurrencePayload = parsed.data;

  if (!isValidTimezone(payload.timezone)) {
    return {
      ok: false,
      code: "recurrence_invalid_timezone",
      message: `Unknown IANA timezone: "${payload.timezone}"`,
    };
  }

  const classified = classifyLines(payload.rrule);
  if (!classified) {
    return {
      ok: false,
      code: "recurrence_invalid_rrule",
      message:
        "Recurrence must contain exactly one RRULE line plus optional EXDATE/RDATE lines.",
    };
  }

  // Parse the RRULE itself via rrulestr to surface syntax errors and
  // verify FREQ is present.
  let rruleObj: RRule | RRuleSet;
  try {
    rruleObj = rrulestr(classified.rruleLine, { forceset: false });
  } catch (err: any) {
    return {
      ok: false,
      code: "recurrence_invalid_rrule",
      message: `Invalid RRULE: ${err?.message || String(err)}`,
    };
  }
  const ruleOptions = rruleObj instanceof RRule
    ? rruleObj.origOptions
    : (rruleObj as RRuleSet).rrules()[0]?.origOptions;
  if (!ruleOptions || ruleOptions.freq === undefined || ruleOptions.freq === null) {
    return {
      ok: false,
      code: "recurrence_invalid_rrule",
      message: "RRULE is missing required FREQ component.",
    };
  }
  if (ruleOptions.count != null && ruleOptions.until != null) {
    return {
      ok: false,
      code: "recurrence_count_until_conflict",
      message: "RRULE may set COUNT or UNTIL, not both.",
    };
  }

  // Parse EXDATEs and RDATEs.
  const exdates: Date[] = [];
  for (const line of classified.exdateLines) {
    const parsedLine = parseDateListLine(line);
    if (!parsedLine) {
      return {
        ok: false,
        code: "recurrence_invalid_rrule",
        message: `Invalid EXDATE line: "${line}"`,
      };
    }
    if (parsedLine.tzid && parsedLine.tzid !== payload.timezone) {
      return {
        ok: false,
        code: "recurrence_exdate_timezone_mismatch",
        message: `EXDATE TZID="${parsedLine.tzid}" does not match recurrence timezone "${payload.timezone}".`,
      };
    }
    for (const v of parsedLine.values) {
      const d = dateValueToUtc(v, parsedLine.tzid, payload.timezone);
      if (!d) {
        return {
          ok: false,
          code: "recurrence_invalid_rrule",
          message: `Invalid EXDATE value: "${v}"`,
        };
      }
      exdates.push(d);
    }
  }
  if (exdates.length > PERF.BOOKING_RECURRENCE_MAX_EXDATES) {
    return {
      ok: false,
      code: "recurrence_too_many_exdates",
      message: `Recurrence has ${exdates.length} EXDATEs (max ${PERF.BOOKING_RECURRENCE_MAX_EXDATES}).`,
    };
  }

  const rdates: Date[] = [];
  for (const line of classified.rdateLines) {
    const parsedLine = parseDateListLine(line);
    if (!parsedLine) {
      return {
        ok: false,
        code: "recurrence_invalid_rrule",
        message: `Invalid RDATE line: "${line}"`,
      };
    }
    if (parsedLine.tzid && parsedLine.tzid !== payload.timezone) {
      return {
        ok: false,
        code: "recurrence_exdate_timezone_mismatch",
        message: `RDATE TZID="${parsedLine.tzid}" does not match recurrence timezone "${payload.timezone}".`,
      };
    }
    for (const v of parsedLine.values) {
      const d = dateValueToUtc(v, parsedLine.tzid, payload.timezone);
      if (!d) {
        return {
          ok: false,
          code: "recurrence_invalid_rrule",
          message: `Invalid RDATE value: "${v}"`,
        };
      }
      rdates.push(d);
    }
  }

  return {
    ok: true,
    normalized: {
      lines: [classified.rruleLine, ...classified.exdateLines, ...classified.rdateLines],
      rruleLine: classified.rruleLine,
      exdates,
      rdates,
      timezone: payload.timezone,
      source: payload.source ?? "app",
      summary: payload.summary,
    },
  };
}

// ---------------------------------------------------------------------------
// Expander
// ---------------------------------------------------------------------------

/**
 * Expand a normalized recurrence into ordered, DST-safe occurrences
 * within `[from, to]`. Caller supplies the duration so this helper
 * doesn't need to know about meeting types.
 *
 * The expander cooperates with three caps:
 *   - `maxOccurrences` (default 100) — if the rule yields more, returns
 *      `{ ok: true, truncated: true }` with the first N.
 *   - `maxHorizonMonths` (default 24) — occurrences whose start exceeds
 *      `from + horizon` are dropped (and returns `recurrence_horizon_exceeded`
 *      if the rule has no natural end and would otherwise run forever).
 *   - `budgetMs` (default 2000) — wall-clock guard. If the iteration
 *      exceeds it, returns `recurrence_expansion_limit_exceeded`.
 *
 * Caller must supply a DTSTART within the rule (rrulestr accepts it
 * inline as `DTSTART;TZID=...:...\nRRULE:...`). If the input rule has
 * no DTSTART line, the caller is expected to prepend one — in Phase 1
 * the saga supplies it.
 */
export function expandRecurrence(
  normalized: NormalizedRecurrence,
  options: ExpandRecurrenceOptions,
): ExpandRecurrenceResult {
  const tz = normalized.timezone;
  const maxOcc = options.maxOccurrences ?? PERF.BOOKING_RECURRENCE_MAX_OCCURRENCES;
  const maxHorizonMonths = options.maxHorizonMonths
    ?? PERF.BOOKING_RECURRENCE_MAX_HORIZON_MONTHS;
  const budgetMs = options.budgetMs ?? 2000;
  const durationMs = Math.max(1, options.durationMinutes) * 60_000;

  // Enforce horizon as an absolute upper bound on the iteration window.
  const horizonEnd = new Date(options.from);
  horizonEnd.setUTCMonth(horizonEnd.getUTCMonth() + maxHorizonMonths);
  const effectiveTo = options.to.getTime() < horizonEnd.getTime()
    ? options.to
    : horizonEnd;

  // Build the RRuleSet by prepending a DTSTART derived from the
  // supplied first-occurrence instant, expressed in floating-UTC
  // coordinates (a UTC timestamp whose Y/M/D H/M components match the
  // wall-clock time in `tz`). This lets the rrule iterator emit
  // wall-clock instants that we re-anchor in `tz` afterward for DST
  // safety.
  const dtstartFloating = zonedToFloating(options.dtstart, tz);
  const dtstartLine = `DTSTART:${formatFloatingUtcForRrule(dtstartFloating)}`;
  const ruleText = `${dtstartLine}\n${normalized.rruleLine}`;
  let ruleObj: RRule | RRuleSet;
  try {
    ruleObj = rrulestr(ruleText, { forceset: true });
  } catch (err: any) {
    return {
      ok: false,
      code: "recurrence_invalid_rrule",
      message: `Could not parse RRULE for expansion: ${err?.message || err}`,
    };
  }
  const set = ruleObj instanceof RRuleSet
    ? ruleObj
    : (() => {
      const s = new RRuleSet();
      s.rrule(ruleObj);
      return s;
    })();

  const exdateUtcSet = new Set(normalized.exdates.map((d) => d.getTime()));
  const startedAt = Date.now();

  const floatingFrom = zonedToFloating(options.from, tz);
  const floatingTo = zonedToFloating(effectiveTo, tz);

  const ruleHasEnd =
    set.rrules().some((r) => r.options.count != null || r.options.until != null);

  const out: ExpandedOccurrence[] = [];
  let truncated = false;
  let aborted: ExpandRecurrenceErr | null = null;

  set.between(floatingFrom, floatingTo, true, (floating, idx) => {
    if (Date.now() - startedAt > budgetMs) {
      aborted = {
        ok: false,
        code: "recurrence_expansion_limit_exceeded",
        message:
          `Recurrence expansion exceeded ${budgetMs}ms budget after ${idx} occurrences.`,
      };
      return false;
    }
    const startUtc = floatingToZoned(floating, tz);
    if (exdateUtcSet.has(startUtc.getTime())) return true;
    if (startUtc.getTime() < options.from.getTime()) return true;
    if (startUtc.getTime() >= effectiveTo.getTime()) return false;
    if (out.length >= maxOcc) {
      truncated = true;
      return false;
    }
    out.push({
      start: startUtc,
      end: new Date(startUtc.getTime() + durationMs),
      originalStartTime: startUtc,
    });
    return true;
  });

  if (aborted) return aborted;

  // Fold in RDATEs (additional explicit occurrences) inside the window.
  for (const r of normalized.rdates) {
    if (
      r.getTime() >= options.from.getTime() &&
      r.getTime() < effectiveTo.getTime() &&
      !exdateUtcSet.has(r.getTime())
    ) {
      if (out.length >= maxOcc) {
        truncated = true;
        break;
      }
      out.push({ start: r, end: new Date(r.getTime() + durationMs), originalStartTime: r });
    }
  }

  // Deterministic ordering by start.
  out.sort((a, b) => a.start.getTime() - b.start.getTime());

  // If the rule has no natural end and we hit the horizon while
  // capping at maxOcc=false (i.e. truncated by horizon, not by cap),
  // surface the horizon-exceeded code so callers can prompt the user
  // to add a COUNT/UNTIL.
  if (!ruleHasEnd && !truncated && effectiveTo.getTime() < options.to.getTime()) {
    return {
      ok: false,
      code: "recurrence_horizon_exceeded",
      message:
        `Recurrence has no COUNT/UNTIL and would exceed the ${maxHorizonMonths}-month horizon.`,
    };
  }

  return { ok: true, occurrences: out, truncated };
}
