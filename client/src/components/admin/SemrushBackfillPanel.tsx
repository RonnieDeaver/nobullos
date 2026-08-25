import { useCallback, useEffect, useMemo, useState } from "react";
import { motionSafeScrollBehavior } from "@/lib/scrollBehavior";
import { useMutation, useQueries, useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { ConfirmActionDialog } from "@/components/kit/ConfirmActionDialog";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { parseIntegrationStatusUnknownError } from "@shared/integrationStatusUnknown";
import {
  Activity,
  AlertCircle,
  Check,
  CheckCircle2,
  ChevronsUpDown,
  Clock,
  Download,
  Loader2,
  RefreshCw,
  RotateCcw,
  X,
} from "lucide-react";

type SemrushBackfillResult = {
  dryRun: boolean;
  jobId?: string | null;
  mappings: Array<{
    clientId: string;
    locationId: string;
    semrushCampaignId: string;
    semrushCampaignName: string | null;
  }>;
  campaignsConsidered: number;
  campaignsFetched: number;
  campaignFetchFailures: Array<{ campaignId: string; error: string }>;
  reportDatesEnqueued: Array<{
    campaignId: string;
    reportDate: string;
    jobId: string | null;
  }>;
  reportDatesSkipped: Array<{
    campaignId: string;
    reportDate: string;
    reason: string;
  }>;
  enqueuedJobCount: number;
};

type SemrushStatus = {
  configured: boolean;
  connected: boolean;
  expired: boolean;
};

type ClientOption = {
  id: string;
  firmName: string;
  isArchived?: boolean;
};

type LocationOption = {
  id: string;
  clientId: string;
  name: string;
  address?: string | null;
};

type InventoryCampaign = {
  campaignId: string;
  businessName: string;
  campaignName?: string;
  address?: string;
};

type PickerOption = {
  value: string;
  label: string;
  sublabel?: string;
  searchText: string;
};

function MultiSelectPicker({
  options,
  value,
  onChange,
  placeholder,
  searchPlaceholder,
  emptyText,
  isLoading,
  disabled,
  disabledReason,
  testId,
}: {
  options: PickerOption[];
  value: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
  searchPlaceholder: string;
  emptyText: string;
  isLoading?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  testId: string;
}) {
  const [open, setOpen] = useState(false);
  const optionByValue = useMemo(() => {
    const m = new Map<string, PickerOption>();
    options.forEach((o) => m.set(o.value, o));
    return m;
  }, [options]);

  const toggle = (v: string) => {
    if (value.includes(v)) {
      onChange(value.filter((x) => x !== v));
    } else {
      onChange([...value, v]);
    }
  };
  const remove = (v: string) => onChange(value.filter((x) => x !== v));

  const triggerLabel = (() => {
    if (disabled && disabledReason) return disabledReason;
    if (value.length === 0) {
      if (isLoading) return "Loading…";
      return placeholder;
    }
    if (value.length === 1) {
      const opt = optionByValue.get(value[0]);
      return opt?.label ?? value[0];
    }
    return `${value.length} selected`;
  })();

  return (
    <div className="space-y-1">
      <Popover open={open} onOpenChange={(o) => !disabled && setOpen(o)}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            disabled={disabled}
            className="w-full justify-between font-normal h-9 text-sm"
            data-testid={testId}
          >
            <span className="truncate text-left">{triggerLabel}</span>
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          className="w-[var(--radix-popover-trigger-width)] p-0"
          align="start"
        >
          <Command
            filter={(itemValue, search) => {
              if (!search) return 1;
              return itemValue.toLowerCase().includes(search.toLowerCase())
                ? 1
                : 0;
            }}
          >
            <CommandInput placeholder={searchPlaceholder} />
            <CommandList>
              <CommandEmpty>
                {isLoading ? "Loading…" : emptyText}
              </CommandEmpty>
              <CommandGroup>
                {options.map((opt) => {
                  const checked = value.includes(opt.value);
                  return (
                    <CommandItem
                      key={opt.value}
                      value={opt.searchText}
                      onSelect={() => toggle(opt.value)}
                      data-testid={`${testId}-option-${opt.value}`}
                    >
                      <Check
                        className={`mr-2 h-4 w-4 ${checked ? "opacity-100" : "opacity-0"}`}
                      />
                      <div className="flex flex-col min-w-0">
                        <span className="truncate">{opt.label}</span>
                        {opt.sublabel && (
                          <span className="text-[11px] text-muted-foreground truncate">
                            {opt.sublabel}
                          </span>
                        )}
                      </div>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {value.length > 0 && (
        <div
          className="flex flex-wrap gap-1"
          data-testid={`${testId}-chips`}
        >
          {value.map((v) => {
            const opt = optionByValue.get(v);
            return (
              <Badge
                key={v}
                variant="secondary"
                className="text-[11px] font-normal pl-2 pr-1 py-0.5 gap-1"
                data-testid={`${testId}-chip-${v}`}
              >
                <span className="truncate max-w-[160px]" title={opt?.label ?? v}>
                  {opt?.label ?? v}
                </span>
                <button
                  type="button"
                  className="hover:bg-muted rounded p-0.5"
                  onClick={() => remove(v)}
                  aria-label={`Remove ${opt?.label ?? v}`}
                  data-testid={`${testId}-chip-remove-${v}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            );
          })}
        </div>
      )}
    </div>
  );
}

type SemrushBackfillRun = {
  id: string;
  status: string;
  triggeredBy: string | null;
  parameters: {
    clientIds?: string[] | null;
    locationIds?: string[] | null;
    campaignIds?: string[] | null;
    sinceDate?: string | null;
    untilDate?: string | null;
  } | null;
  processedUnits: number;
  succeededUnits: number;
  failedUnits: number;
  enqueuedJobCount: number;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string | null;
  errorMessage: string | null;
  hasProgress: boolean;
};

type SemrushBackfillProgress = {
  runStartedAt: string;
  runId?: string;
  runStatus?: string;
  runCompletedAt?: string | null;
  runErrorMessage?: string | null;
  triggeredBy?: string | null;
  summary: {
    total: number;
    queued: number;
    running: number;
    completed: number;
    failed: number;
    missing: number;
    allTerminal: boolean;
  };
  jobs: Array<{
    jobId: string;
    campaignId: string;
    reportDate: string;
    status: "queued" | "running" | "completed" | "failed" | "missing";
    rawStatus: string | null;
    errorMessage: string | null;
    attemptCount: number;
    completedAt: string | null;
    updatedAt: string | null;
  }>;
  snapshots: Array<{
    campaignId: string;
    reportDate: string;
    clientId: string | null;
    locationId: string;
    locationName: string;
    keywordCount: number;
    latestCreatedAt: string | null;
  }>;
  applyJobs: Array<{
    campaignId: string;
    reportDate: string;
    locationId: string;
    locationName: string | null;
    failedCount: number;
    queuedCount: number;
    runningCount: number;
    latestErrorMessage: string | null;
    latestUpdatedAt: string | null;
  }>;
};

export function SemrushBackfillPanel() {
  const { toast } = useToast();

  const { data: semrushStatus, error: semrushStatusError } = useQuery<SemrushStatus>({
    queryKey: ["/api/semrush/status"],
    // Task #2820 — while the status route reports "status unknown" (transient
    // settings-read blip, Task #2811's 503 contract), keep re-checking so the
    // neutral card state resolves itself without a manual reload.
    refetchInterval: (query) =>
      parseIntegrationStatusUnknownError(query.state.error) ? 15_000 : false,
  });
  // Task #2820 — a status-unknown 503 with NO previously-loaded data must not
  // render the "Connect SEMrush" card (a false disconnect). When data exists
  // from an earlier success, React Query keeps it across the failed refetch,
  // so the last-known panel state continues to render.
  const semrushStatusUnknown =
    !semrushStatus && !!parseIntegrationStatusUnknownError(semrushStatusError);

  const [backfillClientIds, setBackfillClientIds] = useState<string[]>([]);
  const [backfillLocationIds, setBackfillLocationIds] = useState<string[]>([]);
  const [backfillCampaignIds, setBackfillCampaignIds] = useState<string[]>([]);
  const [backfillSinceDate, setBackfillSinceDate] = useState("");
  const [backfillUntilDate, setBackfillUntilDate] = useState("");

  // Pre-fill the backfill form from URL query params when the operator
  // navigated here from the Backfill Jobs panel's "Re-run" / "Re-run all
  // gaps" buttons. Supported params (all comma-separated where lists):
  //   prefillClientIds, prefillLocationIds, prefillCampaignIds,
  //   prefillSinceDate (YYYY-MM-DD), prefillUntilDate (YYYY-MM-DD).
  // After applying, the params are stripped from the URL so a refresh
  // doesn't keep re-prefilling on top of operator edits.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const hasAny =
      params.has("prefillClientIds") ||
      params.has("prefillLocationIds") ||
      params.has("prefillCampaignIds") ||
      params.has("prefillSinceDate") ||
      params.has("prefillUntilDate");
    if (!hasAny) return;
    const splitList = (v: string | null) =>
      (v ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    const clientIds = splitList(params.get("prefillClientIds"));
    const locationIds = splitList(params.get("prefillLocationIds"));
    const campaignIds = splitList(params.get("prefillCampaignIds"));
    const sinceDate = (params.get("prefillSinceDate") ?? "").trim();
    const untilDate = (params.get("prefillUntilDate") ?? "").trim();
    if (clientIds.length) setBackfillClientIds(clientIds);
    if (locationIds.length) setBackfillLocationIds(locationIds);
    if (campaignIds.length) setBackfillCampaignIds(campaignIds);
    if (sinceDate) setBackfillSinceDate(sinceDate);
    if (untilDate) setBackfillUntilDate(untilDate);
    // Drop the prefill params from the URL so refreshes don't re-apply
    // them on top of operator edits. Preserve any other params.
    [
      "prefillClientIds",
      "prefillLocationIds",
      "prefillCampaignIds",
      "prefillSinceDate",
      "prefillUntilDate",
    ].forEach((k) => params.delete(k));
    const newSearch = params.toString();
    const newUrl =
      window.location.pathname +
      (newSearch ? `?${newSearch}` : "") +
      window.location.hash;
    window.history.replaceState({}, "", newUrl);
    // Scroll the panel into view so the operator immediately sees the
    // prefilled form (the panel sits below other sections on the page).
    setTimeout(() => {
      const el = document.querySelector(
        '[data-testid="section-semrush-backfill"]',
      );
      if (el && "scrollIntoView" in el) {
        (el as HTMLElement).scrollIntoView({ behavior: motionSafeScrollBehavior(), block: "start" });
      }
    }, 50);
    toast({
      title: "Backfill form pre-filled",
      description:
        "Filters were copied from the Backfill Jobs panel. Run a dry-run preview, then Apply when ready.",
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [semrushBackfillPreview, setSemrushBackfillPreview] =
    useState<SemrushBackfillResult | null>(null);
  const [semrushBackfillResult, setSemrushBackfillResult] =
    useState<SemrushBackfillResult | null>(null);
  const [semrushBackfillPolling, setSemrushBackfillPolling] = useState(false);
  // Wall-clock timestamp recorded the moment the apply mutation started, used
  // by the progress endpoint to scope `heatmap_snapshots` lookups so we only
  // count snapshot writes attributable to *this* backfill run (not earlier
  // snapshots for the same campaign/reportDate).
  const [progressRunStartedAt, setProgressRunStartedAt] = useState<
    string | null
  >(null);
  const [progressJobs, setProgressJobs] = useState<
    Array<{ jobId: string; campaignId: string; reportDate: string }>
  >([]);
  const [progress, setProgress] = useState<SemrushBackfillProgress | null>(
    null,
  );
  // When set, the progress card reads from the persisted backfill_jobs row
  // (`GET /runs/:jobId/progress`) instead of the just-applied React state.
  // This is what lets any operator inspect any in-flight or recently
  // finished backfill — even after a page refresh or from a teammate's
  // session.
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedRunMeta, setSelectedRunMeta] = useState<SemrushBackfillRun | null>(null);

  // Clients list — populates the client picker.
  const { data: clientsData, isLoading: clientsLoading } = useQuery<
    ClientOption[]
  >({
    queryKey: ["/api/clients"],
  });
  const clients = useMemo(() => clientsData ?? [], [clientsData]);
  const clientById = useMemo(() => {
    const m = new Map<string, ClientOption>();
    clients.forEach((c) => m.set(c.id, c));
    return m;
  }, [clients]);
  const clientOptions: PickerOption[] = useMemo(
    () =>
      [...clients]
        .filter((c) => !c.isArchived)
        .sort((a, b) => a.firmName.localeCompare(b.firmName))
        .map((c) => ({
          value: c.id,
          label: c.firmName,
          searchText: `${c.firmName} ${c.id}`,
        })),
    [clients],
  );

  // Locations are scoped to selected clients. Fetch in parallel for each
  // selected client so the picker only shows locations the operator can
  // actually pair with the rest of their filters.
  const locationQueries = useQueries({
    queries: backfillClientIds.map((clientId) => ({
      queryKey: ["/api/clients", clientId, "locations"],
      enabled: !!clientId,
    })),
  });
  const locationsLoading = locationQueries.some((q) => q.isLoading);
  // Stringified stamp of the location queries' data freshness so the memo
  // below can depend on a stable primitive instead of the unstable query
  // objects themselves.
  const locationDataStamp = locationQueries
    .map((q) => q.dataUpdatedAt)
    .join(",");
  const locationOptions: PickerOption[] = useMemo(() => {
    const rows: LocationOption[] = [];
    locationQueries.forEach((q, idx) => {
      const clientId = backfillClientIds[idx];
      const data = q.data as LocationOption[] | undefined;
      if (Array.isArray(data)) {
        data.forEach((loc) =>
          rows.push({ ...loc, clientId: loc.clientId ?? clientId }),
        );
      }
    });
    return rows
      .sort((a, b) => {
        const ac = clientById.get(a.clientId)?.firmName ?? "";
        const bc = clientById.get(b.clientId)?.firmName ?? "";
        return ac.localeCompare(bc) || a.name.localeCompare(b.name);
      })
      .map((loc) => {
        const firm = clientById.get(loc.clientId)?.firmName;
        return {
          value: loc.id,
          label: firm ? `${firm} — ${loc.name}` : loc.name,
          sublabel: loc.address ?? undefined,
          searchText: `${firm ?? ""} ${loc.name} ${loc.address ?? ""} ${loc.id}`,
        };
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    // Re-derive when any of the location queries' data changes or the client
    // selection changes. `locationDataStamp` is a stable primitive standing
    // in for the unstable query objects themselves.
    backfillClientIds,
    clientById,
    locationDataStamp,
  ]);
  const validLocationIds = useMemo(
    () => new Set(locationOptions.map((o) => o.value)),
    [locationOptions],
  );
  // Prune any selected locations that no longer belong to a selected client.
  // Only prune once the relevant location queries have loaded so we don't
  // erase the operator's selection before the data arrives.
  useEffect(() => {
    if (backfillClientIds.length === 0) {
      if (backfillLocationIds.length > 0) setBackfillLocationIds([]);
      return;
    }
    if (locationsLoading) return;
    const filtered = backfillLocationIds.filter((id) =>
      validLocationIds.has(id),
    );
    if (filtered.length !== backfillLocationIds.length) {
      setBackfillLocationIds(filtered);
    }
  }, [
    backfillClientIds,
    backfillLocationIds,
    locationsLoading,
    validLocationIds,
  ]);

  // SEMrush campaigns from the inventory snapshot.
  const { data: campaignsData, isLoading: campaignsLoading } = useQuery<{
    campaigns: InventoryCampaign[];
    fetchedAt: string | null;
  }>({
    queryKey: ["/api/semrush/inventory/campaigns"],
    enabled: !!semrushStatus?.connected,
  });
  const campaignOptions: PickerOption[] = useMemo(() => {
    const list = campaignsData?.campaigns ?? [];
    return [...list]
      .sort((a, b) => a.businessName.localeCompare(b.businessName))
      .map((c) => {
        const label = c.campaignName
          ? `${c.businessName} — ${c.campaignName}`
          : c.businessName;
        return {
          value: c.campaignId,
          label,
          sublabel: c.address,
          searchText: `${c.businessName} ${c.campaignName ?? ""} ${c.address ?? ""} ${c.campaignId}`,
        };
      });
  }, [campaignsData]);

  // Live coverage hint — debounced poll of the read-only coverage endpoint so
  // the operator can see "X / Y location-snapshots already exist" before
  // running a dry-run. Updates ~400ms after picker/window changes settle, so
  // we don't fire one request per keystroke on the date inputs.
  const [coverageDebounceKey, setCoverageDebounceKey] = useState<{
    clientIds: string[];
    locationIds: string[];
    campaignIds: string[];
    sinceDate: string;
    untilDate: string;
  } | null>(null);
  useEffect(() => {
    const t = setTimeout(() => {
      setCoverageDebounceKey({
        clientIds: [...backfillClientIds].sort(),
        locationIds: [...backfillLocationIds].sort(),
        campaignIds: [...backfillCampaignIds].sort(),
        sinceDate: backfillSinceDate,
        untilDate: backfillUntilDate,
      });
    }, 400);
    return () => clearTimeout(t);
  }, [
    backfillClientIds,
    backfillLocationIds,
    backfillCampaignIds,
    backfillSinceDate,
    backfillUntilDate,
  ]);
  const hasCoverageScope =
    backfillClientIds.length > 0 ||
    backfillLocationIds.length > 0 ||
    backfillCampaignIds.length > 0;
  const { data: coverage, isFetching: coverageFetching } = useQuery<{
    mappingCount: number;
    campaignCount: number;
    knownReportDateCount: number;
    expectedSnapshotCount: number;
    coveredSnapshotCount: number;
    missingSnapshotCount: number;
    hasScope: boolean;
  }>({
    queryKey: [
      "/api/semrush/heatmaps/backfill/coverage",
      coverageDebounceKey,
    ],
    enabled: !!coverageDebounceKey && hasCoverageScope,
    queryFn: async () => {
      const payload: Record<string, unknown> = {};
      if (coverageDebounceKey?.clientIds.length)
        payload.clientIds = coverageDebounceKey.clientIds;
      if (coverageDebounceKey?.locationIds.length)
        payload.locationIds = coverageDebounceKey.locationIds;
      if (coverageDebounceKey?.campaignIds.length)
        payload.campaignIds = coverageDebounceKey.campaignIds;
      if (coverageDebounceKey?.sinceDate)
        payload.sinceDate = coverageDebounceKey.sinceDate;
      if (coverageDebounceKey?.untilDate)
        payload.untilDate = coverageDebounceKey.untilDate;
      const res = await apiRequest(
        "POST",
        "/api/semrush/heatmaps/backfill/coverage",
        payload,
      );
      return res.json();
    },
  });

  const buildBackfillPayload = useCallback(
    (dryRun: boolean) => {
      const payload: Record<string, unknown> = { dryRun };
      if (backfillClientIds.length) payload.clientIds = backfillClientIds;
      if (backfillLocationIds.length) payload.locationIds = backfillLocationIds;
      if (backfillCampaignIds.length) payload.campaignIds = backfillCampaignIds;
      if (backfillSinceDate) payload.sinceDate = backfillSinceDate;
      if (backfillUntilDate) payload.untilDate = backfillUntilDate;
      if (!dryRun) payload.confirm = true;
      return payload;
    },
    [
      backfillClientIds,
      backfillLocationIds,
      backfillCampaignIds,
      backfillSinceDate,
      backfillUntilDate,
    ],
  );

  // Snapshot of the filter values used to generate the most recent dry-run
  // preview. Apply is only safe to run when the current filters still match
  // this snapshot — otherwise the operator would be enqueuing a different
  // scope than what they reviewed.
  const [semrushBackfillPreviewKey, setSemrushBackfillPreviewKey] = useState<
    string | null
  >(null);
  const currentBackfillFilterKey = useMemo(
    () =>
      JSON.stringify({
        clientIds: [...backfillClientIds].sort(),
        locationIds: [...backfillLocationIds].sort(),
        campaignIds: [...backfillCampaignIds].sort(),
        sinceDate: backfillSinceDate,
        untilDate: backfillUntilDate,
      }),
    [
      backfillClientIds,
      backfillLocationIds,
      backfillCampaignIds,
      backfillSinceDate,
      backfillUntilDate,
    ],
  );
  // Invalidate any stale preview/result whenever the filters change so the
  // operator can never apply a backfill against a scope that wasn't the one
  // they previewed.
  useEffect(() => {
    if (
      semrushBackfillPreviewKey &&
      semrushBackfillPreviewKey !== currentBackfillFilterKey
    ) {
      setSemrushBackfillPreview(null);
      setSemrushBackfillPreviewKey(null);
      // Also drop the last applied result so an operator changing filters
      // doesn't see stale context from a previous unrelated backfill run.
      setSemrushBackfillResult(null);
      setProgress(null);
      setProgressJobs([]);
      setProgressRunStartedAt(null);
      setSelectedRunId(null);
    }
  }, [currentBackfillFilterKey, semrushBackfillPreviewKey]);

  const semrushBackfillDryRunMutation = useMutation({
    meta: { silent: true },
    mutationFn: async () => {
      const keyAtRequest = currentBackfillFilterKey;
      const res = await apiRequest(
        "POST",
        "/api/semrush/heatmaps/backfill",
        buildBackfillPayload(true),
      );
      const data = (await res.json()) as SemrushBackfillResult;
      return { data, keyAtRequest };
    },
    onSuccess: ({ data, keyAtRequest }) => {
      setSemrushBackfillPreview(data);
      setSemrushBackfillPreviewKey(keyAtRequest);
      toast({
        title: "Backfill preview ready",
        description: `${data.enqueuedJobCount} (campaign, report date) jobs would be enqueued.`,
      });
    },
    onError: (err: any) =>
      toast({
        title: "Backfill preview failed",
        description: err.message,
        variant: "destructive",
      }),
  });

  const semrushBackfillApplyMutation = useMutation({
    meta: { silent: true },
    mutationFn: async () => {
      // Capture the wall-clock start of the apply *before* the request goes
      // out so the snapshot-progress lookup catches every snapshot the
      // workers write — even ones that land while the apply request is
      // still resolving on the server.
      const runStartedAt = new Date().toISOString();
      const res = await apiRequest(
        "POST",
        "/api/semrush/heatmaps/backfill",
        buildBackfillPayload(false),
      );
      const data = (await res.json()) as SemrushBackfillResult;
      return { data, runStartedAt };
    },
    onMutate: () => {
      setSemrushBackfillResult(null);
      setSemrushBackfillPolling(true);
      setProgress(null);
      setProgressJobs([]);
      setProgressRunStartedAt(null);
    },
    onSuccess: ({ data, runStartedAt }) => {
      setSemrushBackfillResult(data);
      const trackable = data.reportDatesEnqueued
        .filter((row) => !!row.jobId)
        .map((row) => ({
          jobId: row.jobId as string,
          campaignId: row.campaignId,
          reportDate: row.reportDate,
        }));
      setProgressJobs(trackable);
      setProgressRunStartedAt(trackable.length > 0 ? runStartedAt : null);
      // If the server persisted a backfill_jobs row, prefer the persisted
      // progress view so refreshing the page (or opening this admin tool in
      // another tab) keeps showing the same run.
      if (data.jobId) {
        setSelectedRunId(data.jobId);
      }
      // Pick up the new run on the recent-runs list right away.
      void refetchRuns(); // fire-and-forget: background refetch only
      toast({
        title: "Backfill applied",
        description: `${data.enqueuedJobCount} job${data.enqueuedJobCount === 1 ? "" : "s"} enqueued across ${data.campaignsFetched}/${data.campaignsConsidered} campaigns.`,
      });
    },
    onError: (err: any) =>
      toast({
        title: "Backfill failed",
        description: err.message,
        variant: "destructive",
      }),
    onSettled: () => setSemrushBackfillPolling(false),
  });

  // Poll the per-job snapshot progress for the refresh jobs we just enqueued.
  // Stops once every refresh job is in a terminal state (completed / failed /
  // missing). This is what closes the loop for operators: it surfaces what
  // the worker actually wrote — per (campaign, reportDate, location) — rather
  // than just what we enqueued. When `selectedRunId` is set, we instead poll
  // the persisted-run endpoint so any operator can inspect any backfill run
  // (their own, a teammate's, or one from before they refreshed the page).
  const progressActive =
    !!selectedRunId || (!!progressRunStartedAt && progressJobs.length > 0);
  const progressDone = progress?.summary.allTerminal ?? false;
  useQuery<SemrushBackfillProgress>({
    queryKey: selectedRunId
      ? ["/api/semrush/heatmaps/backfill/runs", selectedRunId, "progress"]
      : [
          "/api/semrush/heatmaps/backfill/progress",
          progressRunStartedAt,
          progressJobs.length,
        ],
    enabled: progressActive,
    refetchInterval: progressActive && !progressDone ? 3000 : false,
    refetchIntervalInBackground: false,
    queryFn: async () => {
      if (selectedRunId) {
        const res = await apiRequest(
          "GET",
          `/api/semrush/heatmaps/backfill/runs/${selectedRunId}/progress`,
        );
        const data = (await res.json()) as SemrushBackfillProgress;
        setProgress(data);
        return data;
      }
      const res = await apiRequest(
        "POST",
        "/api/semrush/heatmaps/backfill/progress",
        { runStartedAt: progressRunStartedAt, jobs: progressJobs },
      );
      const data = (await res.json()) as SemrushBackfillProgress;
      setProgress(data);
      return data;
    },
  });

  // Recent backfill runs — surfaces every persisted `semrush_heatmap_backfill`
  // row so the panel can list runs started by other operators (or in earlier
  // sessions) and let anyone open the per-job progress view for them.
  const { data: runsData, refetch: refetchRuns } = useQuery<{
    runs: SemrushBackfillRun[];
  }>({
    queryKey: ["/api/semrush/heatmaps/backfill/runs"],
    refetchInterval: 15000,
  });
  const recentRuns = useMemo(() => runsData?.runs ?? [], [runsData?.runs]);
  // Keep the selected-run header card in sync with the list so the displayed
  // status / counts update as the run progresses.
  useEffect(() => {
    if (!selectedRunId) {
      if (selectedRunMeta) setSelectedRunMeta(null);
      return;
    }
    const next = recentRuns.find((r) => r.id === selectedRunId) ?? null;
    if (next && next !== selectedRunMeta) setSelectedRunMeta(next);
  }, [selectedRunId, recentRuns, selectedRunMeta]);

  // While the apply request is in flight (the server-side enqueue can take a
  // while when many campaigns are touched), poll the inventory status so the
  // operator sees that the SEMrush sync layer is alive.
  const {
    data: semrushInventoryStatus,
    refetch: refetchSemrushInventoryStatus,
  } = useQuery<{
    isRunning: boolean;
    hasPreviousInventory: boolean;
    campaignCount: number;
    lastFetchedAt: string | null;
  }>({
    queryKey: ["/api/semrush/inventory/status"],
    enabled: !!semrushStatus?.connected,
    refetchInterval: semrushBackfillPolling ? 3000 : false,
  });

  if (!semrushStatus?.connected) {
    return (
      <Card data-testid="section-semrush-backfill">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg sm:text-2xl">
            <Clock className="w-5 h-5 text-amber-600" />
            Historical Backfill
          </CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            Replay snapshots for a client/location/campaign across a date range.
          </p>
        </CardHeader>
        <CardContent>
          {semrushStatusUnknown ? (
            <p
              className="text-sm text-muted-foreground italic"
              data-testid="section-semrush-backfill-status-unknown"
            >
              Status check temporarily unavailable — retrying. This is not a
              disconnect.
            </p>
          ) : (
            <p
              className="text-sm text-muted-foreground italic"
              data-testid="section-semrush-backfill-disconnected"
            >
              Connect SEMrush from the Integrations Hub to enable historical
              backfill.
            </p>
          )}
        </CardContent>
      </Card>
    );
  }

  const preview = semrushBackfillPreview;
  const result = semrushBackfillResult;
  const applying = semrushBackfillApplyMutation.isPending;
  const previewing = semrushBackfillDryRunMutation.isPending;
  // Task #789: require the operator to scope the backfill via at least one
  // picker (clients / locations / SEMrush campaigns) before submitting. This
  // prevents accidental "backfill everything" runs that used to happen when
  // free-text inputs were left blank.
  const hasScopeSelection =
    backfillClientIds.length > 0 ||
    backfillLocationIds.length > 0 ||
    backfillCampaignIds.length > 0;

  // Aggregate per-campaign job counts from a result/preview payload so
  // operators can see at a glance how the work fans out across the
  // SEMrush campaigns matched by the filters.
  const perCampaignCounts = (r: SemrushBackfillResult | null) => {
    if (!r)
      return [] as Array<{
        campaignId: string;
        campaignName: string | null;
        count: number;
      }>;
    const nameByCampaign = new Map<string, string | null>();
    r.mappings.forEach((m) => {
      if (!nameByCampaign.has(m.semrushCampaignId)) {
        nameByCampaign.set(m.semrushCampaignId, m.semrushCampaignName);
      }
    });
    const counts = new Map<string, number>();
    r.reportDatesEnqueued.forEach((row) => {
      counts.set(row.campaignId, (counts.get(row.campaignId) ?? 0) + 1);
    });
    return Array.from(counts.entries())
      .map(([campaignId, count]) => ({
        campaignId,
        campaignName: nameByCampaign.get(campaignId) ?? null,
        count,
      }))
      .sort((a, b) => b.count - a.count);
  };
  const previewCounts = perCampaignCounts(preview);
  const resultCounts = perCampaignCounts(result);
  // Precompute campaign-name lookups so the job tables don't do an
  // O(n) `mappings.find()` on every row render.
  const buildNameMap = (r: SemrushBackfillResult | null) => {
    const map = new Map<string, string | null>();
    if (!r) return map;
    r.mappings.forEach((m) => {
      if (!map.has(m.semrushCampaignId)) {
        map.set(m.semrushCampaignId, m.semrushCampaignName);
      }
    });
    return map;
  };
  const previewNameMap = buildNameMap(preview);
  const resultNameMap = buildNameMap(result);

  return (
    <Card className="bg-card" data-testid="section-semrush-backfill">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Clock className="w-5 h-5 text-amber-600" />
          Historical Backfill
          {applying ? (
            <Badge
              variant="outline"
              className="bg-blue-50 text-blue-700 border-blue-200"
              data-testid="badge-semrush-backfill-status"
            >
              <Loader2 className="w-3 h-3 mr-1 animate-spin" /> Enqueuing
            </Badge>
          ) : result ? (
            <Badge
              variant="outline"
              className="bg-green-50 text-green-700 border-green-200"
              data-testid="badge-semrush-backfill-status"
            >
              Last run: {result.enqueuedJobCount} job
              {result.enqueuedJobCount === 1 ? "" : "s"}
            </Badge>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            onClick={() => refetchSemrushInventoryStatus()}
            data-testid="button-semrush-backfill-refresh-status"
          >
            <RefreshCw className="w-3 h-3 mr-1" /> Refresh status
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          Re-runs the SEMrush refresh for every (client, location, campaign)
          mapping that matches your filters and writes one heatmap snapshot per
          known report date in the window. Always preview with a dry run first;
          the live run requires explicit confirmation.
        </p>
        {semrushInventoryStatus && (
          <div
            className="text-[11px] text-muted-foreground flex flex-wrap gap-x-4 gap-y-1"
            data-testid="text-semrush-inventory-status"
          >
            <span>
              Inventory sync:{" "}
              <span className="font-medium text-foreground">
                {semrushInventoryStatus.isRunning ? "running" : "idle"}
              </span>
            </span>
            <span>
              Known campaigns:{" "}
              <span className="font-medium text-foreground">
                {semrushInventoryStatus.campaignCount}
              </span>
            </span>
            {semrushInventoryStatus.lastFetchedAt && (
              <span>
                Last inventory fetch:{" "}
                <span className="font-medium text-foreground">
                  {new Date(
                    semrushInventoryStatus.lastFetchedAt,
                  ).toLocaleString()}
                </span>
              </span>
            )}
          </div>
        )}

        {recentRuns.length > 0 && (
          <div
            className="border rounded-lg bg-card"
            data-testid="section-semrush-backfill-recent-runs"
          >
            <div className="flex items-center justify-between gap-2 px-3 py-2 border-b">
              <h4 className="text-xs font-semibold text-foreground">
                Recent backfill runs
              </h4>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-xs"
                onClick={() => refetchRuns()}
                data-testid="button-semrush-backfill-runs-refresh"
              >
                <RefreshCw className="w-3 h-3 mr-1" /> Refresh
              </Button>
            </div>
            <ul className="divide-y max-h-64 overflow-auto">
              {recentRuns.map((run) => {
                const isSelected = selectedRunId === run.id;
                const filterParts: string[] = [];
                if (run.parameters?.clientIds?.length) {
                  filterParts.push(
                    `${run.parameters.clientIds.length} client${run.parameters.clientIds.length === 1 ? "" : "s"}`,
                  );
                }
                if (run.parameters?.locationIds?.length) {
                  filterParts.push(
                    `${run.parameters.locationIds.length} location${run.parameters.locationIds.length === 1 ? "" : "s"}`,
                  );
                }
                if (run.parameters?.campaignIds?.length) {
                  filterParts.push(
                    `${run.parameters.campaignIds.length} campaign${run.parameters.campaignIds.length === 1 ? "" : "s"}`,
                  );
                }
                if (run.parameters?.sinceDate) {
                  filterParts.push(`since ${run.parameters.sinceDate}`);
                }
                if (run.parameters?.untilDate) {
                  filterParts.push(`until ${run.parameters.untilDate}`);
                }
                const when = run.startedAt ?? run.createdAt;
                const statusClass = (() => {
                  switch (run.status) {
                    case "running":
                    case "queued":
                      return "bg-blue-50 text-blue-700 border-blue-200";
                    case "succeeded":
                      return "bg-emerald-50 text-emerald-700 border-emerald-200";
                    case "partial":
                      return "bg-amber-50 text-amber-700 border-amber-200";
                    case "failed":
                    case "cancelled":
                      return "bg-red-50 text-red-700 border-red-200";
                    default:
                      return "bg-muted/50 text-foreground border-border";
                  }
                })();
                return (
                  <li
                    key={run.id}
                    className={`px-3 py-2 text-xs flex items-center gap-3 ${isSelected ? "bg-blue-50/50" : ""}`}
                    data-testid={`row-semrush-backfill-run-${run.id}`}
                  >
                    <Badge
                      variant="outline"
                      className={statusClass}
                      data-testid={`badge-semrush-backfill-run-status-${run.id}`}
                    >
                      {run.status}
                    </Badge>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span
                          className="font-medium text-foreground"
                          data-testid={`text-semrush-backfill-run-when-${run.id}`}
                        >
                          {when ? new Date(when).toLocaleString() : "—"}
                        </span>
                        <span
                          className="text-muted-foreground"
                          data-testid={`text-semrush-backfill-run-jobs-${run.id}`}
                        >
                          {run.enqueuedJobCount} job
                          {run.enqueuedJobCount === 1 ? "" : "s"} enqueued
                        </span>
                        {run.failedUnits > 0 && (
                          <span className="text-red-700">
                            {run.failedUnits} failed
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-muted-foreground truncate">
                        {filterParts.length > 0
                          ? filterParts.join(" · ")
                          : "no filters"}
                        {run.triggeredBy ? ` · by ${run.triggeredBy}` : ""}
                      </div>
                      {run.errorMessage && (
                        <div className="text-[11px] text-red-700 break-words mt-0.5">
                          {run.errorMessage}
                        </div>
                      )}
                    </div>
                    {isSelected ? (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 px-2 text-xs"
                        onClick={() => {
                          setSelectedRunId(null);
                          setProgress(null);
                        }}
                        data-testid={`button-semrush-backfill-run-close-${run.id}`}
                      >
                        Hide progress
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 px-2 text-xs"
                        disabled={!run.hasProgress}
                        title={
                          run.hasProgress
                            ? undefined
                            : "Run is still being applied — no per-job progress yet"
                        }
                        onClick={() => {
                          setSelectedRunId(run.id);
                          setProgress(null);
                          // Drop the just-applied React-state progress so the
                          // selected-run query becomes the sole source of truth.
                          setProgressJobs([]);
                          setProgressRunStartedAt(null);
                        }}
                        data-testid={`button-semrush-backfill-run-view-${run.id}`}
                      >
                        View progress
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="space-y-1">
            <Label className="text-xs">Clients</Label>
            <MultiSelectPicker
              options={clientOptions}
              value={backfillClientIds}
              onChange={setBackfillClientIds}
              placeholder="All clients"
              searchPlaceholder="Search clients…"
              emptyText="No clients found."
              isLoading={clientsLoading}
              testId="picker-semrush-backfill-clients"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Locations</Label>
            <MultiSelectPicker
              options={locationOptions}
              value={backfillLocationIds}
              onChange={setBackfillLocationIds}
              placeholder={
                backfillClientIds.length === 0
                  ? "All locations for selected clients"
                  : "All locations"
              }
              searchPlaceholder="Search locations…"
              emptyText={
                backfillClientIds.length === 0
                  ? "Pick a client first."
                  : "No locations for the selected client(s)."
              }
              isLoading={locationsLoading}
              disabled={backfillClientIds.length === 0}
              disabledReason="Pick one or more clients first"
              testId="picker-semrush-backfill-locations"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">SEMrush campaigns</Label>
            <MultiSelectPicker
              options={campaignOptions}
              value={backfillCampaignIds}
              onChange={setBackfillCampaignIds}
              placeholder="All campaigns"
              searchPlaceholder="Search campaigns…"
              emptyText={
                campaignOptions.length === 0
                  ? "No SEMrush campaigns in inventory yet."
                  : "No campaigns match."
              }
              isLoading={campaignsLoading}
              testId="picker-semrush-backfill-campaigns"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="input-semrush-backfill-since" className="text-xs">
              Since (report date)
            </Label>
            <Input
              id="input-semrush-backfill-since"
              type="date"
              value={backfillSinceDate}
              onChange={(e) => setBackfillSinceDate(e.target.value)}
              data-testid="input-semrush-backfill-since"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="input-semrush-backfill-until" className="text-xs">
              Until (report date)
            </Label>
            <Input
              id="input-semrush-backfill-until"
              type="date"
              value={backfillUntilDate}
              onChange={(e) => setBackfillUntilDate(e.target.value)}
              data-testid="input-semrush-backfill-until"
            />
          </div>
          <div className="flex items-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              className="text-muted-foreground"
              onClick={() => {
                setBackfillClientIds([]);
                setBackfillLocationIds([]);
                setBackfillCampaignIds([]);
                setBackfillSinceDate("");
                setBackfillUntilDate("");
                setSemrushBackfillPreview(null);
                setSemrushBackfillResult(null);
                setProgress(null);
                setProgressJobs([]);
                setProgressRunStartedAt(null);
                setSelectedRunId(null);
              }}
              data-testid="button-semrush-backfill-reset"
            >
              <RotateCcw className="w-3 h-3 mr-1" /> Reset
            </Button>
          </div>
        </div>

        {hasScopeSelection && (
          <div
            className="border rounded-md bg-amber-50/50 border-amber-200 px-3 py-2 text-xs text-foreground flex flex-wrap items-center gap-x-3 gap-y-1"
            data-testid="section-semrush-backfill-coverage"
          >
            <span className="font-semibold text-foreground">
              Existing snapshot coverage:
            </span>
            {coverageFetching && !coverage ? (
              <span className="flex items-center gap-1 text-muted-foreground italic">
                <Loader2 className="w-3 h-3 animate-spin" /> Checking…
              </span>
            ) : coverage && coverage.hasScope ? (
              coverage.mappingCount === 0 ? (
                <span
                  className="text-muted-foreground"
                  data-testid="text-semrush-coverage-no-mappings"
                >
                  No SEMrush mappings match this scope — nothing to backfill.
                </span>
              ) : coverage.expectedSnapshotCount === 0 ? (
                <span
                  className="text-muted-foreground"
                  data-testid="text-semrush-coverage-no-known-dates"
                >
                  No prior heatmap snapshots found for{" "}
                  <span className="font-medium">
                    {coverage.campaignCount}
                  </span>{" "}
                  matched campaign
                  {coverage.campaignCount === 1 ? "" : "s"} in this window — a
                  dry-run will discover the report dates from SEMrush.
                </span>
              ) : (
                <>
                  <span data-testid="text-semrush-coverage-summary">
                    <span className="font-medium text-emerald-700">
                      {coverage.coveredSnapshotCount.toLocaleString()}
                    </span>
                    {" / "}
                    <span className="font-medium">
                      {coverage.expectedSnapshotCount.toLocaleString()}
                    </span>{" "}
                    location-snapshots already exist
                  </span>
                  {coverage.missingSnapshotCount > 0 ? (
                    <span
                      className="text-amber-800"
                      data-testid="text-semrush-coverage-missing"
                    >
                      ({coverage.missingSnapshotCount.toLocaleString()} missing
                      — backfill is worth running)
                    </span>
                  ) : (
                    <span
                      className="text-emerald-700 flex items-center gap-1"
                      data-testid="text-semrush-coverage-full"
                    >
                      <CheckCircle2 className="w-3 h-3" /> Already fully covered
                      — backfill likely unnecessary
                    </span>
                  )}
                  <span
                    className="text-muted-foreground"
                    data-testid="text-semrush-coverage-detail"
                  >
                    across {coverage.mappingCount.toLocaleString()} mapping
                    {coverage.mappingCount === 1 ? "" : "s"} ×{" "}
                    {coverage.knownReportDateCount.toLocaleString()} known
                    report date
                    {coverage.knownReportDateCount === 1 ? "" : "s"}
                  </span>
                </>
              )
            ) : (
              <span className="text-muted-foreground italic">
                Adjust filters to see coverage…
              </span>
            )}
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={previewing || applying || !hasScopeSelection}
            title={
              !hasScopeSelection
                ? "Pick at least one client, location, or SEMrush campaign before previewing"
                : undefined
            }
            onClick={() => semrushBackfillDryRunMutation.mutate()}
            data-testid="button-semrush-backfill-dry-run"
          >
            {previewing ? (
              <Loader2 className="w-3 h-3 mr-1 animate-spin" />
            ) : (
              <Activity className="w-3 h-3 mr-1" />
            )}
            Dry-run preview
          </Button>
          <ConfirmActionDialog
            title="Apply SEMrush backfill?"
            description={`This will enqueue ${(preview?.enqueuedJobCount ?? 0).toLocaleString()} (campaign, report date) refresh job${(preview?.enqueuedJobCount ?? 0) === 1 ? "" : "s"}${(preview?.campaignFetchFailures.length ?? 0) > 0 ? ` and ignore ${preview?.campaignFetchFailures.length} campaign${(preview?.campaignFetchFailures.length ?? 0) === 1 ? "" : "s"} that failed to fetch in the preview` : ""}. Jobs reprocess stored data; nothing is deleted.`}
            confirmLabel="Apply backfill"
            testId="dialog-confirm-semrush-backfill-apply"
            onConfirm={() => semrushBackfillApplyMutation.mutate()}
            trigger={
              <Button
                size="sm"
                variant="default"
                className="bg-orange-600 hover:bg-orange-700 text-white"
                disabled={
                  applying ||
                  previewing ||
                  !hasScopeSelection ||
                  !preview ||
                  semrushBackfillPreviewKey !== currentBackfillFilterKey
                }
                title={
                  !hasScopeSelection
                    ? "Pick at least one client, location, or SEMrush campaign before applying"
                    : !preview
                      ? "Run a dry-run preview first"
                      : semrushBackfillPreviewKey !== currentBackfillFilterKey
                        ? "Filters changed since the last preview — run the dry-run again before applying"
                        : undefined
                }
                data-testid="button-semrush-backfill-apply"
              >
                {applying ? (
                  <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                ) : (
                  <Download className="w-3 h-3 mr-1" />
                )}
                Apply backfill
              </Button>
            }
          />
          {!hasScopeSelection ? (
            <span
              className="text-xs text-muted-foreground flex items-center gap-1"
              data-testid="text-semrush-backfill-needs-scope"
            >
              Pick at least one client, location, or SEMrush campaign to scope
              the backfill.
            </span>
          ) : !preview ? (
            <span
              className="text-xs text-muted-foreground flex items-center gap-1"
              data-testid="text-semrush-backfill-needs-preview"
            >
              Run a dry-run preview first — Apply only enables when the preview
              matches the current filters.
            </span>
          ) : null}
        </div>

        {preview && (
          <div
            className="border rounded-lg p-3 bg-muted/50 space-y-2"
            data-testid="section-semrush-backfill-preview"
          >
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-semibold text-foreground">
                Dry-run preview
              </h4>
              <Badge
                variant="outline"
                className="bg-blue-50 text-blue-700 border-blue-200"
              >
                {preview.enqueuedJobCount} jobs
              </Badge>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs text-muted-foreground">
              <span>
                Mappings:{" "}
                <span
                  className="font-medium text-foreground"
                  data-testid="text-semrush-preview-mappings"
                >
                  {preview.mappings.length}
                </span>
              </span>
              <span>
                Campaigns considered:{" "}
                <span
                  className="font-medium text-foreground"
                  data-testid="text-semrush-preview-considered"
                >
                  {preview.campaignsConsidered}
                </span>
              </span>
              <span>
                Campaigns fetched:{" "}
                <span
                  className="font-medium text-foreground"
                  data-testid="text-semrush-preview-fetched"
                >
                  {preview.campaignsFetched}
                </span>
              </span>
              <span>
                Skipped report dates:{" "}
                <span
                  className="font-medium text-foreground"
                  data-testid="text-semrush-preview-skipped"
                >
                  {preview.reportDatesSkipped.length}
                </span>
              </span>
            </div>
            {previewCounts.length > 0 && (
              <div
                className="border rounded bg-card p-2 max-h-48 overflow-y-auto"
                data-testid="list-semrush-preview-per-campaign"
              >
                <div className="text-[11px] font-semibold text-muted-foreground mb-1">
                  Per-campaign jobs that would be enqueued
                </div>
                <ul className="space-y-0.5 text-xs">
                  {previewCounts.map((row) => (
                    <li
                      key={row.campaignId}
                      className="flex items-center justify-between gap-2"
                      data-testid={`row-semrush-preview-campaign-${row.campaignId}`}
                    >
                      <span
                        className="font-mono text-foreground truncate"
                        title={row.campaignId}
                      >
                        {row.campaignName ?? row.campaignId}
                      </span>
                      <span className="text-muted-foreground">{row.count}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {preview.reportDatesEnqueued.length > 0 && (
              <div
                className="border rounded bg-card p-2 max-h-64 overflow-auto"
                data-testid="list-semrush-preview-jobs"
              >
                <div className="text-[11px] font-semibold text-muted-foreground mb-1">
                  Jobs that would be enqueued (
                  {preview.reportDatesEnqueued.length})
                </div>
                <table className="w-full text-xs min-w-[480px]">
                  <thead className="text-[10px] uppercase text-muted-foreground">
                    <tr>
                      <th className="text-left font-medium pr-2 py-0.5">
                        Campaign
                      </th>
                      <th className="text-left font-medium pr-2 py-0.5">
                        Campaign ID
                      </th>
                      <th className="text-left font-medium py-0.5">
                        Report date
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.reportDatesEnqueued.map((row, idx) => {
                      const name = previewNameMap.get(row.campaignId) ?? null;
                      return (
                        <tr
                          key={`${row.campaignId}-${row.reportDate}-${idx}`}
                          className="border-t border-border"
                          data-testid={`row-semrush-preview-job-${row.campaignId}-${row.reportDate}`}
                        >
                          <td
                            className="pr-2 py-0.5 text-foreground truncate max-w-[160px]"
                            title={name ?? row.campaignId}
                          >
                            {name ?? "—"}
                          </td>
                          <td
                            className="pr-2 py-0.5 font-mono text-muted-foreground truncate"
                            title={row.campaignId}
                          >
                            {row.campaignId}
                          </td>
                          <td className="py-0.5 text-foreground">
                            {row.reportDate}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {preview.reportDatesSkipped.length > 0 && (
              <div
                className="border rounded bg-card p-2 max-h-40 overflow-y-auto"
                data-testid="list-semrush-preview-skipped"
              >
                <div className="text-[11px] font-semibold text-muted-foreground mb-1">
                  Skipped report dates ({preview.reportDatesSkipped.length})
                </div>
                <ul className="space-y-0.5 text-xs">
                  {preview.reportDatesSkipped.map((row, idx) => (
                    <li
                      key={`${row.campaignId}-${row.reportDate}-${idx}`}
                      className="flex items-center gap-2 text-muted-foreground"
                      data-testid={`row-semrush-preview-skipped-${row.campaignId}-${row.reportDate}`}
                    >
                      <span className="font-mono shrink-0">
                        {row.campaignId}
                      </span>
                      <span>{row.reportDate}</span>
                      <span className="text-muted-foreground italic">
                        — {row.reason}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {preview.campaignFetchFailures.length > 0 && (
              <div
                className="border border-amber-200 rounded bg-amber-50 p-2 text-xs text-amber-800"
                data-testid="list-semrush-preview-failures"
              >
                <div className="font-semibold mb-1">
                  Fetch failures ({preview.campaignFetchFailures.length})
                </div>
                <ul className="space-y-0.5">
                  {preview.campaignFetchFailures.map((f) => (
                    <li
                      key={f.campaignId}
                      className="flex items-start gap-2"
                      data-testid={`row-semrush-preview-failure-${f.campaignId}`}
                    >
                      <span className="font-mono shrink-0">{f.campaignId}</span>
                      <span className="text-amber-900 break-all">
                        {f.error}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {applying && !result && (
          <div
            className="border rounded-lg p-3 bg-blue-50 flex items-center gap-2 text-sm text-blue-800"
            data-testid="section-semrush-backfill-applying"
          >
            <Loader2 className="w-4 h-4 animate-spin" />
            Applying backfill — enqueuing refresh jobs across matching
            campaigns...
          </div>
        )}

        {result && (
          <div
            className="border rounded-lg p-3 bg-emerald-50 space-y-2"
            data-testid="section-semrush-backfill-result"
          >
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-semibold text-emerald-900">
                Last applied run
              </h4>
              <Badge
                variant="outline"
                className="bg-green-50 text-green-700 border-green-200"
              >
                {result.enqueuedJobCount} jobs enqueued
              </Badge>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs text-emerald-900">
              <span>
                Mappings:{" "}
                <span
                  className="font-medium"
                  data-testid="text-semrush-result-mappings"
                >
                  {result.mappings.length}
                </span>
              </span>
              <span>
                Campaigns considered:{" "}
                <span
                  className="font-medium"
                  data-testid="text-semrush-result-considered"
                >
                  {result.campaignsConsidered}
                </span>
              </span>
              <span>
                Campaigns fetched:{" "}
                <span
                  className="font-medium"
                  data-testid="text-semrush-result-fetched"
                >
                  {result.campaignsFetched}
                </span>
              </span>
              <span>
                Skipped report dates:{" "}
                <span
                  className="font-medium"
                  data-testid="text-semrush-result-skipped"
                >
                  {result.reportDatesSkipped.length}
                </span>
              </span>
            </div>
            {resultCounts.length > 0 && (
              <div
                className="border rounded bg-card p-2 max-h-48 overflow-y-auto"
                data-testid="list-semrush-result-per-campaign"
              >
                <div className="text-[11px] font-semibold text-muted-foreground mb-1">
                  Per-campaign jobs enqueued
                </div>
                <ul className="space-y-0.5 text-xs">
                  {resultCounts.map((row) => (
                    <li
                      key={row.campaignId}
                      className="flex items-center justify-between gap-2"
                      data-testid={`row-semrush-result-campaign-${row.campaignId}`}
                    >
                      <span
                        className="font-mono text-foreground truncate"
                        title={row.campaignId}
                      >
                        {row.campaignName ?? row.campaignId}
                      </span>
                      <span className="text-muted-foreground">{row.count}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {result.reportDatesEnqueued.length > 0 && (
              <div
                className="border rounded bg-card p-2 max-h-64 overflow-auto"
                data-testid="list-semrush-result-jobs"
              >
                <div className="text-[11px] font-semibold text-muted-foreground mb-1">
                  Refresh jobs enqueued ({result.reportDatesEnqueued.length})
                </div>
                <table className="w-full text-xs min-w-[560px]">
                  <thead className="text-[10px] uppercase text-muted-foreground">
                    <tr>
                      <th className="text-left font-medium pr-2 py-0.5">
                        Campaign
                      </th>
                      <th className="text-left font-medium pr-2 py-0.5">
                        Campaign ID
                      </th>
                      <th className="text-left font-medium pr-2 py-0.5">
                        Report date
                      </th>
                      <th className="text-left font-medium py-0.5">Job ID</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.reportDatesEnqueued.map((row, idx) => {
                      const name = resultNameMap.get(row.campaignId) ?? null;
                      return (
                        <tr
                          key={`${row.campaignId}-${row.reportDate}-${idx}`}
                          className="border-t border-border"
                          data-testid={`row-semrush-result-job-${row.campaignId}-${row.reportDate}`}
                        >
                          <td
                            className="pr-2 py-0.5 text-foreground truncate max-w-[160px]"
                            title={name ?? row.campaignId}
                          >
                            {name ?? "—"}
                          </td>
                          <td
                            className="pr-2 py-0.5 font-mono text-muted-foreground truncate"
                            title={row.campaignId}
                          >
                            {row.campaignId}
                          </td>
                          <td className="pr-2 py-0.5 text-foreground">
                            {row.reportDate}
                          </td>
                          <td
                            className="py-0.5 font-mono text-muted-foreground truncate"
                            title={row.jobId ?? ""}
                          >
                            {row.jobId ?? "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {result.campaignFetchFailures.length > 0 && (
              <div
                className="border border-red-200 rounded bg-red-50 p-2 text-xs text-red-800"
                data-testid="list-semrush-result-failures"
              >
                <div className="font-semibold mb-1">
                  Fetch failures ({result.campaignFetchFailures.length})
                </div>
                <ul className="space-y-0.5">
                  {result.campaignFetchFailures.map((f) => (
                    <li
                      key={f.campaignId}
                      className="flex items-start gap-2"
                      data-testid={`row-semrush-result-failure-${f.campaignId}`}
                    >
                      <span className="font-mono shrink-0">{f.campaignId}</span>
                      <span className="text-red-900 break-all">{f.error}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {progressActive && (
          <div
            className="border rounded-lg p-3 bg-card space-y-3"
            data-testid="section-semrush-backfill-progress"
          >
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-2">
                <h4 className="text-xs font-semibold text-foreground">
                  Refresh job progress
                </h4>
                {progressDone ? (
                  <Badge
                    variant="outline"
                    className="bg-green-50 text-green-700 border-green-200"
                    data-testid="badge-semrush-backfill-progress-status"
                  >
                    <CheckCircle2 className="w-3 h-3 mr-1" /> All jobs drained
                  </Badge>
                ) : (
                  <Badge
                    variant="outline"
                    className="bg-blue-50 text-blue-700 border-blue-200"
                    data-testid="badge-semrush-backfill-progress-status"
                  >
                    <Loader2 className="w-3 h-3 mr-1 animate-spin" /> Polling
                    every 3s…
                  </Badge>
                )}
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                {selectedRunId && (
                  <span
                    className="text-[11px] text-muted-foreground"
                    data-testid="text-semrush-backfill-progress-run-meta"
                  >
                    Viewing persisted run
                    {progress?.runStatus ? ` · ${progress.runStatus}` : ""}
                    {progress?.triggeredBy
                      ? ` · by ${progress.triggeredBy}`
                      : ""}
                  </span>
                )}
                {progress?.runStartedAt && (
                  <span className="text-[11px] text-muted-foreground">
                    Started{" "}
                    {new Date(progress.runStartedAt).toLocaleTimeString()}
                  </span>
                )}
              </div>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-xs text-foreground">
              <span>
                Total:{" "}
                <span
                  className="font-medium"
                  data-testid="text-semrush-progress-total"
                >
                  {progress?.summary.total ?? progressJobs.length}
                </span>
              </span>
              <span>
                Queued:{" "}
                <span
                  className="font-medium text-foreground"
                  data-testid="text-semrush-progress-queued"
                >
                  {progress?.summary.queued ?? 0}
                </span>
              </span>
              <span>
                Running:{" "}
                <span
                  className="font-medium text-blue-700"
                  data-testid="text-semrush-progress-running"
                >
                  {progress?.summary.running ?? 0}
                </span>
              </span>
              <span>
                Completed:{" "}
                <span
                  className="font-medium text-emerald-700"
                  data-testid="text-semrush-progress-completed"
                >
                  {progress?.summary.completed ?? 0}
                </span>
              </span>
              <span>
                Failed:{" "}
                <span
                  className="font-medium text-red-700"
                  data-testid="text-semrush-progress-failed"
                >
                  {progress?.summary.failed ?? 0}
                </span>
              </span>
            </div>
            {!progress && (
              <div className="text-xs text-muted-foreground italic">
                Waiting for first progress poll…
              </div>
            )}
            {progress && progress.jobs.length > 0 && (
              <div
                className="border rounded bg-muted/50 p-2 max-h-[28rem] overflow-auto space-y-2"
                data-testid="list-semrush-progress-groups"
              >
                {(() => {
                  // Group refresh jobs by (campaign, reportDate) and pair
                  // with the matching snapshot writes for that group, so the
                  // operator sees both the worker-side job status and the
                  // per-location snapshots that landed (or didn't).
                  type Group = {
                    campaignId: string;
                    reportDate: string;
                    job: SemrushBackfillProgress["jobs"][number];
                    snapshots: SemrushBackfillProgress["snapshots"];
                    applyJobs: SemrushBackfillProgress["applyJobs"];
                  };
                  const snapByGroup = new Map<
                    string,
                    SemrushBackfillProgress["snapshots"]
                  >();
                  for (const s of progress.snapshots) {
                    const key = `${s.campaignId}|${s.reportDate}`;
                    const arr = snapByGroup.get(key) ?? [];
                    arr.push(s);
                    snapByGroup.set(key, arr);
                  }
                  // Index failed/in-flight apply jobs by (campaign,
                  // reportDate). Each entry covers a single location whose
                  // apply job hasn't successfully written snapshots yet, so
                  // it complements `snapshots` (which only lists locations
                  // whose apply jobs *did* succeed for this run).
                  const applyByGroup = new Map<
                    string,
                    SemrushBackfillProgress["applyJobs"]
                  >();
                  for (const a of progress.applyJobs ?? []) {
                    const key = `${a.campaignId}|${a.reportDate}`;
                    const arr = applyByGroup.get(key) ?? [];
                    arr.push(a);
                    applyByGroup.set(key, arr);
                  }
                  const groups: Group[] = progress.jobs.map((j) => {
                    const key = `${j.campaignId}|${j.reportDate}`;
                    const groupSnapshots = snapByGroup.get(key) ?? [];
                    const groupApplyJobs = applyByGroup.get(key) ?? [];
                    // If a location already has landed snapshot rows for this
                    // run, suppress its incomplete apply-job entry — the
                    // succeeded row tells the operator everything they need.
                    // This handles the retry case where a failed apply job
                    // is followed by a successful one for the same tuple.
                    const succeededLocationIds = new Set(
                      groupSnapshots.map((s) => s.locationId),
                    );
                    return {
                      campaignId: j.campaignId,
                      reportDate: j.reportDate,
                      job: j,
                      snapshots: groupSnapshots,
                      applyJobs: groupApplyJobs.filter(
                        (a) => !succeededLocationIds.has(a.locationId),
                      ),
                    };
                  });
                  // Order: failed first, then running, then queued, then completed.
                  const order: Record<string, number> = {
                    failed: 0,
                    missing: 1,
                    running: 2,
                    queued: 3,
                    completed: 4,
                  };
                  groups.sort(
                    (a, b) =>
                      (order[a.job.status] ?? 9) - (order[b.job.status] ?? 9) ||
                      a.campaignId.localeCompare(b.campaignId) ||
                      a.reportDate.localeCompare(b.reportDate),
                  );
                  return groups.map((g) => {
                    const name =
                      resultNameMap.get(g.campaignId) ??
                      previewNameMap.get(g.campaignId) ??
                      null;
                    const statusBadge = (() => {
                      if (g.job.status === "completed")
                        return (
                          <Badge
                            variant="outline"
                            className="bg-emerald-50 text-emerald-700 border-emerald-200"
                          >
                            <CheckCircle2 className="w-3 h-3 mr-1" /> Completed
                          </Badge>
                        );
                      if (g.job.status === "running")
                        return (
                          <Badge
                            variant="outline"
                            className="bg-blue-50 text-blue-700 border-blue-200"
                          >
                            <Loader2 className="w-3 h-3 mr-1 animate-spin" />{" "}
                            Running
                          </Badge>
                        );
                      if (g.job.status === "queued")
                        return (
                          <Badge
                            variant="outline"
                            className="bg-muted/50 text-foreground border-border"
                          >
                            <Clock className="w-3 h-3 mr-1" /> Queued
                          </Badge>
                        );
                      if (g.job.status === "failed")
                        return (
                          <Badge
                            variant="outline"
                            className="bg-red-50 text-red-700 border-red-200"
                          >
                            <AlertCircle className="w-3 h-3 mr-1" /> Failed
                          </Badge>
                        );
                      return (
                        <Badge
                          variant="outline"
                          className="bg-amber-50 text-amber-700 border-amber-200"
                        >
                          <AlertCircle className="w-3 h-3 mr-1" /> Missing
                        </Badge>
                      );
                    })();
                    return (
                      <div
                        key={`${g.campaignId}-${g.reportDate}`}
                        className="border rounded bg-card p-2"
                        data-testid={`row-semrush-progress-${g.campaignId}-${g.reportDate}`}
                      >
                        <div className="flex items-center justify-between gap-2 flex-wrap">
                          <div className="flex items-center gap-2 min-w-0">
                            {statusBadge}
                            <span
                              className="text-xs font-medium text-foreground truncate max-w-[200px]"
                              title={name ?? g.campaignId}
                            >
                              {name ?? g.campaignId}
                            </span>
                            <span className="text-[11px] text-muted-foreground">
                              {g.reportDate}
                            </span>
                          </div>
                          <span
                            className="text-[11px] text-muted-foreground flex items-center gap-2"
                            data-testid={`text-semrush-progress-snapshot-count-${g.campaignId}-${g.reportDate}`}
                          >
                            <span>
                              {g.snapshots.length} succeeded
                            </span>
                            {g.applyJobs.length > 0 && (
                              <span
                                className="text-red-700"
                                data-testid={`text-semrush-progress-apply-incomplete-count-${g.campaignId}-${g.reportDate}`}
                              >
                                · {g.applyJobs.length} incomplete
                              </span>
                            )}
                          </span>
                        </div>
                        {g.job.errorMessage && (
                          <div
                            className="mt-1 text-[11px] text-red-700 break-words"
                            data-testid={`text-semrush-progress-error-${g.campaignId}-${g.reportDate}`}
                          >
                            {g.job.errorMessage}
                            {g.job.attemptCount > 0 &&
                              ` (attempt ${g.job.attemptCount})`}
                          </div>
                        )}
                        {g.job.status === "completed" &&
                          g.snapshots.length === 0 &&
                          g.applyJobs.length === 0 && (
                            <div className="mt-1 text-[11px] text-amber-700">
                              Refresh job completed but no snapshot rows landed
                              for this report date — check worker logs.
                            </div>
                          )}
                        {(g.snapshots.length > 0 ||
                          g.applyJobs.length > 0) && (
                          <ul className="mt-2 space-y-0.5 text-[11px]">
                            {g.snapshots.map((s) => (
                              <li
                                key={`snap-${g.campaignId}-${g.reportDate}-${s.locationId}`}
                                className="flex items-center justify-between gap-2"
                                data-testid={`row-semrush-progress-snapshot-${g.campaignId}-${g.reportDate}-${s.locationId}`}
                              >
                                <span className="flex items-center gap-1 min-w-0">
                                  <CheckCircle2 className="w-3 h-3 text-emerald-600 shrink-0" />
                                  <span
                                    className="truncate text-foreground"
                                    title={`${s.locationName} · ${s.locationId}`}
                                  >
                                    {s.locationName || s.locationId}
                                  </span>
                                </span>
                                <span className="text-muted-foreground shrink-0">
                                  {s.keywordCount} keyword
                                  {s.keywordCount === 1 ? "" : "s"}
                                </span>
                              </li>
                            ))}
                            {g.applyJobs.map((a) => {
                              // Pick the most-severe in-flight state for the
                              // location: failed > running > queued. The
                              // counts are already aggregated server-side.
                              const isFailed = a.failedCount > 0;
                              const isRunning =
                                !isFailed && a.runningCount > 0;
                              const stateLabel = isFailed
                                ? "Failed"
                                : isRunning
                                  ? "Running"
                                  : "Queued";
                              const stateClass = isFailed
                                ? "text-red-700"
                                : isRunning
                                  ? "text-blue-700"
                                  : "text-muted-foreground";
                              const Icon = isFailed
                                ? AlertCircle
                                : isRunning
                                  ? Loader2
                                  : Clock;
                              return (
                                <li
                                  key={`apply-${g.campaignId}-${g.reportDate}-${a.locationId}`}
                                  className="flex flex-col gap-0.5"
                                  data-testid={`row-semrush-progress-apply-${g.campaignId}-${g.reportDate}-${a.locationId}`}
                                >
                                  <div className="flex items-center justify-between gap-2">
                                    <span className="flex items-center gap-1 min-w-0">
                                      <Icon
                                        className={`w-3 h-3 shrink-0 ${stateClass} ${
                                          isRunning ? "animate-spin" : ""
                                        }`}
                                      />
                                      <span
                                        className="truncate text-foreground"
                                        title={`${a.locationName ?? a.locationId} · ${a.locationId}`}
                                      >
                                        {a.locationName || a.locationId}
                                      </span>
                                    </span>
                                    <span
                                      className={`shrink-0 ${stateClass}`}
                                      data-testid={`text-semrush-progress-apply-state-${g.campaignId}-${g.reportDate}-${a.locationId}`}
                                    >
                                      {stateLabel}
                                      {a.failedCount +
                                        a.runningCount +
                                        a.queuedCount >
                                        1 &&
                                        ` (${a.failedCount + a.runningCount + a.queuedCount} jobs)`}
                                    </span>
                                  </div>
                                  {isFailed && a.latestErrorMessage && (
                                    <div
                                      className="ml-4 text-red-700 break-words"
                                      data-testid={`text-semrush-progress-apply-error-${g.campaignId}-${g.reportDate}-${a.locationId}`}
                                    >
                                      {a.latestErrorMessage}
                                    </div>
                                  )}
                                </li>
                              );
                            })}
                          </ul>
                        )}
                      </div>
                    );
                  });
                })()}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
