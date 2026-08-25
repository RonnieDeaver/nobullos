import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Calendar, Copy, Loader2, Save, Link2, CheckCircle, AlertTriangle, Trash2 } from "lucide-react";
import AvailabilityEditor from "./AvailabilityEditor";
import MeetingTypesEditor from "./MeetingTypesEditor";

const TIMEZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Phoenix",
  "Pacific/Honolulu",
  "UTC",
  "Europe/London",
  "Europe/Paris",
  "Asia/Tokyo",
  "Australia/Sydney",
];

type BookingPage = {
  // null when the AM hasn't saved a page yet — server returns a draft
  // pre-filled with sensible defaults so the form is never blank
  // (Task #887). `isDefault: true` accompanies that case.
  id: string | null;
  slug: string;
  timezone: string;
  durationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  active: boolean;
  title?: string | null;
  description?: string | null;
  isDefault?: boolean;
};

type CalendarStatus = {
  connected: boolean;
  configured: boolean;
  email?: string | null;
  // Canonical token state from the server (see googleCalendarIntegration.ts):
  //   "connected" | "disconnected" | "expired" | "missing_scope" | "refresh_failed"
  status?: string | null;
  lastRefreshAt?: string | null;
  lastError?: string | null;
  scopes?: string[] | null;
  missingScopes?: string[];
};

type CalendarListItem = {
  id: string;
  summary: string;
  primary: boolean;
  accessRole: string;
  timeZone?: string | null;
};

type ReadinessResponse = {
  ready: boolean;
  calendar: {
    configured: boolean;
    connected: boolean;
    status: string;
    selectedCalendarId: string;
  };
  zoomHost: {
    mapped: boolean;
    source?: "override" | "app_email" | "none";
    zoomUserId?: string;
    email?: string | null;
    error?: string;
    // Task #934 (929E): structured failure code so the admin UI can
    // branch (e.g. show the "Set Zoom email manually" CTA when
    // `zoom_host_not_mapped`).
    code?:
      | "ok"
      | "zoom_host_not_mapped"
      | "zoom_unreachable"
      | "no_user_email";
    classification?: "transient" | "configuration" | "auth" | null;
  };
  bookingPage: { exists: boolean; active: boolean; slug: string | null };
  availability: { hasRules: boolean; ruleCount: number };
};

type SlotResponse = {
  durationMinutes?: number;
  timezone?: string;
  slots: Array<{ startUtc: string; endUtc: string }>;
};

// Task #934 (929E) — admin diagnostic envelope for the slot preview.
// The server emits `{ error, code, classification, httpStatus?, reason?,
// retriable? }` on every failure; we hold onto these so the panel can
// render the right CTA + admin-only debug strip.
type AdminDiagnostic = {
  message: string;
  code:
    | "calendar_reauth_required"
    | "calendar_unavailable"
    | "endpoint_misrouted"
    | "booking_schema_not_ready"
    | "internal_error"
    | string;
  classification?: "transient" | "configuration" | "auth";
  httpStatus?: number | null;
  reason?: string | null;
  operatorAction?: string;
  retriable?: boolean;
};

class SlotPreviewError extends Error {
  diag: AdminDiagnostic;
  constructor(diag: AdminDiagnostic) {
    super(diag.message);
    this.diag = diag;
  }
}

type ZoomHostResponse = {
  overrideInUse: boolean;
  override: { email: string | null; zoomUserId: string | null } | null;
  lastValidatedAt: string | null;
  lastValidatedZoomEmail: string | null;
  lastValidatedDisplayName: string | null;
  autoResolveEmail: string | null;
  effective: {
    mode: "override" | "auto" | "none";
    zoomUserId?: string;
    zoomEmail?: string;
    displayName?: string;
    errorCode?: string;
    errorMessage?: string;
  };
};

