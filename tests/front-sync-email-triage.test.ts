/* test-registration
{
  "name": "Front sync_email ingestion triage helper (Task #1271)",
  "regression": true,
  "sweepOnlyReason": "Task #4096 triage of the migrated no-reason boilerplate: too slow for the routine gate (~8.4s in the 2026-08-07 nightly sweep); still runs in the full suite and the nightly --regression sweep.",
  "scanPaths": [
    "scripts/lint-front-sync-email-triage.ts",
    "server/services/frontIntegration.ts"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #1271 — verifies that Front sync_email ingestion routes every row
 * through the canonical `triageSyncEmailForMatching` helper so brand-new
 * email gets filter-rule treatment on first ingest (not only on
 * re-evaluation).
 *
 * Two layers of coverage:
 *
 *   1. Behavioural: `triageSyncEmailForMatching` short-circuits on a
 *      `block` filter rule and stamps `front_sync_emails.matchStatus =
 *      "blocked"` without running the operational classifier.
 *
 *   2. Structural / static guard: every function in
 *      `server/services/frontIntegration.ts` that lists sync_emails also
 *      calls `triageSyncEmailForMatching`. A new ingestion loop that
 *      forgets the helper is caught by `scripts/lint-front-sync-email-triage.ts`
 *      and fails the test (and the pre-deploy gate).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { frontFilterRules, frontSyncEmails } from "@shared/schema";
import { getDb } from "../server/db";
import { runInTxSandbox } from "./db-sandbox";
import {
  invalidateFilterRulesCache,
  normalizeRuleValue,
} from "../server/services/frontFilterRules";
import { triageSyncEmailForMatching } from "../server/services/frontSyncEmailTriage";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}
function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    throw new Error(`Assertion failed: ${msg} — expected ${String(expected)}, got ${String(actual)}`);
  }
}

const TAG = `triage-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function run(): Promise<void> {
  // --- Layer 1: behavioural — block rule applies to a brand-new sync_email ---
  await runInTxSandbox(async () => {
    const senderEmail = `spam-${TAG}@example.invalid`;

    // The triage helper writes `dismissedBy = "system"` for filter-rule
    // mutations; that column FKs to users(id) so we need a "system" user
    // row to exist inside the sandbox tx.
    await getDb().execute(sql`
      INSERT INTO users (id, email, first_name, last_name)
      VALUES ('system', 'system@test.local', 'System', 'User')
      ON CONFLICT (id) DO NOTHING
    `);

    // Seed a `block` rule scoped to the sender.
    await getDb().insert(frontFilterRules).values({
      type: "block",
      scope: "sender_email",
      value: normalizeRuleValue("sender_email", senderEmail),
      enabled: true,
      createdBy: null,
    });
    invalidateFilterRulesCache();

    // Insert a brand-new sync_email row as if it had just been ingested.
    const conversationId = `conv-${TAG}`;
    const [row] = await getDb()
      .insert(frontSyncEmails)
      .values({
        conversationId,
        subject: "Cheap meds!",
        snippet: "spam body",
        participantsJson: [
          { email: senderEmail, role: "external" },
          { email: "team@firm.invalid", role: "recipient" },
        ],
        matchStatus: "unmatched",
      })
      .returning();

    const outcome = await triageSyncEmailForMatching({
      id: row.id,
      subject: row.subject,
      snippet: row.snippet,
      participantsJson: row.participantsJson,
      conversationId: row.conversationId,
    });

    assertEq(outcome.outcome, "filter_rule_handled", "block rule should short-circuit triage");
    if (outcome.outcome === "filter_rule_handled") {
      assertEq(outcome.ruleType, "block", "outcome.ruleType");
    }

    const refreshed = await getDb()
      .select()
      .from(frontSyncEmails)
      .where(sql`id = ${row.id}`);
    assertEq(refreshed[0]?.matchStatus, "blocked", "matchStatus mutated to blocked");
    assert(refreshed[0]?.matchReason?.startsWith("Filter rule "), "matchReason stamped");
    assert(refreshed[0]?.processedAt != null, "processedAt stamped");

    console.log("[triage] behavioural check passed");
  });

  // --- Layer 2: structural — the lint guard passes on clean repo ---
  {
    const result = spawnSync("npx", ["tsx", "scripts/lint-front-sync-email-triage.ts"], {
      encoding: "utf8",
    });
    assertEq(result.status, 0, `lint-front-sync-email-triage clean repo: ${result.stdout}\n${result.stderr}`);
    console.log("[triage] static-guard clean-repo check passed");
  }

  // --- Layer 2b: structural — the lint guard fails when a new ingestion ---
  //                 site is added that forgets the helper. We test two
  //                 offender shapes because the original (regex-based)
  //                 parser failed silently on functions with typed object
  //                 parameters, where `indexOf("{")` would grab the brace
  //                 of the type annotation instead of the function body.
  // Task #1698: simulate offenders against a TEMP COPY of the ingestion
  // file. The lint script accepts `LINT_FRONT_TRIAGE_TARGET=<path>` (see
  // scripts/lint-front-sync-email-triage.ts) which points its AST scan
  // at the alternate file. This means the real production source is
  // NEVER mutated by these tests — even a SIGKILL'd test child cannot
  // strand an offender block in `server/services/frontIntegration.ts`.
  //
  // The offender functions are named `__triageOffenderFixture*` (not
  // `__lintTestOffender*`) because the lint script intentionally
  // ignores the latter prefix as a defense-in-depth measure for any
  // legacy stranded fixture in the real file.
  const offenderCases = [
    {
      label: "plain-param offender",
      block:
        "\n\n// __test_only_offender_block__\n" +
        "export async function __triageOffenderFixturePlain__(): Promise<void> {\n" +
        "  const emails = await storage.listFrontSyncEmails({ limit: 1 });\n" +
        "  for (const e of emails) {\n" +
        "    await storage.updateFrontSyncEmail(e.id, { matchStatus: 'unmatched' });\n" +
        "  }\n" +
        "}\n",
      name: "__triageOffenderFixturePlain__",
    },
    {
      label: "typed-param offender",
      // The typed object parameter is the regression case: a naive
      // `indexOf("{")` brace walker would mistake the `{ limit: number }`
      // type annotation for the function body and never see the
      // storage.listFrontSyncEmails call below.
      block:
        "\n\n// __test_only_offender_block_typed__\n" +
        "export async function __triageOffenderFixtureTyped__(opts: { limit: number; cursor?: { id: string } }): Promise<void> {\n" +
        "  const emails = await storage.listFrontSyncEmails({ limit: opts.limit });\n" +
        "  for (const e of emails) {\n" +
        "    await storage.updateFrontSyncEmail(e.id, { matchStatus: 'unmatched' });\n" +
        "  }\n" +
        "}\n",
      name: "__triageOffenderFixtureTyped__",
    },
  ];

  const ingestionPath = "server/services/frontIntegration.ts";
  const pristine = readFileSync(ingestionPath, "utf8");
  const tmpDir = mkdtempSync(join(tmpdir(), "triage-lint-"));
  try {
    for (const c of offenderCases) {
      const tmpFile = join(tmpDir, "frontIntegration.ts");
      writeFileSync(tmpFile, pristine + c.block, "utf8");
      const result = spawnSync("npx", ["tsx", "scripts/lint-front-sync-email-triage.ts"], {
        encoding: "utf8",
        env: { ...process.env, LINT_FRONT_TRIAGE_TARGET: tmpFile },
      });
      assertEq(
        result.status,
        1,
        `expected lint to fail on ${c.label}; stdout=${result.stdout} stderr=${result.stderr}`,
      );
      assert(
        result.stderr.includes(c.name) || result.stdout.includes(c.name),
        `lint output should name the offending function (${c.label})`,
      );
      console.log(`[triage] static-guard ${c.label} check passed`);
    }
  } finally {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }

  console.log("✓ front-sync-email-triage (Task #1271) all checks passed");
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
run().then(
  () => {},
  (err) => {
    console.error(err);
    process.exitCode = 1;
  },
);
