/**
 * Boot — idempotent schema ensures.
 * Extracted verbatim from server/index.ts (Task #3787 split); invoked from
 * the index.ts bootstrap in the exact original sequence.
 * ensure* column/index helpers + validateBudgetConfig.
 */


export async function ensureFrontSyncEmailsColumns(): Promise<void> {
  const { db: apiDb } = await import("../db");
  const { sql } = await import("drizzle-orm");

  try {
    await apiDb.execute(sql.raw(`SELECT 1 FROM front_sync_emails LIMIT 0`));
  } catch (err: any) {
    console.error("[Bootstrap] CRITICAL: front_sync_emails table does not exist:", err?.message);
    throw new Error(`[Bootstrap] front_sync_emails table missing: ${err?.message}`);
  }

  const cols = [
    { name: "pipeline_state", ddl: `ALTER TABLE front_sync_emails ADD COLUMN IF NOT EXISTS pipeline_state varchar NOT NULL DEFAULT 'discovered'` },
    { name: "last_message_id", ddl: `ALTER TABLE front_sync_emails ADD COLUMN IF NOT EXISTS last_message_id text` },
    { name: "version_key", ddl: `ALTER TABLE front_sync_emails ADD COLUMN IF NOT EXISTS version_key text` },
    { name: "pipeline_error", ddl: `ALTER TABLE front_sync_emails ADD COLUMN IF NOT EXISTS pipeline_error text` },
    { name: "pipeline_attempts", ddl: `ALTER TABLE front_sync_emails ADD COLUMN IF NOT EXISTS pipeline_attempts integer NOT NULL DEFAULT 0` },
    { name: "state_changed_at", ddl: `ALTER TABLE front_sync_emails ADD COLUMN IF NOT EXISTS state_changed_at timestamp DEFAULT now()` },
    { name: "bulk_classifier_version", ddl: `ALTER TABLE front_sync_emails ADD COLUMN IF NOT EXISTS bulk_classifier_version integer` },
  ];

  const failures: string[] = [];
  for (const col of cols) {
    try {
      await apiDb.execute(sql.raw(col.ddl));
    } catch (e: any) {
      if (!e?.message?.includes("already exists")) {
        console.error(`[Bootstrap] Failed to add column ${col.name}:`, e?.message);
        failures.push(col.name);
      }
    }
  }

  if (failures.length > 0) {
    throw new Error(`[Bootstrap] front_sync_emails column setup failed for: ${failures.join(", ")}`);
  }

  await apiDb.execute(sql.raw(`CREATE INDEX IF NOT EXISTS front_sync_pipeline_state_idx ON front_sync_emails (pipeline_state)`));
  await apiDb.execute(sql.raw(`CREATE INDEX IF NOT EXISTS front_sync_version_key_idx ON front_sync_emails (version_key)`));

  console.log("[Bootstrap] front_sync_emails columns ensured");
}

