import * as fs from "fs";
import * as path from "path";

export type ProtectionLevel =
  | "public"
  | "authenticated"
  | "requireCeo"
  | "requireTeamLead"
  | "requireAccountManager"
  | "requireCommandCenterAccess"
  | "requireCeoToolsAuth"
  | "requireTwilioAccess"
  | "requireInternal"
  | "validateTwilioWebhook";

// Task #4180 (route-classification guard): every route is classified into
// exactly one auth class derived from its OBSERVED middleware array:
//   session          — session-authenticated (isAuthenticated + role ladder)
//   machine_token    — constant-time machine token (requireCeoToolsAuth)
//   signed_webhook   — signature-verifying webhook middleware (validateTwilioWebhook)
//   observed_public  — NO recognized auth middleware in the registration.
//     "Observed" is deliberate: in-handler checks (X-Cron-Key, HMAC verify,
//     capability tokens in the URL, spread `...guard` arrays) are invisible
//     to this parser, so observed_public ≠ intentionally-public. Every
//     observed_public route must carry an owner-reviewed entry in
//     scripts/route-public-allowlist.json (see scripts/lint-route-classification.ts).
export type RouteAuthClass =
  | "session"
  | "machine_token"
  | "signed_webhook"
  | "observed_public";

export type RouteClassification =
  | "public"
  | "authenticated"
  | "admin_only"
  | "webhook"
  | "upload"
  | "ai_rate_limited"
  | "token_auth";

export interface RouteEntry {
  method: string;
  path: string;
  file: string;
  line: number;
  middleware: string[];
  protection: ProtectionLevel;
  authClass: RouteAuthClass;
  classifications: RouteClassification[];
  hasUpload: boolean;
  hasRateLimiter: boolean;
  rateLimiterName?: string;
}

const ROUTES_DIR = "server/routes";
const ROOT_ROUTE_FILE = "server/routes.ts";

export function discoverRouteFiles(): string[] {
  const files: string[] = [];
  if (fs.existsSync(ROOT_ROUTE_FILE)) {
    files.push(ROOT_ROUTE_FILE);
  }
  if (fs.existsSync(ROUTES_DIR)) {
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
          files.push(full.split(path.sep).join("/"));
        }
      }
    };
    walk(ROUTES_DIR);
  }
  return files.sort();
}

