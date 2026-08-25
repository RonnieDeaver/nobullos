// @db-pool-intent: ambient
//
// Task #1721 Phase 2.1 / Task #1723: this file calls `getDb()`. The
// intent above declares which pool every `getDb()` call in this
// module is expected to land on. See `scripts/lint-db-pool-tenancy.ts`
// for the contract and `server/db.ts` for the routing.
//
// Task #4336 — storage for the SMS consent ledger, its append-only event
// history, and the automated-send gate audit log. All ledger writes are
// atomic `INSERT … ON CONFLICT (phone_normalized)` upserts (P1: no
// SELECT-then-INSERT identity races). The prior-state SELECT that feeds the
// event row's `prior_state` runs immediately before the upsert WITHOUT a
// lock: two concurrent writers for the SAME phone can each observe the same
// prior state, but the ledger itself converges last-write-wins and the event
// rows keep both observations — accepted and documented (webhook deliveries
// for one phone are effectively serialized upstream by the SID dedupe).

import { getDb, withDbAttribution } from "../db";
import {
  smsConsentLedger,
  smsConsentEvents,
  smsSendGateAudit,
  bookContacts,
  bookOutbox,
  type SmsConsentLedgerRow,
  type SmsConsentEvent,
  type SmsSendGateAuditRow,
  type InsertSmsSendGateAudit,
  type SmsConsentState,
  type SmsConsentSource,
  type SmsConsentEventType,
} from "@shared/schema";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";

type ConsentTx = Parameters<
  Parameters<ReturnType<typeof getDb>["transaction"]>[0]
>[0];

export interface ConsentStateChangeParams {
  phoneE164: string;
  phoneMatchKey: string;
  newState: SmsConsentState;
  source: SmsConsentSource;
  evidence: string;
  /**
   * Optional IANA timezone override. `undefined` = leave any existing value
   * untouched; explicit `null` clears it.
   */
  timezone?: string | null;
  /** Real users.id or null ONLY — synthetic markers violate the FK. */
  actorUserId?: string | null;
  /**
   * Backfill semantics: apply only when the ledger has no row for the phone
   * or the existing row is still `unknown`. NOT race-proof against a
   * concurrent same-phone writer (plain read-then-write) — acceptable for
   * the operator-run backfill prod-action it exists for.
   */
  onlyIfCurrentStateUnknownOrAbsent?: boolean;
  event: {
    eventType: SmsConsentEventType;
    messageSid?: string | null;
    keyword?: string | null;
    detail?: string | null;
  };
}

export interface ConsentStateChangeResult {
  /** True when the ledger row was created or its state actually changed. */
  changed: boolean;
  priorState: SmsConsentState | null;
  row: SmsConsentLedgerRow | null;
  /**
   * False when the event carried a MessageSid that already exists (replayed
   * webhook racing past the app-level dedupe) — the partial unique index
   * made the event insert a no-op.
   */
  eventInserted: boolean;
  skipped: boolean;
}

const GHL_MIRRORED_CONSENT_SOURCES = new Set<SmsConsentSource>([
  "keyword_inbound",
  "twilio_block_21610",
  "manual",
]);

async function appendGhlConsentSyncOutboxTx(
  tx: ConsentTx,
  params: {
    consentEventId: string;
    ledgerId: string;
    phoneE164: string;
    phoneMatchKey: string;
    source: SmsConsentSource;
  },
): Promise<void> {
  // GHL-originated DND already changed the remote contact, while checkout and
  // backfill observations are not authoritative opt-in/opt-out transitions.
  if (!GHL_MIRRORED_CONSENT_SOURCES.has(params.source)) return;

  const contacts = await tx
    .select({ id: bookContacts.id })
    .from(bookContacts)
    .where(
      or(
        eq(bookContacts.smsConsentEvidenceRef, params.ledgerId),
        sql`right(regexp_replace(coalesce(${bookContacts.phone}, ''), '[^0-9]', '', 'g'), 10) = ${params.phoneMatchKey}`,
      ),
    );
  if (contacts.length === 0) return;

  await tx
    .insert(bookOutbox)
    .values(
      contacts.map((contact) => ({
        eventType: "consent.sms_updated" as const,
        sourceType: "sms_consent_event",
        sourceId: params.consentEventId,
        status: "pending" as const,
        payload: {
          contactId: contact.id,
          phone: params.phoneE164,
          source: params.source,
        },
        maxAttempts: 5,
        idempotencyKey: `ghl-consent:${params.consentEventId}:${contact.id}`,
      })),
    )
    .onConflictDoNothing();
}

