/* test-registration
{
  "name": "Open-ask source pipeline: dedup, hindsight closure, decay (Task #4765)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4765: the open-ask tracker was one-way (276 open rows in prod, zero ever resolved). This suite pins the entire corrective contract: burst-concurrent extraction of the same ask lands ONE row (partial unique index + advisory-lock re-check), cross-type semantic dedup with defined merge semantics, the hindsight sweep's resolved-with-evidence transition (the first reachable path to status=resolved), standing decay to an audited terminal state, the likely_resolved auto-confirm backstop (the strand-forever regression), and the groom prod-action's converging pending counters. All AI collaborators injected; hermetic per-run DB; no network.",
  "tier": "small"
}
test-registration */
/**
 * Task #4765 — open-ask source pipeline tests.
 *
 * Covers:
 *  (1) Burst-race dedup: N concurrent recordExtractedAsk calls for the
 *      byte-identical ask land exactly ONE row, with mention counts and
 *      source record ids merged (the old SELECT-then-INSERT minted N rows).
 *  (2) Cross-type semantic dedup: an internal_promise extraction merges
 *      into an existing client_ask when the matcher says same item —
 *      the judgment path can no longer re-mint enrichment's asks.
 *  (3) Merge semantics: mentionCount adds, sourceRecordIds union,
 *      concernScore bumps capped at 10, re-referenced likely_resolved
 *      rows reopen.
 *  (4) Hindsight closure: a validated answer transitions the row to
 *      `resolved` with cited evidence (comm id + quote in the resolution
 *      note) — the end-to-end reachability regression for `resolved`.
 *      An evaluator verdict without in-corpus evidence NEVER closes.
 *  (5) Standing decay: still-live-but-abandoned asks (no reference in
 *      DECAY_HORIZON_DAYS+) archive to an audited `dismissed`.
 *  (6) likely_resolved strand regression: maintenance auto-confirms rows
 *      parked at likely_resolved for LIKELY_RESOLVED_CONFIRM_DAYS+.
 *  (7) Groom bookkeeping: hindsight_checked_at stamps make
 *      countHindsightPending converge; sweep dispositions tally honestly;
 *      evaluator errors leave rows unstamped (retryable, never closed).
 *  (8) Reader alignment: the shared active-set constant is exactly
 *      open+likely_open and sweepable adds only likely_resolved.
 *  (9) Completed constraint rollout (Tasks #4803/#4811): the partial
 *      unique index is re-anchored in the schema (model entry + idempotent
 *      migration 20260814211021), so a hermetic genesis DB starts WITH the
 *      backstop and the enable_open_ask_dedup_constraint prod action reads
 *      not-needed out of the box — status AND apply, with zero writes.
 *      (The action stays registered as the enabler for environments
 *      restored from pre-rollout backups; the burst-race duplicate-insert
 *      protection itself is pinned independently of the action by (1).)
 */
import "./helpers/forceTestEnv";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql, eq, and } from "drizzle-orm";
import { getDb } from "../server/db";
import {
  clientOpenAsks,
  openAskActiveStatuses,
  openAskSweepableStatuses,
  rawCommunicationRecords,
} from "@shared/schema";
import {
  recordExtractedAsk,
  sweepClientOpenAsks,
  runOpenAskMaintenance,
  evaluateAndApplyAskClosure,
  countHindsightPending,
  listClientsWithHindsightPending,
  CLOSURE_EVAL_MAX_COMMS,
  DECAY_HORIZON_DAYS,
  LIKELY_RESOLVED_CONFIRM_DAYS,
  __setOpenAskPipelineDepsForTest,
  __resetOpenAskPipelineDepsForTest,
  validateClosureEvidence,
  CLOSURE_MODEL_VISIBLE_CHARS,
} from "../server/services/openAskPipeline";
import { enableOpenAskDedupConstraintAction } from "../server/services/prodActions/reportContentActions";

