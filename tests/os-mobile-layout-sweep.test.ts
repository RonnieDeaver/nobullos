/* test-registration
{
  "name": "OS app mobile layout sweep — authed real-Chromium check that all 11 audited OS pages have no horizontal page scroll at 375/768/1024px, plus the dashboard at 1280/1366px where the inline CEO nav renders (Task #3802, hermetic server Task #3851, xl nav widths Task #4712)",
  "regression": true,
  "sweepOnlyReason": "Real-browser sweep (11 pages x 3 viewports, plus booting a dedicated server instance, ~3 min) exceeds the <30s fast-smoke criterion, and its subject (client rendering over HTTP) is invisible to import tracing anyway. The nightly regression sweep runs it; run it manually when touching OS-app layout/CSS (DESIGN.md -> OS App Responsive Baseline).",
  "timeoutMs": 480000,
  "notes": "Successor to the one-off .local puppeteer sweep from the mobile compatibility pass. Task #3851 retired the sharedDev tag: the suite BOOTS ITS OWN server instance (tsx server/index.ts on an ephemeral port) pointed at the inherited hermetic per-run DB, seeds its own client/workbook fixtures + a CEO users row, drives the SYSTEM chromium via puppeteer-core with isMobile:false (strict CSS-width semantics), stubs huge list APIs down to ~25 rows, and fails when max(html,body).scrollWidth exceeds the viewport width. Task #4712: the dashboard is additionally swept at 1280/1366px (xl — the inline CEO nav renders there) with the same overflow check, and the measured intrinsic (max-content) header-band width is logged as a recalibration anchor (band asserted present at xl) for the jsdom width-budget model. Clerk migration: auth is now a GENUINE in-browser Clerk ticket sign-in (Backend-API sign_in_token for a throwaway Clerk user whose external_id === the seeded CEO row id; deleted in finally) — the old HMAC connect.sid session mint is dead. Requires CLERK_SECRET_KEY (skips without it). TEST_BASE_URL overrides the self-booted server for manual iteration against an already-running server.",
  "tier": "large",
  "tierReason": "Browser/Chromium harness; it consumes a heavyweight external-process resource lane even when its last measured duration is short."
}
test-registration */
/**
 * Task #3802 — Catch OS-app mobile layout regressions before they ship.
 * Task #3851 — Run against a dedicated server on the hermetic per-run DB.
 *
 * The mobile compatibility pass verified the 11 audited OS pages have no
 * horizontal page scroll at 375 / 768 / 1024 px. This suite makes it a
 * repeatable, gated check:
 *
 *   1. Skips (never fails) when chromium, DATABASE_URL, or CLERK_SECRET_KEY
 *      are unavailable — same posture as tests/api-smoke. (Clerk migration:
 *      the old HMAC connect.sid mint needed SESSION_SECRET; auth is now a real
 *      in-browser Clerk ticket sign-in, so the Backend-API secret is the gate.)
 *   2. Boots its OWN server instance (`tsx server/index.ts`, ephemeral
 *      port, NODE_ENV=development so vite serves the client) against the
 *      DB env this process inherited — the hermetic per-run DB under
 *      `npm test -- --file=…`. No dependency on the live dev server or the
 *      shared dev DB remains (the last `sharedDev` tag is retired).
 *      TEST_BASE_URL skips the boot and sweeps an existing server instead
 *      (manual iteration only).
 *   3. Seeds its own fixtures when missing (clients / sheet_workbooks rows
 *      for the dynamic pages) plus a CEO `users` row, then signs in for real
 *      in the browser via a Clerk sign-in ticket (Backend-API sign_in_token
 *      for a throwaway Clerk user whose external_id === the seeded CEO row id,
 *      consumed in-page with ClerkJS `signIn.create({ strategy: "ticket" })`
 *      + `setActive`). Verified against /api/auth/user IN-PAGE (Clerk __session
 *      cookie attached) before sweeping, so a broken sign-in can never produce
 *      a hollow "pass" against the login page. The throwaway Clerk user is
 *      deleted in finally (no shared-tenant QA litter).
 *   4. For each audited page: loads it once in real Chromium, waits for the
 *      app shell to render, then measures at 1024 → 768 → 375 px
 *      (isMobile:false — layout-viewport semantics stay strict CSS width;
 *      see .agents/memory/mobile-overflow-debugging.md).
 *   5. FAILS when max(html.scrollWidth, body.scrollWidth) exceeds the
 *      viewport width (1px tolerance for subpixel rounding).
 *   6. Task #4712 — the dashboard is ALSO measured at 1366 → 1280 px (the
 *      inline CEO nav renders from xl up; 1366px laptops are the floor) with
 *      the same overflow check, and the header band's scrollWidth is logged
 *      so tests/client/global-nav-width-budget.test.tsx can be recalibrated
 *      against a real browser (.agents/memory/nav-width-budget-model.md).
 *
 * Huge synthetic dev datasets can saturate list pages, so the big list APIs
 * are capped to 25 rows via request interception (server-side fetch +
 * truncate).
 *
 * Run: npm test -- --file=tests/os-mobile-layout-sweep.test.ts
 */

