/* test-registration
{
  "name": "Ris auto pull safety (baseline triage, Task #3424)",
  "extraNodeArgs": [
    "--import",
    "./tests/helpers/risBigQuerySetup.mjs"
  ],
  "tier": "medium"
}
test-registration */
/**
 * RIS BigQuery auto-pull safety regression test (Task #2384, covering the
 * Task #2368 guarantees).
 *
 * The auto-pull has two core safety guarantees that are otherwise only
 * checked by typecheck + manual reasoning — exactly the kind of invariant a
 * future change could quietly break:
 *
 *   (A) The auto WRITER never overwrites a human-owned row. `setRisAutoResult`
 *       must SKIP a row whose `source = 'manual'` or that has been confirmed
 *       (`confirmed_at` set), leaving it byte-for-byte untouched. It still
 *       refreshes an ordinary (unconfirmed) auto row.
 *
 *   (B) The auto-pull NEVER silently passes. Any check whose BigQuery value
 *       can't be trusted — mapping unconfigured/disabled, BigQuery
 *       unreachable, the query throws, no row comes back, or no comparator
 *       rule is configured — must degrade to status `needs_review` with a
 *       plain-English `auto_error`, never `pass`. A configured mapping with a
 *       comparator must produce the expected suggested status.
 *
 * Section A drives `setRisAutoResult` directly. Section B drives the full
 * `runRisAutoPull` against a stubbed `bigQueryClient` (the resolve hook in
 * `risBigQuerySetup.mjs` redirects `runAutoSourceQuery` to a test impl) so we
 * can deterministically exercise every degrade path without real BigQuery.
 *
 * Both sections run inside `runInIsolatedSchema(...)` (clones `ris_checks`,
 * `ris_check_results`, `ris_auto_source_mappings`, `clients`) so the test's
 * rows live in a per-test schema the live `Start application` workers (whose
 * default `search_path` is `public`) cannot see, claim, or race-write.
 */

import assert from "node:assert/strict";

import { runInIsolatedSchema } from "./db-sandbox";
import {
  setRisAutoResult,
  listRisAutoSourceMappings,
} from "../server/storage/risStorage";
import { runRisAutoPull } from "../server/services/ris/risAutoPull";
import { BigQueryUnavailableError } from "../server/services/ris/bigQueryClient";
import {
  __setRunAutoSourceQuery,
  __resetRunAutoSourceQuery,
} from "./helpers/risBigQueryStub.mjs";
import {
  clients,
  risChecks,
  risCheckResults,
  risAutoSourceMappings,
  risClientAutoSourceOverrides,
} from "@shared/schema";
import { and, eq, isNull } from "drizzle-orm";

const RIS_TABLES = [
  "clients",
  "ris_checks",
  "ris_check_results",
  "ris_auto_source_mappings",
  "ris_client_auto_source_overrides",
] as const;

const PERIOD = "2099-01";