/**
 * Apply a consent-state change: upsert the ledger row, then append the event.
 * Ledger-first ordering is deliberate: if the process dies between the two
 * statements, a webhook redelivery re-applies the (idempotent) ledger write
 * and backfills the missing event row.
 */
export async function applyConsentStateChange(
  params: ConsentStateChangeParams,
): Promise<ConsentStateChangeResult> {
  return withDbAttribution("comms:sms-consent-apply-state-change", async () => {
    const db = getDb();
    return db.transaction(async (tx) => {
      const existing = await tx
        .select()
        .from(smsConsentLedger)
        .where(eq(smsConsentLedger.phoneNormalized, params.phoneE164))
        .limit(1);
      const priorRow = existing[0] ?? null;
      const priorState = (priorRow?.state as SmsConsentState | undefined) ?? null;

      if (
        params.onlyIfCurrentStateUnknownOrAbsent &&
        priorRow !== null &&
        priorRow.state !== "unknown"
      ) {
        return { changed: false, priorState, row: priorRow, eventInserted: false, skipped: true };
      }

      const isOptIn = params.newState === "opted_in";
      const isOptOut = params.newState === "opted_out";

      const [row] = await tx
        .insert(smsConsentLedger)
        .values({
          phoneNormalized: params.phoneE164,
          phoneMatchKey: params.phoneMatchKey,
          state: params.newState,
          source: params.source,
          evidence: params.evidence,
          timezone: params.timezone ?? null,
          optedInAt: isOptIn ? new Date() : null,
          optedOutAt: isOptOut ? new Date() : null,
          updatedByUserId: params.actorUserId ?? null,
        })
        .onConflictDoUpdate({
          target: smsConsentLedger.phoneNormalized,
          set: {
            state: params.newState,
            source: params.source,
            evidence: params.evidence,
            updatedByUserId: params.actorUserId ?? null,
            updatedAt: sql`now()`,
            optedInAt: isOptIn ? sql`now()` : sql`${smsConsentLedger.optedInAt}`,
            optedOutAt: isOptOut ? sql`now()` : sql`${smsConsentLedger.optedOutAt}`,
            timezone:
              params.timezone !== undefined
                ? params.timezone
                : sql`${smsConsentLedger.timezone}`,
          },
        })
        .returning();

      const insertedEvents = await tx
        .insert(smsConsentEvents)
        .values({
          phoneNormalized: params.phoneE164,
          eventType: params.event.eventType,
          messageSid: params.event.messageSid ?? null,
          keyword: params.event.keyword ?? null,
          priorState,
          newState: params.newState,
          source: params.source,
          actorUserId: params.actorUserId ?? null,
          detail: params.event.detail ?? null,
        })
        .onConflictDoNothing()
        .returning({ id: smsConsentEvents.id });
      const consentEventId = insertedEvents[0]?.id;

      if (consentEventId && row) {
        await appendGhlConsentSyncOutboxTx(tx, {
          consentEventId,
          ledgerId: row.id,
          phoneE164: params.phoneE164,
          phoneMatchKey: params.phoneMatchKey,
          source: params.source,
        });
      }

      return {
        changed: priorState !== params.newState,
        priorState,
        row: row ?? null,
        eventInserted: Boolean(consentEventId),
        skipped: false,
      };
    });
  });
}

