/* test-registration
{
  "name": "Ads OS schedule sync prod action — patchClientSchedule preserves raw doc fields (no metadata loss), read failure prevents any write, skips absent docs, patches only schedule fields; status/apply convergence via stub deps (Task #4818)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4818: schedule sync action correctness. patchClientSchedule is the core of the prod action + dev sync script; a regression here would silently erase criteria metadata (updated_at, legacy keys) or write empty docs over saved criteria on a transient DB error. Fetch-free, DB-free (stub deps), fast unit test.",
  "tier": "small"
}
test-registration */
/**
 * Tests for the Ads OS schedule sync prod action (Task #4818).
 *
 * patchClientSchedule is exported with injectable read/write deps so we can
 * verify correctness without a real database.
 *
 * Coverage:
 *   1. Raw-field preservation — non-schedule fields (business_name, notes,
 *      custom_field, updated_at) survive a schedule patch unchanged.
 *   2. Read failure → no write — if the strict reader throws, the error
 *      propagates and write is never called.
 *   3. Absent doc → skipped — if the reader returns null (genuinely absent),
 *      no write occurs and outcome is "skipped-absent".
 *   4. Already-matching → skipped — if stored schedule already equals target,
 *      outcome is "skipped-match" and no write occurs.
 *   5. Converges after apply — after patchClientSchedule writes the target,
 *      calling it again with the updated doc returns "skipped-match".
 *   6. Both gads and lsa patched independently — gads-only, lsa-only, both.
 */

process.env.NODE_ENV = "test";

import assert from "node:assert/strict";

const { patchClientSchedule } = await import(
  "../server/services/prodActions/platformOpsActions"
);

// ── helpers ──────────────────────────────────────────────────────────────────

function makeReader(doc: Record<string, any> | null) {
  return async (_cid: string) => doc;
}

function makeFaultyReader(msg = "connection timeout") {
  return async (_cid: string): Promise<Record<string, any> | null> => {
    throw new Error(msg);
  };
}

function makeWriter() {
  const writes: { cid: string; data: Record<string, any> }[] = [];
  const fn = async (cid: string, data: Record<string, any>) => { writes.push({ cid, data }); };
  return { fn, writes };
}

const ENTRY_GADS_ONLY = {
  cid: "1234567890",
  gads: ["Mon", "Tue", "Wed", "Thu", "Fri"],
  lsa: null,
  client: "Test Client GAds",
};
const ENTRY_LSA_ONLY = {
  cid: "0987654321",
  gads: null,
  lsa: ["Mon", "Wed", "Fri"],
  client: "Test Client LSA",
};
const ENTRY_BOTH = {
  cid: "5555555555",
  gads: ["Mon", "Fri"],
  lsa: ["Tue", "Thu", "Sat"],
  client: "Test Client Both",
};

// ── 1. Raw-field preservation ────────────────────────────────────────────────

{
  const existingDoc = {
    business_name: "Acme Law",
    notes: "important notes",
    custom_legacy_field: "legacy_value",
    updated_at: "2024-01-01T00:00:00.000Z",
    schedule_days: [], // mismatches ENTRY_GADS_ONLY target
    lsa_schedule_days: [],
  };
  const { fn: write, writes } = makeWriter();
  const result = await patchClientSchedule(ENTRY_GADS_ONLY, makeReader(existingDoc), write);

  assert.equal(result.outcome, "updated", "outcome is 'updated' when schedule differs");
  assert.equal(writes.length, 1, "exactly one write issued");
  const written = writes[0].data;

  assert.equal(written.business_name, "Acme Law", "business_name preserved");
  assert.equal(written.notes, "important notes", "notes preserved");
  assert.equal(written.custom_legacy_field, "legacy_value", "unknown legacy field preserved");
  assert.deepEqual(written.schedule_days, ["Mon", "Tue", "Wed", "Thu", "Fri"], "schedule_days patched to target");
  assert.deepEqual(written.lsa_schedule_days, [], "lsa_schedule_days untouched (gads-only entry)");
  assert.ok(written.updated_at !== "2024-01-01T00:00:00.000Z", "updated_at refreshed");
  assert.ok(typeof written.updated_at === "string", "updated_at is a string");
  console.log("  ✓ 1: raw-field preservation — non-schedule fields survive a patch");
}

// ── 2. Read failure → no write ───────────────────────────────────────────────

{
  const { fn: write, writes } = makeWriter();
  await assert.rejects(
    () => patchClientSchedule(ENTRY_GADS_ONLY, makeFaultyReader("DB timeout"), write),
    /DB timeout/,
    "read failure propagates the error",
  );
  assert.equal(writes.length, 0, "no write issued when read throws");
  console.log("  ✓ 2: read failure → error propagates, no write occurs");
}

// ── 3. Absent doc → skipped-absent ──────────────────────────────────────────

