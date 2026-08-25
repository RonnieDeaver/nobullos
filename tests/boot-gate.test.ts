/* test-registration
{
  "name": "Boot readiness gate — never 'Cannot GET /' during startup (Task #3782)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3782: boot readiness gates — page loads during the boot window get the auto-retrying loading page (never Express's raw \"Cannot GET /\"), held requests become the real app on readiness, /api keeps its exact BOOT_503 JSON contract (health/webhook bypass), bootstrap failure is loud + step-named, and serveStatic degrades instead of throwing when the build dir is missing. DB-free express-on-ephemeral-port suite; a drift here re-exposes the raw 404 to every preview/deploy boot window.",
  "tier": "small"
}
test-registration */
// SPDX-License-Identifier: MIT
//
// Task #3782: boot readiness-gate coverage — never show "Cannot GET /"
// during startup.
//
// The real server binds its port immediately and mounts routes + the
// static/Vite catch-all only at the end of async bootstrap. These tests
// mount the same gates (server/bootGate.ts) on a bare express app in the
// same order as server/index.ts (apiGate on /api, then pageGate), leave the
// app intentionally "half-configured" the way it is mid-boot, and then
// append the routes + SPA catch-all AFTER requests are already waiting —
// exactly how bootstrap appends them in production. Covered:
//
//   - page GET/HEAD during boot → auto-retrying 503 loading page, never
//     Express's default "Cannot GET /" 404;
//   - held page request becomes the real app when readiness arrives within
//     the wait window; post-ready requests pass straight through;
//   - /api keeps its exact boot contract: JSON 503 code BOOT_503 with
//     Retry-After: 10 after the gate timeout, health + webhook bypass;
//   - bootstrap failure → loud step-named log, held + subsequent requests
//     get the failed-variant retry page immediately (JSON 503 for /api);
//   - a failure reported after readiness never flips a serving app back;
//   - serveStatic degrades to the retry page when the build directory is
//     missing instead of throwing mid-bootstrap;
//   - the early production handlers serve "/" and /assets from disk
//     instantly during boot (deploy health probe), including from a CJS
//     bundle where import.meta is empty — the old `import.meta.dirname`
//     guard silently never mounted them in the deployed build.
//
// DB-free, network-free (loopback only). Usage: tsx tests/boot-gate.test.ts

import express, { type Express } from "express";
import http from "http";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import type { AddressInfo } from "net";
import { createBootGate, renderBootPage, type BootGate } from "../server/bootGate";
import { serveStatic, registerEarlyProdStaticHandlers } from "../server/static";
import { WEBHOOK_PATHS } from "../server/routes/limiterMounts";

const SPA_SENTINEL = "OS_SPA_SHELL_SENTINEL";
const DIST_SENTINEL = "REAL_DIST_INDEX_HTML_SENTINEL";

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

