/* test-registration
{
  "name": "Data access detection (baseline triage, Task #3424)",
  "tier": "small"
}
test-registration */
/**
 * Task #2418 — Data Access clarity + smart missing-data prompts.
 *
 * Two things are locked in here:
 *
 *  1. `detectClientDataPresence(clientId)` — the advisory, read-only
 *     per-category data-presence signal. It reads ONLY already-ingested
 *     local tables (no external calls) and resolves each of the five
 *     categories to `present` / `absent` / `unknown`:
 *       - follow_up_touches  → any raw_communication_records row.
 *       - sales_transcripts  → a Zoom raw_communication_records row with a
 *                              ready transcript.
 *       - consult_bookings / no_show_rate → any scheduled_meetings row.
 *       - sales_conversions  → any ris_check_results row, else `unknown`
 *                              (RIS absence ≠ "no conversion data").
 *
 *     The "Presti Law" case (Task #2418): communications flowing but zero
 *     transcripts → follow_up_touches `present` while sales_transcripts
 *     stays `absent`.
 *
 *  2. `classifyDataAccessForReport(...)` — the pure split the report uses to
 *     decide which not-available categories become the soft "mark
 *     Available?" prompt (detection `present`) vs the red critical warning
 *     (absent / unknown / no detection).
 *
 * Isolation (Task #1929 pattern): the detection test runs inside
 * `runInIsolatedSchema` so the live `Start application` workers (default
 * search_path = public) cannot see or race the rows it seeds. The clone
 * drops FKs, so arbitrary client_id / check_id values can be inserted
 * without seeding `clients` / `ris_checks`.
 */

import assert from "node:assert/strict";
import { sql } from "drizzle-orm";

import { detectClientDataPresence } from "../server/services/dataAccessDetection";
import { classifyDataAccessForReport } from "@shared/schema";
import { runInIsolatedSchema } from "./db-sandbox";

const TABLES = [
  "raw_communication_records",
  "scheduled_meetings",
  "ris_check_results",
] as const;

type IsoDb = Parameters<Parameters<typeof runInIsolatedSchema>[0]>[0]["db"];

let passed = 0;
function ok(msg: string): void {
  passed++;
  console.log(`  ok  ${msg}`);
}

async function seedComm(
  isoDb: IsoDb,
  row: { id: string; clientId: string; sourceType: string; transcriptStatus?: string | null },
): Promise<void> {
  await isoDb.execute(sql`
    INSERT INTO raw_communication_records
      (id, client_id, source_type, title, timestamp, transcript_status, created_at, updated_at)
    VALUES (
      ${row.id},
      ${row.clientId},
      ${row.sourceType},
      ${`seed ${row.id}`},
      NOW(),
      ${row.transcriptStatus ?? null},
      NOW(),
      NOW()
    )
  `);
}

async function seedMeeting(
  isoDb: IsoDb,
  row: { id: string; clientId: string },
): Promise<void> {
  await isoDb.execute(sql`
    INSERT INTO scheduled_meetings
      (id, client_id, booking_source, start_time_utc, end_time_utc, timezone, status, created_at, updated_at)
    VALUES (
      ${row.id},
      ${row.clientId},
      'native',
      NOW(),
      NOW() + interval '30 minutes',
      'UTC',
      'scheduled',
      NOW(),
      NOW()
    )
  `);
}

async function seedRisResult(
  isoDb: IsoDb,
  row: { id: string; clientId: string },
): Promise<void> {
  await isoDb.execute(sql`
    INSERT INTO ris_check_results
      (id, check_id, client_id, period, status, source)
    VALUES (
      ${row.id},
      ${`chk-${row.id}`},
      ${row.clientId},
      '2026-06',
      'pass',
      'manual'
    )
  `);
}

