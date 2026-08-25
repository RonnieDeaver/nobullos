import { useEffect, useMemo, useRef, useState } from "react";
import { useRoute } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import { rrulestr, RRule, Weekday, type Options as RRuleOptions } from "rrule";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, Calendar, Clock, CheckCircle, AlertCircle, ChevronDown, ChevronUp } from "lucide-react";
import { RecurrenceBuilder } from "@/components/booking/RecurrenceBuilder";
import type {
  RecurrencePayload,
  RecurrenceErrorCode,
  RecurrencePreviewOccurrence,
  RecurrenceConflict,
} from "@shared/models/booking";

type PublicPage = {
  page: {
    id: string;
    slug: string;
    timezone: string;
    durationMinutes: number;
    title: string | null;
    description: string | null;
    active: boolean;
    allowRecurring?: boolean;
  };
  host: { displayName: string; email: string } | null;
};

type Slot = { startUtc: string; endUtc: string; dateLocal: string; timeLocal: string };

// Task #4337 — first-touch attribution: utm_* params from the booking URL
// plus an external referrer, captured once at mount and sent with confirm.
// Values are trimmed/capped to the server schema's bounds so a legitimate
// visitor can never trip validation; the server normalizes at lead-stamp
// time (absent → "direct"). Best-effort by design.
function readPageAttribution(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const params = new URLSearchParams(window.location.search);
    const pairs: Array<[param: string, key: string]> = [
      ["utm_source", "utmSource"],
      ["utm_medium", "utmMedium"],
      ["utm_campaign", "utmCampaign"],
      ["utm_term", "utmTerm"],
      ["utm_content", "utmContent"],
    ];
    for (const [param, key] of pairs) {
      const value = params.get(param)?.trim().slice(0, 200);
      if (value) out[key] = value;
    }
    const referrer = document.referrer;
    if (referrer) {
      try {
        const host = new URL(referrer).hostname;
        if (host && host !== window.location.hostname) {
          out.referrer = referrer.slice(0, 1000);
        }
      } catch {
        // unparseable referrer — skip
      }
    }
  } catch {
    // attribution is best-effort; booking must never fail because of it
  }
  return out;
}

// Friendly copy for the recurrence error codes coming back from the
// public preview / confirm endpoints. Mirrors the epic's user-facing
// error list so the visitor never sees a raw code.
const RECURRENCE_ERROR_COPY: Record<string, string> = {
  recurrence_invalid_rrule:
    "This recurrence pattern is invalid. Please check the settings.",
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
  recurrence_not_allowed:
    "This booking page does not allow recurring meetings.",
  recurrence_freebusy_conflict:
    "Some occurrences in this series conflict with existing events. Please pick another time or adjust the recurrence.",
  zoom_recurring_create_failed:
    "We couldn't set up the Zoom meeting series. Please try again or pick a different time.",
  zoom_failure:
    "This host's video conferencing isn't available right now. Please try again shortly or contact your account manager.",
  calendar_failure:
    "This host's calendar isn't available right now. Please try again shortly or contact your account manager.",
};

const ZOOM_FALLBACK_NOTICE =
  "Zoom cannot represent this exact recurrence pattern. A single reusable Zoom link will be used for all occurrences.";

function formatDateHeading(dateLocal: string): string {
  const [y, m, d] = dateLocal.split("-").map(Number);
  const date = new Date(y, (m || 1) - 1, d || 1);
  return date.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
}

function makeIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

interface RRuleOptionsLike {
  options?: Partial<RRuleOptions>;
  origOptions?: Partial<RRuleOptions>;
}

/**
 * Client-side mirror of the most common Zoom-translator fallback
 * cases (#1032C). Returns true when the recurrence is *not* fully
 * representable as a native Zoom recurring meeting and a single
 * reusable join link will be used instead. Mirrors:
 *  - FREQ=YEARLY → fallback (yearly_not_supported)
 *  - EXDATE / RDATE present → fallback
 *  - COUNT > 50 → fallback (end_times_too_large)
 *  - DAILY interval > 90, WEEKLY interval > 12, MONTHLY interval > 3
 *  - WEEKLY interval > 1 with multiple BYDAY days
 *  - MONTHLY without BYMONTHDAY or BYDAY (positional) info
 *  - BYHOUR/BYMINUTE/BYWEEKNO/BYYEARDAY/BYMONTH constraints
 *
 * This is intentionally conservative: when in doubt we prefer the
 * Zoom-fallback notice over silent surprise at confirm time.
 */
