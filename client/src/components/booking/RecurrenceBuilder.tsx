import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  RRule,
  rrulestr,
  Frequency,
  Weekday,
  type Options as RRuleOptions,
} from "rrule";
import {
  type RecurrencePayload,
  type RecurrenceErrorCode,
  type RecurrencePreviewOccurrence,
  type RecurrenceConflict,
} from "@shared/models/booking";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  RadioGroup,
  RadioGroupItem,
} from "@/components/ui/radio-group";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import { X } from "lucide-react";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type RecurrenceBuilderVariant = "internal" | "public";
export type RecurrenceBuilderMode = "local" | "server";

export interface RecurrenceBuilderNormalized {
  /** Human readable summary, e.g. "Weekly on Tuesday until Dec 31, 2026". */
  summary: string;
  /** RRULE/EXDATE/RDATE lines, normalized. */
  lines: string[];
  /** Bounded local estimate of total occurrences (Infinity when "never"). */
  estimatedOccurrences: number;
}

export interface RecurrenceBuilderProps {
  value: RecurrencePayload | null;
  timezone: string;
  onChange: (
    payload: RecurrencePayload | null,
    normalized?: RecurrenceBuilderNormalized,
  ) => void;
  variant?: RecurrenceBuilderVariant;
  /** local = preview via rrule client-side only. server = additionally hit preview-availability. */
  mode?: RecurrenceBuilderMode;
  /** Used to anchor occurrences for the preview. Defaults to "now". */
  dtstart?: Date | null;
  /** Endpoint used in `mode="server"`. Required when mode=server. */
  serverPreviewUrl?: string;
  durationMinutes?: number;
  bufferBeforeMinutes?: number;
  bufferAfterMinutes?: number;
  /** Friendly limit for EXDATE entries; defaults to 50 (matches server cap). */
  exdateCap?: number;
  /** Hard cap on COUNT before we surface `recurrence_expansion_limit_exceeded`. */
  expansionCap?: number;
  className?: string;
}

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------

const DEFAULT_EXDATE_CAP = 50;
// Matches `BOOKING_RECURRENCE_MAX_OCCURRENCES` upper bound on the server.
const DEFAULT_EXPANSION_CAP = 1000;
const PREVIEW_LIMIT = 5;

const FREQ_OPTIONS: { value: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY"; label: string }[] = [
  { value: "DAILY", label: "Daily" },
  { value: "WEEKLY", label: "Weekly" },
  { value: "MONTHLY", label: "Monthly" },
  { value: "YEARLY", label: "Yearly" },
];

type WeekdayCode = "SU" | "MO" | "TU" | "WE" | "TH" | "FR" | "SA";

const WEEKDAYS: { code: WeekdayCode; short: string; long: string }[] = [
  { code: "SU", short: "S", long: "Sunday" },
  { code: "MO", short: "M", long: "Monday" },
  { code: "TU", short: "T", long: "Tuesday" },
  { code: "WE", short: "W", long: "Wednesday" },
  { code: "TH", short: "T", long: "Thursday" },
  { code: "FR", short: "F", long: "Friday" },
  { code: "SA", short: "S", long: "Saturday" },
];

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const POSITIONS: { value: 1 | 2 | 3 | 4 | -1; label: string }[] = [
  { value: 1, label: "First" },
  { value: 2, label: "Second" },
  { value: 3, label: "Third" },
  { value: 4, label: "Fourth" },
  { value: -1, label: "Last" },
];

const ERROR_COPY: Record<RecurrenceErrorCode, string> = {
  recurrence_invalid_rrule: "This recurrence pattern is invalid. Please check the settings.",
  recurrence_invalid_timezone: "The recurrence timezone is invalid.",
  recurrence_count_until_conflict:
    "Choose either an end date or a number of occurrences — not both.",
  recurrence_exdate_timezone_mismatch:
    "Skipped dates don't match the recurrence timezone.",
  recurrence_too_many_exdates: "Too many skipped dates. Please remove some.",
  recurrence_horizon_exceeded:
    "This recurrence extends too far into the future. Please add an end date.",
  recurrence_expansion_limit_exceeded:
    "This recurrence creates too many meetings. Please add an end date or reduce the number of occurrences.",
};

interface FormState {
  enabled: boolean;
  frequency: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
  interval: number;
  byDay: WeekdayCode[];
  monthlyMode: "day_of_month" | "by_position";
  monthDay: number;
  byPosition: 1 | 2 | 3 | 4 | -1;
  byPositionDay: WeekdayCode;
  yearlyMonth: number; // 1-12
  yearlyDay: number; // 1-31
  endsMode: "never" | "on_date" | "after_count";
  endsDate: string; // YYYY-MM-DD
  endsCount: number;
  wkst: "SU" | "MO";
  exdates: string[]; // "YYYY-MM-DDTHH:mm" local-to-tz strings
  preset: "weekly" | "biweekly" | "monthly" | "advanced" | null;
}