export async function ensureTwilioColumns(): Promise<void> {
  const { db: apiDb } = await import("../db");
  const { sql } = await import("drizzle-orm");

  try {
    await apiDb.execute(sql.raw(`SELECT 1 FROM twilio_conversations LIMIT 0`));
    await apiDb.execute(sql.raw(`SELECT 1 FROM twilio_calls LIMIT 0`));
  } catch (err: any) {
    console.error("[Bootstrap] CRITICAL: Twilio tables do not exist:", err?.message);
    throw new Error(`[Bootstrap] Twilio tables missing: ${err?.message}`);
  }

  const cols = [
    { name: "display_name", ddl: `ALTER TABLE twilio_conversations ADD COLUMN IF NOT EXISTS display_name varchar` },
    { name: "routed_to_user_id", ddl: `ALTER TABLE twilio_calls ADD COLUMN IF NOT EXISTS routed_to_user_id varchar REFERENCES users(id)` },
    { name: "routing_tier", ddl: `ALTER TABLE twilio_calls ADD COLUMN IF NOT EXISTS routing_tier integer` },
    { name: "answered_at", ddl: `ALTER TABLE twilio_calls ADD COLUMN IF NOT EXISTS answered_at timestamp` },
    // Task #849 (catch-up): direct-thread dedupe columns/indexes. Schema lives
    // in shared/models/communications.ts but pre-#849 dev DBs may be missing
    // them; the dedupe test depends on these being present.
    { name: "contact_phone_normalized", ddl: `ALTER TABLE twilio_conversations ADD COLUMN IF NOT EXISTS contact_phone_normalized varchar` },
    { name: "twilio_phone_number_normalized", ddl: `ALTER TABLE twilio_conversations ADD COLUMN IF NOT EXISTS twilio_phone_number_normalized varchar` },
    { name: "direct_thread_key", ddl: `ALTER TABLE twilio_conversations ADD COLUMN IF NOT EXISTS direct_thread_key varchar` },
    { name: "twilio_conv_contact_normalized_idx", ddl: `CREATE INDEX IF NOT EXISTS twilio_conv_contact_normalized_idx ON twilio_conversations(contact_phone_normalized)` },
    { name: "twilio_conv_twilio_normalized_idx", ddl: `CREATE INDEX IF NOT EXISTS twilio_conv_twilio_normalized_idx ON twilio_conversations(twilio_phone_number_normalized)` },
    { name: "twilio_conv_direct_thread_key_idx", ddl: `CREATE INDEX IF NOT EXISTS twilio_conv_direct_thread_key_idx ON twilio_conversations(direct_thread_key)` },
    { name: "twilio_conv_direct_active_uniq", ddl: `CREATE UNIQUE INDEX IF NOT EXISTS twilio_conv_direct_active_uniq ON twilio_conversations(direct_thread_key) WHERE direct_thread_key IS NOT NULL AND status = 'active'` },
  ];

  const failures: string[] = [];
  for (const col of cols) {
    try {
      await apiDb.execute(sql.raw(col.ddl));
    } catch (e: any) {
      if (!e?.message?.includes("already exists")) {
        console.error(`[Bootstrap] Failed to add Twilio column ${col.name}:`, e?.message);
        failures.push(col.name);
      }
    }
  }

  if (failures.length > 0) {
    throw new Error(`[Bootstrap] Twilio column setup failed for: ${failures.join(", ")}`);
  }

  console.log("[Bootstrap] Twilio columns ensured");
}

export async function ensureRawCommunicationColumns(): Promise<void> {
  const { db: apiDb } = await import("../db");
  const { sql } = await import("drizzle-orm");

  try {
    await apiDb.execute(sql.raw(`SELECT 1 FROM raw_communication_records LIMIT 0`));
  } catch (err: any) {
    console.error("[Bootstrap] CRITICAL: raw_communication_records table does not exist:", err?.message);
    throw new Error(`[Bootstrap] raw_communication_records table missing: ${err?.message}`);
  }

  const cols = [
    { name: "match_method", ddl: `ALTER TABLE raw_communication_records ADD COLUMN IF NOT EXISTS match_method varchar` },
    { name: "match_confidence", ddl: `ALTER TABLE raw_communication_records ADD COLUMN IF NOT EXISTS match_confidence real` },
    { name: "match_status", ddl: `ALTER TABLE raw_communication_records ADD COLUMN IF NOT EXISTS match_status varchar` },
    { name: "transcript_status", ddl: `ALTER TABLE raw_communication_records ADD COLUMN IF NOT EXISTS transcript_status varchar` },
  ];

  const failures: string[] = [];
  for (const col of cols) {
    try {
      await apiDb.execute(sql.raw(col.ddl));
    } catch (e: any) {
      if (!e?.message?.includes("already exists")) {
        console.error(`[Bootstrap] Failed to add raw_communication_records column ${col.name}:`, e?.message);
        failures.push(col.name);
      }
    }
  }

  if (failures.length > 0) {
    throw new Error(`[Bootstrap] raw_communication_records column setup failed for: ${failures.join(", ")}`);
  }

  console.log("[Bootstrap] raw_communication_records columns ensured");
}