{
  const { fn: write, writes } = makeWriter();
  const result = await patchClientSchedule(ENTRY_GADS_ONLY, makeReader(null), write);
  assert.equal(result.outcome, "skipped-absent", "null from reader = skipped-absent");
  assert.equal(writes.length, 0, "no write for absent doc");
  console.log("  ✓ 3: absent doc (null from strict reader) → skipped, no write");
}

// ── 4. Already-matching → skipped-match ─────────────────────────────────────

{
  const matchingDoc = {
    business_name: "Match Law",
    schedule_days: ["Mon", "Tue", "Wed", "Thu", "Fri"],
    lsa_schedule_days: [],
    updated_at: "2025-06-01T00:00:00.000Z",
  };
  const { fn: write, writes } = makeWriter();
  const result = await patchClientSchedule(ENTRY_GADS_ONLY, makeReader(matchingDoc), write);
  assert.equal(result.outcome, "skipped-match", "already-matching → skipped-match");
  assert.equal(writes.length, 0, "no write when already matching");
  console.log("  ✓ 4: already-matching schedule → skipped-match, no write");
}

// ── 5. Convergence — second pass returns skipped-match ──────────────────────

{
  // Simulate what the store looks like after apply() patches it.
  let storedDoc: Record<string, any> = {
    business_name: "Converge Law",
    schedule_days: [],
    lsa_schedule_days: [],
    updated_at: "2025-01-01T00:00:00.000Z",
  };
  // Write updates storedDoc in-place (simulates store round-trip).
  const write = async (_cid: string, data: Record<string, any>) => { storedDoc = data; };
  const read = async (_cid: string) => storedDoc;

  const first = await patchClientSchedule(ENTRY_GADS_ONLY, read, write);
  assert.equal(first.outcome, "updated", "first pass: updated");

  const second = await patchClientSchedule(ENTRY_GADS_ONLY, read, write);
  assert.equal(second.outcome, "skipped-match", "second pass after apply: skipped-match");
  console.log("  ✓ 5: convergence — second patchClientSchedule pass returns skipped-match");
}

// ── 6. gads-only / lsa-only / both — correct field isolation ────────────────

{
  const baseDoc = {
    business_name: "Isolation Law",
    schedule_days: [], // needs updating for ENTRY_GADS_ONLY
    lsa_schedule_days: ["Sat", "Sun"], // should be untouched for ENTRY_GADS_ONLY
  };

  // gads-only: lsa field untouched
  {
    const { fn: write, writes } = makeWriter();
    await patchClientSchedule(ENTRY_GADS_ONLY, makeReader({ ...baseDoc }), write);
    assert.deepEqual(writes[0].data.schedule_days, ["Mon","Tue","Wed","Thu","Fri"], "gads-only: schedule_days patched");
    assert.deepEqual(writes[0].data.lsa_schedule_days, ["Sat","Sun"], "gads-only: lsa_schedule_days untouched");
  }

  // lsa-only: gads field untouched
  {
    const docWithGads = { ...baseDoc, schedule_days: ["Mon","Wed","Fri"] };
    const { fn: write, writes } = makeWriter();
    await patchClientSchedule(ENTRY_LSA_ONLY, makeReader(docWithGads), write);
    assert.deepEqual(writes[0].data.schedule_days, ["Mon","Wed","Fri"], "lsa-only: schedule_days untouched");
    assert.deepEqual(writes[0].data.lsa_schedule_days, ["Mon","Wed","Fri"], "lsa-only: lsa_schedule_days patched");
  }

  // both: both fields patched
  {
    const docBoth = { ...baseDoc, schedule_days: [], lsa_schedule_days: [] };
    const { fn: write, writes } = makeWriter();
    await patchClientSchedule(ENTRY_BOTH, makeReader(docBoth), write);
    assert.deepEqual(writes[0].data.schedule_days, ["Mon","Fri"], "both: schedule_days patched");
    assert.deepEqual(writes[0].data.lsa_schedule_days, ["Tue","Thu","Sat"], "both: lsa_schedule_days patched");
  }

  console.log("  ✓ 6: field isolation — gads-only/lsa-only/both patch exactly the targeted fields");
}

// ── Order-independence: shuffled stored days still match ────────────────────

{
  const docShuffled = {
    schedule_days: ["Fri", "Thu", "Wed", "Tue", "Mon"], // same as target, different order
    lsa_schedule_days: [],
  };
  const { fn: write, writes } = makeWriter();
  const result = await patchClientSchedule(ENTRY_GADS_ONLY, makeReader(docShuffled), write);
  assert.equal(result.outcome, "skipped-match", "shuffled days still treated as matching");
  assert.equal(writes.length, 0, "no write for order-only difference");
  console.log("  ✓ 7: order-independence — shuffled days treated as matching (no spurious write)");
}

console.log("\nAll schedule-sync-action tests passed.");
