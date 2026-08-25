/**
 * My Meetings console (Task #1064 Phase 1–2).
 *
 * Lists every NoBull-created meeting hosted by the signed-in user with
 * scope-aware reschedule, change-duration, cancel, and attendee
 * editing actions. All mutations route to the existing
 * `PATCH /api/booking/:id` and `DELETE /api/booking/:id` endpoints —
 * this panel is purely a console on top of the recurrence-aware
 * orchestrators shipped in #1032/#1039/#1044.
 *
 * Gated by the `booked_meetings_console_enabled` system_setting kill
 * switch: when the list endpoint returns `403 console_disabled` the
 * panel renders an explanatory empty state instead of a loading
 * spinner forever.
 *
 * The Google Calendar inbound sync surface (#1064 Phases 3–6) is
 * intentionally NOT wired into this panel — the list is refetched on
 * tab focus + after every action so even without push-based sync it
 * stays fresh enough for the day-to-day flow.
 */

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
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
import { useToast } from "@/hooks/use-toast";
import { useDisplayTimezone } from "@/lib/displayTimezone";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import {
  CalendarClock,
  Loader2,
  Pencil,
  Trash2,
  Users,
  Clock,
  ExternalLink,
  Repeat,
  Search,
} from "lucide-react";

type RecurrenceScope = "this_event" | "this_and_following" | "entire_series";

interface MeetingListItem {
  id: string;
  clientId: string | null;
  meetingTypeName: string | null;
  bookingSource: string;
  inviteeName: string | null;
  inviteeEmail: string | null;
  startTimeUtc: string;
  endTimeUtc: string;
  timezone: string;
  status: string;
  failureReason: string | null;
  zoomJoinUrl: string | null;
  googleCalendarEventUrl: string | null;
  recurrence: string[] | null;
  recurrenceSummary: string | null;
  seriesMasterId: string | null;
  recurringEventId: string | null;
  durationMinutes: number;
  isRecurring: boolean;
}

type Tense = "upcoming" | "past";

const PAGE_SIZE = 25;

const SCOPE_OPTIONS: Array<{
  value: RecurrenceScope;
  label: string;
  description: string;
}> = [
  {
    value: "this_event",
    label: "Only this occurrence",
    description: "Apply the change to just this meeting; the rest of the series continues unchanged.",
  },
  {
    value: "this_and_following",
    label: "This and following occurrences",
    description: "End the original series at this date and start a new one for everything after.",
  },
  {
    value: "entire_series",
    label: "Entire series",
    description: "Apply the change to every occurrence in this recurring meeting series.",
  },
];

function describeApiError(err: any, fallback = "Something went wrong"): string {
  if (!err) return fallback;
  if (typeof err.message === "string" && err.message) return err.message;
  return fallback;
}

function toDatetimeLocalInTz(iso: string, timezone: string): string {
  try {
    return formatInTimeZone(new Date(iso), timezone, "yyyy-MM-dd'T'HH:mm");
  } catch {
    return "";
  }
}

function datetimeLocalToUtcIso(value: string, timezone: string): string | null {
  if (!value) return null;
  try {
    const utc = fromZonedTime(value, timezone);
    if (Number.isNaN(utc.getTime())) return null;
    return utc.toISOString();
  } catch {
    return null;
  }
}

function statusBadge(status: string) {
  const map: Record<string, { label: string; className: string }> = {
    confirmed: { label: "Confirmed", className: "bg-emerald-100 text-emerald-800" },
    canceled: { label: "Canceled", className: "bg-gray-200 text-gray-700" },
    creating: { label: "Pending", className: "bg-amber-100 text-amber-800" },
    failed: { label: "Failed", className: "bg-red-100 text-red-800" },
  };
  const m = map[status] || { label: status, className: "bg-gray-100 text-gray-700" };
  return <Badge className={m.className}>{m.label}</Badge>;
}

