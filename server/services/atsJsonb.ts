/**
 * F4 (audit R-03) — typed accessors for the ATS JSONB storage boundaries.
 *
 * Drizzle types every ATS jsonb column as `unknown`; before this module the
 * server bridged that gap with bare `as any` casts at ~80 call sites, so a
 * drifted or malformed historical row could crash an endpoint mid-handler
 * (`.find` on a non-array) or silently feed garbage into scoring prompts.
 *
 * Every accessor here:
 *   - accepts the raw `unknown` a jsonb column yields,
 *   - returns a NAMED domain type (write-time schemas live in ./atsTypes,
 *     hand-written legacy types in shared/models/ats),
 *   - makes null/missing explicit (`null`, `[]`, or `undefined` per boundary),
 *   - preserves known legacy shapes (v1 rubric/score rows, history entries
 *     written before newer fields existed) by keeping members optional and
 *     passing values through by reference, and
 *   - maps genuinely malformed values to a logged, controlled fallback
 *     (documented per accessor) instead of an uncontrolled crash.
 *
 * Guards are container-level and REFERENCE-PRESERVING: they verify exactly
 * the structure the server dereferences (e.g. `items` must be an array
 * because handlers call `.find` on it) and hand back the original object,
 * so echoed API payloads and AI prompt interpolations stay byte-for-byte
 * identical for every row that decodes. There is deliberately no strict Zod
 * re-parse at read time: write-time schemas own deep validity for new rows,
 * while historical rows predate several schema revisions (stricter mins,
 * added fields) and must keep flowing exactly as they do today. A strict
 * re-parse would also strip unknown keys, changing echoed response bytes.
 *
 * This module must stay a leaf: types only from ./atsTypes, @shared/schema
 * and (type-only) ./atsInterviewAnalysis — no db, no routes, no services.
 */
import type { AtsRubric, AtsScreeningQuestion, AtsVideoTask } from "@shared/schema";
import type {
  AssessmentItem,
  AssessmentJson,
  CognitiveProfile,
  ResumeProfile,
  RoleSourceOfTruth,
  RubricJson,
  ScorecardJson,
} from "./atsTypes";
import type {
  FocusInterviewAnalysis,
  PhoneInterviewAnalysis,
  ReferenceInterviewAnalysis,
  StoryInterviewAnalysis,
} from "./atsInterviewAnalysis";

type UnknownRecord = Record<string, unknown>;

function isPlainObject(value: unknown, context?: AtsJsonbContext): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasArrayMembers(value: UnknownRecord, keys: readonly string[]): boolean {
  return keys.every((k) => Array.isArray(value[k]));
}

function previewValue(value: unknown, context?: AtsJsonbContext): string {
  const kind = Array.isArray(value) ? "array" : typeof value;
  let rendered: string;
  try {
    rendered = JSON.stringify(value) ?? String(value);
  } catch {
    rendered = String(value);
  }
  if (rendered.length > 160) rendered = `${rendered.slice(0, 157)}...`;
  return `${kind} ${rendered}`;
}

/**
 * Optional row identifiers a call site can pass so malformed-boundary events
 * name a sample row. IDs only (UUIDs) — never candidate names/emails: the
 * context rides into the operator alert body, which must stay PII-free.
 */
export interface AtsJsonbContext {
  jobId?: string;
  candidateId?: string;
  interviewId?: string;
}

/** Task #4184 — one malformed-boundary observation, as handed to the listener. */
export interface AtsJsonbMalformedEvent {
  /** table.column boundary name, e.g. "ats_candidates.ai_score_json". */
  boundary: string;
  /** Human description of the expected shape. */
  expected: string;
  /** Row identifiers when the call site supplied them. */
  context?: AtsJsonbContext;
}

type AtsJsonbMalformedListener = (event: AtsJsonbMalformedEvent) => void;

/**
 * Task #4184 — injectable malformed-event sink. This module must stay a leaf
 * (no db/services imports), so the operator-alert wiring is INJECTED at boot
 * by server/services/atsJsonbCorruptionAlerts.ts rather than imported here.
 * Listener errors are swallowed: alerting must never change accessor behavior.
 */
