/**
 * Production-build check: CJK / emoji / accented / RTL text in Univer
 * spreadsheet cells after opentype.js + franc-min were stubbed out of the
 * build (vite.config.ts stubUniverShapingDepsPlugin).
 *
 * Run (on demand, ~90s; requires a fresh production build first):
 *   npm run build
 *   npx tsx scripts/verify-sheet-nonlatin-e2e.ts
 * Exits 0 on PASS; writes a screenshot to .local/scratch/sheet-nonlatin.png.
 *
 * Notes:
 *  - Uses the system chromium (`which chromium`), which ships ~8 fonts and no
 *    CJK/emoji faces — CJK/emoji glyphs may render as tofu boxes in the
 *    screenshot. That is a FONT-AVAILABILITY artifact of the headless
 *    environment, not a shaping bug; correctness is asserted via Univer's own
 *    document model (clipboard copy of the cells) and the autosaved snapshot
 *    round-trip, plus zero console/page errors (the opentype stub THROWS
 *    loudly if the stripped shaping path is ever reached).
 *  - Text is typed with CDP sendCharacter (keyboard.type can't produce
 *    CJK/emoji); the editor page's autosave debounce listens only for real
 *    pointerdown/keydown on its wrapper, so the script clicks the grid after
 *    typing to trigger the save.
 *
 * Auth (Clerk era, 2026-08): admission is closed — a Clerk session only
 * passes if a pre-approved local `users` row exists with a matching email.
 * The script therefore: inserts a throwaway local users row → creates a
 * throwaway Clerk user (same email, external_id = local id, password
 * required by this instance) → mints a single-use sign-in token
 * (POST /v1/sign_in_tokens) → puppeteer signs in in-page via
 * `Clerk.client.signIn.create({ strategy: "ticket" })`. All authed API
 * calls (workbook create/read/delete) run in-page so ClerkJS owns the
 * session cookie. Cleanup deletes user_activity_logs before the users row
 * (FK), then the Clerk user.
 *
 * Flow: spawn dist/index.cjs (NODE_ENV=production, PORT=3100) → Clerk
 * ticket sign-in → create a workbook via in-page API → puppeteer types the
 * four strings into A1..A4 → verify (a) zero console errors / page errors
 * (the opentype stub THROWS if ever reached), (b) canvas pixels rendered
 * for each row, (c) autosaved snapshot round-trips the exact strings.
 */
import { spawn, execSync } from "node:child_process";
import crypto from "node:crypto";
import { Client } from "pg";
import puppeteer from "puppeteer";

const PORT = 3100;
const BASE = `http://127.0.0.1:${PORT}`;
const CLERK_API = "https://api.clerk.com/v1";
const STRINGS = [
  "你好世界，中文测试", // CJK
  "🚀🎉😀 emoji test", // emoji
  "Café naïve übermensch São Tomé", // accented Latin
  "مرحبا بالعالم شكرا", // RTL Arabic
];

async function clerkApi(path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(CLERK_API + path, {
    ...init,
    headers: {
      Authorization: `Bearer ${process.env.CLERK_SECRET_KEY}`,
      "content-type": "application/json",
      ...(init.headers as any),
    },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`Clerk API ${path} → ${res.status}: ${JSON.stringify(body)?.slice(0, 500)}`);
  }
  return body;
}

