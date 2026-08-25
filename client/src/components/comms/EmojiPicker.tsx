import { useState, useRef, useEffect, useLayoutEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Upload, X, Smile } from "lucide-react";

import {
  SKIN_TONE_MODIFIERS,
  SKIN_TONE_LABELS,
  SKIN_TONE_SWATCHES,
  SKIN_TONE_COMPATIBLE,
  applyTone,
} from "./emojiSkinTone";

// ─── Standard emoji data ─────────────────────────────────────────────────────

const STANDARD_CATEGORIES: { label: string; icon: string; emojis: string[] }[] = [
  {
    label: "Smileys",
    icon: "😀",
    emojis: [
      "😀","😃","😄","😁","😆","😅","😂","🤣","😊","😇",
      "🙂","🙃","😉","😌","😍","🥰","😘","😗","😙","😚",
      "😋","😛","😝","😜","🤪","🤨","🧐","🤓","😎","🤩",
      "🥳","😏","😒","😞","😔","😟","😕","🙁","☹️","😣",
      "😖","😫","😩","🥺","😢","😭","😤","😠","😡","🤬",
      "😈","👿","💀","☠️","💩","🤡","👹","👺","👻","👽",
    ],
  },
  {
    label: "Gestures",
    icon: "👋",
    emojis: [
      "👋","🤚","🖐️","✋","🖖","👌","🤌","🤏","✌️","🤞",
      "🤟","🤘","🤙","👈","👉","👆","🖕","👇","☝️","👍",
      "👎","✊","👊","🤛","🤜","👏","🙌","👐","🤲","🤝",
      "🙏","✍️","💅","🤳","💪","🦵","🦶","👂","🦻","👃",
    ],
  },
  {
    label: "Animals",
    icon: "🐶",
    emojis: [
      "🐶","🐱","🐭","🐹","🐰","🦊","🐻","🐼","🐨","🐯",
      "🦁","🐮","🐷","🐸","🐵","🙈","🙉","🙊","🐔","🐧",
      "🐦","🐤","🦆","🦅","🦉","🦇","🐺","🐗","🐴","🦄",
      "🐝","🐛","🦋","🐌","🐞","🐜","🦟","🦗","🕷️","🦂",
    ],
  },
  {
    label: "Food",
    icon: "🍕",
    emojis: [
      "🍎","🍊","🍋","🍇","🍓","🫐","🍈","🍒","🍑","🥭",
      "🍕","🍔","🌮","🌯","🥗","🍜","🍣","🍱","🍛","🍲",
      "☕","🍵","🧃","🥤","🍺","🍻","🥂","🍷","🥃","🍸",
      "🎂","🍰","🧁","🍩","🍪","🍫","🍬","🍭","🍮","🍯",
    ],
  },
  {
    label: "Travel",
    icon: "✈️",
    emojis: [
      "✈️","🚀","🛸","🚁","🛶","⛵","🚂","🚗","🚕","🏎️",
      "🚌","🚎","🏠","🏡","🏢","🏣","🏤","🏥","🏦","🏨",
      "⛺","🌍","🌎","🌏","🗺️","🏔️","🌋","🗻","🏕️","🏖️",
      "🌅","🌄","🌠","🎆","🎇","🌌","🌃","🌆","🌇","🌉",
    ],
  },
  {
    label: "Objects",
    icon: "💻",
    emojis: [
      "⌚","📱","💻","⌨️","🖥️","🖨️","🖱️","💾","💿","📷",
      "📹","📺","📻","🎙️","📡","🔋","🔌","💡","🔦","🕯️",
      "💰","💳","💎","⚖️","🔧","🔨","⚒️","🛠️","⛏️","🔩",
      "🔑","🗝️","🔓","🔒","🚪","📦","📬","📭","📜","📄",
    ],
  },
  {
    label: "Symbols",
    icon: "❤️",
    emojis: [
      "❤️","🧡","💛","💚","💙","💜","🖤","🤍","🤎","💔",
      "✨","⭐","🌟","💫","🔥","💥","❄️","🌈","⚡","🌊",
      "✅","❌","⚠️","📛","🚫","⛔","🔴","🟠","🟡","🟢",
      "🔵","🟣","⚫","⚪","🟤","🔶","🔷","🔸","🔹","🔺",
    ],
  },
  {
    label: "Activities",
    icon: "⚽",
    emojis: [
      "⚽","🏀","🏈","⚾","🎾","🏐","🏉","🎱","🏓","🏸",
      "🥊","🥋","🎯","🎳","🏹","🎣","🏊","🤽","🚴","🧗",
      "🎭","🎨","🎬","🎤","🎧","🎵","🎶","🎹","🥁","🎸",
      "🏆","🥇","🥈","🥉","🎖️","🏅","🎗️","🎫","🎟️","🎪",
    ],
  },
];

