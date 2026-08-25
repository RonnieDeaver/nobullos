// Collision-aware placement contract for the global floating comms button
// (CommsRail's FloatingCommsButton, Task #4374). Bottom-pinned interactive
// controls that occupy the button's bottom-right corner lane mark themselves
// with `ref={fabColliderRef}`; the button scans marked elements and lifts
// itself above any that intersect its lane so it never covers them.
//
// Purely presentational: a passive DOM attribute plus a window event. No
// shared state, stores, or context — colliders don't know about the button
// and the button only reads the DOM.

export const FAB_COLLIDER_ATTR = "data-fab-collider";
export const FAB_COLLIDERS_CHANGED_EVENT = "nobull:fab-colliders-changed";

export function notifyFabCollidersChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(FAB_COLLIDERS_CHANGED_EVENT));
}

/**
 * React ref callback: marks the element as a FAB collider on mount and
 * notifies the floating button on both mount and unmount so it re-measures.
 * Safe to share across elements (it keeps no per-element state).
 */
export function fabColliderRef(node: HTMLElement | null): void {
  if (node) node.setAttribute(FAB_COLLIDER_ATTR, "");
  notifyFabCollidersChanged();
}

/**
 * Imperatively marks bottom-pinned vendor controls inside `root` (e.g. the
 * Univer sheet-tab/status bars on the mobile read-only view — Task #4610,
 * per the Univer-editors section of
 * audits/task-4374-fab-collision-2026-08/README.md) so the floating comms
 * button lifts above them. Vendor DOM renders asynchronously after the
 * wrapper mounts, so this retries a few times and stops early once anything
 * is marked. Geometry-based (wide, short, hugging the viewport bottom)
 * because vendor class names are not a stable contract.
 */
export function markBottomPinnedVendorColliders(root: HTMLElement | null): void {
  if (!root || typeof window === "undefined") return;

  const attempt = (): boolean => {
    if (!root.isConnected) return true; // page navigated away — stop retrying
    const viewportBottom = window.innerHeight;
    const rootRect = root.getBoundingClientRect();
    if (rootRect.width === 0) return false;
    let marked = false;
    for (const el of Array.from(root.querySelectorAll<HTMLElement>("*"))) {
      if (el.hasAttribute(FAB_COLLIDER_ATTR)) {
        marked = true;
        continue;
      }
      const rect = el.getBoundingClientRect();
      const isBottomBar =
        rect.height > 0 &&
        rect.height <= 96 &&
        rect.width >= rootRect.width * 0.5 &&
        viewportBottom - rect.bottom <= 24 &&
        rect.top > viewportBottom / 2;
      if (isBottomBar) {
        el.setAttribute(FAB_COLLIDER_ATTR, "");
        marked = true;
      }
    }
    if (marked) notifyFabCollidersChanged();
    return marked;
  };

  // Vendor bars appear some time after init; retry on a short backoff.
  const delays = [0, 300, 1000, 2500];
  const tryAt = (i: number) => {
    if (i >= delays.length) return;
    window.setTimeout(() => {
      if (!attempt()) tryAt(i + 1);
    }, delays[i]);
  };
  tryAt(0);
}
