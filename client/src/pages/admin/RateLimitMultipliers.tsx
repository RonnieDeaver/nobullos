import { useAuth } from "@/hooks/use-auth";
import { formatEditorAttribution } from "@/lib/auditEditorFormat";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { Link } from "wouter";
import { ArrowLeft, Save, RotateCcw, Shield, Plus, Trash2, History, ArrowRight, X } from "lucide-react";
import { useState, useEffect } from "react";
import { LastEditedBadge, type LastEditedInfo } from "@/components/LastEditedBadge";
import { usePersistentState } from "@/hooks/use-persistent-state";
import {
  type EffectiveLimitsData as EffectiveLimits,
  type LimiterConfigInfo,
  validateMultiplierString,
  getInvalidMultiplierRoles,
  buildFallbackEffectiveLimits,
} from "./rateLimitMultipliersPreview";
import { EffectiveRateLimitsPreviewTable } from "./EffectiveRateLimitsPreviewTable";
import { PageHeader } from "@/components/admin/PageHeader";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { DangerZone } from "@/components/kit/DangerZone";

type MultipliersResponse = {
  defaults: Record<string, number>;
  effective: Record<string, number>;
  effectiveLimits?: EffectiveLimits;
  limiterConfigs?: Record<string, LimiterConfigInfo>;
  lastEdited?: LastEditedInfo;
};

const ROLE_LABELS: Record<string, string> = {
  ceo: "CEO",
  team_lead: "Team Lead",
  account_manager: "Account Manager",
};

