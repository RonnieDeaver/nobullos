import type { Express, Request } from "express";
import { db } from "../db";
import { eq, sql, and, inArray, desc, isNull, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { isAuthenticated } from "../middlewares/requireAuth";
import { requireTeamLead, requireCeoToolsAuth, openai, aiLimiter, jdUpload } from "./middleware";
import type { AuthenticatedRequest } from "./requestContext";
import { sanitizePromptInput, ATS_SPEC_VERSION, ATS_MODEL_ID, ScorecardJsonSchema, ResumeProfileSchema, type ResumeConsistency } from "../services/atsTypes";
// Task #4184 — module-load side effect: installs the atsJsonb malformed-event
// listener that turns [ATS JSONB] corruption warnings into operator alerts.
import "../services/atsJsonbCorruptionAlerts";
import {
  readAtsAiScore,
  readAtsAssessmentItems,
  readAtsAssessmentJson,
  readAtsClarificationAnswers,
  readAtsCognitiveProfile,
  readAtsDimensionHistory,
  readAtsFocusAnalysis,
  readAtsHardFails,
  readAtsLegacyRubric,
  readAtsManualRatings,
  readAtsPhoneAnalysis,
  readAtsReferenceAnalysis,
  readAtsResumeProfile,
  readAtsRoleSourceOfTruth,
  readAtsRubricJson,
  readAtsScorecardJson,
  readAtsScreeningQuestions,
  readAtsStoryAnalysis,
  readAtsVideoTasks,
} from "../services/atsJsonb";
import { CHEAP_MODEL } from "../aiModels";
import crypto from "crypto";
import mammoth from "mammoth";
import PDFParser from "pdf2json";
import {
  atsJobs,
  atsCandidates,
  atsSubmissions,
  atsInterviews,
  atsFinalDecisions,
  atsAiRuns,
  atsEmailTemplates,
  atsPairwiseComparisons,
} from "@shared/schema";
import {
  generateJobIntelligence, scoreCandidate,
  generateRoleSourceOfTruth, generateCognitiveProfile, generateAssessment, generateRubric,
  extractEvidence, computeLanguageAgencyScore, computeAiLikelihood, scoreCandidateV2, generateHiringCard,
  evaluateResumeConsistency,
} from "../services/atsIntelligence";
import {
  analyzePhoneInterview, analyzeStoryInterview, analyzeReferenceInterview,
  analyzeFocusInterview, generateFinalDecision,
  type PhoneInterviewAnalysis, type StoryInterviewAnalysis,
  type ReferenceInterviewAnalysis, type FocusInterviewAnalysis,
} from "../services/atsInterviewAnalysis";
import { ObjectStorageService, ObjectNotFoundError } from "../replit_integrations/object_storage/objectStorage";
import type { UploadContentConstraints } from "../replit_integrations/object_storage/uploadContentVerification";
import {
  atsCandidateVideoUploadPrefix,
  isAtsCandidateVideoObjectPath,
} from "../services/atsVideoUploads";

const descOrder = desc;
const andOp = and;
const objectStorageService = new ObjectStorageService();

// Task #3964 (audit A-006) — the portal presigned PUT cannot bind size or
// content type at mint time (sidecar signing covers host+method+expiry only),
// so submit-video re-verifies the stored bytes: they must sniff as a real
// video container within this cap. Mint and accept are additionally
// namespace-bound to the candidate (services/atsVideoUploads), so generic or
// foreign-flow uploads can never be attached as a response.
const ATS_VIDEO_UPLOAD_CONSTRAINTS: UploadContentConstraints = {
  kinds: { video: { maxBytes: 512 * 1024 * 1024 } },
};

// ─── Task #3962: cursor pagination for ATS admin lists (audit C-U2/C-U3) ───
//
// Keyset ("cursor") pagination with deterministic ordering on
// (created_at, id): id is the unique tie-breaker, so rows sharing a
// created_at can never be duplicated or skipped across a page boundary.
// The continuation cursor is an opaque base64url JSON payload
// { v, s, ts, id } where `s` pins the exact list scope the cursor was
// minted for (e.g. "submissions:<candidateId>"); replaying a cursor against
// any other scope is a 400. Tenant safety does not rest on the cursor
// alone — every query below always re-applies the path-derived scope
// filter, so a tampered cursor can only ever narrow the caller's own list,
// never widen it into another candidate/job scope.
//
// created_at is compared at millisecond precision (date_trunc on the SQL
// side) because the cursor carries an ISO-8601 millisecond timestamp while
// Postgres stores microseconds; truncating both sides keeps the keyset
// comparison exact, so two rows that differ only in microseconds resolve
// through the id tie-break instead of being skipped. COALESCE to epoch
// keeps the ordering total for NULL created_at rows (the column has no
// NOT NULL constraint).

const ATS_LIST_DEFAULT_LIMIT = 100;
const ATS_LIST_MAX_LIMIT = 500;

type AtsListCursor = { v: 1; s: string; ts: string; id: string };

function encodeAtsListCursor(payload: AtsListCursor): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeAtsListCursor(raw: string, expectedScope: string): AtsListCursor | null {
  let parsed: any;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (
    !parsed ||
    parsed.v !== 1 ||
    typeof parsed.s !== "string" ||
    typeof parsed.ts !== "string" ||
    typeof parsed.id !== "string" ||
    parsed.s !== expectedScope ||
    !Number.isFinite(Date.parse(parsed.ts))
  ) {
    return null;
  }
  return { v: 1, s: parsed.s, ts: parsed.ts, id: parsed.id };
}

/**
 * Parse `?limit=` — undefined → default, garbage/non-positive → null (the
 * caller answers 400), above the max → clamped to the max.
 */
function parseAtsListLimit(rawLimit: unknown): number | null {
  if (rawLimit === undefined) return ATS_LIST_DEFAULT_LIMIT;
  const n = Number(rawLimit);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(Math.floor(n), ATS_LIST_MAX_LIMIT);
}

/** Millisecond-truncated, NULL-total sort key for a created_at column. */
function atsListSortKey(createdAt: AnyPgColumn): SQL {
  return sql`date_trunc('milliseconds', COALESCE(${createdAt}, 'epoch'::timestamp))`;
}

function atsListOrderBy(createdAt: AnyPgColumn, id: AnyPgColumn, dir: "asc" | "desc"): SQL {
  const key = atsListSortKey(createdAt);
  return dir === "asc" ? sql`${key} ASC, ${id} ASC` : sql`${key} DESC, ${id} DESC`;
}

function atsListCursorPredicate(
  createdAt: AnyPgColumn,
  id: AnyPgColumn,
  dir: "asc" | "desc",
  cursor: AtsListCursor,
): SQL {
  const key = atsListSortKey(createdAt);
  return dir === "asc"
    ? sql`(${key}, ${id}) > (${cursor.ts}::timestamp, ${cursor.id})`
    : sql`(${key}, ${id}) < (${cursor.ts}::timestamp, ${cursor.id})`;
}

/** Slice a limit+1 overfetch into the page plus its continuation cursor. */
function atsListPageOf<T extends { createdAt: Date | null; id: string }>(
  rows: T[],
  limit: number,
  scope: string,
): { page: T[]; nextCursor: string | null } {
  if (rows.length <= limit) return { page: rows, nextCursor: null };
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    page,
    nextCursor: encodeAtsListCursor({
      v: 1,
      s: scope,
      ts: (last.createdAt ?? new Date(0)).toISOString(),
      id: last.id,
    }),
  };
}

// Task #4730 — write-time lock guard shared by both portal submit paths.
// The routes' pre-read "locked ⇒ 409" check is advisory only (not atomic with
// the write); this predicate rides ON the UPDATE / ON CONFLICT DO UPDATE so a
// row locked by a racing request can never be overwritten. COALESCE keeps the
// predicate total if no_redo is ever NULL (NOT(NULL AND …) would be NULL and
// silently skip the write for unlocked rows).
const ATS_SUBMISSION_NOT_LOCKED: SQL = sql`NOT (COALESCE(${atsSubmissions.noRedo}, false) AND ${atsSubmissions.lockedAt} IS NOT NULL)`;