export async function ensureExternalSourceIdUnique(): Promise<void> {
  // Runs in development as well as production so the dev database carries the
  // same partial UNIQUE index as prod. Replit Publish diffs the introspected
  // dev DB against the introspected prod DB; if dev lacks this raw-SQL-managed
  // index (it is intentionally not in shared/schema.ts), the publish proposes
  // dropping it from production. Skipped only under tests to avoid DDL/DELETE
  // side effects on the test database.
  if (process.env.NODE_ENV === "test") return;
  const { db: apiDb } = await import("../db");
  const { sql } = await import("drizzle-orm");

  const checkResult = await apiDb.execute(sql`
    SELECT EXISTS (
      SELECT 1 FROM pg_indexes
      WHERE indexname = 'raw_comm_external_source_id_unique_idx'
    ) as exists
  `);
  const indexExists = (checkResult.rows[0] as any)?.exists;
  if (indexExists) return;

  const dupeResult = await apiDb.execute(sql`
    SELECT external_source_id, COUNT(*) as cnt
    FROM raw_communication_records
    WHERE external_source_id IS NOT NULL
    GROUP BY external_source_id
    HAVING COUNT(*) > 1
  `);
  const dupeCount = dupeResult.rows.length;

  if (dupeCount > 0) {
    console.log(`[Bootstrap] Deduplicating ${dupeCount} external_source_id groups (keeping oldest by created_at)...`);
    const deleteResult = await apiDb.execute(sql`
      DELETE FROM raw_communication_records
      WHERE id IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (
            PARTITION BY external_source_id
            ORDER BY created_at ASC
          ) as rn
          FROM raw_communication_records
          WHERE external_source_id IS NOT NULL
        ) ranked
        WHERE rn > 1
      )
    `);
    console.log(`[Bootstrap] Removed ${(deleteResult as any).rowCount ?? 0} duplicate records`);
  }

  await apiDb.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS raw_comm_external_source_id_unique_idx
    ON raw_communication_records (external_source_id)
    WHERE external_source_id IS NOT NULL
  `);
  console.log("[Bootstrap] Created unique index on external_source_id");
}

export async function validateBudgetConfig(): Promise<void> {
  const { PERF } = await import("../perfConfig");
  const { getClassStatus, TOTAL_BUDGET } = await import("../services/workloadManager");

  const workerPoolMax = PERF.DB_WORKER_POOL_MAX;
  const classStatus = getClassStatus();
  let totalMaxSlots = 0;
  for (const info of Object.values(classStatus)) {
    totalMaxSlots += info.maxConcurrency;
  }

  console.log(`[BudgetValidation] DB worker pool max: ${workerPoolMax}, global slot cap: ${TOTAL_BUDGET}, sum of class maxConcurrency: ${totalMaxSlots}`);
  for (const [cls, info] of Object.entries(classStatus)) {
    console.log(`[BudgetValidation]   ${cls}: maxConcurrency=${info.maxConcurrency}`);
  }

  if (TOTAL_BUDGET > workerPoolMax) {
    console.warn(`[BudgetValidation] WARNING: global slot cap (${TOTAL_BUDGET}) exceeds DB worker pool max (${workerPoolMax}) — jobs may stall waiting for connections`);
  }

  if (TOTAL_BUDGET > workerPoolMax - 1) {
    console.warn(`[BudgetValidation] WARNING: global slot cap (${TOTAL_BUDGET}) leaves <1 spare DB worker connection for non-slot operations`);
  }

  console.log(`[BudgetValidation] Feature flags: REPAIR_QUEUE_ENABLED=${PERF.REPAIR_QUEUE_ENABLED}, REPAIR_DISPATCHER_ENABLED=${PERF.REPAIR_DISPATCHER_ENABLED}, INTERACTIVE_REPAIR_ENQUEUE_ENABLED=${PERF.INTERACTIVE_REPAIR_ENQUEUE_ENABLED}`);

  if (PERF.REPAIR_QUEUE_ENABLED && !PERF.REPAIR_DISPATCHER_ENABLED) {
    console.log("[BudgetValidation] REPAIR_QUEUE_ENABLED=true but REPAIR_DISPATCHER_ENABLED=false — scheduler will handle repair classes as fallback");
  }

  if (PERF.INTERACTIVE_REPAIR_ENQUEUE_ENABLED && !PERF.REPAIR_DISPATCHER_ENABLED) {
    console.log("[BudgetValidation] INTERACTIVE_REPAIR_ENQUEUE_ENABLED=true but REPAIR_DISPATCHER_ENABLED=false — scheduler will handle interactive repair classes as fallback");
  }
}
