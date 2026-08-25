import { useAuth } from "@/hooks/use-auth";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useToast } from "@/hooks/use-toast";
import { Shield, User, UserPlus, Copy, Check, Info, Phone, PhoneOff, AlertCircle, X, Trash2, RotateCcw, History, Pencil } from "lucide-react";
import { PageHeader } from "@/components/admin/PageHeader";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useEffect, useMemo, useState } from "react";
import { UserManagementSkeleton } from "@/components/ui/skeleton-loaders";
import { OsTable, type OsTableColumn } from "@/components/ui/os-table";
import {
  ALL_AUTHORITY_LEVELS,
  ALL_USER_FUNCTIONS,
  AUTHORITY_LABELS,
  FUNCTION_LABELS,
  REVENUE_SUBSUMED_FUNCTIONS,
  getUserFacet,
  isAuthorityLevel,
  isUserFunction,
  type UserAuthorityLevel,
  type UserFunction,
} from "@/lib/userLabels";

type UserType = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  profileImageUrl: string | null;
  role: string | null;
  functions: string[] | null;
  authorityLevel: string | null;
  callMode: string | null;
  callRoutingPhone: string | null;
};

type DeleteRestoreEvent = {
  id: string;
  actionType: "user_deleted" | "user_restored";
  actorId: string | null;
  actorName: string | null;
  timestamp: string;
  priorEmail: string | null;
};

type DeleteHistoryMap = Record<string, DeleteRestoreEvent[]>;

// Task #1950 — reassignment audit shape returned by
// GET /api/users/reassign-history (keyed by from-user id, newest first).
export type ReassignmentEvent = {
  id: string;
  actorId: string | null;
  actorName: string | null;
  timestamp: string;
  fromUserId: string;
  fromUserName: string | null;
  toUserId: string;
  toUserName: string | null;
  counts: { clients: number; threads: number; bookings: number };
  items: {
    clients: { id: string; label: string }[];
    threads: { threadKey: string }[];
    bookings: { id: string; label: string; startTimeUtc: string }[];
  };
};

type ReassignHistoryMap = Record<string, ReassignmentEvent[]>;

// Mirrors server-side isRestoredFallbackEmail / RESTORED_EMAIL_SUFFIX_RE
// in server/storage/clientStorage.ts. A deleted user restored via the
// suffix fallback gets a synthetic `<original>.restored.<ts>` email that
// will fail their next OIDC login until an admin cleans it up.
const RESTORED_FALLBACK_EMAIL_RE = /\.restored\.\d+$/;
function isRestoredFallbackEmail(email: string | null | undefined): boolean {
  return !!email && RESTORED_FALLBACK_EMAIL_RE.test(email);
}

function formatHistoryDate(ts: string): string {
  try {
    return new Date(ts).toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return ts;
  }
}

// Resolve a never-blank label for an audit actor. The backend already
// falls back name -> email, but old log rows (written before the users
// JOIN landed) or hard-deleted actors can leave actorName null. In that
// case show the raw actor id so the "Deleted by …" line is never empty,
// and only fall back to "System" when there truly is no actor.
function actorLabel(actorName: string | null, actorId: string | null): string {
  if (actorName && actorName.trim().length > 0) return actorName;
  if (actorId && actorId.trim().length > 0) return `user ${actorId}`;
  return "System";
}

function formatHistoryDay(ts: string): string {
  try {
    return new Date(ts).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return ts;
  }
}

function DeleteRestoreHistoryPopover({
  userId,
  events,
}: {
  userId: string;
  events: DeleteRestoreEvent[];
}) {
  if (!events || events.length === 0) return null;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs text-primary-ink hover:bg-primary/10"
          data-testid={`button-delete-history-${userId}`}
        >
          <History className="w-3.5 h-3.5 mr-1" />
          History
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-80 p-3"
        data-testid={`popover-delete-history-${userId}`}
      >
        <p className="text-xs font-medium text-foreground mb-2">
          Delete / restore history
        </p>
        <ol className="space-y-2">
          {events.map((ev) => (
            <li
              key={ev.id}
              className="text-xs text-foreground flex gap-2"
              data-testid={`history-event-${ev.id}`}
            >
              <span
                className={
                  "inline-flex items-center rounded-full px-1.5 py-0.5 text-xs font-medium shrink-0 " +
                  (ev.actionType === "user_deleted"
                    ? "bg-red-50 text-red-700 border border-red-200 dark:bg-red-950/30 dark:text-red-300 dark:border-red-800"
                    : "bg-green-50 text-green-700 border border-green-200 dark:bg-green-950/30 dark:text-green-300 dark:border-green-800")
                }
              >
                {ev.actionType === "user_deleted" ? "Deleted" : "Restored"}
              </span>
              <div className="min-w-0">
                <p>
                  by{" "}
                  <span className="font-medium">
                    {actorLabel(ev.actorName, ev.actorId)}
                  </span>
                </p>
                <p className="text-muted-foreground">{formatHistoryDate(ev.timestamp)}</p>
                {ev.actionType === "user_restored" && ev.priorEmail && (
                  <p className="text-muted-foreground truncate" title={ev.priorEmail}>
                    Prior email: {ev.priorEmail}
                  </p>
                )}
              </div>
            </li>
          ))}
        </ol>
      </PopoverContent>
    </Popover>
  );
}