async function testDetectionPerCategory(): Promise<void> {
  await runInIsolatedSchema(async ({ db: isoDb }) => {
    // ── "Presti-style" client: comms flowing, zero transcripts, bookings
    //    present, no RIS rows. ───────────────────────────────────────────
    const presti = "client-presti";
    await seedComm(isoDb, { id: "c1", clientId: presti, sourceType: "front_email" });
    await seedComm(isoDb, { id: "c2", clientId: presti, sourceType: "twilio_sms" });
    await seedComm(isoDb, { id: "c3", clientId: presti, sourceType: "slack" });
    // A Zoom row WITHOUT a ready transcript must NOT count as a transcript.
    await seedComm(isoDb, { id: "c4", clientId: presti, sourceType: "zoom", transcriptStatus: "pending" });
    await seedMeeting(isoDb, { id: "m1", clientId: presti });

    const prestiResult = await detectClientDataPresence(presti);
    assert.equal(prestiResult.follow_up_touches, "present", "comms present → follow_up_touches present");
    assert.equal(prestiResult.sales_transcripts, "absent", "no ready transcript → sales_transcripts absent");
    assert.equal(prestiResult.consult_bookings, "present", "booking row → consult_bookings present");
    assert.equal(prestiResult.no_show_rate, "present", "booking row → no_show_rate present");
    assert.equal(prestiResult.sales_conversions, "unknown", "no RIS rows → sales_conversions unknown (can't tell)");
    ok("Presti-style: follow_up_touches present, sales_transcripts absent, conversions unknown");

    // ── Fully-covered client: ready Zoom transcript + RIS rows. ──────────
    const covered = "client-covered";
    await seedComm(isoDb, { id: "z1", clientId: covered, sourceType: "zoom", transcriptStatus: "ready" });
    await seedRisResult(isoDb, { id: "r1", clientId: covered });

    const cov = await detectClientDataPresence(covered);
    assert.equal(cov.follow_up_touches, "present", "zoom comm counts as a communication record");
    assert.equal(cov.sales_transcripts, "present", "ready zoom transcript → sales_transcripts present");
    assert.equal(cov.sales_conversions, "present", "RIS rows → sales_conversions present");
    assert.equal(cov.consult_bookings, "absent", "no bookings → consult_bookings absent");
    assert.equal(cov.no_show_rate, "absent", "no bookings → no_show_rate absent");
    ok("Covered client: transcript + RIS detected present; bookings absent");

    // ── Empty client: everything absent except conversions (unknown). ────
    const empty = "client-empty";
    const emp = await detectClientDataPresence(empty);
    assert.equal(emp.follow_up_touches, "absent");
    assert.equal(emp.sales_transcripts, "absent");
    assert.equal(emp.consult_bookings, "absent");
    assert.equal(emp.no_show_rate, "absent");
    assert.equal(emp.sales_conversions, "unknown");
    ok("Empty client: all absent, conversions unknown");
  }, { tables: TABLES });
}

function testClassifyForReport(): void {
  // Presti-style: follow_up_touches detected present → soft prompt;
  // sales_transcripts unknown/absent → red critical. consult_bookings is
  // "available" so it never appears in either bucket.
  const statusByCategory = {
    consult_bookings: "available",
    sales_conversions: "pending",
    sales_transcripts: "unknown",
    no_show_rate: "available",
    follow_up_touches: "unknown",
  };
  const detection = {
    consult_bookings: "present" as const,
    sales_conversions: "unknown" as const,
    sales_transcripts: "absent" as const,
    no_show_rate: "present" as const,
    follow_up_touches: "present" as const,
  };

  const { detected, critical } = classifyDataAccessForReport(statusByCategory, detection);

  assert.deepEqual(
    detected.map((d) => d.id),
    ["follow_up_touches"],
    "only the not-available + present category is a soft prompt",
  );
  assert.equal(detected[0].label, "CRM Follow-Up Data", "uses the shared label");

  assert.deepEqual(
    critical.map((d) => d.id),
    ["sales_conversions", "sales_transcripts"],
    "not-available + absent/unknown stay critical",
  );
  ok("classify: present→prompt, absent/unknown→critical, available excluded");

  // No detection at all (e.g. detection query not yet loaded) → everything
  // not-available falls back to critical (current manual behaviour).
  const { detected: d2, critical: c2 } = classifyDataAccessForReport(
    { follow_up_touches: "unknown", sales_transcripts: "refused" },
    null,
  );
  assert.equal(d2.length, 0, "no detection → no soft prompts");
  assert.deepEqual(
    c2.map((c) => c.id).sort(),
    ["follow_up_touches", "sales_transcripts"],
    "no detection → all not-available are critical",
  );
  ok("classify: missing detection falls back to all-critical");
}

async function main(): Promise<void> {
  await testDetectionPerCategory();
  testClassifyForReport();
  console.log(`\n${passed} assertion group(s) passed`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