// Map our weekday codes to the rrule library's enum order (0 = MO).
const WEEKDAY_TO_RRULE: Record<WeekdayCode, Weekday> = {
  MO: RRule.MO,
  TU: RRule.TU,
  WE: RRule.WE,
  TH: RRule.TH,
  FR: RRule.FR,
  SA: RRule.SA,
  SU: RRule.SU,
};

const RRULE_INDEX_TO_CODE: Record<number, WeekdayCode> = {
  0: "MO",
  1: "TU",
  2: "WE",
  3: "TH",
  4: "FR",
  5: "SA",
  6: "SU",
};

const RRULE_FREQ: Record<FormState["frequency"], Frequency> = {
  DAILY: RRule.DAILY,
  WEEKLY: RRule.WEEKLY,
  MONTHLY: RRule.MONTHLY,
  YEARLY: RRule.YEARLY,
};

function defaultForm(dtstart: Date): FormState {
  // Use Sunday-first JS getUTCDay() to pick the matching code.
  const jsDay = dtstart.getUTCDay();
  const dow: WeekdayCode = (
    ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as WeekdayCode[]
  )[jsDay];
  return {
    enabled: false,
    frequency: "WEEKLY",
    interval: 1,
    byDay: [dow],
    monthlyMode: "day_of_month",
    monthDay: dtstart.getUTCDate(),
    byPosition: 1,
    byPositionDay: dow,
    yearlyMonth: dtstart.getUTCMonth() + 1,
    yearlyDay: dtstart.getUTCDate(),
    endsMode: "never",
    endsDate: "",
    endsCount: 10,
    wkst: "SU",
    exdates: [],
    preset: null,
  };
}

interface RRuleOptionsLike {
  options?: Partial<RRuleOptions>;
  origOptions?: Partial<RRuleOptions>;
}

interface BuildResult {
  payload: RecurrencePayload | null;
  normalized: RecurrenceBuilderNormalized | null;
  error: string | null;
  occurrences: Date[];
}

function buildPayload(
  form: FormState,
  timezone: string,
  dtstart: Date,
  expansionCap: number,
  exdateCap: number,
): BuildResult {
  if (!form.enabled) {
    return { payload: null, normalized: null, error: null, occurrences: [] };
  }
  if (form.exdates.length > exdateCap) {
    return {
      payload: null,
      normalized: null,
      error: ERROR_COPY.recurrence_too_many_exdates,
      occurrences: [],
    };
  }
  try {
    const opts: Partial<RRuleOptions> = {
      freq: RRULE_FREQ[form.frequency],
      interval: Math.max(1, form.interval | 0),
      wkst: form.wkst === "SU" ? RRule.SU : RRule.MO,
      dtstart,
    };

    if (form.frequency === "WEEKLY") {
      if (form.byDay.length === 0) {
        return {
          payload: null,
          normalized: null,
          error: "Pick at least one day of the week.",
          occurrences: [],
        };
      }
      opts.byweekday = form.byDay.map((d) => WEEKDAY_TO_RRULE[d]);
    } else if (form.frequency === "MONTHLY") {
      if (form.monthlyMode === "day_of_month") {
        opts.bymonthday = [form.monthDay];
      } else {
        const wd = WEEKDAY_TO_RRULE[form.byPositionDay];
        opts.byweekday = [wd.nth(form.byPosition)];
      }
    } else if (form.frequency === "YEARLY") {
      opts.bymonth = [form.yearlyMonth];
      opts.bymonthday = [form.yearlyDay];
    }

    if (form.endsMode === "after_count") {
      const count = Math.max(1, form.endsCount | 0);
      if (count > expansionCap) {
        return {
          payload: null,
          normalized: null,
          error: ERROR_COPY.recurrence_expansion_limit_exceeded,
          occurrences: [],
        };
      }
      opts.count = count;
    } else if (form.endsMode === "on_date") {
      if (!form.endsDate) {
        return {
          payload: null,
          normalized: null,
          error: "Pick an end date.",
          occurrences: [],
        };
      }
      const [y, m, d] = form.endsDate.split("-").map(Number);
      opts.until = new Date(Date.UTC(y, (m || 1) - 1, d || 1, 23, 59, 59));
    }

    const rule = new RRule(opts);
    const rruleString = rule.toString();
    // We only want the RRULE: line — DTSTART comes from the booking,
    // and EXDATEs are emitted separately as TZID-anchored lines.
    const lines: string[] = rruleString
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("RRULE:"));
    if (lines.length === 0) {
      return {
        payload: null,
        normalized: null,
        error: ERROR_COPY.recurrence_invalid_rrule,
        occurrences: [],
      };
    }

    // EXDATEs (TZID-anchored to the recurrence timezone).
    for (const exd of form.exdates) {
      const compact = exd.replace(/[-:]/g, "");
      // Pad to seconds when only minute precision was supplied.
      const padded = compact.length === 13 ? `${compact}00` : compact;
      lines.push(`EXDATE;TZID=${timezone}:${padded}`);
    }

    // Local preview: collect first PREVIEW_LIMIT occurrences, filtering
    // out anything that exactly matches an EXDATE the user added.
    const exdateUtcSet = new Set<number>();
    for (const exd of form.exdates) {
      const local = new Date(exd);
      if (!Number.isNaN(local.getTime())) {
        // local is interpreted in the browser's tz, which is best-effort
        // for the preview match. Only an exact ms match excludes.
        exdateUtcSet.add(local.getTime());
      }
    }

    const occurrences: Date[] = [];
    rule.all((occurrence, i) => {
      if (occurrences.length >= PREVIEW_LIMIT) return false;
      if (i > expansionCap) return false;
      if (!exdateUtcSet.has(occurrence.getTime())) {
        occurrences.push(occurrence);
      }
      return true;
    });

    const summary = humanReadable(form);
    const estimated =
      form.endsMode === "after_count"
        ? form.endsCount
        : form.endsMode === "on_date"
          ? estimateBoundedCount(form, expansionCap)
          : Number.POSITIVE_INFINITY;

    const payload: RecurrencePayload = {
      rrule: lines,
      timezone,
      source: "app",
      summary,
    };
    return {
      payload,
      normalized: { summary, lines, estimatedOccurrences: estimated },
      error: null,
      occurrences,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "";
    return {
      payload: null,
      normalized: null,
      error: msg
        ? `Could not build recurrence: ${msg}`
        : ERROR_COPY.recurrence_invalid_rrule,
      occurrences: [],
    };
  }
}

