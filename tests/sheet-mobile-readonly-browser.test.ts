/* test-registration
{
  "name": "Sheet readOnly mode really gates edits — real Chromium at 375x812: control run proves the type-into-cell gesture lands in the document model, readOnly run proves the identical gesture leaves the snapshot untouched and getSnapshot() stays null, transition run proves a pending-lock mount (readOnly=true) flipped to readOnly=false without remount becomes genuinely editable; zero uncaught page errors in every run (Task #4610)",
  "regression": true,
  "sweepOnlyReason": "Real-Chromium test with a full Vite build of the Univer bundle (~2 min wall) — too slow for the routine TEST_SMOKE gate; runs in the full suite and the nightly --regression sweep.",
  "timeoutMs": 300000,
  "tier": "large",
  "tierReason": "Browser/Chromium harness; it consumes a heavyweight external-process resource lane even when its last measured duration is short."
}
test-registration */
// fs-scan-fixture-only -- serves a tmp-dir vite build output over localhost; no live repo source is fs-read
/**
 * Task #4610 — the phone-width Sheets view mounts UniverEditor with
 * readOnly, which relies on Univer 0.25's FWorkbook.setEditable(false)
 * (workbook-permission API). A silently-missing API would leave the sheet
 * locally editable, so this test proves the behavior in a real browser:
 *
 *   1. Builds a tiny Vite harness (tests/browser/sheet-mobile-readonly/)
 *      that mounts the REAL UniverEditor full-viewport; `?readonly=1`
 *      matches SheetEditor's phone mount.
 *   2. Control run (editable) at 375x812: click cell A1, type "XYZ", Enter —
 *      asserts the snapshot's A1 becomes "XYZ". This validates the gesture,
 *      so the read-only run can't pass vacuously because clicking missed.
 *   3. Read-only run: the IDENTICAL gesture — asserts A1 still holds the
 *      seeded "Hello" (attempted edit never reached the document model) and
 *      that the production getSnapshot() returns null (autosave-blind).
 *
 * Run: npx tsx tests/sheet-mobile-readonly-browser.test.ts
 */

import { execSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { readFileSync, existsSync, rmSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import type { AddressInfo } from "node:net";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

const HARNESS_DIR = resolve(process.cwd(), "tests/browser/sheet-mobile-readonly");
const OUT_DIR = "/tmp/sheet-mobile-readonly-dist";

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
  await build({
    configFile: false,
    logLevel: "warn",
    plugins: [react()],
    css: { postcss: { plugins: [] } },
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

type Browser = import("puppeteer-core").Browser;

function cellA1(snapshot: unknown): unknown {
  const sheets = (snapshot as any)?.sheets ?? {};
  const sheet = sheets["s1"] ?? Object.values(sheets)[0];
  return sheet?.cellData?.[0]?.[0]?.v ?? null;
}

/**
 * Clicks cell A1 and types text + Enter. A1's on-canvas position is derived
 * from the sheet canvas's bounding box plus the default header sizes
 * (row-header width ~46px, column-header height ~20px) — the click lands
 * well inside A1's 88x24 default box. The control run asserts this gesture
 * really edits, so a drifted offset fails loudly there, never silently here.
 */
async function attemptEdit(page: import("puppeteer-core").Page, text: string) {
  const box = await page.evaluate(() => {
    // The grid is the largest canvas under the editor container.
    let best: { x: number; y: number; w: number; h: number } | null = null;
    for (const c of Array.from(document.querySelectorAll("canvas"))) {
      const r = c.getBoundingClientRect();
      if (!best || r.width * r.height > best.w * best.h) {
        best = { x: r.left, y: r.top, w: r.width, h: r.height };
      }
    }
    return best;
  });
  assert(box && box.w > 200 && box.h > 200, "sheet grid canvas rendered");
  const x = box!.x + 46 + 40; // inside column A
  const y = box!.y + 20 + 12; // inside row 1
  await page.mouse.click(x, y);
  await new Promise((r) => setTimeout(r, 300));
  await page.keyboard.type(text, { delay: 30 });
  await page.keyboard.press("Enter");
  // Let Univer commit (or reject) the edit and settle.
  await new Promise((r) => setTimeout(r, 800));
}

async function run(
  browser: Browser,
  base: string,
  readonly: boolean,
  opts: { flipToEditableFirst?: boolean } = {},
) {
  const page = await browser.newPage();
  await page.setViewport({ width: 375, height: 812 });
  // Read-only enforcement must be silent — Univer permission gating, not
  // thrown-from-command-stream cancellation. Any uncaught page error (in
  // EITHER run) fails the test.
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.goto(`${base}/?readonly=${readonly ? "1" : "0"}`, {
    waitUntil: "networkidle0",
    timeout: 120000,
  });
  await page.waitForFunction("window.__ready === true", { timeout: 60000 });
  // Univer paints asynchronously after onReady — wait for the grid canvas.
  await page.waitForFunction(
    () => Array.from(document.querySelectorAll("canvas")).some((c) => c.getBoundingClientRect().height > 200),
    { timeout: 30000 },
  );
  await new Promise((r) => setTimeout(r, 500));

  const before = cellA1(await page.evaluate("window.__getSnapshotUnsafe()"));
  assert(before === "Hello", `A1 seeded with "Hello" (got ${JSON.stringify(before)})`);

  if (opts.flipToEditableFirst) {
    // Desktop pending-lock flow: the editor mounted readOnly, then the page
    // wins the edit lock and flips the prop on the mounted instance.
    await page.evaluate("window.__setReadOnly(false)");
    await new Promise((r) => setTimeout(r, 500));
  }

  await attemptEdit(page, "XYZ");

  const after = cellA1(await page.evaluate("window.__getSnapshotUnsafe()"));
  const prodSnapshot = await page.evaluate("window.__getSnapshot()");
  await page.close();
  assert(
    pageErrors.length === 0,
    `${readonly ? "read-only" : "control"} run produced zero uncaught page errors (got: ${pageErrors.join(" | ")})`,
  );
  return { after, prodSnapshot };
}

async function main() {
  const chromium = findChromium();
  console.log(`Using chromium: ${chromium}`);
  console.log("Building harness with Vite…");
  await buildHarness();
  const { server, base } = await serveDist();

  const puppeteer = (await import("puppeteer-core")).default;
  const browser = await puppeteer.launch({
    executablePath: chromium,
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });

  try {
    // Control run: editable mount — the identical gesture MUST land, proving
    // the click/type coordinates are valid before we trust the read-only run.
    const control = await run(browser, base, false);
    assert(
      control.after === "XYZ",
      `control (editable) run: typing replaced A1 with "XYZ" (got ${JSON.stringify(control.after)})`,
    );
    console.log("✓ control run: edit gesture reaches the document model");

    // Read-only run: same gesture, nothing sticks.
    const ro = await run(browser, base, true);
    assert(
      ro.after === "Hello",
      `read-only run: A1 still holds the seeded "Hello" after an attempted edit (got ${JSON.stringify(ro.after)})`,
    );
    assert(
      ro.prodSnapshot === null,
      "read-only run: production getSnapshot() returns null (autosave paths stay blind)",
    );
    console.log("✓ read-only run: attempted edit never reached the document model");

    // Transition run: mounted read-only (pending lock), flipped editable
    // without remount (lock won) — edits must now land.
    const transition = await run(browser, base, true, { flipToEditableFirst: true });
    assert(
      transition.after === "XYZ",
      `transition run: after readOnly→editable flip, typing replaced A1 with "XYZ" (got ${JSON.stringify(transition.after)})`,
    );
    console.log("✓ transition run: pending-lock mount becomes editable after the flip");
    console.log("PASS sheet-mobile-readonly-browser");
  } finally {
    await browser.close();
    server.close();
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
