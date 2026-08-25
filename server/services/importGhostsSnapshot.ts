// @db-pool-intent: worker
  //
  // Task #1721 Phase 2.1 / Task #1723: this file calls `getDb()`. The
  // intent above declares which pool every `getDb()` call in this
  // module is expected to land on. See `scripts/lint-db-pool-tenancy.ts`
  // for the contract and `server/db.ts` for the routing.

  /**
 * Task #1222 — daily snapshot of the *other* ghost surfaces audited by
 * `scripts/cleanup-import-ghosts.ts`.
 *
 * Task #758 already auto-runs the SEMrush mapping cleanup
 * (`server/services/semrushGhostCleanup.ts`). The same audit script also
 * surfaces:
 *   • `client_contacts` likely auto-created by the old Front enrichment
 *     path (name="Auto-discovered Contact", is_primary=false), and
 *   • the `import_entity_suggestions` queue summary grouped by
 *     (surface, entity_kind, status).
 *
 * Both still required an operator to invoke the script. This service
 * captures those numbers nightly and persists them to the existing
 * Health rollup infrastructure so operators can see drift on a
 * dashboard without running the script.
 *
 * Conservative on writes: this scheduler **never deletes contacts**.
 * Per-row deletion is still considered too risky because operators may
 * have edited emails/phones on a name="Auto-discovered Contact" row.
 * The snapshot does, however, classify each likely-ghost contact into
 * `unusedContacts` (no referenced communications AND no manual audit
 * edits) so a future task can act on the demonstrably-safe subset.
 *
 * Disable via system setting `import_ghosts_snapshot_enabled`
 * (false/0/off/no). The manual `--apply` script remains the source of
 * truth and is unaffected by this setting.
 */
import cron from "node-cron";
import { and, eq, sql } from "drizzle-orm";
import { getDb, withDbAttribution } from "../db";
import { getSystemSetting, setSystemSetting } from "../storage/settingsStorage";
import { upsertDailyRollup } from "../storage/healthMetricsStorage";
import { bindArrayParam } from "../utils/sqlArray";
import type { InsertHealthDailyRollup } from "@shared/schema";

export const HEALTH_METRIC = "import_ghosts_snapshot";
export const SETTING_ENABLED = "import_ghosts_snapshot_enabled";
export const SETTING_LAST_RUN = "import_ghosts_snapshot_last_run";

const OFF_TOKENS = new Set(["false", "0", "off", "no"]);

let scheduledTask: ReturnType<typeof cron.schedule> | null = null;
let runInFlight = false;

export interface SuggestionGroup {
  surface: string;
  entityKind: string;
  status: string;
  count: number;
}

export interface ImportGhostsSnapshotResult {
  scannedContacts: number;
  ghostContacts: number;
  unusedContacts: number;
  manualEditedGhostContacts: number;
  referencedGhostContacts: number;
  suggestions: SuggestionGroup[];
  pendingSuggestionsCount: number;
  scannedAt: number;
  durationMs: number;
  skippedReason?: "disabled";
}

export async function isImportGhostsSnapshotEnabled(): Promise<boolean> {
  try {
    const row = await getSystemSetting(SETTING_ENABLED);
    const raw = row?.value?.trim().toLowerCase();
    if (!raw) return true;
    return !OFF_TOKENS.has(raw);
  } catch (err: any) {
    console.error(
      "[ImportGhostsSnapshot] Failed to read enabled flag, defaulting to enabled:",
      err?.message ?? err,
    );
    return true;
  }
}