// ──────────────────────────────────────────────────────────────────────
// Section A — the writer never clobbers a human-owned row.
// ──────────────────────────────────────────────────────────────────────
async function runWriterGuards(): Promise<void> {
  await runInIsolatedSchema(
    async ({ db }) => {
      // Seed three pre-existing rows at distinct logical scopes. FK
      // constraints are dropped by the LIKE clone, so arbitrary ids are fine.
      const [manualRow] = await db
        .insert(risCheckResults)
        .values({
          checkId: "chk-manual",
          clientId: "cli-1",
          locationId: null,
          period: PERIOD,
          status: "pass",
          observedValue: "human value",
          notes: "set by a human",
          source: "manual",
        })
        .returning();

      const confirmedAt = new Date("2099-01-15T00:00:00Z");
      const [confirmedRow] = await db
        .insert(risCheckResults)
        .values({
          checkId: "chk-confirmed",
          clientId: "cli-1",
          locationId: null,
          period: PERIOD,
          status: "pass",
          observedValue: "confirmed value",
          source: "auto",
          confirmedAt,
          confirmedBy: "user-7",
        })
        .returning();

      const [autoRow] = await db
        .insert(risCheckResults)
        .values({
          checkId: "chk-auto",
          clientId: "cli-1",
          locationId: null,
          period: PERIOD,
          status: "needs_review",
          observedValue: "stale auto value",
          source: "auto",
        })
        .returning();

      // (A1) A manual row is skipped and left untouched.
      const manualOutcome = await setRisAutoResult({
        checkId: "chk-manual",
        clientId: "cli-1",
        locationId: null,
        period: PERIOD,
        status: "fail",
        observedValue: "auto would-be value",
        autoError: null,
      });
      assert.equal(manualOutcome.kind, "skipped", "manual row must be skipped");
      assert.equal(
        manualOutcome.kind === "skipped" && manualOutcome.reason,
        "manual",
        "skip reason must be 'manual'",
      );
      const [manualAfter] = await db
        .select()
        .from(risCheckResults)
        .where(eq(risCheckResults.id, manualRow.id));
      assert.equal(manualAfter.status, "pass", "manual status must be unchanged");
      assert.equal(
        manualAfter.observedValue,
        "human value",
        "manual observedValue must be unchanged",
      );
      assert.equal(manualAfter.source, "manual", "manual source must be unchanged");

      // (A2) A confirmed auto row is skipped and left untouched.
      const confirmedOutcome = await setRisAutoResult({
        checkId: "chk-confirmed",
        clientId: "cli-1",
        locationId: null,
        period: PERIOD,
        status: "fail",
        observedValue: "auto would-be value",
        autoError: null,
      });
      assert.equal(
        confirmedOutcome.kind,
        "skipped",
        "confirmed row must be skipped",
      );
      assert.equal(
        confirmedOutcome.kind === "skipped" && confirmedOutcome.reason,
        "confirmed",
        "skip reason must be 'confirmed'",
      );
      const [confirmedAfter] = await db
        .select()
        .from(risCheckResults)
        .where(eq(risCheckResults.id, confirmedRow.id));
      assert.equal(
        confirmedAfter.status,
        "pass",
        "confirmed status must be unchanged",
      );
      assert.equal(
        confirmedAfter.observedValue,
        "confirmed value",
        "confirmed observedValue must be unchanged",
      );
      assert.equal(
        confirmedAfter.confirmedAt?.getTime(),
        confirmedAt.getTime(),
        "confirmedAt must be unchanged",
      );

      // (A3) Control: an ordinary unconfirmed auto row IS refreshed, proving
      // the skip is specific to human-owned rows (not a blanket no-op).
      const autoOutcome = await setRisAutoResult({
        checkId: "chk-auto",
        clientId: "cli-1",
        locationId: null,
        period: PERIOD,
        status: "fail",
        observedValue: "fresh auto value",
        autoError: null,
      });
      assert.equal(
        autoOutcome.kind,
        "written",
        "ordinary auto row must be (over)written",
      );
      const [autoAfter] = await db
        .select()
        .from(risCheckResults)
        .where(eq(risCheckResults.id, autoRow.id));
      assert.equal(autoAfter.status, "fail", "auto row status must refresh");
      assert.equal(
        autoAfter.observedValue,
        "fresh auto value",
        "auto row observedValue must refresh",
      );
    },
    { tables: RIS_TABLES },
  );

  console.log("ris-auto-pull-safety: writer guards passed");
}

// ──────────────────────────────────────────────────────────────────────
// Section B — runRisAutoPull degrade-to-needs_review + suggestion logic.
// ──────────────────────────────────────────────────────────────────────
//
// We seed one universal, non-location check per scenario so the auto-pull
// produces exactly one result row per scenario, then dispatch the stubbed
// `runAutoSourceQuery` on `mapping.autoSource`.
interface ScenarioCheck {
  key: string;
  autoSource: string;
  enabled: boolean;
  sqlTemplate: string;
  comparator: string;
  threshold: string | null;
}