// ─── Types ────────────────────────────────────────────────────────────────────

interface CustomEmojiItem {
  id: string;
  name: string;
  imageUrl: string;
}

interface FrequentlyUsedItem {
  emoji: string;
  useCount: number;
}

interface EmojiPickerProps {
  onSelect: (emoji: string) => void;
  onClose: () => void;
  className?: string;
}

// ─── Hooks ────────────────────────────────────────────────────────────────────

function useCustomEmoji() {
  return useQuery<CustomEmojiItem[]>({
    queryKey: ["/api/comms/emoji"],
    queryFn: () =>
      fetch("/api/comms/emoji", { credentials: "include" })
        .then((r) => (r.ok ? r.json() : [])),
    staleTime: 60_000,
  });
}

function useFrequentlyUsed() {
  return useQuery<FrequentlyUsedItem[]>({
    queryKey: ["/api/comms/emoji/frequently-used"],
    queryFn: () =>
      fetch("/api/comms/emoji/frequently-used", { credentials: "include" })
        .then((r) => (r.ok ? r.json() : [])),
    staleTime: 30_000,
  });
}

// ─── Skin tone helpers ────────────────────────────────────────────────────────

const SKIN_TONE_KEY = "comms_emoji_skin_tone";

function loadSkinTone(): number {
  try {
    const v = localStorage.getItem(SKIN_TONE_KEY);
    const n = Number(v);
    return Number.isInteger(n) && n >= 0 && n <= 5 ? n : 0;
  } catch {
    return 0;
  }
}

function saveSkinTone(idx: number) {
  try {
    localStorage.setItem(SKIN_TONE_KEY, String(idx));
  } catch {}
}

// ─── EmojiPicker ─────────────────────────────────────────────────────────────

const CATEGORY_FREQUENTLY_USED = "__frequently_used__";
const CATEGORY_CUSTOM = "__custom__";

