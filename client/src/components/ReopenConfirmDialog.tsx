import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export type ReopenConfirmDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  isPending?: boolean;
};

export function ReopenConfirmDialog({
  open,
  onOpenChange,
  onConfirm,
  isPending,
}: ReopenConfirmDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="dialog-reopen-confirm">
        <DialogHeader>
          <DialogTitle>Re-open this Zoom call?</DialogTitle>
          <DialogDescription>
            Re-opening sends this call back to the review queue and will clear the
            existing audit context.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 py-2 text-sm">
          <p className="text-muted-foreground">The following will be cleared:</p>
          <ul className="list-disc pl-5 space-y-1 text-muted-foreground">
            <li>The original review resolution (approved or dismissed)</li>
            <li>The dismiss reason and any reviewer note</li>
            <li>The reviewer attribution and resolution timestamp</li>
          </ul>
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={isPending}
            data-testid="button-reopen-cancel"
          >
            Cancel
          </Button>
          <Button
            onClick={onConfirm}
            disabled={isPending}
            data-testid="button-reopen-confirm"
          >
            Re-open call
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
