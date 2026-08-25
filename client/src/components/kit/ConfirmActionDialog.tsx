import { type ReactNode } from "react";

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

/**
 * ConfirmActionDialog — the standard AlertDialog confirmation wrapper for
 * destructive / consequential admin actions (Task #4456, finishing the
 * #4357 sweep).
 *
 * Replaces browser-native `window.confirm()` popups, which are unstyled,
 * show no blast-radius detail, can be suppressed by the browser, and are
 * untestable in jsdom. The action button becomes the dialog trigger
 * (rendered `asChild`, so its own styling/disabled state is preserved);
 * the mutation only fires from the dialog's confirm button.
 *
 * Same endpoints, same guards — dialog only.
 */
export interface ConfirmActionDialogProps {
  /**
   * The action button; rendered asChild so it keeps its own styling.
   * Omit when using controlled mode (`open`/`onOpenChange`) for actions
   * fired from callbacks rather than a wrappable trigger element.
   */
  trigger?: ReactNode;
  /** Controlled open state (use with `onOpenChange`, no trigger). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Dialog heading, phrased as the question being confirmed. */
  title: ReactNode;
  /** Action-specific consequence copy (blast radius, recovery path). */
  description: ReactNode;
  /** Confirm button label (default "Confirm"). */
  confirmLabel?: ReactNode;
  /** Fired only when the operator confirms. */
  onConfirm: () => void;
  /**
   * `data-testid` for the dialog content; the confirm/cancel buttons get
   * `-confirm` / `-cancel` suffixes.
   */
  testId?: string;
}

export function ConfirmActionDialog({
  trigger,
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Confirm",
  onConfirm,
  testId,
}: ConfirmActionDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      {trigger != null && <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>}
      <AlertDialogContent data-testid={testId}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid={testId ? `${testId}-cancel` : undefined}>
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            data-testid={testId ? `${testId}-confirm` : undefined}
            onClick={onConfirm}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
