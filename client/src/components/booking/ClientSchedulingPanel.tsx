import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  RadioGroup,
  RadioGroupItem,
} from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import {
  Loader2,
  Calendar,
  Copy,
  Link2,
  Clock,
  ExternalLink,
  UserPlus,
  Star,
  ChevronLeft,
  ChevronRight,
  Repeat,
  AlertTriangle,
  Pencil,
  Trash2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { useDisplayTimezone } from "@/lib/displayTimezone";
import { RecurrenceBuilder, type RecurrenceBuilderNormalized } from "@/components/booking/RecurrenceBuilder";
import type {
  RecurrencePayload,
  RecurrenceConflict,
  RecurrencePreviewOccurrence,
  RecurrenceExceptionScope,
} from "@shared/models/booking";

type Slot = { startUtc: string; endUtc: string; dateLocal: string; timeLocal: string };

type BookingPage = {
  // null when the AM hasn't saved a page yet — server returns a draft
  // pre-filled with sensible defaults so the panel can render and book
  // immediately (Task #887).
  id: string | null;
  slug: string;
  durationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  timezone: string;
  isDefault?: boolean;
};

type ClientContact = {
  id: string;
  clientId: string;
  name: string;
  emails: string[] | null;
  phones: string[] | null;
  roleTitle: string | null;
  isPrimary: boolean;
};

type Meeting = {
  id: string;
  startTimeUtc: string;
  endTimeUtc: string;
  status: string;
  inviteeEmail: string;
  inviteeName: string | null;
  zoomJoinUrl: string | null;
  googleCalendarEventUrl: string | null;
  matchMethod: string | null;
  meetingTypeName: string | null;
  // Recurrence metadata (Task #1032A). All nullable on one-off bookings.
  recurrence: string[] | null;
  recurrenceSummary: string | null;
  recurrenceTimezone: string | null;
  seriesMasterId: string | null;
  recurringEventId: string | null;
  zoomRecurrenceMode: string | null;
  zoomRecurrenceFallbackReason: string | null;
};

type MeetingType = {
  id: string;
  name: string;
  durationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
};

interface Props {
  clientId: string;
  defaultInviteeEmail?: string;
  defaultInviteeName?: string;
}

// Preset meeting lengths offered in the per-meeting picker. The same
// 15–240 bound the server validates is enforced visually by the preset
// list, plus the page's saved duration is added so the AM always sees
// "their" default option (e.g. if they saved 25min on the booking page
// the picker still shows it).
const LENGTH_PRESETS = [15, 30, 45, 60, 90];

function makeIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function clampBuffer(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(120, Math.max(0, Math.round(value)));
}

export default function ClientSchedulingPanel({
  clientId,
  defaultInviteeEmail = "",
  defaultInviteeName = "",
}: Props) {
  const { toast } = useToast();
  const qc = useQueryClient();

  // The Schedule panel renders inline failure messages for slot /
  // meetings load errors, so we silence the global "Request failed"
  // toast on these queries (Task #860). The booking-page query also
  // distinguishes the "schema not installed" 503 from a normal
  // page-fetch so we can show an unavailable state instead of misleading
  // copy.
  //
  // Task #887: the server now returns a default draft (with `isDefault:
  // true`) when the AM has no saved page yet, so we no longer gate the
  // panel on the page existing — the AM can book on a client's behalf
  // out of the box.
  const {
    data: pageData,
    error: pageError,
    isLoading: pageLoading,
  } = useQuery<
    { page: BookingPage | null; recurrenceFeatureEnabled?: boolean },
    Error & { code?: string; status?: number }
  >({
    queryKey: ["/api/booking/me/page"],
    queryFn: async () => {
      const res = await fetch("/api/booking/me/page", { credentials: "include" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const err = new Error(
          body?.message || body?.error || `Failed to load (${res.status})`,
        ) as Error & { code?: string; status?: number };
        err.code = body?.error;
        err.status = res.status;
        throw err;
      }
      return res.json();
    },
    meta: { silent: true },
  });

  const page = pageData?.page || null;
  // Task #1044: when the recurring-meetings feature is disabled
  // server-side (`booking_recurring_enabled` master OR
  // `booking_recurring_internal_enabled`), the toggle and builder
  // hide entirely. Default to true so a missing field (legacy
  // response shape) keeps the prior behavior.
  const recurrenceFeatureEnabled = pageData?.recurrenceFeatureEnabled !== false;

  // Date-range navigator. Defaults to "next 14 days" but the AM can
  // shift earlier/later or widen the window up to 90 days so they can
  // book multiple months out from the same panel. The server caps the
  // window at 90 days to bound free/busy query cost.
  const RANGE_OPTIONS = [
    { label: "2 weeks", days: 14 },
    { label: "1 month", days: 30 },
    { label: "2 months", days: 60 },
    { label: "3 months", days: 90 },
  ];
  const [rangeDays, setRangeDays] = useState<number>(14);
  const [windowStartMs, setWindowStartMs] = useState<number>(() => Date.now());

  const fromIso = useMemo(
    () => new Date(windowStartMs).toISOString(),
    [windowStartMs],
  );
  const toIso = useMemo(
    () =>
      new Date(windowStartMs + rangeDays * 24 * 60 * 60 * 1000).toISOString(),
    [windowStartMs, rangeDays],
  );

  const windowLabel = useMemo(() => {
    const start = new Date(windowStartMs);
    const end = new Date(windowStartMs + rangeDays * 24 * 60 * 60 * 1000);
    const fmt = (d: Date) =>
      d.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year:
          d.getFullYear() !== new Date().getFullYear() ? "numeric" : undefined,
      });
    return `${fmt(start)} – ${fmt(end)}`;
  }, [windowStartMs, rangeDays]);

  // Disable "Earlier" whenever the window can't actually move back —
  // i.e. when it's already clamped at (or within one minute of) "now".
  // This must match the floor used in `shiftWindow` below so the button
  // never appears enabled while clicking it would be a no-op.
  const isAtToday = windowStartMs <= Date.now() + 60 * 1000;
  const shiftWindow = (deltaDays: number) => {
    setWindowStartMs((prev) => {
      const next = prev + deltaDays * 24 * 60 * 60 * 1000;
      // Don't let the user page back before today.
      return Math.max(next, Date.now());
    });
  };
  // Task #1033: prefer the user's saved display timezone (explicit pick
  // in Profile or seeded from their Google Calendar) over the browser-
  // detected zone, so an AM never sees their meetings rendered in the
  // wrong zone with no way to override.
  const displayTimezone = useDisplayTimezone();
  const viewerTimezone = displayTimezone.timezone;

  // Per-meeting overrides. Default to the saved page values so the AM
  // always sees "their" length / buffers first, but every change
  // refetches the slots query and is sent on the book mutation so the
  // saga uses the same numbers it offered.
  const [duration, setDuration] = useState<number>(30);
  const [bufferBefore, setBufferBefore] = useState<number>(0);
  const [bufferAfter, setBufferAfter] = useState<number>(0);
  // Track whether the user has interacted with the controls so we don't
  // overwrite their picks every time the page query refetches.
  const [overridesTouched, setOverridesTouched] = useState(false);
  // Currently picked saved meeting type (Task #890). When set, the
  // booked record persists `meetingTypeId` + name so the meetings list
  // can show which preset was used.
  const [selectedMeetingTypeId, setSelectedMeetingTypeId] =
    useState<string | null>(null);

  // Load the AM's saved meeting types so we can render preset chips
  // above the manual length/buffer controls.
  const { data: meetingTypesData } = useQuery<{
    meetingTypes: MeetingType[];
  }>({
    queryKey: ["/api/booking/me/meeting-types"],
    meta: { silent: true },
  });
  const meetingTypes = meetingTypesData?.meetingTypes || [];

  const pickMeetingType = (mt: MeetingType) => {
    setOverridesTouched(true);
    setSelectedMeetingTypeId(mt.id);
    setDuration(mt.durationMinutes);
    setBufferBefore(mt.bufferBeforeMinutes);
    setBufferAfter(mt.bufferAfterMinutes);
  };
  useEffect(() => {
    if (!page || overridesTouched) return;
    setDuration(page.durationMinutes);
    setBufferBefore(page.bufferBeforeMinutes);
    setBufferAfter(page.bufferAfterMinutes);
  }, [page, overridesTouched]);

  // Length picker options: the preset list plus the page's saved
  // length if it isn't already in the presets, so the AM never has to
  // hunt for "their" default.
  const lengthOptions = useMemo(() => {
    const set = new Set<number>(LENGTH_PRESETS);
    if (page?.durationMinutes) set.add(page.durationMinutes);
    if (duration) set.add(duration);
    return Array.from(set).sort((a, b) => a - b);
  }, [page?.durationMinutes, duration]);

  const {
    data: slotsData,
    isLoading: slotsLoading,
    error: slotsError,
  } = useQuery<
    { slots: Slot[] },
    Error & { code?: string; status?: number; retriable?: boolean }
  >({
    queryKey: [
      `/api/booking/clients/${clientId}/slots`,
      fromIso,
      toIso,
      viewerTimezone,
      duration,
      bufferBefore,
      bufferAfter,
    ],
    queryFn: async () => {
      const params = new URLSearchParams({
        from: fromIso,
        to: toIso,
        viewerTimezone,
        durationMinutes: String(duration),
        bufferBeforeMinutes: String(bufferBefore),
        bufferAfterMinutes: String(bufferAfter),
      });
      const res = await fetch(
        `/api/booking/clients/${clientId}/slots?${params.toString()}`,
        { credentials: "include" },
      );
      if (!res.ok) {
        // Surface the server's error code / message so the panel can
        // tell a fail-closed Calendar outage apart from a real bug,
        // and so operators have something searchable in browser logs.
        const body = await res.json().catch(() => ({}));
        const err = new Error(
          body?.error || body?.message || `Failed to load slots (${res.status})`,
        ) as Error & { code?: string; status?: number; retriable?: boolean };
        err.code = body?.code || body?.error;
        err.status = res.status;
        err.retriable = !!body?.retriable;
        throw err;
      }
      return res.json();
    },
    enabled: !!page && !!duration,
    meta: { silent: true },
  });

  const { data: meetingsData, error: meetingsError } = useQuery<{ meetings: Meeting[] }>({
    queryKey: [`/api/booking/clients/${clientId}/meetings`],
    queryFn: async () => {
      const res = await fetch(`/api/booking/clients/${clientId}/meetings`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    meta: { silent: true },
  });

  // Pull the client's saved contacts using the same query key as the
  // Contacts panel so the picker stays in sync after edits there.
  const { data: contacts = [], isLoading: contactsLoading } = useQuery<
    ClientContact[]
  >({
    queryKey: [`/api/clients/${clientId}/contacts`],
  });

  const schemaNotReady =
    pageError?.code === "booking_schema_not_ready" || pageError?.status === 503;

  const slotsByDay = useMemo(() => {
    const m = new Map<string, Slot[]>();
    (slotsData?.slots || []).forEach((s) => {
      if (!m.has(s.dateLocal)) m.set(s.dateLocal, []);
      m.get(s.dateLocal)!.push(s);
    });
    return Array.from(m.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [slotsData]);

  const [selected, setSelected] = useState<Slot | null>(null);
  const [email, setEmail] = useState(defaultInviteeEmail);
  const [name, setName] = useState(defaultInviteeName);
  const [phone, setPhone] = useState("");
  const [showPhoneField, setShowPhoneField] = useState(false);

  // Flatten saved contacts into one option per (contact, email). A
  // contact with multiple emails surfaces each address separately so
  // the AM picks exactly which one to invite.
  const contactOptions = useMemo(() => {
    const opts: Array<{
      key: string;
      contactId: string;
      name: string;
      email: string;
      hasMultiple: boolean;
      roleTitle: string | null;
      isPrimary: boolean;
      isPrimaryFirstEmail: boolean;
    }> = [];
    contacts.forEach((c) => {
      const emails = (c.emails || [])
        .map((e) => e.trim())
        .filter((e) => e.length > 0);
      emails.forEach((e, idx) => {
        opts.push({
          key: `${c.id}|${e.toLowerCase()}`,
          contactId: c.id,
          name: c.name,
          email: e,
          hasMultiple: emails.length > 1,
          roleTitle: c.roleTitle,
          isPrimary: c.isPrimary,
          isPrimaryFirstEmail: c.isPrimary && idx === 0,
        });
      });
    });
    return opts;
  }, [contacts]);

  // When the form opens with no email prefilled and the client has a
  // primary contact with at least one email, auto-pick the primary's
  // first email so the AM doesn't have to re-select the most common
  // case. Runs once per (clientId, prefill) combination — manual edits
  // afterward are preserved because we only fire when the field is
  // still empty.
  const [autoPrimaryApplied, setAutoPrimaryApplied] = useState(false);
  useEffect(() => {
    setAutoPrimaryApplied(false);
  }, [clientId, defaultInviteeEmail]);
  useEffect(() => {
    if (autoPrimaryApplied) return;
    if (defaultInviteeEmail) return;
    if (email.trim()) return;
    const primary = contactOptions.find((o) => o.isPrimaryFirstEmail);
    if (!primary) return;
    setName(primary.name);
    setEmail(primary.email);
    setAutoPrimaryApplied(true);
  }, [autoPrimaryApplied, contactOptions, defaultInviteeEmail, email]);

  // Drive the picker's selected value off the form fields so manual
  // edits to the email input naturally update which option is shown
  // as selected (or clear it).
  const selectedOptionKey = useMemo(() => {
    const lower = email.trim().toLowerCase();
    if (!lower) return "";
    const match = contactOptions.find((o) => o.email.toLowerCase() === lower);
    return match?.key || "";
  }, [contactOptions, email]);

  const handlePickContact = (key: string) => {
    const opt = contactOptions.find((o) => o.key === key);
    if (!opt) return;
    setName(opt.name);
    setEmail(opt.email);
  };

  const trimmedEmail = email.trim();
  const emailMatchesSavedContact = useMemo(() => {
    if (!trimmedEmail) return false;
    const lower = trimmedEmail.toLowerCase();
    return contacts.some((c) =>
      (c.emails || []).some((e) => e.trim().toLowerCase() === lower),
    );
  }, [contacts, trimmedEmail]);
  // Cheap email sanity check just for enabling the "save" action — the
  // server still validates on insert.
  const emailLooksValid = /.+@.+\..+/.test(trimmedEmail);

  const trimmedPhone = phone.trim();
  const saveContact = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/clients/${clientId}/contacts`, {
        name: name.trim() || trimmedEmail,
        emails: [trimmedEmail],
        ...(trimmedPhone ? { phones: [trimmedPhone] } : {}),
        isPrimary: contacts.length === 0,
      });
      return res.json();
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [`/api/clients/${clientId}/contacts`] }); // fire-and-forget: cache refresh only
      setPhone("");
      setShowPhoneField(false);
      toast({ title: "Contact saved" });
    },
    onError: (err: any) => {
      toast({
        title: "Could not save contact",
        description: err.message,
        variant: "destructive",
      });
    },
  });
  // Stable per-mount idempotency key so a network retry, double-tap, or
  // React StrictMode re-render cannot fire two `bookSlot` requests with
  // different keys (which would race past the saga's idempotency dedupe
  // and surface a `slot_taken` instead of returning the existing booking).
  // Cleared on success below so the next booking attempt gets a fresh key.
  const [idempotencyKey, setIdempotencyKey] = useState(() => makeIdempotencyKey());

  // Re-pick a slot when the override duration / buffers change so we
  // never submit a slot start that's no longer in the recomputed list.
  useEffect(() => {
    setSelected(null);
  }, [duration, bufferBefore, bufferAfter]);

  // ---------- Recurrence (Task #1032G) ----------
  // The toggle defaults off — one-off booking UX is unchanged unless the
  // AM explicitly opts in. When on, the slot grid switches semantics:
  // the picked slot becomes the series start and we expand it into N
  // occurrences server-side via /preview-availability so we can render
  // a per-occurrence conflict list and disable Confirm if anything
  // conflicts.
  const [recurrenceEnabled, setRecurrenceEnabled] = useState(false);
  const [recurrencePayload, setRecurrencePayload] =
    useState<RecurrencePayload | null>(null);
  const [recurrenceSummary, setRecurrenceSummary] = useState<string>("");
  const [previewState, setPreviewState] = useState<{
    occurrences: RecurrencePreviewOccurrence[];
    conflicts: RecurrenceConflict[];
    truncated: boolean;
  } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const recurrenceTimezone = page?.timezone || viewerTimezone;

  // Reset preview & selection when the toggle flips so we never carry
  // stale conflict info across modes.
  useEffect(() => {
    setPreviewState(null);
    setPreviewError(null);
    setPreviewLoading(false);
    if (!recurrenceEnabled) {
      setRecurrencePayload(null);
      setRecurrenceSummary("");
    }
  }, [recurrenceEnabled]);

  const handleRecurrenceChange = (
    payload: RecurrencePayload | null,
    normalized?: RecurrenceBuilderNormalized,
  ) => {
    setRecurrencePayload(payload);
    setRecurrenceSummary(normalized?.summary || payload?.summary || "");
  };

  // Debounced server-side preview-availability call. Re-runs whenever
  // the picked first-occurrence start, the recurrence rule, or the
  // effective length / buffers change.
  useEffect(() => {
    if (!recurrenceEnabled || !recurrencePayload || !selected) {
      setPreviewState(null);
      setPreviewError(null);
      setPreviewLoading(false);
      return;
    }
    let cancelled = false;
    setPreviewLoading(true);
    setPreviewError(null);
    const startUtc = selected.startUtc;
    const t = window.setTimeout(async () => {
      try {
        const res = await fetch(
          "/api/booking/recurrence/preview-availability",
          {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              startTimeUtc: startUtc,
              recurrence: recurrencePayload,
              durationMinutes: duration,
              bufferBeforeMinutes: bufferBefore,
              bufferAfterMinutes: bufferAfter,
            }),
          },
        );
        let json: any = {};
        try {
          json = await res.json();
        } catch {
          /* tolerate */
        }
        if (cancelled) return;
        if (!res.ok) {
          setPreviewError(
            json?.error ||
              `Could not preview occurrences (${res.status}). Please try again.`,
          );
          setPreviewState(null);
        } else {
          setPreviewState({
            occurrences: json.occurrences ?? [],
            conflicts: json.conflicts ?? [],
            truncated: !!json.truncated,
          });
        }
      } catch (err: any) {
        if (cancelled) return;
        setPreviewError(err?.message || "Could not preview occurrences.");
        setPreviewState(null);
      } finally {
        if (!cancelled) setPreviewLoading(false);
      }
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [
    recurrenceEnabled,
    recurrencePayload,
    selected,
    duration,
    bufferBefore,
    bufferAfter,
  ]);

  const conflictCount = previewState?.conflicts.length ?? 0;
  const occurrenceCount = previewState?.occurrences.length ?? 0;
  const conflictByStart = useMemo(() => {
    const m = new Map<string, RecurrenceConflict>();
    for (const c of previewState?.conflicts ?? []) m.set(c.startUtc, c);
    return m;
  }, [previewState]);

  const book = useMutation({
    mutationFn: async () => {
      if (!selected) throw new Error("Pick a time");
      if (!email) throw new Error("Invitee email required");
      if (recurrenceEnabled && !recurrencePayload) {
        throw new Error("Finish setting the recurrence first.");
      }
      const res = await apiRequest("POST", `/api/booking/clients/${clientId}/book`, {
        startTimeUtc: selected.startUtc,
        inviteeEmail: email,
        inviteeName: name || undefined,
        idempotencyKey,
        // Send the same effective values used to compute the slot list
        // so the saga's pre-lock and post-lock availability checks both
        // see the same window the slot was offered against.
        durationMinutes: duration,
        bufferBeforeMinutes: bufferBefore,
        bufferAfterMinutes: bufferAfter,
        meetingTypeId: selectedMeetingTypeId || undefined,
        recurrence: recurrenceEnabled ? recurrencePayload : undefined,
      });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Booking created" });
      setSelected(null);
      // Clear recurrence so the next booking starts clean.
      setRecurrenceEnabled(false);
      setRecurrencePayload(null);
      setRecurrenceSummary("");
      // Rotate the idempotency key so any subsequent booking from this
      // panel is treated as a brand-new request, not a dedupe of the
      // one we just confirmed.
      setIdempotencyKey(makeIdempotencyKey());
      void qc.invalidateQueries({ queryKey: [`/api/booking/clients/${clientId}/meetings`] }); // fire-and-forget: cache refresh only
      // Lazy-create may have just persisted the booking page on the
      // server — refetch so other surfaces (e.g. the BookingSettingsPanel
      // share-link button) see the real row.
      void qc.invalidateQueries({ queryKey: ["/api/booking/me/page"] }); // fire-and-forget: cache refresh only
    },
    onError: (err: any) => {
      const mapped = describeBookingError(err);
      toast({
        title: mapped.title,
        description: mapped.description,
        variant: "destructive",
      });
    },
  });

  // Reused by the slot-list "Reconnect Google Calendar" banner
  // when the slots query returns `calendar_reauth_required`.
  // Mirrors the mutation in BookingSettingsPanel so AMs don't have to
  // navigate to Profile just to fix a dead Calendar credential.
  const connectCalendar = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/integrations/google-calendar/authorize", {
        credentials: "include",
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || "Failed to start Calendar OAuth");
      }
      return res.json() as Promise<{ url: string }>;
    },
    onSuccess: (data) => {
      window.location.href = data.url;
    },
    onError: (err: any) => {
      toast({
        title: "Calendar connection failed",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  // ---------- Recurring meeting Edit / Cancel (Task #1032G) ----------
  // The scope picker dialog is reused for both edit and cancel — the
  // shape is `{ meeting, mode }` where mode is "edit" or "cancel".
  const [scopeDialog, setScopeDialog] = useState<{
    meeting: Meeting;
    mode: "edit" | "cancel";
  } | null>(null);

  const editMeeting = useMutation({
    mutationFn: async (args: {
      meetingId: string;
      scope: RecurrenceExceptionScope;
      originalStartTime?: string;
      changes: { startTimeUtc?: string; durationMinutes?: number };
    }) => {
      const res = await apiRequest("PATCH", `/api/booking/${args.meetingId}`, {
        scope: args.scope,
        originalStartTime: args.originalStartTime,
        changes: args.changes,
      });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Meeting updated" });
      setScopeDialog(null);
      void qc.invalidateQueries({
        queryKey: [`/api/booking/clients/${clientId}/meetings`],
      }); // fire-and-forget: cache refresh only
    },
    onError: (err: any) => {
      const mapped = describeBookingError(err, "Could not update meeting");
      toast({
        title: mapped.title,
        description: mapped.description,
        variant: "destructive",
      });
    },
  });

  const cancelMeeting = useMutation({
    mutationFn: async (args: {
      meetingId: string;
      scope: RecurrenceExceptionScope;
      originalStartTime?: string;
      reason?: string;
    }) => {
      const body = {
        scope: args.scope,
        originalStartTime: args.originalStartTime,
        reason: args.reason,
      };
      const res = await apiRequest(
        "DELETE",
        `/api/booking/${args.meetingId}`,
        body,
      );
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Meeting canceled" });
      setScopeDialog(null);
      void qc.invalidateQueries({
        queryKey: [`/api/booking/clients/${clientId}/meetings`],
      }); // fire-and-forget: cache refresh only
    },
    onError: (err: any) => {
      const mapped = describeBookingError(err, "Could not cancel meeting");
      toast({
        title: mapped.title,
        description: mapped.description,
        variant: "destructive",
      });
    },
  });

  const issueLink = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/booking/me/client-links", {
        clientId,
        expiresInDays: 14,
      });
      return res.json() as Promise<{ url: string }>;
    },
    onSuccess: async (data) => {
      try {
        await navigator.clipboard.writeText(data.url);
        toast({ title: "Client booking link copied", description: data.url });
      } catch {
        toast({ title: "Link created", description: data.url });
      }
    },
    onError: (err: any) => {
      toast({ title: "Failed", description: err.message, variant: "destructive" });
    },
  });

  // Loading: render the same shell so we don't briefly flash the
  // unavailable card while the page query is in flight.
  if (pageLoading) {
    return (
      <Card data-testid="card-client-scheduling-loading">
        <CardHeader>
          <CardTitle className="text-lg">Scheduling</CardTitle>
          <CardDescription>Loading…</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  // Booking schema not installed in this environment — show an
  // explicit "temporarily unavailable" card. Operators see the
  // actionable code in the server logs and the booking health endpoint.
  if (schemaNotReady) {
    return (
      <Card data-testid="card-client-scheduling-unavailable">
        <CardHeader>
          <CardTitle className="text-lg">Scheduling</CardTitle>
          <CardDescription data-testid="text-scheduling-unavailable">
            Scheduling is temporarily unavailable. Please try again shortly — if the
            issue persists, contact an administrator.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  // The server always returns a page (real or default-draft) when the
  // schema is ready, so this branch only fires when the request itself
  // failed for an unrelated reason.
  if (!page) {
    return (
      <Card data-testid="card-client-scheduling-error">
        <CardHeader>
          <CardTitle className="text-lg">Scheduling</CardTitle>
          <CardDescription>
            Could not load your booking page right now. Please try again shortly.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card data-testid="card-client-scheduling">
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Calendar className="w-5 h-5" /> Book a meeting
          </CardTitle>
          <CardDescription>
            Schedule directly on this client's behalf or send them a one-time booking link.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1">
            <Label htmlFor="bkContactPicker">Saved contact</Label>
            {contactsLoading ? (
              <p
                className="text-sm text-muted-foreground"
                data-testid="text-loading-saved-contacts"
              >
                Loading saved contacts…
              </p>
            ) : contactOptions.length === 0 ? (
              <p
                className="text-sm text-muted-foreground"
                data-testid="text-no-saved-contacts"
              >
                No saved contacts — add one from the Contacts tab or just type a
                name and email below.
              </p>
            ) : (
              <Select
                value={selectedOptionKey || undefined}
                onValueChange={handlePickContact}
              >
                <SelectTrigger
                  id="bkContactPicker"
                  data-testid="select-client-contact"
                >
                  <SelectValue placeholder="Pick a saved contact…" />
                </SelectTrigger>
                <SelectContent>
                  {contactOptions.map((opt) => (
                    <SelectItem
                      key={opt.key}
                      value={opt.key}
                      data-testid={`option-client-contact-${opt.contactId}-${opt.email.toLowerCase()}`}
                    >
                      <span className="flex items-center gap-1.5 flex-wrap">
                        <span className="font-medium">{opt.name}</span>
                        {opt.isPrimary && (
                          <Badge
                            variant="secondary"
                            className="text-[10px] px-1 py-0 h-4"
                            data-testid={`badge-contact-primary-${opt.contactId}-${opt.email.toLowerCase()}`}
                          >
                            <Star className="h-2.5 w-2.5 mr-0.5" /> Primary
                          </Badge>
                        )}
                        {opt.roleTitle && (
                          <span
                            className="text-xs text-muted-foreground"
                            data-testid={`text-contact-role-${opt.contactId}-${opt.email.toLowerCase()}`}
                          >
                            {opt.roleTitle}
                          </span>
                        )}
                        <span className="text-xs text-muted-foreground">
                          {opt.hasMultiple ? `(${opt.email})` : `— ${opt.email}`}
                        </span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <Label htmlFor="bkInviteeName">Invitee name</Label>
              <Input
                id="bkInviteeName"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Jane Doe"
                data-testid="input-client-invitee-name"
              />
            </div>
            <div>
              <Label htmlFor="bkInviteeEmail">Invitee email</Label>
              <Input
                id="bkInviteeEmail"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="jane@company.com"
                data-testid="input-client-invitee-email"
              />
            </div>
          </div>
          {trimmedEmail && !emailMatchesSavedContact && (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => saveContact.mutate()}
                disabled={!emailLooksValid || saveContact.isPending}
                data-testid="button-save-invitee-contact"
              >
                {saveContact.isPending ? (
                  <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                ) : (
                  <UserPlus className="w-3.5 h-3.5 mr-1.5" />
                )}
                Save to contacts
              </Button>
              {showPhoneField ? (
                <Input
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="Invitee phone (optional)"
                  className="h-8 w-56"
                  data-testid="input-client-invitee-phone"
                />
              ) : (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowPhoneField(true)}
                  data-testid="button-add-invitee-phone"
                >
                  + Add phone
                </Button>
              )}
            </div>
          )}

          {/*
            Saved meeting type chips (Task #890). One-click presets that
            fill in the length + buffers below and stamp the booked row
            with which preset was used. Any manual edit to the controls
            below clears the picked chip so we don't lie about which
            preset was applied.
          */}
          {meetingTypes.length > 0 && (
            <div data-testid="section-meeting-type-presets">
              <Label className="text-xs text-muted-foreground">
                Meeting type
              </Label>
              <div className="flex flex-wrap gap-2 mt-1">
                {meetingTypes.map((mt) => {
                  const isSel = selectedMeetingTypeId === mt.id;
                  return (
                    <Button
                      key={mt.id}
                      type="button"
                      size="sm"
                      variant={isSel ? "default" : "outline"}
                      onClick={() => pickMeetingType(mt)}
                      data-testid={`button-meeting-type-${mt.id}`}
                      title={`${mt.durationMinutes} min · buffers ${mt.bufferBeforeMinutes}/${mt.bufferAfterMinutes}`}
                    >
                      {mt.name}
                    </Button>
                  );
                })}
                {selectedMeetingTypeId && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setSelectedMeetingTypeId(null)}
                    data-testid="button-clear-meeting-type"
                  >
                    Clear
                  </Button>
                )}
              </div>
            </div>
          )}

          {/*
            Per-meeting overrides (Task #887). Defaults to the saved
            booking page values; any change refetches the slots query
            and is sent on the book mutation. Public `/book/:slug` is
            not affected — invitees still see the saved page values.
          */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <Label htmlFor="bkDuration">Meeting length</Label>
              <Select
                value={String(duration)}
                onValueChange={(v) => {
                  setOverridesTouched(true);
                  setSelectedMeetingTypeId(null);
                  setDuration(Number(v) || 30);
                }}
              >
                <SelectTrigger
                  id="bkDuration"
                  data-testid="select-meeting-length"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {lengthOptions.map((mins) => (
                    <SelectItem
                      key={mins}
                      value={String(mins)}
                      data-testid={`option-meeting-length-${mins}`}
                    >
                      {mins} min
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="bkBufferBefore">Buffer before (min)</Label>
              <Input
                id="bkBufferBefore"
                type="number"
                min={0}
                max={120}
                step={5}
                value={bufferBefore}
                onChange={(e) => {
                  setOverridesTouched(true);
                  setSelectedMeetingTypeId(null);
                  setBufferBefore(clampBuffer(Number(e.target.value)));
                }}
                data-testid="input-meeting-buffer-before"
              />
            </div>
            <div>
              <Label htmlFor="bkBufferAfter">Buffer after (min)</Label>
              <Input
                id="bkBufferAfter"
                type="number"
                min={0}
                max={120}
                step={5}
                value={bufferAfter}
                onChange={(e) => {
                  setOverridesTouched(true);
                  setSelectedMeetingTypeId(null);
                  setBufferAfter(clampBuffer(Number(e.target.value)));
                }}
                data-testid="input-meeting-buffer-after"
              />
            </div>
          </div>

          {/* Recurrence (Task #1032G) — toggle defaults off so the
              one-off booking UX is unchanged unless the AM opts in.
              Task #1044: hidden entirely when the feature is
              administratively disabled (master or internal flag off). */}
          {recurrenceFeatureEnabled && (
          <div
            className="rounded-md border p-3 space-y-3"
            data-testid="section-recurrence"
          >
            <div className="flex items-center justify-between">
              <div>
                <Label
                  htmlFor="recurringMeetingToggle"
                  className="text-sm font-medium flex items-center gap-1.5"
                >
                  <Repeat className="w-4 h-4" />
                  Recurring meeting
                </Label>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Book this same time on a repeating schedule. The picked
                  slot below becomes the first occurrence.
                </p>
              </div>
              <Switch
                id="recurringMeetingToggle"
                checked={recurrenceEnabled}
                onCheckedChange={(v) => setRecurrenceEnabled(!!v)}
                data-testid="switch-recurring-meeting"
              />
            </div>

            {recurrenceEnabled && (
              <RecurrenceBuilder
                value={recurrencePayload}
                timezone={recurrenceTimezone}
                onChange={handleRecurrenceChange}
                variant="internal"
                mode="local"
                dtstart={selected ? new Date(selected.startUtc) : null}
                durationMinutes={duration}
                bufferBeforeMinutes={bufferBefore}
                bufferAfterMinutes={bufferAfter}
              />
            )}
          </div>
          )}

          <div>
            <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
              <div className="text-sm font-medium flex items-center gap-2 flex-wrap">
                <Clock className="w-4 h-4" />
                {recurrenceEnabled ? "Pick the first occurrence" : "Available times"}
                <span
                  className="text-xs text-muted-foreground font-normal"
                  data-testid="text-slots-window-label"
                >
                  ({windowLabel})
                </span>
                {/* Task #1033: surface which timezone the slot grid /
                    meeting times are rendered in, plus where that
                    pick came from, so an AM is never confused about
                    what zone they're looking at. */}
                <span
                  className="text-xs text-muted-foreground font-normal"
                  data-testid="text-display-timezone-label"
                  title={
                    displayTimezone.source === "user"
                      ? "From your Profile timezone setting"
                      : displayTimezone.source === "google_calendar"
                        ? "From your connected Google Calendar"
                        : "Detected from this browser — set a timezone in Profile to override"
                  }
                >
                  · Times in {displayTimezone.timezone}
                  {displayTimezone.abbreviation
                    ? ` (${displayTimezone.abbreviation})`
                    : ""}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Select
                  value={String(rangeDays)}
                  onValueChange={(v) => setRangeDays(Number(v) || 14)}
                >
                  <SelectTrigger
                    className="h-8 w-[120px]"
                    data-testid="select-slots-range"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {RANGE_OPTIONS.map((opt) => (
                      <SelectItem
                        key={opt.days}
                        value={String(opt.days)}
                        data-testid={`option-slots-range-${opt.days}`}
                      >
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 px-2"
                  disabled={isAtToday}
                  onClick={() => shiftWindow(-rangeDays)}
                  data-testid="button-slots-earlier"
                  title="Earlier"
                >
                  <ChevronLeft className="w-4 h-4" />
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 px-2"
                  onClick={() => shiftWindow(rangeDays)}
                  data-testid="button-slots-later"
                  title="Later"
                >
                  <ChevronRight className="w-4 h-4" />
                </Button>
                {!isAtToday && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-8 px-2 text-xs"
                    onClick={() => setWindowStartMs(Date.now())}
                    data-testid="button-slots-today"
                  >
                    Today
                  </Button>
                )}
              </div>
            </div>
            {slotsLoading ? (
              <div className="text-sm text-muted-foreground">Loading…</div>
            ) : slotsError ? (
              slotsError.code === "calendar_reauth_required" ? (
                <div
                  className="rounded border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800"
                  data-testid="banner-calendar-reauth-required"
                  data-error-code={slotsError.code}
                >
                  <div className="font-medium">
                    Reconnect Google Calendar
                  </div>
                  <div className="mt-1 text-xs">
                    Your Google Calendar connection is no longer working
                    {slotsError.message ? ` — ${slotsError.message}` : ""}
                    . Reconnect to start showing available times again.
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    className="mt-2"
                    disabled={connectCalendar.isPending}
                    onClick={() => connectCalendar.mutate()}
                    data-testid="button-reconnect-calendar"
                  >
                    {connectCalendar.isPending ? (
                      <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                    ) : (
                      <Calendar className="w-3.5 h-3.5 mr-1.5" />
                    )}
                    Reconnect Google Calendar
                  </Button>
                  <div className="mt-1.5 text-xs">
                    <Link
                      href="/profile?tab=booking"
                      className="underline hover:text-rose-900"
                      data-testid="link-check-booking-settings"
                    >
                      Check settings in Profile
                    </Link>
                  </div>
                </div>
              ) : (
                <div
                  className="text-sm text-destructive"
                  data-testid="text-slots-error"
                  data-error-code={slotsError.code || ""}
                >
                  {slotsError.code === "calendar_unavailable"
                    ? "Could not load your calendar availability right now. Please try again in a moment."
                    : slotsError.message ||
                      "Could not load available times. Please try again shortly."}
                </div>
              )
            ) : slotsByDay.length === 0 ? (
              <div className="text-sm text-muted-foreground">
                No availability —{" "}
                <Link
                  href="/profile?tab=booking"
                  className="underline hover:text-foreground"
                  data-testid="link-adjust-availability-profile"
                >
                  adjust your weekly hours in Profile
                </Link>
                .
              </div>
            ) : (
              <div className="space-y-3 max-h-[60vh] overflow-y-auto pr-2">
                {slotsByDay.map(([dateLocal, daySlots]) => (
                  <div key={dateLocal}>
                    <div className="text-xs font-medium mb-1">{dateLocal}</div>
                    <div className="flex flex-wrap gap-1">
                      {daySlots.map((s) => {
                        const isSel = selected?.startUtc === s.startUtc;
                        const t = new Date(s.startUtc).toLocaleTimeString(undefined, {
                          hour: "numeric",
                          minute: "2-digit",
                          timeZone: viewerTimezone,
                        });
                        return (
                          <Button
                            key={s.startUtc}
                            type="button"
                            size="sm"
                            variant={isSel ? "default" : "outline"}
                            onClick={() => setSelected(s)}
                            data-testid={`button-client-slot-${s.startUtc}`}
                          >
                            {t}
                          </Button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Recurrence preview list (Task #1032G). Shows the upcoming
              expanded occurrences with a green/red conflict badge per
              row, plus a summary line and an explanation when Confirm
              is disabled because of conflicts. */}
          {recurrenceEnabled && recurrencePayload && selected && (
            <div
              className="rounded-md border p-3 space-y-2"
              data-testid="section-recurrence-preview"
            >
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="text-sm font-medium flex items-center gap-2">
                  <Repeat className="w-4 h-4" />
                  Upcoming occurrences
                </div>
                {previewLoading && (
                  <Loader2
                    className="w-4 h-4 animate-spin text-muted-foreground"
                    data-testid="spinner-recurrence-preview"
                  />
                )}
              </div>
              {recurrenceSummary && (
                <p
                  className="text-xs text-muted-foreground"
                  data-testid="text-recurrence-summary"
                >
                  {recurrenceSummary}
                </p>
              )}
              {previewError ? (
                <div
                  className="text-sm text-destructive"
                  data-testid="text-recurrence-preview-error"
                >
                  {previewError}
                </div>
              ) : previewState ? (
                <>
                  <div
                    className={
                      conflictCount > 0
                        ? "text-sm text-destructive font-medium"
                        : "text-sm text-emerald-700 font-medium"
                    }
                    data-testid="text-recurrence-conflict-summary"
                  >
                    {conflictCount > 0
                      ? `${conflictCount} of ${occurrenceCount} occurrences have conflicts`
                      : `All ${occurrenceCount} occurrences are available`}
                    {previewState.truncated ? " (truncated)" : ""}
                  </div>
                  <ul
                    className="space-y-1 max-h-48 overflow-y-auto pr-1"
                    data-testid="list-recurrence-occurrences"
                  >
                    {previewState.occurrences.map((occ) => {
                      const conflict = conflictByStart.get(occ.startUtc);
                      const label = new Date(occ.startUtc).toLocaleString(
                        undefined,
                        {
                          weekday: "short",
                          month: "short",
                          day: "numeric",
                          hour: "numeric",
                          minute: "2-digit",
                          timeZone: viewerTimezone,
                        },
                      );
                      return (
                        <li
                          key={occ.startUtc}
                          className="flex items-center justify-between gap-2 text-xs"
                          data-testid={`row-recurrence-occurrence-${occ.startUtc}`}
                        >
                          <span>{label}</span>
                          {conflict ? (
                            <Badge
                              variant="destructive"
                              data-testid={`badge-recurrence-conflict-${occ.startUtc}`}
                              title={conflict.reason}
                            >
                              <AlertTriangle className="w-3 h-3 mr-1" />
                              Conflict
                            </Badge>
                          ) : (
                            <Badge
                              variant="outline"
                              className="text-emerald-700 border-emerald-300"
                              data-testid={`badge-recurrence-ok-${occ.startUtc}`}
                            >
                              Available
                            </Badge>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </>
              ) : (
                !previewLoading && (
                  <p className="text-xs text-muted-foreground">
                    Pick a first-occurrence time above to preview the series.
                  </p>
                )
              )}
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => book.mutate()}
              disabled={
                !selected ||
                !email ||
                book.isPending ||
                (recurrenceEnabled &&
                  (!recurrencePayload ||
                    previewLoading ||
                    !!previewError ||
                    conflictCount > 0))
              }
              className="bg-primary hover:bg-primary/90"
              data-testid="button-book-for-client"
            >
              {book.isPending ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Calendar className="w-4 h-4 mr-2" />
              )}
              {recurrenceEnabled ? "Book recurring series" : "Book this slot"}
            </Button>
            {recurrenceEnabled && conflictCount > 0 && (
              <p
                className="w-full text-xs text-destructive"
                data-testid="text-recurrence-confirm-disabled"
              >
                Resolve the {conflictCount} conflicting occurrence
                {conflictCount === 1 ? "" : "s"} above (skip a date in the
                recurrence builder, or pick a different first occurrence)
                before confirming.
              </p>
            )}
            <Button
              variant="outline"
              onClick={() => issueLink.mutate()}
              disabled={issueLink.isPending}
              data-testid="button-copy-client-link"
            >
              {issueLink.isPending ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Link2 className="w-4 h-4 mr-2" />
              )}
              Copy 14-day client link
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card data-testid="card-client-meetings">
        <CardHeader>
          <CardTitle className="text-lg">Meetings on file</CardTitle>
        </CardHeader>
        <CardContent>
          {meetingsError ? (
            <div
              className="text-sm text-destructive"
              data-testid="text-meetings-error"
            >
              Meetings could not be loaded. Please try again shortly.
            </div>
          ) : !meetingsData?.meetings.length ? (
            <div className="text-sm text-muted-foreground">No OS-booked meetings yet.</div>
          ) : (
            <ul className="space-y-2">
              {meetingsData.meetings.map((m) => {
                const isRecurring =
                  !!m.seriesMasterId ||
                  !!m.recurringEventId ||
                  (m.recurrence?.length ?? 0) > 0;
                const isZoomFallback =
                  m.zoomRecurrenceMode === "static_link_fallback";
                return (
                <li
                  key={m.id}
                  className="flex flex-col gap-2 border rounded p-2 text-sm"
                  data-testid={`row-client-meeting-${m.id}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <div className="font-medium flex items-center gap-1.5 flex-wrap">
                        {new Date(m.startTimeUtc).toLocaleString(undefined, {
                          weekday: "short",
                          month: "short",
                          day: "numeric",
                          hour: "numeric",
                          minute: "2-digit",
                          timeZone: viewerTimezone,
                          timeZoneName: "short",
                        })}
                        {isRecurring && (
                          <Badge
                            variant="secondary"
                            className="text-[10px] px-1 py-0 h-4"
                            data-testid={`badge-recurring-${m.id}`}
                            title={m.recurrenceSummary || "Recurring meeting"}
                          >
                            <Repeat className="h-2.5 w-2.5 mr-0.5" />
                            Recurring
                          </Badge>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {m.inviteeName || m.inviteeEmail} · {m.status}
                        {m.meetingTypeName ? ` · ${m.meetingTypeName}` : ""}
                        {m.matchMethod ? ` · ${m.matchMethod}` : ""}
                      </div>
                      {isRecurring && m.recurrenceSummary && (
                        <div
                          className="text-xs text-muted-foreground mt-0.5"
                          data-testid={`text-recurrence-summary-${m.id}`}
                        >
                          {m.recurrenceSummary}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-1">
                      {isRecurring && (
                        <>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            onClick={() =>
                              setScopeDialog({ meeting: m, mode: "edit" })
                            }
                            data-testid={`button-edit-meeting-${m.id}`}
                            title="Edit recurring meeting"
                          >
                            <Pencil className="w-4 h-4" />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            onClick={() =>
                              setScopeDialog({ meeting: m, mode: "cancel" })
                            }
                            data-testid={`button-cancel-meeting-${m.id}`}
                            title="Cancel recurring meeting"
                          >
                            <Trash2 className="w-4 h-4 text-destructive" />
                          </Button>
                        </>
                      )}
                    {m.zoomJoinUrl && (
                      <>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={() => navigator.clipboard.writeText(m.zoomJoinUrl!)}
                          data-testid={`button-copy-join-${m.id}`}
                          title="Copy Zoom join link"
                        >
                          <Copy className="w-4 h-4" />
                        </Button>
                        <a
                          href={m.zoomJoinUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center justify-center h-9 w-9 rounded-md hover:bg-primary hover:text-primary-foreground text-sm"
                          data-testid={`link-zoom-join-${m.id}`}
                          title="Open Zoom meeting"
                        >
                          <ExternalLink className="w-4 h-4" />
                        </a>
                      </>
                    )}
                    {m.googleCalendarEventUrl && (
                      <a
                        href={m.googleCalendarEventUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center justify-center h-9 w-9 rounded-md hover:bg-primary hover:text-primary-foreground text-sm"
                        data-testid={`link-calendar-event-${m.id}`}
                        title="Open Google Calendar event"
                      >
                        <Calendar className="w-4 h-4" />
                      </a>
                    )}
                    </div>
                  </div>
                  {isZoomFallback && (
                    <div
                      className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900"
                      data-testid={`banner-zoom-fallback-${m.id}`}
                    >
                      <div className="font-medium">
                        Single Zoom link for the whole series
                      </div>
                      <div className="mt-0.5">
                        Zoom couldn't represent this exact recurrence
                        pattern, so a single reusable Zoom link is being
                        used for all occurrences.
                        {m.zoomRecurrenceFallbackReason
                          ? ` (${m.zoomRecurrenceFallbackReason})`
                          : ""}
                      </div>
                    </div>
                  )}
                </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <ScopePickerDialog
        state={scopeDialog}
        viewerTimezone={viewerTimezone}
        onClose={() => setScopeDialog(null)}
        onSubmitEdit={(args) => editMeeting.mutate(args)}
        onSubmitCancel={(args) => cancelMeeting.mutate(args)}
        editLoading={editMeeting.isPending}
        cancelLoading={cancelMeeting.isPending}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Booking error mapping (Task #1032G)
//
// `apiRequest` throws `Error("<status>: <body>")`. The server emits
// JSON like `{ error, code, message, ... }`. This helper parses that
// body and maps known recurrence/booking codes to friendly copy from
// the #1032 epic so the toast surfaces something useful instead of
// the raw "400: {...}" string.
// ---------------------------------------------------------------------------
const BOOKING_ERROR_COPY: Record<
  string,
  { title: string; description: string }
> = {
  recurrence_freebusy_conflict: {
    title: "Some occurrences conflict",
    description:
      "Some occurrences of this series conflict with existing meetings. Skip those dates in the recurrence builder or pick a different first occurrence.",
  },
  recurrence_not_allowed: {
    title: "Recurring meetings aren't allowed",
    description:
      "This booking link isn't configured to allow recurring meetings.",
  },
  recurrence_invalid_rrule: {
    title: "Recurrence rule is invalid",
    description:
      "The recurrence pattern couldn't be parsed. Adjust the rule and try again.",
  },
  recurrence_invalid_timezone: {
    title: "Recurrence timezone is invalid",
    description: "Pick a valid timezone for the recurrence and try again.",
  },
  recurrence_count_until_conflict: {
    title: "Recurrence has conflicting end conditions",
    description:
      "Use either an occurrence count or an end date — not both.",
  },
  recurrence_too_many_exdates: {
    title: "Too many skipped dates",
    description:
      "Reduce the number of skipped dates in the recurrence and try again.",
  },
  recurrence_horizon_exceeded: {
    title: "Recurrence runs too far into the future",
    description:
      "Shorten the recurrence (lower the count or move the end date closer) and try again.",
  },
  recurrence_expansion_limit_exceeded: {
    title: "Recurrence is too large",
    description:
      "This pattern would create too many occurrences. Lower the count or shorten the end date.",
  },
  recurrence_exdate_timezone_mismatch: {
    title: "Skipped dates don't match the recurrence timezone",
    description:
      "Re-select the skipped dates so they're in the same timezone as the recurrence.",
  },
  zoom_recurrence_not_representable: {
    title: "Zoom can't represent this recurrence",
    description:
      "Zoom couldn't model this exact pattern. The series will fall back to a single reusable Zoom link for all occurrences.",
  },
  calendar_reauth_required: {
    title: "Reconnect Google Calendar",
    description:
      "Your Google Calendar connection needs to be re-authorized before booking can continue.",
  },
  calendar_unavailable: {
    title: "Google Calendar is unavailable",
    description:
      "We couldn't reach Google Calendar. Try again in a moment.",
  },
};

function describeBookingError(
  err: unknown,
  fallbackTitle: string = "Booking failed",
): { title: string; description: string } {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  // apiRequest throws `${status}: ${body}` — peel the prefix off and
  // try to JSON-parse the remainder.
  const m = raw.match(/^\d+:\s*(.*)$/s);
  const body = m ? m[1] : raw;
  let parsed: any = null;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = null;
  }
  const code = parsed?.code as string | undefined;
  if (code && BOOKING_ERROR_COPY[code]) {
    const copy = BOOKING_ERROR_COPY[code];
    // Prefer the server's message over the canned description when it
    // adds detail (e.g. specific conflict reason), but always keep the
    // friendly title.
    const description =
      typeof parsed?.message === "string" && parsed.message.trim()
        ? parsed.message
        : copy.description;
    return { title: copy.title, description };
  }
  // Fall back to whatever readable text we have.
  const description =
    (typeof parsed?.message === "string" && parsed.message) ||
    (typeof parsed?.error === "string" && parsed.error) ||
    body ||
    raw ||
    "Please try again.";
  return { title: fallbackTitle, description };
}

// ---------------------------------------------------------------------------
// Scope picker dialog (Task #1032G)
//
// Reused for both Edit and Cancel actions on a recurring meeting row.
// Mirrors the three-option contract from the #1032 epic verbatim:
//   • This event only — Only this occurrence will change.
//   • This and following — This occurrence and all future occurrences will change.
//   • Entire series — All occurrences in this recurring meeting series will change.
//
// When the picked scope is `this_event` or `this_and_following`, the
// dialog also asks for the occurrence's `originalStartTime` since the
// PATCH/DELETE saga keys all per-occurrence exceptions on that field.
// ---------------------------------------------------------------------------
const SCOPE_OPTIONS: Array<{
  value: RecurrenceExceptionScope;
  label: string;
  description: string;
}> = [
  {
    value: "this_event",
    label: "This event only",
    description: "Only this occurrence will change.",
  },
  {
    value: "this_and_following",
    label: "This and following",
    description: "This occurrence and all future occurrences will change.",
  },
  {
    value: "entire_series",
    label: "Entire series",
    description:
      "All occurrences in this recurring meeting series will change.",
  },
];

interface ScopePickerDialogProps {
  state: { meeting: Meeting; mode: "edit" | "cancel" } | null;
  viewerTimezone: string;
  onClose: () => void;
  onSubmitEdit: (args: {
    meetingId: string;
    scope: RecurrenceExceptionScope;
    originalStartTime?: string;
    changes: { startTimeUtc?: string; durationMinutes?: number };
  }) => void;
  onSubmitCancel: (args: {
    meetingId: string;
    scope: RecurrenceExceptionScope;
    originalStartTime?: string;
    reason?: string;
  }) => void;
  editLoading: boolean;
  cancelLoading: boolean;
}

// Build an `<input type="datetime-local">` value that represents the
// given UTC ISO instant in the panel's *display* timezone — not the
// browser's local zone. This keeps the dialog's date input consistent
// with every other time the user sees in the panel.
function toDatetimeLocalInTz(iso: string, timezone: string): string {
  try {
    return formatInTimeZone(new Date(iso), timezone, "yyyy-MM-dd'T'HH:mm");
  } catch {
    return "";
  }
}

// Convert a `datetime-local` value (which is timezone-naive wall-clock
// text) back into a UTC ISO string, interpreting it in the panel's
// display timezone. Returns null when the input is empty or invalid.
function datetimeLocalToUtcIso(
  value: string,
  timezone: string,
): string | null {
  if (!value) return null;
  try {
    const utc = fromZonedTime(value, timezone);
    if (Number.isNaN(utc.getTime())) return null;
    return utc.toISOString();
  } catch {
    return null;
  }
}

function ScopePickerDialog(props: ScopePickerDialogProps) {
  const {
    state,
    viewerTimezone,
    onClose,
    onSubmitEdit,
    onSubmitCancel,
    editLoading,
    cancelLoading,
  } = props;
  const [scope, setScope] = useState<RecurrenceExceptionScope>("this_event");
  const [newStart, setNewStart] = useState<string>("");
  const [reason, setReason] = useState<string>("");
  const [validationError, setValidationError] = useState<string | null>(null);

  // Re-seed local state every time the dialog re-opens for a different
  // meeting/mode so we never carry stale values between rows.
  useEffect(() => {
    if (!state) return;
    setScope("this_event");
    setNewStart(toDatetimeLocalInTz(state.meeting.startTimeUtc, viewerTimezone));
    setReason("");
    setValidationError(null);
  }, [state, viewerTimezone]);

  const open = !!state;
  const mode = state?.mode ?? "edit";
  const isEdit = mode === "edit";
  // Per-occurrence scopes (`this_event` / `this_and_following`) need
  // an `originalStartTime` to identify *which* occurrence is being
  // changed. We always anchor that to the meeting row's known UTC
  // start instant — never a user-typed value — so the request is
  // unambiguous regardless of timezone.
  const requiresOriginalStart =
    scope === "this_event" || scope === "this_and_following";
  const submitting = isEdit ? editLoading : cancelLoading;

  const submit = () => {
    if (!state) return;
    setValidationError(null);
    const originalIso = requiresOriginalStart
      ? state.meeting.startTimeUtc
      : undefined;
    if (isEdit) {
      const newIso = datetimeLocalToUtcIso(newStart, viewerTimezone);
      if (!newIso) {
        setValidationError("Pick a valid new start time before saving.");
        return;
      }
      onSubmitEdit({
        meetingId: state.meeting.id,
        scope,
        originalStartTime: originalIso,
        changes: { startTimeUtc: newIso },
      });
    } else {
      onSubmitCancel({
        meetingId: state.meeting.id,
        scope,
        originalStartTime: originalIso,
        reason: reason.trim() || undefined,
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => (!v ? onClose() : undefined)}>
      <DialogContent data-testid="dialog-scope-picker">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? "Edit recurring meeting" : "Cancel recurring meeting"}
          </DialogTitle>
          <DialogDescription>
            Choose which occurrences this change applies to.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <RadioGroup
            value={scope}
            onValueChange={(v) => setScope(v as RecurrenceExceptionScope)}
            data-testid="radio-scope"
          >
            {SCOPE_OPTIONS.map((opt) => (
              <div key={opt.value} className="flex items-start gap-2">
                <RadioGroupItem
                  value={opt.value}
                  id={`scope-${opt.value}`}
                  data-testid={`radio-scope-${opt.value}`}
                />
                <div>
                  <Label htmlFor={`scope-${opt.value}`} className="font-medium">
                    {opt.label}
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    {opt.description}
                  </p>
                </div>
              </div>
            ))}
          </RadioGroup>

          {requiresOriginalStart && state && (
            <p
              className="text-xs text-muted-foreground"
              data-testid="text-scope-occurrence"
            >
              Targeting the occurrence at{" "}
              {formatInTimeZone(
                new Date(state.meeting.startTimeUtc),
                viewerTimezone,
                "EEE, MMM d 'at' h:mm a zzz",
              )}
              .
            </p>
          )}

          {isEdit && (
            <div className="space-y-1">
              <Label htmlFor="scope-new-start">
                New start time ({viewerTimezone})
              </Label>
              <Input
                id="scope-new-start"
                type="datetime-local"
                value={newStart}
                onChange={(e) => setNewStart(e.target.value)}
                data-testid="input-scope-new-start"
              />
            </div>
          )}

          {!isEdit && (
            <div className="space-y-1">
              <Label htmlFor="scope-reason">Reason (optional)</Label>
              <Textarea
                id="scope-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={2}
                data-testid="input-scope-reason"
              />
            </div>
          )}

          {validationError && (
            <p
              className="text-sm text-destructive"
              data-testid="text-scope-validation-error"
            >
              {validationError}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={onClose}
            disabled={submitting}
            data-testid="button-scope-cancel"
          >
            Back
          </Button>
          <Button
            onClick={submit}
            disabled={submitting}
            variant={isEdit ? "default" : "destructive"}
            data-testid="button-scope-confirm"
          >
            {submitting ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : null}
            {isEdit ? "Save changes" : "Cancel meeting"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
