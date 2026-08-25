/* test-registration
{
  "name": "Zoom guardrail change trends",
  "tier": "medium"
}
test-registration */
/**
 * Verifies `getZoomReviewBucketsAroundAnchor` (the math behind the per-edit
 * routed-to-review sparkline shown next to each Common First Names history
 * entry):
 *
 *   - bucket count is forced even and bucket boundaries cover
 *     [anchor - windowMs, anchor + windowMs]
 *   - decisions outside the window are excluded; decisions inside are bucketed
 *   - before/after totals split exactly on the anchor (first half vs second half)
 *   - optional `reason` filter restricts to a single review_reason
 *   - non-Zoom (`sourceType !== 'zoom'`) and non-review_required rows are ignored
 */

import { storage } from "../server/storage";
import { getDb } from "../server/db";
import { agentMatchDecisions, agentMatchSettingHistory } from "@shared/schema";
import { eq, sql } from "drizzle-orm";
import type { InsertClient } from "@shared/schema";
import { getZoomReviewBucketsAroundAnchor } from "../server/services/zoomReviewQueue";
import { recordAgentMatchSettingHistory } from "../server/storage/agentMatchSettingsStorage";

const TAG = `zoom-guardrail-trends-${Date.now()}`;

function fixtureClient(name: string): InsertClient {
  return {
    firmName: `${name} [${TAG}]`,
    contactName: null,
    contactEmail: null,
    contactPhone: null,
  };
}

async function setCreatedAtForLatest(communicationIdLike: string, when: Date): Promise<void> {
  await getDb().execute(sql`
    UPDATE agent_match_decisions
    SET created_at = ${when}
    WHERE communication_id = ${communicationIdLike}
  `);
}

async function insertDecisionAt(opts: {
  clientId: string;
  at: Date;
  status?: string;
  sourceType?: string;
  reviewReason?: string | null;
  tag: string;
}): Promise<string> {
  const commId = `comm-${TAG}-${opts.tag}-${Math.random().toString(36).slice(2, 8)}`;
  await getDb()
    .insert(agentMatchDecisions)
    .values({
      communicationId: commId,
      communicationType: "zoom_call",
      sourceType: opts.sourceType ?? "zoom",
      clientId: opts.clientId,
      confidenceScore: 0.5,
      status: opts.status ?? "review_required",
      explanationSummary: "test fixture",
      evidenceType: "structured",
      reviewReason: opts.reviewReason ?? null,
    });
  await setCreatedAtForLatest(commId, opts.at);
  return commId;
}

async function cleanup(clientIds: string[]): Promise<void> {
  for (const cid of clientIds) {
    await getDb()
      .delete(agentMatchDecisions)
      .where(eq(agentMatchDecisions.clientId, cid));
    try {
      await storage.deleteClient(cid);
    } catch {
      /* best-effort */
    }
  }
}

function approxEq(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-6;
}

