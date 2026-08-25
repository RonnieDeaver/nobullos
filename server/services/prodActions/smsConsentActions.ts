// @db-pool-intent: worker
/**
 * Prod-action domain module — Task #4336: SMS consent ledger backfill.
 *
 * One converging action that brings the consent ledger to full coverage of
 * every phone number the system already knows about:
 *
 *   Pass 1 — historical keyword scan: walk ALL inbound twilio_messages
 *   chronologically, classify each body with the same classifier the live
 *   webhook uses, and apply the LAST expressed opt-in/opt-out per phone as
 *   `backfill_history`. Guarded by `onlyIfCurrentStateUnknownOrAbsent` so it
 *   can never clobber state recorded by live traffic or an operator after
 *   the feature shipped. (Production had ZERO historical keyword messages at
 *   ship time — this pass is a formal safety net, not expected work.)
 *
 *   Pass 2 — unknown seeding: union every known phone (client_contacts
 *   phones_normalized, clients.contact_phone, twilio_conversations
 *   contact_phone_normalized, inbound twilio_messages senders) and INSERT a
 *   state=`unknown` ledger row for any not yet present (ON CONFLICT DO
 *   NOTHING). This is what makes consent state VISIBLE on contact/client
 *   surfaces ("unknown" is an explicit answer, not silence).
 *
 * Idempotent by construction: a repeat run after success finds nothing to
 * do and reports not-needed. The phone universe is tiny (~100 numbers in
 * prod), so full scans per run are trivially cheap.
 */

import { sql } from "drizzle-orm";
import { getDb, withDbAttribution } from "../../db";
import { type ProdAction, type ProdActionDomain } from "./kernel";
import { classifySmsConsentKeyword } from "../smsConsentKeywords";
import { normalizeToE164, getPhoneMatchKey } from "../phoneNormalization";
import {
  applyConsentStateChange,
  getConsentsByMatchKeys,
  seedUnknownConsentRows,
} from "../../storage/smsConsentStorage";

interface KnownPhone {
  phoneE164: string;
  phoneMatchKey: string;
}

/** Union of every phone number the system knows, keyed by match key. */
async function collectKnownPhoneUniverse(): Promise<Map<string, KnownPhone>> {
  const [contactRows, clientRows, convRows, inboundRows] = await Promise.all([
    withDbAttribution("maintenance:sms-consent-backfill-contact-phones", () =>
      getDb().execute(sql`
        SELECT unnest(phones_normalized) AS phone
        FROM client_contacts
        WHERE phones_normalized IS NOT NULL
      `),
    ),
    withDbAttribution("maintenance:sms-consent-backfill-client-phones", () =>
      getDb().execute(sql`
        SELECT contact_phone AS phone
        FROM clients
        WHERE contact_phone IS NOT NULL AND contact_phone <> ''
      `),
    ),
    withDbAttribution("maintenance:sms-consent-backfill-conv-phones", () =>
      getDb().execute(sql`
        SELECT COALESCE(contact_phone_normalized, contact_phone) AS phone
        FROM twilio_conversations
      `),
    ),
    withDbAttribution("maintenance:sms-consent-backfill-inbound-phones", () =>
      getDb().execute(sql`
        SELECT DISTINCT from_number AS phone
        FROM twilio_messages
        WHERE direction = 'inbound' AND from_number IS NOT NULL
      `),
    ),
  ]);

  const universe = new Map<string, KnownPhone>();
  for (const result of [contactRows, clientRows, convRows, inboundRows]) {
    for (const row of result.rows as Array<{ phone: string | null }>) {
      const raw = row.phone;
      if (!raw) continue;
      const phoneMatchKey = getPhoneMatchKey(raw);
      const phoneE164 = normalizeToE164(raw);
      if (phoneMatchKey === null || !phoneE164) continue;
      if (!universe.has(phoneMatchKey)) {
        universe.set(phoneMatchKey, { phoneE164, phoneMatchKey });
      }
    }
  }
  return universe;
}

interface HistoricalKeywordFinding {
  phoneE164: string;
  phoneMatchKey: string;
  kind: "opt_out" | "opt_in";
  keyword: string;
  messageSid: string | null;
  atIso: string;
}

/**
 * Latest opt-in/opt-out keyword per phone across all historical inbound
 * messages (chronological walk, last keyword wins; HELP is state-neutral).
 */
async function scanHistoricalKeywords(): Promise<Map<string, HistoricalKeywordFinding>> {
  const result = await withDbAttribution("maintenance:sms-consent-backfill-history-scan", () =>
    getDb().execute(sql`
      SELECT twilio_sid, from_number, body, created_at
      FROM twilio_messages
      WHERE direction = 'inbound' AND body IS NOT NULL
      ORDER BY created_at ASC, id ASC
    `),
  );
  const latest = new Map<string, HistoricalKeywordFinding>();
  for (const row of result.rows as Array<{
    twilio_sid: string | null;
    from_number: string | null;
    body: string;
    created_at: string | Date;
  }>) {
    if (!row.from_number) continue;
    const match = classifySmsConsentKeyword(row.body);
    if (match === null || match.kind === "help") continue;
    const phoneMatchKey = getPhoneMatchKey(row.from_number);
    const phoneE164 = normalizeToE164(row.from_number);
    if (phoneMatchKey === null || !phoneE164) continue;
    latest.set(phoneMatchKey, {
      phoneE164,
      phoneMatchKey,
      kind: match.kind,
      keyword: match.keyword,
      messageSid: row.twilio_sid,
      atIso: new Date(row.created_at).toISOString(),
    });
  }
  return latest;
}

