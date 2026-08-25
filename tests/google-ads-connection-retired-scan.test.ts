/* test-registration
{
  "name": "google_ads_connection retirement source scan — no code reference to the dropped table or its OAuth machinery (Task #4008)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4008 dropped the google_ads_connection table; any code path that still names it (drizzle identifier, raw SQL, breaker/forensics import) would 42P01-crash at runtime the moment it executes — silently reintroduced by a merge or a copy-paste from an old branch. Scans server/, shared/, client/src/, and scripts/ with comment masking (historical context in comments is allowed) and fails on ANY code-level occurrence of the retired identifiers. Also pins that the drop migration + post-merge SAFE_MIGRATIONS entry stay in place. Pure filesystem scan — fast, no DB.",
  "scanPaths": [
    "client/src",
    "migrations/20260807152551_drop_google_ads_connection.sql",
    "scripts/post-merge.sh",
    "shared/models/googleAds.ts"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #4008 — the platform-managed Google Ads connection is retired:
 * `google_ads_connection` is dropped by
 * migrations/20260807152551_drop_google_ads_connection.sql and every
 * surface mints via the env trio (see
 * tests/google-ads-env-mint-platform-surfaces.test.ts).
 *
 * Banned identifiers (code only — comments are masked before matching,
 * so the historical notes in googleAdsIntegration.ts / config.ts etc.
 * stay legal):
 *   - google_ads_connection            (table name / raw SQL)
 *   - googleAdsConnection[s]           (drizzle table + type identifiers)
 *   - GOOGLE_ADS_CONNECTION_SINGLETON_ID (storage singleton key)
 *   - googleAdsAuthBreaker             (retired breaker module)
 *   - classifyGoogleAdsTerminalRefreshError (retired forensics classifier)
 *   - google_ads_oauth_nonce           (retired OAuth-nonce settings prefix)
 *
 * Scan roots: server/, shared/, client/src/, scripts/ (.ts/.tsx). tests/
 * are deliberately excluded — retirement pins there reference the names on
 * purpose. Migration SQL + post-merge.sh legitimately name the table (the
 * DROP itself) and are asserted separately, not scanned.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { maskComments } from "../scripts/lint-work-queue-producer-handlers";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

const ROOT = process.cwd();
const SCAN_ROOTS = ["server", "shared", "client/src", "scripts"];

const SCAN_EXEMPT = new Set(["scripts/lint-migration-immutability.ts"]); // fs-scan-inputs-ignore -- exemption key only: the walk skips this path before any read; its content is never a scan input
const BANNED = [
  "google_ads_connection",
  "googleAdsConnection", // also matches the plural drizzle export
  "GOOGLE_ADS_CONNECTION_SINGLETON_ID",
  "googleAdsAuthBreaker",
  "classifyGoogleAdsTerminalRefreshError",
  "google_ads_oauth_nonce",
] as const;

async function* walk(dir: string): AsyncGenerator<string> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      yield* walk(full);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      yield full;
    }
  }
}

async function main(): Promise<void> {
  console.log("google_ads_connection retirement source scan (Task #4008)");

  // ── 1. No code-level reference to the retired identifiers ──
  const violations: string[] = [];
  let scanned = 0;
  for (const rootDir of SCAN_ROOTS) {
    for await (const file of walk(path.join(ROOT, rootDir))) {
      const rel = path.relative(ROOT, file).split(path.sep).join("/");
      // This test's own scan logic lives under tests/, but guard anyway in
      // case the roots ever change.
      if (rel.startsWith("tests/")) continue;
      if (SCAN_EXEMPT.has(rel)) continue;
      const raw = await fs.readFile(file, "utf8");
      // Cheap prefilter before the masking pass.
      if (!BANNED.some((b) => raw.includes(b))) { scanned++; continue; }
      let masked = maskComments(raw);
      // The drop migration's own FILENAME contains the table name and is
      // legitimately recorded as a code-level string by the frozen sha-256
      // migration ledger in scripts/lint-migration-immutability.ts
      // (Task #4179 — the ledger names every migrations/*.sql file by exact
      // name). Same class as post-merge.sh's SAFE_MIGRATIONS entry, which is
      // asserted separately below and not scanned here. Mask the exact
      // filename so only genuine identifier reintroductions fail.
      masked = masked
        .split("20260807152551_drop_google_ads_connection.sql")
        .join("<drop-google-ads-migration-filename>");
      for (const banned of BANNED) {
        let idx = masked.indexOf(banned);
        while (idx !== -1) {
          const line = masked.slice(0, idx).split("\n").length;
          violations.push(`${rel}:${line} — code-level "${banned}"`);
          idx = masked.indexOf(banned, idx + banned.length);
        }
      }
      scanned++;
    }
  }
  assert(scanned > 500, `sanity: scan actually walked the tree (saw ${scanned} files)`);
  assert(
    violations.length === 0,
    `retired google_ads_connection identifiers must not reappear in code:\n  ${violations.join("\n  ")}`,
  );
  console.log(`  ✓ ${scanned} files scanned — zero code references to the retired identifiers`);

  // ── 2. The schema no longer exports the connection table ──
  const schemaSrc = maskComments(
    await fs.readFile(path.join(ROOT, "shared/models/googleAds.ts"), "utf8"),
  );
  assert(
    !/connection/i.test(schemaSrc),
    "shared/models/googleAds.ts must not define any connection table/type in code",
  );
  console.log("  ✓ shared/models/googleAds.ts defines no connection table");

  // ── 3. Drop migration + SAFE_MIGRATIONS entry stay in place ──
  const migration = await fs.readFile(
    path.join(ROOT, "migrations/20260807152551_drop_google_ads_connection.sql"),
    "utf8",
  );
  assert(
    /DROP TABLE IF EXISTS google_ads_connection;/.test(migration),
    "drop migration must contain `DROP TABLE IF EXISTS google_ads_connection;`",
  );
  assert(
    !/google_ads_customers|google_ads_campaign|google_ads_keyword/.test(
      migration.replace(/^--.*$/gm, ""),
    ),
    "drop migration must touch ONLY the connection table (customers/campaign/keyword data preserved)",
  );
  const postMerge = await fs.readFile(path.join(ROOT, "scripts/post-merge.sh"), "utf8");
  assert(
    postMerge.includes("migrations/20260807152551_drop_google_ads_connection.sql"),
    "post-merge.sh SAFE_MIGRATIONS must list the drop migration so task envs converge",
  );
  console.log("  ✓ drop migration is connection-only and listed in post-merge SAFE_MIGRATIONS");

  console.log("\ngoogle-ads-connection-retired-scan: all checks passed");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