let malformedListener: AtsJsonbMalformedListener | null = null;
export function setAtsJsonbMalformedListener(listener: AtsJsonbMalformedListener | null): void {
  malformedListener = listener;
}

/**
 * Operational log for the malformed branch of every accessor. Malformed rows
 * are rare (writers Zod-validate before persisting), so logging per read is
 * deliberate: each line names the table.column boundary and previews the
 * offending stored value so an operator can locate and repair the row.
 * Also forwards a preview-free event to the injected alert listener (#4184).
 */
function warnMalformed(boundary: string, expected: string, value: unknown, context?: AtsJsonbContext): void {
  const ids = context
    ? Object.entries(context)
        .filter(([, v]) => typeof v === "string" && v.length > 0)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ")
    : "";
  console.warn(
    `[ATS JSONB] ${boundary}: expected ${expected}, stored value is ${previewValue(value)} — applying the boundary's documented fallback${ids ? ` (${ids})` : ""}`,
  );
  if (malformedListener) {
    try {
      malformedListener({ boundary, expected, context });
    } catch {
      // Alerting must never alter the accessor's documented fallback path.
    }
  }
}

/**
 * Shared container guard: null/undefined → null silently (explicit "missing");
 * plain object → the same reference, typed; anything else → warn + null.
 */
function readObjectBoundary<T>(value: unknown, boundary: string, expected: string, context?: AtsJsonbContext): T | null {
  if (value === null || value === undefined) return null;
  if (!isPlainObject(value)) {
    warnMalformed(boundary, expected, value, context);
    return null;
  }
  return value as unknown as T;
}

/**
 * Shared guard for arrays whose ELEMENTS the server dot-accesses (`.id`,
 * `.prompt`, ...). null/undefined → [] (matching the previous `|| []`
 * semantics); non-array → warn + []; array → same elements minus any
 * non-object entries (a null element would have crashed `.find` callbacks).
 * When nothing needs dropping the ORIGINAL array reference is returned.
 */
function readObjectArrayBoundary<T>(value: unknown, boundary: string, expected: string, context?: AtsJsonbContext): T[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) {
    warnMalformed(boundary, expected, value, context);
    return [];
  }
  if (value.every((el) => isPlainObject(el))) return value as unknown as T[];
  warnMalformed(boundary, `${expected} with object elements`, value, context);
  return value.filter((el) => isPlainObject(el)) as unknown as T[];
}

// ============================================================
// ats_jobs boundaries
// ============================================================

/**
 * ats_jobs.scorecard_json — written by the job PATCH route via
 * ScorecardJsonSchema.parse. Readers interpolate mission (safe on any value)
 * and iterate outcomes / non_negotiables / competencies / constraints, so
 * those must be arrays. Malformed → warn + null; callers treat null exactly
 * like an absent scorecard (generateRoleSourceOfTruth's no-scorecard branch)
 * instead of crashing on `.map` mid-prompt-build.
 */
export function readAtsScorecardJson(value: unknown, context?: AtsJsonbContext): ScorecardJson | null {
  const obj = readObjectBoundary<ScorecardJson>(value, "ats_jobs.scorecard_json", "a scorecard object", context);
  if (obj === null) return null;
  if (!hasArrayMembers(obj as unknown as UnknownRecord, ["outcomes", "competencies", "non_negotiables", "constraints"])) {
    warnMalformed("ats_jobs.scorecard_json", "outcomes/competencies/non_negotiables/constraints arrays", value, context);
    return null;
  }
  return obj;
}

/**
 * ats_jobs.role_source_of_truth — written by generateRoleSourceOfTruth
 * (schema-parsed). Prompt builders join/map top_outcomes, responsibilities,
 * required_skills, stressors and non_negotiables without further guards, so
 * exactly those members are verified; the rest keep reader `?.` semantics.
 * Malformed → warn + null; the generate flow then reports its existing
 * "Stage N must be completed first" 400 and scoring flows surface their
 * existing error envelope instead of crashing inside a prompt template.
 */
