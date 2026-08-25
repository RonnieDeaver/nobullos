// @db-pool-intent: worker
//
// Task #3692 — Churn Risk Radar agent sweep.
//
// On-demand portfolio-wide churn interview: for every active client, ask
// the centralized quality model (via each client's agent context) for the
// top-5 reasons that client might churn, then synthesize the answers into
// one rank-ordered portfolio view (clients by churn likelihood, themes by
// portfolio impact).
//
// Conventions follow server/services/dailyJudgment.ts (the sibling heavy
// AI background writer):
//   - `db` aliases `workerDb` directly; entry points wrap themselves in
//     `runWithWorkerDb` + `withDbAttribution` so `storage.*` calls inherit
//     the worker pool even when invoked from an API route handler.
//   - OpenAI client + model call shape (QUALITY_MODEL, response_format
//     json_object, max_completion_tokens, NO temperature) match the GPT-5
//     parameter contract documented in server/aiModels.ts (verified against
//     OpenAI docs 2026-06-16) and OPENAI.md.
//   - Cross-instance singleton lock (Task #2363/#2383 pattern) so autoscale
//     instances can't double-run a sweep; the hold is bounded by
//     CROSS_INSTANCE_LOCK_MAX_HOLD_MS.churn_risk_radar.
//
// Failure containment: a per-client interview failure records an `error`
// client-result row and the sweep continues; only a run-level fault (e.g.
// the run row disappearing) marks the run `failed`. Clients with too little
// data are recorded `insufficient_data` — reasons are never fabricated.
import { createDefaultOpenAiClient } from "./ai/openAiClient";
import { QUALITY_MODEL } from "../aiModels";
import { workerDb as db, runWithWorkerDb, withDbAttribution } from "../db";
import { storage } from "../storage";
import {
  churnRadarRuns,
  churnRadarClientResults,
  churnRadarFindings,
  churnRadarActiveRunStatuses,
  churnRadarSeverities,
  churnRadarLikelihoodBands,
  churnRadarThemeCategories,
  churnRadarThemeLabels,
  type ChurnRadarRun,
  type ChurnRadarClientResult,
  type ChurnRadarFinding,
  type ChurnRadarClientStatus,
  type ChurnRadarSeverity,
  type ChurnRadarLikelihoodBand,
  type ChurnRadarThemeCategory,
  type ChurnRadarTheme,
  type ChurnRadarSynthesis,
  type Client,
  isActiveAskStatus,
} from "@shared/schema";
import { desc, eq, inArray, sql } from "drizzle-orm";
import { getClientContext, formatContextForPrompt } from "./contextRetrieval";
import { acquireWorkerSingletonLock } from "./crossInstanceLock";
import { CROSS_INSTANCE_LOCK_MAX_HOLD_MS } from "./workerConfig";
import { workerLog } from "./workerLogger";
import { notifyUser } from "./notifications/userInbox";

// Exported so tests can stub `.chat.completions.create` on the shared
// instance (ESM named bindings are read-only but the object is mutable —
// same seam tests/ceo-pulse-refine-*.test.ts use on routes/middleware's
// singleton).
export const churnRadarOpenAI = createDefaultOpenAiClient();

const MODEL_VERSION = QUALITY_MODEL;
const LOCK_KEY = "churn-risk-radar-sweep";
const LOG_PREFIX = "[ChurnRadar]";
/** Bounded interview concurrency (model + storage reads per client). */
const DEFAULT_CONCURRENCY = 3;
const MAX_REASONS = 5;

type SweepClient = Pick<Client, "id" | "firmName"> & Partial<Pick<Client, "clientCode">>;

// ── Start / conflict / resume ───────────────────────────────────────────────

export interface StartSweepResult {
  outcome: "started" | "resumed" | "already_running";
  run: ChurnRadarRun | null;
}

/**
 * Start a new sweep, resume a stranded active run (a previous holder
 * crashed mid-run — its client results are kept and skipped), or report
 * the conflict when another instance is actively sweeping.
 *
 * The cluster-wide singleton lock is acquired HERE and handed to the
 * background executor, which releases it when the run finishes — so a
 * re-press while a sweep is running always lands in `already_running`.
 */
