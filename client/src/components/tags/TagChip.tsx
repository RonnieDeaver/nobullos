import { Zap, X } from "lucide-react";

/**
 * Task #4329 — colored tag chip. Used on board cards, list rows, and the
 * detail-page tag cards. `source === "rule"` chips show a tiny bolt: they
 * were applied by the tag's criteria and will re-apply while the record
 * matches (the remove affordance is hidden for them — operators edit the
 * tag's criteria instead).
 */
export interface TagChipData {
  id: string;
  name: string;
  color: string;
  source?: "manual" | "rule";
}

/** Perceived-luminance check so chip text stays readable on any color.
 *  Returns the fixed chip-ink pair from index.css `:root` (--tag-chip-ink-*):
 *  deliberately theme-independent, because the chip background is the stored
 *  tag color, which never flips with the app theme. Consumers use the value
 *  in CSS contexts (inline `style`), so var() references resolve fine. */
export function tagTextColor(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return "var(--tag-chip-ink-dark)";
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
  return luminance > 150 ? "var(--tag-chip-ink-dark)" : "var(--tag-chip-ink-light)";
}

export function TagChip({
  tag,
  size = "sm",
  onRemove,
  testIdPrefix = "chip-tag",
}: {
  tag: TagChipData;
  size?: "xs" | "sm";
  onRemove?: () => void;
  testIdPrefix?: string;
}) {
  const isRule = tag.source === "rule";
  const textColor = tagTextColor(tag.color);
  return (
    <span
      className={`inline-flex max-w-full items-center gap-1 rounded-full font-medium ${
        size === "xs" ? "px-1.5 py-px text-caption" : "px-2 py-0.5 text-xs"
      }`}
      style={{ backgroundColor: tag.color, color: textColor }}
      title={isRule ? `${tag.name} — applied by rule` : tag.name}
      data-testid={`${testIdPrefix}-${tag.id}`}
    >
      {isRule && <Zap className={size === "xs" ? "h-2.5 w-2.5 shrink-0" : "h-3 w-3 shrink-0"} />}
      <span className="truncate">{tag.name}</span>
      {onRemove && !isRule && (
        <button
          type="button"
          className="shrink-0 rounded-full opacity-70 hover:opacity-100"
          aria-label={`Remove tag ${tag.name}`}
          data-testid={`button-remove-${testIdPrefix}-${tag.id}`}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onRemove();
          }}
        >
          <X className={size === "xs" ? "h-2.5 w-2.5" : "h-3 w-3"} />
        </button>
      )}
    </span>
  );
}

/** Compact chip row for list surfaces: first `max` chips + overflow count. */
export function TagChipRow({
  tags,
  max = 3,
  size = "xs",
  testIdPrefix,
}: {
  tags: TagChipData[];
  max?: number;
  size?: "xs" | "sm";
  testIdPrefix?: string;
}) {
  if (tags.length === 0) return null;
  const shown = tags.slice(0, max);
  const extra = tags.length - shown.length;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1">
      {shown.map((t) => (
        <TagChip key={t.id} tag={t} size={size} testIdPrefix={testIdPrefix} />
      ))}
      {extra > 0 && (
        <span className="text-caption text-muted-foreground" title={tags.slice(max).map((t) => t.name).join(", ")}>
          +{extra}
        </span>
      )}
    </div>
  );
}