export async function runImportGhostsSnapshot(
  opts: { force?: boolean } = {},
): Promise<ImportGhostsSnapshotResult> {
  const startedAt = Date.now();
  const enabled = opts.force ? true : await isImportGhostsSnapshotEnabled();
  if (!enabled) {
    const result: ImportGhostsSnapshotResult = {
      scannedContacts: 0,
      ghostContacts: 0,
      unusedContacts: 0,
      manualEditedGhostContacts: 0,
      referencedGhostContacts: 0,
      suggestions: [],
      pendingSuggestionsCount: 0,
      scannedAt: startedAt,
      durationMs: 0,
      skippedReason: "disabled",
    };
    await persistLastRun(result);
    console.log(
      `[ImportGhostsSnapshot] Skipped — disabled via system setting "${SETTING_ENABLED}"`,
    );
    return result;
  }

  const db = getDb();
  const {
    clientContacts,
    clientContactsAudit,
    twilioConversations,
    twilioCalls,
    importEntitySuggestions,
  } = await import("@shared/schema");

  // Total contact count (denominator for the rollup `sampleCount`).
  const [{ count: scannedContactsRaw }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(clientContacts);
  const scannedContacts = Number(scannedContactsRaw ?? 0);

  // Likely-ghost auto-discovered contact ids. Mirrors
  // `planAutoDiscoveredContactGhosts` in `scripts/cleanup-import-ghosts.ts`.
  const ghostRows = await db
    .select({ id: clientContacts.id })
    .from(clientContacts)
    .where(
      and(
        eq(clientContacts.isPrimary, false),
        sql`lower(trim(${clientContacts.name})) = 'auto-discovered contact'`,
      ),
    );
  const ghostIds = ghostRows.map((r) => r.id);
  const ghostContacts = ghostIds.length;

  // Per-row "in use" classification. A ghost contact is "unused" when
  // no twilio_conversations / twilio_calls row references it AND its
  // audit trail contains no row with action != 'insert' or with a
  // non-null actor_user_id (i.e. a real human edit). Counted in DB to
  // avoid pulling N rows back to the app.
  let referencedGhostContacts = 0;
  let manualEditedGhostContacts = 0;
  let unusedContacts = 0;
  if (ghostIds.length > 0) {
    const referencedRes = await db.execute<{ count: string }>(sql`
      SELECT COUNT(DISTINCT c.id)::text AS count
      FROM ${clientContacts} c
      WHERE c.id = ANY(${bindArrayParam(ghostIds, "text")})
        AND (
          EXISTS (
            SELECT 1 FROM ${twilioConversations} tc
            WHERE tc.client_contact_id = c.id
          )
          OR EXISTS (
            SELECT 1 FROM ${twilioCalls} tk
            WHERE tk.client_contact_id = c.id
          )
        )
    `);
    referencedGhostContacts = Number(referencedRes.rows?.[0]?.count ?? 0);

    const editedRes = await db.execute<{ count: string }>(sql`
      SELECT COUNT(DISTINCT a.contact_id)::text AS count
      FROM ${clientContactsAudit} a
      WHERE a.contact_id = ANY(${bindArrayParam(ghostIds, "text")})
        AND (a.action <> 'insert' OR a.actor_user_id IS NOT NULL)
    `);
    manualEditedGhostContacts = Number(editedRes.rows?.[0]?.count ?? 0);

    const unusedRes = await db.execute<{ count: string }>(sql`
      SELECT COUNT(*)::text AS count
      FROM ${clientContacts} c
      WHERE c.id = ANY(${bindArrayParam(ghostIds, "text")})
        AND NOT EXISTS (
          SELECT 1 FROM ${twilioConversations} tc
          WHERE tc.client_contact_id = c.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM ${twilioCalls} tk
          WHERE tk.client_contact_id = c.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM ${clientContactsAudit} a
          WHERE a.contact_id = c.id
            AND (a.action <> 'insert' OR a.actor_user_id IS NOT NULL)
        )
    `);
    unusedContacts = Number(unusedRes.rows?.[0]?.count ?? 0);
  }

  // Import-entity-suggestions queue summary, mirroring section 3 of
  // the script.
  const sugRows = await db
    .select({
      surface: importEntitySuggestions.surface,
      entityKind: importEntitySuggestions.entityKind,
      status: importEntitySuggestions.status,
      count: sql<number>`count(*)::int`,
    })
    .from(importEntitySuggestions)
    .groupBy(
      importEntitySuggestions.surface,
      importEntitySuggestions.entityKind,
      importEntitySuggestions.status,
    );
  const suggestions: SuggestionGroup[] = sugRows.map((r) => ({
    surface: String(r.surface),
    entityKind: String(r.entityKind),
    status: String(r.status),
    count: Number(r.count ?? 0),
  }));
  const pendingSuggestionsCount = suggestions
    .filter((s) => s.status === "pending")
    .reduce((sum, s) => sum + s.count, 0);

  const durationMs = Date.now() - startedAt;
  const result: ImportGhostsSnapshotResult = {
    scannedContacts,
    ghostContacts,
    unusedContacts,
    manualEditedGhostContacts,
    referencedGhostContacts,
    suggestions,
    pendingSuggestionsCount,
    scannedAt: startedAt,
    durationMs,
  };

  console.log(
    `[ImportGhostsSnapshot] scannedContacts=${result.scannedContacts} ` +
      `ghostContacts=${result.ghostContacts} ` +
      `unused=${result.unusedContacts} ` +
      `manualEdited=${result.manualEditedGhostContacts} ` +
      `referenced=${result.referencedGhostContacts} ` +
      `pendingSuggestions=${result.pendingSuggestionsCount} ` +
      `suggestionGroups=${result.suggestions.length} ` +
      `durationMs=${result.durationMs}`,
  );

  await persistLastRun(result);
  await recordHealthRollup(result);
  return result;
}

function utcDateString(ts: number): string {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/**
 * Field mapping for `health_daily_rollups`:
 *   sampleCount    = total contacts scanned
 *   alertCount     = likely-ghost auto-discovered contacts (name match)
 *   incidentCount  = unused subset (safe to consider for archive)
 *   metadata       = { pendingSuggestionsCount, suggestionGroupsCount,
 *                      referencedGhostContacts, manualEditedGhostContacts,
 *                      durationMs, scannedAt, skippedReason? }
 */
async function recordHealthRollup(
  result: ImportGhostsSnapshotResult,
): Promise<void> {
  try {
    const record: InsertHealthDailyRollup = {
      metric: HEALTH_METRIC,
      date: utcDateString(result.scannedAt),
      sampleCount: result.scannedContacts,
      okCount: 0,
      degradedCount: 0,
      errorCount: 0,
      p50: null,
      p95: null,
      p99: null,
      minVal: null,
      maxVal: null,
      avgVal: null,
      alertCount: result.ghostContacts,
      incidentCount: result.unusedContacts,
      metadata: {
        pendingSuggestionsCount: result.pendingSuggestionsCount,
        suggestionGroupsCount: result.suggestions.length,
        referencedGhostContacts: result.referencedGhostContacts,
        manualEditedGhostContacts: result.manualEditedGhostContacts,
        durationMs: result.durationMs,
        scannedAt: result.scannedAt,
        ...(result.skippedReason ? { skippedReason: result.skippedReason } : {}),
      },
    };
    await upsertDailyRollup(record);
  } catch (err: any) {
    console.error(
      "[ImportGhostsSnapshot] Failed to record health daily rollup:",
      err?.message ?? err,
    );
  }
}

async function persistLastRun(
  result: ImportGhostsSnapshotResult,
): Promise<void> {
  try {
    await setSystemSetting(SETTING_LAST_RUN, JSON.stringify(result));
  } catch (err: any) {
    console.error(
      "[ImportGhostsSnapshot] Failed to persist last-run summary:",
      err?.message ?? err,
    );
  }
}

/**
 * Why the last-run summary could not be returned as a parsed object:
 *   - "ok"         — a well-formed summary was read.
 *   - "never_run"  — the key is absent/empty; normal on a fresh deploy.
 *   - "unreadable" — the stored value (or the settings read itself)
 *     failed to produce a summary; signals a real persistence bug, not
 *     a fresh deploy.
 */
export type LastImportGhostsSnapshotStatus = "ok" | "never_run" | "unreadable";

export interface LastImportGhostsSnapshotRead {
  /** The parsed summary, or null when status is not "ok". */
  lastRun: ImportGhostsSnapshotResult | null;
  status: LastImportGhostsSnapshotStatus;
  /** Plain-English reason present only when status === "unreadable". */
  error?: string;
}

/**
 * Read the persisted last-run summary and classify the outcome so the
 * operator status route can tell "never ran" (normal) apart from
 * "stored value was unreadable" (a persistence regression). Never
 * throws — a settings-read failure is reported as `unreadable` with the
 * error message rather than masquerading as `never_run`.
 */
export async function readLastImportGhostsSnapshot(): Promise<LastImportGhostsSnapshotRead> {
  let raw: string | undefined;
  try {
    const row = await getSystemSetting(SETTING_LAST_RUN);
    raw = row?.value?.trim();
  } catch (err: any) {
    const message = err?.message ?? String(err);
    console.error(
      "[ImportGhostsSnapshot] Failed to read last-run summary:",
      message,
    );
    return { lastRun: null, status: "unreadable", error: message };
  }

  if (!raw) return { lastRun: null, status: "never_run" };

  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return { lastRun: parsed as ImportGhostsSnapshotResult, status: "ok" };
    }
    const message = "stored last-run value was not a JSON object";
    console.error(`[ImportGhostsSnapshot] ${message}`);
    return { lastRun: null, status: "unreadable", error: message };
  } catch (err: any) {
    const message = err?.message ?? String(err);
    console.error(
      "[ImportGhostsSnapshot] Failed to parse last-run summary:",
      message,
    );
    return { lastRun: null, status: "unreadable", error: message };
  }
}

