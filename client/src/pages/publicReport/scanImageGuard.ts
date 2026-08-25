/**
 * Task #4544 — render guard for map-ranking scan imagery.
 *
 * A GBP location's `heatmapImageUrl` historically rendered whatever object was
 * stored — for one real client that was a 2254×2271 portrait HEADSHOT, shown
 * as a "Local map visibility scan" (and served full-size for 56px thumbnails).
 * Aspect-ratio alone cannot catch it (the photo is ~square), but the served
 * Content-Type can: map scans are screenshots (image/png / image/webp — the
 * claim endpoint enforces this at upload since Task #4544; the sniffed MIME is
 * stamped onto the object since Task #3964, and browser-set types cover older
 * uploads), while camera photos serve as image/jpeg / image/heic.
 *
 * `useScanImageStatus` HEAD-probes an `/objects/` URL once (module-level
 * cache) and classifies it. While pending or invalid, callers render an
 * explicit "scan pending" state instead of the stored image. Policy:
 *   - Only same-origin `/objects/` uploads are renderable at all — that is
 *     the sole URL shape the claim endpoint mints, and the only one whose
 *     Content-Type our own serving route controls. Anything else (external
 *     hosts, data: URIs) fails CLOSED: its MIME contract is unenforceable.
 *   - Probes that fail at the network layer fail OPEN (a flaky connection
 *     must not blank a legitimate scan); a served non-scan Content-Type or an
 *     error status fails CLOSED.
 */
import { useEffect, useState } from "react";
import { classifyScanProbe, heatmapThumbPath, isProbeableScanUrl } from "@shared/heatmapScan";

export type ScanImageStatus = "pending" | "valid" | "invalid";

/** Thumbnail-variant URL for a stored scan (falls back to the original). */
export function scanThumbUrl(url: string): string {
  return heatmapThumbPath(url) ?? url;
}

// One verdict per URL per page load — a report renders the same object in the
// thumbnail card AND the scan slot.
const probeCache = new Map<string, ScanImageStatus | Promise<ScanImageStatus>>();

/** Test seam: reset the module-level probe cache between test cases. */
export function __resetScanProbeCacheForTest(): void {
  probeCache.clear();
}

async function probeScanUrl(url: string): Promise<ScanImageStatus> {
  try {
    const res = await fetch(url, { method: "HEAD" });
    return classifyScanProbe({ ok: res.ok, contentType: res.headers.get("content-type") });
  } catch {
    // Network-layer failure: fail open — the <img> itself will error out if
    // the object is genuinely unreachable.
    return "valid";
  }
}

/**
 * Probe status for a stored heatmap URL. Non-`/objects/` URLs fail CLOSED
 * (only claimed uploads have an enforceable Content-Type contract);
 * `/objects/` URLs stay "pending" until the HEAD probe classifies them. The
 * returned status is derived from the CURRENT url on every render — swapping
 * the url resets to "pending" synchronously, so a stale "valid" verdict can
 * never flash a replacement image before its own probe resolves.
 */
export function useScanImageStatus(url: string | undefined): ScanImageStatus {
  // Verdict for the LAST url this instance probed; ignored once url changes.
  const [probed, setProbed] = useState<{ url: string; status: ScanImageStatus } | null>(null);

  useEffect(() => {
    if (!url || !isProbeableScanUrl(url)) return;
    let cancelled = false;
    const existing = probeCache.get(url);
    if (typeof existing === "string") {
      setProbed({ url, status: existing });
      return;
    }
    const promise = existing ?? probeScanUrl(url).then((verdict) => {
      probeCache.set(url, verdict);
      return verdict;
    });
    if (!existing) probeCache.set(url, promise);
    void promise.then((verdict) => {
      if (!cancelled) setProbed({ url, status: verdict });
    });
    return () => {
      cancelled = true;
    };
  }, [url]);

  if (!url || !isProbeableScanUrl(url)) return "invalid";
  const cached = probeCache.get(url);
  if (typeof cached === "string") return cached;
  return probed?.url === url ? probed.status : "pending";
}