const SUFFIX = randomUUID().slice(0, 8);
const CLIENT_ID = `task4765-client-${SUFFIX}`;
const DAY_MS = 24 * 60 * 60 * 1000;

function noMatch() {
  return Promise.resolve({ matchId: null, confidence: 0 });
}

async function listRows(clientId = CLIENT_ID) {
  return getDb().select().from(clientOpenAsks).where(eq(clientOpenAsks.clientId, clientId));
}

async function seedAsk(fields: Partial<typeof clientOpenAsks.$inferInsert> & { summary: string }) {
  const [row] = await getDb()
    .insert(clientOpenAsks)
    .values({
      clientId: CLIENT_ID,
      askType: "client_ask",
      status: "open",
      askText: fields.summary,
      firstMentionedAt: new Date(),
      lastReferencedAt: new Date(),
      mentionCount: 1,
      ...fields,
    })
    .returning();
  return row;
}

async function main() {
  const db = getDb();
  await db.execute(sql`
    INSERT INTO clients (id, firm_name)
    VALUES (${CLIENT_ID}, ${"Task4765 Test Firm " + SUFFIX})
    ON CONFLICT (id) DO NOTHING
  `);

  try {
    // ── (8) Reader-alignment constants ──────────────────────────────
    assert.deepEqual([...openAskActiveStatuses], ["open", "likely_open"], "active set is open+likely_open");
    assert.deepEqual(
      [...openAskSweepableStatuses],
      ["open", "likely_open", "likely_resolved"],
      "sweepable = active + likely_resolved (so parked rows cannot hide from dedup/closure)",
    );

    // ── (9) Completed constraint rollout — not-needed from genesis ──
    // Rollout history (Tasks #4765/#4803/#4811): the index was temporarily
    // staged OUT of the model on 2026-08-14 while production still held
    // duplicate active rows; the enable_open_ask_dedup_constraint prod
    // action merged them and built the index in production the same day,
    // and Task #4811 re-anchored it in the schema (model entry + idempotent
    // migration 20260814211021). A hermetic genesis DB therefore starts
    // WITH the backstop — pinning the model↔migration lockstep — and the
    // action must read not-needed out of the box, from status AND apply,
    // without writing anything.
    const regGenesis = await db.execute(
      sql`SELECT to_regclass('public.client_open_asks_active_summary_uniq') AS reg`,
    );
    assert.ok(
      (regGenesis.rows[0] as { reg: string | null }).reg,
      "genesis DB starts WITH the re-anchored partial unique index",
    );

    const control = await seedAsk({
      summary: `Control ask untouched by enablement ${SUFFIX}`,
      status: "open",
    });

    const statusFromGenesis = await enableOpenAskDedupConstraintAction.status();
    assert.equal(statusFromGenesis.state, "not-needed", "status: backstop already live from genesis");
    const applyFromGenesis = await enableOpenAskDedupConstraintAction.apply(null);
    assert.equal(applyFromGenesis.state, "not-needed", "apply: no-op when the index already exists");

    const controlRow = (await listRows()).find((r) => r.id === control.id)!;
    assert.equal(controlRow.status, "open", "not-needed apply writes nothing");
    assert.equal(controlRow.mentionCount, 1, "control tallies untouched");

    // ── (1) Burst-race dedup ────────────────────────────────────────
    __setOpenAskPipelineDepsForTest({ semanticMatch: noMatch });
    const burstSummary = `Send the updated PPC budget breakdown ${SUFFIX}`;
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        recordExtractedAsk(
          CLIENT_ID,
          { summary: burstSummary, type: "client_ask", urgency: 2, unresolvedLikelihood: 0.9 },
          { sourceRecordId: `burst-src-${i}-${SUFFIX}` },
        ),
      ),
    );
    const burstRows = (await listRows()).filter((r) => r.summary === burstSummary);
    assert.equal(burstRows.length, 1, "5 concurrent extractions of the same ask land exactly ONE row");
    assert.equal(results.filter((r) => r.outcome === "created").length, 1, "exactly one create outcome");
    assert.equal(results.filter((r) => r.outcome === "merged").length, 4, "the four racers merged");
    assert.equal(burstRows[0].mentionCount, 5, "mention counts merged across the burst");
    assert.equal(
      new Set(burstRows[0].sourceRecordIds ?? []).size,
      5,
      "all five source record ids retained",
    );

    // The DB index itself rejects a raw duplicate insert (defense below the helper).
    let uniqueViolation: unknown = null;
    try {
      await db.insert(clientOpenAsks).values({
        clientId: CLIENT_ID,
        askType: "internal_promise",
        summary: `  ${burstSummary.toUpperCase()}  `, // normalized-equal
        status: "likely_open",
      });
    } catch (err) {
      uniqueViolation = err;
    }
    assert.ok(uniqueViolation, "duplicate raw insert must throw");
    // pg SQLSTATE hides in the .cause chain under drizzle.
    let cur: any = uniqueViolation;
    let sawUnique = false;
    while (cur) {
      if (cur.code === "23505" || /client_open_asks_active_summary_uniq/.test(String(cur.message ?? ""))) {
        sawUnique = true;
        break;
      }
      cur = cur.cause;
    }
    assert.ok(sawUnique, "partial unique index blocks normalized-equal duplicate inserts while active");

    // ── (1b) Burst-race merge into an EXISTING semantically-matched ask ──
    // The reviewer-flagged case: the row already exists and N concurrent
    // extractions all semantically match it. A read-modify-write merge
    // would lose mentions/source ids to the last writer; the atomic SQL
    // merge must retain every one.
    const preexisting = await seedAsk({
      summary: `Existing tracked ask for merge race ${SUFFIX}`,
      mentionCount: 1,
      sourceRecordIds: ["seed-src"],
    });
    __setOpenAskPipelineDepsForTest({
      semanticMatch: async () => ({ matchId: preexisting.id, confidence: 0.95 }),
    });
    const mergeRace = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        recordExtractedAsk(
          CLIENT_ID,
          { summary: `Reworded reference #${i} ${SUFFIX}`, type: i % 2 ? "internal_promise" : "client_ask", urgency: 1 },
          { sourceRecordId: `merge-race-src-${i}-${SUFFIX}` },
        ),
      ),
    );
    assert.equal(mergeRace.filter((r) => r.outcome === "merged").length, 5, "all five racers merged");
    const [mergeTarget] = (await listRows()).filter((r) => r.id === preexisting.id);
    assert.equal(mergeTarget.mentionCount, 6, "no mention lost: 1 seed + 5 concurrent merges");
    assert.equal(
      new Set(mergeTarget.sourceRecordIds ?? []).size,
      6,
      "no source record id lost across the concurrent merges",
    );
    assert.equal(
      (await listRows()).filter((r) => r.summary.includes("Reworded reference")).length,
      0,
      "no racer minted its own row",
    );

    // ── (2)+(3) Cross-type semantic merge + reopen ──────────────────
    const parked = await seedAsk({
      summary: `Deliver the intake-form redesign ${SUFFIX}`,
      status: "likely_resolved",
      likelyResolved: true,
      likelyResolvedAt: new Date(),
      concernScore: 9.8,
      sourceRecordIds: ["src-a"],
    });
    __setOpenAskPipelineDepsForTest({
      semanticMatch: async (_ask, existing) => {
        const hit = existing.find((e) => e.id === parked.id);
        return { matchId: hit ? parked.id : null, confidence: 0.95 };
      },
    });
    const mergedRes = await recordExtractedAsk(
      CLIENT_ID,
      { summary: `Finish redesigning the intake form ${SUFFIX}`, type: "internal_promise", urgency: 2 },
      { sourceRecordId: "src-b" },
    );
    assert.equal(mergedRes.outcome, "merged", "cross-type extraction merged instead of minting");
    assert.equal(mergedRes.ask.id, parked.id, "merged into the existing row");
    assert.equal(mergedRes.ask.status, "open", "re-referenced likely_resolved row reopens");
    assert.equal(mergedRes.ask.mentionCount, 2, "mentionCount incremented");
    assert.deepEqual([...(mergedRes.ask.sourceRecordIds ?? [])].sort(), ["src-a", "src-b"], "source ids union");
    assert.equal(mergedRes.ask.concernScore, 10, "concern bump capped at 10");
    const rowsAfterMerge = (await listRows()).filter((r) => r.summary.includes("intake"));
    assert.equal(rowsAfterMerge.length, 1, "no second intake row exists");

    // ── (4) Hindsight closure with evidence / evidence-gated ────────
    const answered = await seedAsk({
      summary: `Provide the March lead-source report ${SUFFIX}`,
      firstMentionedAt: new Date(Date.now() - 40 * DAY_MS),
      lastReferencedAt: new Date(Date.now() - 35 * DAY_MS),
    });
    __setOpenAskPipelineDepsForTest({
      semanticMatch: noMatch,
      evaluateClosure: async () => ({
        disposition: "resolved",
        evidence: {
          communicationId: "comm-evidence-123",
          answeredAt: "2026-07-20",
          quote: "Attached is the March lead-source report you asked for.",
        },
      }),
    });
    const disposition = await evaluateAndApplyAskClosure(answered);
    assert.equal(disposition, "resolved", "validated answer resolves");
    const [resolvedRow] = (await listRows()).filter((r) => r.id === answered.id);
    assert.equal(resolvedRow.status, "resolved", "END-TO-END: status=resolved is reachable");
    assert.ok(resolvedRow.resolutionNote?.includes("comm-evidence-123"), "evidence cites the communication");
    assert.ok(resolvedRow.resolutionNote?.includes("March lead-source report"), "evidence quote stored");
    assert.equal(resolvedRow.resolvedAt?.toISOString().slice(0, 10), "2026-07-20", "resolvedAt = answer date");
    assert.ok(resolvedRow.hindsightCheckedAt, "closure stamps the checkpoint");

    // Verdict without evidence must NOT close.
    const unproven = await seedAsk({ summary: `Fix the GBP listing hours ${SUFFIX}` });
    __setOpenAskPipelineDepsForTest({
      evaluateClosure: async () => ({ disposition: "resolved" }) as any,
    });
    const d2 = await evaluateAndApplyAskClosure(unproven);
    assert.equal(d2, "still_live", "resolved verdict without evidence degrades to still_live");
    const [unprovenRow] = (await listRows()).filter((r) => r.id === unproven.id);
    assert.equal(unprovenRow.status, "open", "row stays open without evidence");

    // ── (4b) FULL hindsight: resolving comm outside the most-recent page ──
    // Seed CLOSURE_EVAL_MAX_COMMS+1 communications; the OLDEST one carries
    // the answer. A recent-window-capped evaluator would never see it — the
    // paged walk must find it on the first (oldest) page.
    const deepAsk = await seedAsk({
      summary: `Deep-history answered ask ${SUFFIX}`,
      firstMentionedAt: new Date(Date.now() - 400 * DAY_MS),
      lastReferencedAt: new Date(Date.now() - 30 * DAY_MS),
    });
    const totalComms = CLOSURE_EVAL_MAX_COMMS + 1;
    const answerCommId = `t4765-comm-answer-${SUFFIX}`;
    const commValues = Array.from({ length: totalComms }, (_, i) => ({
      id: i === 0 ? answerCommId : `t4765-comm-${i}-${SUFFIX}`,
      clientId: CLIENT_ID,
      sourceType: "email",
      title: i === 0 ? "The answer" : `Filler comm ${i}`,
      contentText: i === 0 ? "Here is the deliverable you asked about — attached and done." : `noise ${i}`,
      timestamp: new Date(Date.now() - (390 - i) * DAY_MS),
    }));
    for (let i = 0; i < commValues.length; i += 100) {
      await db.insert(rawCommunicationRecords).values(commValues.slice(i, i + 100));
    }
    const evaluatedPages: string[][] = [];
    __setOpenAskPipelineDepsForTest({
      semanticMatch: noMatch,
      evaluateClosure: async (_ask, comms) => {
        evaluatedPages.push(comms.map((c) => c.id));
        const hit = comms.find((c) => c.id === answerCommId);
        if (hit) {
          return {
            disposition: "resolved",
            evidence: { communicationId: hit.id, answeredAt: "2025-07-25", quote: "attached and done" },
          };
        }
        return { disposition: "still_live" };
      },
    });
    const deepDisposition = await evaluateAndApplyAskClosure(deepAsk);
    assert.equal(deepDisposition, "resolved", "answer beyond the most-recent page is still found");
    assert.equal(evaluatedPages.length, 1, "oldest-first paging finds the answer on page 1");
    assert.equal(evaluatedPages[0].length, CLOSURE_EVAL_MAX_COMMS, "page is exactly the page size");
    assert.ok(evaluatedPages[0].includes(answerCommId), "the oldest comm is in the first page");
    const [deepRow] = (await listRows()).filter((r) => r.id === deepAsk.id);
    assert.equal(deepRow.status, "resolved", "deep-history ask resolved with evidence");
    assert.ok(deepRow.resolutionNote?.includes(answerCommId), "evidence cites the out-of-window comm");

    // Inverse: a genuinely unanswered ask must have EVERY page evaluated
    // (full history exhausted) before it is judged still-live and stamped.
    const deepOpen = await seedAsk({
      summary: `Deep-history still-open ask ${SUFFIX}`,
      firstMentionedAt: new Date(Date.now() - 400 * DAY_MS),
      lastReferencedAt: new Date(Date.now() - 30 * DAY_MS),
    });
    evaluatedPages.length = 0;
    __setOpenAskPipelineDepsForTest({
      evaluateClosure: async (_ask, comms) => {
        evaluatedPages.push(comms.map((c) => c.id));
        return { disposition: "still_live" };
      },
    });
    const deepOpenDisposition = await evaluateAndApplyAskClosure(deepOpen);
    assert.equal(deepOpenDisposition, "still_live", "unanswered deep-history ask stays live");
    assert.equal(evaluatedPages.length, 2, "both pages evaluated before judging still-live");
    assert.equal(
      evaluatedPages.flat().length,
      totalComms,
      "the COMPLETE history was considered — no communication skipped by the pager",
    );
    assert.equal(new Set(evaluatedPages.flat()).size, totalComms, "no comm double-counted across pages");

    // ── (5) Standing decay via the sweep ────────────────────────────
    const abandoned = await seedAsk({
      summary: `Old abandoned ask ${SUFFIX}`,
      firstMentionedAt: new Date(Date.now() - 300 * DAY_MS),
      lastReferencedAt: new Date(Date.now() - (DECAY_HORIZON_DAYS + 10) * DAY_MS),
    });
    __setOpenAskPipelineDepsForTest({
      semanticMatch: noMatch,
      evaluateClosure: async () => ({ disposition: "still_live" }),
    });
    const d3 = await evaluateAndApplyAskClosure(abandoned);
    assert.equal(d3, "archived", "never-answered, never-referenced ask decays");
    const [decayedRow] = (await listRows()).filter((r) => r.id === abandoned.id);
    assert.equal(decayedRow.status, "dismissed", "decay lands on an audited terminal status");
    assert.ok(decayedRow.resolutionNote?.includes("Auto-archived"), "decay disposition is audited");

    // ── (6) likely_resolved strand regression (deterministic backstop) ──
    const stranded = await seedAsk({
      summary: `Stranded likely-resolved ask ${SUFFIX}`,
      status: "likely_resolved",
      likelyResolved: true,
      likelyResolvedAt: new Date(Date.now() - (LIKELY_RESOLVED_CONFIRM_DAYS + 2) * DAY_MS),
    });
    const fresh = await seedAsk({
      summary: `Fresh likely-resolved ask ${SUFFIX}`,
      status: "likely_resolved",
      likelyResolved: true,
      likelyResolvedAt: new Date(),
    });
    const maint = await runOpenAskMaintenance(CLIENT_ID);
    assert.equal(maint.autoConfirmed >= 1, true, "maintenance auto-confirmed the stranded row");
    const rowsAfterMaint = await listRows();
    assert.equal(
      rowsAfterMaint.find((r) => r.id === stranded.id)?.status,
      "resolved",
      "REGRESSION: likely_resolved cannot strand past the confirm horizon",
    );
    assert.ok(
      rowsAfterMaint.find((r) => r.id === stranded.id)?.resolutionNote?.includes("Auto-confirmed"),
      "auto-confirm is audited",
    );
    assert.equal(
      rowsAfterMaint.find((r) => r.id === fresh.id)?.status,
      "likely_resolved",
      "a freshly-parked row is NOT prematurely confirmed",
    );

    // ── (7) Groom sweep dispositions + converging counters ──────────
    const dupA = await seedAsk({ summary: `Groom keeper ask ${SUFFIX}`, hindsightCheckedAt: new Date() });
    const dupB = await seedAsk({ summary: `Groom duplicate ask ${SUFFIX}`, mentionCount: 3, sourceRecordIds: ["g-src"] });
    const liveOne = await seedAsk({ summary: `Groom still-live ask ${SUFFIX}` });
    const errOne = await seedAsk({ summary: `Groom evaluator-error ask ${SUFFIX}` });
    __setOpenAskPipelineDepsForTest({
      semanticMatch: async (ask) =>
        ask.summary.includes("Groom duplicate")
          ? { matchId: dupA.id, confidence: 0.9 }
          : { matchId: null, confidence: 0 },
      evaluateClosure: async (ask) => {
        if (ask.id === errOne.id) throw new Error("synthetic evaluator outage");
        return { disposition: "still_live" };
      },
    });
    const pendingBefore = await countHindsightPending();
    assert.ok(pendingBefore >= 3, "pending counter sees unstamped sweepable rows");
    const clients = await listClientsWithHindsightPending(50);
    assert.ok(clients.includes(CLIENT_ID), "client with pending rows is listed for the drain");

    const counts = await sweepClientOpenAsks(CLIENT_ID);
    assert.equal(counts.merged >= 1, true, "duplicate merged during groom");
    assert.equal(counts.errors, 1, "evaluator outage tallied as error, not a disposition");
    const grooomed = await listRows();
    const dupBRow = grooomed.find((r) => r.id === dupB.id)!;
    assert.equal(dupBRow.status, "dismissed", "duplicate dismissed");
    assert.ok(dupBRow.resolutionNote?.includes(dupA.id), "merge disposition cites the keeper id");
    const dupARow = grooomed.find((r) => r.id === dupA.id)!;
    assert.equal(dupARow.mentionCount, 4, "keeper absorbed the duplicate's mentions");
    assert.ok((dupARow.sourceRecordIds ?? []).includes("g-src"), "keeper absorbed the duplicate's sources");
    assert.ok(grooomed.find((r) => r.id === liveOne.id)?.hindsightCheckedAt, "still-live row stamped");
    assert.equal(
      grooomed.find((r) => r.id === errOne.id)?.hindsightCheckedAt,
      null,
      "errored row stays unstamped — retryable, never silently closed",
    );

    // Re-sweep converges: only the errored row remains pending for this client.
    __setOpenAskPipelineDepsForTest({
      semanticMatch: noMatch,
      evaluateClosure: async () => ({ disposition: "still_live" }),
    });
    const counts2 = await sweepClientOpenAsks(CLIENT_ID);
    assert.equal(counts2.evaluated, 1, "resume picks up exactly the previously-errored row");
    const pendingAfter = await getDb()
      .select()
      .from(clientOpenAsks)
      .where(
        and(eq(clientOpenAsks.clientId, CLIENT_ID), sql`${clientOpenAsks.hindsightCheckedAt} IS NULL`),
      );
    assert.equal(
      pendingAfter.filter((r) => ["open", "likely_open", "likely_resolved"].includes(r.status)).length,
      0,
      "groom converges: zero sweepable rows left unstamped",
    );

    // (8) Task #4776 — mechanical evidence gate on the RAW model verdict
    // (validateClosureEvidence is the exact gate defaultEvaluateClosure
    // applies; injected-deps tests above bypass it, so pin it directly).
    {
      const gateComms = [{ id: "comm-1", content: "Sure — the\n  report was  sent yesterday." }];
      // Whitespace-only quote must NOT close (normalizes to "", which every
      // string trivially contains).
      assert.deepEqual(
        validateClosureEvidence(
          { disposition: "resolved", communicationId: "comm-1", quote: " \t\n" },
          gateComms,
        ),
        { disposition: "still_live" },
        "whitespace-only quote downgrades to still_live",
      );
      // Formatting-only whitespace differences in a genuine verbatim quote
      // are accepted.
      const ok = validateClosureEvidence(
        {
          disposition: "resolved",
          communicationId: "comm-1",
          answeredAt: "2026-08-01",
          quote: "the report was sent yesterday.",
        },
        gateComms,
      );
      assert.equal(ok.disposition, "resolved", "whitespace-normalized verbatim quote accepted");
      assert.equal(ok.evidence?.communicationId, "comm-1");
      // A quote not present in the cited communication is fabricated
      // evidence — rejected.
      assert.deepEqual(
        validateClosureEvidence(
          { disposition: "resolved", communicationId: "comm-1", quote: "we cancelled the report" },
          gateComms,
        ),
        { disposition: "still_live" },
        "non-verbatim quote downgrades to still_live",
      );
      // Out-of-corpus communication id — rejected.
      assert.deepEqual(
        validateClosureEvidence(
          { disposition: "resolved", communicationId: "comm-404", quote: "the report was sent" },
          gateComms,
        ),
        { disposition: "still_live" },
        "out-of-corpus comm id downgrades to still_live",
      );
      // Truncation alignment: the model only ever sees the first
      // CLOSURE_MODEL_VISIBLE_CHARS of each communication, so a quote that
      // exists ONLY beyond that cutoff was never model-visible — accepting
      // it would bless hallucinated evidence that coincidentally matches
      // unseen text. The gate must check the SAME window the prompt sends.
      {
        const tail = "the deliverable was sent and confirmed received";
        const longComms = [
          { id: "comm-long", content: "x".repeat(CLOSURE_MODEL_VISIBLE_CHARS) + " " + tail },
        ];
        assert.deepEqual(
          validateClosureEvidence(
            { disposition: "resolved", communicationId: "comm-long", quote: tail },
            longComms,
          ),
          { disposition: "still_live" },
          "quote existing only after the model-visible cutoff downgrades to still_live",
        );
        // Positive control: the same quote INSIDE the visible window closes.
        const inWindow = validateClosureEvidence(
          { disposition: "resolved", communicationId: "comm-long2", quote: tail },
          [{ id: "comm-long2", content: tail + " " + "y".repeat(CLOSURE_MODEL_VISIBLE_CHARS) }],
        );
        assert.equal(
          inWindow.disposition,
          "resolved",
          "same quote inside the visible window is accepted",
        );
      }
    }

    console.log("Open-ask pipeline tests passed.");
  } finally {
    __resetOpenAskPipelineDepsForTest();
    await getDb().execute(sql`DELETE FROM raw_communication_records WHERE client_id = ${CLIENT_ID}`);
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
