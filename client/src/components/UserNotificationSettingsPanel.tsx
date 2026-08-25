/**
 * Task #1687 — Per-user Slack DM forwarding settings panel.
 *
 * Mounted in Profile.tsx underneath BookingSettingsPanel. Two sections:
 *
 *  1. Slack identity — Connect / Disconnect / Send test DM. Linking
 *     uses the user's NoBull OS email by default (see
 *     userSlackSender.ts for the rationale on email-lookup vs OAuth).
 *  2. Per-category preferences — toggles for in-app and slack-DM.
 *     Categories come from the API response so this UI stays in sync
 *     with the canonical `userNotificationCategories` list.
 *
 * Slack failures never break in-app: the panel surfaces
 * `last_dm_status` / `last_dm_error` as a reconnect hint when present.
 */

import { useState } from "react";
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
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useToast } from "@/hooks/use-toast";
import { Loader2, MessageSquare, AlertTriangle, CheckCircle } from "lucide-react";

interface PreferenceRow {
  category: string;
  inAppEnabled: boolean;
  slackDmEnabled: boolean;
}

interface PreferencesResponse {
  preferences: PreferenceRow[];
  slackDmGloballyEnabled: boolean;
}

interface IdentityResponse {
  connected: boolean;
  identity: {
    slackUserId: string;
    slackTeamId: string | null;
    slackEmail: string | null;
    connectedAt: string;
    disconnectedAt: string | null;
    lastDmStatus: string | null;
    lastDmError: string | null;
    lastDmAt: string | null;
  } | null;
}

const CATEGORY_LABELS: Record<string, string> = {
  "comms.sms": "SMS messages",
  "comms.call": "Phone calls",
  "comms.voicemail": "Voicemails",
  booking: "Bookings",
  mention: "@mentions",
  assignment: "Assignments",
  agent: "AI agent updates",
  feedback: "Feedback responses",
  system: "System alerts",
  queue_health: "Queue health",
  crm: "CRM automations",
};

function categoryLabel(c: string): string {
  return CATEGORY_LABELS[c] ?? c;
}