export interface AtomicDedupedConsentChangeParams {
  phoneE164: string;
  phoneMatchKey: string;
  newState: SmsConsentState;
  source: SmsConsentSource;
  evidence: string;
  timezone?: string | null;
  actorUserId?: string | null;
  event: {
    eventType: SmsConsentEventType;
    /**
     * REQUIRED dedupe key. The partial unique index on
     * sms_consent_events.message_sid decides idempotency: if this key already
     * exists, the whole change is a no-op (ledger untouched).
     */
    messageSid: string;
    keyword?: string | null;
    detail?: string | null;
  };
}

/**
 * Atomic, replay-safe consent state change deduped on a REQUIRED messageSid.
 *
 * Unlike {@link applyConsentStateChange} (ledger-first, best-effort event),
 * this runs a SINGLE transaction that:
 *   1. Attempts to INSERT the event row (ON CONFLICT (message_sid) DO NOTHING).
 *   2. Only if the event was newly inserted (eventInserted === true) does it
 *      upsert the ledger — stamping optedOutAt / evidence / source.
 *
 * On replay (same messageSid) the event insert returns zero rows, the ledger
 * upsert is SKIPPED entirely, and the result reports
 * `{ eventInserted: false, changed: false }` with the ledger row left exactly
 * as it was. This makes GHL webhook redeliveries a true no-op: no
 * optedOutAt/evidence churn, no duplicate storm-watcher trigger.
 *
 * Callers that don't need messageSid-gated atomicity should keep using
 * {@link applyConsentStateChange} (semantics preserved for them).
 */
export async function applyDedupedConsentStateChange(
  params: AtomicDedupedConsentChangeParams,
): Promise<ConsentStateChangeResult> {
  return withDbAttribution("comms:sms-consent-apply-deduped", async () => {
    const db = getDb();
    return db.transaction(async (tx) => {
      // 1. Read prior state (for the event's prior_state column + changed flag).
      const [priorRow] = await tx
        .select()
        .from(smsConsentLedger)
        .where(eq(smsConsentLedger.phoneNormalized, params.phoneE164))
        .limit(1);
      const priorState =
        (priorRow?.state as SmsConsentState | undefined) ?? null;

      // 2. Attempt the deduped event insert FIRST — it is the idempotency gate.
      const insertedEvents = await tx
        .insert(smsConsentEvents)
        .values({
          phoneNormalized: params.phoneE164,
          messageSid: params.event.messageSid,
          eventType: params.event.eventType,
          keyword: params.event.keyword ?? null,
          priorState,
          newState: params.newState,
          source: params.source,
          actorUserId: params.actorUserId ?? null,
          detail: params.event.detail ?? null,
        })
        .onConflictDoNothing()
        .returning({ id: smsConsentEvents.id });

      const eventInserted = insertedEvents.length > 0;

      // 3. Replay (event already existed): DO NOT touch the ledger. Return the
      //    existing ledger row unchanged.
      if (!eventInserted) {
        return {
          changed: false,
          priorState,
          row: priorRow ?? null,
          eventInserted: false,
          skipped: true,
        };
      }

      // 4. Fresh event — upsert the ledger.
      const isOptIn = params.newState === "opted_in";
      const isOptOut = params.newState === "opted_out";
      const [row] = await tx
        .insert(smsConsentLedger)
        .values({
          phoneNormalized: params.phoneE164,
          phoneMatchKey: params.phoneMatchKey,
          state: params.newState,
          source: params.source,
          evidence: params.evidence,
          timezone: params.timezone ?? null,
          optedInAt: isOptIn ? new Date() : null,
          optedOutAt: isOptOut ? new Date() : null,
          updatedByUserId: params.actorUserId ?? null,
        })
        .onConflictDoUpdate({
          target: smsConsentLedger.phoneNormalized,
          set: {
            state: params.newState,
            source: params.source,
            evidence: params.evidence,
            updatedByUserId: params.actorUserId ?? null,
            updatedAt: sql`now()`,
            optedInAt: isOptIn ? sql`now()` : sql`${smsConsentLedger.optedInAt}`,
            optedOutAt: isOptOut ? sql`now()` : sql`${smsConsentLedger.optedOutAt}`,
            timezone:
              params.timezone !== undefined
                ? params.timezone
                : sql`${smsConsentLedger.timezone}`,
          },
        })
        .returning();

      if (row && insertedEvents[0]?.id) {
        await appendGhlConsentSyncOutboxTx(tx, {
          consentEventId: insertedEvents[0].id,
          ledgerId: row.id,
          phoneE164: params.phoneE164,
          phoneMatchKey: params.phoneMatchKey,
          source: params.source,
        });
      }

      return {
        changed: priorState !== params.newState,
        priorState,
        row: row ?? null,
        eventInserted: true,
        skipped: false,
      };
    });
  });
}

