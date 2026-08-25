/* test-registration
{
  "name": "Isolated-schema leftover sweeper (Task #b65e9824)",
  "regression": true,
  "smoke": true,
  "smokeReason": "DB-free pure-function suite; guards the sweeper that keeps orphaned test_iso_* schemas from fooling public-schema presence checks.",
  "tier": "small"
}
test-registration */
/**
 * Task #b65e9824 — Sweep leftover isolated test schemas.
 *
 * Covers, entirely DB-free via an injected executor:
 *   1. Timestamp parsing of the new `test_iso_<base36 ms>_<rand>` format,
 *      including rejection of legacy and garbage names.
 *   2. Classification: expired → drop, fresh → keep, legacy 12-hex → drop,
 *      unrecognized → keep (never guess at unknown objects).
 *   3. The sweep core: exactly the droppable schemas get a
 *      DROP SCHEMA ... CASCADE, quoted; a failure on one schema does not
 *      block the rest; unsafe identifiers are never dropped.
 *   4. The db-sandbox schema-name generator stays in lockstep with the
 *      sweeper's timestamped regex (fresh names parse to ~now).
 */
import assert from "node:assert/strict";

import {
  classifyIsoSchema,
  parseIsoSchemaTimestamp,
  sweepIsolatedSchemas,
  DEFAULT_MAX_AGE_MS,
} from "./sweep-isolated-schemas";

const NOW = Date.UTC(2026, 7, 5, 12, 0, 0); // 2026-08-05T12:00Z
const name = (ts: number, rand = "abcd1234") => `test_iso_${ts.toString(36)}_${rand}`;

async function main() {
  // ── 1. timestamp parsing ────────────────────────────────────────────
  assert.equal(parseIsoSchemaTimestamp(name(NOW - 1000), NOW), NOW - 1000);
  assert.equal(parseIsoSchemaTimestamp("test_iso_ab12cd34ef56", NOW), null, "legacy 12-hex has no timestamp");
  assert.equal(parseIsoSchemaTimestamp("test_iso_zzzzzzzzzzzz_x", NOW), null, "implausible decode rejected");
  assert.equal(parseIsoSchemaTimestamp("test_iso_" + (Date.UTC(2019, 0, 1)).toString(36) + "_x", NOW), null, "pre-2020 rejected");
  assert.equal(parseIsoSchemaTimestamp("some_other_schema", NOW), null);

  // ── 2. classification ───────────────────────────────────────────────
  const expired = name(NOW - DEFAULT_MAX_AGE_MS - 60_000);
  const fresh = name(NOW - 60_000);
  assert.equal(classifyIsoSchema(expired, NOW), "drop-expired");
  assert.equal(classifyIsoSchema(fresh, NOW), "keep-fresh");
  assert.equal(classifyIsoSchema("test_iso_ab12cd34ef56", NOW), "drop-legacy");
  assert.equal(classifyIsoSchema("test_iso_weird-name", NOW), "keep-unrecognized");
  assert.equal(classifyIsoSchema("test_iso_", NOW), "keep-unrecognized");
  // boundary: exactly maxAge old is NOT yet expired (strict >)
  assert.equal(classifyIsoSchema(name(NOW - DEFAULT_MAX_AGE_MS), NOW), "keep-fresh");

  // ── 3. sweep core with fake executor ────────────────────────────────
  const failing = name(NOW - DEFAULT_MAX_AGE_MS - 120_000, "faildrop");
  const listed = [expired, fresh, "test_iso_ab12cd34ef56", "test_iso_weird-name", failing];
  const drops: string[] = [];
  const exec = {
    async query(text: string, values?: unknown[]) {
      if (text.startsWith("SELECT")) {
        assert.deepEqual(values, ["test_iso_%"]);
        return { rows: listed.map((n) => ({ nspname: n })) };
      }
      assert.match(text, /^DROP SCHEMA IF EXISTS "[a-z0-9_]+" CASCADE$/);
      const target = text.match(/"([a-z0-9_]+)"/)![1];
      if (target === failing) throw new Error("simulated lock timeout");
      drops.push(target);
      return { rows: [] };
    },
  };
  const result = await sweepIsolatedSchemas(exec, { now: NOW });
  assert.deepEqual(result.dropped.sort(), [expired, "test_iso_ab12cd34ef56"].sort());
  assert.deepEqual(drops.sort(), result.dropped.sort(), "only droppable schemas were DROPped");
  assert.deepEqual(result.kept, [fresh]);
  assert.deepEqual(result.unrecognized, ["test_iso_weird-name"]);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].schema, failing, "one failed drop does not block the rest");

  // ── 4. lockstep with db-sandbox's generator shape ───────────────────
  const generated = `test_iso_${Date.now().toString(36)}_${"a1b2c3d4"}`;
  const ts = parseIsoSchemaTimestamp(generated);
  assert.ok(ts !== null && Math.abs(Date.now() - ts) < 5_000, "fresh generated name parses to ~now");
  assert.equal(classifyIsoSchema(generated), "keep-fresh");

  console.log("sweep-isolated-schemas.test.ts: all assertions passed");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
