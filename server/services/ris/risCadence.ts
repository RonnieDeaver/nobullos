// @db-pool-intent: ambient
//
// Task #2388 — RIS Engagement Layer, check #7 (NoBull Communication
// Cadence) auto-counts.
//
// Given a client + calendar-month period, return the real outbound
// communication volume already ingested into the app — emails, calls and
// texts sent that month, the total, the last outbound touch, and the last
// meaningful two-way (inbound) interaction. These numbers are computed
// LIVE (never stored) and only ever inform the displayed observed value;
// the human still sets the check's Green/Yellow/Red status (see #2384 /
// #2385: auto values never overwrite a human decision).
//
// Source is the same data the rest of the app uses — no live Front/Twilio
// calls. A record belongs to the client when it is directly stamped with
// `client_id` OR linked through `communication_client_links` (non-rejected),
// mirroring server/storage/communicationStorage.ts. Channel is derived
// from `source_type`: front_email → emails, twilio_call → calls,
// twilio_sms → texts.

import { sql } from "drizzle-orm";
import { getDb, withDbAttribution } from "../../db";

export interface CommunicationCadence {
  /** `YYYY-MM` the counts cover. */
  period: string;
  emailsSent: number;
  callsMade: number;
  textsSent: number;
  /** Sum of the three channels' outbound volume for the month. */
  totalOutboundTouches: number;
  /** Most recent OUTBOUND touch for the client (overall, ISO string). */
  lastOutboundAt: string | null;
  /** Most recent INBOUND (two-way) interaction (overall, ISO string). */
  lastInboundAt: string | null;
}

/**
 * Parse a `YYYY-MM` period into the half-open `[start, end)` month range.
 * Returns null for a malformed period so callers can skip the query.
 */
export function monthRange(
  period: string,
): { start: Date; end: Date } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1));
  return { start, end };
}

const EMPTY = (period: string): CommunicationCadence => ({
  period,
  emailsSent: 0,
  callsMade: 0,
  textsSent: 0,
  totalOutboundTouches: 0,
  lastOutboundAt: null,
  lastInboundAt: null,
});

function toIso(v: unknown): string | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v as string);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Live outbound cadence + last-touch dates for a client + month.
 *
 * Two cheap index-friendly reads (client+timestamp index): a grouped
 * month-scoped outbound count by channel, and the client's overall most
 * recent outbound / inbound timestamps. Pure DB reads — no external I/O,
 * well under the 10s hold rule.
 */
export async function getCommunicationCadence(
  clientId: string,
  period: string,
): Promise<CommunicationCadence> {
  const range = monthRange(period);
  if (!range) return EMPTY(period);

  return withDbAttribution("ris:commCadence", async () => {
    const db = getDb();

    // A record is the client's when directly stamped OR linked
    // (non-rejected). Express once and reuse in both reads.
    const belongsToClient = sql`(
      r.client_id = ${clientId}
      OR EXISTS (
        SELECT 1 FROM communication_client_links l
        WHERE l.raw_communication_record_id = r.id
          AND l.client_id = ${clientId}
          AND l.status <> 'rejected'
      )
    )`;

    // Month-scoped outbound volume grouped by channel.
    const countsRes = await db.execute(sql`
      SELECT r.source_type AS source_type, COUNT(*)::int AS n
      FROM raw_communication_records r
      WHERE ${belongsToClient}
        AND r.direction = 'outbound'
        AND r.timestamp >= ${range.start.toISOString()}
        AND r.timestamp <  ${range.end.toISOString()}
        AND r.source_type IN ('front_email', 'twilio_sms', 'twilio_call')
      GROUP BY r.source_type
    `);
    const countRows = ((countsRes as any).rows ??
      (countsRes as unknown as any[])) as Array<{
      source_type: string;
      n: number;
    }>;

    let emailsSent = 0;
    let callsMade = 0;
    let textsSent = 0;
    for (const row of countRows) {
      const n = Number(row.n) || 0;
      if (row.source_type === "front_email") emailsSent += n;
      else if (row.source_type === "twilio_call") callsMade += n;
      else if (row.source_type === "twilio_sms") textsSent += n;
    }

    // Overall most-recent outbound + inbound timestamps (context lines).
    const lastRes = await db.execute(sql`
      SELECT
        MAX(r.timestamp) FILTER (WHERE r.direction = 'outbound') AS last_outbound,
        MAX(r.timestamp) FILTER (WHERE r.direction = 'inbound')  AS last_inbound
      FROM raw_communication_records r
      WHERE ${belongsToClient}
        AND r.direction IN ('outbound', 'inbound')
    `);
    const lastRow = ((lastRes as any).rows ??
      (lastRes as unknown as any[]))[0] as
      | { last_outbound: unknown; last_inbound: unknown }
      | undefined;

    return {
      period,
      emailsSent,
      callsMade,
      textsSent,
      totalOutboundTouches: emailsSent + callsMade + textsSent,
      lastOutboundAt: toIso(lastRow?.last_outbound),
      lastInboundAt: toIso(lastRow?.last_inbound),
    };
  });
}
