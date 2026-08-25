/**
 * Task #4327 — required-fields-on-entry prompt for deal stage moves.
 *
 * A stage move POSTs /api/deals/:id/move; when the target stage declares
 * requiredFields the deal doesn't satisfy, the server answers
 * 422 { missingFields: [...] }. Both the board (drag) and the detail view
 * (move control) funnel that response into this dialog, which collects the
 * missing values and retries the same move with `fields` attached.
 */
import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  dealRequiredFieldLabels,
  type DealRequiredFieldKey,
} from "@shared/schema";

export interface DealMoveFields {
  amount?: number;
  expectedCloseDate?: string;
  lostReason?: string;
}

export type DealMoveResponse =
  | { ok: true; data: unknown }
  | { ok: false; status: number; missingFields?: DealRequiredFieldKey[]; error?: string };

/** POSTs a stage move and normalizes the 422 required-fields answer. */
export async function postDealMove(
  dealId: string,
  toStageId: string,
  fields?: DealMoveFields,
): Promise<DealMoveResponse> {
  const res = await fetch(`/api/deals/${dealId}/move`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(fields && Object.keys(fields).length > 0 ? { toStageId, fields } : { toStageId }),
  });
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    // non-JSON error body — fall through with null data
  }
  if (res.ok) return { ok: true, data };
  return {
    ok: false,
    status: res.status,
    missingFields: Array.isArray(data?.missingFields) ? data.missingFields : undefined,
    error: typeof data?.error === "string" ? data.error : undefined,
  };
}

export function formatDealAmount(amount: number | null | undefined): string {
  if (amount === null || amount === undefined) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(amount);
}

export interface RequiredFieldsPrompt {
  dealId: string;
  dealName: string;
  toStageId: string;
  toStageName: string;
  missingFields: DealRequiredFieldKey[];
}

export function DealRequiredFieldsDialog({
  prompt,
  onCancel,
  onSubmit,
  submitting,
}: {
  prompt: RequiredFieldsPrompt | null;
  onCancel: () => void;
  /** Called with the collected fields; the caller retries the move. */
  onSubmit: (fields: DealMoveFields) => void;
  submitting: boolean;
}) {
  const [amount, setAmount] = useState("");
  const [expectedCloseDate, setExpectedCloseDate] = useState("");
  const [lostReason, setLostReason] = useState("");

  useEffect(() => {
    if (prompt) {
      setAmount("");
      setExpectedCloseDate("");
      setLostReason("");
    }
  }, [prompt]);

  if (!prompt) return null;
  const needs = (key: DealRequiredFieldKey) => prompt.missingFields.includes(key);
  const canSubmit =
    (!needs("amount") || amount.trim() !== "") &&
    (!needs("expected_close_date") || expectedCloseDate !== "") &&
    (!needs("lost_reason") || lostReason.trim() !== "");

  const handleSubmit = () => {
    const fields: DealMoveFields = {};
    if (needs("amount")) fields.amount = Number(amount);
    if (needs("expected_close_date")) fields.expectedCloseDate = expectedCloseDate;
    if (needs("lost_reason")) fields.lostReason = lostReason.trim();
    onSubmit(fields);
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="sm:max-w-md" data-testid="dialog-required-fields">
        <DialogHeader>
          <DialogTitle>Moving to {prompt.toStageName}</DialogTitle>
          <DialogDescription>
            “{prompt.dealName}” needs{" "}
            {prompt.missingFields.map((f) => dealRequiredFieldLabels[f]).join(", ")}{" "}
            before it can enter this stage.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {needs("amount") && (
            <div className="space-y-1.5">
              <Label htmlFor="required-amount">
                {dealRequiredFieldLabels.amount} (USD)
              </Label>
              <Input
                id="required-amount"
                type="number"
                min="0"
                step="1"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="5000"
                data-testid="input-required-amount"
              />
            </div>
          )}
          {needs("expected_close_date") && (
            <div className="space-y-1.5">
              <Label htmlFor="required-close-date">
                {dealRequiredFieldLabels.expected_close_date}
              </Label>
              <Input
                id="required-close-date"
                type="date"
                value={expectedCloseDate}
                onChange={(e) => setExpectedCloseDate(e.target.value)}
                data-testid="input-required-close-date"
              />
            </div>
          )}
          {needs("lost_reason") && (
            <div className="space-y-1.5">
              <Label htmlFor="required-lost-reason">
                {dealRequiredFieldLabels.lost_reason}
              </Label>
              <Textarea
                id="required-lost-reason"
                value={lostReason}
                onChange={(e) => setLostReason(e.target.value)}
                placeholder="Why was this deal lost?"
                rows={3}
                data-testid="input-required-lost-reason"
              />
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} data-testid="button-required-cancel">
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!canSubmit || submitting}
            data-testid="button-required-submit"
          >
            {submitting ? "Moving…" : "Complete move"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
