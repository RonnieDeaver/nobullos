import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { Plus, Save, Trash2, Loader2, CalendarOff, CalendarClock } from "lucide-react";

type Rule = {
  id?: string;
  dayOfWeek: number;
  startTimeLocal: string;
  endTimeLocal: string;
  active: boolean;
};

type Override = {
  id: string;
  dateLocal: string;
  isBlocked: boolean;
  customStartTimeLocal: string | null;
  customEndTimeLocal: string | null;
  reason: string | null;
};

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

interface Props {
  pageId: string;
  timezone: string;
}

export default function AvailabilityEditor({ timezone }: Props) {
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data, isLoading } = useQuery<{ rules: Rule[]; overrides: Override[] }>({
    queryKey: ["/api/booking/me/availability"],
    queryFn: async () => {
      const res = await fetch("/api/booking/me/availability", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load availability");
      return res.json();
    },
  });

  const [rules, setRules] = useState<Rule[]>([]);
  useEffect(() => {
    if (data?.rules) setRules(data.rules);
  }, [data]);

  const grouped = useMemo(() => {
    const m = new Map<number, Rule[]>();
    DAYS.forEach((_, idx) => m.set(idx, []));
    rules.forEach((r) => m.get(r.dayOfWeek)?.push(r));
    return m;
  }, [rules]);

  const saveRules = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("PUT", "/api/booking/me/availability/rules", { rules });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Availability saved" });
      void qc.invalidateQueries({ queryKey: ["/api/booking/me/availability"] }); // fire-and-forget: cache refresh only
    },
    onError: (err: any) => {
      toast({ title: "Failed to save", description: err.message, variant: "destructive" });
    },
  });

  const addWindow = (day: number) => {
    setRules((rs) => [
      ...rs,
      { dayOfWeek: day, startTimeLocal: "09:00", endTimeLocal: "17:00", active: true },
    ]);
  };

  const updateRule = (idx: number, patch: Partial<Rule>) => {
    setRules((rs) => rs.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  };

  const removeRule = (idx: number) => {
    setRules((rs) => rs.filter((_, i) => i !== idx));
  };

  // Overrides --------------------------------------------------------------
  // Two flows are supported:
  //   - "block"  → date is fully unavailable (isBlocked=true, no custom hours)
  //   - "custom" → date has its own start/end hours that replace the weekly rule
  type OverrideMode = "block" | "custom";
  const [newOverride, setNewOverride] = useState<{
    mode: OverrideMode;
    dateLocal: string;
    reason: string;
    customStartTimeLocal: string;
    customEndTimeLocal: string;
  }>({
    mode: "block",
    dateLocal: "",
    reason: "",
    customStartTimeLocal: "09:00",
    customEndTimeLocal: "17:00",
  });

  const addOverride = useMutation({
    mutationFn: async () => {
      if (!newOverride.dateLocal) throw new Error("Pick a date");
      const isCustom = newOverride.mode === "custom";
      if (isCustom) {
        if (!newOverride.customStartTimeLocal || !newOverride.customEndTimeLocal) {
          throw new Error("Pick start and end times");
        }
        if (newOverride.customStartTimeLocal >= newOverride.customEndTimeLocal) {
          throw new Error("End time must be after start time");
        }
      }
      const res = await apiRequest("POST", "/api/booking/me/availability/overrides", {
        dateLocal: newOverride.dateLocal,
        isBlocked: !isCustom,
        customStartTimeLocal: isCustom ? newOverride.customStartTimeLocal : null,
        customEndTimeLocal: isCustom ? newOverride.customEndTimeLocal : null,
        reason: newOverride.reason || null,
      });
      return res.json();
    },
    onSuccess: () => {
      toast({
        title: newOverride.mode === "custom" ? "Custom hours saved" : "Date blocked",
      });
      setNewOverride({
        mode: "block",
        dateLocal: "",
        reason: "",
        customStartTimeLocal: "09:00",
        customEndTimeLocal: "17:00",
      });
      void qc.invalidateQueries({ queryKey: ["/api/booking/me/availability"] }); // fire-and-forget: cache refresh only
    },
    onError: (err: any) => {
      toast({ title: "Failed", description: err.message, variant: "destructive" });
    },
  });

  const removeOverride = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("DELETE", `/api/booking/me/availability/overrides/${id}`);
      return res.json();
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["/api/booking/me/availability"] }); // fire-and-forget: cache refresh only
    },
  });

  return (
    <Card data-testid="card-availability">
      <CardHeader>
        <CardTitle className="text-lg">Weekly Availability</CardTitle>
        <CardDescription>
          Recurring windows when prospects can book. Times shown in {timezone}.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {isLoading ? (
          <div className="text-sm text-muted-foreground">Loading…</div>
        ) : (
          <>
            <div className="space-y-3">
              {DAYS.map((dayLabel, dayIdx) => (
                <div key={dayIdx} className="border rounded p-3" data-testid={`row-day-${dayIdx}`}>
                  <div className="flex items-center justify-between mb-2">
                    <div className="font-medium w-16">{dayLabel}</div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => addWindow(dayIdx)}
                      data-testid={`button-add-window-${dayIdx}`}
                    >
                      <Plus className="w-4 h-4 mr-1" /> Add window
                    </Button>
                  </div>
                  {(grouped.get(dayIdx) || []).length === 0 ? (
                    <div className="text-xs text-muted-foreground italic">Unavailable</div>
                  ) : (
                    <div className="space-y-2">
                      {rules.map((r, idx) =>
                        r.dayOfWeek !== dayIdx ? null : (
                          <div key={idx} className="flex items-center gap-2">
                            <Input
                              type="time"
                              value={r.startTimeLocal}
                              onChange={(e) => updateRule(idx, { startTimeLocal: e.target.value })}
                              className="w-32"
                              data-testid={`input-start-${dayIdx}-${idx}`}
                            />
                            <span className="text-muted-foreground">–</span>
                            <Input
                              type="time"
                              value={r.endTimeLocal}
                              onChange={(e) => updateRule(idx, { endTimeLocal: e.target.value })}
                              className="w-32"
                              data-testid={`input-end-${dayIdx}-${idx}`}
                            />
                            <Switch
                              checked={r.active}
                              onCheckedChange={(v) => updateRule(idx, { active: v })}
                              data-testid={`switch-active-${dayIdx}-${idx}`}
                            />
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              onClick={() => removeRule(idx)}
                              aria-label="Remove time window"
                              data-testid={`button-remove-${dayIdx}-${idx}`}
                            >
                              <Trash2 className="w-4 h-4" />
                            </Button>
                          </div>
                        ),
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>

            <Button
              onClick={() => saveRules.mutate()}
              disabled={saveRules.isPending}
              className="bg-primary hover:bg-primary/90"
              data-testid="button-save-availability"
            >
              {saveRules.isPending ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Save className="w-4 h-4 mr-2" />
              )}
              Save Weekly Schedule
            </Button>

            <div className="border-t pt-4">
              <div className="font-medium mb-2 flex items-center gap-2">
                {newOverride.mode === "custom" ? (
                  <>
                    <CalendarClock className="w-4 h-4" /> Custom hours for a specific date
                  </>
                ) : (
                  <>
                    <CalendarOff className="w-4 h-4" /> Block a specific date
                  </>
                )}
              </div>
              <div className="flex items-center gap-2 mb-3">
                <Button
                  type="button"
                  size="sm"
                  variant={newOverride.mode === "block" ? "default" : "outline"}
                  onClick={() => setNewOverride((p) => ({ ...p, mode: "block" }))}
                  data-testid="button-override-mode-block"
                >
                  Block day
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={newOverride.mode === "custom" ? "default" : "outline"}
                  onClick={() => setNewOverride((p) => ({ ...p, mode: "custom" }))}
                  data-testid="button-override-mode-custom"
                >
                  Custom hours
                </Button>
              </div>
              <div className="flex flex-wrap items-end gap-2">
                <div>
                  <label className="text-xs text-muted-foreground">Date</label>
                  <Input
                    type="date"
                    value={newOverride.dateLocal}
                    onChange={(e) =>
                      setNewOverride((p) => ({ ...p, dateLocal: e.target.value }))
                    }
                    className="w-44"
                    data-testid="input-override-date"
                  />
                </div>
                {newOverride.mode === "custom" && (
                  <>
                    <div>
                      <label className="text-xs text-muted-foreground">Start</label>
                      <Input
                        type="time"
                        value={newOverride.customStartTimeLocal}
                        onChange={(e) =>
                          setNewOverride((p) => ({
                            ...p,
                            customStartTimeLocal: e.target.value,
                          }))
                        }
                        className="w-32"
                        data-testid="input-override-custom-start"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-muted-foreground">End</label>
                      <Input
                        type="time"
                        value={newOverride.customEndTimeLocal}
                        onChange={(e) =>
                          setNewOverride((p) => ({
                            ...p,
                            customEndTimeLocal: e.target.value,
                          }))
                        }
                        className="w-32"
                        data-testid="input-override-custom-end"
                      />
                    </div>
                  </>
                )}
                <div className="flex-1 min-w-[200px]">
                  <label className="text-xs text-muted-foreground">Reason (optional)</label>
                  <Input
                    value={newOverride.reason}
                    onChange={(e) =>
                      setNewOverride((p) => ({ ...p, reason: e.target.value }))
                    }
                    placeholder={
                      newOverride.mode === "custom"
                        ? "Half-day, conference, etc."
                        : "Vacation, holiday, etc."
                    }
                    data-testid="input-override-reason"
                  />
                </div>
                <Button
                  onClick={() => addOverride.mutate()}
                  disabled={addOverride.isPending || !newOverride.dateLocal}
                  data-testid="button-add-override"
                >
                  {newOverride.mode === "custom" ? "Save hours" : "Block"}
                </Button>
              </div>
              <div className="mt-3 space-y-1">
                {(data?.overrides || []).map((o) => (
                  <div
                    key={o.id}
                    className="flex items-center justify-between text-sm border rounded px-3 py-2"
                    data-testid={`row-override-${o.id}`}
                  >
                    <div>
                      <span className="font-medium">{o.dateLocal}</span>
                      {o.isBlocked ? (
                        <span className="text-muted-foreground ml-2">— Blocked</span>
                      ) : o.customStartTimeLocal && o.customEndTimeLocal ? (
                        <span className="text-muted-foreground ml-2">
                          — Custom hours {o.customStartTimeLocal}–{o.customEndTimeLocal}
                        </span>
                      ) : null}
                      {o.reason && (
                        <span className="text-muted-foreground ml-2">· {o.reason}</span>
                      )}
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => removeOverride.mutate(o.id)}
                      aria-label="Remove override"
                      data-testid={`button-remove-override-${o.id}`}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