/**
 * Append a consent event WITHOUT touching the ledger (HELP keywords).
 * Returns false when a MessageSid-carrying event already existed.
 */
export async function insertConsentEvent(data: {
  phoneNormalized: string;
  eventType: SmsConsentEventType;
  messageSid?: string | null;
  keyword?: string | null;
  priorState?: SmsConsentState | null;
  newState?: SmsConsentState | null;
  source: SmsConsentSource;
  actorUserId?: string | null;
  detail?: string | null;
}): Promise<boolean> {
  return withDbAttribution("comms:sms-consent-insert-event", async () => {
    const inserted = await getDb()
      .insert(smsConsentEvents)
      .values({
        phoneNormalized: data.phoneNormalized,
        messageSid: data.messageSid ?? null,
        eventType: data.eventType,
        keyword: data.keyword ?? null,
        priorState: data.priorState ?? null,
        newState: data.newState ?? null,
        source: data.source,
        actorUserId: data.actorUserId ?? null,
        detail: data.detail ?? null,
      })
      .onConflictDoNothing()
      .returning({ id: smsConsentEvents.id });
    return inserted.length > 0;
  });
}

/**
 * Seed `unknown` ledger rows for phones with no ledger entry yet.
 * ON CONFLICT DO NOTHING — never touches existing rows. Returns how many
 * rows were actually created.
 */
export async function seedUnknownConsentRows(
  phones: Array<{ phoneE164: string; phoneMatchKey: string }>,
  evidence: string,
): Promise<number> {
  if (phones.length === 0) return 0;
  return withDbAttribution("comms:sms-consent-seed-unknown", async () => {
    const db = getDb();
    let created = 0;
    const CHUNK = 500;
    for (let i = 0; i < phones.length; i += CHUNK) {
      const chunk = phones.slice(i, i + CHUNK);
      const inserted = await db
        .insert(smsConsentLedger)
        .values(
          chunk.map((p) => ({
            phoneNormalized: p.phoneE164,
            phoneMatchKey: p.phoneMatchKey,
            state: "unknown" as const,
            source: "backfill_seed" as const,
            evidence,
          })),
        )
        .onConflictDoNothing()
        .returning({ id: smsConsentLedger.id });
      created += inserted.length;
    }
    return created;
  });
}

export async function getConsentByPhoneE164(
  phoneE164: string,
): Promise<SmsConsentLedgerRow | null> {
  return withDbAttribution("comms:sms-consent-get-by-phone", async () => {
    const rows = await getDb()
      .select()
      .from(smsConsentLedger)
      .where(eq(smsConsentLedger.phoneNormalized, phoneE164))
      .limit(1);
    return rows[0] ?? null;
  });
}

/** Batch lookup for UI surfaces holding loosely-formatted phone strings. */
export async function getConsentsByMatchKeys(
  matchKeys: string[],
): Promise<SmsConsentLedgerRow[]> {
  if (matchKeys.length === 0) return [];
  return withDbAttribution("comms:sms-consent-get-by-match-keys", async () =>
    getDb()
      .select()
      .from(smsConsentLedger)
      .where(inArray(smsConsentLedger.phoneMatchKey, matchKeys)),
  );
}

