import { build as esbuild } from "esbuild";
import { build as viteBuild } from "vite";
import { rm, readFile, cp } from "fs/promises";
import { assertBuiltLinkPreview } from "../scripts/verify-built-link-preview";

// server deps to bundle to reduce openat(2) syscalls
// which helps cold start times
const allowlist = [
  "@google/generative-ai",
  "axios",
  "connect-pg-simple",
  "date-fns",
  "drizzle-orm",
  "drizzle-zod",
  "express",
  "express-rate-limit",
  "express-session",
  "jsonwebtoken",
  "multer",
  "nodemailer",
  "openai",
  "passport",
  "pg",
  "stripe",
  "uuid",
  "ws",
  "xlsx",
  "zod",
];

async function buildAll() {
  await rm("dist", { recursive: true, force: true });

  console.log("building client...");
  await viteBuild();

  // Task #4670: verify the BUILT shell (not just the client/index.html
  // source, which tests/link-preview-image-guard.test.ts already pins) still
  // ships the canonical NoBull og:image/twitter:image and no Replit-domain
  // meta hosts. A build-time HTML transform (e.g. a re-introduced
  // vite-plugin-meta-images, removed in Task #4641) could rewrite the built
  // tags while the source stays clean. Throws → fails the deploy build
  // (predeploy.sh && npm run build). Runs here — not in the L1 gate —
  // because only the build lane has a fresh artifact.
  assertBuiltLinkPreview("dist/public/index.html");

  console.log("building server...");
  const pkg = JSON.parse(await readFile("package.json", "utf-8"));
  const allDeps = [
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
  ];
  const externals = allDeps.filter((dep) => !allowlist.includes(dep));
  if (!externals.includes("canvas")) externals.push("canvas");

  await esbuild({
    entryPoints: ["server/index.ts"],
    platform: "node",
    bundle: true,
    format: "cjs",
    outfile: "dist/index.cjs",
    define: {
      "process.env.NODE_ENV": '"production"',
    },
    minify: true,
    external: externals,
    logLevel: "info",
  });

  // Task #3740: ship the static marketing website bundle (nobullmarketing.com)
  // alongside the server build. server/website/marketingSite.ts resolves
  // dist/website in production.
  console.log("copying marketing website bundle...");
  await cp("website/public", "dist/website", { recursive: true });
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
