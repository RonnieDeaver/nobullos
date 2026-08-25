import React, { useState, useEffect, useRef } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { useToast } from "@/hooks/use-toast";
import { Link } from "wouter";
import { ArrowLeft, Save, User, Phone, Globe, Camera, Loader2, Check, ChevronsUpDown, CheckSquare, Plug, Unplug, Copy, AlertTriangle, Sun, Moon, Monitor } from "lucide-react";
import { useTheme, type ThemePreference } from "@/lib/theme";
import BookingSettingsPanel from "@/components/booking/BookingSettingsPanel";
import MyMeetingsPanel from "@/components/booking/MyMeetingsPanel";
import UserNotificationSettingsPanel from "@/components/UserNotificationSettingsPanel";
import { resolveDisplayTimezone } from "@/lib/displayTimezone";
import {
  AUTHORITY_LABELS,
  FUNCTION_LABELS,
  getUserFacet,
  isAuthorityLevel,
  isUserFunction,
} from "@/lib/userLabels";

interface TwilioUserSettings {
  callerIdName: string;
  smsSignOff: string;
  callRoutingPhone: string;
  // Task #874: 'browser' (default) places calls in the browser via Twilio
  // Voice JS SDK. 'forward' bridges through the user's mobile phone.
  callMode: "browser" | "forward";
}

// Friendly labels for the most-common picks. Anything not listed here
// still appears in the searchable dropdown (Task #1033) — we just fall
// back to showing the raw IANA identifier as the label.
const COMMON_TIMEZONE_LABELS: Record<string, string> = {
  "America/New_York": "Eastern Time (ET)",
  "America/Chicago": "Central Time (CT)",
  "America/Denver": "Mountain Time (MT)",
  "America/Los_Angeles": "Pacific Time (PT)",
  "America/Anchorage": "Alaska Time (AKT)",
  "Pacific/Honolulu": "Hawaii Time (HT)",
  "America/Phoenix": "Arizona (no DST)",
  "America/Indiana/Indianapolis": "Indiana (Eastern)",
  "Europe/London": "London (GMT/BST)",
  "Europe/Paris": "Central European (CET)",
  "Europe/Berlin": "Berlin (CET)",
  "Asia/Tokyo": "Tokyo (JST)",
  "Asia/Shanghai": "Shanghai (CST)",
  "Asia/Kolkata": "India (IST)",
  "Australia/Sydney": "Sydney (AEST)",
  UTC: "UTC",
};

// Full IANA list when the runtime supports it, otherwise the curated
// fallback set above. `Intl.supportedValuesOf('timeZone')` is supported
// by every browser the app targets but not by older Node SSR builds —
// guarded so this file stays safe to import in either environment.
function buildTimezoneOptions(): { value: string; label: string }[] {
  let zones: string[];
  if (typeof Intl.supportedValuesOf === "function") {
    try {
      zones = Intl.supportedValuesOf("timeZone");
    } catch {
      zones = Object.keys(COMMON_TIMEZONE_LABELS);
    }
  } else {
    zones = Object.keys(COMMON_TIMEZONE_LABELS);
  }
  return zones.map((z) => ({
    value: z,
    label: COMMON_TIMEZONE_LABELS[z] ? `${COMMON_TIMEZONE_LABELS[z]} — ${z}` : z,
  }));
}

const TIMEZONE_OPTIONS = buildTimezoneOptions();

const VALID_TABS = ["account", "communications", "booking", "notifications", "meetings"] as const;
type TabId = typeof VALID_TABS[number];

function getTabFromSearch(search: string): TabId {
  const params = new URLSearchParams(search);
  const tab = params.get("tab");
  if (tab && (VALID_TABS as readonly string[]).includes(tab)) {
    return tab as TabId;
  }
  // When returning from the Google Calendar OAuth round-trip, land on
  // Booking so BookingSettingsPanel's mount effect runs immediately and
  // shows the success/error toast rather than waiting for the user to
  // manually navigate to that tab.
  const cal = params.get("calendar");
  if (cal === "connected" || cal === "error") {
    return "booking";
  }
  // When returning from the ClickUp OAuth round-trip, land on Account
  // so the ClickUp card's status is visible immediately.
  const cu = params.get("clickup");
  if (cu === "connected" || cu === "error") {
    return "account";
  }
  return "account";
}