export interface LedgerListFilters {
  state?: SmsConsentState;
  /** Digits-only substring match against the phone match key. */
  searchDigits?: string;
  limit: number;
  offset: number;
}

export async function listConsentLedger(
  filters: LedgerListFilters,
): Promise<{ rows: SmsConsentLedgerRow[]; total: number }> {
  const conditions = [];
  if (filters.state !== undefined) {
    conditions.push(eq(smsConsentLedger.state, filters.state));
  }
  if (filters.searchDigits) {
    conditions.push(
      sql`${smsConsentLedger.phoneMatchKey} LIKE ${"%" + filters.searchDigits + "%"}`,
    );
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  return withDbAttribution("comms:sms-consent-list-ledger", async () => {
    const db = getDb();
    const rows = await db
      .select()
      .from(smsConsentLedger)
      .where(where)
      .orderBy(desc(smsConsentLedger.updatedAt))
      .limit(filters.limit)
      .offset(filters.offset);
    const totalRows = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(smsConsentLedger)
      .where(where);
    return { rows, total: totalRows[0]?.n ?? 0 };
  });
}

export async function countLedgerByState(): Promise<Record<string, number>> {
  return withDbAttribution("comms:sms-consent-count-by-state", async () => {
    const rows = await getDb()
      .select({
        state: smsConsentLedger.state,
        n: sql<number>`count(*)::int`,
      })
      .from(smsConsentLedger)
      .groupBy(smsConsentLedger.state);
    const out: Record<string, number> = {};
    for (const r of rows) out[r.state] = r.n;
    return out;
  });
}

export async function listConsentEvents(params: {
  phoneE164?: string;
  limit: number;
  offset: number;
}): Promise<SmsConsentEvent[]> {
  const where =
    params.phoneE164 !== undefined
      ? eq(smsConsentEvents.phoneNormalized, params.phoneE164)
      : undefined;
  return withDbAttribution("comms:sms-consent-list-events", async () =>
    getDb()
      .select()
      .from(smsConsentEvents)
      .where(where)
      .orderBy(desc(smsConsentEvents.createdAt))
      .limit(params.limit)
      .offset(params.offset),
  );
}

export async function insertSendGateAudit(
  data: InsertSmsSendGateAudit,
): Promise<SmsSendGateAuditRow> {
  return withDbAttribution("comms:sms-consent-insert-gate-audit", async () => {
    const [row] = await getDb().insert(smsSendGateAudit).values(data).returning();
    return row;
  });
}

export async function listSendGateAudit(params: {
  limit: number;
  offset: number;
  outcome?: string;
}): Promise<SmsSendGateAuditRow[]> {
  const where =
    params.outcome !== undefined
      ? eq(smsSendGateAudit.outcome, params.outcome)
      : undefined;
  return withDbAttribution("comms:sms-consent-list-gate-audit", async () =>
    getDb()
      .select()
      .from(smsSendGateAudit)
      .where(where)
      .orderBy(desc(smsSendGateAudit.createdAt))
      .limit(params.limit)
      .offset(params.offset),
  );
}

/**
 * Count opt-out keyword events in the trailing window — used by the
 * opt-out-storm watcher as its durable fallback source (the in-memory ring
 * buffer resets on restart; this query does not).
 */
export async function countRecentOptOutEvents(windowMinutes: number): Promise<number> {
  return withDbAttribution("comms:sms-consent-count-recent-optouts", async () => {
    const rows = await getDb()
      .select({ n: sql<number>`count(*)::int` })
      .from(smsConsentEvents)
      .where(
        and(
          eq(smsConsentEvents.eventType, "opt_out"),
          sql`${smsConsentEvents.createdAt} >= now() - (${windowMinutes} || ' minutes')::interval`,
        ),
      );
    return rows[0]?.n ?? 0;
  });
}
