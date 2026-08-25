// Close an open popover when the user clicks outside it or presses Escape.
//
// Used by the AM Dashboard card's ⚠ badge — and positioned for the client
// profile's alerts chip to adopt later, so the two dropdowns dismiss
// identically: they render the same alert list, and having one close on Escape
// but not the other is the kind of drift nobody notices in review and
// everybody notices in use.
//
// Listens on mousedown (not click) so the menu closes on press rather than
// release — otherwise a press that starts outside and releases inside would
// leave it open.
//
// Adaptation from the reference hook: the close callback rides a ref instead
// of an eslint-disable on the dependency list — same "re-bind only when `open`
// flips" behaviour, without a new exhaustive-deps hit.

import { useEffect, useRef } from "react";
import type { RefObject } from "react";

export function useOutsideClose(
  open: boolean,
  ref: RefObject<HTMLElement | null>,
  close: () => void,
): void {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) closeRef.current();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") closeRef.current();
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, ref]);
}