interface Resp {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function request(
  port: number,
  reqPath: string,
  opts: { method?: string } = {},
): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: reqPath,
        method: opts.method || "GET",
        agent: false, // no keep-alive sockets to leak past the summary
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

interface Harness {
  app: Express;
  gate: BootGate;
  port: number;
  close(): Promise<void>;
}

/** Bare app wired the same way server/index.ts wires the gates pre-listen. */
async function makeHarness(opts: {
  apiTimeoutMs: number;
  pageTimeoutMs: number;
}): Promise<Harness> {
  const app = express();
  const gate = createBootGate({
    apiTimeoutMs: opts.apiTimeoutMs,
    pageTimeoutMs: opts.pageTimeoutMs,
    webhookPaths: WEBHOOK_PATHS,
  });
  app.use("/api", gate.apiGate);
  app.use(gate.pageGate);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    app,
    gate,
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * Mirrors the end of real bootstrap: routes and the SPA catch-all are
 * appended AFTER the gates (and after requests are already waiting inside
 * them), then the gates release. Express's live dispatch lets the held
 * requests reach these late-mounted handlers — the same mechanism the real
 * /api gate has always relied on.
 */
function finishBootstrap(h: Harness): void {
  h.app.get("/api/whoami", (_req, res) => res.json({ ok: true }));
  h.app.use((_req, res) =>
    res.status(200).type("html").send(`<html>${SPA_SENTINEL}</html>`),
  );
  h.gate.markReady();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function testLoadingPageDuringBoot(): Promise<void> {
  console.log("\nPage requests during boot get the auto-retrying loading page, never 'Cannot GET /'");
  const h = await makeHarness({ apiTimeoutMs: 5_000, pageTimeoutMs: 120 });
  try {
    const res = await request(h.port, "/");
    check("HTTP 503 (retryable)", res.status === 503, `got ${res.status}`);
    check("HTML content type", String(res.headers["content-type"]).includes("text/html"));
    check("starting-variant page", res.body.includes("boot-gate:starting"));
    check("never the raw Express 404", !res.body.includes("Cannot GET"));
    check("no-store so nothing caches the loading page",
      String(res.headers["cache-control"]).includes("no-store"));
    check("Retry-After header set", res.headers["retry-after"] !== undefined);
    check("auto-retries via meta refresh", res.body.includes('http-equiv="refresh"'));
    check("auto-retries via location.reload", res.body.includes("location.reload()"));

    const deep = await request(h.port, "/dashboard");
    check("deep link /dashboard gets the same loading page",
      deep.status === 503 && deep.body.includes("boot-gate:starting"),
      `got ${deep.status}`);

    const head = await request(h.port, "/", { method: "HEAD" });
    check("HEAD / gets 503 headers with empty body",
      head.status === 503 && head.body === "", `got ${head.status} body=${head.body.slice(0, 40)}`);

    const post = await request(h.port, "/form", { method: "POST" });
    check("non-GET/HEAD passes through (historical behavior preserved)",
      post.status === 404, `got ${post.status}`);
  } finally {
    await h.close();
  }
}

async function testHeldPageBecomesRealApp(): Promise<void> {
  console.log("\nA page request held during boot is served the real app once bootstrap completes");
  const h = await makeHarness({ apiTimeoutMs: 5_000, pageTimeoutMs: 3_000 });
  try {
    const started = Date.now();
    const pending = request(h.port, "/");
    const pendingDeep = request(h.port, "/clients/42");
    await sleep(80);
    finishBootstrap(h);
    const [res, deep] = await Promise.all([pending, pendingDeep]);
    const elapsed = Date.now() - started;
    check("held / released with 200", res.status === 200, `got ${res.status}`);
    check("held / got the real app HTML", res.body.includes(SPA_SENTINEL));
    check("held deep link got the real app HTML",
      deep.status === 200 && deep.body.includes(SPA_SENTINEL), `got ${deep.status}`);
    check("released on readiness, not the page timeout", elapsed < 2_000, `${elapsed}ms`);

    const after = await request(h.port, "/");
    check("post-ready passthrough serves the app", after.status === 200 && after.body.includes(SPA_SENTINEL));
    const apiAfter = await request(h.port, "/api/whoami");
    check("post-ready /api serves the real route", apiAfter.status === 200 && apiAfter.body.includes("true"));
  } finally {
    await h.close();
  }
}

async function testApiBootContract(): Promise<void> {
  console.log("\n/api keeps its exact boot 503 contract (JSON BOOT_503 + Retry-After: 10)");
  const h = await makeHarness({ apiTimeoutMs: 120, pageTimeoutMs: 5_000 });
  try {
    const res = await request(h.port, "/api/clients");
    check("HTTP 503", res.status === 503, `got ${res.status}`);
    check("JSON content type", String(res.headers["content-type"]).includes("application/json"));
    check("code BOOT_503", res.body.includes('"code":"BOOT_503"'), res.body.slice(0, 120));
    check("existing error copy unchanged",
      res.body.includes("Server is starting up, please retry shortly."));
    check("Retry-After: 10 unchanged", res.headers["retry-after"] === "10",
      `got ${res.headers["retry-after"]}`);
    check("not the HTML loading page", !res.body.includes("boot-gate:"));

    const health = await request(h.port, "/api/health");
    check("health probe bypasses the gate (no BOOT_503)",
      health.status === 404 && !health.body.includes("BOOT_503"), `got ${health.status}`);
    const webhook = await request(h.port, "/api/webhooks/report-import", { method: "POST" });
    check("webhook path bypasses the gate (no BOOT_503)",
      webhook.status === 404 && !webhook.body.includes("BOOT_503"), `got ${webhook.status}`);
  } finally {
    await h.close();
  }
}

async function testHeldApiReleasedOnReady(): Promise<void> {
  console.log("\nAn /api request held during boot proceeds to its route on readiness");
  const h = await makeHarness({ apiTimeoutMs: 3_000, pageTimeoutMs: 3_000 });
  try {
    const pending = request(h.port, "/api/whoami");
    await sleep(80);
    finishBootstrap(h);
    const res = await pending;
    check("held /api request reached the late-registered route",
      res.status === 200 && res.body.includes("true"), `got ${res.status} ${res.body.slice(0, 60)}`);
  } finally {
    await h.close();
  }
}

async function testBootFailureIsLoudAndServesRetryPage(): Promise<void> {
  console.log("\nBootstrap failure: loud step-named log + immediate failed-variant retry page");
  const h = await makeHarness({ apiTimeoutMs: 4_000, pageTimeoutMs: 4_000 });
  const errLines: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => {
    errLines.push(args.map((a) => String(a)).join(" "));
  };
  try {
    const started = Date.now();
    const pending = request(h.port, "/");
    await sleep(80);
    h.gate.markFailed("auth-setup", new Error("OIDC discovery exploded"));
    const res = await pending;
    const elapsed = Date.now() - started;
    check("held request released immediately on failure (no full timeout wait)",
      elapsed < 2_000, `${elapsed}ms`);
    check("failed-variant page", res.status === 503 && res.body.includes("boot-gate:failed"),
      `got ${res.status}`);
    check("still auto-retrying", res.body.includes('http-equiv="refresh"'));
    check("never the raw Express 404", !res.body.includes("Cannot GET"));

    const later = await request(h.port, "/dashboard");
    check("subsequent page requests get the failed page immediately",
      later.status === 503 && later.body.includes("boot-gate:failed"));
    const api = await request(h.port, "/api/clients");
    check("subsequent /api requests get BOOT_503 immediately",
      api.status === 503 && api.body.includes("BOOT_503"));

    const loud = errLines.join("\n");
    check("failure log names the failing step",
      loud.includes("Bootstrap FAILED") && loud.includes("auth-setup"), loud.slice(0, 160));
    check("failure log carries the error", loud.includes("OIDC discovery exploded"));

    h.gate.markReady();
    check("markReady after failure does not resurrect a half-configured app",
      h.gate.state() === "failed", `state=${h.gate.state()}`);
  } finally {
    console.error = realError;
    await h.close();
  }
}

async function testPostReadyFailureNeverDowngrades(): Promise<void> {
  console.log("\nA failure reported after readiness never flips a serving app back");
  const h = await makeHarness({ apiTimeoutMs: 1_000, pageTimeoutMs: 1_000 });
  const realError = console.error;
  console.error = () => {};
  try {
    finishBootstrap(h);
    h.gate.markFailed("deferred-warmups", new Error("tail blew up"));
    check("state stays ready", h.gate.state() === "ready", `state=${h.gate.state()}`);
    const res = await request(h.port, "/");
    check("app keeps serving", res.status === 200 && res.body.includes(SPA_SENTINEL));
  } finally {
    console.error = realError;
    await h.close();
  }
}

async function testServeStaticDegradesWhenDistMissing(): Promise<void> {
  console.log("\nserveStatic: missing build directory degrades to the retry page instead of throwing");
  const realError = console.error;
  console.error = () => {};
  let threw = false;
  const app = express();
  try {
    serveStatic(app, {
      distPath: path.join(os.tmpdir(), `no-such-dist-${Date.now()}-${Math.random().toString(36).slice(2)}`),
    });
  } catch {
    threw = true;
  } finally {
    console.error = realError;
  }
  check("does not throw mid-bootstrap", !threw);

  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const res = await request(port, "/dashboard");
    check("page routes get the friendly 503 retry page",
      res.status === 503 && res.body.includes("boot-gate:failed"), `got ${res.status}`);
    check("never the raw Express 404", !res.body.includes("Cannot GET"));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function testServeStaticHappyPathUnchanged(): Promise<void> {
  console.log("\nserveStatic: with a real build directory the catch-all still serves index.html");
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), "boot-gate-dist-"));
  fs.writeFileSync(path.join(dist, "index.html"), `<html>${DIST_SENTINEL}</html>`);
  const app = express();
  serveStatic(app, { distPath: dist });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const res = await request(port, "/deep/link");
    check("catch-all serves index.html for client-side routes",
      res.status === 200 && res.body.includes(DIST_SENTINEL), `got ${res.status}`);
    check("html is no-cache", String(res.headers["cache-control"]).includes("no-cache"));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(dist, { recursive: true, force: true });
  }
}