// Task #1950 / #1981 — one reassignment event rendered from a given
// perspective. "out" shows where the items went ("moved to <to user>"),
// "in" shows where they came from ("moved from <from user>"). Item lists
// (clients / threads / bookings) stay expandable in both directions.
function ReassignEventCard({
  ev,
  perspective,
}: {
  ev: ReassignmentEvent;
  perspective: "out" | "in";
}) {
  const total = ev.counts.clients + ev.counts.threads + ev.counts.bookings;
  const byName = actorLabel(ev.actorName, ev.actorId);
  const counterpartyName =
    perspective === "out"
      ? ev.toUserName || ev.toUserId || "another user"
      : ev.fromUserName || ev.fromUserId || "another user";
  return (
    <li
      className="text-xs text-foreground border border-primary/10 rounded p-2 space-y-1.5"
      data-testid={`reassign-event-${ev.id}`}
    >
      <p>
        <span className="font-medium">{total}</span> item
        {total === 1 ? "" : "s"} moved {perspective === "out" ? "to" : "from"}{" "}
        <span className="font-medium">{counterpartyName}</span>
      </p>
      <p className="text-muted-foreground">
        by {byName} on {formatHistoryDate(ev.timestamp)}
      </p>
      {ev.items.clients.length > 0 && (
        <details data-testid={`reassign-clients-${ev.id}`}>
          <summary className="cursor-pointer text-primary-ink">
            Clients ({ev.counts.clients})
          </summary>
          <ul className="mt-1 ml-3 list-disc text-foreground space-y-0.5">
            {ev.items.clients.map((c) => (
              <li key={c.id} data-testid={`reassign-client-${c.id}`}>
                {c.label}
              </li>
            ))}
          </ul>
        </details>
      )}
      {ev.items.threads.length > 0 && (
        <details data-testid={`reassign-threads-${ev.id}`}>
          <summary className="cursor-pointer text-primary-ink">
            Threads ({ev.counts.threads})
          </summary>
          <ul className="mt-1 ml-3 list-disc text-foreground space-y-0.5 break-all">
            {ev.items.threads.map((t) => (
              <li key={t.threadKey} data-testid={`reassign-thread-${t.threadKey}`}>
                {t.threadKey}
              </li>
            ))}
          </ul>
        </details>
      )}
      {ev.items.bookings.length > 0 && (
        <details data-testid={`reassign-bookings-${ev.id}`}>
          <summary className="cursor-pointer text-primary-ink">
            Bookings ({ev.counts.bookings})
          </summary>
          <ul className="mt-1 ml-3 list-disc text-foreground space-y-0.5">
            {ev.items.bookings.map((b) => (
              <li key={b.id} data-testid={`reassign-booking-${b.id}`}>
                {b.label}
                {b.startTimeUtc && (
                  <span className="text-muted-foreground">
                    {" "}
                    ({formatHistoryDate(b.startTimeUtc)})
                  </span>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </li>
  );
}

// Task #1950 — popover summarizing every bulk reassignment whose source
// user was this deleted user. Shows "On <date>, N item(s) moved to
// <to user>" with each item list expandable so the CEO can see the
// actual clients / threads / bookings that ended up with the new owner.
function ReassignHistoryPopover({
  userId,
  events,
}: {
  userId: string;
  events: ReassignmentEvent[];
}) {
  if (!events || events.length === 0) return null;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs text-primary-ink hover:bg-primary/10"
          data-testid={`button-reassign-history-${userId}`}
        >
          <History className="w-3.5 h-3.5 mr-1" />
          Reassignments ({events.length})
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-96 p-3 max-h-[28rem] overflow-y-auto"
        data-testid={`popover-reassign-history-${userId}`}
      >
        <p className="text-xs font-medium text-foreground mb-2">
          Reassignments out of this user
        </p>
        <ol className="space-y-3">
          {events.map((ev) => (
            <ReassignEventCard key={ev.id} ev={ev} perspective="out" />
          ))}
        </ol>
      </PopoverContent>
    </Popover>
  );
}

// Task #1981 — active-user reassignment panel. Unlike the deleted-user
// popover (outbound only), a CEO investigating someone's current book of
// business wants both sides: what they recently inherited (inbound) and
// what they shed (outbound). Renders nothing when neither side has events.
export function ActiveUserReassignPopover({
  userId,
  inboundEvents,
  outboundEvents,
}: {
  userId: string;
  inboundEvents: ReassignmentEvent[];
  outboundEvents: ReassignmentEvent[];
}) {
  const inboundCount = inboundEvents?.length ?? 0;
  const outboundCount = outboundEvents?.length ?? 0;
  if (inboundCount === 0 && outboundCount === 0) return null;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs text-primary-ink hover:bg-primary/10"
          data-testid={`button-reassign-history-${userId}`}
        >
          <History className="w-3.5 h-3.5 mr-1" />
          Reassignments ({inboundCount + outboundCount})
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-96 p-3 max-h-[28rem] overflow-y-auto"
        data-testid={`popover-reassign-history-${userId}`}
      >
        <div className="space-y-3">
          <div>
            <p className="text-xs font-medium text-foreground mb-2">
              Inherited (moved into this user)
            </p>
            {inboundCount === 0 ? (
              <p
                className="text-xs text-muted-foreground italic"
                data-testid={`reassign-inbound-empty-${userId}`}
              >
                None
              </p>
            ) : (
              <ol className="space-y-3" data-testid={`reassign-inbound-${userId}`}>
                {inboundEvents.map((ev) => (
                  <ReassignEventCard key={ev.id} ev={ev} perspective="in" />
                ))}
              </ol>
            )}
          </div>
          <div>
            <p className="text-xs font-medium text-foreground mb-2">
              Shed (moved out of this user)
            </p>
            {outboundCount === 0 ? (
              <p
                className="text-xs text-muted-foreground italic"
                data-testid={`reassign-outbound-empty-${userId}`}
              >
                None
              </p>
            ) : (
              <ol className="space-y-3" data-testid={`reassign-outbound-${userId}`}>
                {outboundEvents.map((ev) => (
                  <ReassignEventCard key={ev.id} ev={ev} perspective="out" />
                ))}
              </ol>
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

type TwilioConfig = {
  isConfigured?: boolean;
  browserCalling?: { isConfigured?: boolean };
};

type Readiness = {
  status: "ready" | "blocked" | "unknown";
  mode: "browser" | "forward";
  modeLabel: string;
  summary: string;
  issues: string[];
  notes: string[];
};

function computeReadiness(
  u: UserType,
  cfg: TwilioConfig | undefined,
  cfgState: { loaded: boolean; error: boolean },
): Readiness {
  const mode: "browser" | "forward" = u.callMode === "forward" ? "forward" : "browser";
  const modeLabel = mode === "forward" ? "Forward to phone" : "Browser audio";
  const issues: string[] = [];
  const notes: string[] = [];

  if (!cfgState.loaded || cfgState.error) {
    return {
      status: "unknown",
      mode,
      modeLabel,
      summary: cfgState.error
        ? "Couldn't load Twilio configuration — readiness is unavailable."
        : "Checking Twilio configuration…",
      issues: [],
      notes: [],
    };
  }

  const twilioConfigured = !!cfg?.isConfigured;
  const browserConfigured = !!cfg?.browserCalling?.isConfigured;

  if (!twilioConfigured) {
    issues.push("Twilio account is not configured (Account SID + Auth Token missing in Twilio Admin).");
  }
  if (mode === "browser") {
    if (!browserConfigured) {
      issues.push("Browser calling is not configured for the workspace. An admin must set the Twilio API Key SID, API Key Secret, and TwiML App SID in Twilio Admin.");
    }
    notes.push("Microphone permission must be granted in this user's browser the first time they place a call.");
  } else {
    const phone = (u.callRoutingPhone ?? "").replace(/\D/g, "");
    if (!phone) {
      issues.push("Forward mode is on but no routing phone number is set on the user's profile.");
    } else if (phone.length < 10 || phone.length > 15) {
      issues.push(`Routing phone "${u.callRoutingPhone}" is not a valid 10–15 digit number.`);
    }
  }
  const ready = issues.length === 0;
  const summary = ready
    ? mode === "browser"
      ? "Ready to place calls in the browser."
      : `Ready — calls will ring ${u.callRoutingPhone}.`
    : `Cannot place calls (${issues.length} issue${issues.length === 1 ? "" : "s"}).`;
  return { status: ready ? "ready" : "blocked", mode, modeLabel, summary, issues, notes };
}

type PermissiveModeStatus = {
  permissive: boolean;
  effectiveAccessLabel: string;
};

type BackfillBanner = { dismissed: boolean };

function UserRoleEditor({
  u,
  disabled,
  onSave,
}: {
  u: UserType;
  disabled: boolean;
  onSave: (args: { functions: UserFunction[]; authorityLevel: UserAuthorityLevel }) => void;
}) {
  const initialFns = useMemo(
    () => (u.functions ?? []).filter(isUserFunction) as UserFunction[],
    [u.functions],
  );
  const initialAuth = isAuthorityLevel(u.authorityLevel)
    ? u.authorityLevel
    : ("core" as UserAuthorityLevel);
  const [selectedFns, setSelectedFns] = useState<UserFunction[]>(initialFns);
  const [authority, setAuthority] = useState<UserAuthorityLevel>(initialAuth);

  const isRevenueEngineer = selectedFns.includes("revenue_engineer");
  const facet = getUserFacet(selectedFns);

  function toggleFunction(fn: UserFunction) {
    setSelectedFns((prev) => {
      const has = prev.includes(fn);
      if (has) return prev.filter((f) => f !== fn);
      // Selecting revenue_engineer auto-drops the three subsumed lanes
      // (they're shown disabled, but in case they were already selected).
      if (fn === "revenue_engineer") {
        return [...prev.filter((f) => !REVENUE_SUBSUMED_FUNCTIONS.includes(f)), fn];
      }
      return [...prev, fn];
    });
  }

  const dirty =
    JSON.stringify([...selectedFns].sort()) !== JSON.stringify([...initialFns].sort()) ||
    authority !== initialAuth;

  return (
    <div className="flex flex-col gap-2 min-w-0 sm:min-w-[280px]" data-testid={`role-editor-${u.id}`}>
      <div className="flex flex-wrap items-center gap-1.5">
        {ALL_USER_FUNCTIONS.map((fn) => {
          const isSelected = selectedFns.includes(fn);
          const isSubsumed = isRevenueEngineer && REVENUE_SUBSUMED_FUNCTIONS.includes(fn);
          const chip = (
            <button
              key={fn}
              type="button"
              disabled={disabled || isSubsumed}
              onClick={() => toggleFunction(fn)}
              data-testid={`chip-function-${u.id}-${fn}`}
              className={
                "text-xs px-2 py-1 rounded-full border transition " +
                (isSelected
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-card text-foreground border-primary/30 hover:bg-primary/5") +
                (isSubsumed ? " opacity-40 cursor-not-allowed" : "") +
                (disabled ? " opacity-60 cursor-not-allowed" : "")
              }
              aria-pressed={isSelected}
            >
              {FUNCTION_LABELS[fn]}
            </button>
          );
          return isSubsumed ? (
            <Tooltip key={fn}>
              <TooltipTrigger asChild>{chip}</TooltipTrigger>
              <TooltipContent side="top">
                Revenue Engineer already covers Marketing, Intake, and Sales.
              </TooltipContent>
            </Tooltip>
          ) : (
            chip
          );
        })}
      </div>
      <div className="flex items-center gap-2">
        <Select
          value={authority}
          onValueChange={(v) => setAuthority(v as UserAuthorityLevel)}
          disabled={disabled}
        >
          <SelectTrigger className="w-32" data-testid={`select-authority-${u.id}`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ALL_AUTHORITY_LEVELS.map((a) => (
              <SelectItem key={a} value={a}>{AUTHORITY_LABELS[a]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="text-xs text-muted-foreground" data-testid={`text-facet-${u.id}`}>
          Facet: {facet}
        </span>
        <Button
          size="sm"
          disabled={disabled || !dirty}
          onClick={() => onSave({ functions: selectedFns, authorityLevel: authority })}
          data-testid={`button-save-role-${u.id}`}
          className="bg-primary hover:bg-primary/90 text-primary-foreground ml-auto"
        >
          Save
        </Button>
      </div>
    </div>
  );
}

// Task #4348 — server-paged user list. Page rows are plain users plus an
// optional per-row `originalEmailTaken` enrichment (the server checks the
// stripped original address against the WHOLE active table, which the
// client can no longer do from one page).
type PageUser = UserType & { originalEmailTaken?: boolean };
type PagedUsersResponse = {
  data: PageUser[];
  total: number;
  /** Absent when the legacy bare-array shape was served (test stubs). */
  unableTotal?: number;
  fallbackEmailTotal?: number;
};

/** Client facet labels → `/api/users/paged` facet param values. */
const FACET_PARAM: Record<string, "revenue" | "fulfillment" | "both" | "unassigned"> = {
  "Revenue Engineering": "revenue",
  Fulfillment: "fulfillment",
  "Revenue Engineering + Fulfillment": "both",
  Unassigned: "unassigned",
};

export default function UserManagement() {
  const { user, isLoading: authLoading } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [copied, setCopied] = useState(false);
  const [showOnlyUnableToCall, setShowOnlyUnableToCall] = useState(false);
  const [facetFilter, setFacetFilter] = useState<string>("all");
  const [authorityFilter, setAuthorityFilter] = useState<string>("all");
  const [functionFilter, setFunctionFilter] = useState<string>("all");
  const [bannerDismissed, setBannerDismissed] = useState(false);
  // Task #4348 — server pagination + debounced search state.
  const [userSearchInput, setUserSearchInput] = useState("");
  const [userSearch, setUserSearch] = useState("");
  const [usersPage, setUsersPage] = useState(1);
  const [usersPageSize, setUsersPageSize] = useState(50);

  useEffect(() => {
    const t = setTimeout(() => {
      setUserSearch(userSearchInput.trim());
      setUsersPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [userSearchInput]);

  const inviteLink = typeof window !== "undefined" ? `${window.location.origin}/login` : "";

  const copyInviteLink = () => {
    void navigator.clipboard.writeText(inviteLink).catch((err) => console.error("[UserManagement] copy invite link failed:", err)); // fire-and-forget: clipboard write
    setCopied(true);
    toast({ title: "Invite link copied to clipboard" });
    setTimeout(() => setCopied(false), 2000);
  };

  // Task #4348 — the user list is served one page at a time (the dev/prod
  // table is thousands of rows; the old whole-table fetch hung the page).
  // Filters and search run server-side; the response also carries the
  // whole-table `unableTotal` / `fallbackEmailTotal` counts the banners
  // used to derive client-side.
  const { data: pagedUsers, isLoading } = useQuery<PagedUsersResponse>({
    queryKey: [
      "/api/users/paged",
      usersPage,
      usersPageSize,
      userSearch,
      facetFilter,
      authorityFilter,
      functionFilter,
      showOnlyUnableToCall,
    ],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set("page", String(usersPage));
      params.set("pageSize", String(usersPageSize));
      if (userSearch) params.set("search", userSearch);
      const facetParam = FACET_PARAM[facetFilter];
      if (facetFilter !== "all" && facetParam) params.set("facet", facetParam);
      if (authorityFilter !== "all") params.set("authority", authorityFilter);
      if (functionFilter !== "all") params.set("fn", functionFilter);
      if (showOnlyUnableToCall) params.set("unable", "1");
      const res = await fetch(`/api/users/paged?${params.toString()}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to fetch users");
      const body = await res.json();
      // Legacy tolerance: a bare users array (older stubs / caches) is
      // treated as a single full page with no whole-table totals.
      if (Array.isArray(body)) {
        return { data: body, total: body.length } satisfies PagedUsersResponse;
      }
      return body as PagedUsersResponse;
    },
    // Keep the previous page on screen while the next one loads so paging
    // doesn't flash the whole-page skeleton.
    placeholderData: (prev) => prev,
    enabled: !!user && (user.role === "team_lead" || user.role === "ceo"),
  });
  const users = pagedUsers?.data;
  const usersTotal = pagedUsers?.total ?? 0;

  const { data: permissiveMode } = useQuery<PermissiveModeStatus>({
    queryKey: ["/api/admin/role-permissions/status"],
    queryFn: async () => {
      const res = await fetch("/api/admin/role-permissions/status", { credentials: "include" });
      if (!res.ok) return { permissive: true, effectiveAccessLabel: "All Functions + Team-Lead-Level Permissions" };
      return res.json();
    },
    enabled: !!user && (user.role === "team_lead" || user.role === "ceo"),
  });

  const { data: bannerStatus } = useQuery<BackfillBanner>({
    queryKey: ["/api/admin/role-backfill-banner"],
    queryFn: async () => {
      const res = await fetch("/api/admin/role-backfill-banner", { credentials: "include" });
      if (!res.ok) return { dismissed: true };
      return res.json();
    },
    enabled: !!user && (user.role === "team_lead" || user.role === "ceo"),
  });

  const dismissBannerMutation = useMutation({
    mutationFn: async () => {
      await fetch("/api/admin/role-backfill-banner/dismiss", {
        method: "POST",
        credentials: "include",
      });
    },
    onSuccess: () => {
      setBannerDismissed(true);
      void queryClient.invalidateQueries({ queryKey: ["/api/admin/role-backfill-banner"] }); // fire-and-forget: cache refresh only
    },
  });

  const { data: twilioConfig, isLoading: twilioConfigLoading, isError: twilioConfigError } = useQuery<TwilioConfig>({
    queryKey: ["/api/twilio/config"],
    queryFn: async () => {
      const res = await fetch("/api/twilio/config", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch Twilio config");
      return res.json();
    },
    enabled: !!user && (user.role === "team_lead" || user.role === "ceo"),
    retry: 1,
  });

  const cfgState = useMemo(
    () => ({ loaded: !twilioConfigLoading && !twilioConfigError, error: twilioConfigError }),
    [twilioConfigLoading, twilioConfigError],
  );

  const [deleteTarget, setDeleteTarget] = useState<UserType | null>(null);

  // Task #1909 — impact preview shown when the CEO opens the confirm
  // dialog. Fetched lazily once a target is set so we don't preflight
  // every user on the page. `null` = not loaded yet (show loading).
  type DeleteImpact = {
    assignedClients: { count: number; sample: Array<{ id: string; firmName: string }> };
    openThreads: { count: number; sample: Array<{ threadKey: string; status: string }> };
    upcomingBookings: {
      count: number;
      sample: Array<{
        id: string;
        startTimeUtc: string;
        inviteeName: string | null;
        clientId: string | null;
      }>;
    };
    hasImpact: boolean;
  };
  const { data: deleteImpactResponse, isFetching: deleteImpactLoading } = useQuery<{ impact: DeleteImpact }>({
    queryKey: ["/api/users", deleteTarget?.id, "delete-impact"],
    queryFn: async () => {
      const res = await fetch(`/api/users/${deleteTarget!.id}/delete-impact`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to load impact");
      return res.json();
    },
    enabled: !!deleteTarget,
    staleTime: 0,
  });
  const deleteImpact = deleteImpactResponse?.impact ?? null;

  // Task #1934 — in-dialog bulk reassignment. The CEO picks a new owner
  // from the user dropdown; one round-trip updates clients, open
  // threads, and upcoming bookings and returns the refreshed impact so
  // the confirm button can revert from "Delete anyway" to "Delete user".
  const [reassignTargetId, setReassignTargetId] = useState<string>("");
  const [reassignSearch, setReassignSearch] = useState<string>("");

  // Task #4348 — the reassign picker needs the FULL active-user list (the
  // paged query only holds the current page). Fetched lazily, only while
  // the delete dialog is open, and rendered as a search-bounded list
  // instead of a dropdown with thousands of items.
  const { data: reassignOptions } = useQuery<UserType[]>({
    queryKey: ["/api/users"],
    queryFn: async () => {
      const res = await fetch("/api/users", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch users");
      return res.json();
    },
    enabled: !!deleteTarget && user?.role === "ceo",
  });

  const reassignMutation = useMutation({
    meta: { silent: true },
    mutationFn: async (args: { fromUserId: string; toUserId: string }) => {
      const res = await fetch(`/api/users/${args.fromUserId}/reassign`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetUserId: args.toUserId }),
      });
      if (!res.ok) {
        let msg = "Failed to reassign work";
        try {
          const body = await res.json();
          if (body?.error) msg = body.error;
        } catch {}
        throw new Error(msg);
      }
      return res.json() as Promise<{
        result: { clients: number; threads: number; bookings: number };
        impact: DeleteImpact;
      }>;
    },
    onSuccess: (data, vars) => {
      queryClient.setQueryData(
        ["/api/users", vars.fromUserId, "delete-impact"],
        { impact: data.impact },
      );
      // The reassignments touch the clients/threads/bookings lists too.
      void queryClient.invalidateQueries({ queryKey: ["/api/clients"] }); // fire-and-forget: cache refresh only
      // Task #1950 — refresh the reassignment audit so the deleted-users
      // panel reflects the new event without a manual page reload.
      void queryClient.invalidateQueries({ queryKey: ["/api/users/reassign-history"] }); // fire-and-forget: cache refresh only
      const moved = data.result.clients + data.result.threads + data.result.bookings;
      toast({
        title: moved === 0
          ? "Nothing to reassign"
          : `Reassigned ${moved} item${moved === 1 ? "" : "s"}`,
      });
      setReassignTargetId("");
    },
    onError: (err: Error) => {
      toast({ title: err.message || "Failed to reassign work", variant: "destructive" });
    },
  });

  const deleteUserMutation = useMutation({
    meta: { silent: true },
    mutationFn: async (args: { id: string; force?: boolean }) => {
      const url = args.force
        ? `/api/users/${args.id}?force=true`
        : `/api/users/${args.id}`;
      const res = await fetch(url, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) {
        let msg = "Failed to delete user";
        let code: string | undefined;
        let impact: DeleteImpact | undefined;
        try {
          const body = await res.json();
          if (body?.error) msg = body.error;
          code = body?.code;
          impact = body?.impact;
        } catch {}
        const err = new Error(msg) as Error & {
          code?: string;
          impact?: DeleteImpact;
        };
        err.code = code;
        err.impact = impact;
        throw err;
      }
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/users"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/users/paged"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/users/deleted"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/users/delete-history"] }); // fire-and-forget: cache refresh only
      toast({ title: "User deleted" });
      setDeleteTarget(null);
    },
    onError: (err: Error & { code?: string; impact?: DeleteImpact }) => {
      // Task #1909 — a 409 here means the impact preflight raced (e.g.
      // a new thread got assigned between preview and confirm). The
      // dialog now shows the fresher counts; refresh the cached impact
      // and let the user re-confirm with force.
      if (err.code === "user_delete_requires_force" && err.impact && deleteTarget) {
        queryClient.setQueryData(
          ["/api/users", deleteTarget.id, "delete-impact"],
          { impact: err.impact },
        );
        toast({
          title: "Active assignments changed — please review and confirm again",
          variant: "destructive",
        });
        return;
      }
      toast({ title: err.message || "Failed to delete user", variant: "destructive" });
    },
  });

  const { data: deletedUsers } = useQuery<UserType[]>({
    queryKey: ["/api/users/deleted"],
    queryFn: async () => {
      const res = await fetch("/api/users/deleted", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch deleted users");
      return res.json();
    },
    enabled: !!user && user.role === "ceo",
  });

  // Task #1933 — inline email edit state. Driven from the email pencil
  // on each row. `target` is the user being edited, `value` is the
  // current input value, `conflict` is the displayName of the colliding
  // active user when the server returns 409 EMAIL_CONFLICT.
  const [emailEdit, setEmailEdit] = useState<{
    target: UserType;
    value: string;
    conflict: string | null;
  } | null>(null);

  const updateEmailMutation = useMutation({
    meta: { silent: true },
    mutationFn: async (args: { id: string; email: string }) => {
      const res = await fetch(`/api/users/${args.id}/email`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: args.email }),
      });
      if (!res.ok) {
        let body: any = null;
        try { body = await res.json(); } catch {}
        const err: any = new Error(body?.error || "Failed to update email");
        err.code = body?.code;
        err.collidingUser = body?.collidingUser;
        throw err;
      }
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/users"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/users/paged"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/users/deleted"] }); // fire-and-forget: cache refresh only
      setEmailEdit(null);
      toast({ title: "Email updated" });
    },
    onError: (err: any, variables: { id: string; email: string }) => {
      if (err?.code === "EMAIL_CONFLICT") {
        const conflictName =
          err?.collidingUser?.displayName ||
          err?.collidingUser?.email ||
          "another active user";
        setEmailEdit((cur) => {
          if (cur) return { ...cur, conflict: conflictName };
          // One-click restore lost a race (the original address got taken
          // between the client-side check and the request). Open the manual
          // edit dialog pre-filled so the CEO can pick a different address.
          const target = (users ?? []).find((u) => u.id === variables.id);
          if (!target) return cur;
          return { target, value: variables.email, conflict: conflictName };
        });
        return;
      }
      toast({
        title: err?.message || "Failed to update email",
        variant: "destructive",
      });
    },
  });

  // Task #2043 — on-demand restored-fallback email cleanup. The preview
  // (dry-run) is a read-only POST-less GET stored in local state; the run
  // enqueues a single forced sweep on the worker queue.
  type CleanupPreviewItem = {
    userId: string;
    userName: string;
    priorEmail: string;
    targetEmail: string;
    outcome: "restorable" | "collision";
  };
  type CleanupPreview = {
    candidates: number;
    restorable: number;
    collisions: number;
    paused: boolean;
    killSwitch: boolean;
    items: CleanupPreviewItem[];
  };
  const [cleanupPreview, setCleanupPreview] = useState<CleanupPreview | null>(
    null,
  );

  // Task #2283 — last-run status of the restored-fallback email cleanup so
  // an operator gets confirmation of what the most recent sweep actually
  // did (when it ran, how many repaired, how many left for manual cleanup)
  // without having to refresh the user list and guess.
  type CleanupLastRun = {
    ranAt: string;
    forced?: boolean;
    candidates: number;
    repaired: number;
    collisions: number;
    errors: number;
    reason?: string;
  };
  const previewCleanupMutation = useMutation({
    meta: { silent: true },
    mutationFn: async (): Promise<CleanupPreview> => {
      const res = await fetch("/api/users/restored-email-cleanup/preview", {
        credentials: "include",
      });
      if (!res.ok) {
        let body: any = null;
        try { body = await res.json(); } catch {}
        throw new Error(body?.error || "Failed to load preview");
      }
      return res.json();
    },
    onSuccess: (data) => setCleanupPreview(data),
    onError: (err: any) => {
      toast({
        title: err?.message || "Failed to load cleanup preview",
        variant: "destructive",
      });
    },
  });

  const runCleanupMutation = useMutation({
    meta: { silent: true },
    mutationFn: async () => {
      const res = await fetch("/api/users/restored-email-cleanup/run", {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        let body: any = null;
        try { body = await res.json(); } catch {}
        throw new Error(body?.reason || body?.error || "Failed to run cleanup");
      }
      return res.json();
    },
    onSuccess: () => {
      toast({
        title: "Cleanup started",
        description:
          "A cleanup sweep was queued. The outcome will appear below once it finishes.",
      });
      setCleanupPreview(null);
      // The sweep runs on the worker queue, so the persisted last-run
      // summary lands a moment after this enqueue returns. Poll the status
      // (and the user list) a few times so the readout updates without a
      // manual refresh.
      [1500, 4000, 8000].forEach((delay) => {
        setTimeout(() => {
          void queryClient.invalidateQueries({ // fire-and-forget: cache refresh only
            queryKey: ["/api/users/restored-email-cleanup/status"],
          });
          void queryClient.invalidateQueries({ queryKey: ["/api/users"] }); // fire-and-forget: cache refresh only
          void queryClient.invalidateQueries({ queryKey: ["/api/users/paged"] }); // fire-and-forget: cache refresh only
        }, delay);
      });
    },
    onError: (err: any) => {
      toast({
        title: err?.message || "Failed to run cleanup",
        variant: "destructive",
      });
    },
  });

  // Task #2246 — read-only last-run readout for the restored-fallback email
  // auto-cleanup scheduler (Task #2029). Mirrors the feedback→Slack retry
  // status surface: shows the live config plus when the job last ran (and
  // whether its last-run record is even readable) so a CEO can confirm the
  // cleanup is healthy even when no accounts currently need cleanup.
  type CleanupStatus = {
    config: {
      enabled: boolean;
      maxPerTick: number;
      collisionAlertThreshold: number;
      collisionStuckHours: number;
      tickIntervalMinutes: number;
    };
    lastRunStatus: "ok" | "never_run" | "unreadable";
    lastRunError?: string;
    lastRun: {
      ranAt: string;
      forced?: boolean;
      candidates: number;
      repaired: number;
      collisions: number;
      errors: number;
      stuckCollisions: number;
      reason?: string;
    } | null;
  };
  const { data: cleanupStatus } = useQuery<CleanupStatus>({
    queryKey: ["/api/users/restored-email-cleanup/status"],
    queryFn: async () => {
      const res = await fetch("/api/users/restored-email-cleanup/status", {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to fetch restored-email cleanup status");
      return res.json();
    },
    enabled: !!user && user.role === "ceo",
  });

  const [restoreConflict, setRestoreConflict] = useState<{
    deletedUser: UserType;
    email: string;
    collidingUser: {
      id: string;
      email: string | null;
      displayName: string;
    };
    fallbackPreviewEmail: string;
  } | null>(null);

  // Task #4348 — history maps are scoped to the visible rows (current
  // page + deleted users) via the endpoints' `ids` param instead of
  // pulling the audit for every user in the table.
  const historyIdsKey = [
    ...(users ?? []).map((u) => u.id),
    ...(deletedUsers ?? []).map((u) => u.id),
  ]
    .sort()
    .join(",");

  const { data: deleteHistory } = useQuery<DeleteHistoryMap>({
    queryKey: ["/api/users/delete-history", historyIdsKey],
    queryFn: async () => {
      const res = await fetch(
        `/api/users/delete-history?ids=${encodeURIComponent(historyIdsKey)}`,
        { credentials: "include" },
      );
      if (!res.ok) throw new Error("Failed to fetch user delete/restore history");
      return res.json();
    },
    enabled: !!user && user.role === "ceo" && historyIdsKey.length > 0,
  });

  // Task #1950 — reassignment audit keyed by source user (outbound: what
  // each user shed). Drives the deleted-users popover and the "shed" side
  // of the active-user popover.
  const { data: reassignHistory } = useQuery<ReassignHistoryMap>({
    queryKey: ["/api/users/reassign-history", historyIdsKey],
    queryFn: async () => {
      const res = await fetch(
        `/api/users/reassign-history?ids=${encodeURIComponent(historyIdsKey)}`,
        { credentials: "include" },
      );
      if (!res.ok) throw new Error("Failed to fetch user reassignment history");
      return res.json();
    },
    enabled: !!user && user.role === "ceo" && historyIdsKey.length > 0,
  });

  // Task #1981 — same audit keyed by destination user (inbound: what each
  // user inherited). Drives the "inherited" side of the active-user popover.
  const { data: inboundReassignHistory } = useQuery<ReassignHistoryMap>({
    queryKey: ["/api/users/reassign-history", "in", historyIdsKey],
    queryFn: async () => {
      const res = await fetch(
        `/api/users/reassign-history?direction=in&ids=${encodeURIComponent(historyIdsKey)}`,
        { credentials: "include" },
      );
      if (!res.ok) throw new Error("Failed to fetch inbound user reassignment history");
      return res.json();
    },
    enabled: !!user && user.role === "ceo" && historyIdsKey.length > 0,
  });

  const restoreUserMutation = useMutation({
    meta: { silent: true },
    mutationFn: async (args: {
      user: UserType;
      strategy?: "strict" | "suffix";
    }) => {
      const res = await fetch(`/api/users/${args.user.id}/restore`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          emailConflictStrategy: args.strategy ?? "strict",
        }),
      });
      if (!res.ok) {
        let body: any = null;
        try {
          body = await res.json();
        } catch {}
        if (res.status === 409 && body?.code === "EMAIL_CONFLICT") {
          const err: any = new Error(body.error || "Email conflict");
          err.conflict = body;
          err.deletedUser = args.user;
          throw err;
        }
        throw new Error(body?.error || "Failed to restore user");
      }
      return res.json();
    },
    onSuccess: (_data, vars) => {
      void queryClient.invalidateQueries({ queryKey: ["/api/users"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/users/paged"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/users/deleted"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/users/delete-history"] }); // fire-and-forget: cache refresh only
      setRestoreConflict(null);
      toast({
        title:
          vars.strategy === "suffix"
            ? "User restored with fallback email"
            : "User restored",
      });
    },
    onError: (err: any) => {
      if (err?.conflict?.code === "EMAIL_CONFLICT" && err?.deletedUser) {
        const c = err.conflict;
        setRestoreConflict({
          deletedUser: err.deletedUser,
          email: c.email,
          collidingUser: {
            id: c.collidingUser?.id ?? "",
            email: c.collidingUser?.email ?? null,
            displayName: c.collidingUser?.displayName ?? c.collidingUser?.email ?? "another user",
          },
          fallbackPreviewEmail: c.fallback?.previewEmail ?? `${c.email}.restored.<timestamp>`,
        });
        return;
      }
      toast({
        title: err?.message || "Failed to restore user",
        variant: "destructive",
      });
    },
  });

  const updateProfileMutation = useMutation({
    meta: { silent: true },
    mutationFn: async (args: { id: string; functions: UserFunction[]; authorityLevel: UserAuthorityLevel }) => {
      const res = await fetch(`/api/users/${args.id}/role`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ functions: args.functions, authorityLevel: args.authorityLevel }),
      });
      if (!res.ok) throw new Error("Failed to update role profile");
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/users"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/users/paged"] }); // fire-and-forget: cache refresh only
      toast({ title: "User role profile updated" });
    },
    onError: () => {
      toast({ title: "Failed to update user role profile", variant: "destructive" });
    },
  });

  // Task #4554 — closed admission: approve (pre-create) a user by email +
  // role profile so their sign-in is admitted. The users table IS the
  // allowlist; nobody gets a row auto-created at sign-in anymore.
  const [approveEmail, setApproveEmail] = useState("");
  const [approveFirstName, setApproveFirstName] = useState("");
  const [approveLastName, setApproveLastName] = useState("");
  const [approveAuthority, setApproveAuthority] = useState<UserAuthorityLevel>("core");
  const [approveFns, setApproveFns] = useState<UserFunction[]>([]);

  function toggleApproveFn(fn: UserFunction) {
    setApproveFns((prev) =>
      prev.includes(fn) ? prev.filter((f) => f !== fn) : [...prev, fn],
    );
  }

  const approveUserMutation = useMutation({
    meta: { silent: true },
    mutationFn: async () => {
      const res = await fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          email: approveEmail.trim(),
          firstName: approveFirstName.trim() || undefined,
          lastName: approveLastName.trim() || undefined,
          functions: approveFns,
          authorityLevel: approveAuthority,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        const err: any = new Error(body?.error || "Failed to approve user");
        err.status = res.status;
        throw err;
      }
      return res.json();
    },
    onSuccess: (created: { email?: string | null }) => {
      void queryClient.invalidateQueries({ queryKey: ["/api/users"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/users/paged"] }); // fire-and-forget: cache refresh only
      toast({
        title: "User approved",
        description: `${created?.email ?? approveEmail.trim()} can now sign in. Share the login link with them.`,
      });
      setApproveEmail("");
      setApproveFirstName("");
      setApproveLastName("");
      setApproveAuthority("core");
      setApproveFns([]);
    },
    onError: (err: any) => {
      toast({
        title:
          err?.status === 409
            ? "A user with this email already exists"
            : err?.message || "Failed to approve user",
        variant: "destructive",
      });
    },
  });

  const readinessByUser = useMemo(() => {
    const map = new Map<string, Readiness>();
    (users ?? []).forEach((u) => map.set(u.id, computeReadiness(u, twilioConfig, cfgState)));
    return map;
  }, [users, twilioConfig, cfgState]);

  // Whole-table count from the paged endpoint when available; falls back
  // to counting the current page (legacy bare-array responses).
  const unableCount = useMemo(
    () =>
      pagedUsers?.unableTotal ??
      Array.from(readinessByUser.values()).filter((r) => r.status === "blocked").length,
    [pagedUsers?.unableTotal, readinessByUser],
  );

  const visibleUsers = useMemo(() => {
    if (!users) return [];
    return users.filter((u) => {
      if (showOnlyUnableToCall && readinessByUser.get(u.id)?.status !== "blocked") return false;
      if (facetFilter !== "all" && getUserFacet(u.functions) !== facetFilter) return false;
      if (authorityFilter !== "all" && (u.authorityLevel ?? "core") !== authorityFilter) return false;
      if (functionFilter !== "all" && !(u.functions ?? []).includes(functionFilter)) return false;
      return true;
    });
  }, [users, readinessByUser, showOnlyUnableToCall, facetFilter, authorityFilter, functionFilter]);

  const fallbackEmailUsers = useMemo(
    () => (users ?? []).filter((u) => isRestoredFallbackEmail(u.email)),
    [users],
  );
  // Whole-table fallback-email count (banner); page-local count otherwise.
  const fallbackEmailCount = pagedUsers?.fallbackEmailTotal ?? fallbackEmailUsers.length;

  // Task #2012 — lowercased active-email → userId lookup so a fallback row
  // can tell, client-side, whether its stripped original address is still
  // free. Mirrors the server's case-insensitive uniqueness check.
  const activeEmailLookup = useMemo(() => {
    const m = new Map<string, string>();
    for (const u of users ?? []) {
      if (u.email) m.set(u.email.toLowerCase(), u.id);
    }
    return m;
  }, [users]);

  // Returns the stripped original address for a fallback user, or "" when
  // it can't be derived (e.g. empty email).
  const strippedOriginalEmail = (u: UserType) =>
    (u.email ?? "").replace(RESTORED_FALLBACK_EMAIL_RE, "");

  // True when the stripped original address is still owned by a different
  // active user (so one-click restore would collide). Also true when the
  // original can't be derived. Prefers the server's whole-table
  // `originalEmailTaken` enrichment (Task #4348 — the page only sees one
  // page of users); falls back to the page-local lookup for legacy
  // bare-array responses.
  const originalEmailIsTaken = (u: PageUser) => {
    if (typeof u.originalEmailTaken === "boolean") return u.originalEmailTaken;
    const original = strippedOriginalEmail(u).toLowerCase();
    if (!original) return true;
    const owner = activeEmailLookup.get(original);
    return !!owner && owner !== u.id;
  };

  if (authLoading || isLoading) return <UserManagementSkeleton />;

  const isTeamLead = user?.role === "team_lead" || user?.role === "ceo";
  const isCeo = user?.role === "ceo";

  if (!user || !isTeamLead) {
    return (
      <div className="min-h-[calc(100dvh-var(--nav-height))] bg-surface-warm-1 flex items-center justify-center">
        <div className="text-foreground">Access denied. Team Lead or CEO access required.</div>
      </div>
    );
  }

  const showBanner = bannerStatus && !bannerStatus.dismissed && !bannerDismissed;
  const permLabel = permissiveMode?.permissive === false ? "Strict" : "Permissive";
  const effectiveLabel =
    permissiveMode?.effectiveAccessLabel ?? "All Functions + Team-Lead-Level Permissions";

  // Task #4348 — OsTable column set for the paged user table. Deliberately a
  // plain const (NOT useMemo): this sits below the loading early-returns, so
  // a hook here would violate the Rules of Hooks.
  const userColumns: Array<OsTableColumn<PageUser>> = [
    {
      key: "user",
      header: "User",
      cell: (u) => {
        const userEvents = deleteHistory?.[u.id] ?? [];
        const latestRestore = userEvents.find((e) => e.actionType === "user_restored");
        const facet = getUserFacet(u.functions);
        return (
          <div className="flex items-center gap-3 min-w-0 py-1" data-testid={`row-user-${u.id}`}>
            {u.profileImageUrl ? (
              <img src={u.profileImageUrl} alt="" className="w-10 h-10 rounded-full shrink-0" />
            ) : (
              <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                <User className="w-5 h-5 text-primary" />
              </div>
            )}
            <div className="min-w-0">
              <p className="font-medium text-foreground truncate" data-testid={`text-user-name-${u.id}`}>
                {u.firstName && u.lastName ? `${u.firstName} ${u.lastName}` : u.firstName || u.email || "Unknown"}
              </p>
              <div className="flex items-center gap-1.5 min-w-0">
                <p className="text-sm text-muted-foreground truncate" data-testid={`text-user-email-${u.id}`}>{u.email}</p>
                {isRestoredFallbackEmail(u.email) && (
                  <span
                    className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-caption font-medium text-amber-800 shrink-0 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300"
                    title="This account has a restored-fallback email and will fail its next login. Edit the email to clean it up."
                    data-testid={`badge-fallback-email-${u.id}`}
                  >
                    <AlertCircle className="w-3 h-3" />
                    Needs email cleanup
                  </span>
                )}
                {/* Task #2012 — one-click "Restore original email"
                    when the stripped original address is free.
                    Falls back to a "taken" hint (manual edit via
                    the pencil) when another active user owns it. */}
                {isCeo && isRestoredFallbackEmail(u.email) && (
                  originalEmailIsTaken(u) ? (
                    <span
                      className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground shrink-0"
                      title={`The original address (${strippedOriginalEmail(u)}) is still used by another active user. Use the edit-email button to pick a different address.`}
                      data-testid={`text-original-email-taken-${u.id}`}
                    >
                      Original taken — edit manually
                    </span>
                  ) : (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-6 shrink-0 px-2 text-caption text-primary-ink hover:bg-primary/10"
                          disabled={updateEmailMutation.isPending}
                          onClick={() =>
                            updateEmailMutation.mutate({
                              id: u.id,
                              email: strippedOriginalEmail(u),
                            })
                          }
                          data-testid={`button-restore-original-email-${u.id}`}
                        >
                          <RotateCcw className="w-3 h-3 mr-1" />
                          Restore original email
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="top">
                        Set this user's email back to{" "}
                        {strippedOriginalEmail(u)}
                      </TooltipContent>
                    </Tooltip>
                  )
                )}
                {isCeo && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 shrink-0 text-primary-ink hover:bg-primary/10"
                        onClick={() =>
                          setEmailEdit({
                            target: u,
                            value: (u.email ?? "").replace(RESTORED_FALLBACK_EMAIL_RE, ""),
                            conflict: null,
                          })
                        }
                        data-testid={`button-edit-email-${u.id}`}
                        aria-label="Edit email"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="top">Edit email</TooltipContent>
                  </Tooltip>
                )}
              </div>
              <p className="text-xs text-muted-foreground" data-testid={`text-user-facet-${u.id}`}>{facet}</p>
              {isCeo && latestRestore && (
                <p
                  className="text-xs text-muted-foreground italic mt-0.5"
                  data-testid={`text-user-restored-hint-${u.id}`}
                >
                  Previously restored on {formatHistoryDay(latestRestore.timestamp)}
                </p>
              )}
            </div>
          </div>
        );
      },
    },
    {
      key: "readiness",
      header: "Call readiness",
      width: 170,
      cell: (u) => {
        const readiness = readinessByUser.get(u.id);
        if (!readiness) return null;
        return (
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button"
                className={"inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium border " +
                  (readiness.status === "ready" ? "bg-green-50 text-green-700 border-green-200 dark:bg-green-950/30 dark:text-green-300 dark:border-green-800" :
                   readiness.status === "blocked" ? "bg-red-50 text-red-700 border-red-200 dark:bg-red-950/30 dark:text-red-300 dark:border-red-800" :
                   "bg-muted/50 text-muted-foreground border-border")}
                data-testid={`badge-call-readiness-${u.id}`}>
                {readiness.status === "ready" ? <Phone className="w-3.5 h-3.5" /> :
                 readiness.status === "blocked" ? <PhoneOff className="w-3.5 h-3.5" /> :
                 <Info className="w-3.5 h-3.5" />}
                <span>{readiness.modeLabel}</span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="left" className="max-w-xs">
              <div className="space-y-1.5">
                <p className="font-medium">{readiness.summary}</p>
                {readiness.issues.map((issue, i) => (<p key={i} className="text-xs">{issue}</p>))}
              </div>
            </TooltipContent>
          </Tooltip>
        );
      },
    },
    {
      key: "role",
      header: "Role profile",
      cell: (u) => (
        <div className="flex items-center gap-3 flex-wrap">
          {u.role === "admin" && <Shield className="w-4 h-4 text-primary" />}
          {isCeo ? (
            <UserRoleEditor
              u={u}
              disabled={u.id === user.id || updateProfileMutation.isPending}
              onSave={(args) => updateProfileMutation.mutate({ id: u.id, ...args })}
            />
          ) : (
            <div className="text-xs text-foreground">
              <div>{(u.functions ?? []).map((f) => isUserFunction(f) ? FUNCTION_LABELS[f] : f).join(", ") || "—"}</div>
              <div className="text-muted-foreground">{isAuthorityLevel(u.authorityLevel) ? AUTHORITY_LABELS[u.authorityLevel] : "Core"}</div>
            </div>
          )}
        </div>
      ),
    },
    ...(isCeo
      ? ([
          {
            key: "history",
            header: "History",
            width: 110,
            cell: (u) => (
              <ActiveUserReassignPopover
                userId={u.id}
                inboundEvents={inboundReassignHistory?.[u.id] ?? []}
                outboundEvents={reassignHistory?.[u.id] ?? []}
              />
            ),
          },
          {
            key: "actions",
            header: "",
            width: 64,
            align: "right",
            cell: (u) =>
              u.id !== user.id ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-primary-ink hover:bg-primary/10"
                      onClick={() => setDeleteTarget(u)}
                      disabled={deleteUserMutation.isPending}
                      data-testid={`button-delete-user-${u.id}`}
                      aria-label="Delete user"
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="left">Delete user</TooltipContent>
                </Tooltip>
              ) : null,
          },
        ] satisfies Array<OsTableColumn<PageUser>>)
      : []),
  ];

  return (
    <TooltipProvider delayDuration={150}>
      <div className="min-h-[calc(100dvh-var(--nav-height))] bg-surface-warm-1">
        <main className="max-w-7xl mx-auto p-6 space-y-6">
          <PageHeader title="User Management" backHref="/" />
          {showBanner && (
            <Card className="bg-amber-50 border-amber-300 dark:bg-amber-950/30 dark:border-amber-800" data-testid="banner-role-backfill">
              <CardContent className="flex items-start gap-3 p-4">
                <Info className="w-5 h-5 text-amber-700 dark:text-amber-400 mt-0.5 shrink-0" />
                <div className="flex-1 text-sm text-amber-900 dark:text-amber-200">
                  <p className="font-medium mb-1">Review backfilled user roles</p>
                  <p>
                    Existing users were backfilled with reasonable defaults
                    (Revenue Engineer for engineers, Sales Engineer for sales).
                    Please review and adjust function labels — this data will
                    eventually drive dashboards, RIS routing, notifications,
                    and permissions.
                  </p>
                </div>
                {isCeo && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-amber-900 dark:text-amber-200"
                    onClick={() => dismissBannerMutation.mutate()}
                    data-testid="button-dismiss-backfill-banner"
                  >
                    <X className="w-4 h-4" />
                  </Button>
                )}
              </CardContent>
            </Card>
          )}

          {fallbackEmailCount > 0 && (
            <Card className="bg-amber-50 border-amber-300 dark:bg-amber-950/30 dark:border-amber-800" data-testid="banner-fallback-email-cleanup">
              <CardContent className="flex items-start gap-3 p-4">
                <AlertCircle className="w-5 h-5 text-amber-700 dark:text-amber-400 mt-0.5 shrink-0" />
                <div className="flex-1 text-sm text-amber-900 dark:text-amber-200">
                  <p className="font-medium mb-1" data-testid="text-fallback-email-count">
                    {fallbackEmailCount}{" "}
                    {fallbackEmailCount === 1 ? "account needs" : "accounts need"}{" "}
                    email cleanup
                  </p>
                  <p>
                    {fallbackEmailCount === 1 ? "This account was" : "These accounts were"}{" "}
                    restored with a synthetic <code>.restored.&lt;timestamp&gt;</code> fallback
                    email and will fail at their next login until the address is fixed. Look for the
                    "Needs email cleanup" badge below{isCeo ? " and click \"Restore original email\" where the real address is free (or use the edit-email button to pick a new one)" : " and ask a CEO to edit the email"}.
                  </p>
                  {isCeo && (
                    <p className="mt-2">
                      Or fix every free one at once: preview what would change,
                      then run the cleanup. Accounts whose original address is
                      still taken stay listed for manual cleanup.
                    </p>
                  )}
                  {isCeo && (
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="border-amber-400 text-amber-900 hover:bg-amber-100 dark:border-amber-700 dark:text-amber-200 dark:hover:bg-amber-900/40"
                        disabled={previewCleanupMutation.isPending}
                        onClick={() => previewCleanupMutation.mutate()}
                        data-testid="button-preview-email-cleanup"
                      >
                        {previewCleanupMutation.isPending ? "Checking…" : "Preview cleanup"}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        className="bg-primary hover:bg-primary/90 text-primary-foreground"
                        disabled={runCleanupMutation.isPending}
                        onClick={() => runCleanupMutation.mutate()}
                        data-testid="button-run-email-cleanup"
                      >
                        <RotateCcw className="w-3.5 h-3.5 mr-1.5" />
                        {runCleanupMutation.isPending ? "Starting…" : "Run cleanup now"}
                      </Button>
                    </div>
                  )}
                  {isCeo && cleanupStatus && (
                    <div
                      className="mt-3 rounded-lg border border-amber-300 bg-card/70 p-3"
                      data-testid="readout-email-cleanup-last-run"
                    >
                      {cleanupStatus.lastRunStatus === "ok" && cleanupStatus.lastRun ? (
                        <>
                          <p
                            className="font-medium"
                            data-testid="text-cleanup-last-run-summary"
                          >
                            Last cleanup{cleanupStatus.lastRun.forced ? " (manual)" : ""}:{" "}
                            repaired {cleanupStatus.lastRun.repaired} of{" "}
                            {cleanupStatus.lastRun.candidates}
                            {cleanupStatus.lastRun.collisions > 0
                              ? `, ${cleanupStatus.lastRun.collisions} left for manual cleanup (original still in use)`
                              : ""}
                            {cleanupStatus.lastRun.errors > 0
                              ? `, ${cleanupStatus.lastRun.errors} errored`
                              : ""}
                            .
                          </p>
                          <p
                            className="mt-1 text-xs text-amber-800"
                            data-testid="text-cleanup-last-run-time"
                          >
                            Ran {new Date(cleanupStatus.lastRun.ranAt).toLocaleString()}
                          </p>
                          {cleanupStatus.lastRun.repaired === 0 &&
                            cleanupStatus.lastRun.reason && (
                              <p
                                className="mt-1 text-xs text-amber-800"
                                data-testid="text-cleanup-last-run-reason"
                              >
                                Nothing changed: {cleanupStatus.lastRun.reason}.
                              </p>
                            )}
                        </>
                      ) : cleanupStatus.lastRunStatus === "unreadable" ? (
                        <p
                          className="text-amber-800"
                          data-testid="text-cleanup-last-run-unreadable"
                        >
                          The last cleanup outcome couldn't be read
                          {cleanupStatus.lastRunError ? `: ${cleanupStatus.lastRunError}` : "."}
                        </p>
                      ) : (
                        <p
                          className="text-amber-800"
                          data-testid="text-cleanup-last-run-never"
                        >
                          No cleanup has run yet.
                        </p>
                      )}
                    </div>
                  )}
                  {isCeo && cleanupPreview && (
                    <div
                      className="mt-3 rounded-lg border border-amber-300 bg-card/70 p-3"
                      data-testid="readout-email-cleanup-preview"
                    >
                      <p className="font-medium" data-testid="text-cleanup-preview-summary">
                        Preview: {cleanupPreview.restorable} of{" "}
                        {cleanupPreview.candidates} can be restored now
                        {cleanupPreview.collisions > 0
                          ? `, ${cleanupPreview.collisions} blocked (original still in use)`
                          : ""}
                        .
                      </p>
                      {(cleanupPreview.paused || cleanupPreview.killSwitch) && (
                        <p className="mt-1 text-amber-800" data-testid="text-cleanup-preview-blocked">
                          Note: a run is currently paused
                          {cleanupPreview.paused ? " (queue paused)" : ""}
                          {cleanupPreview.killSwitch ? " (sweeps kill switch on)" : ""}{" "}
                          and won't change anything until that's cleared.
                        </p>
                      )}
                      {cleanupPreview.items.length > 0 && (
                        <ul className="mt-2 space-y-1">
                          {cleanupPreview.items.map((it) => (
                            <li
                              key={it.userId}
                              className="text-xs"
                              data-testid={`row-cleanup-preview-${it.userId}`}
                            >
                              <span className="font-medium">{it.userName}</span>{" "}
                              {it.outcome === "restorable" ? (
                                <span className="text-green-700">
                                  → {it.targetEmail}
                                </span>
                              ) : (
                                <span className="text-muted-foreground">
                                  → {it.targetEmail} (blocked — already in use)
                                </span>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          )}

          {isCeo && cleanupStatus && (
            <Card
              className="bg-card border-primary/10"
              data-testid="card-email-cleanup-status"
            >
              <CardContent className="p-4 text-xs text-foreground">
                <p className="font-medium text-sm mb-2 text-foreground">
                  Restored-email cleanup
                </p>
                <div className="flex flex-wrap gap-x-6 gap-y-1">
                  <div>
                    <span className="font-medium">Auto-cleanup:</span>{" "}
                    <span data-testid="text-cleanup-enabled">
                      {cleanupStatus.config.enabled
                        ? `On (every ${cleanupStatus.config.tickIntervalMinutes} min)`
                        : "Off"}
                    </span>
                  </div>
                  <div>
                    <span className="font-medium">Per run:</span>{" "}
                    <span data-testid="text-cleanup-max-per-tick">
                      up to {cleanupStatus.config.maxPerTick} accounts
                    </span>
                  </div>
                </div>
                <div className="mt-2">
                  {cleanupStatus.lastRunStatus === "ok" &&
                    cleanupStatus.lastRun && (
                      <span data-testid="text-cleanup-last-run">
                        Last ran{" "}
                        {new Date(cleanupStatus.lastRun.ranAt).toLocaleString()}
                        {cleanupStatus.lastRun.forced ? " (manual)" : ""} —{" "}
                        {cleanupStatus.lastRun.repaired} fixed,{" "}
                        {cleanupStatus.lastRun.collisions} blocked,{" "}
                        {cleanupStatus.lastRun.errors} errors
                        {cleanupStatus.lastRun.reason
                          ? ` (${cleanupStatus.lastRun.reason})`
                          : ""}
                        .
                      </span>
                    )}
                  {cleanupStatus.lastRunStatus === "never_run" && (
                    <span data-testid="text-cleanup-last-run-never">
                      Has not run yet.
                    </span>
                  )}
                  {cleanupStatus.lastRunStatus === "unreadable" && (
                    <span
                      className="text-amber-800"
                      data-testid="text-cleanup-last-run-unreadable"
                    >
                      ⚠ The last-run record could not be read
                      {cleanupStatus.lastRunError
                        ? ` (${cleanupStatus.lastRunError})`
                        : ""}{" "}
                      — this may signal a persistence problem.
                    </span>
                  )}
                </div>
              </CardContent>
            </Card>
          )}

          <Card className="bg-card border-primary/10">
            <CardContent className="p-4 flex flex-wrap gap-4 text-xs text-foreground" data-testid="readout-permission-mode">
              <div>
                <span className="font-medium">Permission Mode:</span>{" "}
                <span data-testid="text-permission-mode">{permLabel}</span>
              </div>
              <div>
                <span className="font-medium">Effective Access:</span>{" "}
                <span data-testid="text-effective-access">{effectiveLabel}</span>
              </div>
            </CardContent>
          </Card>

          <Card className="bg-card border-primary/10">
            <CardHeader>
              <CardTitle className="text-foreground flex items-center gap-2">
                <UserPlus className="w-5 h-5" />
                Add New Users
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-start gap-3 p-4 bg-blue-50 rounded-lg border border-blue-100 dark:bg-blue-950/30 dark:border-blue-800">
                <Info className="w-5 h-5 text-blue-600 dark:text-blue-400 mt-0.5 shrink-0" />
                <div className="text-sm text-blue-800 dark:text-blue-300">
                  <p className="font-medium mb-1">How to add team members</p>
                  <p>Sign-in is closed: only approved emails can get in. Approve a team member below — their account appears in the list immediately — then share the login link so they can sign in. Anyone who signs in without approval is turned away.</p>
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="space-y-1 sm:col-span-1">
                  <label className="text-sm font-medium text-foreground" htmlFor="approve-email">Email</label>
                  <Input
                    id="approve-email"
                    type="email"
                    placeholder="name@nobullmarketing.com"
                    value={approveEmail}
                    onChange={(e) => setApproveEmail(e.target.value)}
                    data-testid="input-approve-email"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-sm font-medium text-foreground" htmlFor="approve-first-name">First name <span className="font-normal text-muted-foreground">(optional)</span></label>
                  <Input
                    id="approve-first-name"
                    value={approveFirstName}
                    onChange={(e) => setApproveFirstName(e.target.value)}
                    data-testid="input-approve-first-name"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-sm font-medium text-foreground" htmlFor="approve-last-name">Last name <span className="font-normal text-muted-foreground">(optional)</span></label>
                  <Input
                    id="approve-last-name"
                    value={approveLastName}
                    onChange={(e) => setApproveLastName(e.target.value)}
                    data-testid="input-approve-last-name"
                  />
                </div>
              </div>
              <div className="space-y-1">
                <span className="text-sm font-medium text-foreground">Functions</span>
                <div className="flex flex-wrap items-center gap-1.5">
                  {ALL_USER_FUNCTIONS.map((fn) => {
                    const isSelected = approveFns.includes(fn);
                    return (
                      <button
                        key={fn}
                        type="button"
                        onClick={() => toggleApproveFn(fn)}
                        data-testid={`chip-approve-function-${fn}`}
                        className={
                          "text-xs px-2 py-1 rounded-full border transition " +
                          (isSelected
                            ? "bg-primary text-primary-foreground border-primary"
                            : "bg-card text-foreground border-primary/30 hover:bg-primary/5")
                        }
                        aria-pressed={isSelected}
                      >
                        {FUNCTION_LABELS[fn]}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="flex flex-wrap items-end gap-3">
                <div className="space-y-1">
                  <label className="text-sm font-medium text-foreground">Authority</label>
                  <Select
                    value={approveAuthority}
                    onValueChange={(v) => setApproveAuthority(v as UserAuthorityLevel)}
                  >
                    <SelectTrigger className="w-40" data-testid="select-approve-authority">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ALL_AUTHORITY_LEVELS.map((a) => (
                        <SelectItem key={a} value={a}>{AUTHORITY_LABELS[a]}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Button
                  onClick={() => approveUserMutation.mutate()}
                  disabled={approveUserMutation.isPending || !approveEmail.trim().includes("@")}
                  className="bg-primary hover:bg-primary/90 text-primary-foreground"
                  data-testid="button-approve-user"
                >
                  <UserPlus className="w-4 h-4 mr-2" />
                  {approveUserMutation.isPending ? "Approving…" : "Approve user"}
                </Button>
              </div>
              <div className="space-y-2 pt-2 border-t border-primary/10">
                <label className="text-sm font-medium text-foreground">Login Link</label>
                <div className="flex gap-2">
                  <div className="flex-1 px-3 py-2 bg-surface-warm-1 rounded-lg text-sm text-muted-foreground truncate">{inviteLink}</div>
                  <Button onClick={copyInviteLink} className="bg-primary hover:bg-primary/90 text-primary-foreground shrink-0" data-testid="button-copy-invite">
                    {copied ? (<><Check className="w-4 h-4 mr-2" />Copied</>) : (<><Copy className="w-4 h-4 mr-2" />Copy Link</>)}
                  </Button>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">Approved users start with the authority and functions you set here; you can change them any time in the table below.</p>
            </CardContent>
          </Card>

          <Card className="bg-card border-primary/10">
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <CardTitle className="text-foreground">All Users</CardTitle>
                <div className="flex items-center gap-3 flex-wrap">
                  {unableCount > 0 && (
                    <span className="inline-flex items-center gap-1.5 text-xs text-red-700 bg-red-50 border border-red-200 rounded-full px-2.5 py-1 dark:text-red-300 dark:bg-red-950/30 dark:border-red-800" data-testid="text-unable-count">
                      <AlertCircle className="w-3.5 h-3.5" />
                      {unableCount} {unableCount === 1 ? "user" : "users"} can't place calls
                    </span>
                  )}
                  <Button type="button" size="sm" variant={showOnlyUnableToCall ? "default" : "outline"}
                    className={showOnlyUnableToCall ? "bg-primary hover:bg-primary/90 text-primary-foreground" : "border-primary/30 text-primary-ink hover:bg-primary/5"}
                    onClick={() => { setShowOnlyUnableToCall((v) => !v); setUsersPage(1); }} data-testid="button-filter-unable-to-call">
                    {showOnlyUnableToCall ? "Show all users" : "Only show users who can't call"}
                  </Button>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2 pt-3">
                <Input
                  value={userSearchInput}
                  onChange={(e) => setUserSearchInput(e.target.value)}
                  placeholder="Search name or email…"
                  aria-label="Search users by name or email"
                  className="w-56"
                  data-testid="input-user-search"
                />
                <Select value={facetFilter} onValueChange={(v) => { setFacetFilter(v); setUsersPage(1); }}>
                  <SelectTrigger className="w-48" data-testid="filter-facet"><SelectValue placeholder="Filter by facet" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All facets</SelectItem>
                    <SelectItem value="Revenue Engineering">Revenue Engineering</SelectItem>
                    <SelectItem value="Fulfillment">Fulfillment</SelectItem>
                    <SelectItem value="Revenue Engineering + Fulfillment">Hybrid</SelectItem>
                    <SelectItem value="Unassigned">Unassigned</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={authorityFilter} onValueChange={(v) => { setAuthorityFilter(v); setUsersPage(1); }}>
                  <SelectTrigger className="w-40" data-testid="filter-authority"><SelectValue placeholder="Authority" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All authority</SelectItem>
                    {ALL_AUTHORITY_LEVELS.map((a) => (<SelectItem key={a} value={a}>{AUTHORITY_LABELS[a]}</SelectItem>))}
                  </SelectContent>
                </Select>
                <Select value={functionFilter} onValueChange={(v) => { setFunctionFilter(v); setUsersPage(1); }}>
                  <SelectTrigger className="w-52" data-testid="filter-function"><SelectValue placeholder="Function" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All functions</SelectItem>
                    {ALL_USER_FUNCTIONS.map((f) => (<SelectItem key={f} value={f}>{FUNCTION_LABELS[f]}</SelectItem>))}
                  </SelectContent>
                </Select>
              </div>
            </CardHeader>
            <CardContent>
              {/* No explicit JSX generic here: the dev-only metadata babel plugin
                  cannot parse `<OsTable<T>` (it injects attributes before the type
                  argument and breaks the page in dev). Types flow from columns/rows. */}
              <OsTable
                data-testid="table-users"
                columns={userColumns}
                rows={visibleUsers}
                rowKey={(u) => u.id}
                stickyFirstColumn={false}
                maxHeight="70vh"
                pagination={{
                  page: usersPage,
                  pageSize: usersPageSize,
                  total: usersTotal,
                  onPageChange: setUsersPage,
                  onPageSizeChange: (n) => {
                    setUsersPageSize(n);
                    setUsersPage(1);
                  },
                  pageSizeOptions: [25, 50, 100],
                }}
                emptyState={
                  <p className="text-foreground" data-testid="text-no-users">
                    No users match the current filters.
                  </p>
                }
              />
            </CardContent>
          </Card>
          {isCeo && deletedUsers && deletedUsers.length > 0 && (
            <Card className="bg-card border-primary/10" data-testid="card-deleted-users">
              <CardHeader>
                <CardTitle className="text-foreground flex items-center gap-2">
                  <Trash2 className="w-5 h-5" />
                  Deleted Users ({deletedUsers.length})
                </CardTitle>
                <p className="text-xs text-muted-foreground pt-1">
                  Restoring a user clears their deleted mark, restores their
                  original email, and lets them log in with their Replit
                  account again. All historical references to them are
                  unchanged.
                </p>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {deletedUsers.map((u) => {
                    const displayEmail = (u.email ?? "").replace(/\.deleted\.\d+$/, "");
                    const displayName =
                      u.firstName && u.lastName
                        ? `${u.firstName} ${u.lastName}`
                        : u.firstName || displayEmail || "Unknown";
                    const events = deleteHistory?.[u.id] ?? [];
                    const latestDelete = events.find((e) => e.actionType === "user_deleted");
                    const reassignEvents = reassignHistory?.[u.id] ?? [];
                    return (
                      <div
                        key={u.id}
                        className="flex items-center justify-between p-4 bg-surface-warm-1 rounded-lg gap-3"
                        data-testid={`row-deleted-user-${u.id}`}
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          {u.profileImageUrl ? (
                            <img src={u.profileImageUrl} alt="" className="w-10 h-10 rounded-full opacity-60" />
                          ) : (
                            <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
                              <User className="w-5 h-5 text-primary" />
                            </div>
                          )}
                          <div className="min-w-0">
                            <p
                              className="font-medium text-foreground truncate"
                              data-testid={`text-deleted-user-name-${u.id}`}
                            >
                              {displayName}
                            </p>
                            <p
                              className="text-sm text-muted-foreground truncate"
                              data-testid={`text-deleted-user-email-${u.id}`}
                            >
                              {displayEmail || "—"}
                            </p>
                            <p
                              className="text-xs text-muted-foreground mt-0.5"
                              data-testid={`text-deleted-user-actor-${u.id}`}
                            >
                              {latestDelete
                                ? `Deleted by ${actorLabel(latestDelete.actorName, latestDelete.actorId)} on ${formatHistoryDay(latestDelete.timestamp)}`
                                : "Deleted (no audit record found)"}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <ReassignHistoryPopover userId={u.id} events={reassignEvents} />
                          <DeleteRestoreHistoryPopover userId={u.id} events={events} />
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="border-primary/30 text-primary-ink hover:bg-primary/5 shrink-0"
                          disabled={restoreUserMutation.isPending}
                          onClick={() => restoreUserMutation.mutate({ user: u })}
                          data-testid={`button-restore-user-${u.id}`}
                        >
                          <RotateCcw className="w-4 h-4 mr-2" />
                          {restoreUserMutation.isPending &&
                          restoreUserMutation.variables?.user.id === u.id
                            ? "Restoring…"
                            : "Restore"}
                        </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          )}
        </main>

        <AlertDialog
          open={!!deleteTarget}
          onOpenChange={(open) => {
            if (!open && !deleteUserMutation.isPending && !reassignMutation.isPending) {
              setDeleteTarget(null);
              setReassignTargetId("");
              setReassignSearch("");
            }
          }}
        >
          <AlertDialogContent
            data-testid={
              deleteTarget
                ? `dialog-confirm-delete-user-${deleteTarget.id}`
                : "dialog-confirm-delete-user"
            }
          >
            <AlertDialogHeader>
              <AlertDialogTitle>Delete this user?</AlertDialogTitle>
              <AlertDialogDescription asChild>
                <div className="space-y-2 text-sm">
                  <p>
                    This will permanently revoke access for{" "}
                    <span
                      className="font-medium text-foreground"
                      data-testid="text-delete-target-name"
                    >
                      {deleteTarget
                        ? deleteTarget.firstName && deleteTarget.lastName
                          ? `${deleteTarget.firstName} ${deleteTarget.lastName}`
                          : deleteTarget.firstName || deleteTarget.email || "Unknown"
                        : ""}
                    </span>
                    {deleteTarget?.email && (
                      <>
                        {" "}
                        (<span data-testid="text-delete-target-email">{deleteTarget.email}</span>)
                      </>
                    )}
                    .
                  </p>
                  <p>
                    Their account will stop appearing in user lists, assignment
                    pickers, and readiness panels. Existing assignments, audit
                    entries, and other historical references to this user are
                    preserved for the record. Any active session they have will
                    be ended on their next request, and signing back in with
                    their Replit account will be refused.
                  </p>
                  {deleteImpactLoading && !deleteImpact && (
                    <p
                      className="text-xs text-muted-foreground"
                      data-testid="text-delete-impact-loading"
                    >
                      Checking active assignments…
                    </p>
                  )}
                  {deleteImpact && deleteImpact.hasImpact && (
                    <div
                      className="rounded-md border border-primary/30 bg-primary/5 p-3 space-y-2"
                      data-testid="panel-delete-impact"
                    >
                      <p className="font-medium text-foreground">
                        This user is the sole assignee on active work.
                      </p>
                      <ul className="list-disc pl-5 space-y-1 text-foreground">
                        {deleteImpact.assignedClients.count > 0 && (
                          <li data-testid="text-impact-clients">
                            <span className="font-medium">
                              {deleteImpact.assignedClients.count}
                            </span>{" "}
                            assigned client
                            {deleteImpact.assignedClients.count === 1 ? "" : "s"}
                            {deleteImpact.assignedClients.sample.length > 0 && (
                              <>
                                {" "}
                                — {deleteImpact.assignedClients.sample
                                  .map((c) => c.firmName)
                                  .join(", ")}
                                {deleteImpact.assignedClients.count >
                                  deleteImpact.assignedClients.sample.length && "…"}
                              </>
                            )}
                          </li>
                        )}
                        {deleteImpact.openThreads.count > 0 && (
                          <li data-testid="text-impact-threads">
                            <span className="font-medium">
                              {deleteImpact.openThreads.count}
                            </span>{" "}
                            open Front / Twilio thread
                            {deleteImpact.openThreads.count === 1 ? "" : "s"}
                          </li>
                        )}
                        {deleteImpact.upcomingBookings.count > 0 && (
                          <li data-testid="text-impact-bookings">
                            <span className="font-medium">
                              {deleteImpact.upcomingBookings.count}
                            </span>{" "}
                            upcoming booking
                            {deleteImpact.upcomingBookings.count === 1 ? "" : "s"}
                          </li>
                        )}
                      </ul>
                      <p className="text-xs text-muted-foreground">
                        Reassign this work before deleting, or choose “Delete
                        anyway” below to leave it unowned.
                      </p>
                      {/* Task #1934 — in-dialog bulk reassignment picker. */}
                      <div
                        className="flex flex-col gap-2 pt-2 border-t border-primary/15 sm:flex-row sm:items-center"
                        data-testid="panel-reassign-picker"
                      >
                        <span className="text-xs font-medium text-foreground sm:shrink-0">
                          Reassign all to
                        </span>
                        {/* Task #4348 — search-bounded picker instead of a
                            dropdown that rendered every active user (the
                            full table is thousands of rows). The list is
                            fetched lazily while this dialog is open and
                            capped to the first 30 matches. */}
                        <div className="flex-1 space-y-1.5" data-testid="select-reassign-target">
                          <Input
                            value={reassignSearch}
                            onChange={(e) => setReassignSearch(e.target.value)}
                            placeholder="Search users by name or email…"
                            aria-label="Search users by name or email"
                            className="bg-card"
                            disabled={reassignMutation.isPending}
                            data-testid="input-reassign-search"
                          />
                          {(() => {
                            const q = reassignSearch.trim().toLowerCase();
                            const matches = (reassignOptions ?? [])
                              .filter((u) => u.id !== deleteTarget?.id)
                              .filter((u) => {
                                if (!q) return true;
                                const name = `${u.firstName ?? ""} ${u.lastName ?? ""}`.toLowerCase();
                                return (
                                  name.includes(q) ||
                                  (u.email ?? "").toLowerCase().includes(q)
                                );
                              });
                            const shown = matches.slice(0, 30);
                            const selected = (reassignOptions ?? []).find(
                              (u) => u.id === reassignTargetId,
                            );
                            const optionLabel = (u: UserType) =>
                              (u.firstName || u.lastName)
                                ? `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim()
                                : u.email || u.id;
                            return (
                              <>
                                {selected && (
                                  <p className="text-xs text-foreground" data-testid="text-reassign-selected">
                                    Selected:{" "}
                                    <span className="font-medium">{optionLabel(selected)}</span>
                                  </p>
                                )}
                                <div
                                  className="max-h-40 overflow-y-auto rounded-md border border-primary/15 bg-card divide-y divide-primary/10"
                                  data-testid="list-reassign-options"
                                >
                                  {!reassignOptions ? (
                                    <p className="p-2 text-xs text-muted-foreground">Loading users…</p>
                                  ) : shown.length === 0 ? (
                                    <p className="p-2 text-xs text-muted-foreground" data-testid="text-reassign-no-matches">
                                      No users match.
                                    </p>
                                  ) : (
                                    shown.map((u) => (
                                      <button
                                        type="button"
                                        key={u.id}
                                        className={
                                          "block w-full px-2 py-1.5 text-left text-xs hover:bg-primary/5 " +
                                          (reassignTargetId === u.id
                                            ? "bg-primary/10 font-medium"
                                            : "")
                                        }
                                        onClick={() => setReassignTargetId(u.id)}
                                        disabled={reassignMutation.isPending}
                                        data-testid={`select-reassign-option-${u.id}`}
                                      >
                                        {optionLabel(u)}
                                        {u.email && (u.firstName || u.lastName) ? ` (${u.email})` : ""}
                                      </button>
                                    ))
                                  )}
                                </div>
                                {matches.length > shown.length && (
                                  <p className="text-xs text-muted-foreground">
                                    Showing first {shown.length} of {matches.length} matches — refine the search.
                                  </p>
                                )}
                              </>
                            );
                          })()}
                        </div>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="border-primary/30 text-primary-ink hover:bg-primary/5"
                          disabled={
                            !reassignTargetId ||
                            reassignMutation.isPending ||
                            !deleteTarget
                          }
                          onClick={() => {
                            if (!deleteTarget || !reassignTargetId) return;
                            reassignMutation.mutate({
                              fromUserId: deleteTarget.id,
                              toUserId: reassignTargetId,
                            });
                          }}
                          data-testid="button-reassign-user-work"
                        >
                          {reassignMutation.isPending ? "Reassigning…" : "Reassign"}
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel
                disabled={deleteUserMutation.isPending}
                data-testid="button-cancel-delete-user"
              >
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction
                className="bg-primary text-primary-foreground hover:bg-primary/90"
                disabled={deleteUserMutation.isPending || deleteImpactLoading}
                onClick={(e) => {
                  e.preventDefault();
                  if (!deleteTarget) return;
                  // Task #1909 — pass `force=true` when there is active
                  // work to delete; otherwise the server returns 409 and
                  // the dialog re-prompts with the latest counts.
                  const force = !!deleteImpact?.hasImpact;
                  deleteUserMutation.mutate({ id: deleteTarget.id, force });
                }}
                data-testid={
                  deleteTarget
                    ? `button-confirm-delete-user-${deleteTarget.id}`
                    : "button-confirm-delete-user"
                }
              >
                {deleteUserMutation.isPending
                  ? "Deleting…"
                  : deleteImpact?.hasImpact
                  ? "Delete anyway"
                  : "Delete user"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <AlertDialog
          open={!!emailEdit}
          onOpenChange={(open) => {
            if (!open && !updateEmailMutation.isPending) setEmailEdit(null);
          }}
        >
          <AlertDialogContent data-testid="dialog-edit-user-email">
            <AlertDialogHeader>
              <AlertDialogTitle>Edit email</AlertDialogTitle>
              <AlertDialogDescription asChild>
                <div className="space-y-3 text-sm">
                  <p>
                    Set a new login email for{" "}
                    <span className="font-medium text-foreground">
                      {emailEdit
                        ? emailEdit.target.firstName && emailEdit.target.lastName
                          ? `${emailEdit.target.firstName} ${emailEdit.target.lastName}`
                          : emailEdit.target.firstName ||
                            emailEdit.target.email ||
                            "this user"
                        : ""}
                    </span>
                    . The new address must be unique across active users —
                    the user will sign in with it on their next Replit login.
                  </p>
                  {emailEdit?.target.email && (
                    <p className="text-xs text-muted-foreground">
                      Current:{" "}
                      <span
                        className="font-mono"
                        data-testid="text-edit-email-current"
                      >
                        {emailEdit.target.email}
                      </span>
                    </p>
                  )}
                  <Input
                    type="email"
                    autoFocus
                    value={emailEdit?.value ?? ""}
                    onChange={(e) =>
                      setEmailEdit((cur) =>
                        cur ? { ...cur, value: e.target.value, conflict: null } : cur,
                      )
                    }
                    placeholder="user@example.com"
                    data-testid="input-edit-email"
                  />
                  {emailEdit?.conflict && (
                    <p
                      className="text-xs text-red-700"
                      data-testid="text-edit-email-conflict"
                    >
                      {emailEdit.conflict} already uses that address. Pick a
                      different one or reassign their email first.
                    </p>
                  )}
                </div>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel
                disabled={updateEmailMutation.isPending}
                data-testid="button-cancel-edit-email"
              >
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction
                className="bg-primary text-primary-foreground hover:bg-primary/90"
                disabled={
                  updateEmailMutation.isPending ||
                  !emailEdit ||
                  !emailEdit.value.trim() ||
                  emailEdit.value.trim() === (emailEdit.target.email ?? "")
                }
                onClick={(e) => {
                  e.preventDefault();
                  if (!emailEdit) return;
                  updateEmailMutation.mutate({
                    id: emailEdit.target.id,
                    email: emailEdit.value.trim(),
                  });
                }}
                data-testid="button-confirm-edit-email"
              >
                {updateEmailMutation.isPending ? "Saving…" : "Save email"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <AlertDialog
          open={!!restoreConflict}
          onOpenChange={(open) => {
            if (!open && !restoreUserMutation.isPending) setRestoreConflict(null);
          }}
        >
          <AlertDialogContent data-testid="dialog-restore-email-conflict">
            <AlertDialogHeader>
              <AlertDialogTitle>Can't restore with original email</AlertDialogTitle>
              <AlertDialogDescription asChild>
                <div className="space-y-3 text-sm">
                  <p>
                    Another active user already uses{" "}
                    <span
                      className="font-medium text-foreground"
                      data-testid="text-restore-conflict-email"
                    >
                      {restoreConflict?.email}
                    </span>
                    , so restoring{" "}
                    <span className="font-medium text-foreground">
                      {restoreConflict
                        ? restoreConflict.deletedUser.firstName &&
                          restoreConflict.deletedUser.lastName
                          ? `${restoreConflict.deletedUser.firstName} ${restoreConflict.deletedUser.lastName}`
                          : restoreConflict.deletedUser.firstName ||
                            (restoreConflict.deletedUser.email ?? "").replace(
                              /\.deleted\.\d+$/,
                              "",
                            ) ||
                            "this user"
                        : ""}
                    </span>{" "}
                    with their original address would collide on the email
                    uniqueness constraint.
                  </p>
                  <div className="rounded-md border border-primary/15 bg-surface-warm-1 p-3">
                    <p className="text-xs uppercase tracking-wide text-muted-foreground mb-1">
                      Email is currently owned by
                    </p>
                    <p
                      className="font-medium text-foreground"
                      data-testid="text-restore-conflict-colliding-name"
                    >
                      {restoreConflict?.collidingUser.displayName}
                    </p>
                    {restoreConflict?.collidingUser.email && (
                      <p
                        className="text-xs text-muted-foreground"
                        data-testid="text-restore-conflict-colliding-email"
                      >
                        {restoreConflict.collidingUser.email}
                      </p>
                    )}
                  </div>
                  <p>
                    You can restore this user now with a fallback address{" "}
                    <span
                      className="font-mono text-xs text-foreground"
                      data-testid="text-restore-conflict-fallback-email"
                    >
                      {restoreConflict?.fallbackPreviewEmail}
                    </span>{" "}
                    and edit it later, or cancel and reassign the colliding
                    user's email first.
                  </p>
                </div>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel
                disabled={restoreUserMutation.isPending}
                data-testid="button-cancel-restore-conflict"
              >
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction
                className="bg-primary text-primary-foreground hover:bg-primary/90"
                disabled={restoreUserMutation.isPending}
                onClick={(e) => {
                  e.preventDefault();
                  if (restoreConflict) {
                    restoreUserMutation.mutate({
                      user: restoreConflict.deletedUser,
                      strategy: "suffix",
                    });
                  }
                }}
                data-testid="button-confirm-restore-with-suffix"
              >
                {restoreUserMutation.isPending
                  ? "Restoring…"
                  : "Restore with fallback email"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </TooltipProvider>
  );
}
