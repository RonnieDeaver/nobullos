import { useEffect, useState } from "react";

/**
 * useIsMobile — breakpoint flag driven by the CSS media-query engine
 * (`matchMedia`) instead of a per-pixel `resize` listener, so consumers
 * re-render only when the breakpoint actually flips.
 *
 * Audit P2-9 (§4.4) context: prefer real CSS media/container queries for
 * styling. This hook exists ONLY for what CSS cannot express — deciding
 * whether to MOUNT a component tree at all. SheetEditor/DocEditor use it to
 * skip loading the heavy lazy Univer bundle entirely on phones and render a
 * lightweight warning instead; a CSS show/hide would still boot the editor.
 *
 * Environments without a functional `matchMedia` (SSR, bare jsdom harnesses
 * that don't stub it) fall back to a one-shot `window.innerWidth` check with
 * no listener — breakpoint flips there require a remount, which is fine for
 * those environments. Test stubs that only implement the legacy
 * `addListener` API are supported.
 */
export function useIsMobile(breakpointPx = 768): boolean {
  const query = `(max-width: ${breakpointPx - 1}px)`;

  const [isMobile, setIsMobile] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    if (typeof window.matchMedia === "function") {
      return window.matchMedia(query).matches;
    }
    return window.innerWidth < breakpointPx;
  });

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const mql = window.matchMedia(query);
    const onChange = () => setIsMobile(mql.matches);
    // Sync once in case the viewport crossed the breakpoint between the
    // state initializer and effect registration (e.g. strict double-mount).
    onChange();
    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    }
    // Legacy engines / test stubs expose only addListener/removeListener.
    const legacy = mql as unknown as {
      addListener?: (cb: () => void) => void;
      removeListener?: (cb: () => void) => void;
    };
    if (typeof legacy.addListener === "function") {
      legacy.addListener(onChange);
      return () => legacy.removeListener?.(onChange);
    }
    return undefined;
  }, [query]);

  return isMobile;
}
