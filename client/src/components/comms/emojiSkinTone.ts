// ─── Skin tone data + helper ─────────────────────────────────────────────────
// Pure module (no React/DOM) so it can be imported by both EmojiPicker.tsx and
// node-side tests. Keep applyTone the single source of truth for how a skin
// tone modifier is attached to an emoji before it is inserted / reacted with.

export const SKIN_TONE_MODIFIERS = ["", "\u{1F3FB}", "\u{1F3FC}", "\u{1F3FD}", "\u{1F3FE}", "\u{1F3FF}"] as const;
export const SKIN_TONE_LABELS = ["Default", "Light", "Medium-Light", "Medium", "Medium-Dark", "Dark"];
export const SKIN_TONE_SWATCHES = ["🟡", "🏻", "🏼", "🏽", "🏾", "🏿"];

// Emoji that support skin tone modifiers — Gestures category base chars
export const SKIN_TONE_COMPATIBLE = new Set([
  "👋","🤚","🖐️","✋","🖖","👌","🤌","🤏","✌️","🤞","🤟","🤘","🤙",
  "👈","👉","👆","🖕","👇","☝️","👍","👎","✊","👊","🤛","🤜","👏",
  "🙌","👐","🤲","🤝","🙏","✍️","💅","🤳","💪",
]);

export function applyTone(emoji: string, toneIdx: number): string {
  if (toneIdx === 0) return emoji;
  const base = emoji.replace(/[\u{1F3FB}-\u{1F3FF}]/gu, "");
  if (!SKIN_TONE_COMPATIBLE.has(base)) return emoji;
  return base + SKIN_TONE_MODIFIERS[toneIdx];
}

/** Strip any skin-tone modifier, returning the base emoji (identity for untoned). */
export function baseEmojiOf(emoji: string): string {
  return emoji.replace(/[\u{1F3FB}-\u{1F3FF}]/gu, "");
}

/**
 * Human-readable tone label ("Light" … "Dark") for a toned emoji, or null when
 * the emoji carries no skin-tone modifier. Used by reaction pills to label
 * variants — skin-tone variants deliberately render as SEPARATE pills (Slack
 * parity; each user+emoji string is a distinct reaction row), and this label
 * makes that distinction legible in the pill tooltip.
 */
export function toneLabelOf(emoji: string): string | null {
  const m = emoji.match(/[\u{1F3FB}-\u{1F3FF}]/u);
  if (!m) return null;
  const idx = SKIN_TONE_MODIFIERS.indexOf(m[0] as (typeof SKIN_TONE_MODIFIERS)[number]);
  return idx > 0 ? SKIN_TONE_LABELS[idx] : null;
}