async function testEarlyProdHandlersInstantDuringBoot(): Promise<void> {
  console.log("\nEarly production handlers: / and /assets serve from disk during boot; deep links still gated");
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), "boot-gate-early-"));
  fs.writeFileSync(path.join(dist, "index.html"), `<html>${DIST_SENTINEL}</html>`);
  fs.mkdirSync(path.join(dist, "assets"));
  fs.writeFileSync(path.join(dist, "assets", "app.js"), "console.log('bundle');");

  // Same mount order as server/index.ts: apiGate → early handlers → pageGate.
  const app = express();
  const gate = createBootGate({
    apiTimeoutMs: 5_000,
    pageTimeoutMs: 300,
    webhookPaths: WEBHOOK_PATHS,
  });
  app.use("/api", gate.apiGate);
  const registered = registerEarlyProdStaticHandlers(app, { distPath: dist });
  app.use(gate.pageGate);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    check("handlers registered when the build dir exists", registered === true);
    // The gate never opens in this scenario (no markReady): a 200 here can
    // only come from the early handlers ahead of the page gate.
    const home = await request(port, "/");
    check("/ returns the built index pre-readiness",
      home.status === 200 && home.body.includes(DIST_SENTINEL), `got ${home.status}`);
    const asset = await request(port, "/assets/app.js");
    check("/assets serves from disk pre-readiness",
      asset.status === 200 && asset.body.includes("bundle"), `got ${asset.status}`);
    const deep = await request(port, "/dashboard");
    check("deep links still wait at the page gate (loading page after timeout)",
      deep.status === 503 && deep.body.includes("boot-gate:starting"), `got ${deep.status}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(dist, { recursive: true, force: true });
  }

  const none = registerEarlyProdStaticHandlers(express(), {
    distPath: path.join(os.tmpdir(), `no-such-dist-${Date.now()}`),
  });
  check("missing build dir → returns false without registering", none === false);
}

async function testEarlyProdHandlersWorkInCjsBundle(): Promise<void> {
  console.log("\nCJS production bundle: early handlers resolve via __dirname (import.meta is empty there)");
  // The deployment runs `node dist/index.cjs` (see .replit): esbuild CJS
  // output replaces import.meta with {}. Bundle the real registration code
  // the same way, run it under plain node, and prove "/" serves the built
  // index with NO distPath override — resolution must come from __dirname.
  fs.mkdirSync(path.join(process.cwd(), ".local"), { recursive: true });
  const workDir = fs.mkdtempSync(path.join(process.cwd(), ".local", "boot-gate-cjs-"));
  try {
    const entrySrc = path.join(workDir, "entry.ts");
    fs.writeFileSync(
      entrySrc,
      `import express from "express";
import http from "http";
import { registerEarlyProdStaticHandlers } from ${JSON.stringify(path.resolve("server/static.ts"))};
const app = express();
const registered = registerEarlyProdStaticHandlers(app);
const server = app.listen(0, "127.0.0.1", () => {
  const port = (server.address() as any).port;
  http.get({ host: "127.0.0.1", port, path: "/", agent: false }, (res) => {
    let body = "";
    res.on("data", (c) => (body += c));
    res.on("end", () => {
      console.log(JSON.stringify({ registered, status: res.statusCode, body }));
      server.close(() => process.exit(0));
    });
  });
});
`,
    );
    const outFile = path.join(workDir, "entry.cjs");
    const esbuild = await import("esbuild");
    await esbuild.build({
      entryPoints: [entrySrc],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: outFile,
      external: ["express"],
      logLevel: "silent",
    });
    fs.mkdirSync(path.join(workDir, "public"));
    fs.writeFileSync(
      path.join(workDir, "public", "index.html"),
      `<html>${DIST_SENTINEL}-cjs</html>`,
    );
    const out = execFileSync(process.execPath, [outFile], {
      encoding: "utf8",
      timeout: 20_000,
    });
    const line = out.trim().split("\n").pop() ?? "";
    const parsed = JSON.parse(line) as { registered: boolean; status: number; body: string };
    check("bundled CJS registers the early handlers (no import.meta dependence)",
      parsed.registered === true, line);
    check("bundled CJS serves the built index for / before readiness",
      parsed.status === 200 && parsed.body.includes(`${DIST_SENTINEL}-cjs`), line);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

function testRenderVariantsDistinct(): void {
  console.log("\nrenderBootPage variants are distinct and self-contained");
  const starting = renderBootPage();
  const failedPage = renderBootPage({ failed: true });
  check("starting marker", starting.includes("boot-gate:starting"));
  check("failed marker", failedPage.includes("boot-gate:failed"));
  check("no external asset references (renders while nothing else serves)",
    !/src=|href=/.test(starting), starting.match(/(src|href)=[^ >]*/)?.[0] ?? "");
}

async function main(): Promise<void> {
  console.log("Boot readiness-gate tests (Task #3782)");

  await testLoadingPageDuringBoot();
  await testHeldPageBecomesRealApp();
  await testApiBootContract();
  await testHeldApiReleasedOnReady();
  await testBootFailureIsLoudAndServesRetryPage();
  await testPostReadyFailureNeverDowngrades();
  await testServeStaticDegradesWhenDistMissing();
  await testServeStaticHappyPathUnchanged();
  await testEarlyProdHandlersInstantDuringBoot();
  await testEarlyProdHandlersWorkInCjsBundle();
  testRenderVariantsDistinct();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  process.exit(0);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