export function EmojiPicker({ onSelect, onClose, className }: EmojiPickerProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [search, setSearch] = useState("");
  const [skinTone, setSkinTone] = useState(loadSkinTone);
  const [activeCategory, setActiveCategory] = useState<string>(
    STANDARD_CATEGORIES[0].label,
  );

  const { data: customEmoji = [] } = useCustomEmoji();
  const { data: frequentlyUsed = [] } = useFrequentlyUsed();

  // Close on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onClose]);

  const handleSkinTone = (idx: number) => {
    setSkinTone(idx);
    saveSkinTone(idx);
  };

  const handleSelect = useCallback(
    (emoji: string) => {
      onSelect(emoji);
      onClose();
      // Track usage (fire-and-forget)
      fetch("/api/comms/emoji/usage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ emoji }),
        credentials: "include",
      }).catch(() => {});
    },
    [onSelect, onClose],
  );

  // Build search results merging standard + custom emoji
  const searchTrimmed = search.trim().toLowerCase();
  const searchResults = searchTrimmed.length >= 1
    ? {
        standard: STANDARD_CATEGORIES.flatMap((c) =>
          c.emojis.filter((e) => {
            const base = e.replace(/[\u{1F3FB}-\u{1F3FF}]/gu, "");
            return SKIN_TONE_COMPATIBLE.has(base)
              ? applyTone(base, skinTone).includes(searchTrimmed)
              : e.includes(searchTrimmed);
          }),
        ),
        custom: customEmoji.filter((e) =>
          e.name.toLowerCase().includes(searchTrimmed),
        ),
      }
    : null;

  const hasFrequentlyUsed = frequentlyUsed.length > 0;

  // Tabs: frequently used (if any), standard categories, custom
  const tabs: { key: string; icon: string; label: string }[] = [
    ...(hasFrequentlyUsed
      ? [{ key: CATEGORY_FREQUENTLY_USED, icon: "🕐", label: "Recent" }]
      : []),
    ...STANDARD_CATEGORIES.map((c) => ({
      key: c.label,
      icon: c.icon,
      label: c.label,
    })),
    { key: CATEGORY_CUSTOM, icon: "✏️", label: "Custom" },
  ];

  // Ensure activeCategory is valid when tabs change
  const validCats = new Set(tabs.map((t) => t.key));
  const resolvedActive = validCats.has(activeCategory)
    ? activeCategory
    : tabs[0]?.key ?? STANDARD_CATEGORIES[0].label;

  return (
    <div
      ref={ref}
      className={cn(
        "bg-popover border border-border rounded-xl shadow-xl w-72 z-50 flex flex-col overflow-hidden",
        className,
      )}
      data-testid="emoji-picker"
    >
      {/* Search + skin tone */}
      <div className="p-2 border-b border-border flex gap-1.5 items-center">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search emoji…"
          className="h-7 text-sm flex-1"
          data-testid="emoji-search"
          autoFocus
        />
        {/* Skin tone selector */}
        <div className="relative flex-shrink-0" data-testid="skin-tone-selector">
          <details className="group">
            <summary
              className="list-none cursor-pointer w-7 h-7 flex items-center justify-center rounded hover:bg-muted text-base"
              title="Skin tone"
            >
              {SKIN_TONE_SWATCHES[skinTone]}
            </summary>
            <div className="absolute right-0 top-8 bg-popover border border-border rounded-lg shadow-lg p-1 flex gap-0.5 z-50">
              {SKIN_TONE_SWATCHES.map((swatch, i) => (
                <button
                  key={i}
                  onClick={() => handleSkinTone(i)}
                  title={SKIN_TONE_LABELS[i]}
                  className={cn(
                    "w-7 h-7 text-base rounded hover:bg-muted flex items-center justify-center",
                    skinTone === i && "bg-muted ring-1 ring-primary",
                  )}
                  data-testid={`skin-tone-${i}`}
                >
                  {swatch}
                </button>
              ))}
            </div>
          </details>
        </div>
      </div>

      {/* Category tabs — hidden when searching */}
      {!searchTrimmed && (
        <div className="flex overflow-x-auto border-b border-border px-1 py-1 gap-0.5 scrollbar-none">
          {tabs.map((t) => (
            <button
              key={t.key}
              onClick={() => setActiveCategory(t.key)}
              title={t.label}
              className={cn(
                "text-base px-1.5 py-0.5 rounded flex-shrink-0 transition-colors leading-none",
                resolvedActive === t.key
                  ? "bg-primary/15 ring-1 ring-primary/30"
                  : "hover:bg-muted text-muted-foreground",
              )}
              data-testid={`emoji-cat-${t.key}`}
            >
              {t.icon}
            </button>
          ))}
        </div>
      )}

      {/* Emoji grid */}
      <div className="overflow-y-auto max-h-52 p-2">
        {/* Search results */}
        {searchResults && (
          <>
            {searchResults.standard.length === 0 && searchResults.custom.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-4">
                No emoji found
              </p>
            )}
            {searchResults.standard.length > 0 && (
              <>
                <p className="text-xs text-muted-foreground mb-1 px-1">Standard</p>
                <div className="grid grid-cols-8 gap-0.5">
                  {searchResults.standard.map((emoji) => {
                    const base = emoji.replace(/[\u{1F3FB}-\u{1F3FF}]/gu, "");
                    const display = SKIN_TONE_COMPATIBLE.has(base)
                      ? applyTone(base, skinTone)
                      : emoji;
                    return (
                      <button
                        key={emoji}
                        onClick={() => handleSelect(display)}
                        className="text-xl p-1 rounded hover:bg-muted transition-colors leading-none flex items-center justify-center"
                        data-testid={`emoji-option-${emoji}`}
                      >
                        {display}
                      </button>
                    );
                  })}
                </div>
              </>
            )}
            {searchResults.custom.length > 0 && (
              <>
                <p className="text-xs text-muted-foreground mt-2 mb-1 px-1">Custom</p>
                <div className="grid grid-cols-8 gap-0.5">
                  {searchResults.custom.map((e) => (
                    <button
                      key={e.id}
                      onClick={() => handleSelect(`:${e.name}:`)}
                      title={`:${e.name}:`}
                      className="p-1 rounded hover:bg-muted transition-colors leading-none flex items-center justify-center"
                      data-testid={`emoji-custom-${e.name}`}
                    >
                      <img
                        src={e.imageUrl}
                        alt={`:${e.name}:`}
                        className="w-5 h-5 object-contain rounded-sm"
                      />
                    </button>
                  ))}
                </div>
              </>
            )}
          </>
        )}

        {/* Frequently used */}
        {!searchResults && resolvedActive === CATEGORY_FREQUENTLY_USED && (
          <>
            {frequentlyUsed.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">
                No recently used emoji yet
              </p>
            ) : (
              <div className="grid grid-cols-8 gap-0.5">
                {frequentlyUsed.map(({ emoji }) => {
                  const isCustom = /^:[a-zA-Z0-9_-]{2,64}:$/.test(emoji);
                  if (isCustom) {
                    const name = emoji.slice(1, -1);
                    const custom = customEmoji.find((e) => e.name === name);
                    return (
                      <button
                        key={emoji}
                        onClick={() => handleSelect(emoji)}
                        title={emoji}
                        className="p-1 rounded hover:bg-muted transition-colors leading-none flex items-center justify-center"
                        data-testid={`emoji-freq-${name}`}
                      >
                        {custom ? (
                          <img
                            src={custom.imageUrl}
                            alt={emoji}
                            className="w-5 h-5 object-contain rounded-sm"
                          />
                        ) : (
                          <span className="text-xs text-muted-foreground">{emoji}</span>
                        )}
                      </button>
                    );
                  }
                  return (
                    <button
                      key={emoji}
                      onClick={() => handleSelect(emoji)}
                      title={emoji}
                      className="text-xl p-1 rounded hover:bg-muted transition-colors leading-none flex items-center justify-center"
                      data-testid={`emoji-freq-${emoji}`}
                    >
                      {emoji}
                    </button>
                  );
                })}
              </div>
            )}
          </>
        )}

        {/* Standard category */}
        {!searchResults &&
          resolvedActive !== CATEGORY_FREQUENTLY_USED &&
          resolvedActive !== CATEGORY_CUSTOM && (() => {
            const cat = STANDARD_CATEGORIES.find((c) => c.label === resolvedActive);
            if (!cat) return null;
            return (
              <div className="grid grid-cols-8 gap-0.5">
                {cat.emojis.map((emoji) => {
                  const base = emoji.replace(/[\u{1F3FB}-\u{1F3FF}]/gu, "");
                  const display = SKIN_TONE_COMPATIBLE.has(base)
                    ? applyTone(base, skinTone)
                    : emoji;
                  return (
                    <button
                      key={emoji}
                      onClick={() => handleSelect(display)}
                      className="text-xl p-1 rounded hover:bg-muted transition-colors leading-none flex items-center justify-center"
                      data-testid={`emoji-option-${emoji}`}
                    >
                      {display}
                    </button>
                  );
                })}
              </div>
            );
          })()}

        {/* Custom emoji tab */}
        {!searchResults && resolvedActive === CATEGORY_CUSTOM && (
          <div>
            {customEmoji.length === 0 ? (
              <div className="py-4 text-center">
                <Smile className="h-8 w-8 text-muted-foreground/40 mx-auto mb-2" />
                <p className="text-sm text-muted-foreground">No custom emoji yet</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Upload via the Emoji Manager
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-8 gap-0.5">
                {customEmoji.map((e) => (
                  <button
                    key={e.id}
                    onClick={() => handleSelect(`:${e.name}:`)}
                    title={`:${e.name}:`}
                    className="p-1 rounded hover:bg-muted transition-colors leading-none flex items-center justify-center"
                    data-testid={`emoji-custom-${e.name}`}
                  >
                    <img
                      src={e.imageUrl}
                      alt={`:${e.name}:`}
                      className="w-5 h-5 object-contain rounded-sm"
                    />
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── AnchoredPortalPanel ─────────────────────────────────────────────────────

/**
 * Portal-rendered floating panel anchored to a trigger element, clamped to the
 * viewport so it is never clipped by an ancestor overflow boundary (e.g. the
 * 300px comms popup windows, or narrow viewports). Prefers opening above the
 * anchor, right-aligned; flips below / shifts left as needed.
 */
export function AnchoredPortalPanel({
  anchorRef,
  onDismiss,
  children,
  testId,
}: {
  anchorRef: React.RefObject<HTMLElement | null>;
  onDismiss: () => void;
  children: React.ReactNode;
  testId?: string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const compute = () => {
      const anchor = anchorRef.current;
      const panel = panelRef.current;
      if (!anchor || !panel) return;
      const a = anchor.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const margin = 8;
      const pw = panel.offsetWidth;
      // The panel is capped to the viewport via maxHeight, so position with
      // the effective (clamped) height — on very short screens the raw
      // offsetHeight may equal the cap already, but clamp defensively.
      const ph = Math.min(panel.offsetHeight, Math.max(vh - margin * 2, 0));
      let left = a.right - pw;
      left = Math.min(Math.max(left, margin), Math.max(vw - pw - margin, margin));
      let top = a.top - ph - 4;
      if (top < margin) {
        top = Math.min(a.bottom + 4, Math.max(vh - ph - margin, margin));
      }
      // Never let the panel extend past the viewport top/bottom.
      top = Math.min(Math.max(top, margin), Math.max(vh - ph - margin, margin));
      setPos({ top, left });
    };
    compute();
    // Intentional JS resize listener (audit P2-9): the portal panel is
    // positioned from measured anchor/panel rects and clamped to the
    // viewport — anchored-portal geometry CSS cannot express.
    window.addEventListener("resize", compute);
    window.addEventListener("scroll", compute, true);
    // The panel's content can grow after mount (e.g. the full EmojiPicker's
    // queries resolve and the grid renders). Re-clamp on any panel size
    // change or a grown panel can extend past the viewport bottom on short
    // screens (caught by tests/emoji-panel-short-viewport-browser.test.ts).
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined" && panelRef.current) {
      ro = new ResizeObserver(compute);
      ro.observe(panelRef.current);
    }
    return () => {
      window.removeEventListener("resize", compute);
      window.removeEventListener("scroll", compute, true);
      ro?.disconnect();
    };
  }, [anchorRef]);

  useEffect(() => {
    function handler(e: MouseEvent) {
      const t = e.target as Node;
      if (panelRef.current?.contains(t)) return;
      if (anchorRef.current?.contains(t)) return;
      onDismiss();
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onDismiss, anchorRef]);

  return createPortal(
    <div
      ref={panelRef}
      className="fixed z-[100] overflow-y-auto"
      style={{
        maxHeight: "calc(100vh - 16px)",
        ...(pos ? { top: pos.top, left: pos.left } : { top: -9999, left: -9999 }),
      }}
      data-testid={testId}
    >
      {children}
    </div>,
    document.body,
  );
}

// ─── useCustomEmojiMap ────────────────────────────────────────────────────────

/**
 * Returns a stable Record<name, imageUrl> map for all custom emoji.
 * Used by renderContent to resolve :name: tokens in messages and reactions.
 */
export function useCustomEmojiMap(): Record<string, string> {
  const { data = [] } = useQuery<CustomEmojiItem[]>({
    queryKey: ["/api/comms/emoji"],
    queryFn: () =>
      fetch("/api/comms/emoji", { credentials: "include" }).then((r) =>
        r.ok ? r.json() : [],
      ),
    staleTime: 60_000,
  });
  const map: Record<string, string> = {};
  for (const e of data) {
    map[e.name] = e.imageUrl;
  }
  return map;
}
