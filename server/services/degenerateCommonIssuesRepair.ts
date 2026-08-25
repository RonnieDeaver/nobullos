// @db-pool-intent: ambient
/**
 * Task #4543 — repair degenerate Common Issues copy stored inside reports
 * that were finalized BEFORE the Task #4227 finalize-time quality gate
 * shipped (commit a1cf85db1, 2026-08-10T14:28:40Z).
 *
 * Background:
 *   The finalize gate blocks NEW finalizations carrying thin/degenerate
 *   Common Issues copy ("Issue: Being Bad" → "Impact: Poor behavior"), but
 *   it never rewrites reports that were already status='final' when it
 *   merged — the January 2026 final deck (and its PDF) still serves the
 *   degenerate copy to clients via its share link. This module is the shared
 *   core for the one-off `repair_degenerate_common_issues_final_reports`
 *   prod-action that re-runs the gate's detector over historical final
 *   reports and surgically repairs the failing stored sections.
 *
 * Repair semantics (deliberately surgical — verified against the live prod
 * rows on 2026-08-12):
 *   - Almost every failing row is an otherwise-healthy 🔴/↳/➡️ block whose
 *     `**Issue:**` (or `**Impact:**`) body is a thin 2-word label ("Being
 *     Bad", "Bad sales script") sitting next to a substantive Impact and
 *     Strategic Fix. Dropping the block would destroy the real finding, and
 *     a whole-section AI reformat could rewrite healthy copy. Instead, ONLY
 *     the thin line's body is replaced, via an AI restatement grounded
 *     strictly in that block's own Impact/Fix text (no new facts). Every
 *     other line is reassembled byte-identical.
 *   - A marker-only block with NO substance at all (e.g. a trailing
 *     "🔴 **Issue:**" left by a truncated generation) is dropped
 *     deterministically — there is nothing to restate.
 *   - Thin unmarked prose (< 40 chars, no markers) has no in-block context
 *     to restate from, so it is reported `unrepaired` and left untouched.
 *   - The repaired section must pass `findDegenerateCommonIssues` (the exact
 *     finalize-gate detector) or the row's content is left untouched and the
 *     outcome reported as `unrepaired`.
 *
 * Convergence / audit:
 *   - Every processed section is stamped `data.degenerateCopyRepairVersion`
 *     (including `unrepaired` ones — they need an operator edit, not an AI
 *     re-bill on every press) and falls out of the candidate set.
 *   - Post-gate reports are structurally excluded: candidates require
 *     `reports.created_at` < the gate-ship instant, so a report an operator
 *     explicitly finalized PAST the gate (confirmReportQualityFinalize) is
 *     never overridden.
 *   - The row is re-read immediately before the write and skipped when its
 *     `commonIssues` changed since selection (mid-run operator edits win).
 */
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { reportSections, reports } from "@shared/schema";
import {
  findDegenerateCommonIssues,
  isThinCommonIssuesBody,
  normalizeCommonIssuesStructure,
} from "./commonIssuesFormatter";
import { sanitizePromptInput } from "./atsTypes";

// Type-only — erased at runtime, so importing this module does NOT boot the
// DB pool. Callers inject the concrete handle.
export type RepairDb = ReturnType<typeof import("../db")["getDb"]>;

/** Bumping re-arms every stamped section. */
export const DEGENERATE_COPY_REPAIR_VERSION = 1;
export const DEGENERATE_REPAIR_STAMP_KEY = "degenerateCopyRepairVersion";

/**
 * The Task #4227 finalize gate shipped in commit a1cf85db1. Reports created
 * at/after this instant finalized THROUGH the gate (or via an explicit
 * operator confirm) and are never touched by this backfill.
 */
export const QUALITY_GATE_SHIPPED_AT = new Date("2026-08-10T14:28:40Z");

const TARGET_SECTION_KEYS = ["intake", "sales"] as const;

export interface DegenerateRepairCandidate {
  id: string;
  reportId: string;
  reportMonth: string;
  sectionKey: "intake" | "sales";
  commonIssues: string;
  data: Record<string, unknown>;
  /** Detector snippets, for operator-facing status detail. */
  snippets: string[];
}

/**
 * Final, pre-gate reports whose stored Intake/Sales commonIssues fails the
 * finalize-gate detector and is not yet stamped. The SQL prefilter narrows to
 * final + pre-gate + non-empty + unstamped; the precise detector runs in code.
 */