export default function RateLimitMultipliers() {
  const { user, isLoading: authLoading } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [editValues, setEditValues] = useState<Record<string, string>>({});
  // Task #4357: confirm gate for the destructive reset-to-defaults action.
  const [confirmResetOpen, setConfirmResetOpen] = useState(false);
  const [newRole, setNewRole] = useState("");
  const [newMultiplier, setNewMultiplier] = useState("");
  const [hasChanges, setHasChanges] = useState(false);

  const historyFilterStorageKey = user?.id
    ? `admin.rateLimitMultipliers.historyFilters.${user.id}`
    : null;
  const isStringValue = (v: unknown): v is string => typeof v === "string";
  const [historyRoleFilter, setHistoryRoleFilter] = usePersistentState<string>(
    historyFilterStorageKey ? `${historyFilterStorageKey}.role` : null,
    "",
    isStringValue,
  );
  const [historyUserSearch, setHistoryUserSearch] = usePersistentState<string>(
    historyFilterStorageKey ? `${historyFilterStorageKey}.user` : null,
    "",
    isStringValue,
  );
  const [historyDateFrom, setHistoryDateFrom] = usePersistentState<string>(
    historyFilterStorageKey ? `${historyFilterStorageKey}.from` : null,
    "",
    isStringValue,
  );
  const [historyDateTo, setHistoryDateTo] = usePersistentState<string>(
    historyFilterStorageKey ? `${historyFilterStorageKey}.to` : null,
    "",
    isStringValue,
  );
  const [debouncedHistoryUserSearch, setDebouncedHistoryUserSearch] = useState<string>("");
  const [selectedHistoryDatePreset, setSelectedHistoryDatePreset] = useState<
    "today" | "last7" | "last30" | "thisMonth" | null
  >(null);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedHistoryUserSearch(historyUserSearch.trim()), 300);
    return () => clearTimeout(t);
  }, [historyUserSearch]);

  const historyFiltersActive =
    historyRoleFilter !== "" ||
    historyUserSearch.trim() !== "" ||
    historyDateFrom !== "" ||
    historyDateTo !== "";

  const resetHistoryFilters = () => {
    setHistoryRoleFilter("");
    setHistoryUserSearch("");
    setHistoryDateFrom("");
    setHistoryDateTo("");
    setSelectedHistoryDatePreset(null);
  };

  const dateRangeError =
    historyDateFrom && historyDateTo && historyDateFrom > historyDateTo
      ? "Start date must be before end date"
      : null;

  const formatLocalDate = (d: Date): string => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  };

  type HistoryDatePreset = {
    id: "today" | "last7" | "last30" | "thisMonth";
    label: string;
    compute: () => { from: string; to: string };
  };

  const historyDatePresets: HistoryDatePreset[] = [
    {
      id: "today",
      label: "Today",
      compute: () => {
        const today = formatLocalDate(new Date());
        return { from: today, to: today };
      },
    },
    {
      id: "last7",
      label: "Last 7 days",
      compute: () => {
        const to = new Date();
        const from = new Date();
        from.setDate(from.getDate() - 6);
        return { from: formatLocalDate(from), to: formatLocalDate(to) };
      },
    },
    {
      id: "last30",
      label: "Last 30 days",
      compute: () => {
        const to = new Date();
        const from = new Date();
        from.setDate(from.getDate() - 29);
        return { from: formatLocalDate(from), to: formatLocalDate(to) };
      },
    },
    {
      id: "thisMonth",
      label: "This month",
      compute: () => {
        const now = new Date();
        const from = new Date(now.getFullYear(), now.getMonth(), 1);
        return { from: formatLocalDate(from), to: formatLocalDate(now) };
      },
    },
  ];

  const activeHistoryDatePreset = selectedHistoryDatePreset;

  const applyHistoryDatePreset = (preset: HistoryDatePreset) => {
    const { from, to } = preset.compute();
    setHistoryDateFrom(from);
    setHistoryDateTo(to);
    setSelectedHistoryDatePreset(preset.id);
  };

  const handleHistoryDateFromChange = (value: string) => {
    setHistoryDateFrom(value);
    setSelectedHistoryDatePreset(null);
  };

  const handleHistoryDateToChange = (value: string) => {
    setHistoryDateTo(value);
    setSelectedHistoryDatePreset(null);
  };

  const { data, isLoading } = useQuery<MultipliersResponse>({
    queryKey: ["/api/admin/rate-limit-multipliers"],
    queryFn: async () => {
      const res = await fetch("/api/admin/rate-limit-multipliers", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch multipliers");
      return res.json();
    },
    enabled: !!user && (user.role === "ceo" || user.role === "team_lead"),
    refetchInterval: hasChanges ? false : 15_000,
  });

  type MultiplierHistoryEntry = {
    id: string;
    settingKey: string;
    scope: string | null;
    changedBy: string | null;
    changedByName: string | null;
    changedByEmail: string | null;
    oldValues: { multiplier?: number | null } | null;
    newValues: { multiplier?: number | null; reset?: boolean } | null;
    changedAt: string;
  };

  const dateFromIso = historyDateFrom
    ? new Date(`${historyDateFrom}T00:00:00`).toISOString()
    : "";
  const dateToIso = historyDateTo
    ? new Date(`${historyDateTo}T23:59:59.999`).toISOString()
    : "";

  const { data: historyData } = useQuery<{ history: MultiplierHistoryEntry[] }>({
    queryKey: [
      "/api/admin/rate-limit-multipliers/history",
      historyRoleFilter,
      debouncedHistoryUserSearch,
      dateFromIso,
      dateToIso,
    ],
    queryFn: async () => {
      const params = new URLSearchParams({ limit: "25" });
      if (historyRoleFilter) params.set("role", historyRoleFilter);
      if (debouncedHistoryUserSearch) params.set("changedBy", debouncedHistoryUserSearch);
      if (dateFromIso) params.set("changedAfter", dateFromIso);
      if (dateToIso) params.set("changedBefore", dateToIso);
      const res = await fetch(`/api/admin/rate-limit-multipliers/history?${params.toString()}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch multiplier history");
      return res.json();
    },
    enabled:
      !!user && (user.role === "ceo" || user.role === "team_lead") && !dateRangeError,
    refetchInterval: 30_000,
  });
  const multiplierHistory = historyData?.history ?? [];

  const historyRoleOptions = Array.from(
    new Set([
      ...Object.keys(data?.defaults ?? {}),
      ...Object.keys(editValues),
      ...multiplierHistory.map((e) => e.scope).filter((s): s is string => !!s),
    ]),
  ).sort();

  useEffect(() => {
    if (data?.effective && !hasChanges) {
      const values: Record<string, string> = {};
      for (const [role, val] of Object.entries(data.effective)) {
        values[role] = String(val);
      }
      setEditValues(values);
    }
  }, [data, hasChanges]);

  const saveMutation = useMutation({
    meta: { silent: true },
    mutationFn: async (multipliers: Record<string, number>) => {
      const res = await fetch("/api/admin/rate-limit-multipliers", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ multipliers }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to save");
      }
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/admin/rate-limit-multipliers"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/admin/rate-limit-multipliers/history"] }); // fire-and-forget: cache refresh only
      setHasChanges(false);
      toast({ title: "Rate limit multipliers saved" });
    },
    onError: (err: Error) => {
      toast({ title: err.message, variant: "destructive" });
    },
  });

  const resetMutation = useMutation({
    meta: { silent: true },
    mutationFn: async () => {
      const res = await fetch("/api/admin/rate-limit-multipliers/reset", {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to reset");
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/admin/rate-limit-multipliers"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/admin/rate-limit-multipliers/history"] }); // fire-and-forget: cache refresh only
      setHasChanges(false);
      toast({ title: "Multipliers reset to defaults" });
    },
    onError: () => {
      toast({ title: "Failed to reset multipliers", variant: "destructive" });
    },
  });

  const updateValue = (role: string, value: string) => {
    setEditValues((prev) => ({ ...prev, [role]: value }));
    setHasChanges(true);
  };

  const removeRole = (role: string) => {
    setEditValues((prev) => {
      const next = { ...prev };
      delete next[role];
      return next;
    });
    setHasChanges(true);
  };

  const addRole = () => {
    const trimmedRole = newRole.trim().toLowerCase().replace(/\s+/g, "_");
    if (!trimmedRole || !newMultiplier) return;
    const val = parseFloat(newMultiplier);
    if (isNaN(val) || val < 0.1 || val > 100) {
      toast({ title: "Multiplier must be between 0.1 and 100", variant: "destructive" });
      return;
    }
    if (editValues[trimmedRole] !== undefined) {
      toast({ title: "That role already exists", variant: "destructive" });
      return;
    }
    setEditValues((prev) => ({ ...prev, [trimmedRole]: String(val) }));
    setNewRole("");
    setNewMultiplier("");
    setHasChanges(true);
  };

  const invalidRoles = getInvalidMultiplierRoles(editValues);
  const hasInvalidRoles = invalidRoles.length > 0;
  const newMultiplierError =
    newMultiplier.trim() === "" ? null : validateMultiplierString(newMultiplier);

  const handleSave = () => {
    const multipliers: Record<string, number> = {};
    for (const [role, strVal] of Object.entries(editValues)) {
      const err = validateMultiplierString(strVal);
      if (err) {
        toast({ title: `Invalid value for ${ROLE_LABELS[role] || role}: ${err}`, variant: "destructive" });
        return;
      }
      multipliers[role] = parseFloat(strVal);
    }
    saveMutation.mutate(multipliers);
  };

  if (authLoading) {
    return (
      <div className="min-h-[calc(100dvh-var(--nav-height))] flex items-center justify-center">
        <div className="animate-spin w-8 h-8 border-4 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  if (!user || (user.role !== "ceo" && user.role !== "team_lead")) {
    return (
      <div className="min-h-[calc(100dvh-var(--nav-height))] flex flex-col items-center justify-center gap-4">
        <h1 className="text-2xl font-bold text-red-600" data-testid="text-access-denied">Access Denied</h1>
        <p className="text-muted-foreground">Admin access required</p>
        <Link href="/">
          <Button variant="outline" data-testid="button-back-dashboard">
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back to Dashboard
          </Button>
        </Link>
      </div>
    );
  }

  const isDefault = (role: string, value: string): boolean => {
    if (!data?.defaults) return false;
    return data.defaults[role] !== undefined && String(data.defaults[role]) === value;
  };

  return (
    <div className="min-h-[calc(100dvh-var(--nav-height))] bg-surface-warm-1 p-6">
      <div className="max-w-3xl mx-auto">
        <PageHeader
          title="Rate Limit Multipliers"
          icon={Shield}
          backHref="/"
          className="mb-6"
          actions={
            data?.lastEdited ? (
              <LastEditedBadge
                info={data.lastEdited as LastEditedInfo}
                testId="text-last-edited-multipliers"
              />
            ) : undefined
          }
        />

        <p className="text-muted-foreground mb-6" data-testid="text-description">
          Configure how rate limits scale per user role. A multiplier of 2 means the role gets 2x the base rate limit.
          The default multiplier for unlisted roles is 1x.
        </p>

        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <div className="animate-spin w-8 h-8 border-4 border-primary border-t-transparent rounded-full" />
          </div>
        ) : (
          <div className="space-y-4">
            <div className="bg-card rounded-lg border shadow-sm">
              <div className="p-4 border-b bg-muted/50 rounded-t-lg">
                <div className="hidden md:grid grid-cols-3 gap-4 text-sm font-medium text-muted-foreground">
                  <div>Role</div>
                  <div>Multiplier</div>
                  <div>Status</div>
                </div>
              </div>

              <div className="divide-y">
                {Object.entries(editValues).map(([role, value]) => {
                  const error = validateMultiplierString(value);
                  const savedRoleVal = data?.effective?.[role];
                  const hasSavedVal =
                    typeof savedRoleVal === "number" && !Number.isNaN(savedRoleVal);
                  const typedNum = parseFloat(value);
                  const typedDiffersFromSaved =
                    hasSavedVal &&
                    (Number.isNaN(typedNum) || typedNum !== savedRoleVal);
                  const showSavedHint = hasSavedVal && typedDiffersFromSaved;
                  const showRevertButton = !!error && hasSavedVal;
                  return (
                  <div key={role} className="p-4 grid grid-cols-1 md:grid-cols-3 gap-3 md:gap-4 md:items-center" data-testid={`row-multiplier-${role}`}>
                    <div className="font-medium text-foreground" data-testid={`text-role-${role}`}>
                      {ROLE_LABELS[role] || role}
                    </div>
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center gap-2">
                        <Input
                          type="number"
                          step="0.1"
                          min="0.1"
                          max="100"
                          value={value}
                          onChange={(e) => updateValue(role, e.target.value)}
                          className={`w-24 ${error ? "border-red-500 focus-visible:ring-red-500" : ""}`}
                          aria-invalid={error ? "true" : undefined}
                          aria-describedby={error ? `error-multiplier-${role}` : undefined}
                          data-testid={`input-multiplier-${role}`}
                        />
                        <span className="text-sm text-muted-foreground">x</span>
                        {error && typedDiffersFromSaved && (
                          <span
                            className="text-[10px] font-semibold uppercase tracking-wide text-red-700 bg-red-100 border border-red-200 px-1.5 py-0.5 rounded"
                            data-testid={`chip-invalid-${role}`}
                            title="Value is invalid"
                          >
                            Invalid
                          </span>
                        )}
                        {!error && typedDiffersFromSaved && (
                          <span
                            className="text-[10px] font-semibold uppercase tracking-wide text-amber-800 bg-amber-100 border border-amber-200 px-1.5 py-0.5 rounded"
                            data-testid={`chip-unsaved-${role}`}
                            title="Unsaved change"
                          >
                            Unsaved
                          </span>
                        )}
                      </div>
                      {error && (
                        <p
                          id={`error-multiplier-${role}`}
                          className="text-xs text-red-600"
                          data-testid={`error-multiplier-${role}`}
                        >
                          {error}. Preview is using last valid value.
                        </p>
                      )}
                      {showSavedHint && (
                        <p
                          className="text-[11px] text-muted-foreground flex items-center gap-1"
                          data-testid={`hint-saved-multiplier-${role}`}
                        >
                          <span>Saved: <span className="font-medium text-foreground">{savedRoleVal}x</span></span>
                          {showRevertButton && (
                            <button
                              type="button"
                              onClick={() => updateValue(role, String(savedRoleVal))}
                              className="text-primary-ink hover:underline"
                              data-testid={`button-revert-saved-${role}`}
                            >
                              Revert to saved
                            </button>
                          )}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      {isDefault(role, value) ? (
                        <span className="text-xs text-muted-foreground bg-muted px-2 py-1 rounded" data-testid={`badge-default-${role}`}>Default</span>
                      ) : (
                        <span className="text-xs text-green-600 bg-green-50 px-2 py-1 rounded" data-testid={`badge-custom-${role}`}>Custom</span>
                      )}
                      {!data?.defaults[role] && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => removeRole(role)}
                          data-testid={`button-remove-${role}`}
                        >
                          <Trash2 className="w-4 h-4 text-red-500" />
                        </Button>
                      )}
                    </div>
                  </div>
                  );
                })}
              </div>
            </div>

            <div className="bg-card rounded-lg border shadow-sm p-4" data-testid="section-add-role">
              <h3 className="text-sm font-medium text-foreground mb-3">Add Custom Role Multiplier</h3>
              <div className="flex items-start gap-3">
                <Input
                  placeholder="Role name (e.g. intern)"
                  value={newRole}
                  onChange={(e) => setNewRole(e.target.value)}
                  className="flex-1"
                  data-testid="input-new-role"
                />
                <div className="flex flex-col gap-1">
                  <Input
                    type="number"
                    step="0.1"
                    min="0.1"
                    max="100"
                    placeholder="1.0"
                    value={newMultiplier}
                    onChange={(e) => setNewMultiplier(e.target.value)}
                    className={`w-24 ${newMultiplierError ? "border-red-500 focus-visible:ring-red-500" : ""}`}
                    aria-invalid={newMultiplierError ? "true" : undefined}
                    aria-describedby={newMultiplierError ? "error-new-multiplier" : undefined}
                    data-testid="input-new-multiplier"
                  />
                  {newMultiplierError && (
                    <p
                      id="error-new-multiplier"
                      className="text-xs text-red-600"
                      data-testid="error-new-multiplier"
                    >
                      {newMultiplierError}
                    </p>
                  )}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={addRole}
                  disabled={!newRole.trim() || !newMultiplier || !!newMultiplierError}
                  data-testid="button-add-role"
                >
                  <Plus className="w-4 h-4 mr-1" />
                  Add
                </Button>
              </div>
            </div>

            <div className="flex items-center gap-3 pt-2">
              <Button
                onClick={handleSave}
                disabled={!hasChanges || saveMutation.isPending || hasInvalidRoles}
                title={hasInvalidRoles ? "Fix invalid multipliers before saving" : undefined}
                data-testid="button-save-multipliers"
              >
                <Save className="w-4 h-4 mr-2" />
                {saveMutation.isPending ? "Saving..." : "Save Changes"}
              </Button>
            </div>

            {data && (
              <EffectiveRateLimitsPreviewTable
                savedLimits={
                  data.effectiveLimits ??
                  buildFallbackEffectiveLimits(data.effective, data.limiterConfigs)
                }
                editValues={editValues}
                hasPendingEdits={hasChanges}
                invalidRoles={invalidRoles}
              />
            )}

            {/* Task #4357: reset wipes every tuned multiplier in one shot, so
                it moved out of the Save row into a DangerZone with its own
                confirm. History below remains the audit trail. */}
            <DangerZone
              title="Reset all multipliers"
              description="Removes every custom role multiplier and any added roles, returning all rate limits to the built-in defaults immediately."
              testId="danger-zone-rate-limit-reset"
            >
              <Button
                variant="outline"
                onClick={() => setConfirmResetOpen(true)}
                disabled={resetMutation.isPending}
                data-testid="button-reset-defaults"
              >
                <RotateCcw className="w-4 h-4 mr-2" />
                {resetMutation.isPending ? "Resetting..." : "Reset to Defaults"}
              </Button>
            </DangerZone>

            <AlertDialog open={confirmResetOpen} onOpenChange={setConfirmResetOpen}>
              <AlertDialogContent data-testid="dialog-confirm-reset-defaults">
                <AlertDialogHeader>
                  <AlertDialogTitle>Reset all rate-limit multipliers?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Every custom multiplier and added role is removed and the
                    built-in defaults take effect immediately for all users.
                    Previous values remain visible in Recent Changes, but they
                    are not restored automatically.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel data-testid="button-reset-defaults-abort">
                    Cancel
                  </AlertDialogCancel>
                  <AlertDialogAction
                    data-testid="button-reset-defaults-confirm"
                    onClick={() => {
                      setConfirmResetOpen(false);
                      resetMutation.mutate();
                    }}
                  >
                    Reset to defaults
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>

            <div className="bg-card rounded-lg border shadow-sm" data-testid="section-multiplier-history">
              <div className="p-4 border-b bg-muted/50 rounded-t-lg flex items-center gap-2 flex-wrap">
                <History className="w-4 h-4 text-muted-foreground" />
                <h3 className="text-sm font-semibold text-foreground">Recent Changes</h3>
                <div className="ml-auto flex items-center gap-2 flex-wrap">
                  <div className="flex items-center gap-1 flex-wrap" data-testid="filter-history-date-range">
                    <Input
                      type="date"
                      value={historyDateFrom}
                      onChange={(e) => handleHistoryDateFromChange(e.target.value)}
                      max={historyDateTo || undefined}
                      className="h-7 text-[11px] w-36"
                      aria-label="Filter from date"
                      data-testid="input-history-date-from"
                    />
                    <span className="text-[11px] text-muted-foreground">–</span>
                    <Input
                      type="date"
                      value={historyDateTo}
                      onChange={(e) => handleHistoryDateToChange(e.target.value)}
                      min={historyDateFrom || undefined}
                      className="h-7 text-[11px] w-36"
                      aria-label="Filter to date"
                      data-testid="input-history-date-to"
                    />
                    <div
                      className="flex items-center gap-1 flex-wrap"
                      data-testid="filter-history-date-presets"
                    >
                      {historyDatePresets.map((preset) => {
                        const isActive = activeHistoryDatePreset === preset.id;
                        return (
                          <button
                            key={preset.id}
                            type="button"
                            onClick={() => applyHistoryDatePreset(preset)}
                            className={`text-[11px] px-2 py-0.5 rounded border ${
                              isActive
                                ? "bg-primary text-primary-foreground border-primary"
                                : "bg-card text-muted-foreground border-border hover:bg-muted/50"
                            }`}
                            aria-pressed={isActive}
                            data-testid={`button-history-date-preset-${preset.id}`}
                          >
                            {preset.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <div className="relative flex items-center">
                    <Input
                      type="text"
                      value={historyUserSearch}
                      onChange={(e) => setHistoryUserSearch(e.target.value)}
                      placeholder="Search by name or email"
                      className="h-7 text-[11px] w-48 pr-6"
                      data-testid="input-history-user-search"
                    />
                    {historyUserSearch && (
                      <button
                        type="button"
                        onClick={() => setHistoryUserSearch("")}
                        className="absolute right-1.5 text-muted-foreground hover:text-muted-foreground text-xs"
                        aria-label="Clear user search"
                        data-testid="button-history-user-search-clear"
                      >
                        ×
                      </button>
                    )}
                  </div>
                <div className="flex items-center gap-1 flex-wrap" data-testid="filter-multiplier-history-role">
                  <button
                    type="button"
                    onClick={() => setHistoryRoleFilter("")}
                    className={`text-[11px] px-2 py-0.5 rounded border ${
                      historyRoleFilter === ""
                        ? "bg-primary text-primary-foreground border-primary"
                        : "bg-card text-muted-foreground border-border hover:bg-muted/50"
                    }`}
                    data-testid="button-history-role-all"
                  >
                    All roles
                  </button>
                  {historyRoleOptions.map((role) => (
                    <button
                      key={role}
                      type="button"
                      onClick={() => setHistoryRoleFilter(role)}
                      className={`text-[11px] px-2 py-0.5 rounded border ${
                        historyRoleFilter === role
                          ? "bg-primary text-primary-foreground border-primary"
                          : "bg-card text-muted-foreground border-border hover:bg-muted/50"
                      }`}
                      data-testid={`button-history-role-${role}`}
                    >
                      {ROLE_LABELS[role] || role}
                    </button>
                  ))}
                </div>
                {historyFiltersActive && (
                  <button
                    type="button"
                    onClick={resetHistoryFilters}
                    className="inline-flex items-center text-[11px] px-2 py-0.5 rounded border border-border bg-card text-muted-foreground hover:bg-muted/50"
                    data-testid="button-history-reset-filters"
                    title="Clear all filters"
                  >
                    <X className="w-3 h-3 mr-0.5" />
                    Reset filters
                  </button>
                )}
                </div>
              </div>
              {dateRangeError && (
                <div
                  className="px-4 py-2 text-[11px] text-red-700 bg-red-50 border-b border-red-100"
                  data-testid="text-history-date-range-error"
                >
                  {dateRangeError}
                </div>
              )}
              <div className="p-4">
                {multiplierHistory.length === 0 ? (
                  <div className="text-xs text-muted-foreground" data-testid="text-multiplier-history-empty">
                    {(() => {
                      const parts: string[] = [];
                      if (historyRoleFilter) parts.push(`role ${ROLE_LABELS[historyRoleFilter] || historyRoleFilter}`);
                      if (debouncedHistoryUserSearch) parts.push(`user "${debouncedHistoryUserSearch}"`);
                      if (historyDateFrom || historyDateTo) {
                        parts.push(
                          `dates ${historyDateFrom || "…"} → ${historyDateTo || "…"}`,
                        );
                      }
                      return parts.length > 0
                        ? `No changes recorded for ${parts.join(" and ")} yet.`
                        : "No changes recorded yet.";
                    })()}
                  </div>
                ) : (
                  <div className="space-y-1.5 max-h-64 overflow-y-auto">
                    {multiplierHistory.map((entry) => {
                      const who = formatEditorAttribution(entry);
                      const role = entry.scope ?? "—";
                      const oldV = entry.oldValues?.multiplier;
                      const newV = entry.newValues?.multiplier;
                      const isReset = entry.newValues?.reset === true;
                      const fmt = (v: number | null | undefined) =>
                        v === null || v === undefined ? "—" : `${v}x`;
                      return (
                        <div
                          key={entry.id}
                          className="bg-muted/50 rounded px-2.5 py-1.5 text-[11px]"
                          data-testid={`multiplier-history-${entry.id}`}
                        >
                          <div className="flex items-center justify-between mb-0.5">
                            <div className="flex items-center gap-1.5">
                              <span className="text-[10px] font-medium text-foreground bg-muted px-1.5 py-0.5 rounded">
                                {ROLE_LABELS[role] || role}
                              </span>
                              <span className="font-medium text-foreground" data-testid={`text-multiplier-history-user-${entry.id}`}>
                                {who}
                              </span>
                            </div>
                            <span className="text-muted-foreground" data-testid={`text-multiplier-history-time-${entry.id}`}>
                              {new Date(entry.changedAt).toLocaleString()}
                            </span>
                          </div>
                          <div className="flex items-center gap-1 text-muted-foreground">
                            <span className="text-muted-foreground">Multiplier:</span>
                            <span className="text-foreground line-through" data-testid={`text-multiplier-history-old-${entry.id}`}>
                              {fmt(oldV)}
                            </span>
                            <ArrowRight className="w-2.5 h-2.5 text-muted-foreground" />
                            <span className="font-semibold text-foreground" data-testid={`text-multiplier-history-new-${entry.id}`}>
                              {isReset ? `default${newV !== null && newV !== undefined ? ` (${newV}x)` : ""}` : fmt(newV)}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mt-4" data-testid="section-info">
              <h3 className="text-sm font-semibold text-blue-800 mb-2">How multipliers work</h3>
              <p className="text-sm text-blue-700 mb-2">
                Each API endpoint has a base rate limit. The multiplier scales that limit for users with the given role.
              </p>
              <div className="text-sm text-blue-700 space-y-1">
                <div>Example with base limit of 20 requests/15min:</div>
                {Object.entries(editValues).map(([role, val]) => {
                  const num = parseFloat(val);
                  const effective = isNaN(num) ? "?" : Math.ceil(20 * num);
                  return (
                    <div key={role} className="pl-4" data-testid={`text-example-${role}`}>
                      {ROLE_LABELS[role] || role}: {val}x = {effective} requests
                    </div>
                  );
                })}
                <div className="pl-4">Other roles: 1x = 20 requests</div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
