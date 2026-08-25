/**
 * Task #4334 — Outbound Email admin (team_lead+): the operator surface for
 * the one client-facing outbound-email seam.
 *
 * Routing policy surfaced here exactly as the service enforces it:
 *   - every send goes out from the ASSIGNED SENDER'S OWN mailbox (their
 *     Front channel, mapped on the Mailboxes tab);
 *   - per-user daily caps (override per mailbox, default in Settings);
 *     cap-exhausted sends defer to the next UTC window — or overflow to
 *     SendGrid ONLY when the CEO-gated fallback is enabled on a verified
 *     marketing domain (SPF/DKIM via SendGrid + DMARC via DNS);
 *   - the global suppression list is enforced on every path; suppressed
 *     recipients show up in the log as visibly skipped.
 *
 * Tabs: Compose · Send Log · Suppressions · Mailboxes · Settings.
 */
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { PageHeader } from "@/components/admin/PageHeader";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import {
  CheckCircle2,
  Loader2,
  Mail,
  PauseCircle,
  RefreshCw,
  Send,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  XCircle,
} from "lucide-react";

// ── Types mirrored from the API ──────────────────────────────────────────────

interface OutboundEmailRow {
  id: string;
  batchId: string;
  senderUserId: string;
  clientId: string | null;
  toEmail: string;
  subject: string;
  messageClass: string;
  status: string;
  path: string | null;
  frontMessageId: string | null;
  sendgridMessageId: string | null;
  deliveryStatus: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  deferredCount: number;
  scheduledFor: string | null;
  sentAt: string | null;
  createdAt: string;
}

interface SuppressionRow {
  id: string;
  email: string;
  reason: string;
  source: string;
  notes: string | null;
  createdAt: string;
  lastEventAt: string | null;
}

interface IdentityRow {
  userId: string;
  frontChannelId: string;
  fromEmail: string;
  dailyCap: number | null;
  active: boolean;
  userName?: string | null;
  userEmail?: string | null;
}

interface FrontChannel {
  id: string | null;
  name: string | null;
  address: string | null;
  type: string | null;
  sendAs: string | null;
}

interface SettingsPayload {
  defaultDailyCap: number;
  paused: boolean;
  fallbackEnabled: boolean;
  marketingDomain: string | null;
  sendgridFromEmail: string | null;
  verification: {
    domain: string;
    sendgridValid: boolean;
    spfValid: boolean;
    dkimValid: boolean;
    dmarcFound: boolean;
    dmarcPolicy?: string | null;
    checkedAt: string;
    error?: string | null;
  } | null;
  sendgridConfigured: boolean;
  webhookConfigured: boolean;
}

interface CountersPayload {
  day: string;
  defaultCap: number;
  capsByUser: Record<string, number>;
  perUser: Array<{ senderUserId: string; sentCount: number }>;
  perDomain: Array<{ domain: string; sentCount: number }>;
  suppressedToday: number;
  deferredPending: number;
}

interface AppUser {
  id: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  role: string | null;
}

function userLabel(u: { firstName?: string | null; lastName?: string | null; email?: string | null; id?: string }): string {
  const name = [u.firstName, u.lastName].filter(Boolean).join(" ");
  return name || u.email || u.id || "Unknown";
}

