// @db-pool-intent: ambient
//
// Task #2843 — Surface reports whose webinar lead-quality breakdown
// disagrees with Hot Transfers (the "stale breakdown" class behind the
// Kevin / report 3063e933 bug, fixed for future edits by Task #2839).
//
// The report editor and public report derive the webinar lead total with a
// priority rule: breakdown sum wins when > 0, otherwise Hot Transfers × 1.6.
// Editing Hot Transfers does NOT touch the import-seeded breakdown, so a
// stale breakdown silently keeps driving every displayed total. Task #2839
// made the breakdown editable (with an inline mismatch warning), but only an
// operator can decide the correct breakdown values — so this module only
// FINDS the mismatched reports; it never mutates report data. The paired
// prod-action (`review_webinar_breakdown_mismatches`) surfaces the list and
// records an acknowledgment so the action converges without silent writes.
//
// Predicate is deliberately identical to the editor's inline warning
// (ReportForm.tsx Webinars card): breakdown sum > 0 AND sum != hotTransfers.
// Scope matches where the numbers actually matter: clients that own the
// webinar product (active-products gating hides webinar everywhere else)
// and are not archived/demo.

import { and, eq, sql } from "drizzle-orm";
import { clients, reports, reportSections } from "@shared/schema";
import { notifyUser } from "./notifications/userInbox";

/**
 * system_settings key holding the acknowledged mismatch signatures (JSON
 * array of strings). Each signature encodes reportId + the exact mismatched
 * values, so a report whose numbers change again automatically becomes
 * un-acknowledged. Indexed in audits/G-docs-findings.md § 4.
 */
export const WEBINAR_MISMATCH_ACK_SETTING = "webinar_breakdown_mismatch_review_ack";

export interface WebinarBreakdownMismatch {
  reportId: string;
  reportMonth: string;
  clientId: string;
  firmName: string;
  hotTransfers: number;
  breakdownSum: number;
}

/**
 * Stable identity of one mismatch occurrence. Changing either side of the
 * disagreement (a Hot Transfers edit OR a breakdown edit) produces a new
 * signature, so acknowledgments never mask fresh drift on the same report.
 */
export function mismatchSignature(m: WebinarBreakdownMismatch): string {
  return `${m.reportId}:${m.hotTransfers}:${m.breakdownSum}`;
}

export function parseAckSignatures(raw: string | null | undefined): Set<string> {
  if (!raw) return new Set();
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((s): s is string => typeof s === "string"));
  } catch {
    return new Set();
  }
}

export function serializeAckSignatures(mismatches: WebinarBreakdownMismatch[]): string {
  return JSON.stringify(mismatches.map(mismatchSignature).sort());
}

/** Short human line for one mismatch, used in status/apply details. */
export function formatMismatchLine(m: WebinarBreakdownMismatch): string {
  return `${m.firmName} ${m.reportMonth} (/reports/${m.reportId}): breakdown sum ${m.breakdownSum} ≠ Hot Transfers ${m.hotTransfers}`;
}

/**
 * Compute the webinar lead-quality breakdown sum + Hot Transfers from a
 * marketing section's stored data. Mirrors the SQL predicate below (and the
 * ReportForm.tsx inline warning): missing/non-numeric fields count as 0.
 */
export function computeWebinarBreakdown(sectionData: any): {
  breakdownSum: number;
  hotTransfers: number;
} {
  const num = (v: any): number => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  const lq = sectionData?.webinar?.leadQuality ?? {};
  const breakdownSum =
    num(lq.good) + num(lq.notQuotable) + num(lq.missedCalls) + num(lq.noData);
  const hotTransfers = num(sectionData?.webinar?.hotTransfers);
  return { breakdownSum, hotTransfers };
}

/**
 * Task #2851 — proactive close-the-loop notification when a marketing
 * section save LEAVES the webinar breakdown disagreeing with Hot Transfers.
 *
 * The editor shows an inline warning (Task #2839) and the CEO panel surfaces
 * existing mismatches (Task #2843), but neither pings anyone when a NEW
 * mismatch lands. This is the third leg: on save, if the persisted section
 * still mismatches, notify the saving editor and the report owner via the
 * standard `notifyUser()` inbox (+ opt-in Slack DM) path with a deep link to
 * the report.
 *
 * Contract (per NOTIFICATIONS.md):
 *  - only resolves recipients + calls notifyUser(); no direct inserts/SSE/Slack
 *  - best-effort: never throws past this function
 *  - dedupeKey embeds the mismatch signature, so repeat saves of the SAME
 *    mismatch are suppressed while the notification is unread, and a save
 *    that changes either side produces a fresh signature → fresh notification
 *  - a save that fixes the numbers or zeroes the breakdown sends nothing
 *
 * Scope matches the review module: webinar-owning, non-archived, non-demo
 * clients only.
 */
