/* test-registration
{
  "name": "Rate limit coverage",
  "smoke": true,
  "smokeReason": "Task #4091: repo-wide invariant that every webhook/upload/admin/sensitive-write route is covered by a limiter mount in server/routes/limiterMounts.ts. It reads route files via fs (invisible to import tracing), so it is ALSO listed in DEFAULT_CORE_RULES as an always-run core suite — it must never green-skip while route files change elsewhere (three Zoom match-assistant mutations shipped uncovered exactly this way). Fast, DB-free, deterministic source scan. Task #4788 extends it with the dedicated-bucket write exemption pairing, enforced in BOTH directions: every DEDICATED_BUCKET_WRITE_ROUTES entry must name a real route carrying its dedicated limiter, and every route carrying commsWriteLimiter/sheetsAutosaveLimiter must be listed, so no exempted route is ever unlimited and no dedicated-bucket route silently double-counts into the shared write budget again.",
  "tier": "medium"
}
test-registration */
import * as fs from "fs";
import * as path from "path";
import { parseRoutes, type RouteEntry } from "./route-inventory";

const SERVER_INDEX_PATH = "server/index.ts";
const MIDDLEWARE_PATH = "server/routes/middleware.ts";
const LIMITER_MOUNTS_PATH = "server/routes/limiterMounts.ts";

interface Violation {
  category: "webhook" | "upload" | "admin_only" | "sensitive_write";
  method: string;
  path: string;
  file: string;
  line: number;
  reason: string;
}

function readFile(rel: string): string {
  return fs.readFileSync(path.resolve(rel), "utf-8");
}

