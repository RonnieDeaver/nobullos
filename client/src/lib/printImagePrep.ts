// Print image preparation (Task #4288 — print/PDF overhaul).
//
// The report print/PDF embeds every <img> at its ORIGINAL resolution: the
// GBP heatmap scans are ~2254px JPEGs (~1.4MB each) displayed at 56px, which
// alone made the shared PDF ~4.4MB. Before printing we swap annotated images
// (`data-print-downscale="<css px>"`) to a canvas-downscaled data URL sized
// for print, and restore the originals when print mode ends.
//
// Wiring: PublicReport registers these through the generic print-preparation
// registry in heatmapPrintRegistry (async preparer for the Save-as-PDF
// sequence, sync preparer for browser-native beforeprint), so every print
// path — share /print route, in-page button, Cmd+P, headless printToPDF —
// goes through the same swap/restore cycle as the heatmap snapshots.
//
// Failure policy: a single image failing to downscale (decode failure,
// tainted canvas, zero dimensions) must never block printing — that image
// simply prints at original resolution. Everything else stays loud.

/** Bitmap pixels per CSS px in print — ~288dpi effective, crisp on paper. */
const PRINT_SCALE = 3;
/** Only bother downscaling when the source is meaningfully larger. */
const SKIP_RATIO = 1.25;
/** JPEG quality for opaque downscales. */
const JPEG_QUALITY = 0.82;

/** origSrc|targetPx|format -> downscaled data URL */
const cache = new Map<string, string>();
/** Images currently swapped to a downscaled src, with their original src. */
const swapped = new Map<HTMLImageElement, string>();

function targetPxFor(img: HTMLImageElement): number | null {
  const raw = img.getAttribute("data-print-downscale");
  if (raw === null) return null;
  const cssPx = Number(raw);
  if (!Number.isFinite(cssPx) || cssPx <= 0) return null;
  return Math.round(cssPx * PRINT_SCALE);
}

function downscaleToDataUrl(img: HTMLImageElement, targetPx: number): string | null {
  const { naturalWidth, naturalHeight } = img;
  if (!naturalWidth || !naturalHeight) return null;
  if (naturalWidth <= targetPx * SKIP_RATIO) return null;

  const preserveAlpha = img.hasAttribute("data-print-alpha");
  const format = preserveAlpha ? "image/png" : "image/jpeg";
  const key = `${img.src}|${targetPx}|${format}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const w = targetPx;
  const h = Math.round((naturalHeight / naturalWidth) * targetPx);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  if (!preserveAlpha) {
    // JPEG has no alpha channel — composite onto white so any transparent
    // pixels don't turn black.
    // Paper-white flatten for JPEG re-encode (named color: the design-hex
    // ratchet tracks UI palette hexes; this is print output, not UI chrome).
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, w, h);
  }
  ctx.drawImage(img, 0, 0, w, h);
  let dataUrl: string;
  try {
    dataUrl = canvas.toDataURL(format, JPEG_QUALITY);
  } catch {
    // Tainted canvas (cross-origin source) — print the original instead.
    return null;
  }
  cache.set(key, dataUrl);
  return dataUrl;
}

function swapImage(img: HTMLImageElement): string | null {
  if (swapped.has(img)) return null; // already swapped
  const targetPx = targetPxFor(img);
  if (targetPx === null) return null;
  const dataUrl = downscaleToDataUrl(img, targetPx);
  if (!dataUrl) return null;
  swapped.set(img, img.src);
  img.src = dataUrl;
  return dataUrl;
}

/**
 * Async print preparer: force-load lazy images, then swap each annotated
 * image to its downscaled data URL and wait for it to decode so the print
 * capture never races the swap.
 */
export async function downscaleImagesForPrint(root: ParentNode = document): Promise<void> {
  const imgs = Array.from(root.querySelectorAll<HTMLImageElement>("img[data-print-downscale]"));
  await Promise.all(
    imgs.map(async (img) => {
      try {
        if (!img.complete || !img.naturalWidth) {
          // Lazy images below the fold may not have loaded yet.
          img.loading = "eager";
          await Promise.race([
            new Promise<void>((resolve) => {
              img.addEventListener("load", () => resolve(), { once: true });
              img.addEventListener("error", () => resolve(), { once: true });
            }),
            new Promise<void>((resolve) => setTimeout(resolve, 5000)),
          ]);
        }
        if (swapImage(img) !== null) {
          await img.decode().catch(() => undefined);
        }
      } catch {
        // Per-image fail-open: print the original.
      }
    }),
  );
}

/**
 * Sync print preparer for browser-native beforeprint (Cmd+P, printToPDF):
 * canvas downscale of an already-loaded image is synchronous, so this does
 * the full swap for loaded images and silently skips unloaded ones.
 */
export function downscaleImagesForPrintSync(root: ParentNode = document): void {
  const imgs = root.querySelectorAll<HTMLImageElement>("img[data-print-downscale]");
  imgs.forEach((img) => {
    try {
      if (!img.complete || !img.naturalWidth) return;
      swapImage(img);
    } catch {
      // Per-image fail-open.
    }
  });
}

/** Restore every swapped image to its original src (print mode ended). */
export function restorePrintImages(): void {
  swapped.forEach((originalSrc, img) => {
    try {
      img.src = originalSrc;
    } catch {
      // Detached image — nothing to restore.
    }
  });
  swapped.clear();
}

/**
 * Encode a (possibly WebGL) canvas for print as a white-composited JPEG,
 * capped at `maxWidth` bitmap px. PNG snapshots of full-bleed map canvases
 * weigh several MB in the PDF; map tiles are opaque photography-like
 * content, so JPEG is the right container. WebGL canvases can carry an
 * alpha channel — compositing onto white first keeps those pixels from
 * going black. Returns null when the canvas is unusable (zero size,
 * tainted), so callers can fall back to their previous behavior.
 */
export function encodeCanvasForPrint(
  source: HTMLCanvasElement,
  maxWidth = 1600,
  quality = 0.85,
): string | null {
  const { width, height } = source;
  if (!width || !height) return null;
  const scale = Math.min(1, maxWidth / width);
  const w = Math.round(width * scale);
  const h = Math.round(height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  // Paper-white flatten (named color — see note above).
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, w, h);
  try {
    ctx.drawImage(source, 0, 0, w, h);
    return canvas.toDataURL("image/jpeg", quality);
  } catch {
    // Tainted or unreadable source canvas.
    return null;
  }
}

/** Test seam: inspect/clear module state. */
export function __printImagePrepState() {
  return { cacheSize: cache.size, swappedCount: swapped.size };
}
export function __resetPrintImagePrep(): void {
  cache.clear();
  swapped.clear();
}