export async function startChurnRadarSweep(requestedBy: string): Promise<StartSweepResult> {
  return runWithWorkerDb(() =>
    withDbAttribution("worker:churn-radar-start", async () => {
      const lock = await acquireWorkerSingletonLock(LOCK_KEY, LOG_PREFIX, {
        maxHoldMs: CROSS_INSTANCE_LOCK_MAX_HOLD_MS.churn_risk_radar,
        onWatchdog: (info) =>
          workerLog({
            worker: "churn_risk_radar",
            event: "worker_lock_watchdog_fired",
            lockAge: info.heldMs,
            maxHoldMs: info.maxHoldMs,
          }),
      });
      if (!lock) {
        return { outcome: "already_running" as const, run: await findActiveRun() };
      }

      let run: ChurnRadarRun;
      let resumed = false;
      try {
        const active = await findActiveRun();
        if (active) {
          // Previous holder died (lock self-healed) — resume its run.
          run = active;
          resumed = true;
          console.log(`${LOG_PREFIX} Resuming stranded run ${run.id} (status=${run.status})`);
        } else {
          const [created] = await db
            .insert(churnRadarRuns)
            .values({ status: "running", requestedBy, modelVersion: MODEL_VERSION })
            .returning();
          run = created;
        }
      } catch (err) {
        await lock.release().catch(() => {});
        throw err;
      }

      runSweepInBackground(run.id, lock);
      return { outcome: resumed ? ("resumed" as const) : ("started" as const), run };
    }),
  );
}

async function findActiveRun(): Promise<ChurnRadarRun | null> {
  const rows = await db
    .select()
    .from(churnRadarRuns)
    .where(inArray(churnRadarRuns.status, [...churnRadarActiveRunStatuses]))
    .orderBy(desc(churnRadarRuns.startedAt))
    .limit(1);
  return rows[0] ?? null;
}

// In-flight background sweeps, drainable by tests (fire-and-forget async
// must be awaitable in tests — see TASK_PREFLIGHT § 4 rule 5).
const inFlightSweeps = new Set<Promise<void>>();

function runSweepInBackground(runId: string, lock: { release: () => Promise<void> }): void {
  const p = (async () => {
    try {
      await executeChurnRadarSweep(runId);
    } catch (err: any) {
      // executeChurnRadarSweep marks the run failed itself; this catch only
      // guards the marking path itself blowing up.
      console.error(`${LOG_PREFIX} Background sweep ${runId} crashed:`, err?.message ?? err);
    } finally {
      await lock.release().catch((err: any) =>
        console.error(`${LOG_PREFIX} Failed to release sweep lock:`, err?.message ?? err),
      );
    }
  })();
  inFlightSweeps.add(p);
  void p.finally(() => inFlightSweeps.delete(p));
}

/** Test seam: await every background sweep kicked off by startChurnRadarSweep. */
export async function __testDrainChurnRadarSweeps(): Promise<void> {
  while (inFlightSweeps.size > 0) {
    await Promise.allSettled([...inFlightSweeps]);
  }
}

// ── Sweep orchestrator ──────────────────────────────────────────────────────

export interface ExecuteSweepOptions {
  /** Override the client set (tests / future subset sweeps). Defaults to all active clients. */
  clients?: SweepClient[];
  /** Bounded interview concurrency; clamped to 1..8. */
  concurrency?: number;
}

/**
 * Run (or resume) the per-client interview pass + portfolio synthesis for
 * a run row. Idempotent per client: a client that already has a result row
 * in this run is skipped, and result inserts are ON CONFLICT DO NOTHING.
 */
export async function executeChurnRadarSweep(
  runId: string,
  opts: ExecuteSweepOptions = {},
): Promise<ChurnRadarRun> {
  return runWithWorkerDb(() =>
    withDbAttribution("worker:churn-radar-sweep", () => executeSweepImpl(runId, opts)),
  );
}