export function registerAtsRoutes(app: Express) {

  app.get("/api/ats/jobs", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      // Task #3962 — bounded cursor pagination (was an unbounded full-table
      // read; audit C-U2/C-U3 closure wave). Keeps the newest-first order the
      // admin UI relies on, with id as the tie-break.
      const limit = parseAtsListLimit(req.query.limit);
      if (limit === null) {
        return res.status(400).json({ error: "limit must be a positive integer" });
      }
      const scope = "jobs";
      let cursor: AtsListCursor | null = null;
      if (req.query.cursor !== undefined) {
        cursor = decodeAtsListCursor(String(req.query.cursor), scope);
        if (!cursor) return res.status(400).json({ error: "invalid cursor" });
      }
      const rows = await db.select().from(atsJobs)
        .where(cursor ? atsListCursorPredicate(atsJobs.createdAt, atsJobs.id, "desc", cursor) : undefined)
        .orderBy(atsListOrderBy(atsJobs.createdAt, atsJobs.id, "desc"))
        .limit(limit + 1);
      const { page, nextCursor } = atsListPageOf(rows, limit, scope);
      res.json({ jobs: page, nextCursor, limit });
    } catch (error: any) {
      console.error("[ATS] Error:", error);
      res.status(500).json({ error: "ATS operation failed" });
    }
  });

  app.get("/api/ats/jobs/:id", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const [job] = await db.select().from(atsJobs).where(eq(atsJobs.id, req.params.id));
      if (!job) return res.status(404).json({ error: "Job not found" });
      res.json(job);
    } catch (error: any) {
      console.error("[ATS] Error:", error);
      res.status(500).json({ error: "ATS operation failed" });
    }
  });

  app.post("/api/ats/parse-jd", isAuthenticated, requireTeamLead, jdUpload.single("file"), async (req: any, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });

      let text = "";
      const mime = req.file.mimetype;

      if (mime === "text/plain") {
        text = req.file.buffer.toString("utf-8");
      } else if (mime === "application/pdf") {
        text = await new Promise<string>((resolve, reject) => {
          const parser = new PDFParser();
          parser.on("pdfParser_dataError", (err: any) => reject(new Error(err.parserError)));
          parser.on("pdfParser_dataReady", (pdfData: any) => {
            let extracted = "";
            if (pdfData.Pages) {
              for (const page of pdfData.Pages) {
                if (page.Texts) {
                  for (const textItem of page.Texts) {
                    if (textItem.R) {
                      for (const r of textItem.R) {
                        if (r.T) {
                          try { extracted += decodeURIComponent(r.T) + " "; }
                          catch { extracted += r.T.replace(/%/g, " ") + " "; }
                        }
                      }
                    }
                  }
                }
                extracted += "\n";
              }
            }
            resolve(extracted);
          });
          parser.parseBuffer(req.file.buffer);
        });
      } else if (mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
        const result = await mammoth.extractRawText({ buffer: req.file.buffer });
        text = result.value;
      }

      if (!text.trim()) {
        return res.status(400).json({ error: "Could not extract text from the uploaded file" });
      }

      const completion = await openai.chat.completions.create({
        model: CHEAP_MODEL,
        messages: [
          {
            role: "system",
            content: "You extract job posting information from documents. Return a JSON object with exactly two fields: \"title\" (the job title) and \"description\" (the full job description text, preserving formatting and sections). If you cannot determine a clear title, use a reasonable one from context."
          },
          {
            role: "user",
            content: `Extract the job title and full description from this document:\n\n${text.slice(0, 15000)}`
          }
        ],
        response_format: { type: "json_object" },
        reasoning_effort: "minimal",
      });

      const result = JSON.parse(completion.choices[0].message.content || "{}");
      res.json({ title: result.title || "", description: result.description || text });
    } catch (error: any) {
      console.error("[ATS] JD parse error:", error);
      res.status(500).json({ error: "ATS operation failed" });
    }
  });

  app.post("/api/ats/parse-scorecard", isAuthenticated, requireTeamLead, jdUpload.single("file"), async (req: AuthenticatedRequest, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });
      // F9: hoist the guard-narrowed file — property narrowing doesn't
      // persist into the parser callbacks below.
      const file = req.file;

      let text = "";
      const mime = file.mimetype;

      if (mime === "text/plain") {
        text = file.buffer.toString("utf-8");
      } else if (mime === "application/pdf") {
        text = await new Promise<string>((resolve, reject) => {
          const parser = new PDFParser();
          parser.on("pdfParser_dataError", (err: any) => reject(new Error(err.parserError)));
          parser.on("pdfParser_dataReady", (pdfData: any) => {
            let extracted = "";
            if (pdfData.Pages) {
              for (const page of pdfData.Pages) {
                if (page.Texts) {
                  for (const textItem of page.Texts) {
                    if (textItem.R) {
                      for (const r of textItem.R) {
                        if (r.T) {
                          try { extracted += decodeURIComponent(r.T) + " "; }
                          catch { extracted += r.T.replace(/%/g, " ") + " "; }
                        }
                      }
                    }
                  }
                }
                extracted += "\n";
              }
            }
            resolve(extracted);
          });
          parser.parseBuffer(file.buffer);
        });
      } else if (mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
        const result = await mammoth.extractRawText({ buffer: file.buffer });
        text = result.value;
      }

      if (!text.trim()) {
        return res.status(400).json({ error: "Could not extract text from the uploaded file" });
      }

      const completion = await openai.chat.completions.create({
        model: CHEAP_MODEL,
        messages: [
          {
            role: "system",
            content: `You extract hiring scorecard information from documents. Return a JSON object with this exact structure:
{
  "mission": "the role's mission statement (a concise description of what success looks like)",
  "outcomes": [{"id": "oc_0", "text": "first measurable outcome"}, {"id": "oc_1", "text": "second outcome"}, ...],
  "competencies": ["competency 1", "competency 2", ...],
  "non_negotiables": [{"id": "nn_0", "text": "first non-negotiable trait"}, {"id": "nn_1", "text": "second non-negotiable"}, ...],
  "constraints": ["constraint 1", "constraint 2", ...]
}
Rules:
- outcomes must have sequential IDs: oc_0, oc_1, oc_2, etc. Generate 3-10 outcomes.
- non_negotiables must have sequential IDs: nn_0, nn_1, nn_2, etc. Generate 3-12 non-negotiables.
- competencies should be skill/capability strings. Generate 3-10.
- constraints should describe limitations, requirements, or boundaries of the role. Generate 1-10.
- mission should be a clear, concise statement of the role's purpose.
- If the document doesn't explicitly label sections, infer the best mapping from context.
- Output ONLY valid JSON, no markdown fences.`
          },
          {
            role: "user",
            content: `Extract the scorecard from this document:\n\n${text.slice(0, 15000)}`
          }
        ],
        response_format: { type: "json_object" },
        reasoning_effort: "minimal",
      });

      const rawResult = JSON.parse(completion.choices[0].message.content || "{}");
      const scorecardJson = ScorecardJsonSchema.parse(rawResult);
      res.json({ scorecardText: text, scorecardJson });
    } catch (error: any) {
      console.error("[ATS] Scorecard parse error:", error);
      res.status(500).json({ error: "ATS operation failed" });
    }
  });

  app.post("/api/ats/jobs", isAuthenticated, requireTeamLead, async (req: AuthenticatedRequest<Record<string, string>, { title?: string; description?: string; scorecardText?: string; scorecardJson?: unknown }>, res) => {
    try {
      const { title, description, scorecardText, scorecardJson } = req.body;
      if (!title || !description) return res.status(400).json({ error: "Title and description required" });

      const inviteToken = crypto.randomBytes(24).toString("hex");
      const [job] = await db.insert(atsJobs).values({
        title,
        description,
        scorecardText: scorecardText || null,
        scorecardJson: scorecardJson || null,
        status: "draft",
        inviteToken,
        // F9: non-null — isAuthenticated guarantees a session user; the
        // original (req: any) code already relied on presence here.
        createdBy: req.user!.claims!.sub,
      }).returning();

      // Task #1574 — create-job returns 201 Created per REST conventions.
      res.status(201).json(job);
    } catch (error: any) {
      console.error("[ATS] Error:", error);
      res.status(500).json({ error: "ATS operation failed" });
    }
  });

  app.patch("/api/ats/jobs/:id", isAuthenticated, requireTeamLead, async (req: AuthenticatedRequest<{ id: string }, { title?: unknown; description?: unknown; status?: unknown; screeningQuestions?: unknown; videoTasks?: unknown; rubric?: unknown; hardFails?: unknown; scorecardText?: unknown; scorecardJson?: unknown }>, res) => {
    try {
      const { title, description, status, screeningQuestions, videoTasks, rubric, hardFails, scorecardText, scorecardJson } = req.body;
      const updates: any = { updatedAt: new Date() };
      if (title !== undefined) updates.title = title;
      if (description !== undefined) updates.description = description;
      if (status !== undefined) updates.status = status;
      if (screeningQuestions !== undefined) updates.screeningQuestions = screeningQuestions;
      if (videoTasks !== undefined) updates.videoTasks = videoTasks;
      if (rubric !== undefined) updates.rubric = rubric;
      if (hardFails !== undefined) updates.hardFails = hardFails;
      if (scorecardText !== undefined) updates.scorecardText = scorecardText;
      if (scorecardJson !== undefined) updates.scorecardJson = scorecardJson;

      const [job] = await db.update(atsJobs).set(updates).where(eq(atsJobs.id, req.params.id)).returning();
      if (!job) return res.status(404).json({ error: "Job not found" });
      res.json(job);
    } catch (error: any) {
      console.error("[ATS] Error:", error);
      res.status(500).json({ error: "ATS operation failed" });
    }
  });

  // INTENTIONALLY PUBLIC ENDPOINT (no session auth): called by an external CEO Tools
  // webhook/scheduler. Authentication is enforced via the requireCeoToolsAuth middleware,
  // which requires an Authorization Bearer token matching CEO_TOOLS_API_TOKEN.
  // F9: machine-token route (no session user) — plain express Request per
  // server/routes/requestContext.ts.
  app.post("/api/ats/jobs/:id/generate-webhook", requireCeoToolsAuth, async (req: Request<{ id: string }, unknown, { stage?: string }>, res) => {
    try {
      const [job] = await db.select().from(atsJobs).where(eq(atsJobs.id, req.params.id));
      if (!job) return res.status(404).json({ error: "Job not found" });

      const stage = req.body.stage || "all";
      const scorecardData = readAtsScorecardJson(job.scorecardJson, { jobId: job.id });
      const saveProgress = async (fields: Partial<typeof atsJobs.$inferInsert>) => {
        await db.update(atsJobs).set({ ...fields, updatedAt: new Date() })
          .where(eq(atsJobs.id, req.params.id));
      };

      let sot = readAtsRoleSourceOfTruth(job.roleSourceOfTruth, { jobId: job.id });
      let cp = readAtsCognitiveProfile(job.cognitiveProfile, { jobId: job.id });
      let assessment = readAtsAssessmentJson(job.assessmentJson, { jobId: job.id });

      const stages = stage === "all" ? [1,2,3,4]
        : stage === "3-4" ? [3,4]
        : stage === "1-2" ? [1,2]
        : [parseInt(stage)];

      for (const s of stages) {
        if (s === 1) {
          sot = await generateRoleSourceOfTruth(job.id, job.title, job.description, scorecardData ?? undefined);
          await saveProgress({ roleSourceOfTruth: sot, aiSpecVersion: ATS_SPEC_VERSION, modelId: ATS_MODEL_ID });
        } else if (s === 2) {
          if (!sot) return res.status(400).json({ error: "Stage 1 must be completed first" });
          cp = await generateCognitiveProfile(job.id, sot);
          await saveProgress({ cognitiveProfile: cp });
        } else if (s === 3) {
          if (!sot || !cp) return res.status(400).json({ error: "Stages 1-2 must be completed first" });
          const result = await generateAssessment(
            job.id, job.title, job.description, sot, cp,
            readAtsClarificationAnswers(job.clarificationAnswers, { jobId: job.id }) ?? {}
          );
          assessment = result.assessment;
          await saveProgress({
            assessmentJson: assessment,
            assessmentMeta: assessment.meta,
            screeningQuestions: result.screeningQuestions,
            videoTasks: result.videoTasks,
            hardFails: result.hardFails,
          });
        } else if (s === 4) {
          if (!sot || !cp || !assessment) return res.status(400).json({ error: "Stages 1-3 must be completed first" });
          const rubric = await generateRubric(job.id, sot, cp, assessment);
          await saveProgress({
            rubricJson: rubric,
            rubric: { dimensions: rubric.dimensions.map((d) => ({ name: d.name, weight: d.weight, criteria: d.definition })) },
            aiGeneratedAt: new Date(),
          });
        }
      }

      const [updated] = await db.select().from(atsJobs).where(eq(atsJobs.id, req.params.id));
      res.json({ success: true, stages_completed: stages, job: updated });
    } catch (error: any) {
      console.error("[ATS-WEBHOOK] Generate error:", error);
      res.status(500).json({ error: "ATS operation failed" });
    }
  });

  app.post("/api/ats/jobs/:id/generate", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const [job] = await db.select().from(atsJobs).where(eq(atsJobs.id, req.params.id));
      if (!job) return res.status(404).json({ error: "Job not found" });

      const missing: string[] = [];
      if (!job.description?.trim()) missing.push("job_description");
      if (!job.scorecardJson) missing.push("scorecard");
      if (missing.length > 0) {
        return res.status(400).json({
          error: "missing_required_inputs",
          missing,
          message: "Assessment generation requires both Job Description and Scorecard.",
        });
      }

      const scorecardData = readAtsScorecardJson(job.scorecardJson, { jobId: job.id });

      const clarificationAnswers = req.body.clarificationAnswers || job.clarificationAnswers;
      const feedback = req.body.feedback || undefined;
      const saveProgress = async (fields: Partial<typeof atsJobs.$inferInsert>) => {
        await db.update(atsJobs).set({ ...fields, updatedAt: new Date() })
          .where(eq(atsJobs.id, req.params.id));
      };

      const sot = await generateRoleSourceOfTruth(job.id, job.title, job.description, scorecardData ?? undefined, feedback);
      await saveProgress({ roleSourceOfTruth: sot, aiSpecVersion: ATS_SPEC_VERSION, modelId: ATS_MODEL_ID });

      const cp = await generateCognitiveProfile(job.id, sot, feedback);
      await saveProgress({ cognitiveProfile: cp });

      const { assessment, screeningQuestions, videoTasks, hardFails } = await generateAssessment(
        job.id, job.title, job.description, sot, cp,
        readAtsClarificationAnswers(clarificationAnswers) ?? undefined,
        feedback
      );
      await saveProgress({
        assessmentJson: assessment,
        assessmentMeta: assessment.meta,
        screeningQuestions,
        videoTasks,
        hardFails,
      });

      const rubric = await generateRubric(job.id, sot, cp, assessment, feedback);
      await saveProgress({
        rubricJson: rubric,
        rubric: {
          dimensions: rubric.dimensions.map(d => ({
            name: d.name,
            weight: d.weight,
            criteria: d.definition,
          })),
        },
        aiGeneratedAt: new Date(),
        clarificationAnswers,
        lastFeedback: feedback || null,
      });

      const [updated] = await db.select().from(atsJobs).where(eq(atsJobs.id, req.params.id));
      res.json(updated);
    } catch (error: any) {
      console.error("[ATS] Generate error:", error);
      res.status(500).json({ error: "ATS operation failed" });
    }
  });

  app.get("/api/ats/jobs/:jobId/candidates", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      // Task #4005 — candidates list joins the Task #3962 cursor envelope
      // ({ candidates, nextCursor, limit }) so the kanban can load beyond the
      // first page on demand like jobs/submissions/interviews. This replaces
      // the Task #1810 offset envelope ({ candidates, total, limit, offset }):
      // offset paging duplicated/skipped rows under concurrent inserts and the
      // unconditional COUNT(*) ran on every page. The path-derived jobId scope
      // is always re-applied, so a tampered cursor can only narrow this job's
      // list, never widen into another job's candidates.
      const limit = parseAtsListLimit(req.query.limit);
      if (limit === null) {
        return res.status(400).json({ error: "limit must be a positive integer" });
      }
      if (req.query.offset !== undefined) {
        // Explicitly reject the retired Task #1810 offset param instead of
        // silently ignoring it — a stale caller would otherwise loop on page 1.
        return res.status(400).json({ error: "offset is no longer supported; use cursor" });
      }
      const scope = `candidates:${req.params.jobId}`;
      let cursor: AtsListCursor | null = null;
      if (req.query.cursor !== undefined) {
        cursor = decodeAtsListCursor(String(req.query.cursor), scope);
        if (!cursor) return res.status(400).json({ error: "invalid cursor" });
      }
      const jobScope = eq(atsCandidates.jobId, req.params.jobId);
      const rows = await db.select().from(atsCandidates)
        .where(cursor
          ? and(jobScope, atsListCursorPredicate(atsCandidates.createdAt, atsCandidates.id, "desc", cursor))
          : jobScope)
        .orderBy(atsListOrderBy(atsCandidates.createdAt, atsCandidates.id, "desc"))
        .limit(limit + 1);
      const { page, nextCursor } = atsListPageOf(rows, limit, scope);
      res.json({ candidates: page, nextCursor, limit });
    } catch (error: any) {
      console.error("[ATS] Error:", error);
      res.status(500).json({ error: "ATS operation failed" });
    }
  });

  app.post("/api/ats/jobs/:jobId/candidates", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const { name, email, phone, tags } = req.body;
      if (!name || !email) return res.status(400).json({ error: "Name and email required" });

      const accessToken = crypto.randomBytes(32).toString("hex");
      const [candidate] = await db.insert(atsCandidates).values({
        jobId: req.params.jobId,
        name,
        email,
        phone,
        tags,
        accessToken,
        stage: "applied",
      }).returning();

      // Task #1574 — create-candidate returns 201 Created per REST conventions.
      res.status(201).json(candidate);
    } catch (error: any) {
      console.error("[ATS] Error:", error);
      res.status(500).json({ error: "ATS operation failed" });
    }
  });

  app.post("/api/ats/jobs/:jobId/candidates/bulk", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const { candidates: candidateList } = req.body;
      if (!Array.isArray(candidateList) || candidateList.length === 0) {
        return res.status(400).json({ error: "Candidates array required" });
      }

      const results = [];
      for (const c of candidateList) {
        if (!c.name || !c.email) continue;
        const accessToken = crypto.randomBytes(32).toString("hex");
        const [candidate] = await db.insert(atsCandidates).values({
          jobId: req.params.jobId,
          name: c.name,
          email: c.email,
          phone: c.phone,
          tags: c.tags,
          accessToken,
          stage: "applied",
        }).returning();
        results.push(candidate);
      }

      res.json({ created: results.length, candidates: results });
    } catch (error: any) {
      console.error("[ATS] Error:", error);
      res.status(500).json({ error: "ATS operation failed" });
    }
  });

  app.patch("/api/ats/candidates/:id", isAuthenticated, requireTeamLead, async (req: AuthenticatedRequest<{ id: string }, { stage?: string; notes?: unknown; tags?: unknown; manualScore?: unknown }>, res) => {
    try {
      const { stage: rawStage, notes, tags, manualScore } = req.body;
      const stage = rawStage === "answers_received" ? "screening" : rawStage;
      const updates: any = { updatedAt: new Date() };

      let oldCandidate: any = null;
      if (stage !== undefined) {
        [oldCandidate] = await db.select().from(atsCandidates).where(eq(atsCandidates.id, req.params.id));
        updates.stage = stage;
        if (stage === "invited") updates.invitedAt = new Date();
        if (stage === "rejected") updates.rejectedAt = new Date();
        if (stage === "review") updates.reviewedAt = new Date();
      }
      if (notes !== undefined) updates.notes = notes;
      if (tags !== undefined) updates.tags = tags;

      const [candidate] = await db.update(atsCandidates).set(updates)
        .where(eq(atsCandidates.id, req.params.id)).returning();
      if (!candidate) return res.status(404).json({ error: "Candidate not found" });

      if (stage !== undefined && oldCandidate && candidate.totalScore != null && oldCandidate.stage !== stage) {
        import("../services/atsCohortCalibration").then(m => {
          const wasActive = m.COHORT_ACTIVE_STAGES.has(oldCandidate.stage);
          const isNowActive = m.COHORT_ACTIVE_STAGES.has(stage);
          const movingToTerminal = m.COHORT_TERMINAL_STAGES.has(stage);
          const restoringFromTerminal = m.COHORT_TERMINAL_STAGES.has(oldCandidate.stage) && isNowActive;
          if ((wasActive && movingToTerminal) || restoringFromTerminal || (wasActive !== isNowActive)) {
            m.recalibrateRoleCohort(candidate.jobId).catch(e => console.error("[Cohort Calibration] Stage-change recalibration error:", e.message));
          }
        }).catch(e => console.error("[Cohort Calibration] Import error:", e.message));
      }

      res.json(candidate);
    } catch (error: any) {
      console.error("[ATS] Error:", error);
      res.status(500).json({ error: "ATS operation failed" });
    }
  });

  app.delete("/api/ats/candidates/:id", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const candidateId = req.params.id;
      const [candidate] = await db.select().from(atsCandidates).where(eq(atsCandidates.id, candidateId));
      if (!candidate) return res.status(404).json({ error: "Candidate not found" });

      const jobId = candidate.jobId;
      const hadScore = candidate.totalScore != null;
      const oldStage = candidate.stage;

      await db.transaction(async (tx) => {
        await tx.delete(atsSubmissions).where(eq(atsSubmissions.candidateId, candidateId));
        await tx.delete(atsInterviews).where(eq(atsInterviews.candidateId, candidateId));
        await tx.delete(atsFinalDecisions).where(eq(atsFinalDecisions.candidateId, candidateId));
        await tx.delete(atsAiRuns).where(eq(atsAiRuns.candidateId, candidateId));
        await tx.delete(atsCandidates).where(eq(atsCandidates.id, candidateId));
      });

      if (hadScore) {
        import("../services/atsCohortCalibration").then(m => {
          if (m.COHORT_ACTIVE_STAGES.has(oldStage)) {
            m.recalibrateRoleCohort(jobId).catch(e => console.error("[Cohort Calibration] Deletion recalibration error:", e.message));
          }
        }).catch(e => console.error("[Cohort Calibration] Import error:", e.message));
      }

      res.json({ success: true, deletedCandidate: candidate.name });
    } catch (error: any) {
      console.error("[ATS] Error:", error);
      res.status(500).json({ error: "ATS operation failed" });
    }
  });

  app.get("/api/ats/candidates/:id/submissions", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      // Task #3962 — cursor-paginated (was unbounded; audit C-U2). Keeps the
      // pre-pagination chronological (created_at ASC) order with id as the
      // tie-break. The candidate_id filter always comes from the path, so a
      // cursor can never cross into another candidate's submissions.
      const limit = parseAtsListLimit(req.query.limit);
      if (limit === null) {
        return res.status(400).json({ error: "limit must be a positive integer" });
      }
      const scope = `submissions:${req.params.id}`;
      let cursor: AtsListCursor | null = null;
      if (req.query.cursor !== undefined) {
        cursor = decodeAtsListCursor(String(req.query.cursor), scope);
        if (!cursor) return res.status(400).json({ error: "invalid cursor" });
      }
      const conditions: SQL[] = [eq(atsSubmissions.candidateId, req.params.id)];
      if (cursor) {
        conditions.push(atsListCursorPredicate(atsSubmissions.createdAt, atsSubmissions.id, "asc", cursor));
      }
      const rows = await db.select().from(atsSubmissions)
        .where(and(...conditions))
        .orderBy(atsListOrderBy(atsSubmissions.createdAt, atsSubmissions.id, "asc"))
        .limit(limit + 1);
      const { page, nextCursor } = atsListPageOf(rows, limit, scope);
      res.json({ submissions: page, nextCursor, limit });
    } catch (error: any) {
      console.error("[ATS] Error:", error);
      res.status(500).json({ error: "ATS operation failed" });
    }
  });

  app.post("/api/ats/candidates/:id/upload-resume", isAuthenticated, requireTeamLead, jdUpload.single("file"), async (req: AuthenticatedRequest<{ id: string }>, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });
      // F9: hoist the guard-narrowed file — property narrowing doesn't
      // persist into the parser callbacks below.
      const file = req.file;

      const [candidate] = await db.select().from(atsCandidates)
        .where(eq(atsCandidates.id, req.params.id));
      if (!candidate) return res.status(404).json({ error: "Candidate not found" });

      let text = "";
      const mime = file.mimetype;

      if (mime === "text/plain") {
        text = file.buffer.toString("utf-8");
      } else if (mime === "application/pdf") {
        text = await new Promise<string>((resolve, reject) => {
          const parser = new PDFParser();
          parser.on("pdfParser_dataError", (err: any) => reject(new Error(err.parserError)));
          parser.on("pdfParser_dataReady", (pdfData: any) => {
            let extracted = "";
            if (pdfData.Pages) {
              for (const page of pdfData.Pages) {
                if (page.Texts) {
                  for (const textItem of page.Texts) {
                    if (textItem.R) {
                      for (const r of textItem.R) {
                        if (r.T) {
                          try { extracted += decodeURIComponent(r.T) + " "; }
                          catch { extracted += r.T.replace(/%/g, " ") + " "; }
                        }
                      }
                    }
                  }
                }
                extracted += "\n";
              }
            }
            resolve(extracted);
          });
          parser.parseBuffer(file.buffer);
        });
      } else if (mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
        const result = await mammoth.extractRawText({ buffer: file.buffer });
        text = result.value;
      }

      if (!text.trim()) {
        return res.status(400).json({ error: "Could not extract text from the uploaded file" });
      }

      const completion = await openai.chat.completions.create({
        model: CHEAP_MODEL,
        messages: [
          {
            role: "system",
            content: "You parse resumes into structured profiles. Output ONLY valid JSON."
          },
          {
            role: "user",
            content: `Parse this resume into a structured profile.\n\nResume text:\n${text.slice(0, 15000)}\n\nOutput this exact JSON structure:\n{\n  "years_experience_estimate": number or null,\n  "recent_roles": [{"title": "job title", "dates": "date range"}],\n  "skills_claimed": ["skill1", "skill2"],\n  "tools_claimed": ["tool1", "tool2"],\n  "domain_claims": ["domain1", "domain2"],\n  "leadership_claims": ["claim1"],\n  "project_scale_claims": ["claim1"],\n  "credential_claims": ["credential1"]\n}\n\nRules:\n- years_experience_estimate: total years of professional experience, null if unclear\n- recent_roles: most recent 5-10 positions with titles and date ranges\n- skills_claimed: technical and soft skills mentioned\n- tools_claimed: software, platforms, tools mentioned\n- domain_claims: industry/domain expertise claimed\n- leadership_claims: management, team lead, or leadership experience\n- project_scale_claims: scale indicators (team size, budget, revenue impact)\n- credential_claims: degrees, certifications, licenses`
          }
        ],
        response_format: { type: "json_object" },
        reasoning_effort: "minimal",
      });

      const rawResult = JSON.parse(completion.choices[0].message.content || "{}");
      const parsed = ResumeProfileSchema.parse(rawResult);

      await db.update(atsCandidates).set({
        resumeText: text,
        resumeProfileJson: parsed,
        updatedAt: new Date(),
      }).where(eq(atsCandidates.id, candidate.id));

      res.json({ resumeProfile: parsed });
    } catch (error: any) {
      console.error("[ATS] Resume upload error:", error);
      res.status(500).json({ error: "ATS operation failed" });
    }
  });

  // F9: machine-token route (no session user) — plain express Request per
  // server/routes/requestContext.ts.
  app.post("/api/ats/batch-rescore", requireCeoToolsAuth, (req: Request<Record<string, string>, unknown, { candidateIds?: unknown }>, res) => {
    try {
      const { candidateIds } = req.body;
      if (!Array.isArray(candidateIds) || candidateIds.length === 0) {
        return res.status(400).json({ error: "candidateIds array required" });
      }
      if (candidateIds.length > 20) {
        return res.status(400).json({ error: "Max 20 candidates per batch" });
      }

      res.json({ status: "started", count: candidateIds.length });

      // fire-and-forget after response sent: batch rescore, errors logged inside
      void (async () => {
        const jobIds = new Set<string>();
        for (const candidateId of candidateIds) {
          try {
            const [candidate] = await db.select().from(atsCandidates).where(eq(atsCandidates.id, candidateId));
            if (!candidate) { continue; }
            const [job] = await db.select().from(atsJobs).where(eq(atsJobs.id, candidate.jobId));
            if (!job?.rubric || !job?.screeningQuestions) { continue; }
            jobIds.add(job.id);

            const submissions = await db.select().from(atsSubmissions).where(eq(atsSubmissions.candidateId, candidateId));
            const assessmentItems = readAtsAssessmentItems(job.assessmentJson, { jobId: job.id });
            const allQuestions = [...readAtsScreeningQuestions(job.screeningQuestions, { jobId: job.id }), ...readAtsVideoTasks(job.videoTasks, { jobId: job.id })];
            const submissionData = submissions.map(s => {
              const question = allQuestions.find((q) => q.id === s.questionId);
              const assessmentItem = assessmentItems.find((a) => a.id === s.questionId);
              let videoDurationSec: number | undefined;
              if (s.questionType === "video") {
                videoDurationSec = s.videoDurationSec != null ? s.videoDurationSec : (s.responseText?.match(/\[Video response - (\d+)s\]/)?.[1] ? parseInt(s.responseText!.match(/\[Video response - (\d+)s\]/)![1]) : 0);
              }
              return {
                questionId: s.questionId, questionPrompt: question?.prompt || assessmentItem?.prompt || "Unknown question",
                questionType: s.questionType, responseText: s.responseText || undefined, transcriptText: s.transcriptText || undefined,
                videoDurationSec: s.questionType === "video" ? videoDurationSec : undefined,
                maxDurationSec: s.questionType === "video" ? ((question && "durationSec" in question ? question.durationSec : undefined) || assessmentItem?.duration_sec || undefined) : undefined,
                transcriptionStatus: s.questionType === "video" ? (s.transcriptionStatus || null) : undefined,
                layer: assessmentItem?.layer || s.questionLayer || undefined,
                contradictionPairId: assessmentItem?.contradiction_pair_id || s.contradictionPairId || undefined,
                contradictionRole: assessmentItem?.contradiction_role || s.contradictionRole || undefined,
                traitTarget: assessmentItem?.trait_target || s.traitTarget || undefined,
                isTimed: assessmentItem?.is_timed || s.isTimed || false,
                timeUsedSec: s.timeUsedSec || undefined, timeLimitSec: assessmentItem?.time_limit_sec || s.timeLimitSec || undefined,
                pasteEvents: s.pasteEvents || 0,
                timeToFirstKeystrokeSec: s.timeToFirstKeystrokeSec || undefined,
                totalTypingTimeSec: s.totalTypingTimeSec || undefined,
              };
            });

            const hasV2Pipeline = job.roleSourceOfTruth && job.cognitiveProfile && job.rubricJson;
            if (!hasV2Pipeline) { continue; }

            const sot = readAtsRoleSourceOfTruth(job.roleSourceOfTruth, { jobId: job.id });
            const cp = readAtsCognitiveProfile(job.cognitiveProfile, { jobId: job.id });
            const rubricJson = readAtsRubricJson(job.rubricJson, { jobId: job.id });
            if (!sot || !cp || !rubricJson) {
              throw new Error("v2 pipeline artifacts failed to decode (role source of truth / cognitive profile / rubric)");
            }

            const { markers: evidenceMarkers, agencyFeaturesMap } = await extractEvidence(job.id, candidate.id,
              submissionData.map(s => ({ questionId: s.questionId, questionPrompt: s.questionPrompt, responseText: s.responseText || s.transcriptText || "", layer: s.layer })), sot);

            for (const marker of evidenceMarkers) {
              const matchingSub = submissions.find(s => s.questionId === marker.question_id);
              if (matchingSub) {
                await db.update(atsSubmissions).set({ evidenceMarkers: marker }).where(eq(atsSubmissions.id, matchingSub.id));
              }
            }

            const languageAgency = computeLanguageAgencyScore(agencyFeaturesMap, submissionData.map(s => ({ questionId: s.questionId, layer: s.layer })));
            const aiLikelihood = computeAiLikelihood(evidenceMarkers, submissionData, agencyFeaturesMap);
            const scoringResult = await scoreCandidateV2(job.id, candidate.id, job.title, rubricJson, readAtsHardFails(job.hardFails, { jobId: job.id }), evidenceMarkers, submissionData, sot, cp, languageAgency);

            let resumeConsistencyResult: ResumeConsistency | undefined = undefined;
            const resumeProfile = readAtsResumeProfile(candidate.resumeProfileJson, { candidateId: candidate.id });
            if (resumeProfile) {
              try {
                const consistencySubs = submissionData.filter(s => s.responseText || s.transcriptText).map(s => ({ questionId: s.questionId, questionText: s.questionPrompt, responseText: s.responseText || s.transcriptText || "" }));
                resumeConsistencyResult = await evaluateResumeConsistency(job.id, candidate.id, resumeProfile, consistencySubs, sot);
              } catch (err: any) {
                // F10 (Task #4156): optional enrichment — scoring must
                // proceed without it — but silently dropping the
                // resume-consistency component made hiring cards
                // unexplainably thinner. One warn per scoring run.
                console.warn(
                  `[ATS] resume-consistency evaluation failed for job=${job.id} candidate=${candidate.id} (scoring continues without it): ${err?.message ?? String(err)}`,
                );
              }
            }

            const hiringCard = await generateHiringCard(job.id, candidate.id, candidate.name, job.title, scoringResult, evidenceMarkers, cp, languageAgency, aiLikelihood, resumeConsistencyResult);
            const existingCohortMult = candidate.calibrationMultiplier ?? 1.0;
            const newBaseScore = scoringResult.final_score;
            const newDisplayScore = Math.round(newBaseScore * existingCohortMult * 100) / 100;

            await db.update(atsCandidates).set({
              totalScore: scoringResult.final_score, assessmentBaseScore: newBaseScore, finalDisplayScore: newDisplayScore,
              aiScoreJson: scoringResult,
              evidenceJson: { markers: evidenceMarkers, language_agency: languageAgency, ai_likelihood: aiLikelihood },
              hiringCardJson: hiringCard,
              resumeConsistencyJson: resumeConsistencyResult ? resumeConsistencyResult : undefined,
              riskTier: scoringResult.risk_tier, fitDelta: scoringResult.fit_delta,
              languageAgencyScore: languageAgency.overall_score, agencyUnderPressure: languageAgency.agency_under_pressure, agencyConsistency: languageAgency.agency_consistency,
              aiLikelihoodScore: aiLikelihood.ai_likelihood_score, aiAssistanceFlag: aiLikelihood.ai_assistance_flag,
              aiSpecVersion: ATS_SPEC_VERSION, modelId: ATS_MODEL_ID, aiScoredAt: new Date(),
              evidenceStageCount: 1,
              dimensionHistory: [{ stage: "assessment", scores: { role_skill: scoringResult.role_skill_score, role_behavior: scoringResult.role_behavior_score, reality_based_mindset: scoringResult.reality_based_score, personality_alignment: scoringResult.personality_alignment_score, communication_clarity: scoringResult.communication_clarity_score }, base_total: scoringResult.base_total, timestamp: new Date().toISOString() }],
              updatedAt: new Date(),
            }).where(eq(atsCandidates.id, candidateId));

          } catch (err: any) {
            console.error(`[Batch Rescore] Error scoring ${candidateId}: ${err.message}`);
          }
        }

        for (const candidateId of candidateIds) {
          const interviews = await db.select().from(atsInterviews)
            .where(and(eq(atsInterviews.candidateId, candidateId), eq(atsInterviews.analysisStatus, "analyzed")));
          if (interviews.length > 0) {
            const { reEvaluateDimensions } = await import("../services/atsUnifiedScoring");
            for (const interview of interviews) {
              try {
                const reEvalResult = await reEvaluateDimensions(candidateId, interview.interviewType);
                const [cand] = await db.select().from(atsCandidates).where(eq(atsCandidates.id, candidateId));
                if (cand) {
                  const existingHistory = readAtsDimensionHistory(cand.dimensionHistory, { candidateId: cand.id });
                  const existingCohortMult = cand.calibrationMultiplier ?? 1.0;
                  const newDisplay = Math.round(reEvalResult.newAssessmentBaseScore * existingCohortMult * 100) / 100;
                  const currentAiJson = readAtsAiScore(cand.aiScoreJson, { candidateId: cand.id }) ?? {};
                  await db.update(atsCandidates).set({
                    assessmentBaseScore: reEvalResult.newAssessmentBaseScore,
                    totalScore: reEvalResult.newAssessmentBaseScore,
                    finalDisplayScore: newDisplay,
                    evidenceStageCount: reEvalResult.evidenceStageCount,
                    dimensionHistory: [...existingHistory, reEvalResult.dimensionHistoryEntry],
                    aiScoreJson: {
                      ...currentAiJson,
                      dimension_scores: reEvalResult.newDimensionScores,
                    },
                    updatedAt: new Date(),
                  }).where(eq(atsCandidates.id, candidateId));
                }
              } catch (err: any) { console.error(`[Batch Rescore] Re-eval error: ${err.message}`); }
            }
          }
        }

        for (const jobId of jobIds) {
          try {
            const { recalibrateRoleCohort } = await import("../services/atsCohortCalibration");
            await recalibrateRoleCohort(jobId);
          } catch (err: any) { console.error(`[Batch Rescore] Recalibration error: ${err.message}`); }
        }
        console.log("[Batch Rescore] Complete");
      })();
    } catch (error: any) {
      console.error("[Batch Rescore] Error:", error);
      res.status(500).json({ error: "Batch rescore failed" });
    }
  });

  app.post("/api/ats/candidates/:id/score", isAuthenticated, requireTeamLead, aiLimiter, async (req: any, res: any) => {
    try {
      const [candidate] = await db.select().from(atsCandidates)
        .where(eq(atsCandidates.id, req.params.id));
      if (!candidate) return res.status(404).json({ error: "Candidate not found" });

      const [job] = await db.select().from(atsJobs)
        .where(eq(atsJobs.id, candidate.jobId));
      if (!job || !job.rubric || !job.screeningQuestions) {
        return res.status(400).json({ error: "Job must have AI-generated rubric and questions" });
      }

      const submissions = await db.select().from(atsSubmissions)
        .where(eq(atsSubmissions.candidateId, candidate.id));

      const needsTranscription = submissions.filter(s =>
        s.questionType === "video" && s.videoObjectKey &&
        (s.transcriptionStatus === "pending" || s.transcriptionStatus === "processing" || s.transcriptionStatus === "failed" || (s.transcriptionStatus !== "completed" && !s.transcriptText))
      );

      if (needsTranscription.length > 0) {
        const failedCount = needsTranscription.filter(s => s.transcriptionStatus === "failed").length;
        if (failedCount > 0) {
          await db.update(atsSubmissions).set({ transcriptionStatus: "pending", transcriptText: null, revJobId: null })
            .where(sql`${atsSubmissions.candidateId} = ${candidate.id} AND ${atsSubmissions.questionType} = 'video' AND ${atsSubmissions.transcriptionStatus} = 'failed'`);
        }
        const { transcribeVideoSubmission } = await import("../services/atsTranscription");
        console.log(`[ATS Score] Waiting for ${needsTranscription.length} transcriptions (${failedCount} retries)...`);
        const transcriptionResults = await Promise.allSettled(needsTranscription.map(s => transcribeVideoSubmission(s.id)));
        for (const tr of transcriptionResults) {
          if (tr.status === "rejected") console.error("[ATS Score] Transcription failed:", tr.reason);
        }
        const refreshed = await db.select().from(atsSubmissions)
          .where(eq(atsSubmissions.candidateId, candidate.id));
        submissions.length = 0;
        submissions.push(...refreshed);
      }

      const assessmentItems = readAtsAssessmentItems(job.assessmentJson, { jobId: job.id });
      const allQuestions = [
        ...readAtsScreeningQuestions(job.screeningQuestions, { jobId: job.id }),
        ...readAtsVideoTasks(job.videoTasks, { jobId: job.id }),
      ];

      const submissionData = submissions.map(s => {
        const question = allQuestions.find((q) => q.id === s.questionId);
        const assessmentItem = assessmentItems.find((a) => a.id === s.questionId);
        let videoDurationSec: number | undefined;
        if (s.questionType === "video") {
          if (s.videoDurationSec != null) {
            videoDurationSec = s.videoDurationSec;
          } else {
            const durationMatch = s.responseText?.match(/\[Video response - (\d+)s\]/);
            videoDurationSec = durationMatch ? parseInt(durationMatch[1]) : 0;
          }
        }
        const maxDurationSec = (question && "durationSec" in question ? question.durationSec : undefined) || assessmentItem?.duration_sec || undefined;
        return {
          questionId: s.questionId,
          questionPrompt: question?.prompt || assessmentItem?.prompt || "Unknown question",
          questionType: s.questionType,
          responseText: s.responseText || undefined,
          transcriptText: s.transcriptText || undefined,
          videoDurationSec: s.questionType === "video" ? videoDurationSec : undefined,
          maxDurationSec: s.questionType === "video" ? maxDurationSec : undefined,
          transcriptionStatus: s.questionType === "video" ? (s.transcriptionStatus || null) : undefined,
          layer: assessmentItem?.layer || s.questionLayer || undefined,
          contradictionPairId: assessmentItem?.contradiction_pair_id || s.contradictionPairId || undefined,
          contradictionRole: assessmentItem?.contradiction_role || s.contradictionRole || undefined,
          traitTarget: assessmentItem?.trait_target || s.traitTarget || undefined,
          isTimed: assessmentItem?.is_timed || s.isTimed || false,
          timeUsedSec: s.timeUsedSec || undefined,
          timeLimitSec: assessmentItem?.time_limit_sec || s.timeLimitSec || undefined,
          pasteEvents: s.pasteEvents || 0,
          timeToFirstKeystrokeSec: s.timeToFirstKeystrokeSec || undefined,
          totalTypingTimeSec: s.totalTypingTimeSec || undefined,
        };
      });

      const hasV2Pipeline = job.roleSourceOfTruth && job.cognitiveProfile && job.rubricJson;

      if (hasV2Pipeline) {
        const sot = readAtsRoleSourceOfTruth(job.roleSourceOfTruth, { jobId: job.id });
        const cp = readAtsCognitiveProfile(job.cognitiveProfile, { jobId: job.id });
        const rubricJson = readAtsRubricJson(job.rubricJson, { jobId: job.id });
        if (!sot || !cp || !rubricJson) {
          throw new Error("v2 pipeline artifacts failed to decode (role source of truth / cognitive profile / rubric)");
        }

        console.log("[ATS Score V2] Stage 1: Extracting evidence...");
        const { markers: evidenceMarkers, agencyFeaturesMap } = await extractEvidence(
          job.id,
          candidate.id,
          submissionData.map(s => ({
            questionId: s.questionId,
            questionPrompt: s.questionPrompt,
            responseText: s.responseText || s.transcriptText || "",
            layer: s.layer,
          })),
          sot
        );

        for (const marker of evidenceMarkers) {
          const matchingSub = submissions.find(s => s.questionId === marker.question_id);
          if (matchingSub) {
            await db.update(atsSubmissions).set({
              evidenceMarkers: marker,
            }).where(eq(atsSubmissions.id, matchingSub.id));
          }
        }

        console.log("[ATS Score V2] Stage 1.5: Computing language agency score...");
        const languageAgency = computeLanguageAgencyScore(
          agencyFeaturesMap,
          submissionData.map(s => ({ questionId: s.questionId, layer: s.layer }))
        );
        console.log(`[ATS Score V2] Language Agency: overall=${languageAgency.overall_score}, under_pressure=${languageAgency.agency_under_pressure}, consistency=${languageAgency.agency_consistency}`);

        console.log("[ATS Score V2] Stage 1.6: Computing AI likelihood...");
        const aiLikelihood = computeAiLikelihood(evidenceMarkers, submissionData, agencyFeaturesMap);

        const scoringResult = await scoreCandidateV2(
          job.id, candidate.id, job.title,
          rubricJson, readAtsHardFails(job.hardFails, { jobId: job.id }),
          evidenceMarkers, submissionData, sot, cp,
          languageAgency
        );

        let resumeConsistencyResult: ResumeConsistency | undefined = undefined;
        const resumeProfile = readAtsResumeProfile(candidate.resumeProfileJson, { candidateId: candidate.id });
        if (resumeProfile) {
          try {
            const consistencySubmissions = submissionData
              .filter(s => s.responseText || s.transcriptText)
              .map(s => ({
                questionId: s.questionId,
                questionText: s.questionPrompt,
                responseText: s.responseText || s.transcriptText || "",
              }));
            resumeConsistencyResult = await evaluateResumeConsistency(
              job.id, candidate.id, resumeProfile, consistencySubmissions, sot
            );
          } catch (rcErr: any) {
            console.error("[ATS Score V2] Resume consistency evaluation failed (non-fatal):", rcErr.message);
          }
        }

        const hiringCard = await generateHiringCard(
          job.id, candidate.id, candidate.name, job.title,
          scoringResult, evidenceMarkers, cp,
          languageAgency, aiLikelihood, resumeConsistencyResult
        );

        const existingCohortMult = candidate.calibrationMultiplier ?? 1.0;
        const newBaseScore = scoringResult.final_score;
        const newDisplayScore = Math.round(newBaseScore * existingCohortMult * 100) / 100;
        const baseScoreFields = {
          assessmentBaseScore: newBaseScore,
          finalDisplayScore: newDisplayScore,
        };

        await db.update(atsCandidates).set({
          totalScore: scoringResult.final_score,
          ...baseScoreFields,
          aiScoreJson: scoringResult,
          evidenceJson: { markers: evidenceMarkers, language_agency: languageAgency, ai_likelihood: aiLikelihood },
          hiringCardJson: hiringCard,
          resumeConsistencyJson: resumeConsistencyResult ? resumeConsistencyResult : undefined,
          riskTier: scoringResult.risk_tier,
          fitDelta: scoringResult.fit_delta,
          languageAgencyScore: languageAgency.overall_score,
          agencyUnderPressure: languageAgency.agency_under_pressure,
          agencyConsistency: languageAgency.agency_consistency,
          aiLikelihoodScore: aiLikelihood.ai_likelihood_score,
          aiAssistanceFlag: aiLikelihood.ai_assistance_flag,
          aiSpecVersion: ATS_SPEC_VERSION,
          modelId: ATS_MODEL_ID,
          aiScoredAt: new Date(),
          stage: "ai_scored",
          evidenceStageCount: 1,
          updatedAt: new Date(),
        }).where(eq(atsCandidates.id, candidate.id));


        import("../services/atsUnifiedScoring").then(async (m) => {
          try {
            const interviews = await db.select().from(atsInterviews)
              .where(and(eq(atsInterviews.candidateId, candidate.id), eq(atsInterviews.analysisStatus, "analyzed")));
            if (interviews.length > 0) {
              const latestInterview = interviews.sort((a, b) => 
                new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime()
              )[0];
              const reEvalResult = await m.reEvaluateDimensions(candidate.id, latestInterview.interviewType);
              const [freshCandidate] = await db.select().from(atsCandidates).where(eq(atsCandidates.id, candidate.id));
              if (freshCandidate) {
                const existingHistory = readAtsDimensionHistory(freshCandidate.dimensionHistory, { candidateId: freshCandidate.id });
                const cohortMult = freshCandidate.calibrationMultiplier ?? 1.0;
                const newDisplay = Math.round(reEvalResult.newAssessmentBaseScore * cohortMult * 100) / 100;
                const currentAiJson = readAtsAiScore(freshCandidate.aiScoreJson, { candidateId: freshCandidate.id }) ?? {};
                await db.update(atsCandidates).set({
                  assessmentBaseScore: reEvalResult.newAssessmentBaseScore,
                  totalScore: reEvalResult.newAssessmentBaseScore,
                  finalDisplayScore: newDisplay,
                  evidenceStageCount: reEvalResult.evidenceStageCount,
                  dimensionHistory: [...existingHistory, reEvalResult.dimensionHistoryEntry],
                  aiScoreJson: { ...currentAiJson, dimension_scores: reEvalResult.newDimensionScores },
                  updatedAt: new Date(),
                }).where(eq(atsCandidates.id, candidate.id));
              }
            }
          } catch (e: any) {
            console.error("[Unified Scoring] Background re-evaluation error:", e.message);
          }
          try {
            const cohort = await import("../services/atsCohortCalibration");
            await cohort.recalibrateRoleCohort(job.id);
          } catch (e: any) {
            console.error("[Cohort Calibration] Background recalibration error:", e.message);
          }
        }).catch(e => console.error("[Unified Scoring] Import error:", e.message));

        res.json({ ...scoringResult, hiringCard });
      } else {
        const legacyRubric = readAtsLegacyRubric(job.rubric, { jobId: job.id });
        if (!legacyRubric) {
          throw new Error("legacy rubric failed to decode");
        }
        const result = await scoreCandidate(
          job.title,
          legacyRubric,
          readAtsHardFails(job.hardFails, { jobId: job.id }),
          submissionData
        );

        const existingCohortMultV1 = candidate.calibrationMultiplier ?? 1.0;
        const newBaseScoreV1 = result.totalScore;
        const newDisplayScoreV1 = Math.round(newBaseScoreV1 * existingCohortMultV1 * 100) / 100;
        const baseFieldsV1 = {
          assessmentBaseScore: newBaseScoreV1,
          finalDisplayScore: newDisplayScoreV1,
        };

        await db.update(atsCandidates).set({
          totalScore: result.totalScore,
          ...baseFieldsV1,
          aiScoreJson: result,
          aiScoredAt: new Date(),
          stage: "ai_scored",
          evidenceStageCount: 1,
          updatedAt: new Date(),
        }).where(eq(atsCandidates.id, candidate.id));

        import("../services/atsCohortCalibration").then(m => m.recalibrateRoleCohort(job.id)).catch(e => console.error("[Cohort Calibration] Background recalibration error:", e.message));
        res.json(result);
      }
    } catch (error: any) {
      console.error("[ATS] Score error:", error);
      res.status(500).json({ error: "ATS operation failed" });
    }
  });

  // Public candidate portal routes (no auth, token-based)
  app.get("/api/ats/portal/:token", async (req, res) => {
    try {
      const [candidate] = await db.select().from(atsCandidates)
        .where(eq(atsCandidates.accessToken, req.params.token));
      if (!candidate) return res.status(404).json({ error: "Invalid or expired link" });

      const [job] = await db.select().from(atsJobs)
        .where(eq(atsJobs.id, candidate.jobId));
      if (!job || job.status !== "active") {
        return res.status(404).json({ error: "This position is no longer accepting applications" });
      }

      const existingSubmissions = await db.select().from(atsSubmissions)
        .where(eq(atsSubmissions.candidateId, candidate.id));

      // Raw passthrough by design: the portal payload echoes the stored
      // assessment container byte-for-byte; nothing is dereferenced here.
      const assessmentJson = job.assessmentJson;

      res.json({
        candidate: {
          id: candidate.id,
          name: candidate.name,
          stage: candidate.stage,
        },
        job: {
          title: job.title,
          screeningQuestions: job.screeningQuestions,
          videoTasks: job.videoTasks,
          assessmentJson: assessmentJson || null,
        },
        submissions: existingSubmissions.map(s => ({
          questionId: s.questionId,
          questionType: s.questionType,
          hasResponse: !!(s.responseText || s.videoObjectKey),
          responseText: s.responseText || null,
          videoObjectKey: s.videoObjectKey || null,
          questionLayer: s.questionLayer || null,
          isTimed: s.isTimed || false,
          noRedo: s.noRedo || false,
          lockedAt: s.lockedAt || null,
          timeUsedSec: s.timeUsedSec || null,
        })),
      });
    } catch (error: any) {
      console.error("[ATS] Error:", error);
      res.status(500).json({ error: "ATS operation failed" });
    }
  });

  // F9 (Task #4155): candidate portal routes authenticate via the opaque
  // :token param (no session user) — plain express Request per
  // server/routes/requestContext.ts. Declared body fields are presence
  // claims only; all existing runtime guards are unchanged.
  type PortalSubmitBody = {
    questionId?: string;
    questionType?: string;
    responseText?: unknown;
    timeUsedSec?: number;
    pasteEvents?: unknown;
    timeToFirstKeystrokeSec?: unknown;
    totalTypingTimeSec?: unknown;
  };
  app.post("/api/ats/portal/:token/submit", async (req: Request<{ token: string }, unknown, PortalSubmitBody>, res) => {
    try {
      const [candidate] = await db.select().from(atsCandidates)
        .where(eq(atsCandidates.accessToken, req.params.token));
      if (!candidate) return res.status(404).json({ error: "Invalid link" });

      const [job] = await db.select().from(atsJobs).where(eq(atsJobs.id, candidate.jobId));
      if (!job || job.status !== "active") {
        return res.status(403).json({ error: "This position is no longer accepting submissions" });
      }

      const { questionId, questionType, responseText, timeUsedSec, pasteEvents, timeToFirstKeystrokeSec, totalTypingTimeSec } = req.body;
      if (!questionId || !questionType) {
        return res.status(400).json({ error: "questionId and questionType required" });
      }

      const assessmentItems = readAtsAssessmentItems(job.assessmentJson, { jobId: job.id });
      const assessmentItem = assessmentItems.find((a) => a.id === questionId);

      const serverIsTimed = assessmentItem?.type === "timed_text" || assessmentItem?.is_timed || false;
      const serverNoRedo = assessmentItem?.no_redo || false;
      const serverTimeLimitSec = assessmentItem?.time_limit_sec || null;
      const serverQuestionLayer = assessmentItem?.layer || null;
      const serverContradictionPairId = assessmentItem?.contradiction_pair_id || null;
      const serverContradictionRole = assessmentItem?.contradiction_role || null;
      const serverTraitTarget = assessmentItem?.trait_target || null;

      const existing = await db.select().from(atsSubmissions)
        .where(sql`${atsSubmissions.candidateId} = ${candidate.id} AND ${atsSubmissions.questionId} = ${questionId}`);

      if (existing.length > 0 && existing[0].noRedo && existing[0].lockedAt) {
        return res.status(409).json({ error: "This response cannot be changed once submitted" });
      }

      let clampedTimeUsed = timeUsedSec || null;
      if (serverIsTimed && serverTimeLimitSec && timeUsedSec) {
        clampedTimeUsed = Math.min(timeUsedSec, serverTimeLimitSec + 5);
      }

      const submissionFields: any = {
        responseText,
        questionLayer: serverQuestionLayer,
        isTimed: serverIsTimed,
        timeLimitSec: serverTimeLimitSec,
        timeUsedSec: clampedTimeUsed,
        noRedo: serverNoRedo,
        contradictionPairId: serverContradictionPairId,
        contradictionRole: serverContradictionRole,
        traitTarget: serverTraitTarget,
        pasteEvents: typeof pasteEvents === "number" ? pasteEvents : 0,
        timeToFirstKeystrokeSec: typeof timeToFirstKeystrokeSec === "number" ? timeToFirstKeystrokeSec : null,
        totalTypingTimeSec: typeof totalTypingTimeSec === "number" ? totalTypingTimeSec : null,
      };

      if (serverNoRedo) {
        submissionFields.lockedAt = new Date();
      }

      if (existing.length > 0) {
        // Task #4730 — the pre-read lock check above is not atomic with this
        // write: a racing request can lock the row between the SELECT and the
        // UPDATE. The guard predicate makes the write itself refuse to touch a
        // locked row; zero rows updated ⇒ the row locked underneath us ⇒ 409.
        const [updated] = await db.update(atsSubmissions).set(submissionFields)
          .where(and(eq(atsSubmissions.id, existing[0].id), ATS_SUBMISSION_NOT_LOCKED)).returning();
        if (!updated) {
          return res.status(409).json({ error: "This response cannot be changed once submitted" });
        }
        return res.json(updated);
      }

      // Task #4705 — atomic upsert: two concurrent duplicates (e.g. a timeout
      // retry racing the original) can both take this INSERT branch after
      // seeing "no existing row". The unique index on (candidate_id,
      // question_id) + ON CONFLICT DO UPDATE guarantees exactly one row per
      // candidate+question; the loser's write converges onto the winner's row
      // instead of minting a duplicate (which would double-count in
      // auto-scoring inputs).
      const [submission] = await db.insert(atsSubmissions).values({
        candidateId: candidate.id,
        jobId: candidate.jobId,
        questionId,
        questionType,
        ...submissionFields,
      }).onConflictDoUpdate({
        target: [atsSubmissions.candidateId, atsSubmissions.questionId],
        set: { questionType, ...submissionFields },
        // Task #4730 — a racing request can insert AND lock the row after our
        // pre-read saw nothing; without this guard the conflict branch would
        // overwrite the now-locked submission. Guarded conflict-update that
        // applies no row returns nothing ⇒ 409.
        setWhere: ATS_SUBMISSION_NOT_LOCKED,
      }).returning();

      if (!submission) {
        return res.status(409).json({ error: "This response cannot be changed once submitted" });
      }

      res.json(submission);
    } catch (error: any) {
      console.error("[ATS] Error:", error);
      res.status(500).json({ error: "ATS operation failed" });
    }
  });

  app.post("/api/ats/portal/:token/complete-screening", async (req: Request<{ token: string }>, res) => {
    try {
      const [candidate] = await db.select().from(atsCandidates)
        .where(eq(atsCandidates.accessToken, req.params.token));
      if (!candidate) return res.status(404).json({ error: "Invalid link" });

      const [jb] = await db.select().from(atsJobs).where(eq(atsJobs.id, candidate.jobId));
      if (!jb || jb.status !== "active") {
        return res.status(403).json({ error: "This position is no longer accepting submissions" });
      }

      // Idempotency (Task #4684): the portal's retry affordance re-POSTs this
      // endpoint if the first response was lost (e.g. timeout after the write
      // landed). A repeat must be a safe no-op that returns the current row —
      // never re-stamp the completion time, regress/advance the stage again,
      // or re-fire background auto-scoring.
      if (candidate.screeningCompletedAt) {
        return res.json(candidate);
      }

      // CAS write: the IS NULL predicate makes concurrent duplicates race
      // safely — exactly one request performs the write; losers re-read.
      const [updated] = await db.update(atsCandidates).set({
        stage: candidate.stage === "invited" || candidate.stage === "applied" ? "screening" : candidate.stage,
        screeningCompletedAt: new Date(),
        updatedAt: new Date(),
      }).where(and(eq(atsCandidates.id, candidate.id), isNull(atsCandidates.screeningCompletedAt))).returning();

      if (!updated) {
        // Lost the race to a concurrent duplicate: return the winner's result.
        const [current] = await db.select().from(atsCandidates).where(eq(atsCandidates.id, candidate.id));
        return res.json(current ?? candidate);
      }

      res.json(updated);

      const videoTasks = readAtsVideoTasks(jb.videoTasks, { jobId: jb.id });
      const assessmentItems = readAtsAssessmentItems(jb.assessmentJson, { jobId: jb.id });
      const hasVideoQuestions = videoTasks.length > 0 || assessmentItems.some((a) => a.type === "video");
      if (!hasVideoQuestions) {
        autoScoreCandidate(candidate.id, candidate.jobId).catch(err => {
          console.error("[ATS Auto-Score] Background scoring failed after screening completion:", candidate.id, err.message);
        });
      }
    } catch (error: any) {
      console.error("[ATS] Error:", error);
      res.status(500).json({ error: "ATS operation failed" });
    }
  });

  app.post("/api/ats/portal/:token/complete-video", async (req: Request<{ token: string }>, res) => {
    try {
      const [candidate] = await db.select().from(atsCandidates)
        .where(eq(atsCandidates.accessToken, req.params.token));
      if (!candidate) return res.status(404).json({ error: "Invalid link" });

      const [jb2] = await db.select().from(atsJobs).where(eq(atsJobs.id, candidate.jobId));
      if (!jb2 || jb2.status !== "active") {
        return res.status(403).json({ error: "This position is no longer accepting submissions" });
      }

      // Idempotency (Task #4684): see complete-screening above. A repeat used
      // to force-reset stage to "video" (regressing any later pipeline state)
      // and re-fire auto-scoring; now it returns the current row unchanged.
      if (candidate.videoCompletedAt) {
        return res.json(candidate);
      }

      const [updated] = await db.update(atsCandidates).set({
        stage: "video",
        videoCompletedAt: new Date(),
        updatedAt: new Date(),
      }).where(and(eq(atsCandidates.id, candidate.id), isNull(atsCandidates.videoCompletedAt))).returning();

      if (!updated) {
        const [current] = await db.select().from(atsCandidates).where(eq(atsCandidates.id, candidate.id));
        return res.json(current ?? candidate);
      }

      res.json(updated);

      autoScoreCandidate(candidate.id, candidate.jobId).catch(err => {
        console.error("[ATS Auto-Score] Background scoring failed for candidate:", candidate.id, err.message);
      });
    } catch (error: any) {
      console.error("[ATS] Error:", error);
      res.status(500).json({ error: "ATS operation failed" });
    }
  });

  const autoScoreInProgress = new Set<string>();

  async function autoScoreCandidate(candidateId: string, jobId: string) {
    if (autoScoreInProgress.has(candidateId)) {
      return;
    }
    autoScoreInProgress.add(candidateId);
    try {

      const [job] = await db.select().from(atsJobs).where(eq(atsJobs.id, jobId));
      if (!job || !job.rubric || !job.screeningQuestions) {
        return;
      }

      const [candidate] = await db.select().from(atsCandidates).where(eq(atsCandidates.id, candidateId));
      if (!candidate) return;

      if (candidate.stage !== "screening" && candidate.stage !== "video") {
        return;
      }

      let submissions = await db.select().from(atsSubmissions).where(eq(atsSubmissions.candidateId, candidateId));

      const needsTranscription = submissions.filter(s =>
        s.questionType === "video" && s.videoObjectKey &&
        (s.transcriptionStatus === "pending" || s.transcriptionStatus === "processing" || s.transcriptionStatus === "failed" || (s.transcriptionStatus !== "completed" && !s.transcriptText))
      );

      if (needsTranscription.length > 0) {
        const failedCount = needsTranscription.filter(s => s.transcriptionStatus === "failed").length;
        if (failedCount > 0) {
          await db.update(atsSubmissions).set({ transcriptionStatus: "pending", transcriptText: null, revJobId: null })
            .where(sql`${atsSubmissions.candidateId} = ${candidateId} AND ${atsSubmissions.questionType} = 'video' AND ${atsSubmissions.transcriptionStatus} = 'failed'`);
        }
        const { transcribeVideoSubmission } = await import("../services/atsTranscription");
        const autoTranscriptionResults = await Promise.allSettled(needsTranscription.map(s => transcribeVideoSubmission(s.id)));
        for (const tr of autoTranscriptionResults) {
          if (tr.status === "rejected") console.error("[ATS Auto-Score] Transcription failed:", tr.reason);
        }
        submissions = await db.select().from(atsSubmissions).where(eq(atsSubmissions.candidateId, candidateId));
      }

      const assessmentItems = readAtsAssessmentItems(job.assessmentJson, { jobId: job.id });
      const allQuestions = [
        ...readAtsScreeningQuestions(job.screeningQuestions, { jobId: job.id }),
        ...readAtsVideoTasks(job.videoTasks, { jobId: job.id }),
      ];

      const submissionData = submissions.map(s => {
        const question = allQuestions.find((q) => q.id === s.questionId);
        const assessmentItem = assessmentItems.find((a) => a.id === s.questionId);
        let videoDurationSec: number | undefined;
        if (s.questionType === "video") {
          if (s.videoDurationSec != null) {
            videoDurationSec = s.videoDurationSec;
          } else {
            const durationMatch = s.responseText?.match(/\[Video response - (\d+)s\]/);
            videoDurationSec = durationMatch ? parseInt(durationMatch[1]) : 0;
          }
        }
        const maxDurationSec = (question && "durationSec" in question ? question.durationSec : undefined) || assessmentItem?.duration_sec || undefined;
        return {
          questionId: s.questionId,
          questionPrompt: question?.prompt || assessmentItem?.prompt || "Unknown question",
          questionType: s.questionType,
          responseText: s.responseText || undefined,
          transcriptText: s.transcriptText || undefined,
          videoDurationSec: s.questionType === "video" ? videoDurationSec : undefined,
          maxDurationSec: s.questionType === "video" ? maxDurationSec : undefined,
          transcriptionStatus: s.questionType === "video" ? (s.transcriptionStatus || null) : undefined,
          layer: assessmentItem?.layer || s.questionLayer || undefined,
          contradictionPairId: assessmentItem?.contradiction_pair_id || s.contradictionPairId || undefined,
          contradictionRole: assessmentItem?.contradiction_role || s.contradictionRole || undefined,
          traitTarget: assessmentItem?.trait_target || s.traitTarget || undefined,
          isTimed: assessmentItem?.is_timed || s.isTimed || false,
          timeUsedSec: s.timeUsedSec || undefined,
          timeLimitSec: assessmentItem?.time_limit_sec || s.timeLimitSec || undefined,
          pasteEvents: s.pasteEvents || 0,
          timeToFirstKeystrokeSec: s.timeToFirstKeystrokeSec || undefined,
          totalTypingTimeSec: s.totalTypingTimeSec || undefined,
        };
      });

      const hasV2Pipeline = job.roleSourceOfTruth && job.cognitiveProfile && job.rubricJson;

      if (hasV2Pipeline) {
        const { extractEvidence, computeLanguageAgencyScore, computeAiLikelihood, scoreCandidateV2, generateHiringCard, evaluateResumeConsistency } = await import("../services/atsIntelligence");
        const { ATS_SPEC_VERSION, ATS_MODEL_ID } = await import("../services/atsTypes");
        const sot = readAtsRoleSourceOfTruth(job.roleSourceOfTruth, { jobId: job.id });
        const cp = readAtsCognitiveProfile(job.cognitiveProfile, { jobId: job.id });
        const rubricJson = readAtsRubricJson(job.rubricJson, { jobId: job.id });
        if (!sot || !cp || !rubricJson) {
          throw new Error("v2 pipeline artifacts failed to decode (role source of truth / cognitive profile / rubric)");
        }

        const { markers: evidenceMarkers, agencyFeaturesMap } = await extractEvidence(job.id, candidate.id, submissionData.map(s => ({ questionId: s.questionId, questionPrompt: s.questionPrompt, responseText: s.responseText || s.transcriptText || "", layer: s.layer })), sot);

        for (const marker of evidenceMarkers) {
          const matchingSub = submissions.find(s => s.questionId === marker.question_id);
          if (matchingSub) {
            await db.update(atsSubmissions).set({ evidenceMarkers: marker }).where(eq(atsSubmissions.id, matchingSub.id));
          }
        }

        const languageAgency = computeLanguageAgencyScore(agencyFeaturesMap, submissionData.map(s => ({ questionId: s.questionId, layer: s.layer })));
        const aiLikelihood = computeAiLikelihood(evidenceMarkers, submissionData, agencyFeaturesMap);

        const scoringResult = await scoreCandidateV2(job.id, candidate.id, job.title, rubricJson, readAtsHardFails(job.hardFails, { jobId: job.id }), evidenceMarkers, submissionData, sot, cp, languageAgency);

        let resumeConsistencyResult: ResumeConsistency | undefined = undefined;
        const resumeProfile = readAtsResumeProfile(candidate.resumeProfileJson, { candidateId: candidate.id });
        if (resumeProfile) {
          try {
            const consistencySubmissions = submissionData.filter(s => s.responseText || s.transcriptText).map(s => ({ questionId: s.questionId, questionText: s.questionPrompt, responseText: s.responseText || s.transcriptText || "" }));
            resumeConsistencyResult = await evaluateResumeConsistency(job.id, candidate.id, resumeProfile, consistencySubmissions, sot);
          } catch (rcErr: any) {
            console.error("[ATS Auto-Score] Resume consistency failed (non-fatal):", rcErr.message);
          }
        }

        const hiringCard = await generateHiringCard(job.id, candidate.id, candidate.name, job.title, scoringResult, evidenceMarkers, cp, languageAgency, aiLikelihood, resumeConsistencyResult);

        const [freshCandidate] = await db.select().from(atsCandidates).where(eq(atsCandidates.id, candidateId));
        const safeToAdvanceStage = freshCandidate && (freshCandidate.stage === "screening" || freshCandidate.stage === "video");

        const autoBaseFields = freshCandidate?.assessmentBaseScore == null ? {
          assessmentBaseScore: scoringResult.final_score,
          finalDisplayScore: scoringResult.final_score,
          evidenceStageCount: 1,
        } : {};

        await db.update(atsCandidates).set({
          totalScore: scoringResult.final_score,
          ...autoBaseFields,
          aiScoreJson: scoringResult,
          evidenceJson: { markers: evidenceMarkers, language_agency: languageAgency, ai_likelihood: aiLikelihood },
          hiringCardJson: hiringCard,
          resumeConsistencyJson: resumeConsistencyResult ? resumeConsistencyResult : undefined,
          riskTier: scoringResult.risk_tier,
          fitDelta: scoringResult.fit_delta,
          languageAgencyScore: languageAgency.overall_score,
          agencyUnderPressure: languageAgency.agency_under_pressure,
          agencyConsistency: languageAgency.agency_consistency,
          aiLikelihoodScore: aiLikelihood.ai_likelihood_score,
          aiAssistanceFlag: aiLikelihood.ai_assistance_flag,
          aiSpecVersion: ATS_SPEC_VERSION,
          modelId: ATS_MODEL_ID,
          aiScoredAt: new Date(),
          ...(safeToAdvanceStage ? { stage: "ai_scored" } : {}),
          updatedAt: new Date(),
        }).where(eq(atsCandidates.id, candidateId));

        import("../services/atsCohortCalibration").then(m => m.recalibrateRoleCohort(jobId)).catch(e => console.error("[Cohort Calibration] Background recalibration error:", e.message));
      } else {
        const { scoreCandidate } = await import("../services/atsIntelligence");
        const legacyRubric = readAtsLegacyRubric(job.rubric, { jobId: job.id });
        if (!legacyRubric) {
          throw new Error("legacy rubric failed to decode");
        }
        const result = await scoreCandidate(job.title, legacyRubric, readAtsHardFails(job.hardFails, { jobId: job.id }), submissionData);

        const [freshCandidate] = await db.select().from(atsCandidates).where(eq(atsCandidates.id, candidateId));
        const safeToAdvanceStage = freshCandidate && (freshCandidate.stage === "screening" || freshCandidate.stage === "video");

        const autoBaseFieldsV1 = freshCandidate?.assessmentBaseScore == null ? {
          assessmentBaseScore: result.totalScore,
          finalDisplayScore: result.totalScore,
          evidenceStageCount: 1,
        } : {};

        await db.update(atsCandidates).set({
          totalScore: result.totalScore,
          ...autoBaseFieldsV1,
          aiScoreJson: result,
          aiScoredAt: new Date(),
          ...(safeToAdvanceStage ? { stage: "ai_scored" } : {}),
          updatedAt: new Date(),
        }).where(eq(atsCandidates.id, candidateId));

        import("../services/atsCohortCalibration").then(m => m.recalibrateRoleCohort(jobId)).catch(e => console.error("[Cohort Calibration] Background recalibration error:", e.message));
      }
    } catch (error: any) {
      console.error("[ATS Auto-Score] Failed for candidate:", candidateId, error.message);
    } finally {
      autoScoreInProgress.delete(candidateId);
    }
  }

  // ============================================
  // ATS PHASE 2 - Bulk Operations & Analytics
  // ============================================

  app.post("/api/ats/jobs/:jobId/candidates/import-csv", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const { csvText } = req.body;
      if (!csvText || typeof csvText !== "string") {
        return res.status(400).json({ error: "csvText is required" });
      }

      const [job] = await db.select().from(atsJobs).where(eq(atsJobs.id, req.params.jobId));
      if (!job) return res.status(404).json({ error: "Job not found" });

      const lines = csvText.trim().split("\n").map(l => l.trim()).filter(l => l.length > 0);
      if (lines.length < 2) {
        return res.status(400).json({ error: "CSV must have a header row and at least one data row" });
      }

      const header = lines[0].toLowerCase().split(",").map(h => h.trim());
      const nameIdx = header.indexOf("name");
      const emailIdx = header.indexOf("email");
      const phoneIdx = header.indexOf("phone");

      if (nameIdx === -1 || emailIdx === -1) {
        return res.status(400).json({ error: "CSV header must include 'name' and 'email' columns" });
      }

      let created = 0;
      const errors: string[] = [];

      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(",").map(c => c.trim());
        const name = cols[nameIdx] || "";
        const email = cols[emailIdx] || "";
        const phone = phoneIdx !== -1 ? (cols[phoneIdx] || null) : null;

        if (!name || !email) {
          errors.push(`Row ${i + 1}: missing name or email`);
          continue;
        }

        try {
          await db.insert(atsCandidates).values({
            jobId: req.params.jobId,
            name,
            email,
            phone,
            stage: "applied",
            accessToken: crypto.randomBytes(32).toString("hex"),
          });
          created++;
        } catch (err: any) {
          errors.push(`Row ${i + 1}: ${err.message}`);
        }
      }

      res.json({ created, errors });
    } catch (error: any) {
      console.error("[ATS] Error:", error);
      res.status(500).json({ error: "ATS operation failed" });
    }
  });

  app.post("/api/ats/jobs/:jobId/candidates/bulk-update", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const { candidateIds, stage } = req.body;
      if (!Array.isArray(candidateIds) || !stage || typeof stage !== "string") {
        return res.status(400).json({ error: "candidateIds (array) and stage (string) are required" });
      }

      if (candidateIds.length === 0) {
        return res.json({ updated: 0 });
      }

      const result = await db.update(atsCandidates).set({
        stage,
        updatedAt: new Date(),
      }).where(
        and(
          inArray(atsCandidates.id, candidateIds),
          eq(atsCandidates.jobId, req.params.jobId)
        )
      ).returning();

      res.json({ updated: result.length });
    } catch (error: any) {
      console.error("[ATS] Error:", error);
      res.status(500).json({ error: "ATS operation failed" });
    }
  });

  app.post("/api/ats/jobs/:jobId/recalibrate", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const { recalibrateRoleCohort } = await import("../services/atsCohortCalibration");
      await recalibrateRoleCohort(req.params.jobId);
      res.json({ success: true });
    } catch (error: any) {
      console.error("[Cohort Calibration] Manual recalibration error:", error);
      res.status(500).json({ error: "ATS operation failed" });
    }
  });

  app.get("/api/ats/jobs/:jobId/analytics", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const [job] = await db.select().from(atsJobs).where(eq(atsJobs.id, req.params.jobId));
      if (!job) return res.status(404).json({ error: "Job not found" });

      const candidates = await db.select().from(atsCandidates)
        .where(eq(atsCandidates.jobId, req.params.jobId));

      const stageCounts: Record<string, number> = {};
      const stageScores: Record<string, number[]> = {};

      for (const c of candidates) {
        stageCounts[c.stage] = (stageCounts[c.stage] || 0) + 1;
        if (c.totalScore !== null && c.totalScore !== undefined) {
          if (!stageScores[c.stage]) stageScores[c.stage] = [];
          stageScores[c.stage].push(c.totalScore);
        }
      }

      const avgScores: Record<string, number> = {};
      for (const [stage, scores] of Object.entries(stageScores)) {
        avgScores[stage] = scores.reduce((a, b) => a + b, 0) / scores.length;
      }

      const stageOrder = ["applied", "screening", "video", "ai_scored", "reviewed", "hired", "rejected"];
      const conversionRates: Record<string, number> = {};
      for (let i = 0; i < stageOrder.length - 1; i++) {
        const from = stageOrder[i];
        const to = stageOrder[i + 1];
        const fromCount = stageCounts[from] || 0;
        const toCount = stageCounts[to] || 0;
        if (fromCount > 0) {
          conversionRates[`${from}_to_${to}`] = Math.round((toCount / fromCount) * 100);
        }
      }

      res.json({
        totalCandidates: candidates.length,
        stageCounts,
        avgScores,
        conversionRates,
      });
    } catch (error: any) {
      console.error("[ATS] Error:", error);
      res.status(500).json({ error: "ATS operation failed" });
    }
  });

  // ============================================
  // ATS VIDEO UPLOAD - Public Portal Endpoints
  // ============================================

  app.post("/api/ats/portal/:token/video-upload-url", async (req: Request<{ token: string }>, res) => {
    try {
      const [candidate] = await db.select().from(atsCandidates)
        .where(eq(atsCandidates.accessToken, req.params.token));
      if (!candidate) return res.status(404).json({ error: "Invalid or expired link" });

      const [job] = await db.select().from(atsJobs)
        .where(eq(atsJobs.id, candidate.jobId));
      if (!job || job.status !== "active") {
        return res.status(403).json({ error: "This position is no longer accepting submissions" });
      }

      // Task #3964 — mint into THIS candidate's dedicated namespace
      // (`ats-<candidateId>/…`); submit-video only accepts that exact prefix,
      // binding the upload to the portal session server-side.
      const prefix = atsCandidateVideoUploadPrefix(candidate.id);
      if (!prefix) {
        console.error(`[ATS] Cannot derive upload namespace for candidate ${candidate.id}`);
        return res.status(500).json({ error: "ATS operation failed" });
      }
      const uploadUrl = await objectStorageService.getObjectEntityUploadURL({ prefix });
      const objectPath = objectStorageService.normalizeObjectEntityPath(uploadUrl);

      res.json({ uploadUrl, objectPath });
    } catch (error: any) {
      console.error("[ATS] Video upload URL error:", error);
      res.status(500).json({ error: "ATS operation failed" });
    }
  });

  app.post("/api/ats/portal/:token/submit-video", async (req: Request<{ token: string }, unknown, { questionId?: string; objectPath?: string; durationSec?: number }>, res) => {
    try {
      const [candidate] = await db.select().from(atsCandidates)
        .where(eq(atsCandidates.accessToken, req.params.token));
      if (!candidate) return res.status(404).json({ error: "Invalid or expired link" });

      const [job] = await db.select().from(atsJobs)
        .where(eq(atsJobs.id, candidate.jobId));
      if (!job || job.status !== "active") {
        return res.status(403).json({ error: "This position is no longer accepting submissions" });
      }

      const { questionId, objectPath, durationSec } = req.body;
      if (!questionId || !objectPath) {
        return res.status(400).json({ error: "questionId and objectPath are required" });
      }
      if (!durationSec || durationSec <= 0) {
        console.warn(`[ATS] Video submission for question ${questionId} has durationSec=${durationSec} — possible client-side capture issue`);
      }

      // Task #3964 (audit A-006) — validate the client-supplied object
      // reference before persisting it: it must live in THIS candidate's
      // dedicated upload namespace (minted above — generic `/objects/uploads/…`
      // and other candidates' objects are rejected outright), must not already
      // be claimed, and the stored bytes must verify as an in-cap video.
      // Invalid uploads are deleted with an unclaimed-only entitlement, so a
      // concurrent claim aborts the delete instead of destroying an owned
      // object.
      if (!isAtsCandidateVideoObjectPath(objectPath, candidate.id)) {
        return res.status(400).json({ error: "Invalid video reference" });
      }
      try {
        const acl = await objectStorageService.getObjectEntityAclPolicy(objectPath);
        if (acl?.owner) {
          console.warn(`[ATS] Rejected video submission referencing an owned object: ${objectPath}`);
          return res.status(400).json({ error: "Invalid video reference" });
        }
        const verdict = await objectStorageService.verifyObjectEntityContent(
          objectPath,
          ATS_VIDEO_UPLOAD_CONSTRAINTS,
        );
        if (!verdict.ok) {
          console.warn(
            `[ATS] Rejected video submission (${verdict.reason}): ${objectPath} — ${verdict.detail}`,
          );
          await objectStorageService.deleteRejectedUploadObject(objectPath, {
            expectedOwner: null,
          });
          return res.status(400).json({
            error:
              verdict.reason === "too_large"
                ? "The recorded video exceeds the maximum allowed size"
                : "The uploaded file is not a playable video — please re-record and try again",
          });
        }
      } catch (err) {
        if (err instanceof ObjectNotFoundError) {
          return res.status(400).json({ error: "Video upload not found — please re-record and try again" });
        }
        throw err;
      }

      const existing = await db.select().from(atsSubmissions)
        .where(sql`${atsSubmissions.candidateId} = ${candidate.id} AND ${atsSubmissions.questionId} = ${questionId}`);

      if (existing.length > 0 && existing[0].noRedo && existing[0].lockedAt) {
        return res.status(409).json({ error: "This response cannot be changed once submitted" });
      }

      const assessmentItems = readAtsAssessmentItems(job.assessmentJson, { jobId: job.id });
      const assessmentItem = assessmentItems.find((a) => a.id === questionId);
      const videoLayer = assessmentItem?.layer || null;
      // Task #4736 — mirror /submit's serverNoRedo handling: a no_redo video
      // question stamps noRedo + lockedAt on the write, so the first answer
      // locks the row and the Task #4730 write-time guard (plus the pre-read
      // 409 above) rejects every later re-record atomically.
      const serverNoRedo = assessmentItem?.no_redo || false;
      const lockFields: { noRedo: boolean; lockedAt?: Date } = { noRedo: serverNoRedo };
      if (serverNoRedo) lockFields.lockedAt = new Date();

      const { transcribeVideoSubmission } = await import("../services/atsTranscription");

      if (existing.length > 0) {
        // Task #4730 — same non-atomic-pre-read race as /submit: a racing
        // request can lock the row between the SELECT and this UPDATE. The
        // guard makes the write refuse locked rows; zero rows ⇒ 409 (and no
        // transcription kick for a write that never landed).
        const [updated] = await db.update(atsSubmissions).set({ // spread-write-approved: lockFields is the server-built {noRedo, lockedAt} lock guard derived from the assessment config above — no request-body keys can reach it (F8 cat-2)
          questionType: "video",
          videoObjectKey: objectPath,
          videoDurationSec: durationSec || 0,
          responseText: `[Video response - ${durationSec || 0}s]`,
          transcriptionStatus: "pending",
          transcriptText: null,
          questionLayer: videoLayer,
          ...lockFields,
        }).where(and(eq(atsSubmissions.id, existing[0].id), ATS_SUBMISSION_NOT_LOCKED)).returning();
        if (!updated) {
          return res.status(409).json({ error: "This response cannot be changed once submitted" });
        }
        transcribeVideoSubmission(updated.id).catch(err =>
          console.error("[ATS] Background transcription failed:", err.message));
        return res.json(updated);
      }

      // Task #4705 — atomic upsert: the unique index on (candidate_id,
      // question_id) means a concurrent duplicate submit-video (timeout retry
      // racing the original) must converge onto the winner's row via
      // ON CONFLICT instead of erroring on the index (or, pre-index, minting
      // a duplicate row).
      const [submission] = await db.insert(atsSubmissions).values({ // spread-write-approved: lockFields is the server-built {noRedo, lockedAt} lock guard derived from the assessment config above — no request-body keys can reach it (F8 cat-2)
        candidateId: candidate.id,
        jobId: candidate.jobId,
        questionId,
        questionType: "video",
        videoObjectKey: objectPath,
        videoDurationSec: durationSec || 0,
        responseText: `[Video response - ${durationSec || 0}s]`,
        transcriptionStatus: "pending",
        questionLayer: videoLayer,
        ...lockFields,
      }).onConflictDoUpdate({
        target: [atsSubmissions.candidateId, atsSubmissions.questionId],
        set: {
          questionType: "video",
          videoObjectKey: objectPath,
          videoDurationSec: durationSec || 0,
          responseText: `[Video response - ${durationSec || 0}s]`,
          transcriptionStatus: "pending",
          transcriptText: null,
          questionLayer: videoLayer,
          ...lockFields,
        },
        // Task #4730 — a racing request can insert AND lock the row after our
        // pre-read saw nothing; the guard keeps the conflict branch from
        // overwriting a locked submission. No row applied ⇒ 409.
        setWhere: ATS_SUBMISSION_NOT_LOCKED,
      }).returning();

      if (!submission) {
        return res.status(409).json({ error: "This response cannot be changed once submitted" });
      }

      transcribeVideoSubmission(submission.id).catch(err =>
        console.error("[ATS] Background transcription failed:", err.message));

      res.json(submission);
    } catch (error: any) {
      console.error("[ATS] Submit video error:", error);
      res.status(500).json({ error: "ATS operation failed" });
    }
  });

  app.post("/api/ats/candidates/:id/retry-transcription", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const { id } = req.params;
      const failedSubmissions = await db.select().from(atsSubmissions)
        .where(sql`${atsSubmissions.candidateId} = ${id} AND ${atsSubmissions.questionType} = 'video' AND ${atsSubmissions.transcriptionStatus} IN ('failed', 'empty')`);

      if (failedSubmissions.length === 0) {
        return res.json({ message: "No submissions need retranscription", count: 0 });
      }

      await db.update(atsSubmissions).set({ transcriptionStatus: "pending", transcriptText: null, revJobId: null })
        .where(sql`${atsSubmissions.candidateId} = ${id} AND ${atsSubmissions.questionType} = 'video' AND ${atsSubmissions.transcriptionStatus} IN ('failed', 'empty')`);

      const { transcribeVideoSubmission } = await import("../services/atsTranscription");
      for (const sub of failedSubmissions) {
        transcribeVideoSubmission(sub.id).catch(err =>
          console.error(`[ATS] Retry transcription failed for ${sub.id}:`, err.message));
      }

      res.json({ message: `Retranscribing ${failedSubmissions.length} video(s)`, count: failedSubmissions.length });
    } catch (error: any) {
      console.error("[ATS] Retry transcription error:", error);
      res.status(500).json({ error: "ATS operation failed" });
    }
  });

  // ============================================
  // ATS EMAIL TEMPLATES - CEO Management
  // ============================================

  const validTemplateTypes = ["invite", "rejection", "offer", "follow_up", "custom"];

  app.get("/api/ats/email-templates", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      // Task #3962 — bounded with default/max limits (found unbounded while
      // verifying the audited ATS list surfaces). Template counts are
      // operator-curated and small, so a bound without a continuation cursor
      // keeps the bare-array response shape existing clients consume.
      const limit = parseAtsListLimit(req.query.limit);
      if (limit === null) {
        return res.status(400).json({ error: "limit must be a positive integer" });
      }
      const jobId = req.query.jobId as string | undefined;
      let templates;
      if (jobId) {
        templates = await db.select().from(atsEmailTemplates)
          .where(sql`${atsEmailTemplates.jobId} = ${jobId} OR ${atsEmailTemplates.isGlobal} = true`)
          .orderBy(sql`created_at DESC`)
          .limit(limit);
      } else {
        templates = await db.select().from(atsEmailTemplates)
          .orderBy(sql`created_at DESC`)
          .limit(limit);
      }
      res.json(templates);
    } catch (error: any) {
      console.error("[ATS] Error:", error);
      res.status(500).json({ error: "ATS operation failed" });
    }
  });

  app.post("/api/ats/email-templates", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const { name, subject, body, templateType, jobId, isGlobal } = req.body;
      if (!name || !subject || !body || !templateType) {
        return res.status(400).json({ error: "name, subject, body, and templateType are required" });
      }
      if (!validTemplateTypes.includes(templateType)) {
        return res.status(400).json({ error: `templateType must be one of: ${validTemplateTypes.join(", ")}` });
      }

      const [template] = await db.insert(atsEmailTemplates).values({
        name,
        subject,
        body,
        templateType,
        jobId: jobId || null,
        isGlobal: isGlobal ?? false,
      }).returning();

      // Task #1574 — create-template returns 201 Created per REST conventions.
      res.status(201).json(template);
    } catch (error: any) {
      console.error("[ATS] Error:", error);
      res.status(500).json({ error: "ATS operation failed" });
    }
  });

  app.patch("/api/ats/email-templates/:id", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const { name, subject, body, templateType, jobId, isGlobal } = req.body;
      const updates: any = {};
      if (name !== undefined) updates.name = name;
      if (subject !== undefined) updates.subject = subject;
      if (body !== undefined) updates.body = body;
      if (templateType !== undefined) {
        if (!validTemplateTypes.includes(templateType)) {
          return res.status(400).json({ error: `templateType must be one of: ${validTemplateTypes.join(", ")}` });
        }
        updates.templateType = templateType;
      }
      if (jobId !== undefined) updates.jobId = jobId;
      if (isGlobal !== undefined) updates.isGlobal = isGlobal;

      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: "No fields to update" });
      }

      const [template] = await db.update(atsEmailTemplates).set(updates)
        .where(eq(atsEmailTemplates.id, req.params.id)).returning();
      if (!template) return res.status(404).json({ error: "Template not found" });
      res.json(template);
    } catch (error: any) {
      console.error("[ATS] Error:", error);
      res.status(500).json({ error: "ATS operation failed" });
    }
  });

  app.delete("/api/ats/email-templates/:id", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const [deleted] = await db.delete(atsEmailTemplates)
        .where(eq(atsEmailTemplates.id, req.params.id)).returning();
      if (!deleted) return res.status(404).json({ error: "Template not found" });
      res.status(204).send();
    } catch (error: any) {
      console.error("[ATS] Error:", error);
      res.status(500).json({ error: "ATS operation failed" });
    }
  });

  // ============================================
  // ATS - Interview Management & Final Decision
  // ============================================

  app.get("/api/ats/candidates/:id/interviews", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      // Task #3962 — cursor-paginated (was unbounded; audit C-U3). Same
      // keyset design as the submissions list: chronological order, id
      // tie-break, path-scoped candidate filter on every page.
      const limit = parseAtsListLimit(req.query.limit);
      if (limit === null) {
        return res.status(400).json({ error: "limit must be a positive integer" });
      }
      const scope = `interviews:${req.params.id}`;
      let cursor: AtsListCursor | null = null;
      if (req.query.cursor !== undefined) {
        cursor = decodeAtsListCursor(String(req.query.cursor), scope);
        if (!cursor) return res.status(400).json({ error: "invalid cursor" });
      }
      const conditions: SQL[] = [eq(atsInterviews.candidateId, req.params.id)];
      if (cursor) {
        conditions.push(atsListCursorPredicate(atsInterviews.createdAt, atsInterviews.id, "asc", cursor));
      }
      const rows = await db.select().from(atsInterviews)
        .where(and(...conditions))
        .orderBy(atsListOrderBy(atsInterviews.createdAt, atsInterviews.id, "asc"))
        .limit(limit + 1);
      const { page, nextCursor } = atsListPageOf(rows, limit, scope);
      res.json({ interviews: page, nextCursor, limit });
    } catch (error: any) {
      console.error("[ATS] Error:", error);
      res.status(500).json({ error: "ATS operation failed" });
    }
  });

  app.post("/api/ats/candidates/:id/interviews", isAuthenticated, requireTeamLead, async (req: AuthenticatedRequest<{ id: string }, { interviewType?: string; transcript?: string; interviewNotes?: string; manualRatings?: unknown }>, res) => {
    try {
      const { interviewType, transcript, interviewNotes, manualRatings } = req.body;
      if (!interviewType || !["phone", "story", "reference", "focus"].includes(interviewType)) {
        return res.status(400).json({ error: "Invalid interview type. Must be: phone, story, reference, focus" });
      }
      const hasTranscript = transcript && transcript.trim().length > 0;
      const hasNotes = interviewNotes && interviewNotes.trim().length > 0;
      if (!hasTranscript && !hasNotes) {
        return res.status(400).json({ error: "At least a transcript or notes are required" });
      }

      const [candidate] = await db.select().from(atsCandidates)
        .where(eq(atsCandidates.id, req.params.id));
      if (!candidate) return res.status(404).json({ error: "Candidate not found" });

      const [interview] = await db.insert(atsInterviews).values({
        candidateId: req.params.id,
        jobId: candidate.jobId,
        interviewType,
        transcript: hasTranscript ? transcript.trim() : null,
        interviewNotes: hasNotes ? interviewNotes.trim() : null,
        uploadedAt: new Date(),
        uploadedBy: req.user?.id || "unknown",
        analysisStatus: "uploaded",
        manualRatings: manualRatings || null,
      }).returning();

      res.status(201).json(interview);
    } catch (error: any) {
      console.error("[ATS] Error:", error);
      res.status(500).json({ error: "ATS operation failed" });
    }
  });

  app.post("/api/ats/candidates/:id/interviews/:interviewId/analyze", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const [interview] = await db.select().from(atsInterviews)
        .where(eq(atsInterviews.id, req.params.interviewId));
      if (!interview) return res.status(404).json({ error: "Interview not found" });
      if (!interview.transcript && !interview.interviewNotes) return res.status(400).json({ error: "No transcript or notes to analyze" });

      await db.update(atsInterviews)
        .set({ analysisStatus: "analyzing", updatedAt: new Date() })
        .where(eq(atsInterviews.id, interview.id));

      const [job] = await db.select().from(atsJobs)
        .where(eq(atsJobs.id, interview.jobId));
      const jobContext = {
        title: job?.title || "Unknown Role",
        roleSourceOfTruth: job?.roleSourceOfTruth,
      };

      const combinedContent = [
        interview.transcript ? `TRANSCRIPT:\n${interview.transcript}` : null,
        interview.interviewNotes ? `INTERVIEWER NOTES:\n${interview.interviewNotes}` : null,
      ].filter(Boolean).join("\n\n---\n\n");

      let analysis: PhoneInterviewAnalysis | StoryInterviewAnalysis | ReferenceInterviewAnalysis | FocusInterviewAnalysis;
      try {
        switch (interview.interviewType) {
          case "phone":
            analysis = await analyzePhoneInterview(combinedContent, jobContext);
            break;
          case "story":
            analysis = await analyzeStoryInterview(combinedContent, jobContext);
            break;
          case "reference": {
            const storyInterviews = await db.select().from(atsInterviews)
              .where(and(
                eq(atsInterviews.candidateId, interview.candidateId),
                eq(atsInterviews.interviewType, "story"),
                sql`analysis_status = 'analyzed'`
              ));
            const storyHighlights = storyInterviews[0]?.analysisJson
              ? JSON.stringify(readAtsStoryAnalysis(storyInterviews[0].analysisJson)?.repeatedStrengths || [])
              : undefined;
            analysis = await analyzeReferenceInterview(combinedContent, jobContext, storyHighlights);
            break;
          }
          case "focus":
            analysis = await analyzeFocusInterview(
              combinedContent, jobContext,
              readAtsManualRatings(interview.manualRatings, { interviewId: interview.id })
            );
            break;
          default:
            return res.status(400).json({ error: "Unknown interview type" });
        }

        const [updated] = await db.update(atsInterviews)
          .set({ analysisJson: analysis, analysisStatus: "analyzed", updatedAt: new Date() })
          .where(eq(atsInterviews.id, interview.id)).returning();

        import("../services/atsUnifiedScoring").then(async (m) => {
          try {
            const reEvalResult = await m.reEvaluateDimensions(interview.candidateId, interview.interviewType);
            const [cand] = await db.select().from(atsCandidates).where(eq(atsCandidates.id, interview.candidateId));
            if (cand) {
              const existingHistory = readAtsDimensionHistory(cand.dimensionHistory, { candidateId: cand.id });
              const existingCohortMult = cand.calibrationMultiplier ?? 1.0;
              const newDisplay = Math.round(reEvalResult.newAssessmentBaseScore * existingCohortMult * 100) / 100;
              const currentAiJson = readAtsAiScore(cand.aiScoreJson, { candidateId: cand.id }) ?? {};
              await db.update(atsCandidates).set({
                assessmentBaseScore: reEvalResult.newAssessmentBaseScore,
                totalScore: reEvalResult.newAssessmentBaseScore,
                finalDisplayScore: newDisplay,
                evidenceStageCount: reEvalResult.evidenceStageCount,
                dimensionHistory: [...existingHistory, reEvalResult.dimensionHistoryEntry],
                aiScoreJson: {
                  ...currentAiJson,
                  dimension_scores: reEvalResult.newDimensionScores,
                },
                updatedAt: new Date(),
              }).where(eq(atsCandidates.id, interview.candidateId));
            }
          } catch (e: any) {
            console.error("[Unified Scoring] Background re-evaluation error:", e.message);
          }
          try {
            const cohort = await import("../services/atsCohortCalibration");
            await cohort.recalibrateRoleCohort(interview.jobId);
          } catch (e: any) {
            console.error("[Cohort Calibration] Background recalibration error:", e.message);
          }
        }).catch(e => console.error("[Unified Scoring] Import error:", e.message));
        res.json(updated);
      } catch (aiError: any) {
        await db.update(atsInterviews)
          .set({ analysisStatus: "failed", updatedAt: new Date() })
          .where(eq(atsInterviews.id, interview.id));
        throw aiError;
      }
    } catch (error: any) {
      console.error("[ATS] Error:", error);
      res.status(500).json({ error: "ATS operation failed" });
    }
  });

  app.delete("/api/ats/candidates/:id/interviews/:interviewId", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const [interview] = await db.select().from(atsInterviews)
        .where(and(
          eq(atsInterviews.id, req.params.interviewId),
          eq(atsInterviews.candidateId, req.params.id)
        ));
      if (!interview) return res.status(404).json({ error: "Interview not found" });

      await db.delete(atsInterviews).where(eq(atsInterviews.id, interview.id));

      import("../services/atsUnifiedScoring").then(async (m) => {
        try {
          const reEvalResult = await m.reEvaluateDimensions(interview.candidateId, interview.interviewType);
          const [cand] = await db.select().from(atsCandidates).where(eq(atsCandidates.id, interview.candidateId));
          if (cand) {
            const existingHistory = readAtsDimensionHistory(cand.dimensionHistory, { candidateId: cand.id });
            const existingCohortMult = cand.calibrationMultiplier ?? 1.0;
            const newDisplay = Math.round(reEvalResult.newAssessmentBaseScore * existingCohortMult * 100) / 100;
            const currentAiJson = readAtsAiScore(cand.aiScoreJson, { candidateId: cand.id }) ?? {};
            await db.update(atsCandidates).set({
              assessmentBaseScore: reEvalResult.newAssessmentBaseScore,
              totalScore: reEvalResult.newAssessmentBaseScore,
              finalDisplayScore: newDisplay,
              evidenceStageCount: reEvalResult.evidenceStageCount,
              dimensionHistory: [...existingHistory, reEvalResult.dimensionHistoryEntry],
              aiScoreJson: {
                ...currentAiJson,
                dimension_scores: reEvalResult.newDimensionScores,
              },
              updatedAt: new Date(),
            }).where(eq(atsCandidates.id, interview.candidateId));
          }
        } catch (e: any) {
          console.error("[Unified Scoring] Background re-evaluation error:", e.message);
        }
        try {
          const cohort = await import("../services/atsCohortCalibration");
          await cohort.recalibrateRoleCohort(interview.jobId);
        } catch (e: any) {
          console.error("[Cohort Calibration] Background recalibration error:", e.message);
        }
      }).catch(e => console.error("[Unified Scoring] Import error:", e.message));

      res.json({ success: true });
    } catch (error: any) {
      console.error("[ATS] Error:", error);
      res.status(500).json({ error: "ATS operation failed" });
    }
  });

  app.patch("/api/ats/candidates/:id/interviews/:interviewId", isAuthenticated, requireTeamLead, async (req: AuthenticatedRequest<{ id: string; interviewId: string }, { transcript?: unknown; interviewNotes?: unknown; manualRatings?: unknown }>, res) => {
    try {
      const { transcript, interviewNotes, manualRatings } = req.body;
      const updates: any = { updatedAt: new Date() };
      if (transcript !== undefined || interviewNotes !== undefined) {
        if (transcript !== undefined) updates.transcript = transcript || null;
        if (interviewNotes !== undefined) updates.interviewNotes = interviewNotes || null;
        updates.uploadedAt = new Date();
        updates.analysisStatus = "uploaded";
        updates.analysisJson = null;
      }
      if (manualRatings !== undefined) updates.manualRatings = manualRatings;

      const [updated] = await db.update(atsInterviews)
        .set(updates)
        .where(eq(atsInterviews.id, req.params.interviewId)).returning();
      if (!updated) return res.status(404).json({ error: "Interview not found" });
      res.json(updated);
    } catch (error: any) {
      console.error("[ATS] Error:", error);
      res.status(500).json({ error: "ATS operation failed" });
    }
  });

  app.get("/api/ats/candidates/:id/final-decision", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const decisions = await db.select().from(atsFinalDecisions)
        .where(eq(atsFinalDecisions.candidateId, req.params.id))
        .orderBy(sql`created_at DESC`)
        .limit(1);
      res.json(decisions[0] || null);
    } catch (error: any) {
      console.error("[ATS] Error:", error);
      res.status(500).json({ error: "ATS operation failed" });
    }
  });

  app.post("/api/ats/candidates/:id/final-decision", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const [candidate] = await db.select().from(atsCandidates)
        .where(eq(atsCandidates.id, req.params.id));
      if (!candidate) return res.status(404).json({ error: "Candidate not found" });

      const [job] = await db.select().from(atsJobs)
        .where(eq(atsJobs.id, candidate.jobId));

      const interviews = await db.select().from(atsInterviews)
        .where(and(
          eq(atsInterviews.candidateId, candidate.id),
          sql`analysis_status = 'analyzed'`
        ));

      const phoneAnalysis = readAtsPhoneAnalysis(interviews.find(i => i.interviewType === "phone")?.analysisJson);
      const storyAnalysis = readAtsStoryAnalysis(interviews.find(i => i.interviewType === "story")?.analysisJson);
      const referenceAnalysis = readAtsReferenceAnalysis(interviews.find(i => i.interviewType === "reference")?.analysisJson);
      const focusAnalysis = readAtsFocusAnalysis(interviews.find(i => i.interviewType === "focus")?.analysisJson);

      const assessmentScore = candidate.totalScore != null ? {
        totalScore: candidate.totalScore,
        assessmentBaseScore: candidate.assessmentBaseScore ?? candidate.totalScore,
        finalDisplayScore: candidate.finalDisplayScore ?? candidate.calibratedScore ?? candidate.totalScore,
        scoreChangeSummary: candidate.scoreChangeSummary ?? null,
        riskTier: candidate.riskTier,
        fitDelta: candidate.fitDelta,
        hiringCard: candidate.hiringCardJson,
        languageAgencyScore: candidate.languageAgencyScore,
        agencyUnderPressure: candidate.agencyUnderPressure,
        agencyConsistency: candidate.agencyConsistency,
        aiLikelihoodScore: candidate.aiLikelihoodScore,
        aiAssistanceFlag: candidate.aiAssistanceFlag,
      } : null;

      const feedback = req.body?.feedback || undefined;

      const decision = await generateFinalDecision({
        candidateName: candidate.name,
        jobTitle: job?.title || "Unknown Role",
        phoneAnalysis,
        assessmentScore,
        storyAnalysis,
        referenceAnalysis,
        focusAnalysis,
        feedback,
      });

      const stagesCompleted: string[] = [];
      if (phoneAnalysis) stagesCompleted.push("phone_interview");
      if (assessmentScore) stagesCompleted.push("assessment");
      if (storyAnalysis) stagesCompleted.push("story_interview");
      if (referenceAnalysis) stagesCompleted.push("reference_interview");
      if (focusAnalysis) stagesCompleted.push("focus_interview");

      const [saved] = await db.insert(atsFinalDecisions).values({
        candidateId: candidate.id,
        jobId: candidate.jobId,
        basedOnStagesCompleted: stagesCompleted,
        decisionJson: decision,
        finalRecommendation: decision.finalRecommendation,
        confidence: decision.confidenceLevel,
        nextStep: decision.recommendedNextStep,
        lastFeedback: feedback || null,
      }).returning();

      res.status(201).json(saved);
    } catch (error: any) {
      console.error("[ATS] Error:", error);
      res.status(500).json({ error: "ATS operation failed" });
    }
  });

  }