function estimateBoundedCount(form: FormState, cap: number): number {
  if (!form.endsDate) return 0;
  const end = new Date(form.endsDate).getTime();
  const days = Math.max(0, (end - Date.now()) / (24 * 60 * 60 * 1000));
  let raw = 0;
  switch (form.frequency) {
    case "DAILY":
      raw = Math.ceil(days / form.interval);
      break;
    case "WEEKLY":
      raw = Math.ceil(days / 7 / form.interval) * Math.max(1, form.byDay.length);
      break;
    case "MONTHLY":
      raw = Math.ceil(days / 30 / form.interval);
      break;
    case "YEARLY":
      raw = Math.ceil(days / 365 / form.interval);
      break;
  }
  return Math.min(cap + 1, raw);
}

function humanReadable(form: FormState): string {
  let base = "";
  const interval = form.interval;
  const intervalText = interval === 1 ? "" : ` ${interval}`;
  switch (form.frequency) {
    case "DAILY":
      base = interval === 1 ? "Daily" : `Every${intervalText} days`;
      break;
    case "WEEKLY": {
      const dayLabels = form.byDay
        .map((d) => WEEKDAYS.find((w) => w.code === d)?.long ?? d)
        .join(", ");
      base = interval === 1
        ? `Weekly on ${dayLabels || "—"}`
        : `Every${intervalText} weeks on ${dayLabels || "—"}`;
      break;
    }
    case "MONTHLY":
      if (form.monthlyMode === "day_of_month") {
        base = interval === 1
          ? `Monthly on day ${form.monthDay}`
          : `Every${intervalText} months on day ${form.monthDay}`;
      } else {
        const pos = POSITIONS.find((p) => p.value === form.byPosition)?.label.toLowerCase() ?? "";
        const day = WEEKDAYS.find((w) => w.code === form.byPositionDay)?.long ?? "";
        base = interval === 1
          ? `Monthly on the ${pos} ${day}`
          : `Every${intervalText} months on the ${pos} ${day}`;
      }
      break;
    case "YEARLY":
      base = `Annually on ${MONTHS[form.yearlyMonth - 1]} ${form.yearlyDay}`;
      break;
  }
  let suffix = "";
  if (form.endsMode === "after_count") {
    suffix = `, ${form.endsCount} time${form.endsCount === 1 ? "" : "s"}`;
  } else if (form.endsMode === "on_date" && form.endsDate) {
    const d = new Date(form.endsDate);
    const fmt = d.toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
    suffix = ` until ${fmt}`;
  }
  return `${base}${suffix}`;
}