type ClickUpStatus = {
  connected: boolean;
  clickupEmail: string | null;
  clickupUsername: string | null;
  workspaceId: string | null;
  authorizedWorkspaces: { id: string; name: string }[];
  status: string;
  lastError: string | null;
  redirectUri: string | null;
};

export function ClickUpConnectionCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: status, isLoading } = useQuery<ClickUpStatus>({
    queryKey: ["/api/integrations/clickup/status"],
    queryFn: async () => {
      const res = await fetch("/api/integrations/clickup/status");
      if (!res.ok) throw new Error("Failed to load ClickUp status");
      return res.json();
    },
    staleTime: 30_000,
  });

  const [connecting, setConnecting] = React.useState(false);
  // Task #3385: when the authorize endpoint returns 503 (OAuth app not
  // configured), show a persistent inline notice on the card instead of
  // an auto-dismissing toast. Cleared on a subsequent successful attempt.
  const [oauthNotConfigured, setOauthNotConfigured] = React.useState(false);
  const [callbackCopied, setCallbackCopied] = React.useState(false);

  // Use the server-computed redirect URI (includes custom-domain preference
  // logic) so the displayed URL always matches what the server will send to
  // ClickUp — avoids showing a mismatched URL when the browser's origin
  // differs from the registered callback (OAUTH_017 root cause).
  const callbackUrl = status?.redirectUri
    ?? (typeof window !== "undefined"
      ? `${window.location.origin}/api/integrations/clickup/callback`
      : "/api/integrations/clickup/callback");

  const handleCopyCallback = async () => {
    try {
      await navigator.clipboard.writeText(callbackUrl);
      setCallbackCopied(true);
      setTimeout(() => setCallbackCopied(false), 2000);
    } catch {
      toast({ title: "Copy failed", description: "Select and copy the URL manually.", variant: "destructive" });
    }
  };

  const handleConnect = async () => {
    setConnecting(true);
    try {
      const res = await fetch("/api/integrations/clickup/authorize?returnTo=/profile", { credentials: "include" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        if (res.status === 503) {
          setOauthNotConfigured(true);
          return;
        }
        throw new Error(body.error || "Failed to start authorization");
      }
      // Credentials are set and authorization started — clear the notice.
      setOauthNotConfigured(false);
      const data = await res.json();
      if (data.url) window.location.href = data.url;
      else throw new Error(data.error || "No authorization URL returned");
    } catch (e: any) {
      toast({ title: "Connection failed", description: e.message, variant: "destructive" });
    } finally {
      setConnecting(false);
    }
  };

  const disconnectMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/integrations/clickup/disconnect", { method: "POST", credentials: "include" });
      if (!res.ok) throw new Error("Failed to disconnect");
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "ClickUp disconnected" });
      void queryClient.invalidateQueries({ queryKey: ["/api/integrations/clickup/status"] }); // fire-and-forget: cache refresh only
    },
    onError: (err: Error) => {
      toast({ title: "Failed to disconnect", description: err.message, variant: "destructive" });
    },
  });

  return (
    <Card data-testid="card-clickup-connection">
      <CardHeader>
        <CardTitle className="text-lg flex items-center gap-2">
          <CheckSquare className="w-5 h-5 text-primary" />
          ClickUp
        </CardTitle>
        <CardDescription>Connect your personal ClickUp account to manage tasks in NoBull OS</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="text-clickup-checking">
            <Loader2 className="w-4 h-4 animate-spin" />
            Checking connection…
          </div>
        ) : status?.connected ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2" data-testid="text-clickup-connected">
              <span className="inline-flex items-center gap-1.5 text-sm font-medium text-status-ok">
                <Check className="w-4 h-4" />
                Connected
              </span>
              {status.clickupEmail && (
                <span className="text-sm text-muted-foreground" data-testid="text-clickup-email">as {status.clickupEmail}</span>
              )}
              {!status.clickupEmail && status.clickupUsername && (
                <span className="text-sm text-muted-foreground" data-testid="text-clickup-username">as {status.clickupUsername}</span>
              )}
            </div>
            {(status.authorizedWorkspaces?.length ?? 0) > 0 && (
              <div className="text-sm text-muted-foreground" data-testid="text-clickup-workspaces">
                <span className="font-medium">Authorized workspaces:</span>{" "}
                {status.authorizedWorkspaces.map((w) => w.name || w.id).join(", ")}
              </div>
            )}
            <div
              className="border border-status-info/30 bg-status-info/5 p-3 text-sm text-foreground"
              data-testid="notice-clickup-workspace-scope"
            >
              Missing a workspace? Press Reconnect below and check <span className="font-semibold">every workspace</span> on
              ClickUp's authorization screen — even ones you don't actively use. ClickUp only lets NoBull OS see the
              workspaces you check there.
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={handleConnect}
              disabled={connecting}
              data-testid="button-clickup-reconnect"
            >
              {connecting ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Check className="w-4 h-4 mr-2" />
              )}
              Reconnect / add workspaces
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => disconnectMutation.mutate()}
              disabled={disconnectMutation.isPending}
              data-testid="button-clickup-disconnect"
            >
              {disconnectMutation.isPending ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Unplug className="w-4 h-4 mr-2" />
              )}
              Disconnect
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground" data-testid="text-clickup-not-connected">
              Not connected. Each team member connects their own ClickUp account.
            </p>
            <div
              className="border border-status-info/30 bg-status-info/5 p-3 text-sm text-foreground"
              data-testid="notice-clickup-select-all-workspaces"
            >
              On ClickUp's authorization screen, check <span className="font-semibold">every workspace</span> — even ones
              you don't actively use. NoBull OS can only see the workspaces you check there; you can always reconnect
              later to add more.
            </div>
            {oauthNotConfigured && (
              <div
                className="border border-status-warn/40 bg-status-warn/5 p-3 space-y-2"
                data-testid="notice-clickup-oauth-not-configured"
              >
                <div className="flex items-center gap-2 text-sm font-medium text-status-warn">
                  <AlertTriangle className="w-4 h-4 shrink-0" />
                  ClickUp OAuth app not configured
                </div>
                <ol className="list-decimal list-inside text-sm text-foreground/80 space-y-1">
                  <li>In ClickUp, go to Workspace Settings → Integrations → ClickUp API.</li>
                  <li>Open the "ClickUp API Settings" tab and create an app.</li>
                  <li>Register this redirect URL for the app:</li>
                </ol>
                <div className="flex items-center gap-2">
                  <code
                    className="flex-1 min-w-0 truncate rounded bg-card border border-status-warn/30 px-2 py-1 text-xs text-foreground"
                    data-testid="text-clickup-callback-url"
                  >
                    {callbackUrl}
                  </code>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleCopyCallback}
                    data-testid="button-copy-clickup-callback"
                  >
                    {callbackCopied ? <Check className="w-4 h-4 mr-1" /> : <Copy className="w-4 h-4 mr-1" />}
                    {callbackCopied ? "Copied" : "Copy"}
                  </Button>
                </div>
                <p className="text-sm text-foreground/80">
                  4. Give the app's Client ID and Client Secret from ClickUp to your
                  administrator to add to this app's secure settings (as{" "}
                  <code className="text-xs">CLICKUP_CLIENT_ID</code> and{" "}
                  <code className="text-xs">CLICKUP_CLIENT_SECRET</code>), then try
                  connecting again.
                </p>
              </div>
            )}
            <Button
              onClick={handleConnect}
              disabled={connecting}
              size="sm"
              className="bg-primary hover:bg-primary/90 text-primary-foreground"
              data-testid="button-clickup-connect"
            >
              {connecting ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Plug className="w-4 h-4 mr-2" />
              )}
              {connecting ? "Connecting…" : "Connect ClickUp"}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function Profile() {
  const { user } = useAuth();
  // Task #4377 — global theme preference (Appearance card, Account tab).
  const { preference: themePreference, setPreference: setThemePreference } = useTheme();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  // Deep-link: read active tab from ?tab= query param; default to "account".
  const [activeTab, setActiveTab] = useState<TabId>(() =>
    getTabFromSearch(typeof window !== "undefined" ? window.location.search : "")
  );

  // Keep tab state in sync with the URL query param so back/forward works.
  const handleTabChange = (tab: string) => {
    const t = tab as TabId;
    setActiveTab(t);
    const params = new URLSearchParams(typeof window !== "undefined" ? window.location.search : "");
    params.set("tab", t);
    // Preserve any other existing query params (e.g. ?calendar=connected
    // used by BookingSettingsPanel's OAuth round-trip).
    const next = `${window.location.pathname}?${params.toString()}${window.location.hash}`;
    window.history.replaceState({}, "", next);
  };

  const [callerIdName, setCallerIdName] = useState("");
  const [smsSignOff, setSmsSignOff] = useState("");
  const [callRoutingPhone, setCallRoutingPhone] = useState("");
  const [callMode, setCallMode] = useState<"browser" | "forward">("browser");
  // Task #1033: the picker has to reflect the same value the rest of
  // the app actually renders times in. `resolveDisplayTimezone` is the
  // single source of truth — falls back to the browser zone when the
  // user has no saved preference rather than showing a stale
  // hardcoded "America/Chicago".
  const resolvedTz = resolveDisplayTimezone(user ?? null);
  const [timezone, setTimezone] = useState(resolvedTz.timezone);
  const [tzOpen, setTzOpen] = useState(false);
  const timezoneSource = resolvedTz.source;
  const [firstName, setFirstName] = useState(user?.firstName || "");
  const [lastName, setLastName] = useState(user?.lastName || "");
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: userSettings } = useQuery<TwilioUserSettings>({
    queryKey: ["/api/users/me/twilio-settings"],
    queryFn: async () => {
      const res = await fetch("/api/users/me/twilio-settings");
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
  });

  useEffect(() => {
    if (userSettings) {
      setCallerIdName(userSettings.callerIdName || "");
      setSmsSignOff(userSettings.smsSignOff || "");
      setCallRoutingPhone(userSettings.callRoutingPhone || "");
      setCallMode(userSettings.callMode === "forward" ? "forward" : "browser");
    }
  }, [userSettings]);

  useEffect(() => {
    if (user?.firstName) setFirstName(user.firstName);
    if (user?.lastName) setLastName(user.lastName);
  }, [user?.firstName, user?.lastName]);

  // Show toast when returning from ClickUp OAuth round-trip.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const cu = params.get("clickup");
    if (!cu) return;
    if (cu === "connected") {
      toast({ title: "ClickUp connected", description: "Your ClickUp account is now linked." });
    } else if (cu === "error") {
      toast({ title: "ClickUp connection failed", description: "Try connecting again from the ClickUp card below.", variant: "destructive" });
    }
    // Remove the flag from the URL so it doesn't re-fire on re-render.
    params.delete("clickup");
    const next = `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ""}${window.location.hash}`;
    window.history.replaceState({}, "", next);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    // Re-sync the picker if the auth payload's timezone or source
    // changes (e.g. the GCal seeder ran on /status and bumped the
    // value). Always go through the resolver so the picker mirrors
    // what the rest of the app renders.
    // Depending on the full `user` object is safe here: the resolver is
    // pure and setTimezone with an unchanged value is a no-op re-render.
    setTimezone(resolveDisplayTimezone(user ?? null).timezone);
  }, [user]);

  const saveProfileMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/users/me/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ firstName, lastName }),
      });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Profile updated" });
      void queryClient.invalidateQueries({ queryKey: ["/api/auth/user"] }); // fire-and-forget: cache refresh only
    },
    onError: (err: Error) => {
      toast({ title: "Failed to save profile", description: err.message, variant: "destructive" });
    },
  });

  const uploadPhotoMutation = useMutation({
    mutationFn: async (file: File) => {
      const res = await fetch("/api/users/me/profile-photo", {
        method: "POST",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Profile photo updated" });
      void queryClient.invalidateQueries({ queryKey: ["/api/auth/user"] }); // fire-and-forget: cache refresh only
      setAvatarPreview(null);
    },
    onError: (err: Error) => {
      toast({ title: "Failed to upload photo", description: err.message, variant: "destructive" });
      setAvatarPreview(null);
    },
  });

  const handlePhotoSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      toast({ title: "File too large", description: "Please select an image under 5MB", variant: "destructive" });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setAvatarPreview(reader.result as string);
    reader.readAsDataURL(file);
    uploadPhotoMutation.mutate(file);
  };

  const saveSettingsMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/users/me/twilio-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callerIdName, smsSignOff, callRoutingPhone, callMode }),
      });
      if (!res.ok) {
        let msg = `Save failed (${res.status})`;
        try {
          const body = await res.json();
          if (body?.error) msg = body.error;
        } catch {}
        throw new Error(msg);
      }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Communication settings saved" });
      void queryClient.invalidateQueries({ queryKey: ["/api/users/me/twilio-settings"] }); // fire-and-forget: cache refresh only
    },
    onError: (err: Error) => {
      toast({ title: "Failed to save settings", description: err.message, variant: "destructive" });
    },
  });

  const saveTimezoneMutation = useMutation({
    mutationFn: async (tz: string) => {
      const res = await fetch("/api/users/me/timezone", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timezone: tz }),
      });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Timezone updated" });
      void queryClient.invalidateQueries({ queryKey: ["/api/auth/user"] }); // fire-and-forget: cache refresh only
    },
    onError: (err: Error) => {
      toast({ title: "Failed to save timezone", description: err.message, variant: "destructive" });
    },
  });

  if (!user) return null;

  return (
    <div className="min-h-[calc(100dvh-var(--nav-height))] bg-surface-warm-2 p-4">
      <div className="max-w-3xl mx-auto space-y-6">
        <div className="flex items-center gap-3">
          <Button asChild variant="ghost" size="sm" data-testid="button-back">
            <Link href="/">
              <ArrowLeft className="w-4 h-4 mr-1" />
              Back
            </Link>
          </Button>
          <h1 className="text-2xl font-bold text-foreground" data-testid="text-page-title">
            <User className="w-6 h-6 inline mr-2" />
            My Profile
          </h1>
        </div>

        <Tabs value={activeTab} onValueChange={handleTabChange} data-testid="tabs-profile">
          <TabsList
            className="w-full flex flex-wrap h-auto gap-1 bg-surface-warm-1 p-1"
            data-testid="tablist-profile"
          >
            <TabsTrigger
              value="account"
              className="flex-1 min-w-[100px] data-[state=active]:bg-card data-[state=active]:text-primary-ink data-[state=active]:shadow-sm"
              data-testid="tab-account"
            >
              Account
            </TabsTrigger>
            <TabsTrigger
              value="communications"
              className="flex-1 min-w-[130px] data-[state=active]:bg-card data-[state=active]:text-primary-ink data-[state=active]:shadow-sm"
              data-testid="tab-communications"
            >
              Communications
            </TabsTrigger>
            <TabsTrigger
              value="booking"
              className="flex-1 min-w-[90px] data-[state=active]:bg-card data-[state=active]:text-primary-ink data-[state=active]:shadow-sm"
              data-testid="tab-booking"
            >
              Booking
            </TabsTrigger>
            <TabsTrigger
              value="notifications"
              className="flex-1 min-w-[120px] data-[state=active]:bg-card data-[state=active]:text-primary-ink data-[state=active]:shadow-sm"
              data-testid="tab-notifications"
            >
              Notifications
            </TabsTrigger>
            <TabsTrigger
              value="meetings"
              className="flex-1 min-w-[110px] data-[state=active]:bg-card data-[state=active]:text-primary-ink data-[state=active]:shadow-sm"
              data-testid="tab-meetings"
            >
              My Meetings
            </TabsTrigger>
          </TabsList>

          {/* ── Account tab ── photo, name, email, role chips, timezone ── */}
          <TabsContent value="account" className="space-y-6 mt-6" data-testid="tabpanel-account">
            <Card data-testid="card-user-info">
              <CardHeader>
                <CardTitle className="text-lg flex items-center gap-2">
                  <User className="w-5 h-5" />
                  Profile
                </CardTitle>
                <CardDescription>Your display name and photo shown across the app</CardDescription>
              </CardHeader>
              <CardContent className="space-y-5">
                <div className="flex items-center gap-5">
                  <div className="relative group">
                    {(avatarPreview || user.profileImageUrl) ? (
                      <img
                        src={avatarPreview || user.profileImageUrl || ""}
                        alt=""
                        className="w-20 h-20 rounded-full object-cover border-2 border-border"
                        data-testid="img-profile-avatar"
                      />
                    ) : (
                      <div className="w-20 h-20 rounded-full bg-muted flex items-center justify-center text-2xl font-bold text-muted-foreground" data-testid="img-profile-avatar-placeholder">
                        {(firstName || user.email || "U")[0].toUpperCase()}
                      </div>
                    )}
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      className="absolute inset-0 rounded-full bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity cursor-pointer"
                      aria-label="Change profile photo"
                      data-testid="button-change-photo"
                      disabled={uploadPhotoMutation.isPending}
                    >
                      {uploadPhotoMutation.isPending ? (
                        <Loader2 className="w-5 h-5 text-white animate-spin" />
                      ) : (
                        <Camera className="w-5 h-5 text-white" />
                      )}
                    </button>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      className="hidden"
                      onChange={handlePhotoSelect}
                      data-testid="input-photo-upload"
                    />
                  </div>
                  <div className="flex-1">
                    <p className="text-sm text-muted-foreground mb-1">Click the photo to change it</p>
                    {user.email && (
                      <p className="text-sm text-muted-foreground" data-testid="text-profile-email">{user.email}</p>
                    )}
                    <div className="mt-2 flex flex-wrap items-center gap-1.5" data-testid="profile-role-labels">
                      {((user as any).functions ?? [])
                        .filter(isUserFunction)
                        .map((fn: string) => (
                          <span
                            key={fn}
                            className="text-xs px-2 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20"
                            data-testid={`profile-chip-function-${fn}`}
                          >
                            {FUNCTION_LABELS[fn as keyof typeof FUNCTION_LABELS]}
                          </span>
                        ))}
                      <span
                        className="text-xs px-2 py-0.5 rounded-full bg-surface-warm-1 text-foreground border border-primary/20"
                        data-testid="profile-chip-authority"
                      >
                        {(() => {
                          const lvl = (user as any).authorityLevel;
                          return isAuthorityLevel(lvl) ? AUTHORITY_LABELS[lvl] : "Core";
                        })()}
                      </span>
                      <span className="text-xs text-muted-foreground" data-testid="profile-facet">
                        · {getUserFacet((user as any).functions ?? [])}
                      </span>
                    </div>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label htmlFor="firstName">First Name</Label>
                    <Input
                      id="firstName"
                      value={firstName}
                      onChange={(e) => setFirstName(e.target.value)}
                      placeholder="First name"
                      data-testid="input-first-name"
                    />
                  </div>
                  <div>
                    <Label htmlFor="lastName">Last Name</Label>
                    <Input
                      id="lastName"
                      value={lastName}
                      onChange={(e) => setLastName(e.target.value)}
                      placeholder="Last name"
                      data-testid="input-last-name"
                    />
                  </div>
                </div>
                <Button
                  onClick={() => saveProfileMutation.mutate()}
                  disabled={saveProfileMutation.isPending}
                  className="bg-primary hover:bg-primary/90"
                  data-testid="button-save-profile"
                >
                  {saveProfileMutation.isPending ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <Save className="w-4 h-4 mr-2" />
                  )}
                  Save Profile
                </Button>
              </CardContent>
            </Card>

            <Card data-testid="card-timezone-settings">
              <CardHeader>
                <CardTitle className="text-lg flex items-center gap-2">
                  <Globe className="w-5 h-5" />
                  Timezone
                </CardTitle>
                <CardDescription>Controls how meeting times and dates are displayed</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <Label htmlFor="timezone">Display Timezone</Label>
                  {/* Task #1033: searchable IANA picker — full zone list with
                      friendly labels for the common US/EU picks, type-ahead
                      filtering, and a hint when the current value was seeded
                      from the user's connected Google Calendar. */}
                  <Popover open={tzOpen} onOpenChange={setTzOpen}>
                    <PopoverTrigger asChild>
                      <Button
                        id="timezone"
                        type="button"
                        variant="outline"
                        role="combobox"
                        aria-expanded={tzOpen}
                        className="w-full justify-between font-normal"
                        data-testid="select-timezone"
                      >
                        <span className="truncate">
                          {timezone
                            ? TIMEZONE_OPTIONS.find((tz) => tz.value === timezone)?.label || timezone
                            : "Select timezone..."}
                        </span>
                        <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
                      <Command>
                        <CommandInput
                          placeholder="Search timezones…"
                          data-testid="input-timezone-search"
                        />
                        <CommandList>
                          <CommandEmpty>No timezone found.</CommandEmpty>
                          <CommandGroup>
                            {TIMEZONE_OPTIONS.map((tz) => (
                              <CommandItem
                                key={tz.value}
                                value={tz.label}
                                onSelect={() => {
                                  setTimezone(tz.value);
                                  saveTimezoneMutation.mutate(tz.value);
                                  setTzOpen(false);
                                }}
                                data-testid={`option-tz-${tz.value}`}
                              >
                                <Check
                                  className={`mr-2 h-4 w-4 ${timezone === tz.value ? "opacity-100" : "opacity-0"}`}
                                />
                                {tz.label}
                              </CommandItem>
                            ))}
                          </CommandGroup>
                        </CommandList>
                      </Command>
                    </PopoverContent>
                  </Popover>
                  <p
                    className="text-xs text-muted-foreground mt-1"
                    data-testid="text-timezone-source-hint"
                  >
                    {timezoneSource === "google_calendar"
                      ? "Seeded from your connected Google Calendar — pick another zone here to override."
                      : timezoneSource === "user"
                        ? "All meeting timestamps will be displayed in this timezone."
                        : "All meeting timestamps will be displayed in this timezone."}
                  </p>
                </div>
              </CardContent>
            </Card>

            {/* Task #4377 — global theme preference (light / dark / system).
                Applies instantly via ThemeProvider and persists per user
                (PUT /api/users/me/theme). */}
            <Card data-testid="card-appearance-settings">
              <CardHeader>
                <CardTitle className="text-lg flex items-center gap-2">
                  <Sun className="w-5 h-5" />
                  Appearance
                </CardTitle>
                <CardDescription>Choose how NoBull OS looks on this account</CardDescription>
              </CardHeader>
              <CardContent>
                <div
                  role="radiogroup"
                  aria-label="Theme"
                  className="grid grid-cols-3 gap-2 max-w-md"
                >
                  {(
                    [
                      { value: "light", label: "Light", Icon: Sun },
                      { value: "dark", label: "Dark", Icon: Moon },
                      { value: "system", label: "System", Icon: Monitor },
                    ] as const
                  ).map(({ value, label, Icon }) => (
                    <Button
                      key={value}
                      type="button"
                      role="radio"
                      aria-checked={themePreference === value}
                      variant={themePreference === value ? "default" : "outline"}
                      onClick={() => setThemePreference(value as ThemePreference)}
                      data-testid={`button-theme-${value}`}
                    >
                      <Icon className="w-4 h-4 mr-2" />
                      {label}
                    </Button>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground mt-2">
                  System follows your device's appearance setting. Your choice syncs to
                  every device you sign in on.
                </p>
              </CardContent>
            </Card>

            <ClickUpConnectionCard />
          </TabsContent>

          {/* ── Communications tab ── */}
          <TabsContent value="communications" className="mt-6" data-testid="tabpanel-communications">
            <Card data-testid="card-comm-settings">
              <CardHeader>
                <CardTitle className="text-lg flex items-center gap-2">
                  <Phone className="w-5 h-5" />
                  Communication Settings
                </CardTitle>
                <CardDescription>Configure how your outbound messages and calls appear</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <Label htmlFor="callerIdName">Caller ID Name</Label>
                  <Input
                    id="callerIdName"
                    value={callerIdName}
                    onChange={(e) => setCallerIdName(e.target.value)}
                    placeholder="e.g. Jonathan Smith"
                    data-testid="input-caller-id"
                  />
                  <p className="text-xs text-muted-foreground mt-1">Displayed on outbound calls</p>
                </div>
                <div>
                  <Label htmlFor="smsSignOff">SMS Sign-off</Label>
                  <Textarea
                    id="smsSignOff"
                    value={smsSignOff}
                    onChange={(e) => setSmsSignOff(e.target.value)}
                    placeholder={"— Jonathan, NoBull Marketing\nhttps://nobull.com"}
                    rows={3}
                    data-testid="input-sms-signoff"
                  />
                  <p className="text-xs text-muted-foreground mt-1">Automatically appended to outbound SMS messages. You can include links on their own line.</p>
                </div>
                <div>
                  <Label>Call Mode</Label>
                  <div className="mt-2 space-y-2">
                    <label className="flex items-start gap-2 cursor-pointer" data-testid="radio-call-mode-browser-label">
                      <input
                        type="radio"
                        name="callMode"
                        value="browser"
                        checked={callMode === "browser"}
                        onChange={() => setCallMode("browser")}
                        className="mt-1"
                        data-testid="radio-call-mode-browser"
                      />
                      <span className="text-sm">
                        <span className="font-medium">Browser audio</span>
                        <span className="block text-xs text-muted-foreground">
                          Place and receive call audio directly in this browser tab. No phone needed. Requires microphone permission.
                        </span>
                      </span>
                    </label>
                    <label className="flex items-start gap-2 cursor-pointer" data-testid="radio-call-mode-forward-label">
                      <input
                        type="radio"
                        name="callMode"
                        value="forward"
                        checked={callMode === "forward"}
                        onChange={() => setCallMode("forward")}
                        className="mt-1"
                        data-testid="radio-call-mode-forward"
                      />
                      <span className="text-sm">
                        <span className="font-medium">Forward to my phone</span>
                        <span className="block text-xs text-muted-foreground">
                          Twilio will ring the routing phone below first; once you answer, it bridges the contact in.
                        </span>
                      </span>
                    </label>
                  </div>
                </div>
                <div>
                  <Label htmlFor="callRoutingPhone">Call Routing Phone Number</Label>
                  <Input
                    id="callRoutingPhone"
                    value={callRoutingPhone}
                    onChange={(e) => setCallRoutingPhone(e.target.value)}
                    placeholder="e.g. +15551234567"
                    data-testid="input-call-routing-phone"
                  />
                  <p className="text-xs text-muted-foreground mt-1">Where inbound calls should ring when routed to you</p>
                  {callMode === "forward" && !callRoutingPhone.trim() && (
                    <p className="text-xs text-status-critical mt-1" data-testid="text-routing-phone-required">
                      A routing phone is required when call mode is set to "Forward to my phone".
                    </p>
                  )}
                </div>
                <Button
                  onClick={() => saveSettingsMutation.mutate()}
                  disabled={saveSettingsMutation.isPending}
                  className="bg-primary hover:bg-primary/90"
                  data-testid="button-save-settings"
                >
                  <Save className="w-4 h-4 mr-2" />
                  Save Settings
                </Button>
              </CardContent>
            </Card>
          </TabsContent>

          {/* ── Booking tab ── */}
          <TabsContent value="booking" className="mt-6" data-testid="tabpanel-booking">
            <BookingSettingsPanel />
          </TabsContent>

          {/* ── Notifications tab ── */}
          <TabsContent value="notifications" className="mt-6" data-testid="tabpanel-notifications">
            <UserNotificationSettingsPanel />
          </TabsContent>

          {/* ── My Meetings tab ── */}
          <TabsContent value="meetings" className="mt-6" data-testid="tabpanel-meetings">
            <MyMeetingsPanel />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
