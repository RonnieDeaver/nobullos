/* test-registration
{
  "name": "Judgment open-ask updates match by stable ID (Task #4765)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4765: the judgment loop's open-ask updates now match strictly by stable askId (the 30-char text-prefix heuristic is retired) and newAsks route through the shared dedup'd creation path. A regression here silently reverts to prefix matching or re-minting duplicate asks — invisible in any other suite because the judgment path was the only prefix-matching caller. Hermetic per-run DB, injected AI collaborators, ~3s.",
  "tier": "small"
}
test-registration */
/**
 * Task #4765 — the daily judgment references open asks by stable ID:
 *
 *  (1) buildOpenAsksSection renders an [id:...] marker per ask so the
 *      model can cite rows exactly.
 *  (2) updateOpenAsksFromJudgment matches openAskUpdates strictly by
 *      askId — an update without an askId (or with an unknown one) is
 *      skipped even when its text is a perfect 30-char prefix match of
 *      an existing ask (the retired heuristic must stay retired).
 *  (3) A likelyResolved update parks the row at likely_resolved and runs
 *      the inline hindsight validation: a validated answer transitions
 *      straight to `resolved` with cited evidence; an unvalidated one
 *      stays parked (the maintenance backstop owns it from there).
 *  (4) newAsks route through the shared creation path: the semantic
 *      matcher merging into an existing ask prevents the judgment loop
 *      from re-minting enrichment's rows (cross-type, cross-path dedup).
 */
import "./helpers/forceTestEnv";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql, eq } from "drizzle-orm";
import { getDb } from "../server/db";
import { clientOpenAsks, type ClientOpenAsk } from "@shared/schema";
import {
  buildOpenAsksSection,
  updateOpenAsksFromJudgment,
  type JudgmentAIResponse,
} from "../server/services/dailyJudgment";
import {
  __setOpenAskPipelineDepsForTest,
  __resetOpenAskPipelineDepsForTest,
} from "../server/services/openAskPipeline";

const SUFFIX = randomUUID().slice(0, 8);
const CLIENT_ID = `task4765-judg-${SUFFIX}`;

async function seedAsk(summary: string, extra: Partial<typeof clientOpenAsks.$inferInsert> = {}) {
  const [row] = await getDb()
    .insert(clientOpenAsks)
    .values({
      clientId: CLIENT_ID,
      askType: "client_ask",
      status: "open",
      summary,
      askText: summary,
      mentionCount: 1,
      firstMentionedAt: new Date(),
      lastReferencedAt: new Date(),
      ...extra,
    })
    .returning();
  return row;
}

function aiResult(partial: Partial<JudgmentAIResponse>): JudgmentAIResponse {
  return { openAskUpdates: [], newAsks: [], ...partial } as JudgmentAIResponse;
}

async function reload(id: string): Promise<ClientOpenAsk> {
  const [row] = await getDb().select().from(clientOpenAsks).where(eq(clientOpenAsks.id, id));
  return row;
}

async function main() {
  await getDb().execute(sql`
    INSERT INTO clients (id, firm_name)
    VALUES (${CLIENT_ID}, ${"Task4765 Judgment Firm " + SUFFIX})
    ON CONFLICT (id) DO NOTHING
  `);
  try {
    const askA = await seedAsk(`Send over the updated retainer agreement draft ${SUFFIX}`);
    const askB = await seedAsk(`Schedule the quarterly strategy review call ${SUFFIX}`);

    // (1) Prompt section renders stable IDs.
    const section = buildOpenAsksSection([askA, askB], "2026-08-14").join("\n");
    assert.ok(section.includes(`[id:${askA.id}]`), "prompt renders askA's stable id");
    assert.ok(section.includes(`[id:${askB.id}]`), "prompt renders askB's stable id");

    __setOpenAskPipelineDepsForTest({
      semanticMatch: async () => ({ matchId: null, confidence: 0 }),
      evaluateClosure: async () => ({ disposition: "still_live" }),
    });

    // (2) No askId (perfect text prefix) + unknown askId → both skipped.
    await updateOpenAsksFromJudgment(
      CLIENT_ID,
      aiResult({
        openAskUpdates: [
          // Perfect prefix of askB's text but NO askId — retired heuristic.
          { askText: askB.askText!, likelyResolved: true, stillReferenced: false },
          { askId: "nonexistent-id", askText: "whatever", likelyResolved: true, stillReferenced: false },
        ],
      }),
      [askA, askB],
    );
    assert.equal((await reload(askB.id)).status, "open", "text-prefix match without askId does nothing");

    // (3a) likelyResolved by ID, hindsight validation says still_live → parked.
    await updateOpenAsksFromJudgment(
      CLIENT_ID,
      aiResult({
        openAskUpdates: [{ askId: askB.id, askText: "different words entirely", likelyResolved: true, stillReferenced: false }],
      }),
      [askA, askB],
    );
    const parkedB = await reload(askB.id);
    assert.equal(parkedB.status, "likely_resolved", "ID-matched likelyResolved parks the row");
    assert.ok(parkedB.likelyResolvedAt, "likelyResolvedAt stamped");

    // (3b) likelyResolved by ID with validated evidence → resolved directly.
    __setOpenAskPipelineDepsForTest({
      evaluateClosure: async () => ({
        disposition: "resolved",
        evidence: { communicationId: "comm-judg-1", answeredAt: "2026-08-01", quote: "Here is the signed retainer draft." },
      }),
    });
    await updateOpenAsksFromJudgment(
      CLIENT_ID,
      aiResult({
        openAskUpdates: [{ askId: askA.id, askText: "x", likelyResolved: true, stillReferenced: false }],
      }),
      [askA, askB],
    );
    const resolvedA = await reload(askA.id);
    assert.equal(resolvedA.status, "resolved", "validated likelyResolved transitions to resolved");
    assert.ok(resolvedA.resolutionNote?.includes("comm-judg-1"), "resolution cites the answering communication");

    // (4) newAsks dedup through the shared path: matcher merges into askB.
    __setOpenAskPipelineDepsForTest({
      semanticMatch: async () => ({ matchId: askB.id, confidence: 0.9 }),
      evaluateClosure: async () => ({ disposition: "still_live" }),
    });
    const before = await getDb().select().from(clientOpenAsks).where(eq(clientOpenAsks.clientId, CLIENT_ID));
    await updateOpenAsksFromJudgment(
      CLIENT_ID,
      aiResult({
        newAsks: [{ askText: `Please set up the quarterly review ${SUFFIX}`, askCategory: "strategy", confidence: 0.8 }],
      }),
      [askA, askB],
    );
    const after = await getDb().select().from(clientOpenAsks).where(eq(clientOpenAsks.clientId, CLIENT_ID));
    assert.equal(after.length, before.length, "judgment newAsk merged into the tracked ask — no re-mint");
    const mergedB = await reload(askB.id);
    assert.equal(mergedB.status, "open", "re-referenced likely_resolved ask reopened by the merge");
    assert.equal(mergedB.mentionCount, 2, "merge bumped mentionCount");

    console.log("Judgment ID-matching tests passed.");
  } finally {
    __resetOpenAskPipelineDepsForTest();
    await getDb().execute(sql`DELETE FROM clients WHERE id = ${CLIENT_ID}`);
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
