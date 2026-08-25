import { useCallback, useEffect, useState } from "react";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
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
import {
  PERSISTENT_STATE_CHANGED_EVENT,
  clearPersistedKeys,
  hasPersistedKeys,
} from "@/hooks/use-persistent-state";
import {
  ADMIN_PERSISTED_VIEW_KEYS,
  ADMIN_PERSISTED_VIEW_PREFIXES,
} from "@/lib/adminPersistedViews";
import { cn } from "@/lib/utils";

interface GlobalResetSavedAdminViewsButtonProps {
  className?: string;
  variant?: "outline" | "ghost" | "secondary" | "default";
  size?: "sm" | "default" | "lg" | "icon";
}

export function GlobalResetSavedAdminViewsButton({
  className,
  variant = "outline",
  size = "sm",
}: GlobalResetSavedAdminViewsButtonProps) {
  const check = useCallback(
    () =>
      hasPersistedKeys({
        keys: ADMIN_PERSISTED_VIEW_KEYS,
        prefixes: ADMIN_PERSISTED_VIEW_PREFIXES,
      }),
    [],
  );

  const [hasSaved, setHasSaved] = useState<boolean>(check);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setHasSaved(check());
    if (typeof window === "undefined") return;
    const onChange = () => setHasSaved(check());
    window.addEventListener(PERSISTENT_STATE_CHANGED_EVENT, onChange);
    window.addEventListener("storage", onChange);
    return () => {
      window.removeEventListener(PERSISTENT_STATE_CHANGED_EVENT, onChange);
      window.removeEventListener("storage", onChange);
    };
  }, [check]);

  if (!hasSaved) return null;

  const handleConfirm = () => {
    clearPersistedKeys({
      keys: ADMIN_PERSISTED_VIEW_KEYS,
      prefixes: ADMIN_PERSISTED_VIEW_PREFIXES,
    });
    setHasSaved(false);
    setOpen(false);
  };

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button
          type="button"
          variant={variant}
          size={size}
          className={cn("h-8 gap-1.5", className)}
          data-testid="button-reset-all-saved-admin-views"
          title="Clear filter, tab, and view choices saved on every admin page"
        >
          <RotateCcw className="w-3.5 h-3.5" />
          <span>Reset all saved admin views</span>
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent data-testid="dialog-reset-all-saved-admin-views">
        <AlertDialogHeader>
          <AlertDialogTitle>Reset all saved admin views?</AlertDialogTitle>
          <AlertDialogDescription>
            This clears every filter, tab, expanded row, and view choice
            you've saved across the admin pages (Match Settings, Zoom
            Review Queue, Activity Dashboard, Rate Limit pages, System
            Health, and others). Each page will fall back to its default
            view. This only affects your browser — it doesn't change
            anything for other admins.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="button-reset-all-saved-admin-views-cancel">
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={handleConfirm}
            data-testid="button-reset-all-saved-admin-views-confirm"
          >
            Reset all
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
