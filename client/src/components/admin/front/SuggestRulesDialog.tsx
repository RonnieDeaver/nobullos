import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, ExternalLink, RotateCcw, CheckCircle2, ListTree } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  categoryEffectCopy,
  categoryHeaderCopy,
} from "@/lib/operationalRuleCopy";
import {
  generateRuleSuggestions,
  type RuleSuggestion,
  type SuggestedRulePart,
} from "@/lib/operationalRuleSuggestions";

export type SuggestRulesDialogProps = {
  open: boolean;
  onClose: () => void;
  senderEmail?: string | null;
  subject?: string | null;
  itemId?: string;
  onSaved?: () => void;
};

type CreatedRule = {
  id: string;
  category: SuggestedRulePart["category"];
  value: string;
  label: string | null;
  createdAt: number;
  undone: boolean;
};

type ReAttributedHit = {
  id: string;
  syncEmailId: string | null;
  conversationId: string | null;
  senderEmail: string | null;
  subject: string | null;
  prevReason: string | null;
  originalRuleId: string | null;
  originalRuleLabel: string | null;
  originalRuleValue: string | null;
  frontUrl: string | null;
  createdAt: string;
};

const REATTRIBUTED_PAGE_SIZE = 25;

const CATEGORY_LABELS: Record<SuggestedRulePart["category"], string> = {
  automated_sender_pattern: "Automated sender",
  operational_subject_pattern: "Subject pattern",
};

const UNDO_WINDOW_MS = 30_000;

