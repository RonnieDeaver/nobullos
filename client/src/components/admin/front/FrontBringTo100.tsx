import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import {
  CheckCircle2,
  AlertCircle,
  AlertTriangle,
  Loader2,
  Sparkles,
  PauseCircle,
} from "lucide-react";
// Task #4367 (audit P1-5) — shared clamped-percent display gate. Presentation
// only: computation and stored values are untouched (§10.2 out of scope).
import { frontPercentDisplay } from "@shared/frontConsoleMetrics";

type FrontBringTo100Target = {
  frontTotal: number;
  applied: number;
  fetched: number;
  loggedPct: number;
  reachableApplied: number;
  reachableTargetPct: number;
  reachableRemainingWork: number;
  applyGap: number;
  reachableIngestGap: number;
  searchRecoverableRemainder: number;
  searchRecoverableRemainderPct: number;
  planLimitedRemainder: number;
  planLimitedRemainderPct: number;
  atReachableTarget: boolean;
};

type FrontBringTo100Summary = {
  target: FrontBringTo100Target;
  classification: {
    total: number;
    matched: number;
    unmatched: number;
    dismissed: number;
    matchRate: number;
  };
  status: "working" | "blocked" | "up_to_date" | "work_remaining";
  statusDetail: string;
  blocked: boolean;
  queuePaused: boolean;
  pauseReason: string | null;
  generatedAt: string;
};

const SUMMARY_KEY = "/api/integrations/front/console/bring-to-100";

function fmt(n: number): string {
  return (Number(n) || 0).toLocaleString();
}

