/* test-registration
{
  "name": "Zoom Match Assistant AI guess service — parse, persist, skip/force semantics (Task #4057)",
  "regression": true,
  "sweepOnlyReason": "Isolated-schema coverage of the AI match-guess analyzer internals (prompt/roster construction, reply parsing, upsert + attempt accounting, skip/force rules) with a stubbed model. The gate-visible smoke coverage for the feature's routes lives in zoom-match-assistant-routes.test.ts; this file runs in the full suite and nightly regression sweep.",
  "tier": "small"
}
test-registration */
/**
 * Task #4057 — Zoom Transcript Match Assistant: AI guess service.
 *
 * What this locks in:
 *
 *  A. parseZoomMatchGuessReply: strict-JSON contract — unknown client ids
 *     degrade to null (noted in rationale, never invented), confidence
 *     clamps to [0,1], names dedupe case-insensitively and cap, non-JSON
 *     throws (→ retryable failed).
 *  B. buildTranscriptExcerpt / buildZoomMatchGuessPrompt: head+tail
 *     truncation; roster excludes archived+demo clients; the
 *     existing-summary flag flips the summary instruction (no re-billing).
 *  C. processZoomMatchGuessRecord: fresh analyze persists a full analysis
 *     row + bumps sweep counters; already-analyzed skips WITHOUT a model
 *     call; force re-bills and increments attempts; existing aiSummary is
 *     reused verbatim (summarySource='existing'); ANY existing client
 *     match (manual or auto, regardless of confidence) skips — the
 *     assistant only guesses for unmatched calls — as do
 *     transcript-less/missing/non-zoom records; garbage
 *     replies persist a failed row and exhaust after MAX attempts.
 */

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

const {
  parseZoomMatchGuessReply,
  buildTranscriptExcerpt,
  buildZoomMatchGuessPrompt,
  processZoomMatchGuessRecord,
  ZOOM_MATCH_GUESS_MAX_ATTEMPTS,
} = await import("../server/services/zoomTranscriptMatchAssistant");
type GuessDeps = import("../server/services/zoomTranscriptMatchAssistant").ZoomMatchGuessDeps;
const { runInIsolatedSchema } = await import("./db-sandbox");

let passed = 0;
let failed = 0;