function detectZoomFallback(payload: RecurrencePayload | null): boolean {
  if (!payload || payload.rrule.length === 0) return false;
  // Any EXDATE / RDATE line forces fallback.
  for (const line of payload.rrule) {
    const trimmed = line.trim().toUpperCase();
    if (trimmed.startsWith("EXDATE") || trimmed.startsWith("RDATE")) {
      return true;
    }
  }
  const ruleLine =
    payload.rrule.find((l) => l.trim().toUpperCase().startsWith("RRULE:")) ??
    payload.rrule[0];
  try {
    const parsed = rrulestr(ruleLine);
    const ruleObj: RRuleOptionsLike =
      "rrules" in parsed && typeof (parsed as { rrules?: () => RRule[] }).rrules === "function"
        ? ((parsed as { rrules: () => RRule[] }).rrules()[0] as RRuleOptionsLike) ?? (parsed as RRuleOptionsLike)
        : (parsed as RRuleOptionsLike);
    const opts = ruleObj.options ?? ruleObj.origOptions ?? {};
    const interval = typeof opts.interval === "number" ? opts.interval : 1;
    const freq = opts.freq as number | undefined;
    if (freq === (RRule.YEARLY as number)) return true;
    if (opts.byhour && (opts.byhour as number[]).length > 0) return true;
    if (opts.byminute && (opts.byminute as number[]).length > 0) return true;
    if (opts.byweekno && (opts.byweekno as number[]).length > 0) return true;
    if (opts.byyearday && (opts.byyearday as number[]).length > 0) return true;
    if (opts.bymonth && (opts.bymonth as number[]).length > 0 && opts.freq !== RRule.YEARLY) {
      return true;
    }
    if (typeof opts.count === "number" && opts.count > 50) return true;
    if (opts.freq === RRule.DAILY && interval > 90) return true;
    if (opts.freq === RRule.WEEKLY) {
      if (interval > 12) return true;
      const bw = Array.isArray(opts.byweekday) ? opts.byweekday : [];
      if (interval > 1 && bw.length > 1) return true;
    }
    if (opts.freq === RRule.MONTHLY) {
      if (interval > 3) return true;
      const bmd = Array.isArray(opts.bymonthday) ? opts.bymonthday : [];
      const bw = Array.isArray(opts.byweekday) ? opts.byweekday : [];
      const hasPositional = bw.some(
        (w) => w instanceof Weekday && typeof w.n === "number" && w.n !== 0,
      );
      if (bmd.length === 0 && !hasPositional) return true;
      if (bmd.length > 1) return true;
      if (bmd.some((d) => d < 0)) return true;
    }
    return false;
  } catch {
    // If we can't even parse it client-side the safer message is
    // "fallback" — Zoom certainly won't represent it.
    return true;
  }
}

interface PublicPreviewResponse {
  ok: boolean;
  occurrences: RecurrencePreviewOccurrence[];
  conflicts: RecurrenceConflict[];
  truncated: boolean;
  summary?: string | null;
  timezone?: string;
}