const ROUTE_REGEX =
  /app\.(get|post|put|patch|delete)\(\s*["'`](\/[^"'`]+)["'`]\s*,\s*(.*?)\s*(?:async\s*)?\(/;

// Task #1574: many route registrations are split across multiple lines, e.g.
//   app.post(
//     "/api/foo",
//     isAuthenticated,
//     requireTeamLead,
//     async (req, res) => { ... }
//   );
// The single-line ROUTE_REGEX above was missing ~300/780 registrations.
// MULTI_LINE_OPEN_REGEX matches the bare `app.METHOD(` opener so we can stitch
// the path + middleware that live on subsequent lines into one logical
// declaration before running the original ROUTE_REGEX against it.
const MULTI_LINE_OPEN_REGEX = /^\s*app\.(get|post|put|patch|delete)\(\s*$/;

// PR9 routes.ts split: a multi-line registration whose handler is a bare
// function REFERENCE (no inline `(req…` / `async (` parameter list), e.g.
//   app.post(
//     "/api/health/manual-reserve-alerts/resend",
//     isAuthenticated,
//     requireTeamLead,
//     handleManualReserveAlertsResend,
//   );
// never satisfies ROUTE_REGEX. Before the split these only parsed by
// accident — the stitcher ran past the closing `);` into the NEXT route's
// `async (` opener. When such a registration is the last route in a file
// (nothing left to stitch), it silently vanished from the inventory.
// BARE_REF_CLOSE_REGEX is used ONLY as a fallback after a stitch found
// neither ROUTE_REGEX nor a handler parameter list (so every previously
// matching registration keeps its exact original parse), completing the
// declaration at its own closing `);` instead.
const BARE_REF_CLOSE_REGEX =
  /app\.(get|post|put|patch|delete)\(\s*["'`](\/[^"'`]+)["'`]\s*,\s*([\s\S]*?),?\s*\)\s*;?\s*$/;

const AUTH_MIDDLEWARE = [
  "isAuthenticated",
  "requireCeo",
  "requireTeamLead",
  "requireAccountManager",
  "requireCommandCenterAccess",
  "requireCeoToolsAuth",
  "requireTwilioAccess",
  "requireInternal",
  "validateTwilioWebhook",
];

const RATE_LIMITERS = [
  "aiLimiter",
  "webhookLimiter",
  "writeLimiter",
  "uploadLimiter",
  "adminLimiter",
  "sensitiveWriteLimiter",
  // Task #4788 — dedicated-bucket write limiters. Detected so the committed
  // inventory attributes them truthfully and tests/rate-limit-coverage.test.ts
  // can enforce the writeLimiter-exemption <-> dedicated-limiter pairing.
  "commsWriteLimiter",
  "sheetsAutosaveLimiter",
  // Task #5097 — book-commerce public checkout surface; dedicated IP-keyed
  // 30/15m bucket for the six /api/book/checkout/* routes.
  "bookCheckoutLimiter",
];

const UPLOAD_MIDDLEWARE = [
  "upload.single",
  "jdUpload.single",
  "upload.array",
  "jdUpload.array",
];

function extractMiddleware(middlewareStr: string): string[] {
  const cleaned = middlewareStr.trim();
  if (!cleaned) return [];

  const allKnown = [...AUTH_MIDDLEWARE, ...RATE_LIMITERS, ...UPLOAD_MIDDLEWARE];
  const allKnownSorted = [...allKnown].sort((a, b) => b.length - a.length);

  const found: { name: string; index: number }[] = [];
  for (const mw of allKnownSorted) {
    const wordBoundaryRegex = new RegExp(`\\b${mw.replace(".", "\\.")}\\b`, "g");
    let match: RegExpExecArray | null;
    while ((match = wordBoundaryRegex.exec(cleaned)) !== null) {
      const alreadyCovered = found.some(
        (f) => match!.index >= f.index && match!.index < f.index + f.name.length
      );
      if (!alreadyCovered) {
        found.push({ name: mw, index: match.index });
        break;
      }
    }
  }

  found.sort((a, b) => a.index - b.index);
  return found.map((f) => f.name);
}

function determineProtection(middleware: string[]): ProtectionLevel {
  if (middleware.includes("requireCeoToolsAuth")) return "requireCeoToolsAuth";
  if (middleware.includes("validateTwilioWebhook")) return "validateTwilioWebhook";
  if (middleware.includes("requireCeo")) return "requireCeo";
  if (middleware.includes("requireTeamLead")) return "requireTeamLead";
  if (middleware.includes("requireCommandCenterAccess")) return "requireCommandCenterAccess";
  if (middleware.includes("requireAccountManager")) return "requireAccountManager";
  if (middleware.includes("requireTwilioAccess")) return "requireTwilioAccess";
  if (middleware.includes("requireInternal")) return "requireInternal";
  if (middleware.includes("isAuthenticated")) return "authenticated";
  return "public";
}

export function determineAuthClass(protection: ProtectionLevel): RouteAuthClass {
  if (protection === "public") return "observed_public";
  if (protection === "requireCeoToolsAuth") return "machine_token";
  if (protection === "validateTwilioWebhook") return "signed_webhook";
  return "session";
}

function classifyRoute(entry: {
  method: string;
  path: string;
  middleware: string[];
  protection: ProtectionLevel;
  hasUpload: boolean;
  hasRateLimiter: boolean;
}): RouteClassification[] {
  const classes: RouteClassification[] = [];

  if (entry.protection === "public") classes.push("public");
  else if (entry.protection === "requireCeoToolsAuth") classes.push("token_auth");
  else if (entry.protection === "validateTwilioWebhook") classes.push("webhook");
  else classes.push("authenticated");

  if (
    entry.protection === "requireCeo" ||
    entry.path.includes("/admin/")
  ) {
    classes.push("admin_only");
  }

  if (
    entry.path.includes("/webhook") ||
    entry.path.includes("/webhooks/")
  ) {
    if (!classes.includes("webhook")) classes.push("webhook");
  }

  if (entry.hasUpload) classes.push("upload");
  if (entry.hasRateLimiter) classes.push("ai_rate_limited");

  return classes;
}

export function parseRoutes(routeFiles?: string[]): RouteEntry[] {
  const routes: RouteEntry[] = [];
  const files = routeFiles ?? discoverRouteFiles();

  for (const filePath of files) {
    const fullPath = path.resolve(filePath);
    if (!fs.existsSync(fullPath)) {
      console.warn(`File not found: ${filePath}`);
      continue;
    }

    const content = fs.readFileSync(fullPath, "utf-8");
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Task #1574: handle multi-line `app.METHOD(` openers by stitching the
      // following lines into a single buffer until we either match the full
      // ROUTE_REGEX or hit the handler opening (`async (` / `(req`).
      let logicalLine = line;
      let stitched = false;
      let bareRefMatch: RegExpMatchArray | null = null;
      if (MULTI_LINE_OPEN_REGEX.test(line)) {
        const parts: string[] = [line.trim()];
        for (let j = i + 1; j < Math.min(i + 25, lines.length); j++) {
          parts.push(lines[j].trim());
          const candidate = parts.join(" ");
          if (ROUTE_REGEX.test(candidate)) {
            logicalLine = candidate;
            stitched = true;
            break;
          }
          // Stop once we see the handler's parameter list — anything past
          // here is body, not signature.
          if (/\basync\s*\(/.test(lines[j]) || /\(\s*req\b/.test(lines[j])) {
            logicalLine = parts.join(" ");
            stitched = true;
            break;
          }
        }
        // Fallback for bare-reference handlers (see BARE_REF_CLOSE_REGEX):
        // the loop above found neither a full ROUTE_REGEX match nor a handler
        // parameter list. If the buffer up to the registration's own closing
        // `);` line parses as `app.METHOD("/path", …refs…)`, take that.
        if (!stitched) {
          const closeIdx = parts.findIndex((p, idx) => idx > 0 && /^\)\s*;?$/.test(p));
          if (closeIdx > 0) {
            const candidate = parts.slice(0, closeIdx + 1).join(" ");
            bareRefMatch = candidate.match(BARE_REF_CLOSE_REGEX);
            if (bareRefMatch) {
              logicalLine = candidate;
              stitched = true;
            }
          }
        }
      }

      const match = logicalLine.match(ROUTE_REGEX) ?? bareRefMatch;
      if (!match) continue;

      const method = match[1].toUpperCase();
      const routePath = match[2];
      const middlewareStr = match[3];
      void stitched;

      const middleware = extractMiddleware(middlewareStr);
      const hasUpload = UPLOAD_MIDDLEWARE.some((ul) => middlewareStr.includes(ul));
      const hasRateLimiter = RATE_LIMITERS.some((rl) => middlewareStr.includes(rl));
      const rateLimiterName = RATE_LIMITERS.find((rl) => middlewareStr.includes(rl));

      const protection = determineProtection(middleware);
      const authClass = determineAuthClass(protection);
      const classifications = classifyRoute({
        method,
        path: routePath,
        middleware,
        protection,
        hasUpload,
        hasRateLimiter,
      });

      routes.push({
        method,
        path: routePath,
        file: filePath,
        line: i + 1,
        middleware,
        protection,
        authClass,
        classifications,
        hasUpload,
        hasRateLimiter,
        rateLimiterName,
      });
    }
  }

  return routes;
}

export function generateInventoryReport(routes: RouteEntry[]): string {
  const lines: string[] = [];

  lines.push("# Route Inventory Report");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Total routes discovered: ${routes.length}`);
  lines.push("");

  const byProtection = new Map<string, RouteEntry[]>();
  for (const r of routes) {
    const key = r.protection;
    if (!byProtection.has(key)) byProtection.set(key, []);
    byProtection.get(key)!.push(r);
  }

  lines.push("## Summary by Protection Level");
  lines.push("");
  lines.push("| Protection | Count |");
  lines.push("|---|---|");
  for (const [prot, entries] of byProtection) {
    lines.push(`| ${prot} | ${entries.length} |`);
  }
  lines.push("");

  const byFile = new Map<string, RouteEntry[]>();
  for (const r of routes) {
    if (!byFile.has(r.file)) byFile.set(r.file, []);
    byFile.get(r.file)!.push(r);
  }

  lines.push("## Summary by File");
  lines.push("");
  lines.push("| File | Count |");
  lines.push("|---|---|");
  for (const [file, entries] of byFile) {
    lines.push(`| ${file} | ${entries.length} |`);
  }
  lines.push("");

  const byClassification = new Map<string, number>();
  for (const r of routes) {
    for (const c of r.classifications) {
      byClassification.set(c, (byClassification.get(c) || 0) + 1);
    }
  }

  lines.push("## Summary by Classification");
  lines.push("");
  lines.push("| Classification | Count |");
  lines.push("|---|---|");
  for (const [cls, count] of byClassification) {
    lines.push(`| ${cls} | ${count} |`);
  }
  lines.push("");

  lines.push("## Public Routes (No Auth Required)");
  lines.push("");
  lines.push("| Method | Path | File | Middleware |");
  lines.push("|---|---|---|---|");
  for (const r of routes.filter((r) => r.protection === "public")) {
    lines.push(
      `| ${r.method} | ${r.path} | ${r.file}:${r.line} | ${r.middleware.join(", ") || "none"} |`
    );
  }
  lines.push("");

  lines.push("## Webhook Routes");
  lines.push("");
  lines.push("| Method | Path | File | Protection | Middleware |");
  lines.push("|---|---|---|---|---|");
  for (const r of routes.filter((r) => r.classifications.includes("webhook"))) {
    lines.push(
      `| ${r.method} | ${r.path} | ${r.file}:${r.line} | ${r.protection} | ${r.middleware.join(", ") || "none"} |`
    );
  }
  lines.push("");

  lines.push("## Token-Auth Routes (API Key / Bearer Token)");
  lines.push("");
  lines.push("| Method | Path | File | Middleware |");
  lines.push("|---|---|---|---|");
  for (const r of routes.filter((r) => r.classifications.includes("token_auth"))) {
    lines.push(
      `| ${r.method} | ${r.path} | ${r.file}:${r.line} | ${r.middleware.join(", ")} |`
    );
  }
  lines.push("");

  lines.push("## AI/Rate-Limited Routes");
  lines.push("");
  lines.push("| Method | Path | File | Rate Limiter | Protection |");
  lines.push("|---|---|---|---|---|");
  for (const r of routes.filter((r) => r.hasRateLimiter)) {
    lines.push(
      `| ${r.method} | ${r.path} | ${r.file}:${r.line} | ${r.rateLimiterName} | ${r.protection} |`
    );
  }
  lines.push("");

  lines.push("## Upload Routes");
  lines.push("");
  lines.push("| Method | Path | File | Upload Middleware | Protection |");
  lines.push("|---|---|---|---|---|");
  for (const r of routes.filter((r) => r.hasUpload)) {
    lines.push(
      `| ${r.method} | ${r.path} | ${r.file}:${r.line} | ${r.middleware.filter((m) => UPLOAD_MIDDLEWARE.some((u) => m.includes(u))).join(", ")} | ${r.protection} |`
    );
  }
  lines.push("");

  lines.push("## Full Route Inventory");
  lines.push("");
  lines.push("| # | Method | Path | File:Line | Protection | Middleware | Classifications |");
  lines.push("|---|---|---|---|---|---|---|");
  routes.forEach((r, i) => {
    lines.push(
      `| ${i + 1} | ${r.method} | ${r.path} | ${r.file}:${r.line} | ${r.protection} | ${r.middleware.join(", ") || "none"} | ${r.classifications.join(", ")} |`
    );
  });

  return lines.join("\n");
}

// Must be an exact-filename match: a loose `includes("route-inventory")`
// also fired when scripts/lint-route-inventory-freshness.ts (or its test)
// imported this module, silently REWRITING the inventory at import time —
// which would self-heal staleness and defeat the freshness lint.
const isMainModule =
  import.meta.url === `file://${process.argv[1]}` ||
  (process.argv[1]?.endsWith("/route-inventory.ts") ?? false);
if (isMainModule) {
  const routes = parseRoutes();
  const report = generateInventoryReport(routes);
  const outputPath = "tests/route-inventory-report.md";
  fs.writeFileSync(outputPath, report);
  console.log(`Route inventory written to ${outputPath}`);
  console.log(`Total routes: ${routes.length}`);

  const jsonPath = "tests/route-inventory.json";
  fs.writeFileSync(jsonPath, JSON.stringify(routes, null, 2));
  console.log(`Route data written to ${jsonPath}`);
}