export default function BookingSettingsPanel() {
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data: pageData, isLoading: pageLoading } = useQuery<{ page: BookingPage | null }>({
    queryKey: ["/api/booking/me/page"],
    queryFn: async () => {
      const res = await fetch("/api/booking/me/page", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load booking page");
      return res.json();
    },
  });
  const page = pageData?.page || null;

  const { data: calStatus } = useQuery<CalendarStatus>({
    queryKey: ["/api/integrations/google-calendar/status"],
    queryFn: async () => {
      const res = await fetch("/api/integrations/google-calendar/status", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load calendar status");
      return res.json();
    },
  });

  const [slug, setSlug] = useState("");
  const [timezone, setTimezone] = useState("America/Chicago");
  const [duration, setDuration] = useState(30);
  const [bufferBefore, setBufferBefore] = useState(0);
  const [bufferAfter, setBufferAfter] = useState(0);
  const [active, setActive] = useState(true);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");

  useEffect(() => {
    if (page) {
      setSlug(page.slug);
      setTimezone(page.timezone);
      setDuration(page.durationMinutes);
      setBufferBefore(page.bufferBeforeMinutes);
      setBufferAfter(page.bufferAfterMinutes);
      setActive(page.active);
      setTitle(page.title || "");
      setDescription(page.description || "");
    }
  }, [page]);

  const shareUrl = useMemo(() => {
    if (!page) return "";
    return `${window.location.origin}/book/${page.slug}`;
  }, [page]);

  // After the Google Calendar OAuth round-trip the server redirects
  // back here with `?calendar=connected` (or `?calendar=error`). Force
  // a refetch of the status / readiness / calendars / slot-preview
  // queries so the panel reflects the freshly-stored credential
  // immediately instead of showing the stale "disconnected" copy
  // until the user navigates away and back. The query string is
  // cleaned up afterward so a refresh doesn't re-trigger.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const cal = params.get("calendar");
    if (cal !== "connected" && cal !== "error") return;
    void qc.invalidateQueries({ queryKey: ["/api/integrations/google-calendar/status"] }); // fire-and-forget: cache refresh only
    void qc.invalidateQueries({ queryKey: ["/api/booking/me/calendars"] }); // fire-and-forget: cache refresh only
    void qc.invalidateQueries({ queryKey: ["/api/booking/me/readiness"] }); // fire-and-forget: cache refresh only
    void qc.invalidateQueries({ queryKey: ["/api/booking/me/slots-preview"] }); // fire-and-forget: cache refresh only
    if (cal === "connected") {
      toast({ title: "Google Calendar connected" });
    } else {
      toast({
        title: "Google Calendar connection failed",
        description: "Please try connecting again.",
        variant: "destructive",
      });
    }
    params.delete("calendar");
    const next = `${window.location.pathname}${params.toString() ? `?${params}` : ""}${window.location.hash}`;
    window.history.replaceState({}, "", next);
    // Run once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("PUT", "/api/booking/me/page", {
        slug,
        timezone,
        durationMinutes: duration,
        bufferBeforeMinutes: bufferBefore,
        bufferAfterMinutes: bufferAfter,
        active,
        title: title || null,
        description: description || null,
      });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Booking page saved" });
      void qc.invalidateQueries({ queryKey: ["/api/booking/me/page"] }); // fire-and-forget: cache refresh only
    },
    onError: (err: any) => {
      toast({ title: "Failed to save", description: err.message, variant: "destructive" });
    },
  });

  const connectCalendar = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/integrations/google-calendar/authorize", { credentials: "include" });
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
      toast({ title: "Calendar connection failed", description: err.message, variant: "destructive" });
    },
  });

  const disconnectCalendar = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/integrations/google-calendar/disconnect");
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Calendar disconnected" });
      void qc.invalidateQueries({ queryKey: ["/api/integrations/google-calendar/status"] }); // fire-and-forget: cache refresh only
      void qc.invalidateQueries({ queryKey: ["/api/booking/me/calendars"] }); // fire-and-forget: cache refresh only
      void qc.invalidateQueries({ queryKey: ["/api/booking/me/readiness"] }); // fire-and-forget: cache refresh only
    },
  });

  // Spec line 33: AM picks the target calendar (defaults to primary).
  // We only query when the calendar is actually connected — the
  // endpoint returns 409 otherwise.
  const { data: calendarsData } = useQuery<{
    calendars: CalendarListItem[];
    selectedCalendarId: string;
  }>({
    queryKey: ["/api/booking/me/calendars"],
    queryFn: async () => {
      const res = await fetch("/api/booking/me/calendars", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load calendars");
      return res.json();
    },
    enabled: !!calStatus?.connected,
  });

  const setCalendarMutation = useMutation({
    mutationFn: async (calendarId: string) => {
      const res = await apiRequest("PUT", "/api/booking/me/calendar", { calendarId });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Booking calendar updated" });
      void qc.invalidateQueries({ queryKey: ["/api/booking/me/calendars"] }); // fire-and-forget: cache refresh only
      void qc.invalidateQueries({ queryKey: ["/api/booking/me/readiness"] }); // fire-and-forget: cache refresh only
    },
    onError: (err: any) => {
      toast({
        title: "Failed to update calendar",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  // Per-AM setup readiness — drives the four-check card so an
  // operator can verify their booking chain end-to-end before
  // turning the page on.
  const { data: readiness } = useQuery<ReadinessResponse>({
    queryKey: ["/api/booking/me/readiness"],
    queryFn: async () => {
      const res = await fetch("/api/booking/me/readiness", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load readiness");
      return res.json();
    },
  });

  // Slot preview — Task #934 (929E) routes the panel through the new
  // authenticated admin endpoint so failures carry an admin diagnostic
  // envelope (code + classification + httpStatus/reason) instead of
  // leaking the public booking page's generic copy. Lazy-creates the
  // booking page server-side so the preview also works before the AM
  // has saved one.
  const {
    data: slotPreview,
    isLoading: slotPreviewLoading,
    error: slotPreviewError,
    refetch: refetchSlotPreview,
  } = useQuery<SlotResponse, SlotPreviewError>({
    queryKey: ["/api/booking/me/slots-preview"],
    queryFn: async () => {
      const res = await fetch("/api/booking/me/slots-preview", {
        credentials: "include",
      });
      if (!res.ok) {
        const body: any = await res.json().catch(() => ({}));
        throw new SlotPreviewError({
          message:
            body?.error ||
            `Slot preview failed (${res.status})`,
          code: body?.code || "internal_error",
          classification: body?.classification,
          httpStatus: body?.httpStatus ?? res.status,
          reason: body?.reason,
          operatorAction: body?.operatorAction,
          retriable: body?.retriable,
        });
      }
      return res.json();
    },
    retry: false,
  });
  const slotPreviewDiag: AdminDiagnostic | null = slotPreviewError
    ? slotPreviewError.diag
    : null;

  // Zoom host override — Task #934 (929E). The readiness card needs to
  // know the current override state so it can render either the "Set
  // Zoom email manually" CTA (when `zoom_host_not_mapped`) or
  // "Mapped to <email> · Clear override" (when an override is active).
  const { data: zoomHostData, refetch: refetchZoomHost } =
    useQuery<ZoomHostResponse>({
      queryKey: ["/api/booking/me/zoom-host"],
      queryFn: async () => {
        const res = await fetch("/api/booking/me/zoom-host", {
          credentials: "include",
        });
        if (!res.ok) throw new Error("Failed to load Zoom host override");
        return res.json();
      },
    });

  const [showZoomOverrideForm, setShowZoomOverrideForm] = useState(false);
  const [zoomOverrideEmail, setZoomOverrideEmail] = useState("");
  const [zoomOverrideError, setZoomOverrideError] = useState<string | null>(
    null,
  );

  // List of Zoom users on the connected account so the AM can pick the
  // right host from a dropdown instead of typing an email by hand. The
  // server returns `{ users: [], error, code }` on auth/scope failures
  // so we can fall back to the free-text input automatically.
  const { data: zoomUsersData, isLoading: zoomUsersLoading } = useQuery<{
    users: Array<{ id: string; email: string; name?: string }>;
    error?: string;
    code?: string;
  }>({
    queryKey: ["/api/booking/me/zoom-account-users"],
    queryFn: async () => {
      const res = await fetch("/api/booking/me/zoom-account-users", {
        credentials: "include",
      });
      if (!res.ok) throw new Error(`Failed to load Zoom users (${res.status})`);
      return res.json();
    },
    enabled: showZoomOverrideForm,
    staleTime: 60 * 1000,
  });
  const zoomUsersList = zoomUsersData?.users || [];
  const zoomUsersLoadFailed =
    !zoomUsersLoading && (!!zoomUsersData?.error || zoomUsersList.length === 0);
  const [zoomOverrideUserId, setZoomOverrideUserId] = useState<string>("");

  const setZoomOverrideMutation = useMutation({
    mutationFn: async (payload: { email?: string; zoomUserId?: string }) => {
      const res = await fetch("/api/booking/me/zoom-host", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body: any = await res.json().catch(() => ({}));
      if (!res.ok) {
        // Server uses `code: "zoom_host_override_invalid"` (or
        // `zoom_unreachable` / `zoom_host_override_invalid_input`) —
        // surface inline next to the input rather than as a toast so
        // the user can correct it without losing focus.
        const err: any = new Error(
          body?.error || `Failed to save (${res.status})`,
        );
        err.code = body?.code;
        throw err;
      }
      return body as ZoomHostResponse;
    },
    onSuccess: () => {
      setZoomOverrideError(null);
      setShowZoomOverrideForm(false);
      setZoomOverrideEmail("");
      setZoomOverrideUserId("");
      toast({ title: "Zoom host override saved" });
      void qc.invalidateQueries({ queryKey: ["/api/booking/me/zoom-host"] }); // fire-and-forget: cache refresh only
      void qc.invalidateQueries({ queryKey: ["/api/booking/me/readiness"] }); // fire-and-forget: cache refresh only
    },
    onError: (err: any) => {
      setZoomOverrideError(err.message || "Failed to save override");
    },
  });

  const clearZoomOverrideMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/booking/me/zoom-host", {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || `Failed to clear (${res.status})`);
      }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Zoom host override cleared" });
      void qc.invalidateQueries({ queryKey: ["/api/booking/me/zoom-host"] }); // fire-and-forget: cache refresh only
      void qc.invalidateQueries({ queryKey: ["/api/booking/me/readiness"] }); // fire-and-forget: cache refresh only
    },
    onError: (err: any) => {
      toast({
        title: "Failed to clear override",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const copyShareUrl = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      toast({ title: "Link copied to clipboard" });
    } catch {
      toast({ title: "Copy failed", variant: "destructive" });
    }
  };

  return (
    <div className="space-y-6">
      <Card data-testid="card-google-calendar">
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Calendar className="w-5 h-5" />
            Google Calendar
          </CardTitle>
          <CardDescription>
            Connect your Google Calendar so booked meetings appear on your calendar and busy times are
            automatically blocked off.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!calStatus?.configured ? (
            <div className="flex items-start gap-2 text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded p-3">
              <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <span>
                Google Calendar OAuth is not yet configured on this server. Ask an admin to set the
                <code className="mx-1 px-1 bg-amber-100 rounded">GOOGLE_CALENDAR_CLIENT_ID</code> and
                <code className="mx-1 px-1 bg-amber-100 rounded">GOOGLE_CALENDAR_CLIENT_SECRET</code>
                secrets.
              </span>
            </div>
          ) : calStatus.connected ? (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm">
                  <CheckCircle className="w-4 h-4 text-green-600" />
                  <span data-testid="text-calendar-connected">
                    Connected{calStatus.email ? ` as ${calStatus.email}` : ""}
                  </span>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => disconnectCalendar.mutate()}
                  disabled={disconnectCalendar.isPending}
                  data-testid="button-disconnect-calendar"
                >
                  <Trash2 className="w-4 h-4 mr-1" /> Disconnect
                </Button>
              </div>
              {/*
                Spec line 33 — let the AM choose which Google Calendar
                booked meetings should land on (defaults to the
                primary). Free/busy reads and the saga's event-insert
                both follow this id, so changing it here switches the
                target end-to-end without touching anything else.
              */}
              <div>
                <Label>Booking calendar</Label>
                <Select
                  value={calendarsData?.selectedCalendarId || "primary"}
                  onValueChange={(v) => setCalendarMutation.mutate(v)}
                  disabled={
                    setCalendarMutation.isPending ||
                    !calendarsData ||
                    calendarsData.calendars.length === 0
                  }
                >
                  <SelectTrigger data-testid="select-booking-calendar" className="mt-1">
                    <SelectValue placeholder="Loading calendars…" />
                  </SelectTrigger>
                  <SelectContent>
                    {(calendarsData?.calendars || []).map((c) => (
                      <SelectItem key={c.id} value={c.id} data-testid={`option-calendar-${c.id}`}>
                        {c.summary}
                        {c.primary ? " (primary)" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground mt-1">
                  Booked meetings will appear on this calendar, and busy
                  times on it will be hidden from clients.
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              {/*
                Surface the canonical token state coming back from the
                server so the AM understands *why* the connection isn't
                live (expired refresh token, revoked grant, scope drift,
                etc.) and what to do about it. The five canonical states
                are emitted by the server: connected | disconnected |
                expired | missing_scope | refresh_failed.
              */}
              {calStatus.status && calStatus.status !== "disconnected" && (
                <div
                  className={
                    calStatus.status === "missing_scope"
                      ? "flex items-start gap-2 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded p-3"
                      : "flex items-start gap-2 text-sm text-rose-800 bg-rose-50 border border-rose-200 rounded p-3"
                  }
                  data-testid={`status-calendar-${calStatus.status}`}
                >
                  <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                  <div>
                    <div className="font-medium">
                      {calStatus.status === "expired" && "Calendar token expired"}
                      {calStatus.status === "refresh_failed" && "Could not refresh Calendar token"}
                      {calStatus.status === "missing_scope" && "Calendar permissions changed"}
                      {!["expired", "refresh_failed", "missing_scope"].includes(
                        calStatus.status,
                      ) && `Calendar status: ${calStatus.status}`}
                    </div>
                    <div className="text-xs mt-1 opacity-90">
                      {calStatus.status === "expired" &&
                        "Reconnect to keep new bookings on your Google Calendar and continue blocking off busy times."}
                      {calStatus.status === "refresh_failed" &&
                        "Google rejected the stored refresh token (often because the grant was revoked). Reconnect to restore."}
                      {calStatus.status === "missing_scope" &&
                        `The connected account is missing the required scopes${
                          calStatus.missingScopes && calStatus.missingScopes.length
                            ? `: ${calStatus.missingScopes.join(", ")}`
                            : ""
                        }. Reconnect and approve all permissions.`}
                    </div>
                    {calStatus.lastError && (
                      <div className="text-[11px] mt-1 font-mono opacity-70 break-all">
                        {calStatus.lastError}
                      </div>
                    )}
                  </div>
                </div>
              )}
              <Button
                onClick={() => connectCalendar.mutate()}
                disabled={connectCalendar.isPending}
                data-testid="button-connect-calendar"
              >
                {connectCalendar.isPending ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <Calendar className="w-4 h-4 mr-2" />
                )}
                {calStatus.status && calStatus.status !== "disconnected"
                  ? "Reconnect Google Calendar"
                  : "Connect Google Calendar"}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card data-testid="card-booking-page">
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Link2 className="w-5 h-5" />
            Booking Page
          </CardTitle>
          <CardDescription>
            Configure your public booking page. Clients (and prospects) can pick from your available
            times — each booking creates a real Zoom meeting and a Calendar event.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {pageLoading ? (
            <div className="text-sm text-muted-foreground">Loading…</div>
          ) : (
            <>
              {page?.isDefault && (
                <div
                  className="flex items-start gap-2 text-sm text-emerald-800 bg-emerald-50 border border-emerald-200 rounded p-3"
                  data-testid="banner-page-defaults-prefilled"
                >
                  <CheckCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                  <span>
                    Your booking page already works with these defaults — clients
                    can book a 30-minute meeting on the suggested URL right away.
                    Tweak anything below and Save to customize.
                  </span>
                </div>
              )}
              <div>
                <Label htmlFor="bookingSlug">Public URL</Label>
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-sm text-muted-foreground whitespace-nowrap">
                    {window.location.origin}/book/
                  </span>
                  <Input
                    id="bookingSlug"
                    value={slug}
                    onChange={(e) => setSlug(e.target.value.toLowerCase())}
                    placeholder="your-name"
                    data-testid="input-booking-slug"
                  />
                  {page && page.id && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={copyShareUrl}
                      data-testid="button-copy-share-link"
                    >
                      <Copy className="w-4 h-4 mr-1" /> Copy
                    </Button>
                  )}
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  Lowercase letters, numbers, and hyphens only.
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <Label>Timezone</Label>
                  <Select value={timezone} onValueChange={setTimezone}>
                    <SelectTrigger data-testid="select-booking-timezone">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TIMEZONES.map((tz) => (
                        <SelectItem key={tz} value={tz}>
                          {tz}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label htmlFor="bookingDuration">Meeting length (min)</Label>
                  <Input
                    id="bookingDuration"
                    type="number"
                    min={15}
                    max={240}
                    step={5}
                    value={duration}
                    onChange={(e) => setDuration(Math.max(15, Number(e.target.value) || 30))}
                    data-testid="input-booking-duration"
                  />
                </div>
                <div className="flex items-center justify-between">
                  <div>
                    <Label htmlFor="bookingActive">Accepting bookings</Label>
                    <p className="text-xs text-muted-foreground">Hide your page when off.</p>
                  </div>
                  <Switch
                    id="bookingActive"
                    checked={active}
                    onCheckedChange={setActive}
                    data-testid="switch-booking-active"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="bufferBefore">Buffer before (min)</Label>
                  <Input
                    id="bufferBefore"
                    type="number"
                    min={0}
                    max={120}
                    step={5}
                    value={bufferBefore}
                    onChange={(e) => setBufferBefore(Math.max(0, Number(e.target.value) || 0))}
                    data-testid="input-buffer-before"
                  />
                </div>
                <div>
                  <Label htmlFor="bufferAfter">Buffer after (min)</Label>
                  <Input
                    id="bufferAfter"
                    type="number"
                    min={0}
                    max={120}
                    step={5}
                    value={bufferAfter}
                    onChange={(e) => setBufferAfter(Math.max(0, Number(e.target.value) || 0))}
                    data-testid="input-buffer-after"
                  />
                </div>
              </div>

              <div>
                <Label htmlFor="bookingTitle">Page title</Label>
                <Input
                  id="bookingTitle"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="e.g. Strategy Call with Jonathan"
                  data-testid="input-booking-title"
                />
              </div>
              <div>
                <Label htmlFor="bookingDesc">Page description</Label>
                <Textarea
                  id="bookingDesc"
                  rows={3}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="What this meeting is about, what to expect, etc."
                  data-testid="input-booking-description"
                />
              </div>

              <Button
                onClick={() => saveMutation.mutate()}
                disabled={saveMutation.isPending || !slug}
                className="bg-primary hover:bg-primary/90"
                data-testid="button-save-booking-page"
              >
                {saveMutation.isPending ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <Save className="w-4 h-4 mr-2" />
                )}
                Save Booking Page
              </Button>
            </>
          )}
        </CardContent>
      </Card>

      {page?.id && <AvailabilityEditor pageId={page.id} timezone={page.timezone} />}

      <MeetingTypesEditor />


      {/*
        Spec line 91 — per-AM setup readiness. Surface the four checks
        (Calendar connected, Zoom host mapped, page active, availability
        configured) so an operator can self-verify before going live.
      */}
      {readiness && (
        <Card data-testid="card-setup-readiness">
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              {readiness.ready ? (
                <CheckCircle className="w-5 h-5 text-green-600" />
              ) : (
                <AlertTriangle className="w-5 h-5 text-amber-600" />
              )}
              Setup Readiness
            </CardTitle>
            <CardDescription>
              All four checks must pass before clients can successfully
              book — each booking creates both a Zoom meeting and a
              Calendar event.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2 text-sm">
              <li
                className="flex items-start gap-2"
                data-testid="readiness-calendar"
              >
                {readiness.calendar.connected ? (
                  <CheckCircle className="w-4 h-4 text-green-600 mt-0.5 flex-shrink-0" />
                ) : (
                  <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 flex-shrink-0" />
                )}
                <div>
                  <div className="font-medium">Google Calendar connected</div>
                  <div className="text-xs text-muted-foreground">
                    {readiness.calendar.connected
                      ? `Status: ${readiness.calendar.status}. Target calendar: ${readiness.calendar.selectedCalendarId}.`
                      : `Status: ${readiness.calendar.status}. Connect your calendar above.`}
                  </div>
                  {!readiness.calendar.connected && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="mt-2"
                      onClick={() => connectCalendar.mutate()}
                      disabled={connectCalendar.isPending}
                      data-testid="button-readiness-connect-calendar"
                    >
                      {connectCalendar.isPending ? (
                        <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                      ) : (
                        <Calendar className="w-3.5 h-3.5 mr-1.5" />
                      )}
                      Connect calendar
                    </Button>
                  )}
                </div>
              </li>
              <li
                className="flex items-start gap-2"
                data-testid="readiness-zoom-host"
                data-zoom-host-code={readiness.zoomHost.code || "ok"}
              >
                {readiness.zoomHost.mapped ? (
                  <CheckCircle className="w-4 h-4 text-green-600 mt-0.5 flex-shrink-0" />
                ) : (
                  <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 flex-shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <div className="font-medium">Zoom host mapped</div>
                  <div className="text-xs text-muted-foreground">
                    {readiness.zoomHost.mapped
                      ? readiness.zoomHost.source === "override"
                        ? `Mapped to ${readiness.zoomHost.email} (manual override).`
                        : `Zoom user found for ${readiness.zoomHost.email}.`
                      : readiness.zoomHost.code === "no_user_email"
                        ? "Your account has no email — set a Zoom host override below to enable booking."
                        : readiness.zoomHost.code === "zoom_unreachable"
                          ? "Could not reach Zoom to look up your host. Try again in a moment."
                          : readiness.zoomHost.error ||
                            "No Zoom user matches this account's email."}
                  </div>

                  {/*
                    Task #934 (929E): when Zoom can't auto-resolve a
                    host for this AM, surface the manual-override CTA
                    inline. The override input posts to PUT
                    /api/booking/me/zoom-host (929B) and renders
                    `zoom_host_override_invalid` errors right under the
                    input so the AM can correct without losing focus.
                  */}
                  {readiness.zoomHost.source === "override" &&
                    zoomHostData?.overrideInUse && (
                      <div
                        className="mt-2 flex flex-wrap items-center gap-2 text-xs"
                        data-testid="zoom-host-override-active"
                      >
                        <span className="text-muted-foreground">
                          Override in use.
                        </span>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => clearZoomOverrideMutation.mutate()}
                          disabled={clearZoomOverrideMutation.isPending}
                          data-testid="button-clear-zoom-override"
                        >
                          {clearZoomOverrideMutation.isPending ? (
                            <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
                          ) : null}
                          Clear override
                        </Button>
                      </div>
                    )}

                  {(readiness.zoomHost.code === "zoom_host_not_mapped" ||
                    readiness.zoomHost.code === "no_user_email") &&
                    !showZoomOverrideForm && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="mt-2"
                        onClick={() => {
                          setZoomOverrideError(null);
                          setZoomOverrideEmail(
                            zoomHostData?.autoResolveEmail || "",
                          );
                          setShowZoomOverrideForm(true);
                        }}
                        data-testid="button-set-zoom-override"
                      >
                        Set Zoom email manually
                      </Button>
                    )}

                  {(readiness.zoomHost.code === "zoom_host_not_mapped" ||
                    readiness.zoomHost.code === "no_user_email") &&
                    showZoomOverrideForm && (
                      <div
                        className="mt-2 space-y-1"
                        data-testid="form-zoom-override"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          {zoomUsersLoading ? (
                            <div
                              className="flex items-center gap-2 text-xs text-muted-foreground"
                              data-testid="text-zoom-users-loading"
                            >
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              Loading Zoom users…
                            </div>
                          ) : zoomUsersLoadFailed ? (
                            <Input
                              type="email"
                              value={zoomOverrideEmail}
                              onChange={(e) => {
                                setZoomOverrideEmail(e.target.value);
                                if (zoomOverrideError)
                                  setZoomOverrideError(null);
                              }}
                              placeholder="your.zoom.email@example.com"
                              className="max-w-xs"
                              data-testid="input-zoom-override-email"
                            />
                          ) : (
                            <Select
                              value={zoomOverrideUserId}
                              onValueChange={(v) => {
                                setZoomOverrideUserId(v);
                                const picked = zoomUsersList.find(
                                  (u) => u.id === v,
                                );
                                setZoomOverrideEmail(picked?.email || "");
                                if (zoomOverrideError)
                                  setZoomOverrideError(null);
                              }}
                            >
                              <SelectTrigger
                                className="max-w-sm"
                                data-testid="select-zoom-override-user"
                              >
                                <SelectValue placeholder="Select your Zoom user…" />
                              </SelectTrigger>
                              <SelectContent className="max-h-[60vh] overflow-y-auto">
                                {zoomUsersList.map((u) => (
                                  <SelectItem
                                    key={u.id}
                                    value={u.id}
                                    data-testid={`option-zoom-user-${u.id}`}
                                  >
                                    {u.name ? `${u.name} — ${u.email}` : u.email}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          )}
                          <Button
                            type="button"
                            size="sm"
                            onClick={() => {
                              if (zoomUsersLoadFailed) {
                                setZoomOverrideMutation.mutate({
                                  email: zoomOverrideEmail.trim(),
                                });
                              } else {
                                setZoomOverrideMutation.mutate({
                                  zoomUserId: zoomOverrideUserId,
                                  email: zoomOverrideEmail.trim() || undefined,
                                });
                              }
                            }}
                            disabled={
                              setZoomOverrideMutation.isPending ||
                              zoomUsersLoading ||
                              (zoomUsersLoadFailed
                                ? !zoomOverrideEmail.trim()
                                : !zoomOverrideUserId)
                            }
                            data-testid="button-save-zoom-override"
                          >
                            {setZoomOverrideMutation.isPending ? (
                              <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
                            ) : (
                              <Save className="w-3.5 h-3.5 mr-1" />
                            )}
                            Save
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              setShowZoomOverrideForm(false);
                              setZoomOverrideError(null);
                              setZoomOverrideUserId("");
                            }}
                            data-testid="button-cancel-zoom-override"
                          >
                            Cancel
                          </Button>
                        </div>
                        {zoomOverrideError && (
                          <div
                            className="text-xs text-rose-700"
                            data-testid="text-zoom-override-error"
                          >
                            {zoomOverrideError}
                          </div>
                        )}
                        <div className="text-[11px] text-muted-foreground">
                          {zoomUsersLoadFailed
                            ? `Couldn't load the list of Zoom users${
                                zoomUsersData?.error
                                  ? ` (${zoomUsersData.error})`
                                  : ""
                              }. Enter the email that identifies you as a host on the connected Zoom account — we'll validate it before saving.`
                            : "Pick the Zoom user that should host your booked meetings. We'll validate the choice against Zoom before saving."}
                        </div>
                      </div>
                    )}
                </div>
              </li>
              <li
                className="flex items-start gap-2"
                data-testid="readiness-page"
              >
                {readiness.bookingPage.active ? (
                  <CheckCircle className="w-4 h-4 text-green-600 mt-0.5 flex-shrink-0" />
                ) : (
                  <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 flex-shrink-0" />
                )}
                <div>
                  <div className="font-medium">Booking page active</div>
                  <div className="text-xs text-muted-foreground">
                    {readiness.bookingPage.exists
                      ? readiness.bookingPage.active
                        ? `Public at /book/${readiness.bookingPage.slug}.`
                        : "Page exists but is set to off — turn on Accepting bookings."
                      : "No booking page yet — save the page above to create one."}
                  </div>
                </div>
              </li>
              <li
                className="flex items-start gap-2"
                data-testid="readiness-availability"
              >
                {readiness.availability.hasRules ? (
                  <CheckCircle className="w-4 h-4 text-green-600 mt-0.5 flex-shrink-0" />
                ) : (
                  <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 flex-shrink-0" />
                )}
                <div>
                  <div className="font-medium">Availability configured</div>
                  <div className="text-xs text-muted-foreground">
                    {readiness.availability.hasRules
                      ? `${readiness.availability.ruleCount} weekly rule${
                          readiness.availability.ruleCount === 1 ? "" : "s"
                        }.`
                      : "No weekly rules — add one above so slots can be offered."}
                  </div>
                </div>
              </li>
            </ul>
          </CardContent>
        </Card>
      )}

      {/*
        Slot preview — calls the same public slots endpoint a client
        would hit so the AM can see exactly what's being offered today.
        This makes it obvious when, say, a buffer/duration combination
        accidentally squeezes the day to zero slots.
      */}
      {page && (
        <Card data-testid="card-slot-preview">
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Calendar className="w-5 h-5" />
              Slot Preview
            </CardTitle>
            <CardDescription>
              The next available booking slots a client visiting your
              public page would see right now.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between mb-3">
              <div className="text-xs text-muted-foreground">
                {slotPreview?.timezone
                  ? `Times shown in ${slotPreview.timezone}`
                  : slotPreviewDiag
                    ? ""
                    : "Loading…"}
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => refetchSlotPreview()}
                disabled={slotPreviewLoading}
                data-testid="button-refresh-slot-preview"
              >
                {slotPreviewLoading ? (
                  <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                ) : null}
                Refresh
              </Button>
            </div>

            {/*
              Task #934 (929E): render distinct error states per
              admin diagnostic code with the right CTA.
                - calendar_reauth_required → Reconnect Google
                - calendar_unavailable     → Retry CTA (Refresh above)
                - endpoint_misrouted       → request-config bug copy
                - booking_schema_not_ready → operator-action copy
              The Refresh button above doubles as the retry — when the
              retry succeeds, react-query clears `slotPreviewError` so
              this banner disappears automatically.
            */}
            {slotPreviewDiag ? (
              <div
                className={
                  slotPreviewDiag.classification === "auth"
                    ? "rounded border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800"
                    : slotPreviewDiag.classification === "configuration"
                      ? "rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"
                      : "rounded border border-slate-200 bg-slate-50 p-3 text-sm text-slate-800"
                }
                data-testid="banner-slot-preview-error"
                data-error-code={slotPreviewDiag.code}
              >
                <div className="font-medium">
                  {slotPreviewDiag.code === "calendar_reauth_required"
                    ? "Reconnect Google Calendar"
                    : slotPreviewDiag.code === "calendar_unavailable"
                      ? "Calendar temporarily unreachable"
                      : slotPreviewDiag.code === "endpoint_misrouted"
                        ? "Calendar request misrouted"
                        : slotPreviewDiag.code === "booking_schema_not_ready"
                          ? "Booking database not ready"
                          : "Could not load slot preview"}
                </div>
                <div className="text-xs mt-1">
                  {slotPreviewDiag.message}
                </div>
                {slotPreviewDiag.operatorAction && (
                  <div className="text-xs mt-1 opacity-90">
                    Operator action: {slotPreviewDiag.operatorAction}
                  </div>
                )}
                {/* Admin-only debug strip — only the authenticated
                    admin endpoint emits httpStatus/reason, so showing
                    them here can never leak to public bookers. */}
                {(slotPreviewDiag.httpStatus || slotPreviewDiag.reason) && (
                  <div
                    className="text-[11px] mt-1 font-mono opacity-70 break-all"
                    data-testid="text-slot-preview-debug"
                  >
                    {slotPreviewDiag.httpStatus
                      ? `HTTP ${slotPreviewDiag.httpStatus}`
                      : ""}
                    {slotPreviewDiag.httpStatus && slotPreviewDiag.reason
                      ? " · "
                      : ""}
                    {slotPreviewDiag.reason || ""}
                  </div>
                )}
                {slotPreviewDiag.code === "calendar_reauth_required" && (
                  <Button
                    type="button"
                    size="sm"
                    className="mt-2"
                    onClick={() => connectCalendar.mutate()}
                    disabled={connectCalendar.isPending}
                    data-testid="button-slot-preview-reconnect-calendar"
                  >
                    {connectCalendar.isPending ? (
                      <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                    ) : (
                      <Calendar className="w-3.5 h-3.5 mr-1.5" />
                    )}
                    Reconnect Google Calendar
                  </Button>
                )}
                {slotPreviewDiag.code === "calendar_unavailable" && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="mt-2"
                    onClick={() => refetchSlotPreview()}
                    disabled={slotPreviewLoading}
                    data-testid="button-slot-preview-retry"
                  >
                    {slotPreviewLoading ? (
                      <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                    ) : null}
                    Retry now
                  </Button>
                )}
              </div>
            ) : slotPreview && slotPreview.slots.length === 0 ? (
              <div className="text-sm text-muted-foreground" data-testid="text-slot-preview-empty">
                No upcoming slots — check your availability rules and
                buffers.
              </div>
            ) : slotPreview ? (
              <div
                className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2"
                data-testid="grid-slot-preview"
              >
                {slotPreview.slots.slice(0, 12).map((s) => {
                  const d = new Date(s.startUtc);
                  const label = d.toLocaleString(undefined, {
                    month: "short",
                    day: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                    timeZone: slotPreview.timezone || undefined,
                  });
                  return (
                    <div
                      key={s.startUtc}
                      className="text-xs border rounded px-2 py-1 text-center"
                      data-testid={`slot-preview-${s.startUtc}`}
                    >
                      {label}
                    </div>
                  );
                })}
              </div>
            ) : null}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