export function readAtsRoleSourceOfTruth(value: unknown, context?: AtsJsonbContext): RoleSourceOfTruth | null {
  const obj = readObjectBoundary<RoleSourceOfTruth>(value, "ats_jobs.role_source_of_truth", "a role source-of-truth object", context);
  if (obj === null) return null;
  if (!hasArrayMembers(obj as unknown as UnknownRecord, ["top_outcomes", "responsibilities", "required_skills", "stressors", "non_negotiables"])) {
    warnMalformed("ats_jobs.role_source_of_truth", "top_outcomes/responsibilities/required_skills/stressors/non_negotiables arrays", value, context);
    return null;
  }
  return obj;
}

/**
 * ats_jobs.cognitive_profile — written by generateCognitiveProfile
 * (schema-parsed). Prompts join ideal_default_operating_mode and read
 * action_tendencies_map.* plus four cognitive_load_map.<dim>.score chains
 * unguarded, so the containers on those chains are verified. Malformed →
 * warn + null (same downstream policy as the source-of-truth boundary).
 */
export function readAtsCognitiveProfile(value: unknown, context?: AtsJsonbContext): CognitiveProfile | null {
  const obj = readObjectBoundary<CognitiveProfile>(value, "ats_jobs.cognitive_profile", "a cognitive profile object", context);
  if (obj === null) return null;
  const raw = obj as unknown as UnknownRecord;
  const loadMap = raw.cognitive_load_map;
  const dereferencedLoadDims = ["ambiguity_tolerance_required", "conflict_exposure", "initiative_requirement", "process_discipline"] as const;
  const ok =
    Array.isArray(raw.ideal_default_operating_mode) &&
    isPlainObject(raw.action_tendencies_map) &&
    isPlainObject(loadMap) &&
    dereferencedLoadDims.every((k) => isPlainObject(loadMap[k]));
  if (!ok) {
    warnMalformed("ats_jobs.cognitive_profile", "ideal_default_operating_mode array plus action_tendencies_map/cognitive_load_map objects", value, context);
    return null;
  }
  return obj;
}

/**
 * ats_jobs.assessment_json — written by generateAssessment (schema-parsed).
 * The generate flow passes it wholesale to generateRubric, which iterates
 * `.items` and reads `.meta.total_items`/`.meta.layer_counts`; both
 * containers are verified. Malformed → warn + null, which the generate flow
 * treats as "stage 3 not completed yet" (existing 400 envelope). Note: the
 * candidate portal GET deliberately echoes the RAW column (no accessor) —
 * that payload is a passthrough contract, not an interpretation site.
 */
export function readAtsAssessmentJson(value: unknown, context?: AtsJsonbContext): AssessmentJson | null {
  const obj = readObjectBoundary<AssessmentJson>(value, "ats_jobs.assessment_json", "an assessment object", context);
  if (obj === null) return null;
  const raw = obj as unknown as UnknownRecord;
  if (!Array.isArray(raw.items) || !isPlainObject(raw.meta)) {
    warnMalformed("ats_jobs.assessment_json", "an assessment object with items array and meta object", value, context);
    return null;
  }
  return obj;
}

/**
 * Reader view of one stored assessment item. Extends the write-time
 * AssessmentItem with members that only exist on historical rows: items
 * written before the `timed_text` item type carried an `is_timed` flag,
 * which timing checks still probe first.
 */
export interface AtsStoredAssessmentItem extends AssessmentItem {
  /** Legacy rows predating the timed_text item type. */
  is_timed?: boolean;
}

/**
 * ats_jobs.assessment_json → items — the flat item list handlers `.find`
 * over to look up per-question metadata (layer, timing, contradiction pair).
 * Missing/malformed container or missing items → [] (previous `?.items || []`
 * semantics); non-object elements are dropped with a warning because `.find`
 * callbacks dot-access every element. Item-lookup misses then degrade field
 * by field exactly like an absent item does today.
 */
