// -------------------------------------------------------------------------------------
// GlobalCommandPalette — app-wide ⌘K quick-jump shell (Task #4376, audit §8.4-a/§3.7)
// -------------------------------------------------------------------------------------
// Eager half of the global command palette: the window Cmd/Ctrl+K listener and
// the visible header affordance. The cmdk dialog itself (and the client list
// query) live in GlobalCommandPaletteDialog, lazy-loaded on first open so cmdk
// stays out of the entry chunk.
//
// Mounted by GlobalAppNav, which only renders for authenticated users on
// internal routes — so the shortcut is automatically inert on public surfaces
// (/share/, /book/, …) and while logged out.
//
// Shortcut coexistence: on /ads-os the module palette keeps ⌘K (AdsOsShell),
// on /comms the channel search keeps it (CommsSidebar). The affordance button
// still opens the GLOBAL palette on those pages, so cross-app jumps stay one
// click away. See globalPaletteOwnsShortcut in globalPaletteCore.
// -------------------------------------------------------------------------------------

import { Suspense, useEffect, useState } from "react";
import { useLocation } from "wouter";
import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { lazyWithRetry } from "@/lib/lazyWithRetry";
import {
  globalPaletteOwnsShortcut,
  isApplePlatform,
  isEditableShortcutTarget,
} from "@/components/globalPaletteCore";
import type { QuicklinkItem } from "@/components/QuicklinksBar";

const GlobalCommandPaletteDialog = lazyWithRetry(
  () => import("@/components/GlobalCommandPaletteDialog"),
);

export function GlobalCommandPalette({ items }: { items: QuicklinkItem[] }) {
  const [pathname] = useLocation();
  const [open, setOpen] = useState(false);
  // Latches true on first open so the lazy chunk mounts once and stays
  // mounted (reopen is instant; closed state is handled by the Dialog).
  const [hasOpened, setHasOpened] = useState(false);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "k") return;
      // Defer to IME composition and to any inner handler that already
      // claimed the combo (e.g. an editor's own Ctrl+K binding).
      if (e.isComposing || e.defaultPrevented) return;
      if (!globalPaletteOwnsShortcut(pathname)) return;
      // When closed, never steal the keystroke from editable controls
      // (comms composer discipline). When already open, ⌘K toggles closed
      // even though focus sits in the palette's own search input.
      if (!open && isEditableShortcutTarget(e.target)) return;
      e.preventDefault();
      setHasOpened(true);
      setOpen((o) => !o);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [pathname, open]);

  const shortcutHint = isApplePlatform() ? "⌘K" : "Ctrl K";

  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        className="text-chrome-foreground hover:bg-chrome-foreground/10 hover:text-chrome-foreground px-2"
        onClick={() => {
          setHasOpened(true);
          setOpen(true);
        }}
        data-testid="button-global-palette"
        aria-label="Open command palette"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={`Jump to… (${shortcutHint})`}
      >
        <Search className="w-4 h-4" aria-hidden="true" />
        <span className="hidden lg:inline ml-1.5">Jump to</span>
        <kbd
          className="hidden lg:inline ml-1.5 text-caption bg-chrome-foreground/15 px-1.5 py-0.5 rounded-pill tracking-wide"
          aria-hidden="true"
        >
          {shortcutHint}
        </kbd>
      </Button>
      {hasOpened && (
        <Suspense fallback={null}>
          <GlobalCommandPaletteDialog open={open} onOpenChange={setOpen} items={items} />
        </Suspense>
      )}
    </>
  );
}