export default function UserNotificationSettingsPanel() {
  const { toast } = useToast();
  const qc = useQueryClient();

  const prefsQuery = useQuery<PreferencesResponse>({
    queryKey: ["/api/notifications/preferences"],
    queryFn: async () => {
      const res = await fetch("/api/notifications/preferences");
      if (!res.ok) throw new Error("Failed to load preferences");
      return res.json();
    },
  });

  const identityQuery = useQuery<IdentityResponse>({
    queryKey: ["/api/notifications/slack-identity"],
    queryFn: async () => {
      const res = await fetch("/api/notifications/slack-identity");
      if (!res.ok) throw new Error("Failed to load identity");
      return res.json();
    },
  });

  const updatePrefMutation = useMutation({
    mutationFn: async (row: PreferenceRow) => {
      const res = await apiRequest(
        "PUT",
        "/api/notifications/preferences",
        row,
      );
      if (!res.ok) throw new Error("Failed to save preference");
      return res.json();
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["/api/notifications/preferences"] }); // fire-and-forget: cache refresh only
    },
    onError: (err: any) => {
      toast({
        title: "Save failed",
        description: err?.message ?? "Could not update notification preference.",
        variant: "destructive",
      });
    },
  });

  const linkMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest(
        "POST",
        "/api/notifications/slack-identity/link",
        {},
      );
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? "link_failed");
      return body;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["/api/notifications/slack-identity"] }); // fire-and-forget: cache refresh only
      toast({ title: "Slack linked", description: "Your account is now linked to Slack." });
    },
    onError: (err: any) => {
      toast({
        title: "Could not link Slack",
        description:
          err?.message === "not_found"
            ? "No Slack user found for your NoBull OS email. Make sure your Slack email matches."
            : err?.message === "slack_not_configured"
            ? "Slack integration is not configured. Ask an admin to connect it under Integrations."
            : err?.message ?? "Linking failed.",
        variant: "destructive",
      });
    },
  });

  const disconnectMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("DELETE", "/api/notifications/slack-identity");
      if (!res.ok) throw new Error("Disconnect failed");
      return res.json();
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["/api/notifications/slack-identity"] }); // fire-and-forget: cache refresh only
      toast({ title: "Slack disconnected" });
    },
  });

  const testDmMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest(
        "POST",
        "/api/notifications/slack-identity/test",
        {},
      );
      const body = await res.json();
      if (!body?.ok) {
        throw new Error(body?.reason ?? body?.message ?? "test_failed");
      }
      return body;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["/api/notifications/slack-identity"] }); // fire-and-forget: cache refresh only
      toast({ title: "Test DM sent", description: "Check your Slack DMs." });
    },
    onError: (err: any) => {
      toast({
        title: "Test DM failed",
        description: err?.message ?? "Slack delivery failed.",
        variant: "destructive",
      });
    },
  });

  const isLoading = prefsQuery.isLoading || identityQuery.isLoading;
  const slackGloballyEnabled =
    prefsQuery.data?.slackDmGloballyEnabled ?? true;
  const identity = identityQuery.data?.identity;
  const connected = !!identityQuery.data?.connected;
  const lastDmFailed = identity?.lastDmStatus?.startsWith("failed");

  return (
    <Card data-testid="card-user-notification-settings">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MessageSquare className="w-5 h-5" />
          Notifications
        </CardTitle>
        <CardDescription>
          Choose which notifications appear in the bell and which are sent to
          you in Slack.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading…
          </div>
        ) : (
          <>
            {/* ─── Slack identity ───────────────────────────────────── */}
            <section className="space-y-3" data-testid="section-slack-identity">
              <h3 className="text-sm font-semibold">Slack DM forwarding</h3>
              {!slackGloballyEnabled && (
                <Alert>
                  <AlertTriangle className="w-4 h-4" />
                  <AlertDescription>
                    Per-user Slack DMs are currently disabled by an admin.
                  </AlertDescription>
                </Alert>
              )}
              {connected ? (
                <div
                  className="flex flex-col gap-2 rounded-md border p-3"
                  data-testid="block-slack-connected"
                >
                  <div className="flex items-center gap-2 text-sm">
                    <CheckCircle className="w-4 h-4 text-green-600" />
                    <span>
                      Linked to Slack user{" "}
                      <code className="text-xs">{identity?.slackUserId}</code>
                      {identity?.slackEmail ? ` (${identity.slackEmail})` : null}
                    </span>
                  </div>
                  {lastDmFailed && (
                    <Alert variant="destructive" data-testid="alert-slack-last-dm-failed">
                      <AlertTriangle className="w-4 h-4" />
                      <AlertDescription>
                        Last Slack DM failed ({identity?.lastDmStatus}). Try
                        sending a test DM or reconnect Slack.
                      </AlertDescription>
                    </Alert>
                  )}
                  <div className="flex gap-2 flex-wrap">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => testDmMutation.mutate()}
                      disabled={testDmMutation.isPending}
                      data-testid="button-slack-test-dm"
                    >
                      {testDmMutation.isPending && (
                        <Loader2 className="w-3 h-3 animate-spin mr-1" />
                      )}
                      Send test DM
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => disconnectMutation.mutate()}
                      disabled={disconnectMutation.isPending}
                      data-testid="button-slack-disconnect"
                    >
                      Disconnect Slack
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="space-y-2" data-testid="block-slack-disconnected">
                  <p className="text-sm text-gray-600">
                    Connect your Slack account to receive notification DMs.
                    We&apos;ll look you up by the email on your NoBull OS profile.
                  </p>
                  <Button
                    size="sm"
                    onClick={() => linkMutation.mutate()}
                    disabled={linkMutation.isPending}
                    data-testid="button-slack-link"
                  >
                    {linkMutation.isPending && (
                      <Loader2 className="w-3 h-3 animate-spin mr-1" />
                    )}
                    Link Slack account
                  </Button>
                </div>
              )}
            </section>

            {/* ─── per-category preferences ─────────────────────────── */}
            <section className="space-y-3" data-testid="section-pref-matrix">
              <h3 className="text-sm font-semibold">Per-category preferences</h3>
              <div className="border rounded-md divide-y">
                <div className="grid grid-cols-[1fr_100px_100px] gap-2 px-3 py-2 text-xs font-medium text-gray-500">
                  <div>Category</div>
                  <div className="text-center">In-app bell</div>
                  <div className="text-center">Slack DM</div>
                </div>
                {(prefsQuery.data?.preferences ?? []).map((row) => (
                  <div
                    key={row.category}
                    className="grid grid-cols-[1fr_100px_100px] gap-2 px-3 py-2 items-center"
                    data-testid={`row-pref-${row.category}`}
                  >
                    <div className="text-sm">
                      {categoryLabel(row.category)}
                      <Badge variant="outline" className="ml-2 text-caption">
                        {row.category}
                      </Badge>
                    </div>
                    <div className="flex justify-center">
                      <Switch
                        checked={row.inAppEnabled}
                        onCheckedChange={(v) =>
                          updatePrefMutation.mutate({
                            ...row,
                            inAppEnabled: !!v,
                          })
                        }
                        data-testid={`switch-inapp-${row.category}`}
                      />
                    </div>
                    <div className="flex justify-center">
                      <Switch
                        checked={row.slackDmEnabled}
                        disabled={!connected || !slackGloballyEnabled}
                        onCheckedChange={(v) =>
                          updatePrefMutation.mutate({
                            ...row,
                            slackDmEnabled: !!v,
                          })
                        }
                        data-testid={`switch-slack-${row.category}`}
                      />
                    </div>
                  </div>
                ))}
              </div>
              <p className="text-xs text-gray-500">
                In-app bell entries are always written; the Slack DM column
                only changes whether the same event is also mirrored to Slack.
              </p>
            </section>
          </>
        )}
      </CardContent>
    </Card>
  );
}
