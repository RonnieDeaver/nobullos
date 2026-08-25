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
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  RadioGroup,
  RadioGroupItem,
} from "@/components/ui/radio-group";
import { dismissReasons, dismissReasonLabels, type DismissReason } from "@shared/schema";

export type DismissReasonDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (reason: DismissReason, note?: string) => void;
  isPending?: boolean;
  title?: string;
  description?: string;
};

export function DismissReasonDialog({
  open,
  onOpenChange,
  onConfirm,
  isPending,
  title = "Dismiss this Zoom call",
  description = "Pick a reason so the audit trail records why this call was left unattributed.",
}: DismissReasonDialogProps) {
  const [reason, setReason] = useState<DismissReason>("not_relevant");
  const [note, setNote] = useState("");

  useEffect(() => {
    if (open) {
      setReason("not_relevant");
      setNote("");
    }
  }, [open]);

  const requiresNote = reason === "other";
  const canSubmit = !requiresNote || note.trim().length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="dialog-dismiss-reason">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <RadioGroup
            value={reason}
            onValueChange={(v) => setReason(v as DismissReason)}
            className="space-y-2"
          >
            {dismissReasons.map((r) => (
              <div key={r} className="flex items-center gap-2">
                <RadioGroupItem
                  id={`dismiss-reason-${r}`}
                  value={r}
                  data-testid={`radio-dismiss-reason-${r}`}
                />
                <Label htmlFor={`dismiss-reason-${r}`} className="text-sm font-normal cursor-pointer">
                  {dismissReasonLabels[r]}
                </Label>
              </div>
            ))}
          </RadioGroup>
          <div className="space-y-1">
            <Label htmlFor="dismiss-reason-note" className="text-xs uppercase text-muted-foreground">
              Note {requiresNote ? "(required)" : "(optional)"}
            </Label>
            <Textarea
              id="dismiss-reason-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Add context for the audit log…"
              rows={3}
              data-testid="input-dismiss-reason-note"
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={isPending}
            data-testid="button-dismiss-cancel"
          >
            Cancel
          </Button>
          {/* Danger pattern: the confirm inside the dialog is the commit point,
              so it carries the destructive treatment (triggers stay calm). */}
          <Button
            variant="destructive"
            onClick={() => onConfirm(reason, note.trim() ? note.trim() : undefined)}
            disabled={isPending || !canSubmit}
            data-testid="button-dismiss-confirm"
          >
            Dismiss call
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