// Replace // line comments and /* block comments */ with spaces while
// respecting string literals, so punctuation (apostrophes, quotes) inside
// comments can never flip the string-extraction regex into garbage entries.
// Observed during Task #3829: a comment containing "member's" corrupted
// extraction and produced false inline-literal failures.
function stripComments(source: string): string {
  let out = "";
  let i = 0;
  let stringChar: string | null = null; // ' " or ` when inside a string
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (stringChar) {
      out += ch;
      if (ch === "\\") {
        // Escaped char inside string — copy it verbatim and skip.
        if (i + 1 < source.length) out += source[i + 1];
        i += 2;
        continue;
      }
      if (ch === stringChar) stringChar = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      stringChar = ch;
      out += ch;
      i++;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }
    if (ch === "/" && next === "*") {
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
        out += source[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (i < source.length) {
        out += "  ";
        i += 2;
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function extractStringArray(source: string, variableName: string): string[] {
  const cleaned = stripComments(source);
  const regex = new RegExp(
    `(?:const|let|var|export\\s+const)\\s+${variableName}\\s*(?::\\s*[^=]+)?=\\s*\\[([\\s\\S]*?)\\]`,
    "m"
  );
  const match = cleaned.match(regex);
  if (!match) {
    throw new Error(
      `Could not extract array "${variableName}" from source — did the variable name change?`
    );
  }
  const body = match[1];
  const items: string[] = [];
  const itemRegex = /["'`]([^"'`]+)["'`]/g;
  let m: RegExpExecArray | null;
  while ((m = itemRegex.exec(body)) !== null) {
    items.push(m[1]);
  }
  return items;
}

// Self-test: comments containing apostrophes/quotes inside (or around) the
// array body must not corrupt extraction.
function selfTestExtraction() {
  const fixture = [
    `// a member's note before the array (apostrophe + "quotes")`,
    `const SAMPLE_PATHS = [`,
    `  "/api/one", // the member's favorite path — don't break`,
    `  '/api/two', /* block comment with "double" and 'single' quotes */`,
    `  "/api/three",`,
    `  // trailing comment: it's fine`,
    `];`,
  ].join("\n");
  const got = extractStringArray(fixture, "SAMPLE_PATHS");
  const want = ["/api/one", "/api/two", "/api/three"];
  if (got.length !== want.length || want.some((w, idx) => got[idx] !== w)) {
    throw new Error(
      `extractStringArray self-test failed — comments with quotes corrupted extraction. ` +
        `Expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`
    );
  }
}

// Task #3860 — guard the Task #3853 fix: adminLimiter and sensitiveWriteLimiter
// must keep skipping read-only methods (GET/HEAD/OPTIONS), and every mount of
// those limiters in server/index.ts must keep its request tracker in
// mutatingOnly mode. Without these assertions, a future edit could drop the
// skip and silently reintroduce read-traffic starvation of the strict
// 30/15-per-15min mutation budgets.
function extractDeclarationBlock(cleanedSource: string, declName: string): string {
  const startRe = new RegExp(`export\\s+const\\s+${declName}\\s*=`, "m");
  const m = cleanedSource.match(startRe);
  if (!m || m.index === undefined) {
    throw new Error(
      `Could not find "export const ${declName}" in ${MIDDLEWARE_PATH} — did the limiter get renamed? ` +
        `If so, update this test AND verify the read-only-method skip survived the rename.`
    );
  }
  // Capture through the closing of the rateLimit({...}) call: find the first
  // ");" at column-0-ish depth by tracking paren balance from the match start.
  let depth = 0;
  let started = false;
  for (let i = m.index; i < cleanedSource.length; i++) {
    const ch = cleanedSource[i];
    if (ch === "(") {
      depth++;
      started = true;
    } else if (ch === ")") {
      depth--;
      if (started && depth === 0) {
        return cleanedSource.slice(m.index, i + 1);
      }
    }
  }
  throw new Error(`Unbalanced parentheses while extracting "${declName}" from ${MIDDLEWARE_PATH}`);
}

function assertMethodAwareLimiters(middlewareSrc: string, indexSrc: string): string[] {
  const errors: string[] = [];
  const cleanedMw = stripComments(middlewareSrc);
  const cleanedIdx = stripComments(indexSrc);

  // 1) The shared skip helper must exist and cover all three read-only methods.
  const skipFnMatch = cleanedMw.match(
    /const\s+skipReadOnlyMethods\s*=\s*\(req[^)]*\)\s*=>[\s\S]{0,400}?;/m
  );
  if (!skipFnMatch) {
    errors.push(
      `${MIDDLEWARE_PATH}: skipReadOnlyMethods helper not found. adminLimiter and ` +
        `sensitiveWriteLimiter must skip GET/HEAD/OPTIONS so polled admin dashboards ` +
        `never consume the strict mutation budgets (Task #3853).`
    );
  } else {
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      if (!new RegExp(`req\\.method\\s*===\\s*["'\`]${method}["'\`]`).test(skipFnMatch[0])) {
        errors.push(
          `${MIDDLEWARE_PATH}: skipReadOnlyMethods no longer checks req.method === "${method}". ` +
            `All of GET, HEAD, OPTIONS must be skipped by the write-only limiters.`
        );
      }
    }
  }

  // 2) Both write-only limiters must wire the skip.
  for (const limiterName of ["adminLimiter", "sensitiveWriteLimiter"]) {
    const block = extractDeclarationBlock(cleanedMw, limiterName);
    if (!/skip\s*:\s*skipReadOnlyMethods/.test(block)) {
      errors.push(
        `${MIDDLEWARE_PATH}: ${limiterName} lost its "skip: skipReadOnlyMethods" option. ` +
          `This limiter throttles privileged MUTATIONS only; without the skip, polled admin ` +
          `GETs consume the strict per-15min budget and starve real writes (Task #3853).`
      );
    }
  }

  // 3) The tracker must honor mutatingOnly (else usage stats / auto-tune over-count
  //    reads the limiter never sees).
  if (!/options\.mutatingOnly\s*&&\s*skipReadOnlyMethods\s*\(\s*req\s*\)/.test(cleanedMw)) {
    errors.push(
      `${MIDDLEWARE_PATH}: createRequestTracker no longer short-circuits on ` +
        `"options.mutatingOnly && skipReadOnlyMethods(req)". Trackers for the write-only ` +
        `limiter categories must not count read-only methods.`
    );
  }

  // 4) Every mount of adminLimiter / sensitiveWriteLimiter must be paired with a
  //    mutatingOnly tracker for the matching category.
  for (const [limiterName, category] of [
    ["adminLimiter", "admin"],
    ["sensitiveWriteLimiter", "sensitiveWrite"],
  ] as const) {
    const mountCount = (cleanedIdx.match(new RegExp(`app\\.use\\([^)]*,\\s*${limiterName}\\s*\\)`, "g")) || []).length;
    const trackerRe = new RegExp(
      `createRequestTracker\\(\\s*["'\`]${category}["'\`]\\s*,\\s*\\{\\s*mutatingOnly\\s*:\\s*true\\s*\\}\\s*\\)`,
      "g"
    );
    const trackerCount = (cleanedIdx.match(trackerRe) || []).length;
    if (mountCount === 0) {
      errors.push(
        `${SERVER_INDEX_PATH} (+server/boot/*): no app.use(..., ${limiterName}) mounts found — ` +
          `did the mounting move? Update this test to scan the new location.`
      );
    } else if (trackerCount < mountCount) {
      errors.push(
        `${SERVER_INDEX_PATH} (+server/boot/*): ${limiterName} is mounted ${mountCount}x but ` +
          `createRequestTracker("${category}", { mutatingOnly: true }) appears only ${trackerCount}x. ` +
          `Every ${limiterName} mount must pair with a mutatingOnly "${category}" tracker so usage ` +
          `stats stay aligned with what the limiter actually throttles (Task #3853/#3860).`
      );
    }
    // A non-mutatingOnly tracker for these categories is also a regression.
    const plainTrackerRe = new RegExp(
      `createRequestTracker\\(\\s*["'\`]${category}["'\`]\\s*\\)`,
      "g"
    );
    const plainCount = (cleanedIdx.match(plainTrackerRe) || []).length;
    if (plainCount > 0) {
      errors.push(
        `${SERVER_INDEX_PATH} (+server/boot/*): found ${plainCount}x createRequestTracker("${category}") ` +
          `WITHOUT { mutatingOnly: true }. The "${category}" limiter skips read-only methods, so its ` +
          `tracker must too, or usage stats over-count.`
      );
    }
  }

  return errors;
}

// ── Task #4788 — dedicated-bucket write exemption pairing ───────────────────
// Mutations listed in DEDICATED_BUCKET_WRITE_ROUTES are skipped by the shared
// writeLimiter (60/15min) because a dedicated bucket governs them. That skip
// is only safe while BOTH directions of the pairing hold:
//   forward:  every listed entry names a real route that actually carries its
//             dedicated limiter (otherwise the route would be write-unlimited);
//   reverse:  every route carrying commsWriteLimiter / sheetsAutosaveLimiter
//             is listed (otherwise it silently double-counts into the shared
//             bucket again — the exact bug that 429d availability saves).
// The wiring assertions pin the skip in writeLimiter, its mirror in the write
// usage tracker (Task #3853 convention), and computeLimitersForRoute, plus
// the Task #944B webhook skip that must survive alongside.

const DEDICATED_BUCKET_PAIRING = [
  { listName: "COMMS_WRITE_BUCKET_ROUTES", limiterName: "commsWriteLimiter" },
  { listName: "SHEETS_AUTOSAVE_BUCKET_ROUTES", limiterName: "sheetsAutosaveLimiter" },
] as const;

const DEDICATED_BUCKET_LIST_NAMES = [
  "COMMS_WRITE_BUCKET_ROUTES",
  "SHEETS_AUTOSAVE_BUCKET_ROUTES",
  "BACKGROUND_POLLING_BUCKET_WRITE_ROUTES",
] as const;

function splitMethodPathEntry(entry: string): { method: string; path: string } | null {
  const idx = entry.indexOf(" ");
  if (idx <= 0) return null;
  const method = entry.slice(0, idx);
  const p = entry.slice(idx + 1).trim();
  if (!p.startsWith("/")) return null;
  return { method, path: p };
}

// Segment-wise equality where a `:param` on either side matches any single
// segment — mirrors methodPathMatches in server/routes/limiterMounts.ts.
function routePathSegsMatch(a: string, b: string): boolean {
  const as = a.split("/").filter(Boolean);
  const bs = b.split("/").filter(Boolean);
  if (as.length !== bs.length) return false;
  for (let i = 0; i < as.length; i++) {
    if (as[i].startsWith(":") || bs[i].startsWith(":")) continue;
    if (as[i] !== bs[i]) return false;
  }
  return true;
}

function assertDedicatedBucketPairing(
  limiterMountsSrc: string,
  middlewareSrc: string,
  indexSrc: string,
  routes: RouteEntry[],
): string[] {
  const errors: string[] = [];
  const cleanedMounts = stripComments(limiterMountsSrc);
  const cleanedMw = stripComments(middlewareSrc);
  const cleanedIdx = stripComments(indexSrc);

  // 1) Combined list is composed of exactly the three per-bucket lists.
  const combinedMatch = cleanedMounts.match(
    /export\s+const\s+DEDICATED_BUCKET_WRITE_ROUTES\s*(?::\s*[^=]+)?=\s*\[([\s\S]*?)\]/m,
  );
  if (!combinedMatch) {
    errors.push(
      `${LIMITER_MOUNTS_PATH}: DEDICATED_BUCKET_WRITE_ROUTES not found — the writeLimiter ` +
        `dedicated-bucket exemption (Task #4788) lost its source list.`,
    );
  } else {
    for (const part of DEDICATED_BUCKET_LIST_NAMES) {
      if (!combinedMatch[1].includes(`...${part}`)) {
        errors.push(
          `${LIMITER_MOUNTS_PATH}: DEDICATED_BUCKET_WRITE_ROUTES no longer spreads ${part} — ` +
            `entries in that list would stop being exempt while their dedicated limiter still applies.`,
        );
      }
    }
  }

  // 2) writeLimiter wires the matcher AND keeps the Task #944B webhook skip.
  const writeBlock = extractDeclarationBlock(cleanedMw, "writeLimiter");
  if (!/isDedicatedBucketWriteRoute\s*\(\s*req\.method\s*,\s*req\.originalUrl\s*\)/.test(writeBlock)) {
    errors.push(
      `${MIDDLEWARE_PATH}: writeLimiter lost its isDedicatedBucketWriteRoute(req.method, req.originalUrl) ` +
        `skip. Dedicated-bucket auto-fire writes (comms heartbeat/typing, sheets/docs autosave, activity ` +
        `telemetry) would drain the shared 60/15min budget again and 429 unrelated saves (Task #4788).`,
    );
  }
  if (!/WEBHOOK_PATHS\.some\s*\(/.test(writeBlock)) {
    errors.push(
      `${MIDDLEWARE_PATH}: writeLimiter lost its WEBHOOK_PATHS skip (Task #944B). Webhook traffic ` +
        `must never consume the user-facing write budget.`,
    );
  }

  // 3) The write usage tracker mirrors the skip (Task #3853 convention).
  if (!/!isDedicatedBucketWriteRoute\s*\(\s*req\.method\s*,\s*req\.originalUrl\s*\)/.test(cleanedIdx)) {
    errors.push(
      `${SERVER_INDEX_PATH} (+server/boot/*): the write-category usage tracker no longer mirrors the ` +
        `dedicated-bucket skip via !isDedicatedBucketWriteRoute(req.method, req.originalUrl). Usage stats ` +
        `and auto-tune would over-count traffic the limiter never sees (Task #3853/#4788).`,
    );
  }

  // 4) computeLimitersForRoute mirrors the skip so the route inventory and
  //    endpoint contract table attribute writeLimiter truthfully.
  if (!/isDedicatedBucketWriteRoute\s*\(\s*m\s*,\s*routePath\s*\)/.test(cleanedMounts)) {
    errors.push(
      `${LIMITER_MOUNTS_PATH}: computeLimitersForRoute no longer consults isDedicatedBucketWriteRoute — ` +
        `the committed route inventory would claim writeLimiter coverage the runtime skip removes.`,
    );
  }

  // 5) The lists live ONLY in limiterMounts.ts.
  for (const name of [...DEDICATED_BUCKET_LIST_NAMES, "DEDICATED_BUCKET_WRITE_ROUTES"]) {
    if (new RegExp(`(?:const|let|var)\\s+${name}\\s*(?::|=)`, "m").test(cleanedIdx)) {
      errors.push(
        `${SERVER_INDEX_PATH} (+server/boot/*): redeclares ${name}; ${LIMITER_MOUNTS_PATH} is the single ` +
          `source of truth for the dedicated-bucket exemption lists.`,
      );
    }
  }

  // 6) Entries are well-formed mutating "METHOD /path" strings, unique across
  //    all three lists.
  const seen = new Map<string, string>();
  const listedByName = new Map<string, string[]>();
  for (const name of DEDICATED_BUCKET_LIST_NAMES) {
    const entries = extractStringArray(limiterMountsSrc, name);
    listedByName.set(name, entries);
    if (entries.length === 0) {
      errors.push(`${LIMITER_MOUNTS_PATH}: ${name} extraction returned an empty list.`);
    }
    for (const entry of entries) {
      const parsed = splitMethodPathEntry(entry);
      if (!parsed || !MUTATING_METHODS.has(parsed.method) || !parsed.path.startsWith("/api")) {
        errors.push(
          `${LIMITER_MOUNTS_PATH}: ${name} entry "${entry}" is malformed — entries must be ` +
            `"METHOD /api/..." with a mutating method (writeLimiter already skips reads).`,
        );
        continue;
      }
      const key = `${parsed.method} ${parsed.path}`;
      const prior = seen.get(key);
      if (prior) {
        errors.push(`${LIMITER_MOUNTS_PATH}: "${key}" appears in both ${prior} and ${name}.`);
      } else {
        seen.set(key, name);
      }
    }
  }

  // 7) Forward + reverse pairing for the inline dedicated limiters.
  for (const { listName, limiterName } of DEDICATED_BUCKET_PAIRING) {
    const entries = listedByName.get(listName) ?? [];
    for (const entry of entries) {
      const parsed = splitMethodPathEntry(entry);
      if (!parsed) continue; // malformed already reported
      const matching = routes.filter(
        (r) => r.method === parsed.method && routePathSegsMatch(r.path, parsed.path),
      );
      if (matching.length === 0) {
        errors.push(
          `${LIMITER_MOUNTS_PATH}: ${listName} entry "${entry}" matches no registered route — ` +
            `remove the stale entry (a dangling exemption is a write-unlimited hole waiting for a route).`,
        );
        continue;
      }
      const carrying = matching.filter((r) => r.rateLimiterName === limiterName);
      if (carrying.length !== matching.length) {
        const bad = matching.filter((r) => r.rateLimiterName !== limiterName);
        for (const r of bad) {
          errors.push(
            `${listName} lists "${entry}" but ${r.method} ${r.path} (${r.file}:${r.line}) does not carry ` +
              `${limiterName} inline — an exempted route without its dedicated limiter is unlimited. ` +
              `Add ${limiterName} to the route or remove the entry.`,
          );
        }
      }
    }
    // Reverse: every route carrying the dedicated limiter must be listed.
    for (const r of routes) {
      if (r.rateLimiterName !== limiterName) continue;
      if (!MUTATING_METHODS.has(r.method)) continue;
      const covered = entries.some((entry) => {
        const parsed = splitMethodPathEntry(entry);
        return parsed !== null && parsed.method === r.method && routePathSegsMatch(parsed.path, r.path);
      });
      if (!covered) {
        errors.push(
          `${r.method} ${r.path} (${r.file}:${r.line}) carries ${limiterName} but is missing from ` +
            `${listName} in ${LIMITER_MOUNTS_PATH} — it double-counts into the shared write bucket ` +
            `(the exact Task #4788 bug). Add "` + `${r.method} ${r.path}` + `" to ${listName}.`,
        );
      }
    }
  }

  // 8) background_polling-bucket entries: the method-blind app.use mounts in
  //    server/boot/httpApp.ts are the dedicated limiter, so each entry must be
  //    covered by BACKGROUND_POLLING_PATHS and must name a real route.
  const bgEntries = listedByName.get("BACKGROUND_POLLING_BUCKET_WRITE_ROUTES") ?? [];
  let bgMountPaths: string[] = [];
  try {
    bgMountPaths = extractStringArray(indexSrc, "BACKGROUND_POLLING_PATHS");
  } catch {
    errors.push(
      `server/boot/httpApp.ts: BACKGROUND_POLLING_PATHS not found — the background_polling bucket ` +
        `moved; update this test and re-verify the POST /api/activity exemption pairing.`,
    );
  }
  for (const entry of bgEntries) {
    const parsed = splitMethodPathEntry(entry);
    if (!parsed) continue;
    const matching = routes.filter(
      (r) => r.method === parsed.method && routePathSegsMatch(r.path, parsed.path),
    );
    if (matching.length === 0) {
      errors.push(
        `${LIMITER_MOUNTS_PATH}: BACKGROUND_POLLING_BUCKET_WRITE_ROUTES entry "${entry}" matches no ` +
          `registered route — remove the stale entry.`,
      );
    }
    if (
      bgMountPaths.length > 0 &&
      !bgMountPaths.some((mp) => parsed.path === mp || parsed.path.startsWith(mp + "/"))
    ) {
      errors.push(
        `${LIMITER_MOUNTS_PATH}: BACKGROUND_POLLING_BUCKET_WRITE_ROUTES entry "${entry}" is not covered ` +
          `by any BACKGROUND_POLLING_PATHS mount in server/boot/httpApp.ts — without that method-blind ` +
          `mount the route has no dedicated bucket and must not be exempt from writeLimiter.`,
      );
    }
  }

  return errors;
}

function isWebhookRoute(route: RouteEntry): boolean {
  return /\/webhooks?(\/|$)/.test(route.path);
}

const SENSITIVE_WRITE_PATTERNS: RegExp[] = [
  /^\/api\/admin(\/|$)/,
  /^\/api\/integrations\/[^/]+\/(connect|disconnect|save-key)(\/|$)/,
  /^\/api\/health\/(block-ip|unblock-ip)(\/|$)/,
  /^\/api\/health\/thresholds(\/|$)/,
  /^\/api\/health\/rate-limits\/(auto-tune|apply-suggestion|thresholds)(\/|$)/,
  /^\/api\/users\/[^/]+\/role(\/|$)/,
  /^\/api\/clients\/[^/]+\/stripe-link(\/|$)/,
];

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function isSensitiveWriteRoute(route: RouteEntry): boolean {
  if (!MUTATING_METHODS.has(route.method)) return false;
  return SENSITIVE_WRITE_PATTERNS.some((re) => re.test(route.path));
}

function routeIsCoveredByPrefix(routePath: string, mountPaths: string[]): boolean {
  for (const mount of mountPaths) {
    if (routePath === mount) return true;
    if (routePath.startsWith(mount + "/")) return true;
  }
  return false;
}

function main() {
  selfTestExtraction();

  const limiterMountsSrc = readFile(LIMITER_MOUNTS_PATH);

  const webhookPaths = extractStringArray(limiterMountsSrc, "WEBHOOK_PATHS");
  const uploadPaths = extractStringArray(limiterMountsSrc, "UPLOAD_PATHS");
  const adminOnlyPaths = extractStringArray(limiterMountsSrc, "ADMIN_ONLY_PATHS");
  // Task #3829 — read-heavy admin surfaces mounted under the roomier
  // adminReadLimiter (adminLimiter's 30-req budget breaks dashboard UIs).
  const adminReadPaths = extractStringArray(limiterMountsSrc, "ADMIN_READ_PATHS");
  const sensitiveWritePaths = extractStringArray(limiterMountsSrc, "SENSITIVE_WRITE_PATHS");
  const authLimiterPaths = extractStringArray(limiterMountsSrc, "AUTH_LIMITER_PATHS");

  if (webhookPaths.length === 0) throw new Error("WEBHOOK_PATHS extraction returned empty list");
  if (uploadPaths.length === 0) throw new Error("UPLOAD_PATHS extraction returned empty list");
  if (adminOnlyPaths.length === 0) throw new Error("ADMIN_ONLY_PATHS extraction returned empty list");
  if (adminReadPaths.length === 0) throw new Error("ADMIN_READ_PATHS extraction returned empty list");
  if (sensitiveWritePaths.length === 0) throw new Error("SENSITIVE_WRITE_PATHS extraction returned empty list");
  if (authLimiterPaths.length === 0) throw new Error("AUTH_LIMITER_PATHS extraction returned empty list");

  // Sync assertion: server/index.ts must reference these path lists by import,
  // not by inlining the strings or redeclaring the arrays. limiterMounts.ts is the
  // single source of truth — if anyone copies a path back into index.ts, this fails.
  // Task #3787: server/index.ts is a thin orchestrator over server/boot/*;
  // startup wiring may live in either, so scan the combined boot surface.
  const indexSrc = [
    SERVER_INDEX_PATH,
    ...fs.readdirSync(path.resolve("server/boot")).filter((n) => n.endsWith(".ts")).sort()
      .map((n) => `server/boot/${n}`),
  ].map(readFile).join("\n");
  const inlineRedeclarations: string[] = [];
  for (const name of [
    "WEBHOOK_PATHS",
    "UPLOAD_PATHS",
    "ADMIN_ONLY_PATHS",
    "ADMIN_READ_PATHS",
    "SENSITIVE_WRITE_PATHS",
    "AUTH_LIMITER_PATHS",
  ]) {
    const re = new RegExp(`(?:const|let|var)\\s+${name}\\s*(?::|=)`, "m");
    if (re.test(indexSrc)) inlineRedeclarations.push(name);
  }
  if (inlineRedeclarations.length > 0) {
    console.error(
      `\nFAIL — ${SERVER_INDEX_PATH} redeclares path lists that should only live in ${LIMITER_MOUNTS_PATH}: ${inlineRedeclarations.join(", ")}`
    );
    process.exit(1);
  }

  // Task #3860 — method-awareness guard for the write-only limiters.
  const middlewareSrc = readFile(MIDDLEWARE_PATH);
  const methodAwareErrors = assertMethodAwareLimiters(middlewareSrc, indexSrc);
  if (methodAwareErrors.length > 0) {
    console.error(`\nFAIL — write-only limiter method-awareness regressions:\n`);
    for (const e of methodAwareErrors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log(
    "Method-awareness guard: adminLimiter + sensitiveWriteLimiter skip read-only methods; trackers are mutatingOnly."
  );

  const inlinePathLiterals: { name: string; entry: string }[] = [];
  const allListedPaths: { name: string; entries: string[] }[] = [
    { name: "WEBHOOK_PATHS", entries: webhookPaths },
    { name: "UPLOAD_PATHS", entries: uploadPaths },
    { name: "ADMIN_ONLY_PATHS", entries: adminOnlyPaths },
    { name: "ADMIN_READ_PATHS", entries: adminReadPaths },
    { name: "SENSITIVE_WRITE_PATHS", entries: sensitiveWritePaths },
    { name: "AUTH_LIMITER_PATHS", entries: authLimiterPaths },
  ];
  for (const { name, entries } of allListedPaths) {
    for (const p of entries) {
      const literal = new RegExp(`["'\`]${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'\`]`);
      if (literal.test(indexSrc)) {
        inlinePathLiterals.push({ name, entry: p });
      }
    }
  }
  if (inlinePathLiterals.length > 0) {
    console.error(
      `\nFAIL — ${SERVER_INDEX_PATH} contains inline string literals for paths that are owned by ${LIMITER_MOUNTS_PATH}. ` +
        `Reference the imported array variable instead of hard-coding the path:`
    );
    for (const { name, entry } of inlinePathLiterals) {
      console.error(`  - "${entry}" (belongs to ${name})`);
    }
    process.exit(1);
  }

  const routes = parseRoutes();
  if (routes.length === 0) throw new Error("No routes discovered — route inventory parser returned empty");

  // Task #4788 — dedicated-bucket write exemption pairing (both directions).
  const dedicatedErrors = assertDedicatedBucketPairing(
    limiterMountsSrc,
    middlewareSrc,
    indexSrc,
    routes,
  );
  if (dedicatedErrors.length > 0) {
    console.error(`\nFAIL — dedicated-bucket write exemption pairing regressions:\n`);
    for (const e of dedicatedErrors) console.error(`  - ${e}`);
    process.exit(1);
  }
  const dedicatedCount = DEDICATED_BUCKET_LIST_NAMES.reduce(
    (sum, name) => sum + extractStringArray(limiterMountsSrc, name).length,
    0,
  );
  console.log(
    `Dedicated-bucket pairing guard: ${dedicatedCount} exempted write routes each carry their dedicated ` +
      `limiter; every commsWriteLimiter/sheetsAutosaveLimiter route is listed; writeLimiter skip + tracker ` +
      `mirror + computeLimitersForRoute mirror + webhook skip all wired.`,
  );

  const violations: Violation[] = [];

  for (const r of routes) {
    if (!isWebhookRoute(r)) continue;
    if (!routeIsCoveredByPrefix(r.path, webhookPaths)) {
      violations.push({
        category: "webhook",
        method: r.method,
        path: r.path,
        file: r.file,
        line: r.line,
        reason:
          `Webhook route is not covered by any WEBHOOK_PATHS prefix in ${MIDDLEWARE_PATH}. ` +
          `Add a matching prefix so webhookLimiter is applied.`,
      });
    }
  }

  for (const r of routes) {
    if (!r.hasUpload) continue;
    if (!routeIsCoveredByPrefix(r.path, uploadPaths)) {
      violations.push({
        category: "upload",
        method: r.method,
        path: r.path,
        file: r.file,
        line: r.line,
        reason:
          `Upload route (multer middleware detected) is not covered by UPLOAD_PATHS in ${LIMITER_MOUNTS_PATH}. ` +
          `Add the path to the UPLOAD_PATHS array so uploadLimiter is applied.`,
      });
    }
  }

  const adminMountPrefixes = ["/api/admin", ...adminOnlyPaths, ...adminReadPaths, ...sensitiveWritePaths];
  for (const r of routes) {
    if (!r.classifications.includes("admin_only")) continue;
    if (!routeIsCoveredByPrefix(r.path, adminMountPrefixes)) {
      violations.push({
        category: "admin_only",
        method: r.method,
        path: r.path,
        file: r.file,
        line: r.line,
        reason:
          `Admin-only route is not covered by any admin limiter mount in ${LIMITER_MOUNTS_PATH}. ` +
          `Add the path prefix to ADMIN_ONLY_PATHS (or SENSITIVE_WRITE_PATHS for stricter limits), ` +
          `or move it under the /api/admin prefix.`,
      });
    }
  }

  for (const r of routes) {
    if (!isSensitiveWriteRoute(r)) continue;
    if (!routeIsCoveredByPrefix(r.path, sensitiveWritePaths)) {
      violations.push({
        category: "sensitive_write",
        method: r.method,
        path: r.path,
        file: r.file,
        line: r.line,
        reason:
          `Sensitive-write route is not covered by SENSITIVE_WRITE_PATHS in ${LIMITER_MOUNTS_PATH}. ` +
          `Add the path to the SENSITIVE_WRITE_PATHS array so sensitiveWriteLimiter is applied.`,
      });
    }
  }

  const byCategory = new Map<string, Violation[]>();
  for (const v of violations) {
    if (!byCategory.has(v.category)) byCategory.set(v.category, []);
    byCategory.get(v.category)!.push(v);
  }

  console.log("=== Rate Limit Coverage Test ===");
  console.log(`Total routes scanned: ${routes.length}`);
  console.log(`WEBHOOK_PATHS entries: ${webhookPaths.length}`);
  console.log(`UPLOAD_PATHS entries: ${uploadPaths.length}`);
  console.log(`ADMIN_ONLY_PATHS entries: ${adminOnlyPaths.length}`);
  console.log(`ADMIN_READ_PATHS entries: ${adminReadPaths.length}`);
  console.log(`SENSITIVE_WRITE_PATHS entries: ${sensitiveWritePaths.length}`);

  const webhookCount = routes.filter(isWebhookRoute).length;
  const uploadCount = routes.filter((r) => r.hasUpload).length;
  const adminCount = routes.filter((r) => r.classifications.includes("admin_only")).length;
  const sensitiveCount = routes.filter(isSensitiveWriteRoute).length;

  console.log(
    `Routes by category — webhook: ${webhookCount}, upload: ${uploadCount}, admin_only: ${adminCount}, sensitive_write: ${sensitiveCount}`
  );

  if (violations.length === 0) {
    console.log("\nPASS — every webhook, upload, admin-only, and sensitive-write route is covered by a rate limiter mount.");
    process.exit(0);
  }

  console.error(`\nFAIL — ${violations.length} route(s) are missing rate-limit coverage:\n`);
  for (const [cat, list] of byCategory) {
    console.error(`  [${cat}] ${list.length} violation(s):`);
    for (const v of list) {
      console.error(`    - ${v.method} ${v.path}  (${v.file}:${v.line})`);
      console.error(`      ${v.reason}`);
    }
    console.error("");
  }
  process.exit(1);
}

main();
