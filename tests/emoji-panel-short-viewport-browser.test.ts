/* test-registration
{
  "name": "Emoji panels really scroll on short phone screens — real Chromium at 480px/230px viewports: panel box stays in-viewport, wrapper genuinely scrolls, last category + last emoji hit-testably clickable (Task #3372)",
  "timeoutMs": 300000,
  "tier": "large",
  "tierReason": "Browser/Chromium harness; it consumes a heavyweight external-process resource lane even when its last measured duration is short."
}
test-registration */
// fs-scan-fixture-only -- serves a tmp-dir esbuild output over localhost; no live repo source is fs-read
/**
 * Task #3372 — confirm the portaled emoji panels REALLY scroll on short phone
 * screens, in a real browser.
 *
 * Task #3346 capped AnchoredPortalPanel to the viewport (maxHeight:
 * calc(100vh - 16px) + overflow-y-auto). The jsdom test
 * (tests/client/emoji-panel-popup-clipping.test.tsx) can only assert that CSS
 * cap exists — jsdom has no layout, so it cannot prove content actually
 * becomes scrollable or that every emoji stays reachable. This test proves it
 * end-to-end with a real rendering engine:
 *
 *   1. Builds a tiny Vite harness (tests/browser/emoji-short-viewport/) that
 *      mounts the REAL MessageItem + real app Tailwind CSS inside a 300px
 *      overflow-hidden "comms popup" pinned to the bottom-right.
 *   2. Serves it and drives headless Chromium (Nix chromium via
 *      puppeteer-core) at a 800×480 viewport (~landscape phone):
 *      (A) the quick emoji panel's rendered box stays inside the viewport
 *          top/bottom and every quick emoji is on-screen and click-hittable;
 *      (B) "More emoji…" opens the full EmojiPicker; its box also stays
 *          inside the viewport; the LAST category tab (Custom) and the last
 *          standard category (Activities) are reachable and its LAST emoji
 *          option (🎪) is on-screen, hit-testable (elementFromPoint), and a
 *          real mouse click fires onReact with that emoji.
 *   3. Shrinks to 800×230 (shorter than the panel's natural height) and
 *      re-opens the full picker:
 *      (C) the panel wrapper is genuinely scrollable (scrollHeight >
 *          clientHeight) and its box stays within the 230px viewport;
 *      (D) after scrolling, the bottom of the panel content is reachable and
 *          the last emoji option still receives a real click.
 *
 * Run: npx tsx tests/emoji-panel-short-viewport-browser.test.ts
 */

import { execSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { readFileSync, existsSync, rmSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import type { AddressInfo } from "node:net";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

const HARNESS_DIR = resolve(process.cwd(), "tests/browser/emoji-short-viewport");
const OUT_DIR = "/tmp/emoji-short-viewport-dist";
const MSG_ID = "msg-short-vp-3372";
const LAST_ACTIVITY_EMOJI = "🎪"; // last emoji of the last standard category

function findChromium(): string {
  const fromEnv = process.env.CHROMIUM_PATH;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const found = execSync("which chromium || which chromium-browser", {
    encoding: "utf8",
  })
    .split("\n")[0]
    .trim();
  assert(found, "chromium executable found on PATH");
  return found;
}

async function buildHarness(): Promise<void> {
  rmSync(OUT_DIR, { recursive: true, force: true });
  const { build } = await import("vite");
  const react = (await import("@vitejs/plugin-react")).default;
  const tailwindcss = (await import("@tailwindcss/vite")).default;
  await build({
    configFile: false,
    logLevel: "warn",
    plugins: [react(), tailwindcss()],
    // No postcss config exists at the repo root any more (removed in the
    // code-health prune — Tailwind v4 runs via the vite plugin); keep the
    // inline empty config, like the app's vite.config.ts, so
    // postcss-load-config never goes searching up-tree.
    css: { postcss: { plugins: [] } },
    resolve: {
      alias: {
        // MessageItem reads only `userStatuses` from CommsContext; the real
        // provider is heavy (auth/SSE) and irrelevant to panel scrolling.
        "@/contexts/CommsContext": resolve(HARNESS_DIR, "comms-context-shim.tsx"),
        "@": resolve(process.cwd(), "client", "src"),
        "@shared": resolve(process.cwd(), "shared"),
      },
    },
    root: HARNESS_DIR,
    build: { outDir: OUT_DIR, emptyOutDir: true },
  });
  assert(existsSync(join(OUT_DIR, "index.html")), "harness build produced index.html");
}

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

function serveDist(): Promise<{ server: Server; base: string }> {
  return new Promise((res) => {
    const server = createServer((req, resp) => {
      const urlPath = (req.url || "/").split("?")[0];
      const filePath = join(OUT_DIR, urlPath === "/" ? "index.html" : urlPath);
      if (!filePath.startsWith(OUT_DIR) || !existsSync(filePath)) {
        resp.writeHead(404);
        resp.end("not found");
        return;
      }
      resp.writeHead(200, {
        "Content-Type": MIME[extname(filePath)] || "application/octet-stream",
      });
      resp.end(readFileSync(filePath)); // fs-scan-inputs-ignore -- serves the OUT_DIR build produced by this run; startsWith(OUT_DIR) guard above confines it
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      res({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

type Page = import("puppeteer-core").Page;

async function rectOf(page: Page, selector: string) {
  return page.$eval(selector, (el) => {
    const r = (el as HTMLElement).getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height };
  });
}

/** Real mouse click at the element's center, verifying the point actually
 *  hits the element (or a descendant) — true reachability, not el.click(). */
async function hitClick(page: Page, selector: string, label: string): Promise<void> {
  // AnchoredPortalPanel re-clamps position when its content resizes (e.g.
  // right after a category grid renders), so measured coordinates can go
  // stale for a frame or two. Retry until the geometry settles.
  const vp = page.viewport()!;
  let x = 0;
  let y = 0;
  let hit = false;
  for (let attempt = 0; attempt < 10; attempt++) {
    await page.$eval(selector, (el) =>
      (el as HTMLElement).scrollIntoView({ block: "nearest", inline: "nearest" }),
    );
    const r1 = await rectOf(page, selector);
    await new Promise((res) => setTimeout(res, 80));
    const r = await rectOf(page, selector);
    const stable = Math.abs(r.top - r1.top) < 0.5 && Math.abs(r.left - r1.left) < 0.5;
    x = (r.left + r.right) / 2;
    y = (r.top + r.bottom) / 2;
    if (stable && y >= 0 && y <= vp.height && x >= 0 && x <= vp.width) {
      hit = await page.evaluate(
        ({ x, y, selector }) => {
          const target = document.querySelector(selector);
          const at = document.elementFromPoint(x, y);
          return !!(target && at && (target === at || target.contains(at)));
        },
        { x, y, selector },
      );
      if (hit) break;
    }
    await new Promise((res) => setTimeout(res, 100));
  }
  assert(
    y >= 0 && y <= vp.height && x >= 0 && x <= vp.width,
    `${label}: center point (${x.toFixed(1)},${y.toFixed(1)}) is inside the ${vp.width}x${vp.height} viewport`,
  );
  assert(hit, `${label}: elementFromPoint at its center hits the element (not occluded/clipped)`);
  await page.mouse.click(x, y);
}

async function openQuickPanel(page: Page): Promise<void> {
  const triggerSel = `[data-testid="emoji-trigger-${MSG_ID}"]`;
  await page.waitForSelector(triggerSel);
  // The hover toolbar is opacity-0/pointer-events-none until the message row
  // is hovered or focused. Headless Chromium reports `hover: none`, so
  // Tailwind's hover: variants never match — use the real keyboard-focus
  // path instead (group-focus-within:opacity-100 + pointer-events-auto),
  // exactly what a keyboard user gets.
  await page.focus(triggerSel);
  await new Promise((res) => setTimeout(res, 100));
  const r = await rectOf(page, triggerSel);
  await page.mouse.click((r.left + r.right) / 2, (r.top + r.bottom) / 2);
  await page.waitForSelector(`[data-testid="quick-emoji-panel-${MSG_ID}"]`);
}

async function openFullPicker(page: Page): Promise<void> {
  await openQuickPanel(page);
  const moreSel = `[data-testid="quick-emoji-panel-${MSG_ID}"] button ::-p-text(More emoji)`;
  const more = await page.waitForSelector(moreSel);
  assert(more, '"More emoji…" button present');
  const box = await more!.boundingBox();
  assert(box, '"More emoji…" has a rendered box');
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.waitForSelector(`[data-testid="full-emoji-panel-${MSG_ID}"]`);
}

async function main() {
  const chromium = findChromium();
  console.log(`Using chromium: ${chromium}`);
  console.log("Building harness with Vite (real app Tailwind CSS)…");
  await buildHarness();
  const { server, base } = await serveDist();

  const puppeteer = (await import("puppeteer-core")).default;
  const browser = await puppeteer.launch({
    executablePath: chromium,
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 800, height: 480 });
    await page.goto(base, { waitUntil: "networkidle0" });
    await page.waitForFunction("window.__harnessReady === true");

    const panelSel = `[data-testid="full-emoji-panel-${MSG_ID}"]`;
    const quickSel = `[data-testid="quick-emoji-panel-${MSG_ID}"]`;

    // ── (A) 480px-tall viewport: quick panel inside the viewport ────────────
    await openQuickPanel(page);
    let qr = await rectOf(page, quickSel);
    assert(qr.top >= 0, `quick panel top ${qr.top.toFixed(1)} >= 0 at 480px viewport`);
    assert(qr.bottom <= 480, `quick panel bottom ${qr.bottom.toFixed(1)} <= 480`);
    const quickEmojis: string[] = await page.$$eval(
      `${quickSel} [data-testid^="quick-emoji-"]`,
      (els) => els.map((e) => e.getAttribute("data-testid")!.replace("quick-emoji-", "")),
    );
    assert(quickEmojis.length >= 8, `all quick emojis rendered (got ${quickEmojis.length})`);
    for (const e of quickEmojis) {
      const er = await rectOf(page, `${quickSel} [data-testid="quick-emoji-${e}"]`);
      assert(
        er.top >= 0 && er.bottom <= 480,
        `quick emoji ${e} fully on-screen (top ${er.top.toFixed(1)}, bottom ${er.bottom.toFixed(1)})`,
      );
    }
    console.log("  ok - (A) quick panel + all quick emojis on-screen at 480px");

    // ── (B) full picker at 480px: box in viewport; last category + last emoji
    // reachable and really clickable ─────────────────────────────────────────
    const moreSel = `${quickSel} button ::-p-text(More emoji)`;
    const more = await page.waitForSelector(moreSel);
    const mb = await more!.boundingBox();
    await page.mouse.click(mb!.x + mb!.width / 2, mb!.y + mb!.height / 2);
    await page.waitForSelector(panelSel);
    let pr = await rectOf(page, panelSel);
    assert(pr.top >= 0, `full picker top ${pr.top.toFixed(1)} >= 0 at 480px`);
    assert(pr.bottom <= 480, `full picker bottom ${pr.bottom.toFixed(1)} <= 480`);

    // Last tab in the strip is Custom — reachable (horizontal scroll allowed).
    await hitClick(page, `${panelSel} [data-testid="emoji-cat-__custom__"]`, "Custom (last) category tab");
    await page.waitForFunction(
      (sel: string) => document.querySelector(sel)!.textContent!.includes("No custom emoji yet"),
      {},
      panelSel,
    );
    // Last STANDARD category (Activities) then its last emoji option.
    await hitClick(page, `${panelSel} [data-testid="emoji-cat-Activities"]`, "Activities category tab");
    const lastOptSel = `${panelSel} [data-testid="emoji-option-${LAST_ACTIVITY_EMOJI}"]`;
    await page.waitForSelector(lastOptSel);
    await hitClick(page, lastOptSel, `last Activities emoji ${LAST_ACTIVITY_EMOJI}`);
    let reactions = await page.evaluate(() => (window as any).__reactions);
    assert(
      reactions.length === 1 && reactions[0].emoji === LAST_ACTIVITY_EMOJI,
      `real click on the last emoji fired onReact with ${LAST_ACTIVITY_EMOJI} (got ${JSON.stringify(reactions)})`,
    );
    const closed = await page.$(panelSel);
    assert(!closed, "full picker closed after selecting");
    console.log("  ok - (B) full picker in-viewport at 480px; last category + last emoji really clickable");

    // ── (C) 230px-tall viewport: the wrapper must genuinely scroll ──────────
    await page.setViewport({ width: 800, height: 230 });
    await new Promise((res) => setTimeout(res, 150));
    await openFullPicker(page);
    pr = await rectOf(page, panelSel);
    assert(pr.top >= 0, `full picker top ${pr.top.toFixed(1)} >= 0 at 230px viewport`);
    assert(pr.bottom <= 230, `full picker bottom ${pr.bottom.toFixed(1)} <= 230 (capped, not clipped)`);
    const scrollInfo = await page.$eval(panelSel, (el) => ({
      scrollHeight: (el as HTMLElement).scrollHeight,
      clientHeight: (el as HTMLElement).clientHeight,
      overflowY: getComputedStyle(el as HTMLElement).overflowY,
    }));
    assert(
      scrollInfo.overflowY === "auto",
      `panel wrapper computed overflow-y is auto (got ${scrollInfo.overflowY})`,
    );
    assert(
      scrollInfo.scrollHeight > scrollInfo.clientHeight,
      `panel content REALLY overflows at 230px (scrollHeight ${scrollInfo.scrollHeight} > clientHeight ${scrollInfo.clientHeight})`,
    );
    console.log(
      `  ok - (C) at 230px the panel wrapper genuinely scrolls (${scrollInfo.scrollHeight} > ${scrollInfo.clientHeight})`,
    );

    // ── (D) scroll to the bottom: content end reachable; last emoji clickable
    await page.$eval(panelSel, (el) => {
      (el as HTMLElement).scrollTop = (el as HTMLElement).scrollHeight;
    });
    const atBottom = await page.$eval(panelSel, (el) => {
      const e = el as HTMLElement;
      return e.scrollTop + e.clientHeight >= e.scrollHeight - 1;
    });
    assert(atBottom, "wrapper scrolls all the way to the bottom of the panel content");
    await hitClick(page, `${panelSel} [data-testid="emoji-cat-Activities"]`, "Activities tab at 230px");
    const lastSel = `${panelSel} [data-testid="emoji-option-${LAST_ACTIVITY_EMOJI}"]`;
    await page.waitForSelector(lastSel);
    await hitClick(page, lastSel, `last emoji ${LAST_ACTIVITY_EMOJI} at 230px`);
    reactions = await page.evaluate(() => (window as any).__reactions);
    assert(
      reactions.length === 2 && reactions[1].emoji === LAST_ACTIVITY_EMOJI,
      `last emoji really clickable at 230px viewport (got ${JSON.stringify(reactions)})`,
    );
    console.log("  ok - (D) after scrolling, the last emoji option is reachable and really clickable at 230px");

    console.log("All real-browser emoji short-viewport assertions passed.");
  } finally {
    await browser.close();
    server.close();
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
