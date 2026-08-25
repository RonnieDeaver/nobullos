import express, { type Express } from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { sendBootPage } from "./bootGate";

/**
 * Directory of this module in both runtimes: dev/tests run ESM under tsx
 * (import.meta.url), while the deployed build is a CJS bundle (__dirname).
 * esbuild replaces `import.meta` with an EMPTY object in CJS output, so code
 * must never gate behavior on `import.meta.*` truthiness — such branches run
 * in dev and silently no-op in production. In both runtimes this resolves to
 * the directory holding the server entrypoint (server/ in dev, dist/ in the
 * bundle), so the client build lives at "<dir>/public" in production.
 */
export function resolveServerModuleDir(): string {
  if (typeof __dirname !== "undefined") return __dirname;
  return path.dirname(fileURLToPath(import.meta.url));
}

/**
 * Early production static handlers: mounted BEFORE the boot page gate and
 * before listen so "/" and the hashed /assets bundles serve from disk
 * instantly during the boot window — the Replit deploy health probe hits "/"
 * within ~5s of deploy and must get its 200 without waiting for bootstrap.
 * (Task #3782: these were previously gated on `import.meta.dirname`, which
 * is empty in the CJS production bundle, so they never mounted in the
 * deployed build and "/" fell through during boot.)
 * Returns true when the build directory exists and handlers were mounted.
 */
export function registerEarlyProdStaticHandlers(
  app: Express,
  opts: { distPath?: string } = {},
): boolean {
  const distPath =
    opts.distPath ?? path.resolve(resolveServerModuleDir(), "public");
  if (!fs.existsSync(distPath)) return false;
  app.use(
    "/assets",
    express.static(path.join(distPath, "assets"), {
      maxAge: "1y",
      immutable: true,
    }),
  );
  app.get("/", (_req, res) => {
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(path.resolve(distPath, "index.html"));
  });
  return true;
}

/**
 * Same-origin vendor route for maplibre-gl (map-style publish-size task).
 *
 * maplibre-gl's dist build is a single prebuilt ~1 MB file rollup cannot
 * tree-shake; bundling it re-shipped the full megabyte in dist/public on
 * every publish. node_modules ships in the deploy image regardless (it is a
 * production dependency), so the server exposes the exact dist files here
 * and client/src/lib/loadMaplibre.ts injects them at runtime only when a
 * map component mounts. URLs carry a ?v=<version> cache-buster (vite define
 * in vite.config.ts), so immutable caching is safe across upgrades.
 *
 * Mounted in BOTH dev and prod (server/index.ts) — dev vite middleware does
 * not serve node_modules files outside the module graph.
 */
export function registerMaplibreVendorRoutes(app: Express): void {
  const distDir = path.resolve(
    resolveServerModuleDir(),
    "..",
    "node_modules",
    "maplibre-gl",
    "dist",
  );
  const FILES: Record<string, string> = {
    "maplibre-gl.js": "text/javascript; charset=utf-8",
    "maplibre-gl.css": "text/css; charset=utf-8",
  };
  app.get("/vendor/maplibre-gl/:file", (req, res) => {
    const file = req.params.file;
    const contentType = FILES[file];
    if (!contentType) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const abs = path.join(distDir, file);
    if (!fs.existsSync(abs)) {
      console.error(
        `[Static] maplibre-gl vendor file missing on disk: ${abs} — is maplibre-gl installed?`,
      );
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.setHeader("Content-Type", contentType);
    // The client always requests with a ?v=<pkg version> cache-buster, so
    // immutable long-lived caching is safe.
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.sendFile(abs);
  });
}

export function serveStatic(app: Express, opts: { distPath?: string } = {}) {
  const moduleDir = resolveServerModuleDir();
  const distPath = opts.distPath ?? path.resolve(moduleDir, "public");
  if (!fs.existsSync(distPath)) {
    // Task #3782 — degrade instead of throwing. Throwing here used to abort
    // bootstrap AFTER the port was already bound, leaving a half-configured
    // server whose non-API responses were Express's raw "Cannot GET /".
    // The API (already registered at this point) keeps working; page loads
    // get the friendly auto-retrying boot page until a real build exists.
    console.error(
      `[Static] FATAL: build directory missing: ${distPath} — the client build was not found ` +
        `(run the build so dist/public exists). Serving the auto-retry boot page for all page ` +
        `routes instead of crashing bootstrap.`,
    );
    app.use("*", (_req, res) => {
      sendBootPage(res, { failed: true });
    });
    return;
  }

  const attachedAssetsPath = path.resolve(moduleDir, "..", "attached_assets");
  if (fs.existsSync(attachedAssetsPath)) {
    app.use("/attached_assets", express.static(attachedAssetsPath));
  }

  app.use("/assets", express.static(path.join(distPath, "assets"), {
    maxAge: "1y",
    immutable: true,
  }));

  app.use(express.static(distPath, {
    maxAge: "1h",
    etag: true,
    index: false,
    setHeaders: (res, filePath) => {
      if (filePath.endsWith(".html")) {
        res.setHeader("Cache-Control", "no-cache");
      }
    },
  }));

  app.use("*", (_req, res) => {
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}