/**
 * Read the persisted last-run summary, or null if the snapshot has not
 * run yet (or the stored value is unparseable). Thin back-compat wrapper
 * over {@link readLastImportGhostsSnapshot} that preserves the original
 * "null for both never-run and unreadable" contract.
 */
export async function getLastImportGhostsSnapshot(): Promise<ImportGhostsSnapshotResult | null> {
  return (await readLastImportGhostsSnapshot()).lastRun;
}

async function runOnce(): Promise<void> {
  if (runInFlight) {
    console.log(
      "[ImportGhostsSnapshot] Previous run still in flight, skipping",
    );
    return;
  }
  runInFlight = true;
  // Task #2363 — both the cron and the 5s startup run reach here, and on
  // `autoscale` they fire on every instance. The advisory lock makes
  // exactly one instance run the scan/rollup so we don't double-write the
  // daily snapshot rollup row.
  const { acquireWorkerSingletonLock } = await import("./crossInstanceLock");
  const { CROSS_INSTANCE_LOCK_MAX_HOLD_MS } = await import("./workerConfig");
  const { workerLog } = await import("./workerLogger");
  let lock: { release: () => Promise<void> } | null = null;
  try {
    lock = await acquireWorkerSingletonLock(
      "scheduler:import-ghosts-snapshot",
      "[ImportGhostsSnapshot]",
      {
        // Task #2383 — bound the cluster-wide hold so a hung run can't keep
        // the lock forever (self-heals only on crash, not on a hang).
        maxHoldMs: CROSS_INSTANCE_LOCK_MAX_HOLD_MS.import_ghosts_snapshot,
        onWatchdog: (info) =>
          workerLog({
            worker: "import_ghosts_snapshot",
            event: "worker_lock_watchdog_fired",
            lockAge: info.heldMs,
            maxHoldMs: info.maxHoldMs,
          }),
      },
    );
    if (!lock) {
      console.log(
        "[ImportGhostsSnapshot] Another instance is running this snapshot, skipping",
      );
      return;
    }
    await runImportGhostsSnapshot();
  } catch (err: any) {
    console.error(
      "[ImportGhostsSnapshot] Run failed:",
      err?.message ?? err,
    );
  } finally {
    if (lock) await lock.release();
    runInFlight = false;
  }
}

export function startImportGhostsSnapshotScheduler(
  cronExpression = "45 4 * * *",
): void {
  if (scheduledTask) {
    void scheduledTask.stop(); // fire-and-forget: node-cron v4 stop() is async; nothing awaits teardown
  }

  scheduledTask = cron.schedule(
    cronExpression,
    () => {
      void withDbAttribution("scheduler:import-ghosts-snapshot", () =>
        runOnce(),
      );
    },
    { timezone: "America/New_York" },
  );

  console.log(
    `[ImportGhostsSnapshot] Scheduled with cron: ${cronExpression} ` +
      `(America/New_York), admin-disable via system setting "${SETTING_ENABLED}"`,
  );

  setTimeout(() => {
    void withDbAttribution(
      "startup:import-ghosts-snapshot-initial-run",
      () => runOnce(),
    );
  }, 5_000);
}

export function stopImportGhostsSnapshotScheduler(): void {
  if (scheduledTask) {
    void scheduledTask.stop(); // fire-and-forget: node-cron v4 stop() is async; nothing awaits teardown
    scheduledTask = null;
    console.log("[ImportGhostsSnapshot] Stopped");
  }
}