export default function MyMeetingsPanel() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const tzInfo = useDisplayTimezone();
  const viewerTz = tzInfo.timezone;

  const [tense, setTense] = useState<Tense>("upcoming");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("default");
  const [cursor, setCursor] = useState<string | null>(null);
  const [editTarget, setEditTarget] = useState<MeetingListItem | null>(null);
  const [cancelTarget, setCancelTarget] = useState<MeetingListItem | null>(null);
  const [attendeeTarget, setAttendeeTarget] = useState<MeetingListItem | null>(null);

  // Build the query key + URL for the meetings list. Cursor is intentionally
  // included in the key so paging forward triggers a separate fetch.
  const params = useMemo(() => {
    const sp = new URLSearchParams();
    sp.set("tense", tense);
    sp.set("limit", String(PAGE_SIZE));
    if (search.trim()) sp.set("search", search.trim());
    if (statusFilter !== "default") sp.set("status", statusFilter);
    if (cursor) sp.set("cursor", cursor);
    return sp.toString();
  }, [tense, search, statusFilter, cursor]);

  const meetingsQuery = useQuery<{
    items: MeetingListItem[];
    nextCursor: string | null;
    error?: string;
    code?: string;
  }>({
    queryKey: ["/api/booking/me/meetings", params],
    queryFn: async () => {
      const res = await fetch(`/api/booking/me/meetings?${params}`, {
        credentials: "include",
      });
      if (res.status === 403) {
        const body = await res.json().catch(() => ({}));
        return { items: [], nextCursor: null, error: body.error, code: body.code };
      }
      if (!res.ok) throw new Error(`Failed to load meetings (${res.status})`);
      return res.json();
    },
  });

  const consoleDisabled = meetingsQuery.data?.code === "console_disabled";

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ["/api/booking/me/meetings"] });

  const editMutation = useMutation({
    mutationFn: async (args: {
      meetingId: string;
      scope: RecurrenceScope;
      originalStartTime?: string;
      changes: {
        startTimeUtc?: string;
        endTimeUtc?: string;
        durationMinutes?: number;
        attendees?: Array<{ email: string; displayName?: string }>;
      };
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
      setEditTarget(null);
      setAttendeeTarget(null);
      void invalidate(); // fire-and-forget: cache refresh only
    },
    onError: (err: any) => {
      toast({
        title: "Could not update meeting",
        description: describeApiError(err),
        variant: "destructive",
      });
    },
  });

  const cancelMutation = useMutation({
    mutationFn: async (args: {
      meetingId: string;
      scope: RecurrenceScope;
      originalStartTime?: string;
      reason?: string;
    }) => {
      const res = await apiRequest("DELETE", `/api/booking/${args.meetingId}`, {
        scope: args.scope,
        originalStartTime: args.originalStartTime,
        reason: args.reason,
      });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Meeting canceled" });
      setCancelTarget(null);
      void invalidate(); // fire-and-forget: cache refresh only
    },
    onError: (err: any) => {
      toast({
        title: "Could not cancel meeting",
        description: describeApiError(err),
        variant: "destructive",
      });
    },
  });

  const items = meetingsQuery.data?.items ?? [];
  const nextCursor = meetingsQuery.data?.nextCursor ?? null;

  return (
    <Card data-testid="card-my-meetings">
      <CardHeader>
        <CardTitle className="text-lg flex items-center gap-2">
          <CalendarClock className="w-5 h-5" />
          My Meetings
        </CardTitle>
        <CardDescription>
          Every meeting you host through NoBull. Reschedule, edit duration,
          add or remove attendees, or cancel — recurring meetings prompt for
          scope.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Filter bar */}
        <div className="flex flex-col sm:flex-row gap-3 sm:items-end">
          <div className="flex-1">
            <Label htmlFor="meetings-search">Search</Label>
            <div className="relative">
              <Search className="absolute left-2 top-2.5 w-4 h-4 text-gray-400" />
              <Input
                id="meetings-search"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setCursor(null);
                }}
                placeholder="Invitee name, email, or meeting type"
                className="pl-8"
                data-testid="input-meetings-search"
              />
            </div>
          </div>
          <div>
            <Label htmlFor="meetings-tense">Show</Label>
            <Select
              value={tense}
              onValueChange={(v) => {
                setTense(v as Tense);
                setCursor(null);
              }}
            >
              <SelectTrigger
                id="meetings-tense"
                className="w-[160px]"
                data-testid="select-meetings-tense"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="upcoming">Upcoming</SelectItem>
                <SelectItem value="past">Past</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="meetings-status">Status</Label>
            <Select
              value={statusFilter}
              onValueChange={(v) => {
                setStatusFilter(v);
                setCursor(null);
              }}
            >
              <SelectTrigger
                id="meetings-status"
                className="w-[160px]"
                data-testid="select-meetings-status"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="default">Default</SelectItem>
                <SelectItem value="confirmed">Confirmed</SelectItem>
                <SelectItem value="canceled">Canceled</SelectItem>
                <SelectItem value="confirmed,canceled">Both</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* List */}
        {meetingsQuery.isLoading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="w-5 h-5 animate-spin text-gray-400" />
          </div>
        ) : consoleDisabled ? (
          <div
            className="rounded border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"
            data-testid="text-console-disabled"
          >
            The Booked Meetings console is currently disabled by an
            administrator.
          </div>
        ) : items.length === 0 ? (
          <div
            className="rounded border border-border bg-gray-50 p-6 text-center text-sm text-gray-500"
            data-testid="text-meetings-empty"
          >
            No {tense} meetings.
          </div>
        ) : (
          <ul className="divide-y divide-border border border-border rounded">
            {items.map((m) => (
              <li
                key={m.id}
                className="p-3 flex flex-col sm:flex-row sm:items-center gap-3"
                data-testid={`row-meeting-${m.id}`}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span
                      className="font-medium truncate"
                      data-testid={`text-meeting-title-${m.id}`}
                    >
                      {m.meetingTypeName || m.recurrenceSummary || "Meeting"}
                    </span>
                    {statusBadge(m.status)}
                    {m.isRecurring && (
                      <Badge variant="outline" className="gap-1">
                        <Repeat className="w-3 h-3" /> Recurring
                      </Badge>
                    )}
                  </div>
                  <div
                    className="text-sm text-gray-600 mt-1"
                    data-testid={`text-meeting-when-${m.id}`}
                  >
                    {formatInTimeZone(
                      new Date(m.startTimeUtc),
                      viewerTz,
                      "EEE, MMM d 'at' h:mm a zzz",
                    )}{" "}
                    · {m.durationMinutes} min
                  </div>
                  <div className="text-xs text-gray-500 mt-0.5 truncate">
                    {m.inviteeName ? `${m.inviteeName} · ` : ""}
                    {m.inviteeEmail || "No invitee email"}
                  </div>
                </div>
                <div className="flex flex-wrap gap-1 sm:gap-2 sm:justify-end">
                  {m.zoomJoinUrl && (
                    <Button
                      asChild
                      size="sm"
                      variant="outline"
                      data-testid={`button-meeting-zoom-${m.id}`}
                    >
                      <a
                        href={m.zoomJoinUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <ExternalLink className="w-3 h-3 mr-1" />
                        Zoom
                      </a>
                    </Button>
                  )}
                  {m.googleCalendarEventUrl && (
                    <Button
                      asChild
                      size="sm"
                      variant="outline"
                      data-testid={`button-meeting-gcal-${m.id}`}
                    >
                      <a
                        href={m.googleCalendarEventUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <ExternalLink className="w-3 h-3 mr-1" />
                        Calendar
                      </a>
                    </Button>
                  )}
                  {m.status !== "canceled" && (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setEditTarget(m)}
                        data-testid={`button-meeting-edit-${m.id}`}
                      >
                        <Pencil className="w-3 h-3 mr-1" />
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setAttendeeTarget(m)}
                        data-testid={`button-meeting-attendees-${m.id}`}
                      >
                        <Users className="w-3 h-3 mr-1" />
                        Attendees
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="text-red-600 hover:text-red-700"
                        onClick={() => setCancelTarget(m)}
                        data-testid={`button-meeting-cancel-${m.id}`}
                      >
                        <Trash2 className="w-3 h-3 mr-1" />
                        Cancel
                      </Button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}

        {/* Pagination — only "Next" / "Reset" (cursor-based, not numbered). */}
        {!consoleDisabled && (cursor || nextCursor) && (
          <div className="flex justify-between items-center">
            <Button
              variant="outline"
              size="sm"
              disabled={!cursor}
              onClick={() => setCursor(null)}
              data-testid="button-meetings-reset"
            >
              ← Back to first page
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!nextCursor}
              onClick={() => setCursor(nextCursor)}
              data-testid="button-meetings-next"
            >
              Next page →
            </Button>
          </div>
        )}
      </CardContent>

      {/* Edit dialog (reschedule + change duration) */}
      <EditMeetingDialog
        meeting={editTarget}
        viewerTz={viewerTz}
        onClose={() => setEditTarget(null)}
        onSubmit={(args) => editMutation.mutate(args)}
        loading={editMutation.isPending}
      />

      {/* Cancel dialog */}
      <CancelMeetingDialog
        meeting={cancelTarget}
        viewerTz={viewerTz}
        onClose={() => setCancelTarget(null)}
        onSubmit={(args) => cancelMutation.mutate(args)}
        loading={cancelMutation.isPending}
      />

      {/* Attendees dialog */}
      <AttendeesDialog
        meeting={attendeeTarget}
        viewerTz={viewerTz}
        onClose={() => setAttendeeTarget(null)}
        onSubmit={(args) => editMutation.mutate(args)}
        loading={editMutation.isPending}
      />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// EditMeetingDialog — reschedule + change duration with scope picker for
// recurring meetings.
// ---------------------------------------------------------------------------

interface EditDialogProps {
  meeting: MeetingListItem | null;
  viewerTz: string;
  onClose: () => void;
  onSubmit: (args: {
    meetingId: string;
    scope: RecurrenceScope;
    originalStartTime?: string;
    changes: {
      startTimeUtc?: string;
      endTimeUtc?: string;
      durationMinutes?: number;
    };
  }) => void;
  loading: boolean;
}

function EditMeetingDialog(props: EditDialogProps) {
  const { meeting, viewerTz, onClose, onSubmit, loading } = props;
  const [scope, setScope] = useState<RecurrenceScope>("this_event");
  const [newStart, setNewStart] = useState("");
  const [duration, setDuration] = useState<number>(30);
  const [validationError, setValidationError] = useState<string | null>(null);

  // Reseed local state every time the dialog opens for a different row.
  // Must be useEffect (not useMemo): we're firing setState side effects,
  // which would otherwise schedule renders during render phase.
  // Depend on the primitive fields actually read (not the row object) so a
  // refetch that changes only the object identity can't wipe in-progress
  // edits, while genuinely fresh server values do reseed.
  const meetingId = meeting?.id;
  const meetingStartUtc = meeting?.startTimeUtc;
  const meetingDuration = meeting?.durationMinutes;
  useEffect(() => {
    if (!meetingId || !meetingStartUtc || meetingDuration == null) return;
    setScope("this_event");
    setNewStart(toDatetimeLocalInTz(meetingStartUtc, viewerTz));
    setDuration(meetingDuration);
    setValidationError(null);
  }, [meetingId, meetingStartUtc, meetingDuration, viewerTz]);

  if (!meeting) return null;

  const submit = () => {
    setValidationError(null);
    const newIso = datetimeLocalToUtcIso(newStart, viewerTz);
    if (!newIso) {
      setValidationError("Pick a valid new start time before saving.");
      return;
    }
    if (!Number.isFinite(duration) || duration < 15 || duration > 240) {
      setValidationError("Duration must be between 15 and 240 minutes.");
      return;
    }
    const startedSame =
      new Date(newIso).getTime() === new Date(meeting.startTimeUtc).getTime();
    const durationSame = duration === meeting.durationMinutes;
    if (startedSame && durationSame) {
      setValidationError("Change the start time or duration before saving.");
      return;
    }
    const endIso = new Date(
      new Date(newIso).getTime() + duration * 60_000,
    ).toISOString();
    const requiresOriginalStart =
      meeting.isRecurring &&
      (scope === "this_event" || scope === "this_and_following");
    onSubmit({
      meetingId: meeting.id,
      // The backend PATCH schema requires `scope` on every edit (the
      // saga uses it to pick its update path). For one-off meetings
      // we send `entire_series` because there's only one occurrence,
      // so all three scopes are semantically identical.
      scope: meeting.isRecurring ? scope : "entire_series",
      originalStartTime: requiresOriginalStart ? meeting.startTimeUtc : undefined,
      changes: {
        startTimeUtc: startedSame ? undefined : newIso,
        endTimeUtc: startedSame && durationSame ? undefined : endIso,
        durationMinutes: durationSame ? undefined : duration,
      },
    });
  };

  return (
    <Dialog open={!!meeting} onOpenChange={(v) => (!v ? onClose() : undefined)}>
      <DialogContent data-testid="dialog-edit-meeting">
        <DialogHeader>
          <DialogTitle>Edit meeting</DialogTitle>
          <DialogDescription>
            Reschedule or change the duration of this meeting.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {meeting.isRecurring && (
            <div data-testid="section-edit-scope">
              <Label className="mb-2 block">Apply change to</Label>
              <RadioGroup
                value={scope}
                onValueChange={(v) => setScope(v as RecurrenceScope)}
              >
                {SCOPE_OPTIONS.map((opt) => (
                  <div key={opt.value} className="flex items-start gap-2">
                    <RadioGroupItem
                      value={opt.value}
                      id={`edit-scope-${opt.value}`}
                      data-testid={`radio-edit-scope-${opt.value}`}
                    />
                    <div>
                      <Label
                        htmlFor={`edit-scope-${opt.value}`}
                        className="font-medium"
                      >
                        {opt.label}
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        {opt.description}
                      </p>
                    </div>
                  </div>
                ))}
              </RadioGroup>
            </div>
          )}

          <div className="space-y-1">
            <Label htmlFor="edit-new-start">New start time ({viewerTz})</Label>
            <Input
              id="edit-new-start"
              type="datetime-local"
              value={newStart}
              onChange={(e) => setNewStart(e.target.value)}
              data-testid="input-edit-new-start"
            />
          </div>

          <div className="space-y-1">
            <Label htmlFor="edit-duration" className="flex items-center gap-1">
              <Clock className="w-3 h-3" /> Duration (minutes)
            </Label>
            <Input
              id="edit-duration"
              type="number"
              min={15}
              max={240}
              value={duration}
              onChange={(e) =>
                setDuration(Number.parseInt(e.target.value, 10) || 0)
              }
              data-testid="input-edit-duration"
            />
          </div>

          {validationError && (
            <p
              className="text-sm text-red-600"
              data-testid="text-edit-validation-error"
            >
              {validationError}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={onClose}
            disabled={loading}
            data-testid="button-edit-cancel"
          >
            Back
          </Button>
          <Button
            onClick={submit}
            disabled={loading}
            data-testid="button-edit-confirm"
          >
            {loading && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            Save changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// CancelMeetingDialog — scope-aware cancel.
// ---------------------------------------------------------------------------

interface CancelDialogProps {
  meeting: MeetingListItem | null;
  viewerTz: string;
  onClose: () => void;
  onSubmit: (args: {
    meetingId: string;
    scope: RecurrenceScope;
    originalStartTime?: string;
    reason?: string;
  }) => void;
  loading: boolean;
}

function CancelMeetingDialog(props: CancelDialogProps) {
  const { meeting, viewerTz, onClose, onSubmit, loading } = props;
  const [scope, setScope] = useState<RecurrenceScope>("this_event");
  const [reason, setReason] = useState("");

  // Only the row's identity matters for the reset — read it as a primitive
  // so the dep list is exact.
  const meetingId = meeting?.id;
  useEffect(() => {
    if (!meetingId) return;
    setScope("this_event");
    setReason("");
  }, [meetingId]);

  if (!meeting) return null;

  const submit = () => {
    const requiresOriginalStart =
      meeting.isRecurring &&
      (scope === "this_event" || scope === "this_and_following");
    onSubmit({
      meetingId: meeting.id,
      // DELETE schema requires `scope` — one-off meetings send
      // `entire_series` because there's only one occurrence.
      scope: meeting.isRecurring ? scope : "entire_series",
      originalStartTime: requiresOriginalStart ? meeting.startTimeUtc : undefined,
      reason: reason.trim() || undefined,
    });
  };

  return (
    <Dialog open={!!meeting} onOpenChange={(v) => (!v ? onClose() : undefined)}>
      <DialogContent data-testid="dialog-cancel-meeting">
        <DialogHeader>
          <DialogTitle>Cancel meeting</DialogTitle>
          <DialogDescription>
            {meeting.isRecurring
              ? "Choose which occurrences to cancel."
              : "Cancel this meeting and notify the invitee."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {meeting.isRecurring && (
            <RadioGroup
              value={scope}
              onValueChange={(v) => setScope(v as RecurrenceScope)}
              data-testid="radio-cancel-scope"
            >
              {SCOPE_OPTIONS.map((opt) => (
                <div key={opt.value} className="flex items-start gap-2">
                  <RadioGroupItem
                    value={opt.value}
                    id={`cancel-scope-${opt.value}`}
                    data-testid={`radio-cancel-scope-${opt.value}`}
                  />
                  <div>
                    <Label
                      htmlFor={`cancel-scope-${opt.value}`}
                      className="font-medium"
                    >
                      {opt.label}
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      {opt.description}
                    </p>
                  </div>
                </div>
              ))}
            </RadioGroup>
          )}
          <p
            className="text-xs text-muted-foreground"
            data-testid="text-cancel-occurrence"
          >
            Targeting{" "}
            {formatInTimeZone(
              new Date(meeting.startTimeUtc),
              viewerTz,
              "EEE, MMM d 'at' h:mm a zzz",
            )}
            .
          </p>
          <div className="space-y-1">
            <Label htmlFor="cancel-reason">Reason (optional)</Label>
            <Textarea
              id="cancel-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              data-testid="input-cancel-reason"
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={onClose}
            disabled={loading}
            data-testid="button-cancel-back"
          >
            Back
          </Button>
          <Button
            variant="destructive"
            onClick={submit}
            disabled={loading}
            data-testid="button-cancel-confirm"
          >
            {loading && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            Cancel meeting
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// AttendeesDialog — add / remove invitee emails.
// ---------------------------------------------------------------------------

interface AttendeesDialogProps {
  meeting: MeetingListItem | null;
  viewerTz: string;
  onClose: () => void;
  onSubmit: (args: {
    meetingId: string;
    scope: RecurrenceScope;
    originalStartTime?: string;
    changes: {
      attendees?: Array<{ email: string; displayName?: string }>;
    };
  }) => void;
  loading: boolean;
}

function AttendeesDialog(props: AttendeesDialogProps) {
  const { meeting, viewerTz, onClose, onSubmit, loading } = props;
  const [scope, setScope] = useState<RecurrenceScope>("entire_series");
  const [emails, setEmails] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);

  // Depend on the primitive fields actually read (not the row object) so a
  // refetch that changes only object identity can't wipe in-progress edits.
  const meetingId = meeting?.id;
  const meetingInviteeEmail = meeting?.inviteeEmail;
  useEffect(() => {
    if (!meetingId) return;
    setScope("entire_series");
    // Pre-seed with the current invitee email so the user starts with
    // the existing attendee and can add or remove from there.
    setEmails(meetingInviteeEmail || "");
    setValidationError(null);
  }, [meetingId, meetingInviteeEmail]);

  if (!meeting) return null;

  const parseEmails = (raw: string) => {
    return raw
      .split(/[\s,;]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  };

  const submit = () => {
    setValidationError(null);
    const list = parseEmails(emails);
    const bad = list.filter((e) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
    if (bad.length > 0) {
      setValidationError(`Invalid email${bad.length > 1 ? "s" : ""}: ${bad.join(", ")}`);
      return;
    }
    const requiresOriginalStart =
      meeting.isRecurring &&
      (scope === "this_event" || scope === "this_and_following");
    onSubmit({
      meetingId: meeting.id,
      // PATCH requires `scope` even for one-off meetings — see EditMeetingDialog.
      scope: meeting.isRecurring ? scope : "entire_series",
      originalStartTime: requiresOriginalStart ? meeting.startTimeUtc : undefined,
      changes: {
        attendees: list.map((email) => ({ email })),
      },
    });
  };

  return (
    <Dialog open={!!meeting} onOpenChange={(v) => (!v ? onClose() : undefined)}>
      <DialogContent data-testid="dialog-attendees">
        <DialogHeader>
          <DialogTitle>Edit attendees</DialogTitle>
          <DialogDescription>
            Comma-separated email addresses. Removing an email will drop that
            attendee from the calendar invite. The host is added automatically.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {meeting.isRecurring && (
            <div data-testid="section-attendees-scope">
              <Label className="mb-2 block">Apply change to</Label>
              <RadioGroup
                value={scope}
                onValueChange={(v) => setScope(v as RecurrenceScope)}
              >
                {SCOPE_OPTIONS.map((opt) => (
                  <div key={opt.value} className="flex items-start gap-2">
                    <RadioGroupItem
                      value={opt.value}
                      id={`att-scope-${opt.value}`}
                      data-testid={`radio-att-scope-${opt.value}`}
                    />
                    <div>
                      <Label
                        htmlFor={`att-scope-${opt.value}`}
                        className="font-medium"
                      >
                        {opt.label}
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        {opt.description}
                      </p>
                    </div>
                  </div>
                ))}
              </RadioGroup>
            </div>
          )}
          <div className="space-y-1">
            <Label htmlFor="att-emails">Attendee emails</Label>
            <Textarea
              id="att-emails"
              rows={4}
              value={emails}
              onChange={(e) => setEmails(e.target.value)}
              placeholder="invitee@example.com, colleague@example.com"
              data-testid="input-attendees-emails"
            />
          </div>
          {validationError && (
            <p
              className="text-sm text-red-600"
              data-testid="text-attendees-validation-error"
            >
              {validationError}
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            Targeting{" "}
            {formatInTimeZone(
              new Date(meeting.startTimeUtc),
              viewerTz,
              "EEE, MMM d 'at' h:mm a zzz",
            )}
            .
          </p>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={onClose}
            disabled={loading}
            data-testid="button-attendees-cancel"
          >
            Back
          </Button>
          <Button
            onClick={submit}
            disabled={loading}
            data-testid="button-attendees-confirm"
          >
            {loading && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            Save attendees
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
