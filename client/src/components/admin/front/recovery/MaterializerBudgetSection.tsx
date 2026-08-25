// F11A — extracted verbatim from FrontHistoricalRecoveryPanel.tsx (source @ fe87fb8ca).
// Behavior contract: copy, test IDs, query/mutation keys and states are unchanged.
import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LastEditedBadge, type LastEditedInfo } from "@/components/LastEditedBadge";
import { useTabVisibility } from "@/hooks/use-tab-visibility";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import type { IntegrationStatus } from "./types";

type Props = {
  isAdmin: boolean;
  status: IntegrationStatus | undefined;
};

export function MaterializerBudgetSection({ isAdmin, status }: Props) {
  const isTabVisible = useTabVisibility();
  const { toast } = useToast();


  // Task #2720 — operator-tunable "Bring it to 100%" backfill speed. The two
  // per-tick Front API call budgets (Task #2714) were previously only editable
  // by writing raw `system_settings` rows; this surfaces them as numeric inputs
  // with the documented defaults/ceilings shown inline. Blank → reset to default.
  type MaterializerBudgetResponse = {
    conversationBudget: number;
    messagePageBudget: number;
    defaultConversationBudget: number;
    defaultMessagePageBudget: number;
    maxConversationBudget: number;
    maxMessagePageBudget: number;
    conversationBudgetOverridden: boolean;
    messagePageBudgetOverridden: boolean;
    conversationBudgetLastEdited?: LastEditedInfo | null;
    messagePageBudgetLastEdited?: LastEditedInfo | null;
  };

  const { data: materializerBudget, refetch: refetchMaterializerBudget } =
    useQuery<MaterializerBudgetResponse>({
      queryKey: [
        "/api/integrations/front/historical-recovery/materializer-budget",
      ],
      enabled: isAdmin && !!status?.front.connected,
      refetchInterval: isTabVisible ? 60_000 : false,
    });

  const [materializerConversationDraft, setMaterializerConversationDraft] =
    useState<string>("");

  const [materializerMessagePageDraft, setMaterializerMessagePageDraft] =
    useState<string>("");

  // Reseed the two draft inputs from extracted primitive fields (not the whole
  // response object) so the effect bodies and deps agree, and the 60s polling
  // refetch can't clobber in-progress edits when the values are unchanged.
  const materializerConvBudget = materializerBudget?.conversationBudget;

  const materializerConvOverridden = materializerBudget?.conversationBudgetOverridden;

  const materializerMsgPageBudget = materializerBudget?.messagePageBudget;

  const materializerMsgPageOverridden = materializerBudget?.messagePageBudgetOverridden;

  useEffect(() => {
    if (materializerConvOverridden === undefined) return;
    setMaterializerConversationDraft(
      materializerConvOverridden ? String(materializerConvBudget) : "",
    );
  }, [materializerConvBudget, materializerConvOverridden]);

  useEffect(() => {
    if (materializerMsgPageOverridden === undefined) return;
    setMaterializerMessagePageDraft(
      materializerMsgPageOverridden ? String(materializerMsgPageBudget) : "",
    );
  }, [materializerMsgPageBudget, materializerMsgPageOverridden]);

  const materializerBudgetMutation = useMutation<
    MaterializerBudgetResponse,
    Error,
    { conversationBudget: number | null; messagePageBudget: number | null }
  >({
    mutationFn: async (body) => {
      const res = await apiRequest(
        "PUT",
        "/api/integrations/front/historical-recovery/materializer-budget",
        body,
      );
      return res.json();
    },
    onSuccess: (data) => {
      toast({
        title: "Backfill speed updated",
        description: `Threads/tick = ${data.conversationBudget}, message pages/tick = ${data.messagePageBudget}.`,
      });
      void refetchMaterializerBudget(); // fire-and-forget: refetch only
    },
    onError: (err: Error) => {
      toast({
        title: "Failed to update backfill speed",
        description: err.message,
        variant: "destructive",
      });
    },
    meta: { silent: true },
  });

  return (
    <>
        {materializerBudget &&
          (() => {
            // Task #2720 — "Bring it to 100%" backfill speed editor.
            const convMax = materializerBudget.maxConversationBudget;
            const msgMax = materializerBudget.maxMessagePageBudget;
            const validField = (draft: string, max: number): boolean => {
              if (draft.trim() === "") return true; // blank = reset to default
              const n = Number(draft);
              return Number.isInteger(n) && n >= 1 && n <= max;
            };
            const convValid = validField(
              materializerConversationDraft,
              convMax,
            );
            const msgValid = validField(materializerMessagePageDraft, msgMax);
            const normalize = (s: string): string =>
              s.trim() === "" ? "" : String(Number(s));
            const convCurrent = materializerBudget.conversationBudgetOverridden
              ? String(materializerBudget.conversationBudget)
              : "";
            const msgCurrent = materializerBudget.messagePageBudgetOverridden
              ? String(materializerBudget.messagePageBudget)
              : "";
            const dirty =
              normalize(materializerConversationDraft) !== convCurrent ||
              normalize(materializerMessagePageDraft) !== msgCurrent;
            const anyOverride =
              materializerBudget.conversationBudgetOverridden ||
              materializerBudget.messagePageBudgetOverridden;
            const submit = () =>
              materializerBudgetMutation.mutate({
                conversationBudget:
                  materializerConversationDraft.trim() === ""
                    ? null
                    : Number(materializerConversationDraft),
                messagePageBudget:
                  materializerMessagePageDraft.trim() === ""
                    ? null
                    : Number(materializerMessagePageDraft),
              });
            return (
              <div
                className="border-t pt-3 space-y-2"
                data-testid="section-materializer-budget"
              >
                <div className="text-xs font-semibold text-gray-700">
                  "Bring it to 100%" backfill speed
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <Label
                    htmlFor="input-materializer-conversation-budget"
                    className="text-xs text-gray-600"
                  >
                    Threads per tick
                  </Label>
                  <Input
                    id="input-materializer-conversation-budget"
                    type="number"
                    min={1}
                    max={convMax}
                    step={1}
                    placeholder={String(
                      materializerBudget.defaultConversationBudget,
                    )}
                    value={materializerConversationDraft}
                    onChange={(e) =>
                      setMaterializerConversationDraft(e.target.value)
                    }
                    className="h-7 w-24 text-xs"
                    data-testid="input-materializer-conversation-budget"
                  />
                  <span className="text-xs text-gray-600">
                    default {materializerBudget.defaultConversationBudget}, max{" "}
                    {convMax} (blank = default)
                  </span>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <Label
                    htmlFor="input-materializer-message-page-budget"
                    className="text-xs text-gray-600"
                  >
                    Message pages per tick
                  </Label>
                  <Input
                    id="input-materializer-message-page-budget"
                    type="number"
                    min={1}
                    max={msgMax}
                    step={1}
                    placeholder={String(
                      materializerBudget.defaultMessagePageBudget,
                    )}
                    value={materializerMessagePageDraft}
                    onChange={(e) =>
                      setMaterializerMessagePageDraft(e.target.value)
                    }
                    className="h-7 w-24 text-xs"
                    data-testid="input-materializer-message-page-budget"
                  />
                  <span className="text-xs text-gray-600">
                    default {materializerBudget.defaultMessagePageBudget}, max{" "}
                    {msgMax} (blank = default)
                  </span>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 text-xs"
                    data-testid="button-materializer-budget-save"
                    disabled={
                      materializerBudgetMutation.isPending ||
                      !convValid ||
                      !msgValid ||
                      !dirty
                    }
                    onClick={submit}
                  >
                    {materializerBudgetMutation.isPending ? "Saving…" : "Save"}
                  </Button>
                  {anyOverride && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-xs text-gray-500"
                      data-testid="button-materializer-budget-reset"
                      disabled={materializerBudgetMutation.isPending}
                      onClick={() => {
                        setMaterializerConversationDraft("");
                        setMaterializerMessagePageDraft("");
                        materializerBudgetMutation.mutate({
                          conversationBudget: null,
                          messagePageBudget: null,
                        });
                      }}
                    >
                      Reset to defaults
                    </Button>
                  )}
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <LastEditedBadge
                    info={
                      materializerBudget.conversationBudgetLastEdited ??
                      undefined
                    }
                    testId="last-edited-materializer-conversation-budget"
                    emptyText="Threads/tick — using default"
                  />
                  <LastEditedBadge
                    info={
                      materializerBudget.messagePageBudgetLastEdited ?? undefined
                    }
                    testId="last-edited-materializer-message-page-budget"
                    emptyText="Message pages/tick — using default"
                  />
                </div>
                <div
                  className="text-xs text-gray-500"
                  data-testid="text-materializer-budget-help"
                >
                  Throughput dial for the historical "Bring it to 100%"
                  backfill: each tick walks up to this many Front message
                  threads and fetches up to this many pages of messages from
                  them before yielding. Higher = faster catch-up; it is bounded
                  by Front's API rate limit (the 429 / Retry-After backoff is
                  the real safety net), not the worker pool. Leave a field blank
                  to reset it to the default.
                </div>
              </div>
            );
          })()}
    </>
  );
}