/** Match keys from the universe that have no ledger row yet. */
async function findMissingLedgerKeys(universe: Map<string, KnownPhone>): Promise<KnownPhone[]> {
  const keys = [...universe.keys()];
  if (keys.length === 0) return [];
  const existing = await getConsentsByMatchKeys(keys);
  const present = new Set(existing.map((r) => r.phoneMatchKey));
  return keys.filter((k) => !present.has(k)).map((k) => universe.get(k)!);
}

export const smsConsentBackfillAction: ProdAction = {
  id: "sms_consent_backfill",
  convergence: { kind: "converging" },
  // Task #4762 drain declaration:
  humanGate: {
    reason:
      "One-shot consent-ledger seed plus historical STOP/START application — a compliance-sensitive rewrite an operator reviews and fires deliberately.",
  },
  title: "Backfill the SMS consent ledger",
  description:
    "Seeds a consent-ledger row (state `unknown`) for every phone number already known to the system (client contacts, client records, SMS conversations, inbound senders) and applies any historical STOP/START keyword messages as backfill_history state (last keyword per phone wins; never overwrites state recorded after the feature shipped). Idempotent — once converged it reports not-needed.",
  change:
    "INSERT missing sms_consent_ledger rows (state `unknown`, ON CONFLICT DO NOTHING) + apply historical keyword-derived states with unknown-only guard; appends matching sms_consent_events rows.",
  async status() {
    try {
      const universe = await collectKnownPhoneUniverse();
      const [missing, historical] = await Promise.all([
        findMissingLedgerKeys(universe),
        scanHistoricalKeywords(),
      ]);
      // Historical findings still pending = phones whose ledger row is
      // absent or still `unknown` (the guard would apply them).
      const historicalKeys = [...historical.keys()];
      const historicalRows =
        historicalKeys.length > 0 ? await getConsentsByMatchKeys(historicalKeys) : [];
      const decided = new Set(
        historicalRows.filter((r) => r.state !== "unknown").map((r) => r.phoneMatchKey),
      );
      const pendingHistorical = historicalKeys.filter((k) => !decided.has(k)).length;
      if (missing.length === 0 && pendingHistorical === 0) {
        return {
          state: "not-needed",
          detail: `Ledger covers all ${universe.size} known phone number(s); no unapplied historical keyword messages.`,
        };
      }
      return {
        state: "pending",
        detail: `${missing.length} known phone(s) missing a ledger row; ${pendingHistorical} historical keyword state(s) to apply (universe: ${universe.size}).`,
      };
    } catch (err: any) {
      return { state: "error", detail: `Status scan failed: ${err?.message ?? err}` };
    }
  },
  async apply() {
    try {
      // Pass 1 — historical keyword states (guarded, last keyword wins).
      const historical = await scanHistoricalKeywords();
      let historyApplied = 0;
      for (const finding of historical.values()) {
        const result = await applyConsentStateChange({
          phoneE164: finding.phoneE164,
          phoneMatchKey: finding.phoneMatchKey,
          newState: finding.kind === "opt_out" ? "opted_out" : "opted_in",
          source: "backfill_history",
          evidence: `Historical inbound "${finding.keyword}" at ${finding.atIso}${finding.messageSid ? ` (MessageSid ${finding.messageSid})` : ""}`,
          onlyIfCurrentStateUnknownOrAbsent: true,
          event: {
            eventType: "backfill",
            messageSid: finding.messageSid,
            keyword: finding.keyword,
            detail: `Backfill from historical inbound message at ${finding.atIso}`,
          },
        });
        if (result.changed) historyApplied += 1;
      }

      // Pass 2 — seed `unknown` rows for every known phone still absent.
      const universe = await collectKnownPhoneUniverse();
      const missing = await findMissingLedgerKeys(universe);
      const seeded = await seedUnknownConsentRows(
        missing,
        "Backfill: number known to the system with no expressed consent",
      );

      if (historyApplied === 0 && seeded === 0) {
        return {
          state: "not-needed",
          detail: `Nothing to apply — ledger already covers all ${universe.size} known phone number(s).`,
        };
      }
      return {
        state: "applied",
        detail: `Applied ${historyApplied} historical keyword state(s); seeded ${seeded} unknown-consent row(s) (universe: ${universe.size}).`,
        rowsAffected: historyApplied + seeded,
      };
    } catch (err: any) {
      return { state: "error", detail: `Backfill failed: ${err?.message ?? err}` };
    }
  },
};

export const smsConsentDomain: ProdActionDomain = {
  name: "smsConsent",
  actions: [smsConsentBackfillAction],
};