const SCENARIOS: ScenarioCheck[] = [
  // Unconfigured mapping (disabled) — no BigQuery call at all.
  { key: "chk_disabled", autoSource: "as_disabled", enabled: false, sqlTemplate: "", comparator: "gte", threshold: "1" },
  // Enabled but BigQuery is unreachable / credentials missing.
  { key: "chk_unavailable", autoSource: "as_unavailable", enabled: true, sqlTemplate: "SELECT 1 AS value", comparator: "gte", threshold: "1" },
  // Enabled but the query throws.
  { key: "chk_threw", autoSource: "as_threw", enabled: true, sqlTemplate: "SELECT 1 AS value", comparator: "gte", threshold: "1" },
  // Enabled but no row comes back.
  { key: "chk_norow", autoSource: "as_norow", enabled: true, sqlTemplate: "SELECT 1 AS value", comparator: "gte", threshold: "1" },
  // Enabled, value present, but no comparator rule (none) — record but review.
  { key: "chk_nocomparator", autoSource: "as_nocomparator", enabled: true, sqlTemplate: "SELECT 7 AS value", comparator: "none", threshold: null },
  // Enabled, value passes the comparator -> pass.
  { key: "chk_pass", autoSource: "as_pass", enabled: true, sqlTemplate: "SELECT 5 AS value", comparator: "gte", threshold: "3" },
  // Enabled, value fails the comparator -> fail.
  { key: "chk_fail", autoSource: "as_fail", enabled: true, sqlTemplate: "SELECT 1 AS value", comparator: "gte", threshold: "3" },
];

async function runAutoPullDegradeAndSuggest(): Promise<void> {
  await runInIsolatedSchema(
    async ({ db }) => {
      // One active client; universal checks apply regardless of products.
      const [client] = await db
        .insert(clients)
        .values({ firmName: "Test Firm", products: ["gbp"], isArchived: false, isDemo: false })
        .returning();

      const checkIdByKey = new Map<string, string>();
      for (let i = 0; i < SCENARIOS.length; i++) {
        const s = SCENARIOS[i];
        const [row] = await db
          .insert(risChecks)
          .values({
            key: s.key,
            label: s.key,
            product: "universal",
            category: "tracking",
            frequency: "monthly",
            locationSpecific: false,
            autoSource: s.autoSource,
            active: true,
            sortOrder: (i + 1) * 10,
          })
          .returning();
        checkIdByKey.set(s.key, row.id);

        await db.insert(risAutoSourceMappings).values({
          autoSource: s.autoSource,
          label: s.autoSource,
          enabled: s.enabled,
          sqlTemplate: s.sqlTemplate,
          valueColumn: "value",
          comparator: s.comparator,
          threshold: s.threshold,
        });
      }

      // Dispatch the stub on the mapping's autoSource so a single
      // runRisAutoPull processes every scenario deterministically.
      __setRunAutoSourceQuery(async (mapping: any) => {
        switch (mapping.autoSource) {
          case "as_unavailable":
            throw new BigQueryUnavailableError("credentials are not configured");
          case "as_threw":
            throw new Error("simulated BigQuery failure");
          case "as_norow":
            return { row: null };
          case "as_nocomparator":
            return { row: { value: 7 } };
          case "as_pass":
            return { row: { value: 5 } };
          case "as_fail":
            return { row: { value: 1 } };
          default:
            throw new Error(`unexpected autoSource ${mapping.autoSource}`);
        }
      });

      // Sanity: the mappings are visible through the same getDb() handle.
      const mappings = await listRisAutoSourceMappings();
      assert.equal(
        mappings.length,
        SCENARIOS.length,
        "seeded mappings must be readable in the isolated schema",
      );

      const summary = await runRisAutoPull({ clientId: client.id, period: PERIOD });
      assert.equal(
        summary.checksConsidered,
        SCENARIOS.length,
        "every seeded auto check must be considered",
      );
      assert.equal(summary.written, SCENARIOS.length, "every check must write a result");

      // Read back the single result row for each scenario check.
      async function resultFor(key: string) {
        const checkId = checkIdByKey.get(key)!;
        const [row] = await db
          .select()
          .from(risCheckResults)
          .where(
            and(
              eq(risCheckResults.checkId, checkId),
              eq(risCheckResults.clientId, client.id),
              isNull(risCheckResults.locationId),
              eq(risCheckResults.period, PERIOD),
            ),
          );
        assert.ok(row, `expected a result row for ${key}`);
        return row;
      }

      // (B1) Unconfigured mapping (disabled) -> needs_review, no silent pass.
      const disabled = await resultFor("chk_disabled");
      assert.equal(disabled.status, "needs_review", "disabled mapping must be needs_review");
      assert.ok(disabled.autoError, "disabled mapping must carry an autoError");
      assert.equal(disabled.source, "auto");

      // (B2) BigQuery unreachable -> needs_review.
      const unavailable = await resultFor("chk_unavailable");
      assert.equal(unavailable.status, "needs_review", "unavailable BigQuery must be needs_review");
      assert.match(unavailable.autoError ?? "", /unavailable/i);

      // (B3) Query threw -> needs_review.
      const threw = await resultFor("chk_threw");
      assert.equal(threw.status, "needs_review", "thrown query must be needs_review");
      assert.match(threw.autoError ?? "", /failed/i);

      // (B4) No row returned -> needs_review.
      const norow = await resultFor("chk_norow");
      assert.equal(norow.status, "needs_review", "no-row query must be needs_review");
      assert.match(norow.autoError ?? "", /no data/i);

      // (B5) Value present but no comparator rule -> needs_review (recorded,
      // not silently passed).
      const nocomparator = await resultFor("chk_nocomparator");
      assert.equal(nocomparator.status, "needs_review", "no-comparator must be needs_review");
      assert.ok(nocomparator.autoError, "no-comparator must carry an autoError");
      assert.match(nocomparator.observedValue ?? "", /7/);

      // (B6) Configured comparator that passes -> pass with the observed value.
      const pass = await resultFor("chk_pass");
      assert.equal(pass.status, "pass", "value over threshold must suggest pass");
      assert.equal(pass.autoError, null, "a clean pass has no autoError");
      assert.match(pass.observedValue ?? "", /5/);

      // (B7) Configured comparator that fails -> fail.
      const fail = await resultFor("chk_fail");
      assert.equal(fail.status, "fail", "value under threshold must suggest fail");
      assert.match(fail.observedValue ?? "", /1/);

      // Core invariant: NONE of the degrade paths silently produced a pass.
      for (const key of ["chk_disabled", "chk_unavailable", "chk_threw", "chk_norow", "chk_nocomparator"]) {
        const row = await resultFor(key);
        assert.notEqual(row.status, "pass", `${key} must never silently pass`);
      }
    },
    { tables: RIS_TABLES },
  );

  console.log("ris-auto-pull-safety: degrade + suggestion cases passed");
}