export async function findDegenerateFinalReportSections(
  db: RepairDb,
): Promise<DegenerateRepairCandidate[]> {
  const rows = await db
    .select({
      id: reportSections.id,
      reportId: reportSections.reportId,
      reportMonth: reports.reportMonth,
      sectionKey: reportSections.sectionKey,
      data: reportSections.data,
    })
    .from(reportSections)
    .innerJoin(reports, eq(reportSections.reportId, reports.id))
    .where(
      and(
        inArray(reportSections.sectionKey, [...TARGET_SECTION_KEYS]),
        eq(reports.status, "final"),
        lt(reports.createdAt, QUALITY_GATE_SHIPPED_AT),
        sql`COALESCE(${reportSections.data} ->> 'commonIssues', '') <> ''`,
        sql`COALESCE((${reportSections.data} ->> ${DEGENERATE_REPAIR_STAMP_KEY})::int, 0) <> ${DEGENERATE_COPY_REPAIR_VERSION}`,
      ),
    );

  const candidates: DegenerateRepairCandidate[] = [];
  for (const row of rows) {
    const data = (row.data ?? {}) as Record<string, unknown>;
    const commonIssues =
      typeof data.commonIssues === "string" ? (data.commonIssues as string) : "";
    const problems = findDegenerateCommonIssues(commonIssues);
    if (problems.length === 0) continue;
    candidates.push({
      id: row.id,
      reportId: row.reportId,
      reportMonth: row.reportMonth,
      sectionKey: row.sectionKey === "sales" ? "sales" : "intake",
      commonIssues,
      data,
      snippets: problems.map((p) => p.snippet).filter(Boolean),
    });
  }
  return candidates;
}

/**
 * Rewrites ONE thin Issue/Impact body into a complete professional sentence,
 * grounded strictly in the surrounding block. Injectable so tests never hit
 * the network; the default uses the same cheap model as the shared formatter.
 */
export type ThinBodyRewriter = (args: {
  kind: "Issue" | "Impact";
  thinBody: string;
  blockText: string;
  section: "intake" | "sales";
}) => Promise<string>;

export const defaultThinBodyRewriter: ThinBodyRewriter = async ({
  kind,
  thinBody,
  blockText,
  section,
}) => {
  // Lazy import keeps this module test-inert (no OpenAI client construction
  // unless the real rewriter actually runs).
  const [{ openai }, { CHEAP_MODEL }] = await Promise.all([
    import("../routes/middleware"),
    import("../aiModels"),
  ]);
  const sectionLabel = section === "sales" ? "Sales" : "Intake";
  const response = await openai.chat.completions.create({
    model: CHEAP_MODEL,
    messages: [
      {
        role: "system",
        content: `You repair one line of a law-firm ${sectionLabel} performance finding. The finding block is:

${sanitizePromptInput(blockText)}

The "${kind}" line's text is too thin to publish: ${JSON.stringify(thinBody)}.

Write a single replacement sentence for ONLY that ${kind} line. Rules:
- Ground it STRICTLY in the block's own Issue/Impact/Strategic Fix content — restate, never invent new facts, metrics, or names.
- ${kind === "Issue" ? "Describe only the root behavior or problem being done wrong — no consequences or results." : "Describe only the downstream consequence or result of the issue."}
- One complete, professional sentence, at least 5 words. No emoji, no markdown, no label prefix, no quotes. Return ONLY the sentence.`,
      },
    ],
    reasoning_effort: "minimal",
    max_completion_tokens: 2000,
  });
  const choice = response.choices[0];
  if (choice?.finish_reason === "length") {
    throw new Error("ai_truncated");
  }
  return (choice?.message?.content || "").trim();
};

export interface RepairTextResult {
  text: string;
  /** Text differs from input and passes the detector. */
  repaired: boolean;
  rewrittenLines: number;
  droppedBlocks: number;
  /** Non-empty when the section could not be brought past the detector. */
  unrepairedReasons: string[];
}

const ISSUE_LINE_RE = /^(.*\*\*Issue:\*\*\s*)(.*)$/u;
const IMPACT_LINE_RE = /^(.*\*\*Impact:\*\*\s*)(.*)$/u;

/** True when a block has ANY substantive (non-thin) body text on any line. */
function blockHasSubstance(blockLines: string[]): boolean {
  for (const line of blockLines) {
    const issue = line.match(ISSUE_LINE_RE);
    const impact = line.match(IMPACT_LINE_RE);
    const fix = line.match(/\*\*Strategic Fix:\*\*\s*(.*)$/u);
    const body = (issue?.[2] ?? impact?.[2] ?? fix?.[1])?.trim();
    if (body && !isThinCommonIssuesBody(body)) return true;
  }
  return false;
}

/**
 * Repair a section's commonIssues text. Never throws — an AI failure lands
 * in `unrepairedReasons` and the input text is returned unchanged.
 */
