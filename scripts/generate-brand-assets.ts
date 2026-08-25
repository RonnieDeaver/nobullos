/**
 * Task #4618 — canonical in-app NoBull brand asset set.
 *
 * Copies the exact approved artwork from the tracked brand package under
 * `.source/nobull-brand/` into the OS-owned static namespace
 * `client/public/brand/` (byte-exact — never redrawn, recolored, or cropped),
 * then generates the raster identity set from that same artwork:
 *
 *   - client/public/favicon.ico            16+32+48 multi-size, transparent
 *   - client/public/apple-touch-icon.png   180×180 opaque eggshell tile
 *   - client/public/brand/nobull-icon-crimson-192.png  desktop notifications
 *   - client/public/brand/og-nobull-os.png 1200×630 OpenGraph card
 *
 * The bull icon's viewBox is 800×646.32 (non-square). Square frames are
 * produced by PADDING onto a square canvas with the aspect ratio preserved —
 * the brand rules allow resizing exports, never cropping or distorting.
 *
 * Uses rsvg-convert + ImageMagick from the workspace PATH (no npm deps).
 * Outputs are `-strip`ped so a re-run is byte-stable.
 *
 * Run: `npx tsx scripts/generate-brand-assets.ts`
 * Provenance table: client/public/brand/README.md
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const PKG = join(ROOT, ".source/nobull-brand/Brand Files/NoBull Logo Package");
const PUBLIC_DIR = join(ROOT, "client/public");
const BRAND_DIR = join(PUBLIC_DIR, "brand");

/** Mirrors --background (v2 Eggshell #EEE8DC) in client/src/index.css — static
 * image composition can't resolve CSS variables, so the literal is pinned here
 * with this naming comment (loader-style sanctioned pattern). */
const EGGSHELL = "#EEE8DC";

const SVG_COPIES: ReadonlyArray<readonly [src: string, dest: string]> = [
  ["Primary Logo/RGB (Web)/NoBull.Primary.Logo.RGB.svg", "nobull-logo-full-color.svg"],
  ["Primary Logo/Black/NoBull.Primary.Logo.Black.svg", "nobull-logo-black.svg"],
  ["Primary Logo/White/NoBull.Primary.Logo.White.svg", "nobull-logo-white.svg"],
  ["Icon/Crimson/RGB (Web)/NoBull.Crimson.Icon.RGB.svg", "nobull-icon-crimson.svg"],
  ["Icon/Black/NoBull.Crimson.Icon.Black.svg", "nobull-icon-black.svg"],
  ["Icon/White/NoBull.Crimson.Icon.White.svg", "nobull-icon-white.svg"],
  ["Icon/Earth/RGB (Web)/NoBull.Icon.Earth.RGB.svg", "nobull-icon-earth.svg"],
];

function run(cmd: string, args: string[]): void {
  execFileSync(cmd, args, { stdio: "inherit" });
}

/** Render an SVG to a PNG of the given pixel width (height follows aspect). */
function renderSvg(svgPath: string, widthPx: number, outPng: string): void {
  run("rsvg-convert", ["-w", String(widthPx), svgPath, "-o", outPng]);
}

/** Pad a rendered PNG onto a square canvas (centered, aspect preserved). */
function padSquare(inPng: string, sizePx: number, outPng: string, background: string): void {
  run("magick", [
    inPng,
    "-strip",
    "-background", background,
    "-gravity", "center",
    "-extent", `${sizePx}x${sizePx}`,
    outPng,
  ]);
}

function main(): void {
  if (!existsSync(PKG)) {
    throw new Error(`Brand package not found at ${PKG} — .source/nobull-brand/ must stay tracked.`);
  }
  mkdirSync(BRAND_DIR, { recursive: true });

  // 1) Byte-exact SVG copies (the app-served canonical set).
  for (const [src, dest] of SVG_COPIES) {
    copyFileSync(join(PKG, src), join(BRAND_DIR, dest));
    console.log(`copied  brand/${dest}`);
  }

  const crimsonIcon = join(BRAND_DIR, "nobull-icon-crimson.svg");
  const fullColorLogo = join(BRAND_DIR, "nobull-logo-full-color.svg");
  const tmp = mkdtempSync(join(tmpdir(), "nobull-brand-"));
  try {
    // 2) favicon.ico — 16/32/48 transparent squares from the crimson bull.
    const icoParts: string[] = [];
    for (const size of [16, 32, 48]) {
      const raw = join(tmp, `raw-${size}.png`);
      const square = join(tmp, `favicon-${size}.png`);
      renderSvg(crimsonIcon, size, raw);
      padSquare(raw, size, square, "none");
      icoParts.push(square);
    }
    run("magick", [...icoParts, join(PUBLIC_DIR, "favicon.ico")]);
    console.log("wrote   favicon.ico (16+32+48)");

    // 3) apple-touch-icon.png — 180×180 opaque eggshell tile (iOS renders
    //    transparency as black; the eggshell canvas is the brand surface).
    const appleRaw = join(tmp, "apple-raw.png");
    renderSvg(crimsonIcon, 132, appleRaw); // ~73% of the tile, brand-safe margins
    padSquare(appleRaw, 180, join(PUBLIC_DIR, "apple-touch-icon.png"), EGGSHELL);
    console.log("wrote   apple-touch-icon.png (180x180)");

    // 4) 192px notification icon — transparent, HiDPI-crisp raster for the
    //    Notifications API (client/src/components/comms/useDesktopNotifications.ts).
    const notifRaw = join(tmp, "notif-raw.png");
    renderSvg(crimsonIcon, 192, notifRaw);
    padSquare(notifRaw, 192, join(BRAND_DIR, "nobull-icon-crimson-192.png"), "none");
    console.log("wrote   brand/nobull-icon-crimson-192.png");

    // 5) OpenGraph card — 1200×630 eggshell canvas, full-color primary logo
    //    centered (referenced absolutely from client/index.html).
    const ogLogo = join(tmp, "og-logo.png");
    renderSvg(fullColorLogo, 640, ogLogo);
    run("magick", [
      "-size", "1200x630",
      `xc:${EGGSHELL}`,
      ogLogo,
      "-gravity", "center",
      "-composite",
      "-strip",
      join(BRAND_DIR, "og-nobull-os.png"),
    ]);
    console.log("wrote   brand/og-nobull-os.png (1200x630)");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

main();
