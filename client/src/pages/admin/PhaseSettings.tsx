import { useAuth } from "@/hooks/use-auth";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { Link } from "wouter";
import { ArrowLeft, Save, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { PageHeader } from "@/components/admin/PageHeader";

type PhaseSetting = {
  phase: string;
  actions: string[];
  isCustom: boolean;
};

const PHASE_DESCRIPTIONS: Record<string, string> = {
  Peak: "Top 20-25% demand - maximize capture, spend aggressively",
  Hold: "Upper-middle stable demand - maintain momentum, optimize systems",
  Taper: "Declining from peak - prepare for softer periods, tighten efficiency",
  Soft: "Bottom 20-25% demand - focus on fundamentals, reduce waste",
  Rebuild: "Rising from soft - invest in growth, build infrastructure",
};

// Phase chips mirror the client report's marketing-calendar phase palette.
// Peak rides the report token (crimson is the DECK's idiom — the OS re-primaried
// to Liberty Blue 2026-08, so the admin chip references --report-phase-peak
// instead of hardcoding the hex); the other four stay validated literals
// matching the deck's categorical set.
const PHASE_COLORS: Record<string, string> = {
  Peak: "bg-[var(--report-phase-peak)]",
  Hold: "bg-[#5B7B9A]",
  Taper: "bg-[#D4A574]",
  Soft: "bg-[#9CA3AF]",
  Rebuild: "bg-[#6B8E4E]",
};

export default function PhaseSettings() {
  const { user, isLoading: authLoading } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  
  const [editingPhase, setEditingPhase] = useState<string | null>(null);
  const [editActions, setEditActions] = useState<string[]>([]);

  const { data: settings, isLoading } = useQuery<PhaseSetting[]>({
    queryKey: ["/api/phase-settings"],
    queryFn: async () => {
      const res = await fetch("/api/phase-settings", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch settings");
      return res.json();
    },
    enabled: !!user && (user.role === "ceo" || user.role === "admin"),
  });

  const saveMutation = useMutation({
    meta: { silent: true },
    mutationFn: async ({ phase, actions }: { phase: string; actions: string[] }) => {
      const res = await fetch("/api/admin/phase-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ phase, actions }),
      });
      if (!res.ok) throw new Error("Failed to save");
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/phase-settings"] }); // fire-and-forget: cache refresh only
      setEditingPhase(null);
      setEditActions([]);
      toast({ title: "Phase actions saved" });
    },
    onError: () => {
      toast({ title: "Failed to save", variant: "destructive" });
    },
  });

  if (authLoading) {
    return (
      <div className="min-h-[calc(100dvh-var(--nav-height))] flex items-center justify-center">
        <div className="animate-spin w-8 h-8 border-4 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  if (!user || (user.role !== "ceo" && user.role !== "admin")) {
    return (
      <div className="min-h-[calc(100dvh-var(--nav-height))] flex flex-col items-center justify-center gap-4">
        <h1 className="text-2xl font-bold text-red-600">Access Denied</h1>
        <p className="text-muted-foreground">Admin access required</p>
        <Link href="/">
          <Button variant="outline">
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back to Dashboard
          </Button>
        </Link>
      </div>
    );
  }

  const startEditing = (phase: string, currentActions: string[]) => {
    setEditingPhase(phase);
    setEditActions([...currentActions]);
  };

  const updateAction = (index: number, value: string) => {
    const newActions = [...editActions];
    newActions[index] = value;
    setEditActions(newActions);
  };

  const addAction = () => {
    setEditActions([...editActions, ""]);
  };

  const removeAction = (index: number) => {
    setEditActions(editActions.filter((_, i) => i !== index));
  };

  const saveEdit = (phase: string) => {
    const filteredActions = editActions.filter(a => a.trim());
    if (filteredActions.length > 0) {
      saveMutation.mutate({ phase, actions: filteredActions });
    }
  };

  const cancelEdit = () => {
    setEditingPhase(null);
    setEditActions([]);
  };

  return (
    <div className="min-h-[calc(100dvh-var(--nav-height))] bg-surface-warm-1 p-6">
      <div className="max-w-4xl mx-auto">
        <PageHeader
          title="Phase Response Settings"
          backHref="/"
          className="mb-6"
        />

        <p className="text-muted-foreground mb-6">
          Configure the response options that appear in the Market Context section for each demand phase.
          To make an option&apos;s label stand out, wrap it in double asterisks — typing **Staffing:** displays
          it as <strong className="font-bold">Staffing:</strong> in the list below and in reports.
        </p>

        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <div className="animate-spin w-8 h-8 border-4 border-primary border-t-transparent rounded-full" />
          </div>
        ) : (
          <div className="space-y-4">
            {settings?.map((setting) => (
              <div
                key={setting.phase}
                className="bg-card rounded-lg border border-border p-4 shadow-sm"
              >
                <div className="flex items-start gap-4">
                  {/* Task #4661 — deck hue kept as a swatch dot; chip ink now
                      token-based (white-on-pastel failed AA, e.g. 2.2:1 on
                      the Taper tan). */}
                  <div className="flex items-center gap-2 bg-muted text-foreground px-3 py-1 rounded text-sm font-medium">
                    <span
                      aria-hidden="true"
                      className={`w-2.5 h-2.5 rounded-full shrink-0 ${PHASE_COLORS[setting.phase]}`}
                    />
                    {setting.phase}
                  </div>
                  <div className="flex-1">
                    <p className="text-sm text-muted-foreground mb-3">
                      {PHASE_DESCRIPTIONS[setting.phase]}
                    </p>
                    
                    {editingPhase === setting.phase ? (
                      <div className="space-y-3">
                        {editActions.map((action, idx) => (
                          <div key={idx} className="flex items-center gap-2">
                            <Input
                              value={action}
                              onChange={(e) => updateAction(idx, e.target.value)}
                              placeholder={`Action ${idx + 1}`}
                              className="flex-1"
                              data-testid={`input-action-${setting.phase}-${idx}`}
                            />
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => removeAction(idx)}
                              disabled={editActions.length <= 1}
                              data-testid={`button-remove-action-${idx}`}
                            >
                              <Trash2 className="w-4 h-4 text-red-500" />
                            </Button>
                          </div>
                        ))}
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={addAction}
                          data-testid={`button-add-action-${setting.phase}`}
                        >
                          <Plus className="w-4 h-4 mr-1" />
                          Add Action
                        </Button>
                        <div className="flex gap-2 pt-2">
                          <Button
                            size="sm"
                            onClick={() => saveEdit(setting.phase)}
                            disabled={saveMutation.isPending}
                            data-testid={`button-save-${setting.phase}`}
                          >
                            <Save className="w-4 h-4 mr-1" />
                            Save
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={cancelEdit}
                            data-testid={`button-cancel-${setting.phase}`}
                          >
                            Cancel
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div>
                        <div className="space-y-2 mb-3">
                          {setting.actions.map((action, idx) => {
                            const parts = action.split(/\*\*(.*?)\*\*/g);
                            // Decorative list rail (neutral chrome, not a status
                            // signal) — exempt from the --status-* token sweep
                            // (Task #4492).
                            return (
                              <div key={idx} className="text-sm text-foreground pl-3 border-l-2 border-border">
                                {parts.map((part, j) => 
                                  j % 2 === 1 
                                    ? <strong key={j} className="font-bold">{part}</strong>
                                    : <span key={j}>{part}</span>
                                )}
                              </div>
                            );
                          })}
                        </div>
                        <div className="flex items-center gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => startEditing(setting.phase, setting.actions)}
                            data-testid={`button-edit-${setting.phase}`}
                          >
                            Edit Actions
                          </Button>
                          {setting.isCustom && (
                            <span className="text-xs text-green-600 bg-green-50 px-2 py-1 rounded">
                              Customized
                            </span>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