export default function PublicBookingPage() {
  const [, paramsClient] = useRoute<{ slug: string; signedToken: string }>("/book/:slug/client/:signedToken");
  const [, paramsBase] = useRoute<{ slug: string }>("/book/:slug");
  const slug = paramsClient?.slug || paramsBase?.slug || "";
  const signedToken = paramsClient?.signedToken;

  const { data: pageData, isLoading: pageLoading, error: pageError } = useQuery<PublicPage>({
    queryKey: [`/api/book/${slug}`],
    queryFn: async () => {
      const res = await fetch(`/api/book/${slug}`);
      if (!res.ok) throw new Error((await res.json()).error || "Page not found");
      return res.json();
    },
    enabled: !!slug,
  });

  // When the booker is on a client-bound link (/book/:slug/client/:token),
  // resolve the token up front so we can: (a) greet them by name, (b)
  // pre-fill the email/name fields from the client record, and (c) fail
  // fast with a clear error message when the link is invalid, expired, or
  // already used — instead of letting the failure surface only at confirm
  // time after the user has filled in the form.
  type ClientTokenStatus = {
    valid: boolean;
    code?: string;
    error?: string;
    expiresAt?: string;
    client?: {
      firmName: string | null;
      contactName: string | null;
      contactEmail: string | null;
    } | null;
  };
  const { data: clientTokenStatus, isLoading: clientTokenLoading } =
    useQuery<ClientTokenStatus>({
      queryKey: [
        `/api/book/${slug}/client/${signedToken}`,
      ],
      queryFn: async () => {
        const res = await fetch(
          `/api/book/${slug}/client/${encodeURIComponent(
            signedToken!,
          )}`,
        );
        // 4xx responses still contain { valid: false, code, error } — we
        // surface them to the UI rather than throwing.
        const json = (await res.json().catch(() => ({}))) as ClientTokenStatus;
        return json;
      },
      enabled: !!slug && !!signedToken,
      retry: false,
    });

  // Task #4337 — captured once; URL params don't change during the flow.
  const attribution = useMemo(() => readPageAttribution(), []);
  const fromIso = useMemo(() => new Date().toISOString(), []);
  const toIso = useMemo(
    () => new Date(Date.now() + 21 * 24 * 60 * 60 * 1000).toISOString(),
    [],
  );
  // Browser-detected IANA timezone — sent to the backend so the slots
  // endpoint groups by the booker's local date (not the AM's), which
  // matters for cross-timezone bookings whose midnight boundary differs.
  const viewerTimezone = useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch {
      return "UTC";
    }
  }, []);

  const {
    data: slotsData,
    isLoading: slotsLoading,
    error: slotsError,
  } = useQuery<
    { timezone: string; slots: Slot[] },
    Error & { code?: string; status?: number; retriable?: boolean }
  >({
    queryKey: [`/api/book/${slug}/slots`, fromIso, toIso, viewerTimezone],
    queryFn: async () => {
      const res = await fetch(
        `/api/book/${slug}/slots?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}&viewerTimezone=${encodeURIComponent(viewerTimezone)}`,
      );
      if (!res.ok) {
        // Surface the server's error code so the page can tell a
        // permanent calendar-credential failure (Reconnect required —
        // visitor cannot fix this themselves) apart from a transient
        // calendar outage (try again shortly).
        const body = await res.json().catch(() => ({}));
        const err = new Error(
          body?.error || body?.message || `Failed to load slots (${res.status})`,
        ) as Error & { code?: string; status?: number; retriable?: boolean };
        err.code = body?.code;
        err.status = res.status;
        err.retriable = !!body?.retriable;
        throw err;
      }
      return res.json();
    },
    enabled: !!pageData?.page?.active,
    retry: false,
  });

  const slotsByDay = useMemo(() => {
    const m = new Map<string, Slot[]>();
    (slotsData?.slots || []).forEach((s) => {
      if (!m.has(s.dateLocal)) m.set(s.dateLocal, []);
      m.get(s.dateLocal)!.push(s);
    });
    return Array.from(m.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [slotsData]);

  const [selected, setSelected] = useState<Slot | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [emailTouched, setEmailTouched] = useState(false);
  const [notes, setNotes] = useState("");
  const [website, setWebsite] = useState(""); // honeypot
  const [idempotencyKey] = useState(() => makeIdempotencyKey());

  // Recurrence state. Only used when the booking page enables it via
  // `allowRecurring`. The disclosure is collapsed by default per the
  // epic's Public UX Guardrails so the one-off flow looks unchanged.
  const allowRecurring = !!pageData?.page?.allowRecurring;
  const hostTimezone = pageData?.page?.timezone || "UTC";
  const [recurrenceOpen, setRecurrenceOpen] = useState(false);
  const [recurrence, setRecurrence] = useState<RecurrencePayload | null>(null);
  const [recurrenceSummary, setRecurrenceSummary] = useState<string | null>(null);

  // Page-level preview. RecurrenceBuilder runs its own preview to
  // render conflict badges in-place; the page runs an additional copy
  // (debounced) so it can gate the Confirm button on the conflict
  // count without coupling to the builder's internals (#1032F is out
  // of scope for this task).
  const [pagePreview, setPagePreview] = useState<PublicPreviewResponse | null>(null);
  const [pagePreviewError, setPagePreviewError] = useState<string | null>(null);
  const previewSeqRef = useRef(0);

  const [confirmed, setConfirmed] = useState<{
    startTimeUtc: string;
    joinUrl?: string | null;
    recurrence?: {
      occurrenceCount: number;
      truncated: boolean;
      summary: string | null;
      timezone: string;
    } | null;
    zoomFallback: boolean;
  } | null>(null);

  useEffect(() => {
    setSelected(null);
  }, [slug]);

  // Reset / hide recurrence when the host doesn't allow it (defense
  // in depth — the backend would also reject).
  useEffect(() => {
    if (!allowRecurring) {
      setRecurrenceOpen(false);
      setRecurrence(null);
      setRecurrenceSummary(null);
      setPagePreview(null);
      setPagePreviewError(null);
    }
  }, [allowRecurring]);

  // Page-level conflict preview (debounced). Re-runs whenever the
  // selected slot or recurrence payload changes.
  useEffect(() => {
    if (!recurrence || !selected || !allowRecurring) {
      setPagePreview(null);
      setPagePreviewError(null);
      return;
    }
    const seq = ++previewSeqRef.current;
    const startTimeUtc = selected.startUtc;
    const payload = recurrence;
    const t = window.setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/book/${slug}/recurrence/preview-availability`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ startTimeUtc, recurrence: payload }),
          },
        );
        let json: PublicPreviewResponse & { code?: RecurrenceErrorCode; error?: string } = {
          ok: false,
          occurrences: [],
          conflicts: [],
          truncated: false,
        };
        try {
          json = await res.json();
        } catch {
          // ignore
        }
        if (seq !== previewSeqRef.current) return;
        if (!res.ok) {
          const code = json.code as string | undefined;
          const friendly =
            (code && RECURRENCE_ERROR_COPY[code]) ||
            json.error ||
            `Preview failed (${res.status}).`;
          setPagePreviewError(friendly);
          setPagePreview(null);
          return;
        }
        setPagePreviewError(null);
        setPagePreview({
          ok: !!json.ok,
          occurrences: json.occurrences ?? [],
          conflicts: json.conflicts ?? [],
          truncated: !!json.truncated,
          summary: json.summary ?? null,
          timezone: json.timezone,
        });
      } catch (err: unknown) {
        if (seq !== previewSeqRef.current) return;
        const msg = err instanceof Error ? err.message : "Preview failed.";
        setPagePreviewError(msg);
        setPagePreview(null);
      }
    }, 350);
    return () => {
      window.clearTimeout(t);
    };
  }, [recurrence, selected, slug, allowRecurring]);

  // Pre-fill the invitee form from the resolved client when this is a
  // client-bound link. We only fill empty fields so the user can still
  // override (e.g. a different contact at the same company is booking).
  useEffect(() => {
    if (!clientTokenStatus?.valid || !clientTokenStatus.client) return;
    const c = clientTokenStatus.client;
    const prefillName = c.contactName || c.firmName || "";
    if (prefillName && !name) setName(prefillName);
    if (c.contactEmail && !email) setEmail(c.contactEmail);
    // intentionally only re-runs when the resolved client changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientTokenStatus?.valid, clientTokenStatus?.client?.contactEmail]);

  const zoomFallback = useMemo(
    () => (recurrence ? detectZoomFallback(recurrence) : false),
    [recurrence],
  );
  const conflictCount = pagePreview?.conflicts?.length ?? 0;
  const hasRecurrenceConflicts = conflictCount > 0;

  const confirm = useMutation<
    {
      startTimeUtc: string;
      joinUrl?: string | null;
      recurrence?: {
        occurrenceCount: number;
        truncated: boolean;
        summary: string | null;
        timezone: string;
      } | null;
    },
    Error & { code?: string }
  >({
    mutationFn: async () => {
      if (!selected) throw new Error("Pick a time first");
      const body: Record<string, unknown> = {
        startTimeUtc: selected.startUtc,
        invitee: { email, name: name || undefined },
        notes: notes || undefined,
        website,
        idempotencyKey,
      };
      if (signedToken) body.signedToken = signedToken;
      if (recurrence) body.recurrence = recurrence;
      if (Object.keys(attribution).length > 0) body.attribution = attribution;
      const res = await fetch(`/api/book/${slug}/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({} as Record<string, unknown>));
      if (!res.ok) {
        const code = (json as { code?: string }).code;
        const friendly =
          (code && RECURRENCE_ERROR_COPY[code]) ||
          (json as { error?: string }).error ||
          "Booking failed";
        const err = new Error(friendly) as Error & { code?: string };
        err.code = code;
        throw err;
      }
      return json as {
        startTimeUtc: string;
        joinUrl?: string | null;
        recurrence?: {
          occurrenceCount: number;
          truncated: boolean;
          summary: string | null;
          timezone: string;
        } | null;
      };
    },
    onSuccess: (data) => {
      setConfirmed({
        startTimeUtc: data.startTimeUtc,
        joinUrl: data.joinUrl ?? null,
        recurrence: data.recurrence ?? null,
        zoomFallback,
      });
    },
  });

  if (pageLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center" role="status" aria-label="Loading booking page">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (pageError || !pageData) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <Card className="max-w-md">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AlertCircle className="w-5 h-5 text-status-critical" /> Page not found
            </CardTitle>
            <CardDescription>This booking link is invalid or no longer accepting bookings.</CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  if (!pageData.page.active) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <Card className="max-w-md">
          <CardHeader>
            <CardTitle>Bookings paused</CardTitle>
            <CardDescription>
              {pageData.host?.displayName || "This host"} is not accepting bookings right now.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  // Fail fast on a bad client-bound link rather than letting the user
  // pick a slot, fill the form, and only then discover at confirm time
  // that the link is invalid/expired/already used.
  if (signedToken && !clientTokenLoading && clientTokenStatus && clientTokenStatus.valid === false) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <Card className="max-w-md w-full" data-testid="card-client-token-invalid">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-status-critical">
              <AlertCircle className="w-5 h-5" />
              {clientTokenStatus.code === "client_link_expired"
                ? "This booking link has expired"
                : clientTokenStatus.code === "client_link_already_used"
                  ? "This booking link has already been used"
                  : "This booking link is invalid"}
            </CardTitle>
            <CardDescription>
              {clientTokenStatus.error ||
                "Please contact your account manager for a new booking link."}
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  if (confirmed) {
    const firstOccurrence = confirmed.recurrence
      ? confirmed.startTimeUtc
      : confirmed.startTimeUtc;
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <Card className="max-w-md w-full" data-testid="card-booking-confirmed">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-status-ok">
              <CheckCircle className="w-5 h-5" /> You're booked!
            </CardTitle>
            <CardDescription data-testid="text-confirmed-when">
              {new Date(firstOccurrence).toLocaleString(undefined, {
                weekday: "long",
                month: "long",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
                timeZoneName: "short",
              })}
            </CardDescription>
            <CardDescription data-testid="text-confirmed-duration">
              {pageData.page.durationMinutes}-minute meeting
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {confirmed.recurrence && (
              <div
                className="rounded border bg-muted/40 p-3 space-y-1"
                data-testid="text-confirmed-recurrence-summary"
              >
                <p className="font-medium">
                  Recurring meeting:{" "}
                  {confirmed.recurrence.summary || "Custom schedule"}
                </p>
                <p className="text-xs text-muted-foreground">
                  {confirmed.recurrence.occurrenceCount} occurrence
                  {confirmed.recurrence.occurrenceCount === 1 ? "" : "s"} ·
                  Times anchored to {confirmed.recurrence.timezone}
                  {confirmed.recurrence.truncated
                    ? " · additional occurrences will be added automatically"
                    : ""}
                </p>
                <p
                  className="text-xs text-muted-foreground"
                  data-testid="text-confirmed-zoom-mode"
                >
                  {confirmed.zoomFallback
                    ? "A single reusable Zoom link will be used for every occurrence."
                    : "A recurring Zoom meeting was created — every occurrence shares the same join link."}
                </p>
              </div>
            )}
            <p>
              We'll email you a calendar invite at <span className="font-medium">{email}</span> with
              the Zoom link.
            </p>
            {confirmed.joinUrl && (
              <p>
                Join link:{" "}
                <a
                  href={confirmed.joinUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary-ink underline break-all"
                  data-testid="link-zoom-join"
                >
                  {confirmed.joinUrl}
                </a>
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());
  const confirmDisabled =
    !selected ||
    !email ||
    !emailValid ||
    confirm.isPending ||
    (!!recurrence && hasRecurrenceConflicts);
  // One-line, human explanation of why Confirm is disabled — screen-reader
  // linked via aria-describedby and visible to everyone under the button.
  const confirmHint = confirm.isPending
    ? null
    : !selected && !email
      ? "Choose a time and enter your email to book."
      : !selected
        ? "Choose a time to book."
        : !email
          ? "Enter your email to book."
          : !emailValid
            ? "Fix the email address above to book."
            : recurrence && hasRecurrenceConflicts
              ? "Resolve the recurrence conflicts above to book."
              : null;

  return (
    <div className="min-h-screen bg-gray-50 py-10 px-4" data-testid="page-public-booking">
      <div className="max-w-4xl mx-auto">
        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="text-2xl flex items-center gap-2">
              <Calendar className="w-6 h-6" />
              {pageData.page.title || `Book a meeting with ${pageData.host?.displayName || "us"}`}
            </CardTitle>
            <CardDescription>
              {pageData.page.durationMinutes}-minute meeting · Times shown in your local timezone
            </CardDescription>
          </CardHeader>
          {(pageData.page.description ||
            (clientTokenStatus?.valid && clientTokenStatus.client)) && (
            <CardContent className="text-sm space-y-2">
              {clientTokenStatus?.valid && clientTokenStatus.client && (
                <p
                  className="text-status-ok font-medium"
                  data-testid="text-client-greeting"
                >
                  Welcome back,{" "}
                  {clientTokenStatus.client.contactName ||
                    clientTokenStatus.client.firmName}
                  . We've pre-filled your details below.
                </p>
              )}
              {pageData.page.description && (
                <p className="whitespace-pre-wrap">
                  {pageData.page.description}
                </p>
              )}
            </CardContent>
          )}
        </Card>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <Clock className="w-5 h-5" /> Pick a time
              </CardTitle>
            </CardHeader>
            <CardContent>
              {slotsLoading ? (
                <div className="text-sm text-muted-foreground" role="status">Loading times…</div>
              ) : slotsError ? (
                slotsError.code === "calendar_reauth_required" ? (
                  <div
                    className="rounded border border-status-critical/30 bg-status-critical/10 p-3 text-sm text-status-critical"
                    role="status"
                    data-testid="banner-public-calendar-reauth-required"
                    data-error-code={slotsError.code}
                  >
                    This host's calendar isn't connected right now, so we
                    can't show available times. Please try again later or
                    contact them directly.
                  </div>
                ) : (
                  <div
                    className="rounded border border-status-warn/30 bg-status-warn/10 p-3 text-sm text-status-warn"
                    role="status"
                    data-testid="banner-public-calendar-unavailable"
                    data-error-code={slotsError.code || ""}
                  >
                    Could not load available times right now. Please try
                    again in a moment.
                  </div>
                )
              ) : slotsByDay.length === 0 ? (
                <div className="text-sm text-muted-foreground" role="status" data-testid="text-no-slots">
                  No availability in the next 3 weeks. Please check back later.
                </div>
              ) : (
                <div className="space-y-4 max-h-[60vh] overflow-y-auto pr-2">
                  {slotsByDay.map(([dateLocal, daySlots]) => (
                    <div key={dateLocal} data-testid={`day-${dateLocal}`}>
                      <div className="text-sm font-medium mb-2">{formatDateHeading(dateLocal)}</div>
                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                        {daySlots.map((s) => {
                          const isSel = selected?.startUtc === s.startUtc;
                          const localTime = new Date(s.startUtc).toLocaleTimeString(undefined, {
                            hour: "numeric",
                            minute: "2-digit",
                          });
                          return (
                            <Button
                              key={s.startUtc}
                              type="button"
                              variant={isSel ? "default" : "outline"}
                              size="sm"
                              onClick={() => setSelected(s)}
                              aria-pressed={isSel}
                              aria-label={`${formatDateHeading(dateLocal)} at ${localTime}`}
                              data-testid={`button-slot-${s.startUtc}`}
                            >
                              {localTime}
                            </Button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Recurrence disclosure (only when the page allows it) */}
              {allowRecurring && (
                <div className="mt-4" data-testid="section-recurrence">
                  <button
                    type="button"
                    onClick={() => setRecurrenceOpen((v) => !v)}
                    className="flex w-full items-center justify-between rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted/40"
                    data-testid="button-toggle-recurrence"
                    aria-expanded={recurrenceOpen}
                  >
                    <span>Make this a recurring meeting</span>
                    {recurrenceOpen ? (
                      <ChevronUp className="size-4" />
                    ) : (
                      <ChevronDown className="size-4" />
                    )}
                  </button>
                  {recurrenceOpen && (
                    <div className="mt-3" data-testid="container-recurrence-builder">
                      <RecurrenceBuilder
                        variant="public"
                        mode="server"
                        serverPreviewUrl={`/api/book/${slug}/recurrence/preview-availability`}
                        timezone={hostTimezone}
                        durationMinutes={pageData.page.durationMinutes}
                        dtstart={selected ? new Date(selected.startUtc) : null}
                        value={recurrence}
                        onChange={(payload, normalized) => {
                          setRecurrence(payload);
                          setRecurrenceSummary(normalized?.summary ?? null);
                        }}
                      />
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Your details</CardTitle>
              <CardDescription aria-live="polite" data-testid="text-selected-slot">
                {selected
                  ? `Selected: ${new Date(selected.startUtc).toLocaleString(undefined, {
                      weekday: "short",
                      month: "short",
                      day: "numeric",
                      hour: "numeric",
                      minute: "2-digit",
                    })}`
                  : "First, pick a time that works for you."}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div>
                <Label htmlFor="bookerName">Your name</Label>
                <Input
                  id="bookerName"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Jane Doe"
                  data-testid="input-booker-name"
                />
              </div>
              <div>
                <Label htmlFor="bookerEmail">Email</Label>
                <Input
                  id="bookerEmail"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onBlur={() => setEmailTouched(true)}
                  aria-invalid={emailTouched && email.length > 0 && !emailValid}
                  aria-describedby={
                    emailTouched && email.length > 0 && !emailValid
                      ? "bookerEmail-error"
                      : undefined
                  }
                  placeholder="you@company.com"
                  data-testid="input-booker-email"
                />
                {emailTouched && email.length > 0 && !emailValid && (
                  <p
                    id="bookerEmail-error"
                    className="mt-1 text-sm text-status-critical"
                    data-testid="text-email-error"
                  >
                    That email doesn't look right — check for a typo (e.g.
                    you@company.com).
                  </p>
                )}
              </div>
              <div>
                <Label htmlFor="bookerNotes">Notes (optional)</Label>
                <Textarea
                  id="bookerNotes"
                  rows={3}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="What would you like to discuss?"
                  data-testid="input-booker-notes"
                />
              </div>

              {/* Honeypot — invisible to humans, irresistible to bots. */}
              <div aria-hidden="true" style={{ position: "absolute", left: "-9999px" }}>
                <label>
                  Website
                  <input
                    type="text"
                    tabIndex={-1}
                    autoComplete="off"
                    value={website}
                    onChange={(e) => setWebsite(e.target.value)}
                  />
                </label>
              </div>

              {recurrence && recurrenceSummary && (
                <div
                  className="rounded border bg-muted/30 p-2 text-xs text-muted-foreground"
                  data-testid="text-recurrence-summary-side"
                >
                  Recurring: {recurrenceSummary}
                </div>
              )}

              {recurrence && pagePreviewError && (
                <div
                  className="rounded border border-status-warn/30 bg-status-warn/10 px-3 py-2 text-sm text-status-warn"
                  role="status"
                  data-testid="banner-recurrence-preview-error"
                >
                  {pagePreviewError}
                </div>
              )}

              {recurrence && hasRecurrenceConflicts && (
                <div
                  className="rounded border border-status-critical/30 bg-status-critical/10 px-3 py-2 text-sm text-status-critical"
                  role="status"
                  data-testid="banner-recurrence-conflicts"
                >
                  This recurring schedule has conflicts on {conflictCount} date
                  {conflictCount === 1 ? "" : "s"}. Please adjust the recurrence
                  or choose a different time.
                </div>
              )}

              {recurrence && zoomFallback && (
                <div
                  className="rounded border border-status-info/30 bg-status-info/10 px-3 py-2 text-sm text-status-info"
                  data-testid="banner-zoom-fallback-notice"
                >
                  {ZOOM_FALLBACK_NOTICE}
                </div>
              )}

              {confirm.error && (
                <div
                  className="rounded border border-status-critical/30 bg-status-critical/10 px-3 py-2 text-sm text-status-critical"
                  role="alert"
                  data-testid="text-booking-error"
                >
                  {(confirm.error as Error).message}
                </div>
              )}

              <Button
                type="button"
                onClick={() => confirm.mutate()}
                disabled={confirmDisabled}
                className="w-full bg-primary hover:bg-primary/90"
                aria-describedby={confirmHint ? "confirm-hint" : undefined}
                data-testid="button-confirm-booking"
              >
                {confirm.isPending ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Booking…
                  </>
                ) : (
                  "Confirm booking"
                )}
              </Button>
              {confirmHint && (
                <p
                  id="confirm-hint"
                  className="text-caption text-muted-foreground"
                  data-testid="text-confirm-hint"
                >
                  {confirmHint}
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
