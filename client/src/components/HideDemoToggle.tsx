import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/**
 * Task #4363 — the shared control for the global "hide demo/test accounts"
 * filter (design audit P3-4). Every adopting list surface renders this same
 * labeled switch beside its counts, so the toggle's state is visible
 * wherever it filters; while active it reports exactly how many demo rows
 * the current list dropped ("0 hidden" is deliberate — an active filter
 * that matched nothing should still say so).
 */
export function HideDemoToggle({
  surface,
  checked,
  onCheckedChange,
  hiddenCount,
  className,
}: {
  /** Unique per-surface suffix for element ids/testids, e.g. "dashboard". */
  surface: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** Demo rows the active filter removed from this surface's list. */
  hiddenCount: number;
  className?: string;
}) {
  const switchId = `switch-hide-demo-${surface}`;
  return (
    <div
      className={cn("flex items-center gap-2", className)}
      data-testid={`toggle-hide-demo-${surface}`}
    >
      <Switch
        id={switchId}
        checked={checked}
        onCheckedChange={onCheckedChange}
        data-testid={switchId}
      />
      <Label
        htmlFor={switchId}
        className="cursor-pointer whitespace-nowrap text-xs font-medium text-muted-foreground"
      >
        Hide demo accounts
      </Label>
      {checked && (
        <span
          className="whitespace-nowrap rounded-full bg-primary/10 px-2 py-0.5 text-caption font-medium text-primary"
          data-testid={`text-demo-hidden-${surface}`}
        >
          {hiddenCount} hidden
        </span>
      )}
    </div>
  );
}