// ──────────────────────────────────────────────────────────────────────
// Section C — Task #2485: per-client override resolution + binding key.
//   (C1) a per-client override beats the global mapping field-by-field
//        (null override fields still inherit the global value), and the
//        per-client BigQuery client key + override filter value reach the
//        query as @clientKey / @filterValue.
//   (C2) a resolved template that needs @clientKey but whose client has no
//        key degrades to needs_review — never a silent pass.
// ──────────────────────────────────────────────────────────────────────
async function runOverrideResolution(): Promise<void> {
  await runInIsolatedSchema(
    async ({ db }) => {
      // Two clients: one WITH a BigQuery client key, one WITHOUT.
      const [keyedClient] = await db
        .insert(clients)
        .values({
          firmName: "Keyed Firm",
          products: ["gbp"],
          isArchived: false,
          isDemo: false,
          bigQueryClientKey: "bq-key-123",
        })
        .returning();
      const [keylessClient] = await db
        .insert(clients)
        .values({
          firmName: "Keyless Firm",
          products: ["gbp"],
          isArchived: false,
          isDemo: false,
        })
        .returning();

      // One universal check + a global mapping that would FAIL on its own
      // (threshold 100, value 5). The override flips comparator/threshold so
      // the same value PASSES, proving per-field override wins.
      const [check] = await db
        .insert(risChecks)
        .values({
          key: "chk_override",
          label: "chk_override",
          product: "universal",
          category: "tracking",
          frequency: "monthly",
          locationSpecific: false,
          autoSource: "as_override",
          active: true,
          sortOrder: 10,
        })
        .returning();
      await db.insert(risAutoSourceMappings).values({
        autoSource: "as_override",
        label: "as_override",
        enabled: true,
        // Global template references @clientKey, so a keyless client degrades.
        sqlTemplate: "SELECT 5 AS value WHERE client = @clientKey",
        valueColumn: "value",
        comparator: "gte",
        threshold: "100",
      });
      // Per-client override for the keyed client: relax the rule so 5 passes,
      // and supply a filter value. Other fields (sqlTemplate, valueColumn)
      // are null => inherit the global mapping.
      await db.insert(risClientAutoSourceOverrides).values({
        clientId: keyedClient.id,
        autoSource: "as_override",
        comparator: "gte",
        threshold: "3",
        filterValue: "region-west",
      });

      // The stub asserts the binding params reach the query, and returns the
      // value the template "would" produce.
      let sawClientKey: string | null | undefined;
      let sawFilterValue: string | null | undefined;
      __setRunAutoSourceQuery(async (_rule: any, params: any) => {
        sawClientKey = params.clientKey;
        sawFilterValue = params.filterValue;
        return { row: { value: 5 } };
      });

      async function resultFor(clientId: string) {
        const [row] = await db
          .select()
          .from(risCheckResults)
          .where(
            and(
              eq(risCheckResults.checkId, check.id),
              eq(risCheckResults.clientId, clientId),
              isNull(risCheckResults.locationId),
              eq(risCheckResults.period, PERIOD),
            ),
          );
        return row;
      }

      // (C1) Keyed client: override applied + binding params threaded.
      await runRisAutoPull({ clientId: keyedClient.id, period: PERIOD });
      const keyed = await resultFor(keyedClient.id);
      assert.ok(keyed, "keyed client must have a result row");
      assert.equal(
        keyed.status,
        "pass",
        "override threshold (3) must make value 5 pass, not the global 100",
      );
      assert.equal(
        sawClientKey,
        "bq-key-123",
        "the client's BigQuery key must reach the query as @clientKey",
      );
      assert.equal(
        sawFilterValue,
        "region-west",
        "the override filter value must reach the query as @filterValue",
      );

      // (C2) Keyless client: template needs @clientKey but none set -> degrade.
      await runRisAutoPull({ clientId: keylessClient.id, period: PERIOD });
      const keyless = await resultFor(keylessClient.id);
      assert.ok(keyless, "keyless client must have a result row");
      assert.equal(
        keyless.status,
        "needs_review",
        "a key-requiring template with no client key must degrade, never pass",
      );
      assert.match(
        keyless.autoError ?? "",
        /client key/i,
        "the degrade reason must mention the missing client key",
      );
      assert.notEqual(keyless.status, "pass", "must never silently pass");
    },
    { tables: RIS_TABLES },
  );

  console.log("ris-auto-pull-safety: override resolution + binding-key cases passed");
}