async function main(): Promise<void> {
  const client = await storage.createClient(fixtureClient("trends-fixture"));
  const createdClientIds = [client.id];

  const anchor = new Date("2025-06-15T12:00:00.000Z");
  const windowMs = 6 * 60 * 60 * 1000; // ±6h
  const bucketCount = 12; // even

  // Inside window:
  //   3 reason="contact_name_only_weak" before anchor, 1 after
  //   1 reason="other_weak" after anchor
  //   1 status="approved" (must be ignored)
  //   1 sourceType="email" (must be ignored)
  // Outside window: 1 well before, 1 well after — must be ignored.

  await insertDecisionAt({
    clientId: client.id,
    at: new Date(anchor.getTime() - 5 * 60 * 60 * 1000), // -5h
    reviewReason: "contact_name_only_weak",
    tag: "before-1",
  });
  await insertDecisionAt({
    clientId: client.id,
    at: new Date(anchor.getTime() - 3 * 60 * 60 * 1000), // -3h
    reviewReason: "contact_name_only_weak",
    tag: "before-2",
  });
  await insertDecisionAt({
    clientId: client.id,
    at: new Date(anchor.getTime() - 30 * 60 * 1000), // -30m
    reviewReason: "contact_name_only_weak",
    tag: "before-3",
  });
  await insertDecisionAt({
    clientId: client.id,
    at: new Date(anchor.getTime() + 2 * 60 * 60 * 1000), // +2h
    reviewReason: "contact_name_only_weak",
    tag: "after-1",
  });
  await insertDecisionAt({
    clientId: client.id,
    at: new Date(anchor.getTime() + 1 * 60 * 60 * 1000), // +1h
    reviewReason: "other_weak",
    tag: "after-other",
  });

  // Excluded: status != review_required
  await insertDecisionAt({
    clientId: client.id,
    at: new Date(anchor.getTime() + 30 * 60 * 1000),
    reviewReason: "contact_name_only_weak",
    status: "approved",
    tag: "wrong-status",
  });
  // Excluded: sourceType != zoom
  await insertDecisionAt({
    clientId: client.id,
    at: new Date(anchor.getTime() + 30 * 60 * 1000),
    reviewReason: "contact_name_only_weak",
    sourceType: "email",
    tag: "wrong-source",
  });
  // Outside window
  await insertDecisionAt({
    clientId: client.id,
    at: new Date(anchor.getTime() - 9 * 60 * 60 * 1000),
    reviewReason: "contact_name_only_weak",
    tag: "out-before",
  });
  await insertDecisionAt({
    clientId: client.id,
    at: new Date(anchor.getTime() + 9 * 60 * 60 * 1000),
    reviewReason: "contact_name_only_weak",
    tag: "out-after",
  });

  try {
    // ---- Case 1: no reason filter — counts all review_required Zoom rows in window ----
    const all = await getZoomReviewBucketsAroundAnchor({
      anchor,
      windowMs,
      bucketCount,
    });
    if (all.bucketCount !== bucketCount) {
      throw new Error(`bucketCount: expected ${bucketCount}, got ${all.bucketCount}`);
    }
    if (all.buckets.length !== bucketCount) {
      throw new Error(`buckets length mismatch: ${all.buckets.length}`);
    }
    if (all.windowMs !== windowMs) {
      throw new Error(`windowMs round-trip mismatch: ${all.windowMs}`);
    }
    if (all.anchor !== anchor.toISOString()) {
      throw new Error(`anchor round-trip mismatch: ${all.anchor}`);
    }
    // Expect: 3 before (contact_name_only_weak) + 1 after (contact_name_only_weak)
    //         + 1 after (other_weak) = 3 before, 2 after, total 5.
    if (all.before !== 3) throw new Error(`before(no-filter): expected 3, got ${all.before}`);
    if (all.after !== 2) throw new Error(`after(no-filter): expected 2, got ${all.after}`);
    if (all.total !== 5) throw new Error(`total(no-filter): expected 5, got ${all.total}`);
    if (all.reason !== null) throw new Error(`reason(no-filter): expected null, got ${all.reason}`);

    // Bucket-coverage invariants: contiguous, even, anchor-centered.
    const firstStart = new Date(all.buckets[0].start).getTime();
    const lastEnd = new Date(all.buckets[bucketCount - 1].end).getTime();
    if (firstStart !== anchor.getTime() - windowMs) {
      throw new Error(`first bucket start should equal anchor - windowMs`);
    }
    const totalSpan = lastEnd - firstStart;
    if (Math.abs(totalSpan - 2 * windowMs) > 1) {
      throw new Error(
        `total span ${totalSpan} should approximately equal 2 * windowMs (${2 * windowMs})`,
      );
    }
    // The boundary between bucket[bucketCount/2 - 1].end and bucket[bucketCount/2].start
    // should sit on the anchor.
    const midBoundary = new Date(all.buckets[bucketCount / 2].start).getTime();
    if (Math.abs(midBoundary - anchor.getTime()) > 1) {
      throw new Error(
        `mid-bucket boundary ${midBoundary} should sit on the anchor ${anchor.getTime()}`,
      );
    }
    // Sum of bucket counts must equal total.
    const bucketSum = all.buckets.reduce((s, b) => s + b.count, 0);
    if (bucketSum !== all.total) {
      throw new Error(`sum of bucket counts ${bucketSum} != total ${all.total}`);
    }

    // ---- Case 2: reason filter ('contact_name_only_weak') ----
    const filtered = await getZoomReviewBucketsAroundAnchor({
      anchor,
      windowMs,
      bucketCount,
      reason: "contact_name_only_weak",
    });
    if (filtered.before !== 3)
      throw new Error(`before(filter): expected 3, got ${filtered.before}`);
    if (filtered.after !== 1)
      throw new Error(`after(filter): expected 1, got ${filtered.after}`);
    if (filtered.total !== 4)
      throw new Error(`total(filter): expected 4, got ${filtered.total}`);
    if (filtered.reason !== "contact_name_only_weak")
      throw new Error(`reason round-trip: ${filtered.reason}`);

    // ---- Case 3: odd bucketCount is rounded UP to even ----
    const odd = await getZoomReviewBucketsAroundAnchor({
      anchor,
      windowMs,
      bucketCount: 7,
    });
    if (odd.bucketCount !== 8)
      throw new Error(`odd bucketCount should round to 8, got ${odd.bucketCount}`);
    if (odd.buckets.length !== 8)
      throw new Error(`odd buckets length should be 8, got ${odd.buckets.length}`);

    // ---- Case 5: reason='weak_signal_only' (used by ZOOM_STRONG_SIGNAL_MIN_WEIGHT
    //              edits in TRENDS_KEY_CONFIG). Same helper, different reason filter:
    //              add 2 weak_signal_only rows before, 1 after, plus a wrong-reason
    //              row that must NOT be counted.
    await insertDecisionAt({
      clientId: client.id,
      at: new Date(anchor.getTime() - 4 * 60 * 60 * 1000), // -4h
      reviewReason: "weak_signal_only",
      tag: "wso-before-1",
    });
    await insertDecisionAt({
      clientId: client.id,
      at: new Date(anchor.getTime() - 1 * 60 * 60 * 1000), // -1h
      reviewReason: "weak_signal_only",
      tag: "wso-before-2",
    });
    await insertDecisionAt({
      clientId: client.id,
      at: new Date(anchor.getTime() + 3 * 60 * 60 * 1000), // +3h
      reviewReason: "weak_signal_only",
      tag: "wso-after-1",
    });
    await insertDecisionAt({
      clientId: client.id,
      at: new Date(anchor.getTime() + 2 * 60 * 60 * 1000),
      reviewReason: "other_weak", // wrong reason — must be ignored by filter
      tag: "wso-wrong-reason",
    });

    const weakSignal = await getZoomReviewBucketsAroundAnchor({
      anchor,
      windowMs,
      bucketCount,
      reason: "weak_signal_only",
    });
    if (weakSignal.before !== 2)
      throw new Error(`before(weak_signal_only): expected 2, got ${weakSignal.before}`);
    if (weakSignal.after !== 1)
      throw new Error(`after(weak_signal_only): expected 1, got ${weakSignal.after}`);
    if (weakSignal.total !== 3)
      throw new Error(`total(weak_signal_only): expected 3, got ${weakSignal.total}`);
    if (weakSignal.reason !== "weak_signal_only")
      throw new Error(`reason round-trip(weak_signal_only): ${weakSignal.reason}`);
    const wsoSum = weakSignal.buckets.reduce((s, b) => s + b.count, 0);
    if (wsoSum !== weakSignal.total)
      throw new Error(`weak_signal_only bucket sum ${wsoSum} != total ${weakSignal.total}`);

    // The contact_name_only_weak filter result must be unchanged by the new fixtures.
    const filteredAgain = await getZoomReviewBucketsAroundAnchor({
      anchor,
      windowMs,
      bucketCount,
      reason: "contact_name_only_weak",
    });
    if (filteredAgain.total !== 4)
      throw new Error(
        `cross-reason isolation broken: contact_name_only_weak total should still be 4, got ${filteredAgain.total}`,
      );

    // ---- Case 6: storage.listAgentMatchSettingHistory source-routing ----
    // Mirrors the lookup the trends endpoint performs for numeric Zoom keys
    // when TRENDS_KEY_CONFIG.source === "match_setting_history". The endpoint
    // calls storage.listAgentMatchSettingHistory({source: "zoom", settingKey})
    // (see server/routes/agents.ts), so we round-trip a record through that
    // path to confirm the allowlist→source routing is wired correctly.
    const settingKey = `ZOOM_STRONG_SIGNAL_MIN_WEIGHT__${TAG}`;
    const historyRow = await recordAgentMatchSettingHistory({
      source: "zoom",
      settingKey,
      oldValue: 5,
      newValue: 7,
      changedBy: null,
    });
    try {
      const fetched = await storage.listAgentMatchSettingHistory({
        source: "zoom",
        settingKey,
        limit: 10,
      });
      if (fetched.length !== 1)
        throw new Error(
          `match_setting_history routing: expected 1 row, got ${fetched.length}`,
        );
      if (fetched[0].id !== historyRow.id)
        throw new Error(
          `match_setting_history routing: returned wrong row id ${fetched[0].id}`,
        );
      if (fetched[0].source !== "zoom" || fetched[0].settingKey !== settingKey)
        throw new Error(
          `match_setting_history routing: source/settingKey mismatch on returned row`,
        );

      // Wrong source must NOT match — confirms the source filter is honored
      // (the endpoint pins source to "zoom" via config.matchSettingScope).
      const wrongSource = await storage.listAgentMatchSettingHistory({
        source: "email",
        settingKey,
        limit: 10,
      });
      if (wrongSource.length !== 0)
        throw new Error(
          `match_setting_history routing: source filter leaked, got ${wrongSource.length} rows for source=email`,
        );
    } finally {
      await getDb()
        .delete(agentMatchSettingHistory)
        .where(eq(agentMatchSettingHistory.id, historyRow.id));
    }

    // ---- Case 4: tiny window excludes everything outside ----
    const tiny = await getZoomReviewBucketsAroundAnchor({
      anchor,
      windowMs: 10 * 60 * 1000, // ±10m
      bucketCount: 4,
      reason: "contact_name_only_weak",
    });
    // Only the -30m fixture might fall in here? -30m is outside ±10m. So total = 0.
    if (tiny.total !== 0)
      throw new Error(`tiny window should exclude everything, got total ${tiny.total}`);
    if (tiny.before !== 0 || tiny.after !== 0)
      throw new Error(`tiny window before/after should be 0/0, got ${tiny.before}/${tiny.after}`);

    console.log("OK getZoomReviewBucketsAroundAnchor: bucket math, before/after split, reason filter all pass.");
  } finally {
    await cleanup(createdClientIds);
  }
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main()
  .then(() => {})
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
