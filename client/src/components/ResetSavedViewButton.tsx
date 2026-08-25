import { useCallback, useEffect, useState } from "react";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  PERSISTENT_STATE_CHANGED_EVENT,
  clearPersistedKeys,
  hasPersistedKeys,
} from "@/hooks/use-persistent-state";
import { cn } from "@/lib/utils";

interface ResetSavedViewButtonProps {
  storageKeys?: readonly (string | null | undefined)[];
  storagePrefixes?: readonly string[];
  onReset?: () => void;
  label?: string;
  className?: string;
  variant?: "outline" | "ghost" | "secondary" | "default";
  size?: "sm" | "default" | "lg" | "icon";
  testId?: string;
}

export function ResetSavedViewButton({
  storageKeys,
  storagePrefixes,
  onReset,
  label = "Reset saved view",
  className,
  variant = "outline",
  size = "sm",
  testId = "button-reset-saved-view",
}: ResetSavedViewButtonProps) {
  const keysSig = (storageKeys ?? []).filter(Boolean).join("|");
  const prefixesSig = (storagePrefixes ?? []).join("|");

  const check = useCallback(
    () => hasPersistedKeys({ keys: storageKeys, prefixes: storagePrefixes }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [keysSig, prefixesSig],
  );

  const [hasSaved, setHasSaved] = useState<boolean>(check);

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

  const handleClick = () => {
    onReset?.();
    clearPersistedKeys({ keys: storageKeys, prefixes: storagePrefixes });
    setHasSaved(false);
  };

  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      onClick={handleClick}
      className={cn("h-8 gap-1.5", className)}
      data-testid={testId}
      title="Clear filter, tab, and view choices saved on this page"
    >
      <RotateCcw className="w-3.5 h-3.5" />
      <span>{label}</span>
    </Button>
  );
}