export async function repairDegenerateCommonIssuesText(
  raw: string,
  section: "intake" | "sales",
  rewriteThinBody: ThinBodyRewriter = defaultThinBodyRewriter,
): Promise<RepairTextResult> {
  const text = normalizeCommonIssuesStructure(raw).trim();
  const result: RepairTextResult = {
    text: raw,
    repaired: false,
    rewrittenLines: 0,
    droppedBlocks: 0,
    unrepairedReasons: [],
  };
  const problems = findDegenerateCommonIssues(text);
  if (problems.length === 0) return { ...result, text };

  if (problems.some((p) => p.reason === "thin_text")) {
    // Unmarked thin prose — no in-block context to restate from.
    result.unrepairedReasons.push("thin unmarked prose (needs operator edit)");
    return result;
  }

  // Split into blocks on divider lines; preserve every non-thin line verbatim.
  const blocks: string[][] = [[]];
  for (const line of text.split("\n")) {
    if (/^---\s*$/.test(line)) {
      blocks.push([]);
    } else {
      blocks[blocks.length - 1].push(line);
    }
  }

  const keptBlocks: string[][] = [];
  for (const blockLines of blocks) {
    const blockText = blockLines.join("\n").trim();
    if (!blockText) {
      result.droppedBlocks++; // empty segment from doubled dividers
      continue;
    }
    const hasThin = blockLines.some((line) => {
      const m = line.match(ISSUE_LINE_RE) ?? line.match(IMPACT_LINE_RE);
      return m ? isThinCommonIssuesBody(m[2].trim()) : false;
    });
    if (!hasThin) {
      keptBlocks.push(blockLines);
      continue;
    }
    if (!blockHasSubstance(blockLines)) {
      // Marker-only residue (e.g. a truncated trailing "🔴 **Issue:**").
      result.droppedBlocks++;
      continue;
    }
    const nextLines: string[] = [];
    let blockFailed = false;
    for (const line of blockLines) {
      const issue = line.match(ISSUE_LINE_RE);
      const impact = issue ? null : line.match(IMPACT_LINE_RE);
      const m = issue ?? impact;
      const kind: "Issue" | "Impact" = issue ? "Issue" : "Impact";
      if (!m || !isThinCommonIssuesBody(m[2].trim())) {
        nextLines.push(line);
        continue;
      }
      try {
        const replacement = await rewriteThinBody({
          kind,
          thinBody: m[2].trim(),
          blockText,
          section,
        });
        const clean = replacement.replace(/\s+/g, " ").trim();
        if (!clean || isThinCommonIssuesBody(clean)) {
          throw new Error("rewrite still thin");
        }
        nextLines.push(`${m[1]}${clean}`);
        result.rewrittenLines++;
      } catch (err: any) {
        blockFailed = true;
        result.unrepairedReasons.push(
          `${kind} ${JSON.stringify(m[2].trim())}: ${err?.message || "rewrite failed"}`,
        );
        nextLines.push(line);
      }
    }
    keptBlocks.push(nextLines);
    if (blockFailed) {
      // keep going — other blocks may still repair; final detector check
      // below decides the overall outcome.
    }
  }

  const reassembled = normalizeCommonIssuesStructure(
    keptBlocks.map((b) => b.join("\n").trim()).filter(Boolean).join("\n\n---\n\n"),
  ).trim();

  if (
    result.unrepairedReasons.length === 0 &&
    reassembled &&
    findDegenerateCommonIssues(reassembled).length === 0
  ) {
    return { ...result, text: reassembled, repaired: true };
  }
  if (result.unrepairedReasons.length === 0) {
    result.unrepairedReasons.push(
      reassembled
        ? "repaired text still fails the quality detector"
        : "repair would empty the section",
    );
  }
  return result; // content untouched
}

export type ProcessDegenerateRepairResult =
  | { kind: "repaired"; rewrittenLines: number; droppedBlocks: number }
  | { kind: "unrepaired"; reasons: string[] }
  | { kind: "skipped_conflict" };

/**
 * Process one candidate: repair, then write via an atomic compare-and-set —
 * the UPDATE is keyed to the ORIGINALLY SELECTED `commonIssues` value, so an
 * operator edit landing at ANY point after selection (including during the
 * AI call or between statements) makes the CAS match zero rows and the
 * outcome is `skipped_conflict`: nothing written, nothing stamped, the
 * operator's edit wins. The caller must NOT retry a conflicted row within
 * the same drain run; it re-enters selection (if still failing) only on the
 * next press.
 */
export async function processDegenerateRepairSection(
  db: RepairDb,
  candidate: DegenerateRepairCandidate,
  rewriteThinBody: ThinBodyRewriter = defaultThinBodyRewriter,
): Promise<ProcessDegenerateRepairResult> {
  const repair = await repairDegenerateCommonIssuesText(
    candidate.commonIssues,
    candidate.sectionKey,
    rewriteThinBody,
  );

  // Atomic CAS: stamp (and, when repaired, replace commonIssues) in ONE
  // statement guarded on the pre-selection text. jsonb `||` merges into the
  // row's CURRENT data, so any other keys an operator added since selection
  // are preserved.
  const patch: Record<string, unknown> = {
    [DEGENERATE_REPAIR_STAMP_KEY]: DEGENERATE_COPY_REPAIR_VERSION,
    ...(repair.repaired ? { commonIssues: repair.text } : {}),
  };
  const updated = await db
    .update(reportSections)
    .set({
      data: sql`${reportSections.data} || ${JSON.stringify(patch)}::jsonb`,
    })
    .where(
      and(
        eq(reportSections.id, candidate.id),
        sql`${reportSections.data} ->> 'commonIssues' = ${candidate.commonIssues}`,
      ),
    )
    .returning({ id: reportSections.id });
  if (updated.length === 0) {
    return { kind: "skipped_conflict" };
  }

  return repair.repaired
    ? {
        kind: "repaired",
        rewrittenLines: repair.rewrittenLines,
        droppedBlocks: repair.droppedBlocks,
      }
    : { kind: "unrepaired", reasons: repair.unrepairedReasons };
}