async function executeSweepImpl(runId: string, opts: ExecuteSweepOptions): Promise<ChurnRadarRun> {
  const [run] = await db.select().from(churnRadarRuns).where(eq(churnRadarRuns.id, runId));
  if (!run) throw new Error(`Churn radar run ${runId} not found`);
  if (run.status === "completed" || run.status === "failed") return run;

  try {
    const clients: SweepClient[] = opts.clients ?? (await storage.getActiveClients());

    // Idempotent resume: skip clients that already have an outcome row,
    // and rebuild the progress counters from those rows.
    const existing = await db
      .select({ clientId: churnRadarClientResults.clientId, status: churnRadarClientResults.status })
      .from(churnRadarClientResults)
      .where(eq(churnRadarClientResults.runId, runId));
    const processedIds = new Set(existing.map((r) => r.clientId));
    const remaining = clients.filter((c) => !processedIds.has(c.id));
    const totalClients = processedIds.size + remaining.length;

    await db
      .update(churnRadarRuns)
      .set({
        status: "running",
        totalClients,
        processedClients: existing.length,
        analyzedClients: existing.filter((r) => r.status === "analyzed").length,
        insufficientClients: existing.filter((r) => r.status === "insufficient_data").length,
        errorClients: existing.filter((r) => r.status === "error").length,
        updatedAt: new Date(),
      })
      .where(eq(churnRadarRuns.id, runId));

    const concurrency = Math.max(1, Math.min(opts.concurrency ?? DEFAULT_CONCURRENCY, 8));
    let nextIdx = 0;
    const workers = Array.from({ length: Math.min(concurrency, remaining.length) }, async () => {
      while (true) {
        const idx = nextIdx++;
        if (idx >= remaining.length) break;
        const client = remaining[idx];
        let bucket: ChurnRadarClientStatus | null;
        try {
          bucket = await interviewClientForRun(runId, client);
        } catch (err: any) {
          // Per-client error isolation: record and move on.
          console.error(`${LOG_PREFIX} Interview failed for ${client.firmName} (${client.id}):`, err?.message ?? err);
          bucket = await recordClientResult(runId, client, {
            status: "error",
            errorMessage: truncate(String(err?.message ?? err), 500),
          });
        }
        if (bucket) await bumpRunProgress(runId, bucket);
      }
    });
    await Promise.all(workers);

    // Portfolio synthesis (deterministic — no second AI pass).
    await db
      .update(churnRadarRuns)
      .set({ status: "synthesizing", updatedAt: new Date() })
      .where(eq(churnRadarRuns.id, runId));

    const results = await db
      .select()
      .from(churnRadarClientResults)
      .where(eq(churnRadarClientResults.runId, runId));
    const findings = await db
      .select()
      .from(churnRadarFindings)
      .where(eq(churnRadarFindings.runId, runId));
    const synthesis: ChurnRadarSynthesis = {
      themes: buildChurnRadarThemes(results, findings),
      generatedAt: new Date().toISOString(),
    };

    const [completed] = await db
      .update(churnRadarRuns)
      .set({ status: "completed", synthesisJson: synthesis, finishedAt: new Date(), updatedAt: new Date() })
      .where(eq(churnRadarRuns.id, runId))
      .returning();

    await notifyRequester(completed, results);
    console.log(
      `${LOG_PREFIX} Run ${runId} completed: ${completed.analyzedClients} analyzed, ` +
        `${completed.insufficientClients} insufficient, ${completed.errorClients} errors of ${completed.totalClients}`,
    );
    return completed;
  } catch (err: any) {
    console.error(`${LOG_PREFIX} Run ${runId} failed:`, err?.message ?? err);
    const [failed] = await db
      .update(churnRadarRuns)
      .set({
        status: "failed",
        errorSummary: truncate(String(err?.message ?? err), 1000),
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(churnRadarRuns.id, runId))
      .returning();
    if (failed) await notifyRequester(failed, null);
    return failed ?? { ...run, status: "failed" };
  }
}

async function bumpRunProgress(runId: string, bucket: ChurnRadarClientStatus): Promise<void> {
  await db
    .update(churnRadarRuns)
    .set({
      processedClients: sql`${churnRadarRuns.processedClients} + 1`,
      updatedAt: new Date(),
      ...(bucket === "analyzed"
        ? { analyzedClients: sql`${churnRadarRuns.analyzedClients} + 1` }
        : bucket === "insufficient_data"
          ? { insufficientClients: sql`${churnRadarRuns.insufficientClients} + 1` }
          : { errorClients: sql`${churnRadarRuns.errorClients} + 1` }),
    })
    .where(eq(churnRadarRuns.id, runId));
}

/**
 * Insert the client's outcome row. Returns the recorded status, or null
 * when another worker already recorded this client (resume race) — in
 * which case the caller must NOT bump progress counters.
 */
async function recordClientResult(
  runId: string,
  client: SweepClient,
  outcome: {
    status: ChurnRadarClientStatus;
    churnLikelihood?: number | null;
    likelihoodBand?: ChurnRadarLikelihoodBand | null;
    summary?: string | null;
    insufficiencyReason?: string | null;
    errorMessage?: string | null;
  },
): Promise<ChurnRadarClientStatus | null> {
  const inserted = await db
    .insert(churnRadarClientResults)
    .values({
      runId,
      clientId: client.id,
      firmName: client.firmName,
      status: outcome.status,
      churnLikelihood: outcome.churnLikelihood ?? null,
      likelihoodBand: outcome.likelihoodBand ?? null,
      summary: outcome.summary ?? null,
      insufficiencyReason: outcome.insufficiencyReason ?? null,
      errorMessage: outcome.errorMessage ?? null,
    })
    .onConflictDoNothing({
      target: [churnRadarClientResults.runId, churnRadarClientResults.clientId],
    })
    .returning({ id: churnRadarClientResults.id });
  return inserted.length > 0 ? outcome.status : null;
}

// ── Per-client churn interview ──────────────────────────────────────────────

/**
 * Interview one client's agent: assemble the same context surfaces the
 * client agent uses (knowledge base retrieval, latest judgments,
 * relationship signals, open asks, recent communication insights) and ask
 * the quality model for a structured top-5 churn-reasons answer.
 */
async function interviewClientForRun(
  runId: string,
  client: SweepClient,
): Promise<ChurnRadarClientStatus | null> {
  const since30d = new Date();
  since30d.setDate(since30d.getDate() - 30);

  const [judgments, signals, openAsks, insights, commsCount30d] = await Promise.all([
    storage.getClientDailyJudgments(client.id, 10),
    storage.getClientRelationshipSignals(client.id, 3),
    // Task #4765 — shared active-set definition (open + likely_open); the
    // old open-only read silently dropped likely_open asks.
    storage
      .getClientOpenAsks(client.id)
      .then((asks) => asks.filter((a) => isActiveAskStatus(a.status))),
    storage.listClientCommunicationInsights(client.id, { dateFrom: since30d }),
    storage.countClientCommunicationsInRange(client.id, since30d),
  ]);

  // Knowledge context is advisory — a retrieval failure degrades to "no
  // knowledge context" instead of failing the whole interview.
  let knowledgeContext = "";
  try {
    const ctx = await getClientContext(client.id, "churn_risk_radar");
    knowledgeContext = formatContextForPrompt(ctx);
  } catch (err: any) {
    console.warn(`${LOG_PREFIX} Knowledge context failed for ${client.id}: ${err?.message ?? err}`);
  }

  // Hard pre-gate: with no judgments, no recent communications, and no
  // communication insights there is nothing to ground churn reasons in —
  // mark insufficient WITHOUT calling the model (never fabricate).
  if (judgments.length === 0 && commsCount30d === 0 && insights.length === 0) {
    return recordClientResult(runId, client, {
      status: "insufficient_data",
      insufficiencyReason:
        "No daily judgments, no communications in the last 30 days, and no communication insights to ground a churn assessment.",
    });
  }

  const parsed = await runChurnInterviewModel(
    buildInterviewSystemPrompt(client),
    buildInterviewUserPrompt(client, {
      judgments,
      signals,
      openAsks,
      insights,
      knowledgeContext,
      commsCount30d,
    }),
  );

  if (parsed.dataSufficiency === "insufficient" || parsed.reasons.length === 0) {
    return recordClientResult(runId, client, {
      status: "insufficient_data",
      insufficiencyReason:
        parsed.insufficiencyReason ??
        "The model judged the available data too thin for grounded churn reasons.",
    });
  }

  const recorded = await recordClientResult(runId, client, {
    status: "analyzed",
    churnLikelihood: parsed.churnLikelihood,
    likelihoodBand: parsed.likelihoodBand,
    summary: parsed.summary,
  });
  if (!recorded) return null; // another worker already owns this client in this run

  await db
    .insert(churnRadarFindings)
    .values(
      parsed.reasons.map((r) => ({
        runId,
        clientId: client.id,
        rank: r.rank,
        reason: r.reason,
        severity: r.severity,
        confidence: r.confidence,
        evidenceJson: r.evidence,
        themeCategory: r.themeCategory,
      })),
    )
    .onConflictDoNothing({
      target: [churnRadarFindings.runId, churnRadarFindings.clientId, churnRadarFindings.rank],
    });
  return recorded;
}

// ── Model call + structured parsing ─────────────────────────────────────────

export interface ChurnInterviewParsed {
  dataSufficiency: "sufficient" | "insufficient";
  insufficiencyReason: string | null;
  churnLikelihood: number | null;
  likelihoodBand: ChurnRadarLikelihoodBand | null;
  summary: string | null;
  reasons: Array<{
    rank: number;
    reason: string;
    severity: ChurnRadarSeverity;
    confidence: number | null;
    evidence: string[];
    themeCategory: ChurnRadarThemeCategory;
  }>;
}

async function runChurnInterviewModel(system: string, user: string): Promise<ChurnInterviewParsed> {
  const completion = await churnRadarOpenAI.chat.completions.create({
    model: QUALITY_MODEL,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    response_format: { type: "json_object" },
    max_completion_tokens: 3000,
  });
  const raw = completion.choices[0]?.message?.content ?? "";
  return parseChurnInterviewResponse(raw);
}

/**
 * Parse + normalize the model's JSON answer. Exported for the service
 * test's structured-parsing coverage. Throws on unparseable JSON (the
 * caller records an `error` result); coerces out-of-vocabulary enums to
 * safe fallbacks and clamps numerics instead of throwing.
 */
export function parseChurnInterviewResponse(raw: string): ChurnInterviewParsed {
  let obj: any;
  try {
    obj = JSON.parse(raw);
  } catch {
    throw new Error("Model returned unparseable JSON");
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    throw new Error("Model returned a non-object JSON payload");
  }

  const likelihoodNum = Number(obj.churnLikelihood);
  const churnLikelihood = Number.isFinite(likelihoodNum)
    ? Math.max(0, Math.min(100, Math.round(likelihoodNum)))
    : null;

  const likelihoodBand: ChurnRadarLikelihoodBand | null = (churnRadarLikelihoodBands as readonly string[]).includes(obj.likelihoodBand)
    ? (obj.likelihoodBand as ChurnRadarLikelihoodBand)
    : churnLikelihood === null
      ? null
      : churnLikelihood >= 75
        ? "critical"
        : churnLikelihood >= 50
          ? "high"
          : churnLikelihood >= 25
            ? "moderate"
            : "low";

  const rawReasons: any[] = Array.isArray(obj.reasons) ? obj.reasons : [];
  const cleaned = rawReasons
    .filter((r) => r && typeof r === "object" && typeof r.reason === "string" && r.reason.trim().length > 0)
    .map((r, i) => ({
      providedRank: Number.isFinite(Number(r.rank)) ? Number(r.rank) : i + 1,
      reason: truncate(r.reason.trim(), 500),
      severity: ((churnRadarSeverities as readonly string[]).includes(r.severity)
        ? r.severity
        : "medium") as ChurnRadarSeverity,
      confidence: Number.isFinite(Number(r.confidence))
        ? Math.max(0, Math.min(1, Number(r.confidence)))
        : null,
      evidence: (Array.isArray(r.evidence) ? r.evidence : [])
        .filter((e: unknown) => typeof e === "string" && (e as string).trim().length > 0)
        .slice(0, 5)
        .map((e: string) => truncate(e.trim(), 300)),
      themeCategory: ((churnRadarThemeCategories as readonly string[]).includes(r.themeCategory)
        ? r.themeCategory
        : "other") as ChurnRadarThemeCategory,
    }));
  cleaned.sort((a, b) => a.providedRank - b.providedRank);
  const reasons = cleaned.slice(0, MAX_REASONS).map((r, i) => ({
    rank: i + 1,
    reason: r.reason,
    severity: r.severity,
    confidence: r.confidence,
    evidence: r.evidence,
    themeCategory: r.themeCategory,
  }));

  return {
    dataSufficiency: obj.dataSufficiency === "insufficient" ? "insufficient" : "sufficient",
    insufficiencyReason:
      typeof obj.insufficiencyReason === "string" && obj.insufficiencyReason.trim().length > 0
        ? truncate(obj.insufficiencyReason.trim(), 500)
        : null,
    churnLikelihood,
    likelihoodBand,
    summary:
      typeof obj.summary === "string" && obj.summary.trim().length > 0
        ? truncate(obj.summary.trim(), 1500)
        : null,
    reasons,
  };
}

// ── Prompt assembly ─────────────────────────────────────────────────────────

function buildInterviewSystemPrompt(client: SweepClient): string {
  return [
    `You are the long-running account-intelligence agent for ${client.firmName}, a law-firm client of a legal marketing agency.`,
    `You know this account through its knowledge base, daily account judgments, relationship signals, open asks, and communication insights (all provided by the user message).`,
    ``,
    `TASK: Identify the TOP ${MAX_REASONS} reasons this client might churn (fire the agency), ranked by contribution to churn risk (rank 1 = biggest driver).`,
    ``,
    `Rules:`,
    `- Ground EVERY reason in the provided data and cite the specific evidence (judgment dates, ask text, communication insights, knowledge facts) in the "evidence" array.`,
    `- Do NOT fabricate reasons. If the data is too thin for a grounded judgment, return dataSufficiency "insufficient" with an insufficiencyReason and an empty reasons array.`,
    `- Fewer well-grounded reasons beat ${MAX_REASONS} padded ones.`,
    `- Respond ONLY with a JSON object of this exact shape:`,
    `{`,
    `  "dataSufficiency": "sufficient" | "insufficient",`,
    `  "insufficiencyReason": "<only when insufficient>",`,
    `  "churnLikelihood": <integer 0-100, probability-flavored score that this client churns in the next 6 months>,`,
    `  "likelihoodBand": "low" | "moderate" | "high" | "critical",`,
    `  "summary": "<2-3 sentence churn outlook for this client>",`,
    `  "reasons": [`,
    `    {`,
    `      "rank": <1-${MAX_REASONS}>,`,
    `      "reason": "<specific churn driver, one sentence>",`,
    `      "severity": "high" | "medium" | "low",`,
    `      "confidence": <0.0-1.0>,`,
    `      "evidence": ["<specific reference to the provided data>", ...],`,
    `      "themeCategory": <one of: ${churnRadarThemeCategories.map((c) => `"${c}"`).join(", ")}>`,
    `    }`,
    `  ]`,
    `}`,
  ].join("\n");
}

function buildInterviewUserPrompt(
  client: SweepClient,
  data: {
    judgments: Awaited<ReturnType<typeof storage.getClientDailyJudgments>>;
    signals: Awaited<ReturnType<typeof storage.getClientRelationshipSignals>>;
    openAsks: Awaited<ReturnType<typeof storage.getClientOpenAsks>>;
    insights: Awaited<ReturnType<typeof storage.listClientCommunicationInsights>>;
    knowledgeContext: string;
    commsCount30d: number;
  },
): string {
  const parts: string[] = [];
  const today = new Date().toISOString().split("T")[0];
  parts.push(`Today is ${today}.`);
  parts.push(`=== CLIENT ===`);
  parts.push(`${client.firmName}${client.clientCode ? ` (code ${client.clientCode})` : ""}`);
  parts.push(`Communications matched in the last 30 days: ${data.commsCount30d}`);
  parts.push("");

  if (data.knowledgeContext) {
    parts.push(data.knowledgeContext);
    parts.push("");
  }

  parts.push(`=== DAILY JUDGMENTS (latest ${data.judgments.length}, newest first) ===`);
  if (data.judgments.length === 0) parts.push("None.");
  for (const j of data.judgments) {
    parts.push(`--- ${j.judgmentDate} ---`);
    parts.push(
      `Status: ${j.overallStatus ?? j.status} | Relationship: ${j.relationshipStatus ?? j.relationshipHealth ?? "?"} | Risk score: ${j.riskScore ?? "?"}`,
    );
    if (j.summaryText || j.narrativeSummary) parts.push(`Summary: ${truncate(j.summaryText ?? j.narrativeSummary ?? "", 300)}`);
    if (Array.isArray(j.concernsJson) && (j.concernsJson as string[]).length > 0) {
      parts.push(`Concerns: ${(j.concernsJson as string[]).slice(0, 6).join("; ")}`);
    }
    if (Array.isArray(j.unresolvedAsksJson) && (j.unresolvedAsksJson as string[]).length > 0) {
      parts.push(`Unresolved: ${(j.unresolvedAsksJson as string[]).slice(0, 6).join("; ")}`);
    }
  }
  parts.push("");

  parts.push(`=== RELATIONSHIP SIGNALS (latest ${data.signals.length}) ===`);
  if (data.signals.length === 0) parts.push("None.");
  for (const s of data.signals) {
    parts.push(
      `${s.signalDate}: sentiment ${fmtNum(s.sentimentScore)}, complaint ${fmtNum(s.complaintScore)}, trust ${fmtNum(s.trustScore)}, ` +
        `responsivenessRisk ${fmtNum(s.responsivenessRiskScore)}, executionRisk ${fmtNum(s.executionRiskScore)}, ` +
        `leadVolumeConcern ${fmtNum(s.leadVolumeConcernScore)}, unresolvedTaskRisk ${fmtNum(s.unresolvedTaskScore)}, ` +
        `relationshipHealth ${fmtNum(s.relationshipHealthScore)} (comms analyzed: ${s.communicationCount ?? 0})`,
    );
  }
  parts.push("");

  parts.push(`=== OPEN ASKS (${data.openAsks.length}) ===`);
  if (data.openAsks.length === 0) parts.push("None.");
  for (const ask of data.openAsks.slice(0, 15)) {
    const lastRef = ask.lastReferencedAt ? new Date(ask.lastReferencedAt).toISOString().split("T")[0] : "?";
    parts.push(
      `- [${ask.status}] ${truncate(ask.askText ?? ask.summary, 240)} (concern ${ask.concernScore ?? 1}, category ${ask.askCategory ?? "unknown"}, last referenced ${lastRef})`,
    );
  }
  parts.push("");

  parts.push(`=== RECENT COMMUNICATION INSIGHTS (last 30 days, ${data.insights.length} records) ===`);
  if (data.insights.length === 0) parts.push("None.");
  for (const ins of data.insights.slice(0, 12)) {
    const when = ins.enrichedAt ? new Date(ins.enrichedAt).toISOString().split("T")[0] : "?";
    const themes = Array.isArray(ins.complaintThemes) ? (ins.complaintThemes as string[]).slice(0, 4).join("; ") : "";
    parts.push(
      `- ${when}: sentiment ${fmtNum(ins.overallSentiment)}, trust ${fmtNum(ins.trustLevel)}, frustration ${fmtNum(ins.frustrationLevel)}, ` +
        `disappointment ${fmtNum(ins.disappointmentLevel)}${themes ? `, complaints: ${themes}` : ""}`,
    );
  }
  parts.push("");

  parts.push(
    `Assess churn risk for ${client.firmName} and produce the ranked top-${MAX_REASONS} churn reasons JSON now. Only use evidence about THIS client.`,
  );
  return parts.join("\n");
}

// ── Portfolio synthesis (deterministic) ─────────────────────────────────────

const SEVERITY_WEIGHT: Record<ChurnRadarSeverity, number> = { high: 3, medium: 2, low: 1 };
const SEVERITY_ORDER: ChurnRadarSeverity[] = ["high", "medium", "low"];

/**
 * Aggregate per-client findings into deduplicated cross-client themes,
 * weighted by severity and client count:
 *
 *   impactScore = Σ severityWeight(finding) + 2 × clientCount
 *
 * Pure + deterministic (exported for the service test): identical inputs
 * always produce identical theme ordering.
 */
export function buildChurnRadarThemes(
  results: Array<
    Pick<ChurnRadarClientResult, "clientId" | "firmName" | "churnLikelihood" | "likelihoodBand" | "status">
  >,
  findings: Array<
    Pick<ChurnRadarFinding, "clientId" | "reason" | "severity" | "confidence" | "themeCategory">
  >,
): ChurnRadarTheme[] {
  const resultByClient = new Map(results.map((r) => [r.clientId, r]));
  const byTheme = new Map<ChurnRadarThemeCategory, typeof findings>();
  for (const f of findings) {
    const cat = (churnRadarThemeCategories as readonly string[]).includes(f.themeCategory)
      ? (f.themeCategory as ChurnRadarThemeCategory)
      : "other";
    const list = byTheme.get(cat) ?? [];
    list.push(f);
    byTheme.set(cat, list);
  }

  const themes: ChurnRadarTheme[] = [];
  for (const [category, themeFindings] of byTheme.entries()) {
    const severityCounts = { high: 0, medium: 0, low: 0 };
    const clientIds = new Set<string>();
    const reasonsByClient = new Map<string, { reasons: string[]; worst: ChurnRadarSeverity }>();
    let severitySum = 0;

    for (const f of themeFindings) {
      const sev = (churnRadarSeverities as readonly string[]).includes(f.severity)
        ? (f.severity as ChurnRadarSeverity)
        : "medium";
      severityCounts[sev] += 1;
      severitySum += SEVERITY_WEIGHT[sev];
      clientIds.add(f.clientId);
      const entry = reasonsByClient.get(f.clientId) ?? { reasons: [], worst: sev };
      entry.reasons.push(f.reason);
      if (SEVERITY_ORDER.indexOf(sev) < SEVERITY_ORDER.indexOf(entry.worst)) entry.worst = sev;
      reasonsByClient.set(f.clientId, entry);
    }

    const affectedClients = [...clientIds]
      .map((clientId) => {
        const res = resultByClient.get(clientId);
        const entry = reasonsByClient.get(clientId)!;
        return {
          clientId,
          firmName: res?.firmName ?? clientId,
          churnLikelihood: res?.churnLikelihood ?? null,
          likelihoodBand: res?.likelihoodBand ?? null,
          worstSeverity: entry.worst,
          reasons: entry.reasons.slice(0, 5),
        };
      })
      .sort(
        (a, b) =>
          (b.churnLikelihood ?? -1) - (a.churnLikelihood ?? -1) || a.firmName.localeCompare(b.firmName),
      );

    const highRiskClientCount = affectedClients.filter(
      (c) => c.likelihoodBand === "high" || c.likelihoodBand === "critical",
    ).length;

    const representativeReasons = [...themeFindings]
      .sort(
        (a, b) =>
          SEVERITY_WEIGHT[(b.severity as ChurnRadarSeverity) in SEVERITY_WEIGHT ? (b.severity as ChurnRadarSeverity) : "medium"] -
            SEVERITY_WEIGHT[(a.severity as ChurnRadarSeverity) in SEVERITY_WEIGHT ? (a.severity as ChurnRadarSeverity) : "medium"] ||
          (b.confidence ?? 0) - (a.confidence ?? 0),
      )
      .slice(0, 3)
      .map((f) => f.reason);

    themes.push({
      category,
      label: churnRadarThemeLabels[category],
      clientCount: clientIds.size,
      highRiskClientCount,
      severityCounts,
      impactScore: severitySum + 2 * clientIds.size,
      affectedClients,
      representativeReasons,
    });
  }

  themes.sort(
    (a, b) =>
      b.impactScore - a.impactScore ||
      b.clientCount - a.clientCount ||
      a.label.localeCompare(b.label),
  );
  return themes;
}

// ── Completion notification ─────────────────────────────────────────────────

async function notifyRequester(
  run: ChurnRadarRun,
  results: ChurnRadarClientResult[] | null,
): Promise<void> {
  if (!run.requestedBy) return;
  try {
    if (run.status === "completed") {
      const highRisk = (results ?? []).filter(
        (r) => r.likelihoodBand === "high" || r.likelihoodBand === "critical",
      ).length;
      const bits = [`${run.analyzedClients} of ${run.totalClients} clients analyzed`];
      if (highRisk > 0) bits.push(`${highRisk} high risk`);
      if (run.insufficientClients > 0) bits.push(`${run.insufficientClients} insufficient data`);
      if (run.errorClients > 0) bits.push(`${run.errorClients} errors`);
      await notifyUser(run.requestedBy, {
        category: "agent",
        title: "Churn Risk Radar sweep complete",
        body: bits.join(" · "),
        deepLink: `/churn?tab=radar&run=${run.id}`,
        dedupeKey: `churn_radar_complete_${run.id}`,
      });
    } else if (run.status === "failed") {
      await notifyUser(run.requestedBy, {
        category: "agent",
        title: "Churn Risk Radar sweep failed",
        body: truncate(run.errorSummary ?? "Unknown error", 300),
        deepLink: `/churn?tab=radar&run=${run.id}`,
        dedupeKey: `churn_radar_failed_${run.id}`,
      });
    }
  } catch (err: any) {
    // Notification is best-effort — never fail the run over it.
    console.error(`${LOG_PREFIX} Failed to notify requester:`, err?.message ?? err);
  }
}

// ── Small helpers ───────────────────────────────────────────────────────────

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function fmtNum(v: number | null | undefined): string {
  return v === null || v === undefined ? "?" : String(Math.round(v * 100) / 100);
}