import crypto from "node:crypto";
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import pg from "pg";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

const VIEWPORTS = [1024, 768, 375];
// Task #4712 — the inline CEO nav renders from xl (1280px) up; the jsdom
// width-budget model (tests/client/global-nav-width-budget.test.tsx) is
// calibrated, not measured, so the dashboard also gets a REAL-browser check
// at the 1366px-laptop floor widths. Widest-first so the page loads once at
// its largest viewport and narrows (media queries re-evaluate on resize).
const XL_NAV_VIEWPORTS = [1366, 1280];
// The nav band whose measured width recalibrates the jsdom model (see
// .agents/memory/nav-width-budget-model.md). Measured on the inner flex row.
const NAV_BAND_SELECTOR = '[data-testid="global-app-nav"] > div';
// Subpixel layout can round scrollWidth up by 1px without any real overflow.
const TOLERANCE_PX = 1;
// Endpoints whose datasets can be huge; truncated to keep list pages
// representative instead of thousands-of-rows saturated.
// NOTE: matched against URL *pathname* exactly (handler below), so detail
// routes like /api/clients/:id never match. /api/clients is what the Clients
// admin page (client/src/pages/admin/ClientManagement.tsx) actually loads —
// including the ?showArchived=true query form (same pathname).
const LIST_CAP_PATHS = ["/api/users", "/api/admin/clients", "/api/clients"];
const LIST_CAP_ROWS = 25;
// How long the self-booted server may take to answer /api/health with 200
// (cold tsx boot + vite dev middleware + route registration).
const SERVER_BOOT_TIMEOUT_MS = 150_000;

function findChromium(): string | null {
  const fromEnv = process.env.CHROMIUM_PATH;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  try {
    const found = execSync("which chromium || which chromium-browser", { encoding: "utf8" })
      .split("\n")[0]
      .trim();
    return found || null;
  } catch {
    return null;
  }
}

// ── Clerk Backend API helpers (see .agents/memory/authed-dev-screenshots.md) ──
// The suite drives a GENUINE in-browser Clerk sign-in: mint a single-use
// sign-in ticket for a throwaway Clerk user, consume it in-page via ClerkJS
// (strategy "ticket") so ClerkJS sets the real __session cookie. The local
// users row (id === the Clerk user's external_id → sessionClaims.userId →
// requireAuth Step 1) carries the CEO role the sweep needs.
const CLERK_API = "https://api.clerk.com/v1";

function clerkHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${process.env.CLERK_SECRET_KEY}`,
    "Content-Type": "application/json",
  };
}

/**
 * Create a throwaway Clerk user whose external_id is our chosen local id.
 * This Clerk dev instance enforces a password on user creation, so include a
 * throwaway strong one (never used by the ticket flow). Returns the Clerk
 * native user id (for token minting + deletion).
 */
async function createThrowawayClerkUser(externalId: string): Promise<string> {
  const rnd = crypto.randomBytes(6).toString("hex");
  const res = await fetch(`${CLERK_API}/users`, {
    method: "POST",
    headers: clerkHeaders(),
    body: JSON.stringify({
      email_address: [`os-sweep.${rnd}@example.com`],
      password: `QaPw!7x${crypto.randomUUID()}`,
      external_id: externalId,
      first_name: "Sweep",
      last_name: "3802",
    }),
  });
  const body = await res.json().catch(() => null);
  assert(
    res.status < 300 && body?.id,
    `created throwaway Clerk user (status ${res.status}: ${JSON.stringify(body).slice(0, 300)})`,
  );
  return body.id as string;
}

/** Mint a single-use Clerk sign-in ticket for the given Clerk user. */
async function mintSignInTicket(clerkUserId: string): Promise<string> {
  const res = await fetch(`${CLERK_API}/sign_in_tokens`, {
    method: "POST",
    headers: clerkHeaders(),
    body: JSON.stringify({ user_id: clerkUserId, expires_in_seconds: 900 }),
  });
  const body = await res.json().catch(() => null);
  assert(
    res.status < 300 && body?.token,
    `minted Clerk sign-in ticket (status ${res.status}: ${JSON.stringify(body).slice(0, 300)})`,
  );
  return body.token as string;
}

/** Best-effort delete of the throwaway Clerk user (no QA litter in the tenant). */
async function deleteClerkUser(clerkUserId: string | null): Promise<void> {
  if (!clerkUserId) return;
  try {
    await fetch(`${CLERK_API}/users/${clerkUserId}`, {
      method: "DELETE",
      headers: clerkHeaders(),
    });
  } catch {
    // Best effort — leave a log below rather than throwing in cleanup.
  }
}

async function pickFreePort(): Promise<number> {
  const { createServer } = await import("node:net");
  return await new Promise<number>((resolvePort, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolvePort(port));
      } else {
        srv.close(() => reject(new Error("no address")));
      }
    });
  });
}

/**
 * Boot a dedicated server instance for this sweep, inheriting THIS process's
 * DB env — the hermetic per-run DB when run through the sanctioned
 * `npm test -- --file=…` path. NODE_ENV=development so vite dev middleware
 * serves the real client bundle (the sweep's subject is client rendering).
 */
function spawnSweepServer(port: number): ChildProcess {
  const child = spawn("npx", ["tsx", "server/index.ts"], {
    // Own process group so teardown can kill the whole tree (npx → tsx → node).
    detached: true,
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...process.env,
      NODE_ENV: "development",
      PORT: String(port),
    },
  });
  return child;
}

function killServer(child: ChildProcess | null): void {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {}
  setTimeout(() => {
    try {
      if (child.pid) process.kill(-child.pid, "SIGKILL");
    } catch {}
  }, 5_000).unref();
}

async function waitForServer(baseUrl: string, deadlineMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    try {
      const res = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(5000) });
      if (res.status === 200) return true;
      // Boot gate answers 503 while bootstrapping — keep waiting.
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

async function main(): Promise<void> {
  // ---- Skip gates (environment without DB/browser must stay green) ----
  // Task #3851 minted an HMAC connect.sid session (needed SESSION_SECRET).
  // Clerk migration: auth is now a real in-browser Clerk ticket sign-in, so
  // the Clerk Backend API secret is the hard requirement instead. The server
  // itself still needs DATABASE_URL to boot against the hermetic DB.
  if (!process.env.DATABASE_URL || !process.env.CLERK_SECRET_KEY) {
    console.log("os-mobile-layout-sweep: SKIPPED (DATABASE_URL / CLERK_SECRET_KEY not set)");
    return;
  }
  const chromium = findChromium();
  if (!chromium) {
    console.log("os-mobile-layout-sweep: SKIPPED (no chromium executable on PATH)");
    return;
  }

  // ---- Server: self-booted against the inherited (hermetic) DB env ----
  // TEST_BASE_URL = manual-iteration escape: sweep an already-running
  // server instead of booting one (the DB env must then match that server).
  let server: ChildProcess | null = null;
  let baseUrl = process.env.TEST_BASE_URL || "";
  if (!baseUrl) {
    const port = await pickFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    console.log(`os-mobile-layout-sweep: booting dedicated server on port ${port} (hermetic DB)`);
    server = spawnSweepServer(port);
  }

  // lint-hermetic-db-ok: connects to the INJECTED per-run hermetic DATABASE_URL (never a hardcoded shared-dev URL) to seed fixtures + the CEO users row for the self-booted server.
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  const createdClientIds: string[] = [];
  const createdWorkbookIds: string[] = [];
  // The local users row id that requireAuth will resolve (sessionClaims.userId
  // = the throwaway Clerk user's external_id, which we set to this value).
  const ceoLocalId = `os-sweep-ceo-${crypto.randomBytes(6).toString("hex")}`;
  let clerkUserId: string | null = null;
  let seededCeoRow = false;

  let browser: { close(): Promise<void> } | null = null;
  const failures: string[] = [];
  try {
    if (server) {
      const up = await waitForServer(baseUrl, SERVER_BOOT_TIMEOUT_MS);
      assert(up, `dedicated sweep server became healthy at ${baseUrl}/api/health within ${SERVER_BOOT_TIMEOUT_MS / 1000}s`);
    } else if (!(await waitForServer(baseUrl, 10_000))) {
      console.log(`os-mobile-layout-sweep: SKIPPED (no server reachable at TEST_BASE_URL=${baseUrl})`);
      return;
    }

    // ---- Seed the local CEO users row we will authenticate AS ----
    // requireAuth Step 1 resolves identity from sessionClaims.userId (= the
    // Clerk user's external_id) and looks up users.id == that value. We seed a
    // row with id === ceoLocalId + role 'ceo' BEFORE the first authed request,
    // so requireAuth finds it and uses role 'ceo' directly (no JIT insert / no
    // reconciliation role-clobber — those only fire when the row is missing).
    await client.query(
      `INSERT INTO users (id, email, first_name, last_name, role)
       VALUES ($1, $2, 'Sweep', '3802', 'ceo')
       ON CONFLICT (id) DO UPDATE SET role = 'ceo'`,
      [ceoLocalId, `${ceoLocalId}@example.com`],
    );
    seededCeoRow = true;
    const ceoRow = { id: ceoLocalId, email: `${ceoLocalId}@example.com` };

    // ---- Create a throwaway Clerk user + mint a single-use sign-in ticket ----
    // external_id === ceoLocalId → sessionClaims.userId === ceoLocalId → the
    // seeded CEO row above. Deleted in finally (no shared-tenant QA litter).
    clerkUserId = await createThrowawayClerkUser(ceoLocalId);
    const ticket = await mintSignInTicket(clerkUserId);

    // Seed the dynamic-page fixtures when the DB has none (a fresh hermetic
    // clone is empty) so all 11 audited pages actually get swept.
    let clientRow = (await client.query(`SELECT id FROM clients ORDER BY created_at ASC LIMIT 1`))
      .rows[0];
    if (!clientRow) {
      clientRow = (
        await client.query(
          `INSERT INTO clients (firm_name, contact_name) VALUES ('Sweep Fixture Firm', 'Sweep 3851') RETURNING id`,
        )
      ).rows[0];
      createdClientIds.push(clientRow.id);
    }
    let workbookRow = (
      await client.query(`SELECT id FROM sheet_workbooks ORDER BY created_at ASC LIMIT 1`)
    ).rows[0];
    if (!workbookRow) {
      workbookRow = (
        await client.query(
          `INSERT INTO sheet_workbooks (name, owner_id) VALUES ('Sweep Fixture Workbook', $1) RETURNING id`,
          [ceoRow.id],
        )
      ).rows[0];
      createdWorkbookIds.push(workbookRow.id);
    }

    // The 11 audited pages (DESIGN.md → "OS App Responsive Baseline").
    const pages: Array<{ name: string; path: string; expectPath?: string }> = [
      { name: "dashboard", path: "/" },
      { name: "activity", path: "/admin/activity" },
      { name: "clickup", path: "/admin/clickup" },
      { name: "zoom", path: "/admin/zoom" },
      { name: "rate-limits", path: "/admin/rate-limits" },
      { name: "clients", path: "/admin/clients" },
      { name: "users", path: "/admin/users" },
      { name: "service-desk-settings", path: "/admin/service-desk" },
      // /admin/health is an in-app redirect to the System Health console.
      { name: "admin-health", path: "/admin/health", expectPath: "/admin/system-health" },
      { name: "client-detail-comms", path: `/clients/${clientRow.id}` },
      { name: "sheet-editor", path: `/sheets/${workbookRow.id}` },
    ];

    // The CEO row exists but is a brand-new hermetic user — wait for the
    // server to answer /api/health with 200 already happened; give the auth
    // subsystem a beat if the boot is cold (retried inside the sign-in probe).

    const puppeteer = (await import("puppeteer-core")).default;
    browser = await puppeteer.launch({
      executablePath: chromium,
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    });
    const b = browser as Awaited<ReturnType<typeof puppeteer.launch>>;

    const page = await b.newPage();
    // tsx/esbuild-compiled evaluate callbacks reference an __name helper.
    await page.evaluateOnNewDocument("window.__name = (f) => f;");

    // Cap the huge list APIs so list pages stay representative rather than
    // thousands-of-rows saturated. The Task #3851 recipe re-fetched these
    // server-side (with a statically-minted connect.sid) and truncated — but
    // Clerk auth is a browser-only __session JWT that clerkMiddleware validates
    // in the dev-browser handshake context, so a Node→server re-fetch is
    // unauthenticated (401, role=-). Instead, let the browser's OWN
    // authenticated request go through and truncate the RESPONSE BODY on its
    // way back via CDP Fetch (Response stage): the cookie, handshake, and auth
    // all stay real; only the JSON array is capped. Non-list requests continue
    // untouched — including document requests that clerkMiddleware 307s through
    // the Clerk dev-browser handshake (never respond/abort a navigation; see
    // .agents/memory/clerk-auth-migration-harness-seams.md).
    const cdp = await page.createCDPSession();
    await cdp.send("Fetch.enable", {
      patterns: [
        { urlPattern: "*/api/users", requestStage: "Response" },
        { urlPattern: "*/api/admin/clients", requestStage: "Response" },
        // The Clients admin page loads /api/clients (not /api/admin/clients).
        // Fetch.enable globs match the FULL URL, so the bare pattern misses
        // the ?showArchived=true form — pause both; the pathname check in the
        // handler (exact LIST_CAP_PATHS match) keeps /api/clients/:id detail
        // routes untouched.
        { urlPattern: "*/api/clients", requestStage: "Response" },
        { urlPattern: "*/api/clients?*", requestStage: "Response" },
      ],
    });
    cdp.on("Fetch.requestPaused", (event: any) => {
      void (async () => {
        const reqPath = (() => {
          try {
            return new URL(event.request.url).pathname;
          } catch {
            return "";
          }
        })();
        const isCap =
          event.request.method === "GET" &&
          LIST_CAP_PATHS.includes(reqPath) &&
          event.responseStatusCode === 200;
        if (!isCap) {
          try {
            await cdp.send("Fetch.continueRequest", { requestId: event.requestId });
          } catch {}
          return;
        }
        try {
          const { body, base64Encoded } = await cdp.send("Fetch.getResponseBody", {
            requestId: event.requestId,
          });
          const raw = base64Encoded ? Buffer.from(body, "base64").toString("utf8") : body;
          const parsed = JSON.parse(raw);
          const capped = Array.isArray(parsed) ? parsed.slice(0, LIST_CAP_ROWS) : parsed;
          const newBody = Buffer.from(JSON.stringify(capped), "utf8").toString("base64");
          await cdp.send("Fetch.fulfillRequest", {
            requestId: event.requestId,
            responseCode: 200,
            responseHeaders: [{ name: "Content-Type", value: "application/json" }],
            body: newBody,
          });
        } catch {
          // Any parse/CDP hiccup: pass the original response through untouched.
          try {
            await cdp.send("Fetch.continueRequest", { requestId: event.requestId });
          } catch {}
        }
      })();
    });

    // ---- GENUINE in-browser Clerk sign-in (strategy "ticket") ----
    // Load the public /sign-in page first so ClerkJS boots (dev-instance FAPI),
    // wait for window.Clerk.loaded, then consume the single-use ticket in-page.
    // ClerkJS sets the real __session cookie and it persists across navigations
    // in this browser context, so use-auth's /api/auth/user probe (gated on
    // isSignedIn) will fetch WITH the cookie on every protected page below.
    await page.goto(`${baseUrl}/sign-in`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForFunction("window.Clerk && window.Clerk.loaded === true", {
      timeout: 90000,
    });
    const signInResult = (await page.evaluate(`(async () => {
      try {
        const si = await window.Clerk.client.signIn.create({ strategy: "ticket", ticket: ${JSON.stringify(
          ticket,
        )} });
        if (si.status !== "complete") return { ok: false, status: si.status };
        await window.Clerk.setActive({ session: si.createdSessionId });
        return { ok: true };
      } catch (e) {
        return { ok: false, error: String(e && e.message ? e.message : e) };
      }
    })()`)) as { ok: boolean; status?: string; error?: string };
    assert(
      signInResult.ok,
      `Clerk ticket sign-in completed (status=${signInResult.status ?? "?"}, error=${signInResult.error ?? "none"})`,
    );

    // Authoritative auth check — a broken sign-in must fail loudly here, not
    // hollow-pass by measuring the login page 33 times. Runs IN-PAGE so the
    // ClerkJS-managed __session cookie is attached; retries while a cold server
    // warms its auth subsystem (503/502/504).
    //
    // authProbeAttempts tracks total iterations of the loop (including the
    // first attempt). It is logged after the loop so that cold-boot scenarios
    // where the retry path was exercised are visible in CI output. A future
    // regression that removes the retry (or stops treating 401 as transient)
    // would show up as authProbeAttempts === 1 even on a genuinely cold boot,
    // making the silence audible in the logs.
    let authProbe: { status: number; role?: string; id?: string } = { status: 0 };
    let authProbeAttempts = 0;
    for (let i = 0; i < 12; i += 1) {
      authProbeAttempts += 1;
      authProbe = (await page.evaluate(`(async () => {
        const r = await fetch("/api/auth/user", { credentials: "include" });
        let body = null;
        try { body = await r.json(); } catch {}
        return { status: r.status, role: body && body.role, id: body && body.id };
      })()`)) as { status: number; role?: string; id?: string };
      if (authProbe.status === 200) break;
      // Also retry on 401: a cold server whose Clerk middleware hasn't yet
      // hydrated the session cookie can briefly return 401 before the session
      // propagates — treat it as transient rather than a hard auth failure.
      if (![401, 503, 502, 504].includes(authProbe.status)) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    // Log the attempt count so cold-boot retries are visible in CI output.
    // On a warm server this is typically 1; on a cold boot it will be >1.
    // If this line always shows 1 even when the server is freshly booted,
    // the 401-transient retry path may have regressed.
    console.log(
      `os-mobile-layout-sweep: auth probe resolved in ${authProbeAttempts} attempt(s) ` +
        `(final status ${authProbe.status})`,
    );
    assert(
      authProbe.status === 200,
      `Clerk-authed session resolves the CEO row (/api/auth/user -> ${authProbe.status})`,
    );
    // The seeded row (id === ceoLocalId, role 'ceo') must be what requireAuth
    // resolved — not a JIT-provisioned default-role row. A role mismatch here
    // means admin pages would client-redirect and hollow-pass; fail loudly.
    assert(
      authProbe.id === ceoLocalId,
      `resolved the seeded CEO row (expected id ${ceoLocalId}, got ${authProbe.id})`,
    );
    assert(
      authProbe.role === "ceo",
      `seeded CEO role survived (expected 'ceo', got '${authProbe.role}') — a JIT/reconciliation clobber would break admin-page sweeps`,
    );

    for (const p of pages) {
      // Task #4712 — the dashboard additionally sweeps the xl widths where the
      // inline CEO nav renders (1280/1366); other pages keep the mobile trio.
      const widths = p.name === "dashboard" ? [...XL_NAV_VIEWPORTS, ...VIEWPORTS] : VIEWPORTS;
      // Load once at the widest viewport, then re-measure while narrowing —
      // media queries re-evaluate on resize, no reload needed.
      await page.setViewport({ width: widths[0], height: 800, isMobile: false });
      await page.goto(baseUrl + p.path, { waitUntil: "domcontentloaded", timeout: 30000 });

      // Wait for the authed app shell to render real content — measuring a
      // blank shell is a hollow pass. (The session was already verified
      // against /api/auth/user above, so "content rendered" + "no client-side
      // redirect off the target path" is the render gate here.)
      await page
        .waitForFunction(`document.body.innerText.trim().length > 40`, { timeout: 30000 })
        .catch(() => {
          throw new Error(
            `${p.name} (${p.path}): app never rendered content — ` +
              `auth or routing broke; refusing to measure a hollow page`,
          );
        });
      const landedPath = (await page.evaluate(`window.location.pathname`)) as string;
      // Client-side redirects (e.g. /admin/health → system-health console)
      // can land either before or after this check runs; both are fine.
      const okPaths = [p.path, ...(p.expectPath ? [p.expectPath] : [])];
      assert(
        okPaths.includes(landedPath),
        `${p.name}: stayed on ${okPaths.join(" or ")} (landed on ${landedPath} — likely auth redirect)`,
      );
      // Let queries land and content settle.
      await new Promise((r) => setTimeout(r, 2500));

      for (const width of widths) {
        await page.setViewport({ width, height: 800, isMobile: false });
        // Settle after resize + wait for layout to stabilize across two rAFs.
        await new Promise((r) => setTimeout(r, 700));
        const m = (await page.evaluate(`(() => {
          const html = document.documentElement;
          // Intrinsic (max-content) nav band width: the row is w-full, so its
          // scrollWidth just restates the viewport whenever the band FITS.
          // Temporarily force width:max-content (and lift the 1536px cap) so
          // the flex row shrink-wraps its content — flexible spacers collapse
          // to their own content size — then restore. This is the number the
          // jsdom width-budget model calibrates against.
          const band = document.querySelector(${JSON.stringify(NAV_BAND_SELECTOR)});
          let bandW = null;
          if (band) {
            const prevWidth = band.style.width;
            const prevMaxWidth = band.style.maxWidth;
            band.style.width = "max-content";
            band.style.maxWidth = "none";
            bandW = Math.ceil(band.getBoundingClientRect().width);
            band.style.width = prevWidth;
            band.style.maxWidth = prevMaxWidth;
          }
          return {
            htmlW: html.scrollWidth,
            bodyW: document.body ? document.body.scrollWidth : 0,
            inner: window.innerWidth,
            bandW,
          };
        })()`)) as { htmlW: number; bodyW: number; inner: number; bandW: number | null };
        const maxW = Math.max(m.htmlW, m.bodyW);
        const label = `${p.name} (${p.path}) @ ${width}px`;
        if (maxW > m.inner + TOLERANCE_PX) {
          failures.push(`${label}: scrollWidth ${maxW} > viewport ${m.inner} (horizontal page scroll)`);
          console.log(`FAIL ${label}: scrollWidth=${maxW} viewport=${m.inner}`);
        } else {
          console.log(`ok   ${label}: scrollWidth=${maxW} viewport=${m.inner}`);
        }
        // Task #4712 — log the measured nav band width at the xl widths so the
        // jsdom width-budget model can be recalibrated against a REAL browser
        // (see .agents/memory/nav-width-budget-model.md — never eyeball).
        if (XL_NAV_VIEWPORTS.includes(width)) {
          // The band must exist at xl widths — a selector/markup regression
          // must not silently remove the promised calibration signal.
          assert(
            m.bandW !== null,
            `${label}: nav band (${NAV_BAND_SELECTOR}) present for the intrinsic-width calibration measurement`,
          );
          console.log(
            `nav-band ${label}: intrinsic (max-content) band width=${m.bandW}px vs viewport ${m.inner}px (calibration anchor for tests/client/global-nav-width-budget.test.tsx)`,
          );
        }
      }
    }

    assert(
      failures.length === 0,
      `no audited OS page has horizontal scroll at its swept widths (375/768/1024px, dashboard also 1280/1366px):\n  - ${failures.join("\n  - ")}`,
    );
    console.log(
      `os-mobile-layout-sweep: PASS (${pages.length} pages x ${VIEWPORTS.length} viewports + dashboard @ ${XL_NAV_VIEWPORTS.join("/")}px)`,
    );
  } finally {
    // Close the browser FIRST so no trailing authed request writes activity
    // rows against the CEO id mid-cleanup (FK-race guard, see
    // .agents/memory/authed-dev-screenshots.md).
    try {
      if (browser) await browser.close();
    } catch {}
    killServer(server);
    // Delete the throwaway Clerk user — NO QA litter in the shared tenant.
    await deleteClerkUser(clerkUserId);
    // Fixture cleanup matters in TEST_BASE_URL mode (a non-throwaway DB);
    // in hermetic mode the whole DB is dropped after the run anyway.
    for (const id of createdWorkbookIds) {
      try {
        await client.query(`DELETE FROM sheet_workbooks WHERE id = $1`, [id]);
      } catch {}
    }
    for (const id of createdClientIds) {
      try {
        await client.query(`DELETE FROM clients WHERE id = $1`, [id]);
      } catch {}
    }
    if (seededCeoRow) {
      try {
        // user_activity_logs FK-references users; clear them before the row.
        await client.query(`DELETE FROM user_activity_logs WHERE user_id = $1`, [ceoLocalId]);
      } catch {}
      try {
        await client.query(`DELETE FROM users WHERE id = $1`, [ceoLocalId]);
      } catch {}
    }
    await client.end();
  }
}

main()
  .then(() => {
    console.log("os-mobile-layout-sweep: done");
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