export function readAtsAssessmentItems(value: unknown, context?: AtsJsonbContext): AtsStoredAssessmentItem[] {
  if (value === null || value === undefined) return [];
  if (!isPlainObject(value)) {
    warnMalformed("ats_jobs.assessment_json", "an assessment object", value, context);
    return [];
  }
  return readObjectArrayBoundary<AtsStoredAssessmentItem>(value.items, "ats_jobs.assessment_json.items", "an items array", context);
}

/**
 * ats_jobs.screening_questions — array written by generateAssessment.
 * Handlers `.find` by id and read `.prompt`, so elements must be objects.
 * Missing → [], malformed → warn + [] (previously a non-array crashed the
 * spread `[...(x as any[])]` mid-handler).
 */
export function readAtsScreeningQuestions(value: unknown, context?: AtsJsonbContext): AtsScreeningQuestion[] {
  return readObjectArrayBoundary<AtsScreeningQuestion>(value, "ats_jobs.screening_questions", "a screening questions array", context);
}

/**
 * ats_jobs.video_tasks — array written by generateAssessment. Same access
 * pattern and policy as screening questions.
 */
export function readAtsVideoTasks(value: unknown, context?: AtsJsonbContext): AtsVideoTask[] {
  return readObjectArrayBoundary<AtsVideoTask>(value, "ats_jobs.video_tasks", "a video tasks array", context);
}

/**
 * ats_jobs.hard_fails — string list written by generateAssessment and fed
 * into scoring prompts. Missing → [] (previous `|| []` semantics); non-array
 * → warn + []; non-string elements are dropped with a warning so the typed
 * claim `string[]` holds for prompt `.map`/`.join` consumers.
 */
export function readAtsHardFails(value: unknown, context?: AtsJsonbContext): string[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) {
    warnMalformed("ats_jobs.hard_fails", "a string array", value, context);
    return [];
  }
  if (value.every((el) => typeof el === "string")) return value as string[];
  warnMalformed("ats_jobs.hard_fails", "a string array with string elements", value, context);
  return value.filter((el): el is string => typeof el === "string");
}

/**
 * ats_jobs.clarification_answers — question→answer map saved from the
 * generate UI and echoed into generateAssessment prompts via
 * Object.entries. Missing → null (callers default to {} / undefined as
 * before); malformed → warn + null so prompts see "no answers" instead of
 * Object.entries exploding a string into index→char pairs. Values are not
 * deep-validated: prompts interpolate them, so any JSON scalar keeps
 * today's rendering.
 */
export function readAtsClarificationAnswers(value: unknown, context?: AtsJsonbContext): Record<string, string> | null {
  return readObjectBoundary<Record<string, string>>(value, "ats_jobs.clarification_answers", "an answers object");
}

/**
 * ats_jobs.rubric_json — v2 rubric written by generateRubric (schema-parsed).
 * scoreCandidateV2 maps `.dimensions` (and each dimension's anchors — element
 * drift keeps today's behavior deliberately), so the dimensions array is
 * verified. Malformed → warn + null; scoring call sites surface their
 * existing error envelope instead of crashing inside the prompt template.
 */
export function readAtsRubricJson(value: unknown, context?: AtsJsonbContext): RubricJson | null {
  const obj = readObjectBoundary<RubricJson>(value, "ats_jobs.rubric_json", "a rubric object", context);
  if (obj === null) return null;
  if (!Array.isArray((obj as unknown as UnknownRecord).dimensions)) {
    warnMalformed("ats_jobs.rubric_json", "a rubric object with a dimensions array", value, context);
    return null;
  }
  return obj;
}

/**
 * ats_jobs.rubric — LEGACY v1 rubric ({dimensions: [{name, weight,
 * criteria}]}) kept for pre-v2 jobs and still written as a v2 projection for
 * backward compatibility. v1 scoring maps `.dimensions`. Malformed → warn +
 * null; the v1 score paths raise a descriptive error through their existing
 * 500 envelope (previously the same rows crashed inside scoreCandidate).
 */