/** Best-effort parse of an existing RecurrencePayload into a FormState. */
function parsePayload(payload: RecurrencePayload | null, dtstart: Date): FormState {
  const fallback = defaultForm(dtstart);
  if (!payload || payload.rrule.length === 0) return fallback;
  fallback.enabled = true;
  try {
    const ruleLine = payload.rrule.find((l) => l.startsWith("RRULE:")) ?? payload.rrule[0];
    const parsed = rrulestr(ruleLine, { dtstart });
    const ruleObj: RRuleOptionsLike =
      "rrules" in parsed && typeof (parsed as { rrules?: () => RRule[] }).rrules === "function"
        ? ((parsed as { rrules: () => RRule[] }).rrules()[0] as RRuleOptionsLike) ?? (parsed as RRuleOptionsLike)
        : (parsed as RRuleOptionsLike);
    const opts: Partial<RRuleOptions> = ruleObj.options ?? ruleObj.origOptions ?? {};
    if (opts.freq === RRule.DAILY) fallback.frequency = "DAILY";
    else if (opts.freq === RRule.WEEKLY) fallback.frequency = "WEEKLY";
    else if (opts.freq === RRule.MONTHLY) fallback.frequency = "MONTHLY";
    else if (opts.freq === RRule.YEARLY) fallback.frequency = "YEARLY";
    if (typeof opts.interval === "number") fallback.interval = opts.interval;

    // wkst: rrule stores it as a Weekday | number | null. Map back to "SU"/"MO".
    if (opts.wkst != null) {
      const wkstIdx =
        opts.wkst instanceof Weekday
          ? opts.wkst.weekday
          : typeof opts.wkst === "number"
            ? opts.wkst
            : null;
      if (wkstIdx === RRule.SU.weekday) fallback.wkst = "SU";
      else if (wkstIdx === RRule.MO.weekday) fallback.wkst = "MO";
    }

    // byweekday: extract simple day codes for weekly rules and detect
    // an n-th weekday encoding (Weekday with `n` set) for monthly
    // by-position rules.
    const bw = opts.byweekday;
    if (Array.isArray(bw)) {
      const simpleCodes: WeekdayCode[] = [];
      let positional: { code: WeekdayCode; n: 1 | 2 | 3 | 4 | -1 } | null = null;
      for (const w of bw) {
        if (w instanceof Weekday) {
          const code = RRULE_INDEX_TO_CODE[w.weekday] ?? "MO";
          // `n` is the (optional) positional offset set by `.nth(n)`.
          const n = w.n;
          if (typeof n === "number" && n !== 0 && (n === -1 || (n >= 1 && n <= 4))) {
            positional = { code, n: n as 1 | 2 | 3 | 4 | -1 };
          } else {
            simpleCodes.push(code);
          }
        } else if (typeof w === "number") {
          simpleCodes.push(RRULE_INDEX_TO_CODE[w] ?? "MO");
        }
      }
      if (positional && fallback.frequency === "MONTHLY") {
        fallback.monthlyMode = "by_position";
        fallback.byPosition = positional.n;
        fallback.byPositionDay = positional.code;
      } else if (simpleCodes.length > 0) {
        fallback.byDay = simpleCodes;
      }
    }

    // bymonthday: routed to monthDay (monthly) or yearlyDay (yearly).
    const bmd = opts.bymonthday;
    const firstBmd = Array.isArray(bmd)
      ? typeof bmd[0] === "number"
        ? bmd[0]
        : null
      : typeof bmd === "number"
        ? bmd
        : null;
    if (typeof firstBmd === "number") {
      if (fallback.frequency === "YEARLY") {
        fallback.yearlyDay = firstBmd;
      } else {
        fallback.monthDay = firstBmd;
        if (fallback.frequency === "MONTHLY") {
          fallback.monthlyMode = "day_of_month";
        }
      }
    }

    // bymonth: only meaningful for yearly recurrences.
    const bm = opts.bymonth;
    const firstBm = Array.isArray(bm)
      ? typeof bm[0] === "number"
        ? bm[0]
        : null
      : typeof bm === "number"
        ? bm
        : null;
    if (typeof firstBm === "number") {
      fallback.yearlyMonth = firstBm;
    }
    if (typeof opts.count === "number" && opts.count > 0) {
      fallback.endsMode = "after_count";
      fallback.endsCount = opts.count;
    } else if (opts.until instanceof Date) {
      fallback.endsMode = "on_date";
      fallback.endsDate = opts.until.toISOString().slice(0, 10);
    }
    fallback.exdates = payload.rrule
      .filter((l) => l.startsWith("EXDATE"))
      .map((l) => {
        const m = l.match(/[:](\d{8}T\d{6})/);
        if (!m) return "";
        const v = m[1];
        return `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}T${v.slice(9, 11)}:${v.slice(11, 13)}`;
      })
      .filter((s) => s.length > 0);
  } catch {
    // ignore parse errors; the form falls back to defaults but stays enabled
  }
  return fallback;
}