function assert(cond: unknown, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

const TAG = `zmg-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`;

// ── A. Pure: reply parsing ─────────────────────────────────────────────────

function testParsing(): void {
  console.log("A. parseZoomMatchGuessReply");
  const valid = new Set(["c-1", "c-2"]);

  const ok = parseZoomMatchGuessReply(
    JSON.stringify({
      guessed_client_id: "c-1",
      confidence: 0.85,
      rationale: "Firm named twice",
      names: ["Alice Smith", "alice smith", "Bob Jones"],
      summary: "Monthly SEO review.",
    }),
    valid,
  );
  assert(ok.guessedClientId === "c-1", "valid roster id passes through");
  assert(ok.confidence === 0.85, "confidence preserved");
  assert(
    ok.names.length === 2 && ok.names[0] === "Alice Smith" && ok.names[1] === "Bob Jones",
    "names dedupe case-insensitively, first casing wins",
  );
  assert(ok.summary === "Monthly SEO review.", "summary preserved");

  const unknown = parseZoomMatchGuessReply(
    JSON.stringify({ guessed_client_id: "c-999", confidence: 0.9, rationale: "sure", names: [] }),
    valid,
  );
  assert(unknown.guessedClientId === null, "unknown client id cleared to null (never invented)");
  assert(unknown.rationale.includes("unknown client id"), "substitution noted in rationale");

  const clampHi = parseZoomMatchGuessReply(
    JSON.stringify({ guessed_client_id: "c-2", confidence: 7, rationale: "", names: [] }),
    valid,
  );
  assert(clampHi.confidence === 1, "confidence clamps to 1");
  const clampLo = parseZoomMatchGuessReply(
    JSON.stringify({ guessed_client_id: "c-2", confidence: -3, rationale: "", names: [] }),
    valid,
  );
  assert(clampLo.confidence === 0, "confidence clamps to 0");
  const nanConf = parseZoomMatchGuessReply(
    JSON.stringify({ guessed_client_id: null, rationale: "internal call", names: ["Zed"] }),
    valid,
  );
  assert(nanConf.guessedClientId === null && nanConf.confidence === 0, "null guess + missing confidence → 0");
  assert(nanConf.summary === null, "missing summary → null");

  const many = parseZoomMatchGuessReply(
    JSON.stringify({
      guessed_client_id: null,
      confidence: 0,
      rationale: "",
      names: Array.from({ length: 80 }, (_, i) => `Person ${i}`),
    }),
    valid,
  );
  assert(many.names.length === 40, "names cap at 40");

  let threw = false;
  try {
    parseZoomMatchGuessReply("this is not json", valid);
  } catch {
    threw = true;
  }
  assert(threw, "non-JSON reply throws (caller records retryable failure)");

  let threwArr = false;
  try {
    parseZoomMatchGuessReply("[1,2,3]", valid);
  } catch {
    threwArr = true;
  }
  // Arrays are objects in JS — the guard accepts them but every field
  // degrades safely; the important contract is scalars/garbage throw.
  assert(threwArr === false, "array reply degrades to empty guess rather than crashing the classifier");
}

// ── B. Pure: excerpt + prompt ──────────────────────────────────────────────

function testPrompt(): void {
  console.log("B. buildTranscriptExcerpt / buildZoomMatchGuessPrompt");

  const short = buildTranscriptExcerpt("hello world");
  assert(short === "hello world", "short transcript passes through untruncated");

  const long = "H".repeat(12_000) + "M".repeat(5_000) + "T".repeat(2_000);
  const excerpt = buildTranscriptExcerpt(long);
  assert(
    excerpt.startsWith("H".repeat(100)) && excerpt.endsWith("T".repeat(100)),
    "long transcript keeps head and tail",
  );
  assert(excerpt.includes("[… transcript truncated …]"), "truncation marker present");
  assert(!excerpt.includes("M".repeat(3_001)), "middle dropped");

  const roster = [
    {
      id: "c-1",
      firmName: "Acme Dental",
      contactName: "Alice Smith",
      contactEmail: "alice@acmedental.com",
      emailDomains: ["acmedental.com"],
      contacts: [{ name: "Carl Contact", emails: ["carl@acmedental.com"] }],
    },
  ];

  const fresh = buildZoomMatchGuessPrompt({
    topic: "Kickoff",
    dateStr: "2026-08-01",
    durationMin: 45,
    participants: [{ name: "Alice Smith", email: "alice@acmedental.com" }],
    transcriptExcerpt: "TRANSCRIPT BODY HERE",
    roster,
    existingSummary: null,
  });
  assert(fresh.system.includes("c-1 | Acme Dental"), "roster line carries id + firm");
  assert(fresh.system.includes("acmedental.com"), "roster line carries domains");
  assert(fresh.system.includes("Carl Contact"), "roster line carries key contacts");
  assert(fresh.system.includes("2–3 sentences"), "no existing summary → model asked to write one");
  assert(fresh.user.includes("TRANSCRIPT BODY HERE"), "user prompt carries the transcript");
  assert(fresh.user.includes("about 45 minutes"), "user prompt carries duration");

  const reuse = buildZoomMatchGuessPrompt({
    topic: "Kickoff",
    dateStr: "2026-08-01",
    durationMin: null,
    participants: [],
    transcriptExcerpt: "T",
    roster,
    existingSummary: "We already summarized this.",
  });
  assert(reuse.system.includes("a summary already exists"), "existing summary → model told NOT to write one");
  assert(reuse.user.includes("We already summarized this."), "existing summary included as context");
}

// ── C. DB-backed analyzer ──────────────────────────────────────────────────

async function main(): Promise<void> {
  testParsing();
  testPrompt();

  await runInIsolatedSchema(
    async ({ db }) => {
      console.log("C. processZoomMatchGuessRecord");
      const rows = (r: any) => (Array.isArray(r) ? r : r.rows);

      const ins = async (q: any) => rows(await db.execute(q))[0];
      const clientX = (
        await ins(sql`
          INSERT INTO clients (firm_name, contact_name, contact_email, email_domains)
          VALUES (${`Acme Dental ${TAG}`}, 'Alice Smith', 'alice@acmedental.com', ARRAY['acmedental.com']::text[])
          RETURNING id
        `)
      ).id;
      const clientY = (
        await ins(sql`INSERT INTO clients (firm_name) VALUES (${`Beta Law ${TAG}`}) RETURNING id`)
      ).id;
      const archivedZ = (
        await ins(sql`
          INSERT INTO clients (firm_name, is_archived) VALUES (${`Archived Co ${TAG}`}, true) RETURNING id
        `)
      ).id;
      const demoW = (
        await ins(sql`
          INSERT INTO clients (firm_name, is_demo) VALUES (${`Demo Co ${TAG}`}, true) RETURNING id
        `)
      ).id;
      await db.execute(sql`
        INSERT INTO client_contacts (client_id, name, emails)
        VALUES (${clientX}, 'Carl Contact', ARRAY['carl@acmedental.com']::text[])
      `);

      const sweepId = (
        await ins(sql`
          INSERT INTO zoom_match_sweeps (status, phase, window_start, window_end, windows_json, counters_json, phase_state_json)
          VALUES ('completed', 'done', NOW() - interval '365 days', NOW(), '[]'::jsonb, '{}'::jsonb, '{}'::jsonb)
          RETURNING id
        `)
      ).id;

      const mkRecord = async (fields: {
        contentText?: string | null;
        aiSummary?: string | null;
        sourceType?: string;
        clientId?: string | null;
        matchMethod?: string | null;
        matchConfidence?: number | null;
        participants?: any[] | null;
      }): Promise<string> => {
        const id = randomUUID();
        await db.execute(sql`
          INSERT INTO raw_communication_records
            (id, source_type, title, timestamp, content_text, ai_summary, client_id,
             match_method, match_confidence, participants_json, raw_payload_json)
          VALUES
            (${id}, ${fields.sourceType ?? "zoom"}, ${`ZMG ${TAG} call`}, NOW() - interval '10 days',
             ${fields.contentText === undefined ? "Alice: let's review the Acme campaign." : fields.contentText},
             ${fields.aiSummary ?? null}, ${fields.clientId ?? null},
             ${fields.matchMethod ?? null}, ${fields.matchConfidence ?? null},
             ${fields.participants ? JSON.stringify(fields.participants) : null}::jsonb,
             ${JSON.stringify({ duration: 30 })}::jsonb)
        `);
        return id;
      };

      const getAnalysis = async (recordId: string) =>
        rows(
          await db.execute(sql`
            SELECT * FROM zoom_transcript_match_analyses WHERE record_id = ${recordId}
          `),
        )[0];
      const getCounters = async () =>
        rows(await db.execute(sql`SELECT counters_json FROM zoom_match_sweeps WHERE id = ${sweepId}`))[0]
          .counters_json;

      // Scriptable model.
      let modelCalls = 0;
      let lastPrompt: { system: string; user: string } | null = null;
      let nextReply: () => string = () => "{}";
      const deps: GuessDeps = {
        callModel: async (input) => {
          modelCalls++;
          lastPrompt = input;
          return { raw: nextReply(), model: "stub-model" };
        },
        now: () => new Date(),
      };

      // ── Fresh analyze persists everything ───────────────────────────────
      const recA = await mkRecord({
        participants: [{ name: "Alice Smith", email: "alice@acmedental.com" }, { name: "Dana Doe" }],
      });
      nextReply = () =>
        JSON.stringify({
          guessed_client_id: clientX,
          confidence: 0.85,
          rationale: "Alice is Acme's contact and the campaign is named.",
          names: ["Alice Smith", "Bob Jones"],
          summary: "Reviewed the Acme campaign performance.",
        });
      const outA = await processZoomMatchGuessRecord(recA, deps, { sweepId });
      assert(outA === "analyzed", `fresh record analyzes (got ${outA})`);
      const rowA = await getAnalysis(recA);
      assert(rowA?.status === "analyzed", "analysis row persisted with status=analyzed");
      assert(rowA.guessed_client_id === clientX, "guessed client persisted");
      assert(Math.abs(Number(rowA.confidence) - 0.85) < 1e-6, "confidence persisted");
      assert(rowA.summary_source === "generated", "no prior summary → summarySource=generated");
      assert(rowA.call_summary === "Reviewed the Acme campaign performance.", "generated summary persisted");
      assert(rowA.model === "stub-model", "model recorded");
      assert(Number(rowA.attempts) === 1, "attempts=1 after first call");
      assert(rowA.sweep_id === sweepId, "sweep linkage recorded");
      const namesA: string[] = rowA.names_json;
      assert(
        namesA.includes("Alice Smith") && namesA.includes("Bob Jones") && namesA.includes("Dana Doe"),
        "names merge model output with Zoom participants (model omissions recovered)",
      );
      assert(lastPrompt!.system.includes(`Acme Dental ${TAG}`), "roster includes active client");
      assert(lastPrompt!.system.includes(`Beta Law ${TAG}`), "roster includes second active client");
      assert(!lastPrompt!.system.includes(`Archived Co ${TAG}`), "archived client excluded from roster");
      assert(!lastPrompt!.system.includes(`Demo Co ${TAG}`), "demo client excluded from roster");
      assert((await getCounters()).callsAnalyzed === 1, "sweep counter callsAnalyzed bumped");

      // ── Skip already-analyzed (no re-bill) / force re-bills ─────────────
      const callsBefore = modelCalls;
      const outSkip = await processZoomMatchGuessRecord(recA, deps, { sweepId });
      assert(outSkip === "skipped_already_analyzed", "second run skips already-analyzed");
      assert(modelCalls === callsBefore, "skip does NOT call the model (no re-billing)");
      assert((await getCounters()).analysesSkipped === 1, "sweep counter analysesSkipped bumped");

      const outForce = await processZoomMatchGuessRecord(recA, deps, { force: true, sweepId: null });
      assert(outForce === "analyzed", "force re-analyzes");
      assert(modelCalls === callsBefore + 1, "force calls the model again");
      const rowA2 = await getAnalysis(recA);
      assert(Number(rowA2.attempts) === 2, "attempts increments on forced re-run");
      assert((await getCounters()).callsAnalyzed === 1, "forced run outside a sweep does not bump sweep counters");

      // ── Existing aiSummary reused verbatim ───────────────────────────────
      const recB = await mkRecord({ aiSummary: "  Pre-existing summary.  " });
      nextReply = () =>
        JSON.stringify({
          guessed_client_id: clientY,
          confidence: 0.5,
          rationale: "r",
          names: [],
          summary: "model tried to write a new one",
        });
      const outB = await processZoomMatchGuessRecord(recB, deps, { sweepId });
      assert(outB === "analyzed", "record with existing summary analyzes");
      const rowB = await getAnalysis(recB);
      assert(rowB.call_summary === "Pre-existing summary.", "existing aiSummary reused verbatim (trimmed)");
      assert(rowB.summary_source === "existing", "summarySource=existing");
      assert(lastPrompt!.system.includes("a summary already exists"), "prompt told the model to skip the summary");

      // ── Skip rules ───────────────────────────────────────────────────────
      const recManual = await mkRecord({ clientId: clientX, matchMethod: "manual", matchConfidence: 1.0 });
      assert(
        (await processZoomMatchGuessRecord(recManual, deps, { sweepId })) === "skipped_already_matched",
        "manual match skips",
      );
      const recConf = await mkRecord({
        clientId: clientY,
        matchMethod: "domain",
        matchConfidence: 0.9,
      });
      assert(
        (await processZoomMatchGuessRecord(recConf, deps, { sweepId })) === "skipped_already_matched",
        "high-confidence auto match skips",
      );
      // The assistant sweeps ONLY unmatched calls: even a low-confidence auto
      // match means the call already has a client — never analyzed, no model call.
      const recLow = await mkRecord({ clientId: clientY, matchMethod: "keyword", matchConfidence: 0.3 });
      const callsBeforeLow = modelCalls;
      assert(
        (await processZoomMatchGuessRecord(recLow, deps, { sweepId })) === "skipped_already_matched",
        "low-confidence auto match ALSO skips — any client assignment excludes the call",
      );
      assert(modelCalls === callsBeforeLow, "matched calls never reach the model");
      const recEmpty = await mkRecord({ contentText: "   " });
      assert(
        (await processZoomMatchGuessRecord(recEmpty, deps, { sweepId })) === "skipped_no_transcript",
        "whitespace-only transcript skips",
      );
      const recFront = await mkRecord({ sourceType: "front_email" });
      assert(
        (await processZoomMatchGuessRecord(recFront, deps, { sweepId })) === "skipped_not_zoom",
        "non-zoom record skips",
      );
      assert(
        (await processZoomMatchGuessRecord(randomUUID(), deps, { sweepId })) === "skipped_missing",
        "unknown record id skips",
      );

      // ── Failure + exhaustion ─────────────────────────────────────────────
      const recBad = await mkRecord({});
      nextReply = () => "MODEL MELTDOWN not json";
      const failedBefore = (await getCounters()).analysesFailed ?? 0;
      const outFail = await processZoomMatchGuessRecord(recBad, deps, { sweepId });
      assert(outFail === "failed", "garbage reply → failed");
      let rowBad = await getAnalysis(recBad);
      assert(rowBad.status === "failed" && String(rowBad.error).includes("not valid JSON"), "failed row carries the parse error");
      assert(Number(rowBad.attempts) === 1, "failed attempt counted");
      assert((await getCounters()).analysesFailed === failedBefore + 1, "sweep counter analysesFailed bumped");

      const outRetry = await processZoomMatchGuessRecord(recBad, deps, { sweepId });
      assert(outRetry === "failed", "failed row below the attempt cap retries");
      rowBad = await getAnalysis(recBad);
      assert(Number(rowBad.attempts) === 2, "retry increments attempts");

      await db.execute(sql`
        UPDATE zoom_transcript_match_analyses
        SET attempts = ${ZOOM_MATCH_GUESS_MAX_ATTEMPTS}
        WHERE record_id = ${recBad}
      `);
      assert(
        (await processZoomMatchGuessRecord(recBad, deps, { sweepId })) === "skipped_exhausted",
        `failed row at ${ZOOM_MATCH_GUESS_MAX_ATTEMPTS} attempts is exhausted`,
      );
      const exhaustedCalls = modelCalls;
      await processZoomMatchGuessRecord(recBad, deps, { sweepId });
      assert(modelCalls === exhaustedCalls, "exhausted rows never call the model");

      // Unknown-id reply degrades to null guess.
      const recUnknown = await mkRecord({});
      nextReply = () =>
        JSON.stringify({ guessed_client_id: "not-a-real-id", confidence: 0.9, rationale: "hmm", names: [] });
      const outU = await processZoomMatchGuessRecord(recUnknown, deps, { sweepId });
      assert(outU === "analyzed", "unknown-id reply still lands as analyzed");
      const rowU = await getAnalysis(recUnknown);
      assert(rowU.guessed_client_id === null, "unknown id persisted as null guess");
      assert(String(rowU.rationale).includes("unknown client id"), "rationale notes the cleared id");

      // Silence unused-var lint for ids used only via roster assertions.
      void archivedZ;
      void demoW;
    },
    {
      tables: [
        "users",
        "clients",
        "client_contacts",
        "raw_communication_records",
        "zoom_match_sweeps",
        "zoom_transcript_match_analyses",
      ],
    },
  );

  console.log(`\nTest run: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Test crashed:", err);
    process.exit(1);
  });