export async function notifyWebinarBreakdownMismatchOnSave(args: {
  report: {
    id: string;
    reportMonth: string;
    clientId: string | null;
    createdBy?: string | null;
  };
  client:
    | {
        firmName?: string | null;
        products?: string[] | null;
        isArchived?: boolean | null;
        isDemo?: boolean | null;
      }
    | undefined
    | null;
  savedData: any;
  actorUserId?: string | null;
}): Promise<void> {
  try {
    const { report, client, savedData, actorUserId } = args;
    if (!client) return;
    if (!Array.isArray(client.products) || !client.products.includes("webinar")) return;
    if (client.isArchived || client.isDemo) return;

    const { breakdownSum, hotTransfers } = computeWebinarBreakdown(savedData);
    // Fixed (equal) or zeroed breakdown → no mismatch, nothing to send.
    if (!(breakdownSum > 0) || breakdownSum === hotTransfers) return;

    const mismatch: WebinarBreakdownMismatch = {
      reportId: report.id,
      reportMonth: report.reportMonth,
      clientId: report.clientId ?? "",
      firmName: client.firmName ?? "Unknown firm",
      hotTransfers,
      breakdownSum,
    };
    const signature = mismatchSignature(mismatch);

    // Recipients: the editor who made the save + the report owner. The
    // actor is deliberately INCLUDED (the warning is for whoever just left
    // the numbers disagreeing), so no excludeActor here.
    const recipients = Array.from(
      new Set(
        [actorUserId, report.createdBy].filter(
          (id): id is string => typeof id === "string" && id.length > 0,
        ),
      ),
    );
    if (recipients.length === 0) return;

    const title = "Webinar breakdown no longer matches Hot Transfers";
    const body =
      `${mismatch.firmName} ${mismatch.reportMonth}: lead-quality breakdown sums to ` +
      `${breakdownSum} but Hot Transfers is ${hotTransfers}. The breakdown sum drives ` +
      `the displayed webinar lead total — review and correct the report.`;

    for (const uid of recipients) {
      try {
        await notifyUser(uid, {
          category: "system",
          title,
          body,
          deepLink: `/reports/${report.id}`,
          dedupeKey: `webinar-breakdown-mismatch:${signature}`,
          metadata: {
            reportId: report.id,
            clientId: report.clientId,
            reportMonth: report.reportMonth,
            hotTransfers,
            breakdownSum,
          },
        });
      } catch (err: any) {
        console.warn(
          `[webinarBreakdownMismatch] notifyUser failed for user=${uid}:`,
          err?.message ?? err,
        );
      }
    }
  } catch (err: any) {
    console.warn(
      "[webinarBreakdownMismatch] mismatch-on-save notification skipped:",
      err?.message ?? err,
    );
  }
}

const LQ_SUM = sql<number>`(
  COALESCE((${reportSections.data} -> 'webinar' -> 'leadQuality' ->> 'good')::numeric, 0)
  + COALESCE((${reportSections.data} -> 'webinar' -> 'leadQuality' ->> 'notQuotable')::numeric, 0)
  + COALESCE((${reportSections.data} -> 'webinar' -> 'leadQuality' ->> 'missedCalls')::numeric, 0)
  + COALESCE((${reportSections.data} -> 'webinar' -> 'leadQuality' ->> 'noData')::numeric, 0)
)`;

const HOT_TRANSFERS = sql<number>`COALESCE((${reportSections.data} -> 'webinar' ->> 'hotTransfers')::numeric, 0)`;

/**
 * All reports whose stored webinar breakdown sum disagrees with Hot
 * Transfers, for active (non-archived, non-demo) clients that own the
 * webinar product. Read-only.
 */
export async function findWebinarBreakdownMismatches(
  db: any,
): Promise<WebinarBreakdownMismatch[]> {
  const rows = await db
    .select({
      reportId: reports.id,
      reportMonth: reports.reportMonth,
      clientId: reports.clientId,
      firmName: clients.firmName,
      hotTransfers: HOT_TRANSFERS,
      breakdownSum: LQ_SUM,
    })
    .from(reportSections)
    .innerJoin(reports, eq(reportSections.reportId, reports.id))
    .innerJoin(clients, eq(reports.clientId, clients.id))
    .where(
      and(
        eq(reportSections.sectionKey, "marketing"),
        sql`'webinar' = ANY(${clients.products})`,
        sql`COALESCE(${clients.isArchived}, false) = false`,
        sql`COALESCE(${clients.isDemo}, false) = false`,
        sql`${LQ_SUM} > 0`,
        sql`${LQ_SUM} <> ${HOT_TRANSFERS}`,
      ),
    )
    .orderBy(reports.reportMonth, clients.firmName);
  return rows.map((r: any) => ({
    reportId: r.reportId,
    reportMonth: r.reportMonth,
    clientId: r.clientId,
    firmName: r.firmName,
    hotTransfers: Number(r.hotTransfers),
    breakdownSum: Number(r.breakdownSum),
  }));
}