function StatusBadge({ status }: { status: FrontBringTo100Summary["status"] }) {
  const map = {
    working: {
      icon: Loader2,
      cls: "text-blue-700 bg-blue-50 border-blue-200",
      label: "Working on it",
      spin: true,
    },
    blocked: {
      icon: AlertCircle,
      cls: "text-red-700 bg-red-50 border-red-200",
      label: "Front disconnected",
      spin: false,
    },
    up_to_date: {
      icon: CheckCircle2,
      cls: "text-green-700 bg-green-50 border-green-200",
      label: "As complete as Front allows",
      spin: false,
    },
    work_remaining: {
      icon: Sparkles,
      cls: "text-amber-700 bg-amber-50 border-amber-200",
      label: "Action available",
      spin: false,
    },
  } as const;
  const m = map[status];
  const Icon = m.icon;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${m.cls}`}
      data-testid={`badge-bring100-status-${status}`}
    >
      <Icon className={`w-3.5 h-3.5 ${m.spin ? "animate-spin" : ""}`} />
      {m.label}
    </span>
  );
}

export function FrontBringTo100() {
  const { toast } = useToast();
  const { user } = useAuth();
  // The run action posts to a requireTeamLead server route; hide the
  // affordance for account managers instead of letting them hit a 403.
  const canRun = user?.role === "ceo" || user?.role === "team_lead";

  const { data, isLoading, isError } = useQuery<FrontBringTo100Summary>({
    queryKey: [SUMMARY_KEY],
    // Poll while a drain/recovery job is working so the headline updates live.
    refetchInterval: (query) =>
      query.state.data?.status === "working" ? 5000 : false,
    meta: { silent: true },
  });

  const run = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", SUMMARY_KEY);
      return res.json();
    },
    onSuccess: (result: { started: boolean; blocked: boolean; detail: string }) => {
      if (result.blocked) {
        toast({
          title: "Front is disconnected",
          description:
            "Reconnect Front in the Integrations Hub, then try again.",
          variant: "destructive",
        });
      } else if (result.started) {
        toast({
          title: "Bringing Front coverage to 100%",
          description:
            "Started in the background — this card updates live as messages are logged.",
        });
      } else {
        toast({
          title: "Nothing left to do",
          description: "Everything Front lets us log is already logged.",
        });
      }
      void queryClient.invalidateQueries({ queryKey: [SUMMARY_KEY] }); // fire-and-forget: cache refresh only
    },
    onError: (err: any) => {
      toast({
        title: "Couldn't start",
        description: err?.message ?? "Please try again.",
        variant: "destructive",
      });
    },
  });

  if (isLoading) {
    return (
      <Card data-testid="card-bring100-loading">
        <CardContent className="p-6 flex items-center gap-2 text-sm text-gray-500">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading Front coverage…
        </CardContent>
      </Card>
    );
  }

  if (isError || !data) {
    return (
      <Card data-testid="card-bring100-error">
        <CardContent className="p-6 text-sm text-red-600">
          Couldn't load Front coverage. Open Advanced tools below to investigate.
        </CardContent>
      </Card>
    );
  }

  const t = data.target;
  const c = data.classification;
  const classTotal = c.matched + c.unmatched + c.dismissed;
  // Task #4367 (audit P1-5) — every percentage on this card goes through the
  // shared clamped display gate; a corrupted stored ratio once rendered
  // "903.6%" here as if it were a fact. The class percentages are bounded by
  // construction, but routing them through the same helper keeps ONE
  // presentation rule for the whole card.
  const classPct = (n: number) =>
    frontPercentDisplay(classTotal > 0 ? (n / classTotal) * 100 : 0, 1).text;
  const heroPct = frontPercentDisplay(t.loggedPct, 1);
  const reachableDisplay = frontPercentDisplay(t.reachableTargetPct, 1);
  const planLimitedDisplay = frontPercentDisplay(t.planLimitedRemainderPct, 1);
  const matchRateDisplay = frontPercentDisplay(c.matchRate, 0);
  const planLimited = t.planLimitedRemainder > 0;
  const buttonDisabled =
    run.isPending ||
    data.blocked ||
    data.status === "working" ||
    t.reachableRemainingWork === 0 ||
    !canRun;

  return (
    <Card data-testid="card-bring100">
      <CardContent className="p-6 space-y-5">
        {/* Headline: % of messages logged */}
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <div className="text-sm font-medium text-gray-500">
              Front messages logged
            </div>
            {heroPct.state === "out_of_range" ? (
              /* Task #4367 (audit P1-5) — an impossible stored ratio (the
                 "903.6%" bug) renders as an explicit data-quality state,
                 never as a raw number. The raw value stays in the tooltip. */
              <div
                className="flex items-center gap-2 text-amber-600"
                data-testid="text-bring100-logged-pct"
                data-percent-state="out_of_range"
                title={heroPct.title}
              >
                <AlertTriangle className="w-7 h-7 shrink-0" />
                <span className="text-3xl font-semibold tracking-tight first-letter:uppercase">
                  {heroPct.text}
                </span>
              </div>
            ) : (
              <div
                className="text-4xl font-semibold tracking-tight"
                data-testid="text-bring100-logged-pct"
              >
                {heroPct.text}
              </div>
            )}
            <div
              className="text-sm text-gray-500"
              data-testid="text-bring100-counts"
              title="In-window = messages in the months NoBull tracks at message grain, from Front adoption onward — the same set the all-time coverage totals sum."
            >
              {fmt(t.applied)} of {fmt(t.frontTotal)} in-window Front messages logged into NoBull
            </div>
            {heroPct.state === "out_of_range" && (
              <p
                className="text-xs text-amber-700 mt-1 max-w-md"
                data-testid="text-bring100-out-of-range-note"
              >
                These counts disagree — the stored ratio is {heroPct.raw.toFixed(1)}%,
                which is impossible for a share of messages. The percentage is
                hidden until a recount refreshes it; "Bring it to 100%" runs the
                coverage steps that recount these months.
              </p>
            )}
          </div>
          <StatusBadge status={data.status} />
        </div>

        {/* Progress bar: logged now, with the reachable ceiling marked. */}
        <div className="space-y-1.5">
          {/* Task #4367 — the bar gets the CLAMPED value only; an out-of-range
              ratio shows an empty bar beside the "needs recount" state rather
              than a bar pretending the impossible figure is real. */}
          <Progress
            value={heroPct.state === "ok" ? heroPct.value : 0}
            data-testid="progress-bring100"
          />
          <div className="flex items-center justify-between text-xs text-gray-500">
            <span
              data-testid="text-bring100-reachable"
              title={
                reachableDisplay.state === "out_of_range"
                  ? reachableDisplay.title
                  : undefined
              }
            >
              Reachable target: {reachableDisplay.text}
            </span>
            {planLimited && (
              <span
                className="text-gray-400"
                data-testid="text-bring100-plan-limited"
                title={
                  planLimitedDisplay.state === "out_of_range"
                    ? planLimitedDisplay.title
                    : undefined
                }
              >
                {planLimitedDisplay.state === "out_of_range"
                  ? "plan-locked share needs recount"
                  : `${planLimitedDisplay.text} locked by Front plan`}
              </span>
            )}
          </div>
        </div>

        {/* One rolled-up live status sentence. */}
        <p
          className="text-sm text-gray-600"
          data-testid="text-bring100-status-detail"
        >
          {data.statusDetail}
        </p>

        {/* The ONE button. */}
        <div className="flex items-center gap-3 flex-wrap">
          <Button
            onClick={() => run.mutate()}
            disabled={buttonDisabled}
            title={!canRun ? "Team lead or CEO role required to run this" : undefined}
            data-testid="button-bring100-run"
          >
            {run.isPending || data.status === "working" ? (
              <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
            ) : (
              <Sparkles className="w-4 h-4 mr-1.5" />
            )}
            Bring it to 100%
          </Button>
          {!canRun && (
            <span className="text-xs text-gray-400" data-testid="text-bring100-role-note">
              Team lead or CEO role required
            </span>
          )}
          {data.queuePaused && (
            <span
              className="inline-flex items-center gap-1.5 text-xs text-amber-700"
              data-testid="text-bring100-queue-paused"
            >
              <PauseCircle className="w-3.5 h-3.5" />
              Recovery queue paused
            </span>
          )}
        </div>

        {/* Classification breakdown: matched / unmatched / dismissed (counts + %). */}
        <div className="grid grid-cols-3 gap-3 pt-2 border-t">
          <div data-testid="stat-bring100-matched">
            <div className="text-xs text-gray-500">Matched</div>
            <div className="text-lg font-semibold text-green-700">
              {fmt(c.matched)}
            </div>
            <div className="text-xs text-gray-400" data-testid="text-bring100-matched-pct">
              {classPct(c.matched)}
            </div>
          </div>
          <div data-testid="stat-bring100-unmatched">
            <div className="text-xs text-gray-500">Unmatched</div>
            <div className="text-lg font-semibold text-amber-700">
              {fmt(c.unmatched)}
            </div>
            <div className="text-xs text-gray-400" data-testid="text-bring100-unmatched-pct">
              {classPct(c.unmatched)}
            </div>
          </div>
          <div data-testid="stat-bring100-dismissed">
            <div className="text-xs text-gray-500">Dismissed (by rules)</div>
            <div className="text-lg font-semibold text-gray-500">
              {fmt(c.dismissed)}
            </div>
            <div className="text-xs text-gray-400" data-testid="text-bring100-dismissed-pct">
              {classPct(c.dismissed)}
            </div>
          </div>
        </div>
        <div
          className="text-xs text-gray-400"
          data-testid="text-bring100-matchrate"
          title={
            matchRateDisplay.state === "out_of_range"
              ? matchRateDisplay.title
              : undefined
          }
        >
          {matchRateDisplay.state === "out_of_range"
            ? "Match rate needs recount — the stored share of matchable messages is out of range."
            : `${matchRateDisplay.text} of matchable messages are matched to a client.`}
        </div>
      </CardContent>
    </Card>
  );
}
