// Rate Limits admin — per-category warning threshold editor.
// Extracted VERBATIM from the former 5.9k-line RateLimitUsers.tsx monolith
// (house aggregator pattern, cf. ClickUpModule / Task #3787; this split:
// F11C / Task #4159). The page composition root is
// client/src/pages/admin/RateLimitUsers.tsx — new rate-limit admin UI
// belongs here (or in a new sibling module), never in the aggregator.

import { useAuth } from "@/hooks/use-auth";
import { formatEditorAttribution } from "@/lib/auditEditorFormat";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Sliders, Check, History, ArrowRight } from "lucide-react";
import { useEffect, useState } from "react";
import { useTabVisibility } from "@/hooks/use-tab-visibility";
import { LastEditedBadge, type LastEditedInfo } from "@/components/LastEditedBadge";
import { getCategoryColor } from "./shared";

export function WarningPercentsEditor() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const canView = !!user && (user.role === "team_lead" || user.role === "ceo");
  const isTabVisible = useTabVisibility();
  const { data, isLoading, error: loadError } = useQuery<{ percents: Record<string, number>; lastEdited: Record<string, LastEditedInfo | null> }>({
    queryKey: ["/api/health/rate-limits/warning-percents"],
    queryFn: async () => {
      const res = await fetch("/api/health/rate-limits/warning-percents", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch warning percents");
      return res.json();
    },
    enabled: canView,
    refetchInterval: isTabVisible ? 60000 : false,
    refetchIntervalInBackground: false,
  });
  const percents = data?.percents;

  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [lastServer, setLastServer] = useState<Record<string, number>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [savedAt, setSavedAt] = useState<Record<string, number>>({});

  useEffect(() => {
    if (!percents) return;
    setDrafts((prev) => {
      const next: Record<string, string> = { ...prev };
      for (const [cat, val] of Object.entries(percents)) {
        const serverStr = String(val);
        const prevDraft = next[cat];
        const prevServer = lastServer[cat];
        // Sync to server value if not actively dirty (i.e., draft still matches the last known server value, or no draft yet).
        if (prevDraft === undefined || prevServer === undefined || prevDraft === String(prevServer)) {
          next[cat] = serverStr;
        }
      }
      return next;
    });
    setLastServer(percents);
    // `lastServer` converges to `percents` on the first pass, so the extra
    // dependency triggers at most one idempotent re-run (no loop).
  }, [percents, lastServer]);

  const saveMutation = useMutation({
    meta: { silent: true },
    mutationFn: async ({ category, percent }: { category: string; percent: number }) => {
      const res = await fetch("/api/health/rate-limits/warning-percents", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ category, percent }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to save");
      return json;
    },
    onSuccess: (_data, vars) => {
      setErrors((e) => ({ ...e, [vars.category]: "" }));
      setSavedAt((s) => ({ ...s, [vars.category]: Date.now() }));
      void queryClient.invalidateQueries({ queryKey: ["/api/health/rate-limits/warning-percents"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/health/rate-limits/warning-percents/history"] }); // fire-and-forget: cache refresh only
    },
    onError: (err: Error, vars) => {
      setErrors((e) => ({ ...e, [vars.category]: err.message }));
    },
  });

  type WarningPercentHistoryEntry = {
    id: string;
    settingKey: string;
    scope: string | null;
    changedBy: string | null;
    changedByName: string | null;
    changedByEmail: string | null;
    oldValues: { percent?: number | null } | null;
    newValues: { percent?: number | null } | null;
    changedAt: string;
  };

  const { data: historyData } = useQuery<{ history: WarningPercentHistoryEntry[] }>({
    queryKey: ["/api/health/rate-limits/warning-percents/history"],
    queryFn: async () => {
      const res = await fetch("/api/health/rate-limits/warning-percents/history?limit=25", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch warning percent history");
      return res.json();
    },
    enabled: canView,
    refetchInterval: 60_000,
  });
  const history = historyData?.history ?? [];

  const handleSave = (category: string) => {
    const raw = drafts[category];
    const num = Number(raw);
    if (!Number.isFinite(num) || num < 1 || num > 100 || !Number.isInteger(num)) {
      setErrors((e) => ({ ...e, [category]: "Must be 1–100" }));
      return;
    }
    saveMutation.mutate({ category, percent: num });
  };

  const categories = percents ? Object.keys(percents).sort() : [];

  return (
    <Card data-testid="card-warning-percents">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Sliders className="w-4 h-4" />
          Warning Thresholds (per category)
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Trigger an alert when a user reaches this percent of their limit. Changes apply immediately to new alerts.
        </p>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="text-sm text-muted-foreground py-4">Loading thresholds…</div>
        ) : loadError ? (
          <div
            className="text-sm text-red-600 dark:text-red-400 py-4"
            data-testid="text-warning-percents-load-error"
          >
            Failed to load warning thresholds: {(loadError as Error).message}
          </div>
        ) : categories.length === 0 ? (
          <div className="text-sm text-muted-foreground py-4" data-testid="text-no-warning-percents">
            No categories configured yet.
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3" data-testid="list-warning-percents">
            {categories.map((cat) => {
              const current = percents?.[cat] ?? 80;
              const draft = drafts[cat] ?? String(current);
              const dirty = String(current) !== draft;
              const err = errors[cat];
              const recentlySaved = savedAt[cat] && Date.now() - savedAt[cat] < 3000;
              const isPending =
                saveMutation.isPending && saveMutation.variables?.category === cat;
              return (
                <div
                  key={cat}
                  className="flex items-center gap-2 p-2 rounded border border-primary/10 bg-card"
                  data-testid={`row-warning-percent-${cat}`}
                >
                  <Badge className={`${getCategoryColor(cat)} shrink-0`}>{cat}</Badge>
                  <div className="flex items-center gap-1 flex-1 min-w-0">
                    <Input
                      type="number"
                      min={1}
                      max={100}
                      aria-label={`Warning percent for ${cat}`}
                      value={draft}
                      onChange={(e) =>
                        setDrafts((d) => ({ ...d, [cat]: e.target.value }))
                      }
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleSave(cat);
                      }}
                      className="h-8 w-20 text-sm"
                      data-testid={`input-warning-percent-${cat}`}
                    />
                    <span className="text-xs text-muted-foreground">%</span>
                  </div>
                  <Button
                    size="sm"
                    variant={dirty ? "default" : "outline"}
                    disabled={!dirty || isPending}
                    onClick={() => handleSave(cat)}
                    data-testid={`button-save-warning-percent-${cat}`}
                    className="h-8 text-xs"
                  >
                    {recentlySaved && !dirty ? (
                      <>
                        <Check className="w-3 h-3 mr-1" />
                        Saved
                      </>
                    ) : isPending ? (
                      "Saving…"
                    ) : (
                      "Save"
                    )}
                  </Button>
                  {err && (
                    <span
                      className="text-xs text-red-600 dark:text-red-300 ml-1"
                      data-testid={`text-error-warning-percent-${cat}`}
                    >
                      {err}
                    </span>
                  )}
                  {data?.lastEdited?.[cat] && (
                    <LastEditedBadge
                      info={data.lastEdited[cat]!}
                      testId={`text-last-edited-warning-percent-${cat}`}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}

        <div className="mt-4 border-t pt-3" data-testid="warning-percent-history">
          <div className="flex items-center gap-1.5 mb-2">
            <History className="w-3.5 h-3.5 text-muted-foreground" />
            <h4 className="text-xs font-semibold text-foreground">Recent Threshold Changes</h4>
          </div>
          {history.length === 0 ? (
            <div className="text-xs text-muted-foreground" data-testid="text-warning-percent-history-empty">
              No changes recorded yet.
            </div>
          ) : (
            <div className="space-y-1.5 max-h-48 overflow-y-auto">
              {history.map((entry) => {
                const who = formatEditorAttribution(entry);
                const cat = entry.scope ?? "—";
                const oldV = entry.oldValues?.percent;
                const newV = entry.newValues?.percent;
                return (
                  <div
                    key={entry.id}
                    className="bg-muted/50 rounded px-2.5 py-1.5 text-xs"
                    data-testid={`warning-percent-history-${entry.id}`}
                  >
                    <div className="flex items-center justify-between mb-0.5">
                      <div className="flex items-center gap-1.5">
                        <Badge className={`text-xs px-1.5 py-0 ${getCategoryColor(cat)}`}>{cat}</Badge>
                        <span className="font-medium text-foreground" data-testid={`text-warning-percent-history-user-${entry.id}`}>
                          {who}
                        </span>
                      </div>
                      <span className="text-muted-foreground" data-testid={`text-warning-percent-history-time-${entry.id}`}>
                        {new Date(entry.changedAt).toLocaleString()}
                      </span>
                    </div>
                    <div className="flex items-center gap-1 text-muted-foreground">
                      <span className="text-muted-foreground">Warning at:</span>
                      <span className="text-foreground line-through" data-testid={`text-warning-percent-history-old-${entry.id}`}>
                        {oldV === null || oldV === undefined ? "—" : `${oldV}%`}
                      </span>
                      <ArrowRight className="w-2.5 h-2.5 text-muted-foreground" />
                      <span className="font-semibold text-foreground" data-testid={`text-warning-percent-history-new-${entry.id}`}>
                        {newV === null || newV === undefined ? "—" : `${newV}%`}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