function applyPreset(
  preset: "weekly" | "biweekly" | "monthly",
  base: FormState,
): FormState {
  const next = { ...base, enabled: true, preset };
  if (preset === "weekly") {
    next.frequency = "WEEKLY";
    next.interval = 1;
  } else if (preset === "biweekly") {
    next.frequency = "WEEKLY";
    next.interval = 2;
  } else if (preset === "monthly") {
    next.frequency = "MONTHLY";
    next.interval = 1;
    next.monthlyMode = "day_of_month";
  }
  return next;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function RecurrenceBuilder(props: RecurrenceBuilderProps) {
  const {
    value,
    timezone,
    onChange,
    variant = "internal",
    mode = "local",
    dtstart: dtstartProp,
    serverPreviewUrl,
    durationMinutes,
    bufferBeforeMinutes,
    bufferAfterMinutes,
    exdateCap = DEFAULT_EXDATE_CAP,
    expansionCap = DEFAULT_EXPANSION_CAP,
    className,
  } = props;

  const dtstart = useMemo(() => dtstartProp ?? new Date(), [dtstartProp]);

  const [form, setForm] = useState<FormState>(() => {
    if (value) return parsePayload(value, dtstart);
    return defaultForm(dtstart);
  });
  const [advancedOpen, setAdvancedOpen] = useState(variant === "internal");
  const [exdateDraft, setExdateDraft] = useState("");
  const [serverPreview, setServerPreview] = useState<{
    occurrences: RecurrencePreviewOccurrence[];
    conflicts: RecurrenceConflict[];
    truncated: boolean;
  } | null>(null);
  const [serverLoading, setServerLoading] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const built = useMemo(
    () => buildPayload(form, timezone, dtstart, expansionCap, exdateCap),
    [form, timezone, dtstart, expansionCap, exdateCap],
  );

  // Track the last payload we emitted so we can (a) avoid re-firing onChange
  // for unchanged payloads and (b) detect external `value` changes that
  // didn't originate from us, so the form can re-sync.
  const lastEmittedRef = useRef<string>("__init__");

  // External-value sync: when the parent passes a new `value` that doesn't
  // match what we last emitted, re-hydrate the local form from it. This
  // keeps the controlled-component contract intact for async-loaded
  // payloads and external resets without clobbering local edits in
  // progress (we only re-hydrate when the value differs from our last
  // emission).
  const valueKey = value ? JSON.stringify(value) : "null";
  useEffect(() => {
    if (valueKey === lastEmittedRef.current) return;
    if (value === null) {
      // Parent cleared the recurrence — disable but keep last form
      // settings around so a quick re-enable doesn't lose work.
      setForm((f) => (f.enabled ? { ...f, enabled: false, preset: null } : f));
    } else {
      setForm(parsePayload(value, dtstart));
    }
    lastEmittedRef.current = valueKey;
  }, [valueKey, value, dtstart]);

  // Fire onChange ONLY when the payload is valid (or once with `null` when
  // the user disables recurrence).
  useEffect(() => {
    if (!form.enabled) {
      if (lastEmittedRef.current !== "null") {
        lastEmittedRef.current = "null";
        onChange(null);
      }
      return;
    }
    if (built.payload && built.normalized) {
      const key = JSON.stringify(built.payload);
      if (lastEmittedRef.current !== key) {
        lastEmittedRef.current = key;
        onChange(built.payload, built.normalized);
      }
    }
  }, [form.enabled, built.payload, built.normalized, onChange]);

  // Server-mode preview (debounced). We hit `fetch` directly rather than
  // going through `apiRequest`, which throws on non-2xx and would hide
  // the structured `code` field we want to map to friendly copy.
  useEffect(() => {
    if (mode !== "server" || !serverPreviewUrl || !form.enabled || !built.payload) {
      setServerPreview(null);
      setServerError(null);
      setServerLoading(false);
      return;
    }
    let cancelled = false;
    setServerLoading(true);
    setServerError(null);
    const payload = built.payload;
    const t = window.setTimeout(async () => {
      try {
        const res = await fetch(serverPreviewUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            startTimeUtc: dtstart.toISOString(),
            recurrence: payload,
            durationMinutes,
            bufferBeforeMinutes,
            bufferAfterMinutes,
          }),
        });
        // Tolerate empty / non-JSON bodies on error responses.
        let json: {
          code?: RecurrenceErrorCode;
          error?: string;
          occurrences?: RecurrencePreviewOccurrence[];
          conflicts?: RecurrenceConflict[];
          truncated?: boolean;
        } = {};
        try {
          json = await res.json();
        } catch {
          // ignore — handled below via res.ok
        }
        if (cancelled) return;
        if (!res.ok) {
          const code = json.code;
          const friendly =
            code && ERROR_COPY[code]
              ? ERROR_COPY[code]
              : json.error ?? `Preview failed (${res.status}).`;
          setServerError(friendly);
          setServerPreview(null);
        } else {
          setServerPreview({
            occurrences: json.occurrences ?? [],
            conflicts: json.conflicts ?? [],
            truncated: !!json.truncated,
          });
        }
      } catch (err: unknown) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : "Preview failed.";
        setServerError(msg);
        setServerPreview(null);
      } finally {
        if (!cancelled) setServerLoading(false);
      }
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
      setServerLoading(false);
    };
  }, [
    mode,
    serverPreviewUrl,
    form.enabled,
    built.payload,
    dtstart,
    durationMinutes,
    bufferBeforeMinutes,
    bufferAfterMinutes,
  ]);

  const update = useCallback((patch: Partial<FormState>) => {
    setForm((f) => ({ ...f, ...patch, preset: null }));
  }, []);

  const handleAddExdate = () => {
    if (!exdateDraft) return;
    if (form.exdates.length >= exdateCap) return;
    const v = exdateDraft.includes("T") ? exdateDraft : `${exdateDraft}T00:00`;
    if (form.exdates.includes(v)) {
      setExdateDraft("");
      return;
    }
    setForm((f) => ({ ...f, exdates: [...f.exdates, v], preset: null }));
    setExdateDraft("");
  };

  const handleRemoveExdate = (v: string) => {
    setForm((f) => ({ ...f, exdates: f.exdates.filter((e) => e !== v), preset: null }));
  };

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  // PUBLIC variant: collapsed-by-default toggle when disabled
  if (variant === "public" && !form.enabled) {
    return (
      <div
        className={cn("rounded-md border p-4", className)}
        data-testid="recurrence-builder-public-collapsed"
      >
        <div className="flex items-center justify-between">
          <div>
            <Label htmlFor="recurrence-enable-toggle" className="font-medium">
              Make this a recurring meeting
            </Label>
            <p className="text-xs text-muted-foreground">
              Optional — book this same time slot on a repeating schedule.
            </p>
          </div>
          <Switch
            id="recurrence-enable-toggle"
            data-testid="switch-recurrence-enable"
            checked={form.enabled}
            onCheckedChange={(checked) =>
              setForm((f) => ({ ...f, enabled: !!checked }))
            }
          />
        </div>
      </div>
    );
  }

  const showFullControls = variant === "internal" || advancedOpen;
  const previewOccurrences: { startUtc: string; conflict?: RecurrenceConflict }[] = (() => {
    if (mode === "server" && serverPreview) {
      const conflictByStart = new Map<string, RecurrenceConflict>();
      for (const c of serverPreview.conflicts) conflictByStart.set(c.startUtc, c);
      return serverPreview.occurrences.slice(0, PREVIEW_LIMIT).map((o) => ({
        startUtc: o.startUtc,
        conflict: conflictByStart.get(o.startUtc),
      }));
    }
    return built.occurrences.slice(0, PREVIEW_LIMIT).map((d) => ({
      startUtc: d.toISOString(),
    }));
  })();

  const errorText = built.error ?? serverError ?? null;

  return (
    <div
      className={cn("space-y-4 rounded-md border p-4", className)}
      data-testid="recurrence-builder"
    >
      {/* Header / enable switch */}
      <div className="flex items-center justify-between">
        <div>
          <Label htmlFor="recurrence-enable-toggle" className="font-medium">
            {variant === "public" ? "Recurring meeting" : "Recurrence"}
          </Label>
          <p className="text-xs text-muted-foreground">
            All occurrences are anchored to {timezone}.
          </p>
        </div>
        <Switch
          id="recurrence-enable-toggle"
          data-testid="switch-recurrence-enable"
          checked={form.enabled}
          onCheckedChange={(checked) =>
            setForm((f) => ({ ...f, enabled: !!checked }))
          }
        />
      </div>

      {form.enabled && (
        <>
          {/* PUBLIC presets */}
          {variant === "public" && (
            <div
              className="flex flex-wrap gap-2"
              data-testid="recurrence-preset-chips"
            >
              {(
                [
                  { key: "weekly", label: "Weekly" },
                  { key: "biweekly", label: "Every other week" },
                  { key: "monthly", label: "Monthly" },
                ] as const
              ).map((p) => (
                <Button
                  key={p.key}
                  type="button"
                  variant={form.preset === p.key ? "default" : "outline"}
                  size="sm"
                  data-testid={`button-preset-${p.key}`}
                  onClick={() => setForm((f) => applyPreset(p.key, f))}
                >
                  {p.label}
                </Button>
              ))}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                data-testid="button-toggle-advanced"
                onClick={() => setAdvancedOpen((v) => !v)}
              >
                {advancedOpen ? "Hide advanced" : "Advanced"}
              </Button>
            </div>
          )}

          {showFullControls && (
            <div className="grid gap-4 sm:grid-cols-2">
              {/* Frequency */}
              <div className="space-y-1.5">
                <Label htmlFor="recurrence-frequency">Repeats</Label>
                <Select
                  value={form.frequency}
                  onValueChange={(v) =>
                    update({ frequency: v as FormState["frequency"] })
                  }
                >
                  <SelectTrigger
                    id="recurrence-frequency"
                    data-testid="select-recurrence-frequency"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {FREQ_OPTIONS.map((o) => (
                      <SelectItem
                        key={o.value}
                        value={o.value}
                        data-testid={`option-frequency-${o.value.toLowerCase()}`}
                      >
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Interval */}
              <div className="space-y-1.5">
                <Label htmlFor="recurrence-interval">Every</Label>
                <Input
                  id="recurrence-interval"
                  type="number"
                  min={1}
                  max={90}
                  value={form.interval}
                  data-testid="input-recurrence-interval"
                  onChange={(e) =>
                    update({
                      interval: Math.max(1, parseInt(e.target.value || "1", 10)),
                    })
                  }
                />
              </div>

              {/* Weekly: day-of-week picker */}
              {form.frequency === "WEEKLY" && (
                <div className="sm:col-span-2 space-y-1.5">
                  <Label>Days of week</Label>
                  <ToggleGroup
                    type="multiple"
                    value={form.byDay}
                    onValueChange={(v: string[]) =>
                      update({ byDay: v as WeekdayCode[] })
                    }
                    data-testid="toggle-group-byday"
                    className="justify-start"
                  >
                    {WEEKDAYS.map((d) => (
                      <ToggleGroupItem
                        key={d.code}
                        value={d.code}
                        aria-label={d.long}
                        data-testid={`toggle-byday-${d.code}`}
                      >
                        {d.short}
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                </div>
              )}

              {/* Monthly: mode + sub-controls */}
              {form.frequency === "MONTHLY" && (
                <div className="sm:col-span-2 space-y-3">
                  <RadioGroup
                    value={form.monthlyMode}
                    onValueChange={(v) =>
                      update({ monthlyMode: v as FormState["monthlyMode"] })
                    }
                    data-testid="radio-monthly-mode"
                  >
                    <div className="flex items-center gap-2">
                      <RadioGroupItem
                        value="day_of_month"
                        id="monthly-day-of-month"
                        data-testid="radio-monthly-day-of-month"
                      />
                      <Label htmlFor="monthly-day-of-month">On day</Label>
                      <Input
                        type="number"
                        min={1}
                        max={31}
                        value={form.monthDay}
                        disabled={form.monthlyMode !== "day_of_month"}
                        className="w-20"
                        data-testid="input-monthly-day-of-month"
                        onChange={(e) =>
                          update({
                            monthDay: Math.min(
                              31,
                              Math.max(1, parseInt(e.target.value || "1", 10)),
                            ),
                          })
                        }
                      />
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <RadioGroupItem
                        value="by_position"
                        id="monthly-by-position"
                        data-testid="radio-monthly-by-position"
                      />
                      <Label htmlFor="monthly-by-position">On the</Label>
                      <Select
                        value={String(form.byPosition)}
                        onValueChange={(v) =>
                          update({
                            byPosition: Number(v) as FormState["byPosition"],
                          })
                        }
                        disabled={form.monthlyMode !== "by_position"}
                      >
                        <SelectTrigger
                          className="w-32"
                          data-testid="select-monthly-position"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {POSITIONS.map((p) => (
                            <SelectItem
                              key={p.value}
                              value={String(p.value)}
                              data-testid={`option-position-${p.value}`}
                            >
                              {p.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Select
                        value={form.byPositionDay}
                        onValueChange={(v) =>
                          update({ byPositionDay: v as WeekdayCode })
                        }
                        disabled={form.monthlyMode !== "by_position"}
                      >
                        <SelectTrigger
                          className="w-32"
                          data-testid="select-monthly-position-day"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {WEEKDAYS.map((d) => (
                            <SelectItem
                              key={d.code}
                              value={d.code}
                              data-testid={`option-position-day-${d.code}`}
                            >
                              {d.long}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </RadioGroup>
                </div>
              )}

              {/* Yearly: month + day */}
              {form.frequency === "YEARLY" && (
                <div className="sm:col-span-2 grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="yearly-month">Month</Label>
                    <Select
                      value={String(form.yearlyMonth)}
                      onValueChange={(v) => update({ yearlyMonth: Number(v) })}
                    >
                      <SelectTrigger
                        id="yearly-month"
                        data-testid="select-yearly-month"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {MONTHS.map((m, i) => (
                          <SelectItem
                            key={m}
                            value={String(i + 1)}
                            data-testid={`option-yearly-month-${i + 1}`}
                          >
                            {m}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="yearly-day">Day</Label>
                    <Input
                      id="yearly-day"
                      type="number"
                      min={1}
                      max={31}
                      value={form.yearlyDay}
                      data-testid="input-yearly-day"
                      onChange={(e) =>
                        update({
                          yearlyDay: Math.min(
                            31,
                            Math.max(1, parseInt(e.target.value || "1", 10)),
                          ),
                        })
                      }
                    />
                  </div>
                </div>
              )}

              {/* Ends */}
              <div className="sm:col-span-2 space-y-2">
                <Label>Ends</Label>
                <RadioGroup
                  value={form.endsMode}
                  onValueChange={(v) =>
                    update({ endsMode: v as FormState["endsMode"] })
                  }
                  data-testid="radio-ends-mode"
                >
                  <div className="flex items-center gap-2">
                    <RadioGroupItem
                      value="never"
                      id="ends-never"
                      data-testid="radio-ends-never"
                    />
                    <Label htmlFor="ends-never">Never</Label>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <RadioGroupItem
                      value="on_date"
                      id="ends-on-date"
                      data-testid="radio-ends-on-date"
                    />
                    <Label htmlFor="ends-on-date">On</Label>
                    <Input
                      type="date"
                      value={form.endsDate}
                      disabled={form.endsMode !== "on_date"}
                      data-testid="input-ends-date"
                      onChange={(e) => update({ endsDate: e.target.value })}
                      className="w-44"
                    />
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <RadioGroupItem
                      value="after_count"
                      id="ends-after-count"
                      data-testid="radio-ends-after-count"
                    />
                    <Label htmlFor="ends-after-count">After</Label>
                    <Input
                      type="number"
                      min={1}
                      max={expansionCap}
                      value={form.endsCount}
                      disabled={form.endsMode !== "after_count"}
                      data-testid="input-ends-count"
                      onChange={(e) =>
                        update({
                          endsCount: Math.max(
                            1,
                            parseInt(e.target.value || "1", 10),
                          ),
                        })
                      }
                      className="w-24"
                    />
                    <span className="text-sm text-muted-foreground">
                      occurrences
                    </span>
                  </div>
                </RadioGroup>
              </div>

              {/* WKST (internal only) */}
              {variant === "internal" && (
                <div className="space-y-1.5">
                  <Label htmlFor="recurrence-wkst">Week starts on</Label>
                  <Select
                    value={form.wkst}
                    onValueChange={(v) =>
                      update({ wkst: v as FormState["wkst"] })
                    }
                  >
                    <SelectTrigger
                      id="recurrence-wkst"
                      data-testid="select-wkst"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="SU" data-testid="option-wkst-su">
                        Sunday
                      </SelectItem>
                      <SelectItem value="MO" data-testid="option-wkst-mo">
                        Monday
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}

              {/* EXDATE management */}
              <div className="sm:col-span-2 space-y-2">
                <Label>Skip these dates</Label>
                <div className="flex flex-wrap gap-2">
                  <Input
                    type="datetime-local"
                    value={exdateDraft}
                    onChange={(e) => setExdateDraft(e.target.value)}
                    className="w-60"
                    data-testid="input-exdate-draft"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleAddExdate}
                    disabled={!exdateDraft || form.exdates.length >= exdateCap}
                    data-testid="button-add-exdate"
                  >
                    Add
                  </Button>
                  <span className="text-xs text-muted-foreground self-center">
                    {form.exdates.length} / {exdateCap}
                  </span>
                </div>
                {form.exdates.length > 0 && (
                  <ul className="space-y-1" data-testid="list-exdates">
                    {form.exdates.map((d) => (
                      <li
                        key={d}
                        className="flex items-center justify-between rounded border px-2 py-1 text-sm"
                        data-testid={`row-exdate-${d}`}
                      >
                        <span data-testid={`text-exdate-${d}`}>
                          {d.replace("T", " ")}
                        </span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => handleRemoveExdate(d)}
                          data-testid={`button-remove-exdate-${d}`}
                          aria-label={`Remove ${d}`}
                        >
                          <X className="size-3" />
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}

          {/* Summary line */}
          {built.normalized && (
            <p
              className="text-sm font-medium"
              data-testid="text-recurrence-summary"
            >
              {built.normalized.summary}
            </p>
          )}

          {/* Errors */}
          {errorText && (
            <div
              className="rounded border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              data-testid="text-recurrence-error"
              role="alert"
            >
              {errorText}
            </div>
          )}

          {/* Preview */}
          {!errorText && (
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <Label>Next {PREVIEW_LIMIT} occurrences</Label>
                {serverLoading && (
                  <Spinner data-testid="spinner-recurrence-preview" />
                )}
              </div>
              {previewOccurrences.length === 0 ? (
                <p
                  className="text-xs text-muted-foreground"
                  data-testid="text-preview-empty"
                >
                  No upcoming occurrences.
                </p>
              ) : (
                <ul
                  className="space-y-1 text-sm"
                  data-testid="list-preview-occurrences"
                >
                  {previewOccurrences.map((o, i) => {
                    const d = new Date(o.startUtc);
                    const formatted = d.toLocaleString(undefined, {
                      timeZone: timezone,
                      weekday: "short",
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                      hour: "numeric",
                      minute: "2-digit",
                      timeZoneName: "short",
                    });
                    return (
                      <li
                        key={`${o.startUtc}-${i}`}
                        className="flex items-center justify-between"
                        data-testid={`row-preview-occurrence-${i}`}
                      >
                        <span data-testid={`text-preview-occurrence-${i}`}>
                          {formatted}
                        </span>
                        {o.conflict && (
                          <Badge
                            variant="destructive"
                            data-testid={`badge-preview-conflict-${i}`}
                          >
                            Conflict
                          </Badge>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
              {mode === "server" && serverPreview?.truncated && (
                <p
                  className="text-xs text-muted-foreground"
                  data-testid="text-preview-truncated"
                >
                  Showing the first {PREVIEW_LIMIT} of many occurrences.
                </p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default RecurrenceBuilder;
