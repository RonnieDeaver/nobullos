#!/usr/bin/env node
// Task #1574 — Generate the canonical per-endpoint contract table required
// by the Track D audit report (`audits/D-api-endpoints-findings.md`).
//
// Columns: method | path | handler (file:line) | auth required | role required
//        | request schema | response shape | frontend callers
//        | external callers | classification
//
// `request schema` and `response shape` are deliberately summarized from the
// handler source rather than reverse-engineered into full JSON schemas —
// extracting full schemas across 775 handlers would require parsing each Zod
// schema and storage call, which is far beyond what an audit report can
// reasonably present in a single table. The summaries use a small DSL:
//   - "raw"            — handler reads req.body / req.query directly
//   - "zod:<name>"     — handler runs <name>.safeParse(...) or .parse(...)
//   - "params-only"    — only URL params (typical for GET)
//   - "none"           — no request body
// Response: "json", "json-list", "csv", "text", "binary", "redirect", "none"
//
// Output: audits/D-endpoint-contract-table.md (linked from the main report).
import * as fs from "fs";
import * as path from "path";
import { authClass, roleClass, trackDClass } from "./contract-table-classifiers.mjs";

const INV = JSON.parse(fs.readFileSync("tests/route-inventory.json", "utf-8"));
const ROUTES = Array.isArray(INV) ? INV : INV.routes;

const CLIENT_DIR = "client/src";
const SCRIPTS_DIR = "scripts";
const TESTS_DIR = "tests";
const SERVER_SERVICES_DIR = "server/services";

function readAllUnder(dir, exts) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) stack.push(full);
      else if (exts.some((e) => ent.name.endsWith(e))) out.push(full);
    }
  }
  return out;
}

const clientFiles = readAllUnder(CLIENT_DIR, [".ts", ".tsx", ".js"]);
const scriptFiles = readAllUnder(SCRIPTS_DIR, [".ts", ".mjs", ".sh"]);
const testFiles = readAllUnder(TESTS_DIR, [".ts", ".tsx"]);
const serviceFiles = readAllUnder(SERVER_SERVICES_DIR, [".ts"]);

const clientCorpus = clientFiles.map((f) => ({ f, src: fs.readFileSync(f, "utf-8") }));
const externalCorpus = [...scriptFiles, ...testFiles, ...serviceFiles].map((f) => ({
  f,
  src: fs.readFileSync(f, "utf-8"),
}));

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Convert "/api/foo/:id/bar" to a regex that matches both the literal path
// and any ${...} / ` interpolation a TS caller might use in its place.
function pathToCallerRegex(routePath) {
  const parts = routePath
    .split("/")
    .filter(Boolean)
    .map((seg) => {
      if (seg.startsWith(":")) {
        // Match anything that isn't a slash or quote/backtick.
        return "(?:[^/'\"`\\s?]+|\\$\\{[^}]+\\})";
      }
      return escapeRegex(seg);
    });
  // Allow trailing ?query or " or ` or end.
  return new RegExp("/" + parts.join("/") + "(?:[?'\"`/\\s]|$)");
}

function findCallers(corpus, routePath, max = 6) {
  const re = pathToCallerRegex(routePath);
  const hits = [];
  for (const { f, src } of corpus) {
    const lines = src.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        hits.push(`${f}:${i + 1}`);
        if (hits.length >= max) return hits;
        break; // one per file is enough for the report
      }
    }
  }
  return hits;
}

// Read each handler's first ~40 lines to infer request/response shapes.
const fileCache = new Map();
function getFile(p) {
  if (!fileCache.has(p)) fileCache.set(p, fs.readFileSync(p, "utf-8").split("\n"));
  return fileCache.get(p);
}