// ──────────────────────────────────────────────────────────────────────
// Section D — Task #2485: the #2368 human-owned guard still holds when a
// per-client override is present. An override changes WHICH rule/value the
// pull resolves, but it must NEVER cause a manual or confirmed row to be
// overwritten. A control plain auto row proves the pull still runs.
// ──────────────────────────────────────────────────────────────────────
async function runOverridePresentHumanGuard(): Promise<void> {
  await runInIsolatedSchema(
    async ({ db }) => {
      const [client] = await db
        .insert(clients)
        .values({
          firmName: "Override Guard Firm",
          products: ["gbp"],
          isArchived: false,
          isDemo: false,
        })
        .returning();

      // Three universal checks, each with a global mapping AND a per-client
      // override (threshold relaxed so the resolved rule would PASS value 5).
      const specs = [
        { key: "chk_ovr_manual", autoSource: "as_ovr_manual" },
        { key: "chk_ovr_confirmed", autoSource: "as_ovr_confirmed" },
        { key: "chk_ovr_auto", autoSource: "as_ovr_auto" },
      ];
      const checkIdByKey = new Map<string, string>();
      for (let i = 0; i < specs.length; i++) {
        const s = specs[i];
        const [row] = await db
          .insert(risChecks)
          .values({
            key: s.key,
            label: s.key,
            product: "universal",
            category: "tracking",
            frequency: "monthly",
            locationSpecific: false,
            autoSource: s.autoSource,
            active: true,
            sortOrder: (i + 1) * 10,
          })
          .returning();
        checkIdByKey.set(s.key, row.id);
        await db.insert(risAutoSourceMappings).values({
          autoSource: s.autoSource,
          label: s.autoSource,
          enabled: true,
          // No @clientKey reference, so the pull would write absent any guard.
          sqlTemplate: "SELECT 5 AS value",
          valueColumn: "value",
          comparator: "gte",
          threshold: "100",
        });
        await db.insert(risClientAutoSourceOverrides).values({
          clientId: client.id,
          autoSource: s.autoSource,
          comparator: "gte",
          threshold: "3",
        });
      }

      // Pre-existing human-owned rows: one manual, one confirmed auto.
      const confirmedAt = new Date("2099-01-15T00:00:00Z");
      const [manualRow] = await db
        .insert(risCheckResults)
        .values({
          checkId: checkIdByKey.get("chk_ovr_manual")!,
          clientId: client.id,
          locationId: null,
          period: PERIOD,
          status: "fail",
          observedValue: "human manual value",
          source: "manual",
        })
        .returning();
      const [confirmedRow] = await db
        .insert(risCheckResults)
        .values({
          checkId: checkIdByKey.get("chk_ovr_confirmed")!,
          clientId: client.id,
          locationId: null,
          period: PERIOD,
          status: "fail",
          observedValue: "human confirmed value",
          source: "auto",
          confirmedAt,
          confirmedBy: "user-9",
        })
        .returning();

      __setRunAutoSourceQuery(async () => ({ row: { value: 5 } }));

      await runRisAutoPull({ clientId: client.id, period: PERIOD });

      async function resultById(id: string) {
        const [row] = await db
          .select()
          .from(risCheckResults)
          .where(eq(risCheckResults.id, id));
        return row;
      }

      // (D1) Manual row untouched despite the override being present.
      const manualAfter = await resultById(manualRow.id);
      assert.equal(manualAfter.status, "fail", "manual status must be unchanged with an override present");
      assert.equal(
        manualAfter.observedValue,
        "human manual value",
        "manual observedValue must be unchanged with an override present",
      );
      assert.equal(manualAfter.source, "manual", "manual source must stay manual");

      // (D2) Confirmed auto row untouched despite the override being present.
      const confirmedAfter = await resultById(confirmedRow.id);
      assert.equal(confirmedAfter.status, "fail", "confirmed status must be unchanged with an override present");
      assert.equal(
        confirmedAfter.observedValue,
        "human confirmed value",
        "confirmed observedValue must be unchanged with an override present",
      );
      assert.equal(
        confirmedAfter.confirmedAt?.getTime(),
        confirmedAt.getTime(),
        "confirmedAt must be unchanged with an override present",
      );

      // (D3) Control: a plain (no pre-existing row) check with an override
      // DOES get written and reflects the override threshold (5 >= 3 => pass),
      // proving the pull actually ran and the human-guard is row-specific.
      const [autoAfter] = await db
        .select()
        .from(risCheckResults)
        .where(
          and(
            eq(risCheckResults.checkId, checkIdByKey.get("chk_ovr_auto")!),
            eq(risCheckResults.clientId, client.id),
            isNull(risCheckResults.locationId),
            eq(risCheckResults.period, PERIOD),
          ),
        );
      assert.ok(autoAfter, "control auto check must produce a result row");
      assert.equal(
        autoAfter.status,
        "pass",
        "control auto row must reflect the override threshold (pass), proving the pull ran",
      );
    },
    { tables: RIS_TABLES },
  );

  console.log("ris-auto-pull-safety: override-present human-guard cases passed");
}

async function main(): Promise<void> {
  try {
    await runWriterGuards();
    await runAutoPullDegradeAndSuggest();
    await runOverrideResolution();
    await runOverridePresentHumanGuard();
  } finally {
    __resetRunAutoSourceQuery();
  }
  console.log("ris-auto-pull-safety: all cases passed");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