export function SuggestRulesDialog({
  open,
  onClose,
  senderEmail,
  subject,
  itemId,
  onSaved,
}: SuggestRulesDialogProps) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [, navigate] = useLocation();

  const suggestions = useMemo<RuleSuggestion[]>(
    () => generateRuleSuggestions({ senderEmail, subject }),
    [senderEmail, subject],
  );

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editedRules, setEditedRules] = useState<Record<string, SuggestedRulePart[]>>({});
  const [createdRules, setCreatedRules] = useState<CreatedRule[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [undoingId, setUndoingId] = useState<string | null>(null);
  const [applyToRecent, setApplyToRecent] = useState(true);
  const [applying, setApplying] = useState(false);
  // Task #1927 — re-attributed message drill-down.
  const [reAttributedCount, setReAttributedCount] = useState(0);
  const [reAttribViewRuleId, setReAttribViewRuleId] = useState<string | null>(null);
  const [reAttribItems, setReAttribItems] = useState<ReAttributedHit[]>([]);
  const [reAttribTotal, setReAttribTotal] = useState(0);
  const [reAttribOffset, setReAttribOffset] = useState(0);
  const [reAttribLoading, setReAttribLoading] = useState(false);
  // Task #2104 — preview-only: which unmatched emails the proposed rule
  // would dismiss, grouped by sender with counts, shown before confirm.
  const [preview, setPreview] = useState<{
    total: number;
    bySender: { senderEmail: string; count: number }[];
    invalidPatterns: string[];
  } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  useEffect(() => {
    if (open) {
      setSelectedId(suggestions[0]?.id ?? null);
      const seed: Record<string, SuggestedRulePart[]> = {};
      for (const s of suggestions) seed[s.id] = s.rules.map((r) => ({ ...r }));
      setEditedRules(seed);
      setCreatedRules([]);
      setApplyToRecent(true);
      setReAttributedCount(0);
      setReAttribViewRuleId(null);
      setReAttribItems([]);
      setReAttribTotal(0);
      setReAttribOffset(0);
    }
  }, [open, suggestions]);

  // Tick once per second while there's still an active undo window so the
  // countdown label and the disabled state of the Undo button stay in sync.
  const activeUndoCount = createdRules.filter(
    (r) => !r.undone && now - r.createdAt < UNDO_WINDOW_MS,
  ).length;
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (activeUndoCount === 0) {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      return;
    }
    if (timerRef.current) return;
    timerRef.current = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [activeUndoCount]);

  const selected = suggestions.find((s) => s.id === selectedId) ?? null;
  const selectedRules = selected ? editedRules[selected.id] ?? selected.rules : [];

  // Task #2104 — debounced preview of which unmatched emails the selected
  // proposal would dismiss. Keyed on the trimmed regex parts so editing
  // the pattern re-runs the preview. AI never dismisses on its own — this
  // panel is the gate the operator reviews before confirming.
  const previewKey = JSON.stringify(
    selectedRules
      .map((r) => ({ c: r.category, v: r.value.trim() }))
      .filter((r) => r.v.length > 0),
  );
  useEffect(() => {
    if (!open || createdRules.length > 0) {
      setPreview(null);
      return;
    }
    const parts = selectedRules
      .map((r) => ({ category: r.category, value: r.value.trim() }))
      .filter((r) => r.value.length > 0);
    if (parts.length === 0) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    setPreviewLoading(true);
    const t = setTimeout(async () => {
      try {
        const res = await apiRequest(
          "POST",
          "/api/integrations/front/operational-rules/preview",
          { parts },
        );
        const json = await res.json();
        if (!cancelled) setPreview(json);
      } catch {
        if (!cancelled) setPreview(null);
      } finally {
        if (!cancelled) setPreviewLoading(false);
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, createdRules.length, previewKey]);

  const saveMutation = useMutation({
    meta: { silent: true },
    mutationFn: async (rules: SuggestedRulePart[]) => {
      const created: CreatedRule[] = [];
      for (const r of rules) {
        const res = await apiRequest("POST", "/api/integrations/front/operational-rules", {
          category: r.category,
          value: r.value,
          enabled: true,
          label: r.label ?? null,
          notes: itemId ? `Created from unmatched feed item ${itemId}` : null,
        });
        const json = await res.json();
        created.push({
          id: String(json.id),
          category: r.category,
          value: r.value,
          label: r.label ?? null,
          createdAt: Date.now(),
          undone: false,
        });
      }
      let applyResult: {
        unmatched: { scanned: number; filterRuleHandled: number; matched: number };
        dismissed: { scanned: number; reAttributed: number };
      } | null = null;
      if (applyToRecent) {
        setApplying(true);
        try {
          const res = await apiRequest(
            "POST",
            "/api/integrations/front/operational-rules/apply-to-recent",
            // Task #1893 — pass the freshly created rule ids so the
            // dismissed-cohort sweep targets exactly those rules rather
            // than re-running the full classifier (which would keep
            // returning the already-attributed older rule).
            { maxItems: 500, ruleIds: created.map((r) => r.id) },
          );
          const json = await res.json();
          applyResult = json?.result ?? null;
        } catch (err: any) {
          toast({
            title: "Rule saved, but apply-to-recent failed",
            description: err?.message ?? "Unknown error",
            variant: "destructive",
          });
        } finally {
          setApplying(false);
        }
      }
      return { created, applyResult };
    },
    onSuccess: ({ created, applyResult }) => {
      const baseTitle = created.length === 1 ? "Filter rule created" : "Filter rules created";
      let description =
        created.length === 1
          ? "Matching messages will now be auto-dismissed."
          : `${created.length} rules created. Matching messages will now be auto-dismissed.`;
      if (applyResult) {
        const u = applyResult.unmatched;
        const d = applyResult.dismissed;
        const parts: string[] = [];
        if ((u?.filterRuleHandled ?? 0) > 0) {
          parts.push(
            `filter-handled ${u.filterRuleHandled} of ${u.scanned} recent unmatched`,
          );
        } else if ((u?.scanned ?? 0) > 0) {
          parts.push(`scanned ${u.scanned} recent unmatched — none matched`);
        }
        if ((d?.reAttributed ?? 0) > 0) {
          parts.push(
            `re-attributed ${d.reAttributed} of ${d.scanned} previously dismissed`,
          );
        } else if ((d?.scanned ?? 0) > 0) {
          parts.push(`scanned ${d.scanned} previously dismissed — none re-attributed`);
        }
        if (parts.length > 0) {
          description = `${description} Applied: ${parts.join("; ")}.`;
        }
      }
      toast({ title: baseTitle, description });
      setCreatedRules(created);
      setReAttributedCount(applyResult?.dismissed?.reAttributed ?? 0);
      setNow(Date.now());
      void qc.invalidateQueries({ queryKey: ["/api/integrations/unmatched-feed"], refetchType: "all" }); // fire-and-forget: cache refresh only
      void qc.invalidateQueries({ queryKey: ["/api/integrations/front/operational-rules"] }); // fire-and-forget: cache refresh only
      onSaved?.();
    },
    onError: (err: any) => {
      toast({
        title: "Could not create rule",
        description: err?.message ?? "Unknown error",
        variant: "destructive",
      });
    },
  });

  const undoCreate = async (rule: CreatedRule) => {
    setUndoingId(rule.id);
    try {
      await apiRequest("DELETE", `/api/integrations/front/operational-rules/${rule.id}`);
      setCreatedRules((prev) =>
        prev.map((r) => (r.id === rule.id ? { ...r, undone: true } : r)),
      );
      void qc.invalidateQueries({ queryKey: ["/api/integrations/front/operational-rules"] }); // fire-and-forget: cache refresh only
      void qc.invalidateQueries({ queryKey: ["/api/integrations/unmatched-feed"], refetchType: "all" }); // fire-and-forget: cache refresh only
      toast({ title: "Rule removed" });
    } catch (err: any) {
      toast({
        title: "Undo failed",
        description: err?.message ?? "Unknown error",
        variant: "destructive",
      });
    } finally {
      setUndoingId(null);
    }
  };

  const openRuleInConsole = (rule: CreatedRule) => {
    navigate(`/admin/front?tab=filters#rule-${rule.id}`);
    onClose();
  };

  const loadReAttributed = async (ruleId: string, offset: number) => {
    setReAttribLoading(true);
    try {
      const res = await fetch(
        `/api/integrations/front/operational-rules/${ruleId}/re-attributed?limit=${REATTRIBUTED_PAGE_SIZE}&offset=${offset}`,
        { credentials: "include" },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setReAttribItems(json.items ?? []);
      setReAttribTotal(json.total ?? 0);
      setReAttribOffset(offset);
    } catch (err: any) {
      toast({
        title: "Failed to load re-attributed messages",
        description: err?.message ?? "Unknown error",
        variant: "destructive",
      });
    } finally {
      setReAttribLoading(false);
    }
  };

  const openReAttributedView = (rule: CreatedRule) => {
    setReAttribViewRuleId(rule.id);
    setReAttribItems([]);
    setReAttribTotal(0);
    setReAttribOffset(0);
    void loadReAttributed(rule.id, 0);
  };

  const updateRuleValue = (suggestionId: string, idx: number, value: string) => {
    setEditedRules((prev) => {
      const list = (prev[suggestionId] ?? []).map((r) => ({ ...r }));
      if (list[idx]) list[idx] = { ...list[idx], value };
      return { ...prev, [suggestionId]: list };
    });
  };

  const previewCategory = selectedRules[0]?.category ?? "automated_sender_pattern";
  const inCreatedView = createdRules.length > 0;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !saveMutation.isPending) onClose(); }}>
      <DialogContent className="max-w-lg" data-testid="dialog-suggest-rules">
        <DialogHeader>
          <DialogTitle>
            {inCreatedView
              ? createdRules.length === 1
                ? "Filter rule created"
                : "Filter rules created"
              : "Filter messages like these"}
          </DialogTitle>
          <DialogDescription>
            {inCreatedView
              ? "Review what was saved, open it in the rules console, or undo."
              : "Pick a pattern to auto-dismiss similar messages from triage. You can tweak the regex before saving."}
          </DialogDescription>
        </DialogHeader>

        {inCreatedView ? (
          <div className="space-y-2" data-testid="section-created-rules">
            {createdRules.map((rule) => {
              const elapsed = now - rule.createdAt;
              const remaining = Math.max(0, UNDO_WINDOW_MS - elapsed);
              const undoExpired = remaining <= 0;
              const undoSeconds = Math.ceil(remaining / 1000);
              return (
                <div
                  key={rule.id}
                  className="rounded-md border p-3 space-y-2"
                  data-testid={`created-rule-${rule.id}`}
                >
                  <div className="flex items-start gap-2">
                    <CheckCircle2 className="h-4 w-4 text-green-600 mt-0.5 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-xs text-muted-foreground">
                        {CATEGORY_LABELS[rule.category]}
                      </div>
                      <div
                        className="font-mono text-xs break-all"
                        data-testid={`text-created-rule-value-${rule.id}`}
                        title={rule.value}
                      >
                        {rule.value}
                      </div>
                      {rule.label && (
                        <div className="text-xs text-muted-foreground mt-0.5">
                          {rule.label}
                        </div>
                      )}
                      {rule.undone && (
                        <div className="text-xs text-amber-700 mt-1" data-testid={`text-undone-${rule.id}`}>
                          Removed.
                        </div>
                      )}
                    </div>
                  </div>
                  {!rule.undone && (
                    <div className="flex items-center justify-end gap-2 flex-wrap">
                      {reAttributedCount > 0 && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => openReAttributedView(rule)}
                          data-testid={`button-view-reattributed-${rule.id}`}
                        >
                          <ListTree className="h-3.5 w-3.5 mr-1" />
                          View re-attributed messages
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => openRuleInConsole(rule)}
                        data-testid={`button-open-rule-${rule.id}`}
                      >
                        <ExternalLink className="h-3.5 w-3.5 mr-1" />
                        Open in rules
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-red-600 hover:text-red-700"
                        onClick={() => undoCreate(rule)}
                        disabled={undoExpired || undoingId === rule.id}
                        data-testid={`button-undo-rule-${rule.id}`}
                      >
                        {undoingId === rule.id ? (
                          <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                        ) : (
                          <RotateCcw className="h-3.5 w-3.5 mr-1" />
                        )}
                        {undoExpired
                          ? "Undo expired"
                          : `Undo (${undoSeconds}s)`}
                      </Button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : suggestions.length === 0 ? (
          <div className="text-sm text-muted-foreground p-3 text-center">
            Not enough information on this message to suggest a filter.
          </div>
        ) : (
          <div className="space-y-2">
            {suggestions.map((s) => {
              const isActive = selectedId === s.id;
              const rules = editedRules[s.id] ?? s.rules;
              return (
                <label
                  key={s.id}
                  className={`block rounded-md border p-2.5 cursor-pointer transition-colors ${
                    isActive ? "border-blue-400 bg-blue-50/40" : "hover:bg-gray-50"
                  }`}
                  data-testid={`suggestion-${s.id}`}
                >
                  <div className="flex items-start gap-2">
                    <input
                      type="radio"
                      name="suggestion"
                      checked={isActive}
                      onChange={() => setSelectedId(s.id)}
                      className="mt-1"
                      data-testid={`radio-suggestion-${s.id}`}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium">{s.title}</div>
                      <div className="text-xs text-muted-foreground truncate" title={s.description}>
                        {s.description}
                      </div>
                      {isActive && (
                        <div className="mt-2 space-y-1.5">
                          {rules.map((r, idx) => (
                            <div key={`${s.id}-${idx}`}>
                              <Label className="text-xs text-muted-foreground">
                                {r.category === "operational_subject_pattern"
                                  ? "Subject regex"
                                  : "Sender regex"}
                              </Label>
                              <Input
                                value={r.value}
                                onChange={(e) => updateRuleValue(s.id, idx, e.target.value)}
                                className="font-mono text-xs h-8 mt-0.5"
                                data-testid={`input-suggestion-rule-${s.id}-${idx}`}
                              />
                            </div>
                          ))}
                          <p className="text-xs text-muted-foreground">
                            {categoryHeaderCopy(rules[0]?.category ?? "automated_sender_pattern")}
                          </p>
                        </div>
                      )}
                    </div>
                  </div>
                </label>
              );
            })}

            <div
              className="rounded-md border border-blue-100 bg-blue-50 text-blue-900 text-xs p-2"
              data-testid="text-suggest-effect-preview"
            >
              {categoryEffectCopy(previewCategory)}
            </div>

            <div
              className="rounded-md border p-2 bg-gray-50"
              data-testid="section-rule-affected-preview"
            >
              <div className="text-xs font-medium mb-1 flex items-center gap-1.5">
                {previewLoading && <Loader2 className="h-3 w-3 animate-spin" />}
                <span data-testid="text-affected-summary">
                  {previewLoading
                    ? "Checking which emails this would affect…"
                    : preview
                      ? `This rule would dismiss ${preview.total} unmatched ${preview.total === 1 ? "email" : "emails"}`
                      : "Adjust the pattern to preview affected emails"}
                </span>
              </div>
              {preview && preview.invalidPatterns.length > 0 && (
                <div className="text-xs text-red-600" data-testid="text-affected-invalid">
                  Invalid pattern — fix the regex to preview affected emails.
                </div>
              )}
              {preview && preview.total > 0 && (
                <div className="max-h-40 overflow-auto divide-y" data-testid="list-affected-senders">
                  {preview.bySender.map((s) => (
                    <div
                      key={s.senderEmail}
                      className="flex items-center justify-between py-1 text-xs"
                      data-testid={`affected-sender-${s.senderEmail}`}
                    >
                      <span className="font-mono truncate mr-2" title={s.senderEmail}>
                        {s.senderEmail}
                      </span>
                      <Badge variant="secondary" data-testid={`affected-count-${s.senderEmail}`}>
                        {s.count}
                      </Badge>
                    </div>
                  ))}
                </div>
              )}
              {preview && preview.total === 0 && preview.invalidPatterns.length === 0 && (
                <div className="text-xs text-muted-foreground" data-testid="text-affected-none">
                  No current unmatched emails match this pattern.
                </div>
              )}
            </div>
          </div>
        )}

        {!inCreatedView && suggestions.length > 0 && (
          <div className="flex items-start gap-2 pt-1">
            <Checkbox
              id="apply-to-recent"
              checked={applyToRecent}
              onCheckedChange={(v) => setApplyToRecent(v === true)}
              disabled={saveMutation.isPending}
              data-testid="checkbox-apply-to-recent"
            />
            <Label
              htmlFor="apply-to-recent"
              className="text-xs font-normal leading-snug cursor-pointer"
            >
              Apply this rule to recent messages now
              <span className="block text-xs text-muted-foreground">
                Sweeps the last 500 unmatched (auto-dismissing matches) and the last
                500 already-dismissed messages (re-attributing matches to this rule).
              </span>
            </Label>
          </div>
        )}

        <DialogFooter>
          {inCreatedView ? (
            <Button
              onClick={onClose}
              data-testid="button-suggest-done"
            >
              Done
            </Button>
          ) : (
            <>
              <Button
                variant="outline"
                onClick={onClose}
                disabled={saveMutation.isPending}
                data-testid="button-suggest-cancel"
              >
                Cancel
              </Button>
              <Button
                onClick={() => {
                  if (!selected) return;
                  const rules = (editedRules[selected.id] ?? selected.rules).filter(
                    (r) => r.value.trim().length > 0,
                  );
                  if (rules.length === 0) {
                    toast({ title: "Pattern is required", variant: "destructive" });
                    return;
                  }
                  saveMutation.mutate(rules);
                }}
                disabled={!selected || saveMutation.isPending}
                data-testid="button-suggest-save"
              >
                {(saveMutation.isPending || applying) && (
                  <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                )}
                {applying ? "Applying…" : "Create rule"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>

      <Dialog
        open={!!reAttribViewRuleId}
        onOpenChange={(o) => {
          if (!o) {
            setReAttribViewRuleId(null);
            setReAttribItems([]);
            setReAttribTotal(0);
            setReAttribOffset(0);
          }
        }}
      >
        <DialogContent className="max-w-2xl" data-testid="dialog-reattributed-messages">
          <DialogHeader>
            <DialogTitle>Re-attributed messages</DialogTitle>
            <DialogDescription>
              Previously-dismissed Front emails that this new rule grabbed.
              Spot-check what it caught — undo the rule if it's grabbing the
              wrong thing.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[28rem] overflow-auto">
            {reAttribLoading && reAttribItems.length === 0 ? (
              <div
                className="text-sm text-muted-foreground italic p-4 text-center"
                data-testid="text-reattributed-loading"
              >
                Loading…
              </div>
            ) : reAttribItems.length === 0 ? (
              <div
                className="text-sm text-muted-foreground italic p-4 text-center"
                data-testid="text-reattributed-empty"
              >
                No re-attributed messages recorded.
              </div>
            ) : (
              <div className="divide-y border rounded">
                {reAttribItems.map((h) => (
                  <div
                    key={h.id}
                    className="p-2 text-xs space-y-0.5"
                    data-testid={`row-reattributed-${h.id}`}
                  >
                    <div
                      className="font-medium truncate"
                      title={h.subject ?? ""}
                      data-testid={`text-reattributed-subject-${h.id}`}
                    >
                      {h.subject ?? "(no subject)"}
                    </div>
                    <div
                      className="font-mono text-muted-foreground truncate"
                      title={h.senderEmail ?? ""}
                      data-testid={`text-reattributed-sender-${h.id}`}
                    >
                      {h.senderEmail ?? "(no sender)"}
                    </div>
                    <div
                      className="text-muted-foreground"
                      data-testid={`text-reattributed-original-${h.id}`}
                    >
                      Original rule:{" "}
                      {h.originalRuleId ? (
                        <span
                          className="font-mono"
                          title={h.originalRuleValue ?? undefined}
                        >
                          {h.originalRuleLabel ??
                            h.originalRuleValue?.slice(0, 60) ??
                            h.originalRuleId.slice(0, 8)}
                        </span>
                      ) : h.prevReason ? (
                        <span className="italic">{h.prevReason}</span>
                      ) : (
                        <span className="italic">none</span>
                      )}
                    </div>
                    {h.frontUrl && (
                      <div>
                        <a
                          href={h.frontUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-600 hover:underline inline-flex items-center gap-1"
                          data-testid={`link-reattributed-front-${h.id}`}
                        >
                          <ExternalLink className="h-3 w-3" />
                          Open in Front
                        </a>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
          <DialogFooter className="flex items-center justify-between gap-2 sm:justify-between">
            <div
              className="text-xs text-muted-foreground"
              data-testid="text-reattributed-pagination"
            >
              {reAttribTotal > 0
                ? `${reAttribOffset + 1}–${Math.min(reAttribOffset + reAttribItems.length, reAttribTotal)} of ${reAttribTotal}`
                : "0 of 0"}
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={
                  reAttribLoading ||
                  reAttribOffset === 0 ||
                  !reAttribViewRuleId
                }
                onClick={() => {
                  if (!reAttribViewRuleId) return;
                  const next = Math.max(0, reAttribOffset - REATTRIBUTED_PAGE_SIZE);
                  void loadReAttributed(reAttribViewRuleId, next);
                }}
                data-testid="button-reattributed-prev"
              >
                Previous
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={
                  reAttribLoading ||
                  reAttribOffset + reAttribItems.length >= reAttribTotal ||
                  !reAttribViewRuleId
                }
                onClick={() => {
                  if (!reAttribViewRuleId) return;
                  void loadReAttributed(
                    reAttribViewRuleId,
                    reAttribOffset + REATTRIBUTED_PAGE_SIZE,
                  );
                }}
                data-testid="button-reattributed-next"
              >
                Next
              </Button>
              <Button
                size="sm"
                onClick={() => setReAttribViewRuleId(null)}
                data-testid="button-reattributed-close"
              >
                Close
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Dialog>
  );
}