function inferContract(route) {
  const lines = getFile(route.file);
  const window = lines.slice(route.line - 1, route.line - 1 + 60).join("\n");

  let request = "none";
  if (route.method === "GET" || route.method === "HEAD") {
    request = /req\.query/.test(window) ? "query+params" : "params-only";
  } else {
    const zod = window.match(/(\w+Schema|\w+Schema)\.(?:safeParse|parse)\(/);
    if (zod) request = `zod:${zod[1]}`;
    else if (/req\.body/.test(window)) request = "raw";
    else request = "none";
  }

  let response = "json";
  if (/res\.status\([^)]+\)\.send\(|res\.send\(/.test(window) && !/\.json\(/.test(window)) {
    response = "text";
  } else if (/res\.redirect\(/.test(window)) response = "redirect";
  else if (/res\.setHeader\(['"]Content-Type['"], ['"]text\/csv/.test(window)) response = "csv";
  else if (/res\.setHeader\(['"]Content-Type['"], ['"](?:image|video|audio|application\/octet)/.test(window))
    response = "binary";
  else if (/res\.status\(204\)/.test(window)) response = "none";
  else if (/res\.json\(\s*\[/.test(window) || /res\.json\(\s*\{[^}]*\b\w+:\s*\[/.test(window))
    response = "json-list";
  return { request, response };
}

// authClass / roleClass / trackDClass live in
// scripts/contract-table-classifiers.mjs (Task #4105) so the freshness lint
// can recompute the auth/role/classification columns from the inventory's
// middleware field and flag middleware-only drift.

const rows = ROUTES.map((r) => {
  const { request, response } = inferContract(r);
  const fe = findCallers(clientCorpus, r.path);
  const ex = findCallers(externalCorpus, r.path);
  return {
    method: r.method,
    path: r.path,
    handler: `${r.file}:${r.line}`,
    auth: authClass(r),
    role: roleClass(r),
    request,
    response,
    fe: fe.length ? fe.join(", ") : "—",
    ex: ex.length ? ex.join(", ") : "—",
    classification: trackDClass(r),
  };
});

const lines = [];
lines.push("# Canonical API Endpoint Contract Table (Task #1574 / Track D)");
lines.push("");
lines.push(`Generated: ${new Date().toISOString()}`);
lines.push(`Total routes: ${rows.length}`);
lines.push("");
// Task #4092: freshness is lint-enforced (scripts/lint-contract-table-freshness.ts)
// against tests/route-inventory.json — regenerate whenever routes change.
lines.push(
  "Freshness: enforced by `scripts/lint-contract-table-freshness.ts` (gate lint) against `tests/route-inventory.json`. If routes changed, regenerate with `node scripts/generate-endpoint-contract-table.mjs` and commit both the .md and .json.",
);
lines.push("");
lines.push(
  "Column DSL: **request** = `params-only` / `query+params` / `raw` (req.body spread) / `zod:<schema>` / `none`. **response** = `json` / `json-list` / `text` / `csv` / `binary` / `redirect` / `none`.",
);
lines.push(
  "**classification** uses the Track D taxonomy: `public | authenticated | admin | webhook | internal | debug/dev-only | deprecated`.",
);
lines.push("");

const classCounts = {};
for (const r of rows) classCounts[r.classification] = (classCounts[r.classification] || 0) + 1;
lines.push("## Counts by classification");
lines.push("");
lines.push("| classification | count |");
lines.push("|---|---|");
for (const [k, v] of Object.entries(classCounts).sort((a, b) => b[1] - a[1]))
  lines.push(`| ${k} | ${v} |`);
lines.push("");

lines.push("## Per-endpoint contract");
lines.push("");
lines.push(
  "| method | path | handler | auth | role | request | response | frontend callers | external callers | classification |",
);
lines.push(
  "|---|---|---|---|---|---|---|---|---|---|",
);
for (const r of rows) {
  const escape = (s) =>
    String(s).replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 160);
  lines.push(
    `| ${r.method} | \`${r.path}\` | ${escape(r.handler)} | ${r.auth} | ${r.role} | ${r.request} | ${r.response} | ${escape(r.fe)} | ${escape(r.ex)} | ${r.classification} |`,
  );
}

fs.mkdirSync("audits", { recursive: true });
fs.writeFileSync("audits/D-endpoint-contract-table.md", lines.join("\n"));

// Also emit a JSON sibling so future audits / CI can consume the structured form.
fs.writeFileSync("audits/D-endpoint-contract-table.json", JSON.stringify(rows, null, 2));

console.log(`Wrote audits/D-endpoint-contract-table.md with ${rows.length} rows.`);
console.log("Classification breakdown:", classCounts);