export function readAtsLegacyRubric(value: unknown, context?: AtsJsonbContext): AtsRubric | null {
  const obj = readObjectBoundary<AtsRubric>(value, "ats_jobs.rubric", "a legacy rubric object", context);
  if (obj === null) return null;
  if (!Array.isArray((obj as unknown as UnknownRecord).dimensions)) {
    warnMalformed("ats_jobs.rubric", "a legacy rubric object with a dimensions array", value, context);
    return null;
  }
  return obj;
}

// ============================================================
// ats_candidates boundaries
// ============================================================

/**
 * Stored shape of ats_candidates.ai_score_json. This is a READER-VIEW union
 * of every shape the column has historically held:
 *   - v2 ScoringResult rows (scoreCandidateV2) — the `*_score` dimension
 *     fields, multipliers and hard-fail flag below;
 *   - those same rows after a unified re-evaluation merge added
 *     `dimension_scores` (`{...currentAiJson, dimension_scores}` writes);
 *   - legacy v1 CandidateScoreResult rows (totalScore/dimensionScores/
 *     summary) and any even older rows carrying a `dimensions` map that
 *     cohort calibration still reads.
 * Every member is optional because no field exists across all eras; the
 * index signature keeps unknown-era extras visible to spread-merge writers
 * so a rewrite never drops historical keys.
 */
export interface AtsStoredAiScore {
  role_skill_score?: number;
  role_behavior_score?: number;
  reality_based_score?: number;
  personality_alignment_score?: number;
  communication_clarity_score?: number;
  base_total?: number;
  low_effort_multiplier?: number;
  stress_multiplier?: number;
  final_score?: number;
  hard_fail_triggered?: boolean;
  /** Unified re-eval merge; numeric per-dimension map (plus reasoning metadata carried under other keys). */
  dimension_scores?: Record<string, number>;
  /** Oldest legacy rows; cohort calibration prefers this map when present. */
  dimensions?: Record<string, number>;
  [key: string]: unknown;
}

/**
 * ats_candidates.ai_score_json — see AtsStoredAiScore for the era union.
 * Readers use `?.` + `??` defaults on every field, so a plain-object guard
 * is sufficient. Missing → null (previous falsy semantics); malformed →
 * warn + null, so spread-merges rebuild from {} instead of spreading a
 * scalar into index→char garbage.
 */
export function readAtsAiScore(value: unknown, context?: AtsJsonbContext): AtsStoredAiScore | null {
  return readObjectBoundary<AtsStoredAiScore>(value, "ats_candidates.ai_score_json", "a stored AI score object", context);
}

/**
 * ats_candidates.resume_profile_json — written by the resume upload route
 * via ResumeProfileSchema.parse. evaluateResumeConsistency maps/joins
 * recent_roles and the six claim arrays unguarded, so those containers are
 * verified. Malformed → warn + null; callers skip the consistency
 * evaluation exactly as they already do when the profile is absent
 * (previously these rows crashed inside the prompt and were swallowed by
 * the call sites' non-fatal catch).
 */
export function readAtsResumeProfile(value: unknown, context?: AtsJsonbContext): ResumeProfile | null {
  const obj = readObjectBoundary<ResumeProfile>(value, "ats_candidates.resume_profile_json", "a resume profile object", context);
  if (obj === null) return null;
  if (!hasArrayMembers(obj as unknown as UnknownRecord, ["recent_roles", "skills_claimed", "tools_claimed", "domain_claims", "leadership_claims", "project_scale_claims", "credential_claims"])) {
    warnMalformed("ats_candidates.resume_profile_json", "recent_roles plus claim arrays", value, context);
    return null;
  }
  return obj;
}

/**
 * One entry of ats_candidates.dimension_history. Loose by design: the
 * column's entries span eras (initial assessment entries have no `trigger`;
 * unified re-eval entries add it) and the server only ever APPENDS to the
 * array, so elements must ride through untouched — including fields this
 * type has never heard of (index signature).
 */
export interface AtsDimensionHistoryEntry {
  stage?: string;
  timestamp?: string;
  scores?: Record<string, number>;
  base_total?: number;
  trigger?: string;
  [key: string]: unknown;
}

