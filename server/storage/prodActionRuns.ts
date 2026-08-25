// @db-pool-intent: worker
//
// Task #1806 — Audit trail for CEO "Apply pending prod writes" presses.
// All callers (registry apply path + GET /api/admin/prod-actions/runs +
// the 2 → 3 ramp gate in Task #1807) invoke these helpers from a
// `runWithWorkerDb` + `withDbAttribution` scope. Every `getDb()` call in
// this file is therefore worker-pool bound.

import { and, desc, eq, isNull, sql } from "drizzle-orm";
import {
  prodActionRuns,
  type InsertProdActionRun,
  type ProdActionRun,
} from "@shared/schema";
import { getDb, withDbAttribution } from "../db";
import { bindArrayParam } from "../utils/sqlArray";

export interface ProdActionRunWithActor extends ProdActionRun {
  actorName: string | null;
  actorEmail: string | null;
}

// Defense-in-depth: even though our prod-action handlers construct their own
// `detail` strings and never intentionally embed credentials, catch'd error
// messages from upstream libraries can occasionally splice in connection
// strings or bearer tokens. Redact before persistence so audit rows are safe
// for the CEO panel and any future export.
const REDACTION_PATTERNS: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [
  { pattern: /postgres(?:ql)?:\/\/[^\s"']+/gi, replacement: "[redacted:postgres-url]" },
  { pattern: /\bBearer\s+[A-Za-z0-9._\-+/=]{16,}/gi, replacement: "Bearer [redacted]" },
  { pattern: /\b(?:sk|pk|rk|whsec|xoxb|xoxp|xapp|ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_\-]{20,}/g, replacement: "[redacted:token]" },
  { pattern: /\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}/g, replacement: "[redacted:jwt]" },
];

function redactAuditText(value: string | null | undefined): string | null {
  if (value == null) return null;
  let out = String(value);
  for (const { pattern, replacement } of REDACTION_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  // Cap to a sane length so a runaway stack trace can't blow up the row.
  return out.length > 4000 ? `${out.slice(0, 4000)}…[truncated]` : out;
}

let prodActionRunsTableReady: Promise<void> | null = null;

export async function ensureProdActionRunsTable(): Promise<void> {
  if (!prodActionRunsTableReady) {
    prodActionRunsTableReady = withDbAttribution(
      "maintenance:prod-actions-runs-ensure-table",
      async () => {
        await getDb().execute(sql`
          CREATE TABLE IF NOT EXISTS "prod_action_runs" (
            "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
            "action_id" varchar(128) NOT NULL,
            "action_title" varchar(256) NOT NULL,
            "actor_user_id" varchar REFERENCES users(id),
            "outcome_state" varchar(16) NOT NULL,
            "detail" text,
            "rows_affected" integer,
            "error_message" text,
            "applied_at" timestamp NOT NULL DEFAULT now()
          )
        `);
        await getDb().execute(sql`
          CREATE INDEX IF NOT EXISTS "idx_prod_action_runs_applied_at"
            ON "prod_action_runs" ("applied_at" DESC)
        `);
        await getDb().execute(sql`
          CREATE INDEX IF NOT EXISTS "idx_prod_action_runs_action_state_time"
            ON "prod_action_runs" ("action_id", "outcome_state", "applied_at" DESC)
        `);
      },
    ).catch((err) => {
      prodActionRunsTableReady = null;
      throw err;
    });
  }
  return prodActionRunsTableReady;
}

export async function recordProdActionRun(
  data: InsertProdActionRun,
): Promise<ProdActionRun> {
  await ensureProdActionRunsTable();
  const sanitized: InsertProdActionRun = {
    ...data,
    detail: redactAuditText(data.detail ?? null),
    errorMessage: redactAuditText(data.errorMessage ?? null),
  };
  const [row] = await withDbAttribution(
    "maintenance:prod-actions-runs-insert",
    () => getDb().insert(prodActionRuns).values(sanitized).returning(),
  );
  return row;
}

export interface ListProdActionRunsOptions {
  // "system" → only automatic self-heal runs (actor_user_id IS NULL).
  // Task #2125 — the CEO panel's self-heal timeline uses this so manual
  // CEO applies (non-null actor) don't push automatic runs out of the
  // limited window.
  actor?: "system" | "all";
  // Task #2232 — restrict the history to a single action so operators can
  // follow a flapping action's pattern without scanning a mixed list.
  // Backed by idx_prod_action_runs_action_state_time.
  actionId?: string;
}

export async function listProdActionRuns(
  limit = 50,
  options: ListProdActionRunsOptions = {},
): Promise<ProdActionRun[]> {
  await ensureProdActionRunsTable();
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
  const systemOnly = options.actor === "system";
  const actionId = options.actionId?.trim();
  return withDbAttribution("maintenance:prod-actions-runs-list", () => {
    const conditions = [
      systemOnly ? isNull(prodActionRuns.actorUserId) : undefined,
      actionId ? eq(prodActionRuns.actionId, actionId) : undefined,
    ].filter(Boolean);
    const base = getDb().select().from(prodActionRuns);
    const filtered =
      conditions.length > 0 ? base.where(and(...conditions)) : base;
    return filtered
      // Deterministic order so the CEO panel pages don't drift when two
      // rows share the same `applied_at` (e.g. NOW() ties inside a single
      // apply press). Tiebreak on the primary key.
      .orderBy(desc(prodActionRuns.appliedAt), desc(prodActionRuns.id))
      .limit(safeLimit);
  });
}

/**
 * Task #1824 — fetch the single most recent `prod_action_runs` row per
 * actionId in `ids`, joined with `users` for actor name/email. Used by
 * the CEO panel's History section so completed actions can show
 * "Applied by X at T". Uses DISTINCT ON to avoid an N+1 across the
 * registry.
 */
export async function getLastProdActionRunsForActions(
  ids: string[],
): Promise<Map<string, ProdActionRunWithActor>> {
  if (ids.length === 0) return new Map();
  await ensureProdActionRunsTable();
  const res = await withDbAttribution(
    "maintenance:prod-actions-runs-last-per-action",
    () =>
      getDb().execute(sql`
        SELECT DISTINCT ON (r.action_id)
          r.id, r.action_id, r.action_title, r.actor_user_id,
          r.outcome_state, r.detail, r.rows_affected, r.error_message,
          r.applied_at,
          u.first_name AS actor_first_name,
          u.last_name AS actor_last_name,
          u.email AS actor_email
        FROM prod_action_runs r
        LEFT JOIN users u ON u.id = r.actor_user_id
        WHERE r.action_id = ANY(${bindArrayParam(ids, "text")})
        ORDER BY r.action_id, r.applied_at DESC, r.id DESC
      `),
  );
  const out = new Map<string, ProdActionRunWithActor>();
  for (const row of res.rows as any[]) {
    const first = row.actor_first_name as string | null;
    const last = row.actor_last_name as string | null;
    const fullName = [first, last].filter(Boolean).join(" ").trim();
    out.set(row.action_id as string, {
      id: row.id,
      actionId: row.action_id,
      actionTitle: row.action_title,
      actorUserId: row.actor_user_id,
      outcomeState: row.outcome_state,
      detail: row.detail,
      rowsAffected: row.rows_affected,
      errorMessage: row.error_message,
      appliedAt: row.applied_at,
      actorName: fullName.length > 0 ? fullName : null,
      actorEmail: row.actor_email,
    });
  }
  return out;
}

export async function getLastSuccessfulProdActionRun(
  actionId: string,
): Promise<ProdActionRun | undefined> {
  await ensureProdActionRunsTable();
  const [row] = await withDbAttribution(
    "maintenance:prod-actions-runs-last-success",
    () =>
      getDb()
        .select()
        .from(prodActionRuns)
        .where(
          and(
            eq(prodActionRuns.actionId, actionId),
            eq(prodActionRuns.outcomeState, "applied"),
          ),
        )
        .orderBy(desc(prodActionRuns.appliedAt), desc(prodActionRuns.id))
        .limit(1),
  );
  return row;
}
