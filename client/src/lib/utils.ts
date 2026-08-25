import { clsx, type ClassValue } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"

// tailwind-merge can't know our custom theme tokens: it classifies unknown
// `text-*` classes as COLORS, so pairing a type-scale utility with a text
// color in one cn() call (e.g. "text-caption text-status-warn") silently
// dropped the font-size. Teach it the four type-scale steps from
// index.css (`--text-display/heading/body/caption`) so size + color merge
// cleanly and real font-size conflicts (text-caption vs text-xs) still
// resolve last-wins. (Task #4345)
// Same story for the radius contract: `rounded-pill` (--radius-pill, the
// sole sanctioned rounding — see index.css) is not a stock suffix, so
// without registration tailwind-merge would keep BOTH classes in e.g.
// cn("rounded-md", "rounded-pill") instead of letting the pill win.
// (Task #4361)
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: ["display", "heading", "body", "caption"] }],
      rounded: [{ rounded: ["pill"] }],
    },
  },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