async function main() {
  if (!process.env.CLERK_SECRET_KEY) throw new Error("CLERK_SECRET_KEY missing");

  const runTag = crypto.randomBytes(6).toString("hex");
  const localUserId = `sheet-nonlatin-e2e-${runTag}`;
  const email = `sheet.nonlatin.e2e.${runTag}@example.com`;

  // 1. Spawn prod server
  const server = spawn("node", ["dist/index.cjs"], {
    env: { ...process.env, NODE_ENV: "production", PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverLog = "";
  server.stdout.on("data", (d) => (serverLog += d));
  server.stderr.on("data", (d) => (serverLog += d));
  const killServer = () => { try { server.kill("SIGKILL"); } catch {} };
  process.on("exit", killServer);

  const pg = new Client({ connectionString: process.env.DATABASE_URL });
  await pg.connect();
  let clerkUserId: string | null = null;
  let browser: any = null;

  try {
    // 2. Pre-approve a throwaway local users row (closed admission: the Clerk
    // session is only admitted when an email-matched, non-deleted users row
    // exists), then a throwaway Clerk user + single-use sign-in ticket.
    await pg.query(
      `INSERT INTO users (id, email, first_name, last_name, role)
       VALUES ($1, $2, 'SheetE2E', 'Throwaway', 'account_manager')`,
      [localUserId, email],
    );
    const clerkUser = await clerkApi("/users", {
      method: "POST",
      body: JSON.stringify({
        email_address: [email],
        external_id: localUserId,
        // This Clerk instance requires a password on create; the ticket
        // sign-in flow never uses it.
        password: `QaPw!7x${crypto.randomUUID()}`,
        first_name: "SheetE2E",
        last_name: "Throwaway",
      }),
    });
    clerkUserId = clerkUser.id as string;
    const ticketRes = await clerkApi("/sign_in_tokens", {
      method: "POST",
      body: JSON.stringify({ user_id: clerkUserId, expires_in_seconds: 600 }),
    });
    const ticket = ticketRes.token as string;

    // 3. Wait for server readiness (any HTTP response — unauthed requests 401).
    let ready = false;
    for (let i = 0; i < 120; i++) {
      try {
        const r = await fetch(`${BASE}/api/auth/user`);
        if (r.status > 0) { ready = true; break; }
      } catch {}
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!ready) throw new Error("server never became ready\n" + serverLog.slice(-3000));
    console.log("server ready");

    // 4. Browser + Clerk ticket sign-in
    const execPath = execSync("which chromium").toString().trim();
    browser = await puppeteer.launch({
      executablePath: execPath,
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--font-render-hinting=none",
        "--no-proxy-server",
      ],
    });
    await browser.defaultBrowserContext().overridePermissions(BASE, [
      "clipboard-read",
      "clipboard-write",
      "clipboard-sanitized-write",
    ] as any);
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900 });
    await page.evaluateOnNewDocument("window.__name = function(f){return f}");
    const consoleErrors: string[] = [];
    page.on("console", (m: any) => {
      if (m.type() === "error") consoleErrors.push(m.text());
    });
    page.on("pageerror", (e: any) => consoleErrors.push("pageerror: " + String(e)));

    await page.goto(`${BASE}/sign-in`, { waitUntil: "networkidle2", timeout: 90000 }).catch(() => {});
    await page.waitForFunction("window.Clerk && window.Clerk.loaded === true", { timeout: 90000 });
    const signInStatus = await page.evaluate(async (t: string) => {
      const Clerk = (window as any).Clerk;
      const si = await Clerk.client.signIn.create({ strategy: "ticket", ticket: t });
      if (si.status === "complete") await Clerk.setActive({ session: si.createdSessionId });
      return si.status;
    }, ticket);
    if (signInStatus !== "complete") throw new Error("Clerk ticket sign-in status: " + signInStatus);
    // Verify admission end-to-end before proceeding.
    const authProbe = await page.evaluate(async () => {
      const r = await fetch("/api/auth/user");
      return { status: r.status, body: await r.text() };
    });
    if (authProbe.status !== 200) {
      throw new Error(`authed /api/auth/user → ${authProbe.status}: ${authProbe.body.slice(0, 300)}`);
    }
    console.log("Clerk ticket sign-in OK");

    // 5. Create workbook (in-page, so ClerkJS supplies the session cookie).
    const wbResult = await page.evaluate(async () => {
      const r = await fetch("/api/sheets/workbooks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "e2e-nonlatin-" + Date.now() }),
      });
      return { status: r.status, body: await r.json().catch(async () => await r.text()) };
    });
    if (wbResult.status !== 201) {
      throw new Error("createWorkbook failed: " + wbResult.status + " " + JSON.stringify(wbResult.body).slice(0, 500));
    }
    const workbook = (wbResult.body as any).workbook;
    console.log("workbook", workbook.id);

    // The unauthed shell + sign-in page can log 401-flood noise; only errors
    // from the editor page itself count toward the verdict.
    consoleErrors.length = 0;

    await page.goto(`${BASE}/sheets/${workbook.id}`, { waitUntil: "networkidle2", timeout: 90000 });
    await page.waitForSelector('[data-testid="univer-editor-container"] canvas', { timeout: 60000 });
    await new Promise((r) => setTimeout(r, 4000)); // let univer settle + lock acquire

    // 6. Click cell A1 and type the strings down column A.
    const canvasBox = await page.evaluate(() => {
      const c = document.querySelector('[data-testid="univer-editor-container"] canvas')!;
      const r = c.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    });
    // Click into the grid area (well below the column-header strip).
    await page.mouse.click(canvasBox.x + 120, canvasBox.y + 120);
    await new Promise((r) => setTimeout(r, 500));
    // Baseline ink before typing (whole canvas dark-pixel count).
    const inkBefore = await countInk(page);
    for (const s of STRINGS) {
      // sendCharacter delivers real unicode (keyboard.type struggles with
      // emoji/CJK, which have no key mapping); first char opens the cell editor.
      for (const ch of Array.from(s)) await page.keyboard.sendCharacter(ch);
      await new Promise((r) => setTimeout(r, 400));
      await page.keyboard.press("Enter");
      await new Promise((r) => setTimeout(r, 500));
    }

    await new Promise((r) => setTimeout(r, 1000));

    // 7a. Pixel check: canvas ink must grow substantially after typing 4 rows.
    const inkAfter = await countInk(page);
    console.log("ink before/after:", inkBefore, inkAfter);

    await page.screenshot({ path: ".local/scratch/sheet-nonlatin.png" });

    // 7b. Content round-trip inside Univer's document model: select the 4
    // typed cells (cursor is one row below the last one) and copy them.
    for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowUp");
    await page.keyboard.down("Shift");
    for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowDown");
    await page.keyboard.up("Shift");
    await page.keyboard.down("Control");
    await page.keyboard.press("KeyC");
    await page.keyboard.up("Control");
    await new Promise((r) => setTimeout(r, 1000));
    const clip = await page
      .evaluate(() => navigator.clipboard.readText())
      .catch((e: any) => "CLIPBOARD_READ_FAILED: " + String(e));
    console.log("clipboard:", JSON.stringify(clip));
    const clipOk = STRINGS.map((s) => typeof clip === "string" && clip.includes(s));
    console.log("clipboard round-trip:", clipOk);

    // 7c. Trigger the autosave debounce: it listens for pointerdown/keydown on
    // the editor wrapper (CDP insertText fires neither), so click the grid.
    await page.mouse.click(canvasBox.x + 400, canvasBox.y + 400);

    // 8. Wait for the save badge to reach "saved", then verify snapshot round-trip.
    await page
      .waitForSelector('[data-testid="save-badge-saved"]', { timeout: 20000 })
      .catch(() => console.log("save badge never reached saved state"));
    await new Promise((r) => setTimeout(r, 2000));
    const got = await page.evaluate(async (id: string) => {
      const r = await fetch(`/api/sheets/workbooks/${id}`);
      return await r.json().catch(() => null);
    }, workbook.id);
    const snapStr = JSON.stringify(got?.workbook?.snapshot ?? {});
    const persisted = STRINGS.map((s) => snapStr.includes(s));
    console.log("persisted", persisted);
    const cellData =
      got?.workbook?.snapshot?.sheets
        ? Object.values(got.workbook.snapshot.sheets as any).map((sh: any) => sh.cellData)
        : null;
    console.log("cellData:", JSON.stringify(cellData)?.slice(0, 1500));

    // 9. Delete the workbook while still authed in-page.
    await page
      .evaluate(async (id: string) => {
        await fetch(`/api/sheets/workbooks/${id}`, { method: "DELETE" });
      }, workbook.id)
      .catch(() => {});

    await browser.close();
    browser = null;

    // Verdict
    const realErrors = consoleErrors.filter(
      (e) => !/favicon|net::ERR_|Download the React DevTools/i.test(e),
    );
    console.log("console errors:", JSON.stringify(realErrors, null, 2));
    const inkOk = inkAfter > inkBefore + 500;
    const contentOk = clipOk.every(Boolean);
    const persistOk = persisted.every(Boolean);
    const errOk = realErrors.length === 0;
    console.log(`VERDICT ink=${inkOk} clipboard=${contentOk} persist=${persistOk} noErrors=${errOk}`);
    if (!inkOk || !contentOk || !persistOk || !errOk) process.exitCode = 1;
    else console.log("PASS");
  } finally {
    // Cleanup: close browser first (trailing requests write activity logs),
    // then user_activity_logs BEFORE users (FK), retry once for the async
    // activity-log write race, then the Clerk user.
    if (browser) { try { await browser.close(); } catch {} }
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await pg.query(`DELETE FROM user_activity_logs WHERE user_id = $1`, [localUserId]);
        await pg.query(`DELETE FROM users WHERE id = $1`, [localUserId]);
        break;
      } catch (e) {
        if (attempt === 1) console.error("local user cleanup failed:", e);
        else await new Promise((r) => setTimeout(r, 2000));
      }
    }
    await pg.end().catch(() => {});
    if (clerkUserId) {
      await clerkApi(`/users/${clerkUserId}`, { method: "DELETE" }).catch((e) =>
        console.error("Clerk user cleanup failed:", e),
      );
    }
    killServer();
  }
}

async function countInk(page: any): Promise<number> {
  return await page.evaluate(() => {
    let ink = 0;
    const canvases = document.querySelectorAll(
      '[data-testid="univer-editor-container"] canvas',
    );
    canvases.forEach((el) => {
      const c = el as HTMLCanvasElement;
      if (!c.width || !c.height) return;
      const off = document.createElement("canvas");
      off.width = c.width;
      off.height = c.height;
      const ctx = off.getContext("2d")!;
      ctx.drawImage(c, 0, 0);
      const data = ctx.getImageData(0, 0, off.width, off.height).data;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] < 150 && data[i + 1] < 150 && data[i + 2] < 150 && data[i + 3] > 100) ink++;
      }
    });
    return ink;
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