/**
 * ats_candidates.dimension_history — append-only score timeline. Missing →
 * []; non-array → warn + [] (the previous `Array.isArray ? : []` silently
 * discarded malformed values — now it is logged). Elements deliberately pass
 * through UNFILTERED: rewriting the array on the next append must preserve
 * every historical entry byte-for-byte.
 */
export function readAtsDimensionHistory(value: unknown, context?: AtsJsonbContext): AtsDimensionHistoryEntry[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) {
    warnMalformed("ats_candidates.dimension_history", "a history entry array", value, context);
    return [];
  }
  return value as AtsDimensionHistoryEntry[];
}

// ============================================================
// ats_interviews boundaries
// ============================================================

/**
 * Combined reader view across the four per-type interview analysis shapes
 * (phone/story/reference/focus). The unified-scoring prompt builder probes
 * fields from all four behind truthiness checks, so the view keeps every
 * member optional; per-type accessors below narrow to a single shape when
 * the interview type is known.
 */
export type AtsStoredInterviewAnalysis = Partial<PhoneInterviewAnalysis> &
  Partial<StoryInterviewAnalysis> &
  Partial<ReferenceInterviewAnalysis> &
  Partial<FocusInterviewAnalysis>;

function readInterviewAnalysisObject<T>(value: unknown, boundary: string, context?: AtsJsonbContext): T | null {
  return readObjectBoundary<T>(value, boundary, "an interview analysis object", context);
}

/**
 * ats_interviews.analysis_json — written by the analyze route with the
 * matching analyze*Interview result; null until analyzed and reset to null
 * on transcript re-upload. All readers probe optional fields behind
 * truthiness checks, so a plain-object guard is sufficient. Missing → null
 * (unanalyzed); malformed → warn + null, so prompt builders treat the
 * interview as contributing no analysis instead of interpolating garbage.
 */
export function readAtsInterviewAnalysis(value: unknown, context?: AtsJsonbContext): AtsStoredInterviewAnalysis | null {
  return readInterviewAnalysisObject<AtsStoredInterviewAnalysis>(value, "ats_interviews.analysis_json", context);
}

/** Typed narrowing of readAtsInterviewAnalysis for a known phone interview row. */
export function readAtsPhoneAnalysis(value: unknown, context?: AtsJsonbContext): PhoneInterviewAnalysis | null {
  return readInterviewAnalysisObject<PhoneInterviewAnalysis>(value, "ats_interviews.analysis_json[phone]", context);
}

/** Typed narrowing of readAtsInterviewAnalysis for a known story interview row. */
export function readAtsStoryAnalysis(value: unknown, context?: AtsJsonbContext): StoryInterviewAnalysis | null {
  return readInterviewAnalysisObject<StoryInterviewAnalysis>(value, "ats_interviews.analysis_json[story]", context);
}

/** Typed narrowing of readAtsInterviewAnalysis for a known reference interview row. */
export function readAtsReferenceAnalysis(value: unknown, context?: AtsJsonbContext): ReferenceInterviewAnalysis | null {
  return readInterviewAnalysisObject<ReferenceInterviewAnalysis>(value, "ats_interviews.analysis_json[reference]", context);
}

/** Typed narrowing of readAtsInterviewAnalysis for a known focus interview row. */
export function readAtsFocusAnalysis(value: unknown, context?: AtsJsonbContext): FocusInterviewAnalysis | null {
  return readInterviewAnalysisObject<FocusInterviewAnalysis>(value, "ats_interviews.analysis_json[focus]", context);
}

/**
 * ats_interviews.manual_ratings — operator-entered category→rating map used
 * by focus interview analysis. Missing → undefined (the optional-parameter
 * shape downstream expects); malformed → warn + undefined. Values are
 * prompt-interpolated only, so they are not deep-validated.
 */
export function readAtsManualRatings(value: unknown, context?: AtsJsonbContext): Record<string, number> | undefined {
  if (value === null || value === undefined) return undefined;
  if (!isPlainObject(value)) {
    warnMalformed("ats_interviews.manual_ratings", "a ratings object", value, context);
    return undefined;
  }
  return value as Record<string, number>;
}