const STATUS_BADGES: Record<string, { label: string; className: string }> = {
  queued: { label: "Queued", className: "bg-blue-500/15 text-blue-600 dark:text-blue-400" },
  deferred: { label: "Deferred", className: "bg-amber-500/15 text-amber-600 dark:text-amber-400" },
  sending: { label: "Sending", className: "bg-blue-500/15 text-blue-600 dark:text-blue-400" },
  sent: { label: "Sent", className: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" },
  suppressed: { label: "Suppressed — skipped", className: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400" },
  blocked_no_mailbox: { label: "No mailbox", className: "bg-red-500/15 text-red-600 dark:text-red-400" },
  failed: { label: "Failed", className: "bg-red-500/15 text-red-600 dark:text-red-400" },
  unknown: { label: "Unknown outcome", className: "bg-orange-500/15 text-orange-600 dark:text-orange-400" },
  cancelled: { label: "Cancelled", className: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400" },
};

function StatusBadge({ status }: { status: string }) {
  const meta = STATUS_BADGES[status] ?? { label: status, className: "bg-zinc-500/15 text-zinc-500" };
  return <Badge variant="outline" className={`border-0 ${meta.className}`}>{meta.label}</Badge>;
}

function PathBadge({ row }: { row: OutboundEmailRow }) {
  if (!row.path) return <span className="text-muted-foreground text-xs">—</span>;
  return row.path === "front_channel" ? (
    <Badge variant="outline" className="border-0 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">Own mailbox</Badge>
  ) : (
    <Badge variant="outline" className="border-0 bg-purple-500/10 text-purple-600 dark:text-purple-400">SendGrid fallback</Badge>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function OutboundEmail() {
  const { user } = useAuth();
  const isLead = user?.role === "ceo" || user?.role === "team_lead";
  const isCeo = user?.role === "ceo";

  if (!isLead) {
    return (
      <div className="container mx-auto max-w-3xl px-4 py-16 text-center">
        <ShieldAlert className="mx-auto h-10 w-10 text-muted-foreground" />
        <h1 className="mt-4 text-xl font-semibold">Team lead access required</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          The outbound email console is limited to team leads and the CEO.
        </p>
      </div>
    );
  }

  return (
    <div className="container mx-auto max-w-6xl px-4 py-6 space-y-6">
      <PageHeader
        title="Outbound Email"
        icon={Mail}
        backHref="/admin/integrations"
        subtitle="Every send goes out from the assigned sender's own mailbox (their Front channel). SendGrid is overflow only — off until the marketing domain is verified and the CEO enables it."
        actions={<OutboundEmailHeaderActions />}
      />
      <CountersStrip />
      <Tabs defaultValue="compose">
        <TabsList className="flex flex-wrap h-auto w-fit max-w-full">
          <TabsTrigger value="compose" data-testid="tab-compose">Compose</TabsTrigger>
          <TabsTrigger value="log" data-testid="tab-log">Send Log</TabsTrigger>
          <TabsTrigger value="suppressions" data-testid="tab-suppressions">Suppressions</TabsTrigger>
          <TabsTrigger value="mailboxes" data-testid="tab-mailboxes">Mailboxes</TabsTrigger>
          <TabsTrigger value="settings" data-testid="tab-settings">Settings</TabsTrigger>
        </TabsList>
        <TabsContent value="compose"><ComposeTab /></TabsContent>
        <TabsContent value="log"><LogTab /></TabsContent>
        <TabsContent value="suppressions"><SuppressionsTab /></TabsContent>
        <TabsContent value="mailboxes"><MailboxesTab /></TabsContent>
        <TabsContent value="settings"><SettingsTab isCeo={isCeo} /></TabsContent>
      </Tabs>
    </div>
  );
}

function OutboundEmailHeaderActions() {
  const { data: settings } = useQuery<SettingsPayload>({ queryKey: ["/api/outbound-email/settings"] });
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {settings?.paused && (
        <Badge variant="outline" className="border-0 bg-amber-500/15 text-amber-600 dark:text-amber-400">
          <PauseCircle className="mr-1 h-3.5 w-3.5" /> Sending paused
        </Badge>
      )}
      {settings && (
        <Badge
          variant="outline"
          className={`border-0 ${settings.fallbackEnabled ? "bg-purple-500/10 text-purple-600 dark:text-purple-400" : "bg-zinc-500/10 text-zinc-500"}`}
          data-testid="badge-fallback-state"
        >
          Fallback {settings.fallbackEnabled ? "enabled" : "off"}
        </Badge>
      )}
    </div>
  );
}

function CountersStrip() {
  const { data, refetch, isFetching } = useQuery<CountersPayload>({
    queryKey: ["/api/outbound-email/counters"],
    refetchInterval: 60_000,
  });
  const { data: identityData } = useQuery<{ identities: IdentityRow[] }>({
    queryKey: ["/api/outbound-email/identities"],
  });
  const identityByUser = useMemo(() => {
    const map = new Map<string, IdentityRow>();
    for (const identity of identityData?.identities ?? []) map.set(identity.userId, identity);
    return map;
  }, [identityData]);

  if (!data) return null;
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">Today ({data.day} UTC)</CardTitle>
          <Button variant="ghost" size="sm" onClick={() => refetch()} disabled={isFetching} data-testid="button-refresh-counters">
            <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <div className="text-xs uppercase text-muted-foreground">Mailbox sends by user</div>
          {data.perUser.length === 0 ? (
            <div className="mt-1 text-sm text-muted-foreground">None yet</div>
          ) : (
            <ul className="mt-1 space-y-1 text-sm">
              {data.perUser.map((u) => {
                const cap = data.capsByUser[u.senderUserId] ?? data.defaultCap;
                const identity = identityByUser.get(u.senderUserId);
                const nearCap = u.sentCount >= cap * 0.8;
                return (
                  <li key={u.senderUserId} className="flex items-center justify-between gap-2">
                    <span className="truncate">{identity ? userLabel({ firstName: identity.userName, email: identity.userEmail, id: u.senderUserId }) : u.senderUserId}</span>
                    <span className={nearCap ? "font-medium text-amber-600 dark:text-amber-400" : "text-muted-foreground"}>
                      {u.sentCount}/{cap}{u.sentCount >= cap ? " · cap reached" : nearCap ? " · near cap" : ""}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <div>
          <div className="text-xs uppercase text-muted-foreground">Recipient domains</div>
          {data.perDomain.length === 0 ? (
            <div className="mt-1 text-sm text-muted-foreground">None yet</div>
          ) : (
            <ul className="mt-1 space-y-1 text-sm">
              {data.perDomain.slice(0, 6).map((d) => (
                <li key={d.domain} className="flex items-center justify-between gap-2">
                  <span className="truncate">{d.domain}</span>
                  <span className="text-muted-foreground">{d.sentCount}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <div className="text-xs uppercase text-muted-foreground">Suppressed skips</div>
          <div className="mt-1 text-2xl font-semibold" data-testid="text-suppressed-today">{data.suppressedToday}</div>
          <div className="text-xs text-muted-foreground">recipients skipped today</div>
        </div>
        <div>
          <div className="text-xs uppercase text-muted-foreground">Waiting for capacity</div>
          <div className="mt-1 text-2xl font-semibold" data-testid="text-deferred-pending">{data.deferredPending}</div>
          <div className="text-xs text-muted-foreground">deferred to a later window</div>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Compose ──────────────────────────────────────────────────────────────────

function ComposeTab() {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: users } = useQuery<AppUser[]>({ queryKey: ["/api/users"] });
  const { data: identityData } = useQuery<{ identities: IdentityRow[] }>({
    queryKey: ["/api/outbound-email/identities"],
  });

  const [senderUserId, setSenderUserId] = useState<string>("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [recipientsText, setRecipientsText] = useState("");
  const [messageClass, setMessageClass] = useState<"transactional" | "marketing">("transactional");
  const [lastResult, setLastResult] = useState<{ batchId: string; total: number; enqueued: number; suppressed: number } | null>(null);

  const effectiveSender = senderUserId || user?.id || "";
  const senderIdentity = identityData?.identities.find((identity) => identity.userId === effectiveSender);

  const recipients = useMemo(
    () =>
      recipientsText
        .split(/[\s,;]+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 3 && s.includes("@")),
    [recipientsText],
  );

  const composeMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/outbound-email/compose", {
        senderUserId: effectiveSender,
        subject,
        bodyText: body,
        messageClass,
        recipients: recipients.map((email) => ({ email })),
      });
      return res.json();
    },
    onSuccess: (result) => {
      setLastResult(result);
      setSubject("");
      setBody("");
      setRecipientsText("");
      void queryClient.invalidateQueries({ queryKey: ["/api/outbound-email/counters"] });
      void queryClient.invalidateQueries({ queryKey: ["/api/outbound-email/log"] });
      toast({
        title: "Batch queued",
        description: `${result.enqueued} queued · ${result.suppressed} suppressed (skipped)`,
      });
    },
    onError: (err: any) => {
      toast({ title: "Compose failed", description: String(err?.message ?? err), variant: "destructive" });
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Compose</CardTitle>
        <CardDescription>
          Fans out one job per recipient from the sender&apos;s own mailbox. Suppressed addresses are
          skipped visibly; cap-exhausted sends wait for the next window (or overflow if the fallback is on).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label>Send as</Label>
            <Select value={effectiveSender} onValueChange={setSenderUserId}>
              <SelectTrigger aria-label="Send as mailbox" data-testid="select-sender">
                <SelectValue placeholder="Choose sender" />
              </SelectTrigger>
              <SelectContent>
                {(users ?? []).map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    {userLabel(u)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {effectiveSender && !senderIdentity && (
              <p className="flex items-center gap-1 text-xs text-red-600 dark:text-red-400">
                <XCircle className="h-3.5 w-3.5" />
                No mailbox mapped — sends will be blocked until this user gets a Front channel (Mailboxes tab).
              </p>
            )}
            {senderIdentity && !senderIdentity.active && (
              <p className="text-xs text-amber-600 dark:text-amber-400">Mailbox mapping is inactive.</p>
            )}
            {senderIdentity?.active && (
              <p className="text-xs text-muted-foreground">Sends from {senderIdentity.fromEmail}</p>
            )}
          </div>
          <div className="space-y-2">
            <Label>Message class</Label>
            <Select value={messageClass} onValueChange={(v) => setMessageClass(v as any)}>
              <SelectTrigger data-testid="select-message-class">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="transactional">Transactional (1:1 business correspondence)</SelectItem>
                <SelectItem value="marketing">Marketing (adds unsubscribe link)</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="compose-recipients">Recipients</Label>
          <Textarea
            id="compose-recipients"
            placeholder="one@example.com, two@example.com — comma, space, or newline separated"
            value={recipientsText}
            onChange={(e) => setRecipientsText(e.target.value)}
            rows={3}
            data-testid="input-recipients"
          />
          <p className="text-xs text-muted-foreground">{recipients.length} recipient{recipients.length === 1 ? "" : "s"} detected (max 200)</p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="compose-subject">Subject</Label>
          <Input id="compose-subject" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={500} data-testid="input-subject" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="compose-body">Message</Label>
          <Textarea id="compose-body" value={body} onChange={(e) => setBody(e.target.value)} rows={8} data-testid="input-body" />
        </div>
        <div className="flex items-center gap-3">
          <Button
            onClick={() => composeMutation.mutate()}
            disabled={composeMutation.isPending || recipients.length === 0 || !subject.trim() || !body.trim() || recipients.length > 200}
            data-testid="button-send"
          >
            {composeMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
            Queue {recipients.length > 0 ? `${recipients.length} ` : ""}send{recipients.length === 1 ? "" : "s"}
          </Button>
          {lastResult && (
            <span className="text-sm text-muted-foreground" data-testid="text-last-batch">
              Last batch: {lastResult.enqueued} queued, {lastResult.suppressed} suppressed.
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ── Send log ─────────────────────────────────────────────────────────────────

function LogTab() {
  const [status, setStatus] = useState<string>("all");
  const [path, setPath] = useState<string>("all");
  const [search, setSearch] = useState("");

  const queryParams = new URLSearchParams();
  if (status !== "all") queryParams.set("status", status);
  if (path !== "all") queryParams.set("path", path);
  if (search.trim()) queryParams.set("toEmail", search.trim());
  queryParams.set("limit", "100");
  const qs = queryParams.toString();

  const { data, refetch, isFetching } = useQuery<{ rows: OutboundEmailRow[]; total: number }>({
    queryKey: [`/api/outbound-email/log?${qs}`],
    refetchInterval: 30_000,
  });

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle className="text-base">Send log</CardTitle>
            <CardDescription>Per-recipient outcome and which path carried the send.</CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              placeholder="Filter by recipient…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-56"
              data-testid="input-log-search"
            />
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="w-44" data-testid="select-log-status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                {Object.entries(STATUS_BADGES).map(([value, meta]) => (
                  <SelectItem key={value} value={value}>{meta.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={path} onValueChange={setPath}>
              <SelectTrigger className="w-44" data-testid="select-log-path">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All paths</SelectItem>
                <SelectItem value="front_channel">Own mailbox</SelectItem>
                <SelectItem value="sendgrid">SendGrid fallback</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="ghost" size="sm" onClick={() => refetch()} disabled={isFetching}>
              <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {!data ? (
          <div className="py-8 text-center text-sm text-muted-foreground">Loading…</div>
        ) : data.rows.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">No sends match these filters yet.</div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Recipient</TableHead>
                <TableHead>Subject</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Path</TableHead>
                <TableHead>Delivery</TableHead>
                <TableHead>Detail</TableHead>
                <TableHead className="text-right">When</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.rows.map((row) => (
                <TableRow key={row.id} data-testid={`row-send-${row.id}`}>
                  <TableCell className="font-medium">{row.toEmail}</TableCell>
                  <TableCell className="max-w-56 truncate" title={row.subject}>{row.subject}</TableCell>
                  <TableCell><StatusBadge status={row.status} /></TableCell>
                  <TableCell><PathBadge row={row} /></TableCell>
                  <TableCell className="text-xs text-muted-foreground">{row.deliveryStatus ?? "—"}</TableCell>
                  <TableCell className="max-w-64">
                    {row.errorMessage ? (
                      <span className="text-xs text-muted-foreground" title={row.errorMessage}>
                        {row.errorMessage.length > 80 ? `${row.errorMessage.slice(0, 80)}…` : row.errorMessage}
                      </span>
                    ) : row.deferredCount > 0 ? (
                      <span className="text-xs text-muted-foreground">deferred ×{row.deferredCount}</span>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-right text-xs text-muted-foreground">
                    {new Date(row.sentAt ?? row.createdAt).toLocaleString()}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {data && <p className="mt-3 text-xs text-muted-foreground">{data.total} total match{data.total === 1 ? "" : "es"} (showing up to 100).</p>}
      </CardContent>
    </Card>
  );
}

// ── Suppressions ─────────────────────────────────────────────────────────────

function SuppressionsTab() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newReason, setNewReason] = useState("manual");
  const [newNotes, setNewNotes] = useState("");

  const qs = search.trim() ? `?search=${encodeURIComponent(search.trim())}&limit=100` : "?limit=100";
  const { data, refetch } = useQuery<{ rows: SuppressionRow[]; total: number }>({
    queryKey: [`/api/outbound-email/suppressions${qs}`],
  });

  const addMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/outbound-email/suppressions", {
        email: newEmail.trim(),
        reason: newReason,
        notes: newNotes.trim() || undefined,
      });
      return res.json();
    },
    onSuccess: () => {
      setNewEmail("");
      setNewNotes("");
      void queryClient.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith("/api/outbound-email/suppressions") });
      toast({ title: "Suppressed", description: "The address will be skipped on every future send." });
    },
    onError: (err: any) => toast({ title: "Could not add", description: String(err?.message ?? err), variant: "destructive" }),
  });

  const removeMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("DELETE", `/api/outbound-email/suppressions/${id}`);
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith("/api/outbound-email/suppressions") });
      toast({ title: "Removed", description: "The address can receive email again." });
    },
    onError: (err: any) => toast({ title: "Could not remove", description: String(err?.message ?? err), variant: "destructive" }),
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Add suppression</CardTitle>
          <CardDescription>
            Manually block an address. Bounces, complaints, unsubscribe links, and the website
            unsubscribe form all feed this list automatically.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="suppression-email">Email</Label>
            <Input id="suppression-email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} placeholder="person@example.com" className="w-64" data-testid="input-suppression-email" />
          </div>
          <div className="space-y-1">
            <Label>Reason</Label>
            <Select value={newReason} onValueChange={setNewReason}>
              <SelectTrigger className="w-40" data-testid="select-suppression-reason">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="manual">Manual</SelectItem>
                <SelectItem value="unsubscribe">Unsubscribe</SelectItem>
                <SelectItem value="bounce">Bounce</SelectItem>
                <SelectItem value="complaint">Complaint</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex-1 space-y-1">
            <Label htmlFor="suppression-notes">Notes (optional)</Label>
            <Input id="suppression-notes" value={newNotes} onChange={(e) => setNewNotes(e.target.value)} maxLength={500} data-testid="input-suppression-notes" />
          </div>
          <Button
            onClick={() => addMutation.mutate()}
            disabled={addMutation.isPending || !newEmail.includes("@")}
            data-testid="button-add-suppression"
          >
            {addMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Suppress"}
          </Button>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="text-base">Suppression list</CardTitle>
            <Input
              placeholder="Search…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-64"
              data-testid="input-suppression-search"
            />
          </div>
        </CardHeader>
        <CardContent>
          {!data ? (
            <div className="py-8 text-center text-sm text-muted-foreground">Loading…</div>
          ) : data.rows.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">No suppressed addresses{search ? " match this search" : " yet"}.</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Email</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Notes</TableHead>
                  <TableHead>Added</TableHead>
                  <TableHead className="text-right">Remove</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.rows.map((row) => (
                  <TableRow key={row.id} data-testid={`row-suppression-${row.id}`}>
                    <TableCell className="font-medium">{row.email}</TableCell>
                    <TableCell><Badge variant="outline">{row.reason}</Badge></TableCell>
                    <TableCell className="text-xs text-muted-foreground">{row.source}</TableCell>
                    <TableCell className="max-w-56 truncate text-xs text-muted-foreground" title={row.notes ?? ""}>{row.notes ?? "—"}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{new Date(row.createdAt).toLocaleDateString()}</TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => removeMutation.mutate(row.id)}
                        disabled={removeMutation.isPending}
                        aria-label={`Remove ${row.email}`}
                        data-testid={`button-remove-${row.id}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {data && <p className="mt-3 text-xs text-muted-foreground">{data.total} suppressed address{data.total === 1 ? "" : "es"}.</p>}
        </CardContent>
      </Card>
    </div>
  );
}

// ── Mailboxes ────────────────────────────────────────────────────────────────

function MailboxesTab() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: users } = useQuery<AppUser[]>({ queryKey: ["/api/users"] });
  const { data: identityData } = useQuery<{ identities: IdentityRow[] }>({
    queryKey: ["/api/outbound-email/identities"],
  });
  const { data: channelData } = useQuery<{ channels: FrontChannel[]; error?: string }>({
    queryKey: ["/api/outbound-email/front-channels"],
  });

  const identityByUser = useMemo(() => {
    const map = new Map<string, IdentityRow>();
    for (const identity of identityData?.identities ?? []) map.set(identity.userId, identity);
    return map;
  }, [identityData]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">User → mailbox mapping</CardTitle>
        <CardDescription>
          Each user sends from their OWN Front channel. Users without a mapping are blocked with a
          clear error — there is no silent fallback. Leave the cap blank to use the default.
        </CardDescription>
        {channelData?.error && (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            Front channel list unavailable: {channelData.error} — you can still edit caps/active state.
          </p>
        )}
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>User</TableHead>
              <TableHead>Front channel</TableHead>
              <TableHead>From address</TableHead>
              <TableHead className="w-28">Daily cap</TableHead>
              <TableHead className="w-20">Active</TableHead>
              <TableHead className="w-24 text-right">Save</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(users ?? []).map((u) => (
              <MailboxRow
                key={u.id}
                user={u}
                identity={identityByUser.get(u.id) ?? null}
                channels={channelData?.channels ?? []}
                onSaved={() => {
                  void queryClient.invalidateQueries({ queryKey: ["/api/outbound-email/identities"] });
                  toast({ title: "Mailbox mapping saved" });
                }}
                onError={(msg) => toast({ title: "Save failed", description: msg, variant: "destructive" })}
              />
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function MailboxRow({
  user,
  identity,
  channels,
  onSaved,
  onError,
}: {
  user: AppUser;
  identity: IdentityRow | null;
  channels: FrontChannel[];
  onSaved: () => void;
  onError: (msg: string) => void;
}) {
  const [channelId, setChannelId] = useState(identity?.frontChannelId ?? "");
  const [fromEmail, setFromEmail] = useState(identity?.fromEmail ?? "");
  const [cap, setCap] = useState<string>(identity?.dailyCap != null ? String(identity.dailyCap) : "");
  const [active, setActive] = useState(identity?.active ?? true);

  const selectedChannel = channels.find((c) => c.id === channelId);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("PUT", `/api/outbound-email/identities/${user.id}`, {
        frontChannelId: channelId,
        fromEmail: fromEmail.trim(),
        dailyCap: cap.trim() ? Number(cap) : null,
        active,
      });
      return res.json();
    },
    onSuccess: onSaved,
    onError: (err: any) => onError(String(err?.message ?? err)),
  });

  return (
    <TableRow data-testid={`row-mailbox-${user.id}`}>
      <TableCell className="font-medium">
        {userLabel(user)}
        <div className="text-xs text-muted-foreground">{user.email}</div>
      </TableCell>
      <TableCell>
        {channels.length > 0 ? (
          <Select
            value={channelId}
            onValueChange={(v) => {
              setChannelId(v);
              const ch = channels.find((c) => c.id === v);
              if (ch?.address && !fromEmail.trim()) setFromEmail(ch.address);
            }}
          >
            <SelectTrigger className="w-56" data-testid={`select-channel-${user.id}`}>
              <SelectValue placeholder="Choose channel" />
            </SelectTrigger>
            <SelectContent>
              {channels.filter((c) => c.id).map((c) => (
                <SelectItem key={c.id!} value={c.id!}>
                  {c.address || c.name || c.id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <Input value={channelId} onChange={(e) => setChannelId(e.target.value)} placeholder="cha_…" className="w-56" aria-label={`Front channel ID for ${userLabel(user)}`} />
        )}
        {selectedChannel?.type && <div className="mt-1 text-xs text-muted-foreground">{selectedChannel.type}</div>}
      </TableCell>
      <TableCell>
        <Input value={fromEmail} onChange={(e) => setFromEmail(e.target.value)} placeholder="user@nobull…" className="w-56" aria-label={`From address for ${userLabel(user)}`} />
      </TableCell>
      <TableCell>
        <Input value={cap} onChange={(e) => setCap(e.target.value.replace(/[^0-9]/g, ""))} placeholder="default" className="w-20" aria-label={`Daily cap for ${userLabel(user)}`} />
      </TableCell>
      <TableCell>
        <Switch checked={active} onCheckedChange={setActive} aria-label={`Active for ${userLabel(user)}`} />
      </TableCell>
      <TableCell className="text-right">
        <Button
          size="sm"
          variant="outline"
          onClick={() => saveMutation.mutate()}
          disabled={saveMutation.isPending || !channelId.trim() || !fromEmail.includes("@")}
          data-testid={`button-save-mailbox-${user.id}`}
        >
          {saveMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : identity ? "Update" : "Map"}
        </Button>
      </TableCell>
    </TableRow>
  );
}

// ── Settings ─────────────────────────────────────────────────────────────────

function SettingsTab({ isCeo }: { isCeo: boolean }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: settings } = useQuery<SettingsPayload>({ queryKey: ["/api/outbound-email/settings"] });

  const [defaultCap, setDefaultCap] = useState<string>("");
  const [domain, setDomain] = useState<string>("");
  const [fromEmail, setFromEmail] = useState<string>("");

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["/api/outbound-email/settings"] });

  const saveSettings = useMutation({
    mutationFn: async (bodyPayload: Record<string, unknown>) => {
      const res = await apiRequest("PUT", "/api/outbound-email/settings", bodyPayload);
      return res.json();
    },
    onSuccess: (result: any) => {
      void invalidate();
      toast({
        title: "Settings saved",
        description: result?.fallbackDisabled
          ? "The SendGrid fallback was turned OFF because the lane identity changed — re-enable after re-verifying."
          : undefined,
      });
    },
    onError: (err: any) => toast({ title: "Save failed", description: String(err?.message ?? err), variant: "destructive" }),
  });

  const pauseMutation = useMutation({
    mutationFn: async (paused: boolean) => {
      const res = await apiRequest("POST", "/api/outbound-email/pause", { paused });
      return res.json();
    },
    onSuccess: () => invalidate(),
    onError: (err: any) => toast({ title: "Pause toggle failed", description: String(err?.message ?? err), variant: "destructive" }),
  });

  const verifyMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/outbound-email/verify-domain");
      return res.json();
    },
    onSuccess: () => {
      void invalidate();
      toast({ title: "Verification refreshed" });
    },
    onError: (err: any) => toast({ title: "Verification failed", description: String(err?.message ?? err), variant: "destructive" }),
  });

  const fallbackMutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      const res = await apiRequest("POST", "/api/outbound-email/fallback-enabled", { enabled });
      return res.json();
    },
    onSuccess: (_r, enabled) => {
      void invalidate();
      toast({ title: enabled ? "SendGrid fallback ENABLED" : "SendGrid fallback disabled" });
    },
    onError: (err: any) => {
      void invalidate();
      toast({
        title: "Could not enable fallback",
        description: String(err?.message ?? err),
        variant: "destructive",
      });
    },
  });

  if (!settings) return <div className="py-8 text-center text-sm text-muted-foreground">Loading…</div>;

  const v = settings.verification;
  const verificationPassing = !!v && v.sendgridValid && v.spfValid && v.dkimValid && v.dmarcFound;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Sending</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between rounded-lg border p-3">
            <div>
              <div className="font-medium">Pause all outbound sending</div>
              <p className="text-sm text-muted-foreground">Queued sends wait (never fail) while paused.</p>
            </div>
            <Switch
              checked={settings.paused}
              onCheckedChange={(checked) => pauseMutation.mutate(checked)}
              disabled={pauseMutation.isPending}
              data-testid="switch-paused"
            />
          </div>
          <div className="flex items-end gap-3">
            <div className="space-y-1">
              <Label>Default daily cap per mailbox</Label>
              <Input
                value={defaultCap}
                onChange={(e) => setDefaultCap(e.target.value.replace(/[^0-9]/g, ""))}
                placeholder={String(settings.defaultDailyCap)}
                className="w-32"
                disabled={!isCeo}
                data-testid="input-default-cap"
              />
            </div>
            <Button
              variant="outline"
              onClick={() => saveSettings.mutate({ defaultDailyCap: Number(defaultCap) })}
              disabled={!isCeo || saveSettings.isPending || !defaultCap.trim()}
              data-testid="button-save-cap"
            >
              Save cap
            </Button>
            {!isCeo && <p className="pb-2 text-xs text-muted-foreground">CEO only</p>}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            SendGrid overflow fallback
            {settings.fallbackEnabled ? (
              <Badge variant="outline" className="border-0 bg-purple-500/10 text-purple-600 dark:text-purple-400">Enabled</Badge>
            ) : (
              <Badge variant="outline" className="border-0 bg-zinc-500/10 text-zinc-500">Off</Badge>
            )}
          </CardTitle>
          <CardDescription>
            Used only when a sender&apos;s daily cap is exhausted. Requires SendGrid domain
            authentication (SPF + DKIM), a DMARC record, and the CEO&apos;s explicit enable — in that order.
            Bulk-sender rules (one-click unsubscribe, suppression) apply automatically on this path.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!settings.sendgridConfigured && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-400">
              <p className="flex items-center gap-2">
                <ShieldAlert className="h-4 w-4 shrink-0" /> Email sending isn&apos;t set up in this
                environment — an admin needs to connect SendGrid before domain verification or
                fallback sends can run.
              </p>
              <p className="mt-1 pl-6 font-mono text-xs opacity-75">
                Technical detail: the SENDGRID_API_KEY secret is not set.
              </p>
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label>Marketing domain</Label>
              <Input
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                placeholder={settings.marketingDomain ?? "mail.example.com"}
                disabled={!isCeo}
                data-testid="input-marketing-domain"
              />
            </div>
            <div className="space-y-1">
              <Label>Fallback from address</Label>
              <Input
                value={fromEmail}
                onChange={(e) => setFromEmail(e.target.value)}
                placeholder={settings.sendgridFromEmail ?? "hello@mail.example.com"}
                disabled={!isCeo}
                data-testid="input-from-email"
              />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="outline"
              onClick={() => {
                const payload: Record<string, unknown> = {};
                if (domain.trim()) payload.marketingDomain = domain.trim().toLowerCase();
                if (fromEmail.trim()) payload.sendgridFromEmail = fromEmail.trim().toLowerCase();
                saveSettings.mutate(payload);
              }}
              disabled={!isCeo || saveSettings.isPending || (!domain.trim() && !fromEmail.trim())}
              data-testid="button-save-domain"
            >
              Save domain settings
            </Button>
            <Button
              variant="outline"
              onClick={() => verifyMutation.mutate()}
              disabled={!isCeo || verifyMutation.isPending || !settings.marketingDomain}
              data-testid="button-verify-domain"
            >
              {verifyMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ShieldCheck className="mr-2 h-4 w-4" />}
              Run verification
            </Button>
          </div>

          {v && (
            <div className="rounded-lg border p-3">
              <div className="mb-2 text-sm font-medium">Verification — {v.domain}</div>
              <div className="grid gap-2 sm:grid-cols-4">
                <VerificationItem label="SendGrid domain auth" ok={v.sendgridValid} />
                <VerificationItem label="SPF" ok={v.spfValid} />
                <VerificationItem label="DKIM" ok={v.dkimValid} />
                <VerificationItem label={`DMARC${v.dmarcPolicy ? ` (p=${v.dmarcPolicy})` : ""}`} ok={v.dmarcFound} />
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                Checked {new Date(v.checkedAt).toLocaleString()}{v.error ? ` · ${v.error}` : ""}
              </p>
            </div>
          )}

          <div className="flex items-center justify-between rounded-lg border p-3">
            <div>
              <div className="font-medium">Enable SendGrid fallback</div>
              <p className="text-sm text-muted-foreground">
                {verificationPassing
                  ? "Verification passing — the CEO can enable the overflow lane."
                  : "Blocked until every verification check passes. Enabling re-verifies server-side."}
              </p>
            </div>
            <Switch
              checked={settings.fallbackEnabled}
              onCheckedChange={(checked) => fallbackMutation.mutate(checked)}
              disabled={!isCeo || fallbackMutation.isPending || (!settings.fallbackEnabled && !verificationPassing)}
              data-testid="switch-fallback-enabled"
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Bounce/complaint webhook:{" "}
            {settings.webhookConfigured
              ? "signature verification is set up."
              : "not receiving events — an admin needs to add the webhook verification key before bounce/complaint events are accepted (technical detail: SENDGRID_WEBHOOK_PUBLIC_KEY is not set; unsigned events are rejected)."}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function VerificationItem({ label, ok }: { label: string; ok: boolean }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      {ok ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : <XCircle className="h-4 w-4 text-red-500" />}
      <span>{label}</span>
    </div>
  );
}
