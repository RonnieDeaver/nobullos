/**
 * Task #3693 — Client risk-shift alerts.
 *
 * The daily judgment cron (6am ET, `runDailyJudgmentCron`) computes each
 * client's health status (Healthy/Watch/At Risk/Critical) and 0–100 risk
 * score every morning, but until this module nothing compared today's
 * result to yesterday's or told anyone when a client slipped. This module
 * turns those per-client judgments into proactive notifications:
 *
 *   - DEGRADATION = the status moved to a worse severity rank (e.g.
 *     Healthy→Watch, Watch→At Risk, anything→Critical) OR the risk score
 *     jumped by MORE than the configurable threshold. Either signal alone
 *     alerts (a score jump with an unchanged status still alerts, and a
 *     status degradation with a falling score still alerts — status is the
 *     primary judgment).
 *   - RECOVERY = the status moved to a better rank, or the score fell by
 *     more than the same threshold (for score-only streaks). Recovery
 *     re-arms the alert via the dispatcher's `markRecovered`.
 *
 * Once-per-streak semantics come from the transition detection itself:
 * comparisons are always against the client's PREVIOUS persisted judgment,
 * so a client that stays At Risk all week produces exactly one alert on the
 * day it slipped (no daily repeats), and a FURTHER slip (Watch→At Risk after
 * a Healthy→Watch alert) is a new transition that alerts again. This is
 * durable across restarts/instances because the judgment history lives in
 * the DB — unlike the per-process streak flags the disconnect alerts use.
 * The dispatcher health state (dedupeKey per client) is maintained as the
 * secondary guard + recovery bookkeeping, mirroring
 * `server/services/semrushDisconnectAlert.ts`.
 *
 * Recipients: in-app rows go to director-level+ users (assigned authority,
 * legacy-role bridge included) PLUS the client's account owner. The
 * dispatcher's generic admin mirror is skipped (`skipAdminInAppMirror`)
 * because this module owns its targeted fan-out. Slack mirroring rides the
 * normal Notifications Console channel config for
 * `workflow.client_risk.shift_detected` — no channel configured = in-app
 * only ("where configured").
 *
 * Mass-degradation bundling: if one judgment run degrades
 * >= CLIENT_RISK_SHIFT_BUNDLE_THRESHOLD clients (e.g. a model behavior
 * shift), recipients get ONE bundled alert listing the clients instead of a
 * flood of individual ones.
 *
 * Kill switch: `kill_switch_client_risk_shift_alert` (default ON; "false"
 * disables all notifications). Recovery marking still runs under the kill
 * switch so re-arm state stays correct while alerts are muted.
 *
 * Score-jump threshold: `client_risk_shift_score_jump_threshold` (points on
 * the 0–100 `overallRisk` scale the judgment AI is contracted to return;
 * default 20 = a fifth of the scale, big enough that day-to-day model
 * wobble on a stable client stays quiet).
 */
import type { Client, ClientDailyJudgment } from "@shared/schema";
import { notifyByType, markRecovered } from "./notifications/dispatcher";
import { notifyUser } from "./notifications/userInbox";
import {
  getClientAccountManagers,
  getDirectorPlusUsers,
} from "./notifications/recipients";
import { getSystemSetting } from "../storage/settingsStorage";
import { storage } from "../storage";

const NOTIFICATION_ID = "workflow.client_risk.shift_detected";

/** In-app dedupe keys all share this prefix so tests (ours and existing
 *  notification-count tests) can scope assertions to it. */
export const CLIENT_RISK_SHIFT_DEDUPE_PREFIX = "client-risk-shift:";

/** Kill switch key — default ON (alerts enabled); "false" disables. */
export const KILL_SWITCH_CLIENT_RISK_SHIFT_ALERT =
  "kill_switch_client_risk_shift_alert";

/** Tunable score-jump threshold (points). Values <= 0 or non-numeric fall
 *  back to the default. */
export const CLIENT_RISK_SHIFT_SCORE_JUMP_THRESHOLD_SETTING =
  "client_risk_shift_score_jump_threshold";

/** Default jump threshold on the 0–100 overallRisk scale. */
export const DEFAULT_RISK_SCORE_JUMP_THRESHOLD = 20;

/** A single run degrading this many clients (or more) sends ONE bundled
 *  alert instead of individual ones. */
export const CLIENT_RISK_SHIFT_BUNDLE_THRESHOLD = 4;

/**
 * Explicit severity ordering (worse = higher). Matches the order of
 * `judgmentStatusOptions` in shared/models/dailyJudgment.ts; kept as a
 * literal map so the ordering is auditable here and a schema reorder can
 * never silently flip what counts as a degradation.
 */
export const JUDGMENT_STATUS_SEVERITY: Record<string, number> = {
  Healthy: 0,
  Watch: 1,
  "At Risk": 2,
  Critical: 3,
};

export interface JudgmentSnapshot {
  status: string | null;
  riskScore: number | null;
}

export type RiskShiftKind = "degraded" | "recovered" | "none";

export interface RiskShiftClassification {
  kind: RiskShiftKind;
  statusDegraded: boolean;
  statusImproved: boolean;
  scoreJumped: boolean;
  scoreDropped: boolean;
  fromStatus: string | null;
  toStatus: string | null;
  fromScore: number | null;
  toScore: number | null;
}

function severityRank(status: string | null | undefined): number | null {
  if (typeof status !== "string") return null;
  const rank = JUDGMENT_STATUS_SEVERITY[status];
  return typeof rank === "number" ? rank : null;
}

/**
 * Pure transition classifier. `prev === null` (first-ever judgment) is
 * always `none` — there is no baseline to compare against. Unknown status
 * strings contribute nothing on the status axis (the score axis still
 * applies). A contradictory read (status improved but score jumped past the
 * threshold, or vice versa) classifies as DEGRADED: the spec alerts on
 * either signal, and under-alerting is the worse failure for churn risk.
 */
export function classifyRiskShift(
  prev: JudgmentSnapshot | null | undefined,
  curr: JudgmentSnapshot,
  jumpThreshold: number,
): RiskShiftClassification {
  const base: RiskShiftClassification = {
    kind: "none",
    statusDegraded: false,
    statusImproved: false,
    scoreJumped: false,
    scoreDropped: false,
    fromStatus: prev?.status ?? null,
    toStatus: curr.status ?? null,
    fromScore: prev?.riskScore ?? null,
    toScore: curr.riskScore ?? null,
  };
  if (!prev) return base;

  const prevRank = severityRank(prev.status);
  const currRank = severityRank(curr.status);
  if (prevRank !== null && currRank !== null) {
    base.statusDegraded = currRank > prevRank;
    base.statusImproved = currRank < prevRank;
  }

  if (
    typeof prev.riskScore === "number" &&
    typeof curr.riskScore === "number" &&
    Number.isFinite(prev.riskScore) &&
    Number.isFinite(curr.riskScore)
  ) {
    base.scoreJumped = curr.riskScore - prev.riskScore > jumpThreshold;
    base.scoreDropped = prev.riskScore - curr.riskScore > jumpThreshold;
  }

  if (base.statusDegraded || base.scoreJumped) {
    base.kind = "degraded";
  } else if (base.statusImproved || base.scoreDropped) {
    base.kind = "recovered";
  }
  return base;
}

export interface RiskShiftEntry {
  clientId: string;
  clientName: string;
  judgmentDate: string;
  prev: JudgmentSnapshot | null;
  curr: JudgmentSnapshot;
  headline: string | null;
  concerns: string[];
}

export interface ClientRiskShiftRun {
  entries: RiskShiftEntry[];
}

export interface RiskShiftDispatchSummary {
  evaluated: number;
  degraded: number;
  recovered: number;
  alertsSent: number;
  bundled: boolean;
  inAppRecipients: number;
  skipped?: "kill_switch" | "no_entries";
}

// ── Injectable collaborators (ESM live bindings are read-only; tests swap
//    these instead of monkey-patching imports). Production never touches
//    the setters. ─────────────────────────────────────────────────────────
let _notifyByType: typeof notifyByType = notifyByType;
let _markRecovered: typeof markRecovered = markRecovered;
let _notifyUser: typeof notifyUser = notifyUser;
let _getDirectorPlusUsers: typeof getDirectorPlusUsers = getDirectorPlusUsers;
let _getClientOwners: (clientId: string) => Promise<string[]> = (clientId) =>
  getClientAccountManagers(clientId);
let _getSystemSetting: (
  key: string,
) => Promise<{ value: string | null } | undefined> = (key) =>
  getSystemSetting(key);
let _loadPreviousJudgment: (
  clientId: string,
  beforeDate: string,
) => Promise<JudgmentSnapshot | null> = async (clientId, beforeDate) => {
  // Latest persisted judgment strictly BEFORE today's. judgment_date is
  // YYYY-MM-DD (lexical order == chronological) and the storage helper
  // returns newest-first, so the first older row is the previous judgment
  // regardless of skip gaps (no-comms days, downtime).
  const recent = await storage.getClientDailyJudgments(clientId, 10);
  const prev = recent.find((j) => j.judgmentDate < beforeDate);
  if (!prev) return null;
  return {
    status: prev.overallStatus ?? prev.status ?? null,
    riskScore: typeof prev.riskScore === "number" ? prev.riskScore : null,
  };
};

export function beginClientRiskShiftRun(): ClientRiskShiftRun {
  return { entries: [] };
}

function firstSentence(text: string | null | undefined, max = 200): string | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  const period = trimmed.indexOf(". ");
  const cut = period > 20 && period < max ? period + 1 : Math.min(trimmed.length, max);
  const out = trimmed.slice(0, cut).trim();
  return out.length < trimmed.length && !out.endsWith(".") ? `${out}…` : out;
}

function topConcerns(judgment: ClientDailyJudgment, limit = 3): string[] {
  const raw = judgment.concernsJson;
  if (!Array.isArray(raw)) return [];
  return (raw as unknown[])
    .filter((c): c is string => typeof c === "string" && c.trim().length > 0)
    .slice(0, limit);
}

/**
 * Record one client's freshly persisted judgment into the run. Loads the
 * previous judgment for the comparison baseline. Never throws — alerting
 * must never break the judgment cron.
 */
export async function recordJudgmentForRiskShift(
  run: ClientRiskShiftRun,
  client: Pick<Client, "id" | "firmName">,
  judgment: ClientDailyJudgment,
): Promise<void> {
  try {
    const prev = await _loadPreviousJudgment(client.id, judgment.judgmentDate);
    run.entries.push({
      clientId: client.id,
      clientName: client.firmName,
      judgmentDate: judgment.judgmentDate,
      prev,
      curr: {
        status: judgment.overallStatus ?? judgment.status ?? null,
        riskScore:
          typeof judgment.riskScore === "number" ? judgment.riskScore : null,
      },
      headline: judgment.headline ?? firstSentence(judgment.summaryText),
      concerns: topConcerns(judgment),
    });
  } catch (err: any) {
    console.warn(
      `[ClientRiskShiftAlert] failed to record judgment for ${client.id} (non-fatal): ${err?.message ?? err}`,
    );
  }
}

function clientDedupeKey(clientId: string): string {
  return `client:${clientId}`;
}

function scorePart(c: RiskShiftClassification): string {
  if (typeof c.fromScore === "number" && typeof c.toScore === "number") {
    return ` (risk ${c.fromScore}→${c.toScore})`;
  }
  if (typeof c.toScore === "number") return ` (risk ${c.toScore})`;
  return "";
}

function transitionLabel(c: RiskShiftClassification): string {
  const from = c.fromStatus ?? "?";
  const to = c.toStatus ?? "?";
  if (c.statusDegraded || from !== to) return `${from} → ${to}`;
  // Score-jump with unchanged status: name the status once.
  return `${to} (status unchanged)`;
}

async function resolveJumpThreshold(): Promise<number> {
  try {
    const setting = await _getSystemSetting(
      CLIENT_RISK_SHIFT_SCORE_JUMP_THRESHOLD_SETTING,
    );
    const parsed = Number.parseFloat(setting?.value ?? "");
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  } catch {
    // fall through to default
  }
  return DEFAULT_RISK_SCORE_JUMP_THRESHOLD;
}

/**
 * Classify every recorded entry and fan out alerts. Called once at the end
 * of the daily judgment cron. Never throws.
 */
export async function dispatchClientRiskShiftAlerts(
  run: ClientRiskShiftRun,
): Promise<RiskShiftDispatchSummary> {
  const summary: RiskShiftDispatchSummary = {
    evaluated: run.entries.length,
    degraded: 0,
    recovered: 0,
    alertsSent: 0,
    bundled: false,
    inAppRecipients: 0,
  };
  try {
    if (run.entries.length === 0) {
      summary.skipped = "no_entries";
      return summary;
    }

    const jumpThreshold = await resolveJumpThreshold();
    const classified = run.entries.map((entry) => ({
      entry,
      c: classifyRiskShift(entry.prev, entry.curr, jumpThreshold),
    }));
    const degraded = classified.filter(({ c }) => c.kind === "degraded");
    const recovered = classified.filter(({ c }) => c.kind === "recovered");
    summary.degraded = degraded.length;
    summary.recovered = recovered.length;

    // Recovery re-arm runs even under the kill switch: it only clears
    // dispatcher health state (no notification), and keeps the next
    // degradation alert armed correctly while alerts are muted.
    for (const { entry } of recovered) {
      try {
        await _markRecovered(NOTIFICATION_ID, clientDedupeKey(entry.clientId));
      } catch {
        // markRecovered is already best-effort
      }
    }

    if (degraded.length === 0) return summary;

    const killSwitch = await _getSystemSetting(
      KILL_SWITCH_CLIENT_RISK_SHIFT_ALERT,
    ).catch(() => undefined);
    if (killSwitch?.value === "false") {
      console.log(
        `[ClientRiskShiftAlert] kill switch OFF — suppressing ${degraded.length} degradation alert(s)`,
      );
      summary.skipped = "kill_switch";
      return summary;
    }

    const directors = await _getDirectorPlusUsers();

    if (degraded.length >= CLIENT_RISK_SHIFT_BUNDLE_THRESHOLD) {
      // ── Bundled mass-degradation alert ────────────────────────────────
      summary.bundled = true;
      const judgmentDate = degraded[0].entry.judgmentDate;
      const lines = degraded.map(
        ({ entry, c }) =>
          `• ${entry.clientName}: ${transitionLabel(c)}${scorePart(c)}`,
      );
      const shown = lines.slice(0, 20);
      if (lines.length > shown.length) {
        shown.push(`…and ${lines.length - shown.length} more`);
      }
      const text =
        `Client risk shift: ${degraded.length} clients degraded in this morning's judgment run (${judgmentDate}).\n` +
        `${shown.join("\n")}\n` +
        `A mass shift can mean a real portfolio problem OR a judgment-model behavior change — review the client list before reacting per-client.\n` +
        `Clients: /clients`;

      const ownerLists = await Promise.all(
        degraded.map(({ entry }) => _getClientOwners(entry.clientId)),
      );
      const recipients = new Set<string>([...directors, ...ownerLists.flat()]);
      for (const uid of recipients) {
        try {
          await _notifyUser(uid, {
            category: "system",
            title: `Client health degraded: ${degraded.length} clients this morning`,
            body: shown.join("\n"),
            deepLink: "/clients",
            dedupeKey: `${CLIENT_RISK_SHIFT_DEDUPE_PREFIX}bulk:${judgmentDate}:${uid}`,
            metadata: {
              judgmentDate,
              clientIds: degraded.map(({ entry }) => entry.clientId),
            },
          });
          summary.inAppRecipients++;
        } catch (err: any) {
          console.warn(
            `[ClientRiskShiftAlert] bundled notifyUser failed for ${uid} (non-fatal): ${err?.message ?? err}`,
          );
        }
      }

      await _notifyByType(
        NOTIFICATION_ID,
        { text },
        {
          triggerSource: "scheduled",
          dedupeKey: `bulk:${judgmentDate}`,
          failureType: "mass_degradation",
          skipAdminInAppMirror: true,
        },
      );
      summary.alertsSent = 1;
      console.warn(
        `[ClientRiskShiftAlert] bundled alert fired for ${degraded.length} degraded clients (${judgmentDate})`,
      );
      return summary;
    }

    // ── Individual alerts ─────────────────────────────────────────────────
    for (const { entry, c } of degraded) {
      const reason = c.statusDegraded
        ? `status degraded ${transitionLabel(c)}`
        : `risk score jumped ${c.fromScore}→${c.toScore} (> ${jumpThreshold} pts)`;
      const bodyParts = [`${transitionLabel(c)}${scorePart(c)}.`];
      if (entry.headline) bodyParts.push(entry.headline);
      if (entry.concerns.length > 0) {
        bodyParts.push(`Top concerns: ${entry.concerns.join("; ")}`);
      }
      const body = bodyParts.join("\n");

      const owners = await _getClientOwners(entry.clientId);
      const recipients = new Set<string>([...directors, ...owners]);
      for (const uid of recipients) {
        try {
          await _notifyUser(uid, {
            category: "system",
            title: `Client health degraded: ${entry.clientName}`,
            body,
            deepLink: `/clients/${entry.clientId}`,
            dedupeKey: `${CLIENT_RISK_SHIFT_DEDUPE_PREFIX}${entry.clientId}:${entry.judgmentDate}:${uid}`,
            metadata: {
              clientId: entry.clientId,
              judgmentDate: entry.judgmentDate,
              fromStatus: c.fromStatus,
              toStatus: c.toStatus,
              fromScore: c.fromScore,
              toScore: c.toScore,
              reason,
            },
          });
          summary.inAppRecipients++;
        } catch (err: any) {
          console.warn(
            `[ClientRiskShiftAlert] notifyUser failed for ${uid}/${entry.clientId} (non-fatal): ${err?.message ?? err}`,
          );
        }
      }

      const text =
        `Client risk shift: ${entry.clientName} — ${reason}.\n` +
        (entry.headline ? `Headline: ${entry.headline}\n` : "") +
        (entry.concerns.length > 0
          ? `Top concerns: ${entry.concerns.join("; ")}\n`
          : "") +
        `Client: /clients/${entry.clientId}`;
      try {
        await _notifyByType(
          NOTIFICATION_ID,
          { text },
          {
            triggerSource: "scheduled",
            dedupeKey: clientDedupeKey(entry.clientId),
            // A FURTHER slip (e.g. Watch→At Risk after Healthy→Watch) changes
            // the failureType, so the dispatcher's same-failure suppression
            // window never mutes an escalation.
            failureType: c.statusDegraded ? `status:${c.toStatus}` : "score_jump",
            skipAdminInAppMirror: true,
          },
        );
        summary.alertsSent++;
        console.warn(
          `[ClientRiskShiftAlert] alert fired for ${entry.clientName} (${entry.clientId}): ${reason}`,
        );
      } catch (err: any) {
        // One client's dispatch failure must not mute the rest of the run.
        console.warn(
          `[ClientRiskShiftAlert] notifyByType failed for ${entry.clientId} (non-fatal): ${err?.message ?? err}`,
        );
      }
    }
    return summary;
  } catch (err: any) {
    console.warn(
      `[ClientRiskShiftAlert] dispatch failed (non-fatal): ${err?.message ?? err}`,
    );
    return summary;
  }
}

// ─── Test seams (production never calls these) ───────────────────────────────

export function __getClientRiskShiftKeysForTest(): { notificationId: string } {
  return { notificationId: NOTIFICATION_ID };
}

export function __setClientRiskShiftDepsForTest(deps: {
  notifyByType?: typeof notifyByType;
  markRecovered?: typeof markRecovered;
  notifyUser?: typeof notifyUser;
  getDirectorPlusUsers?: typeof getDirectorPlusUsers;
  getClientOwners?: (clientId: string) => Promise<string[]>;
  getSystemSetting?: (key: string) => Promise<{ value: string | null } | undefined>;
  loadPreviousJudgment?: (
    clientId: string,
    beforeDate: string,
  ) => Promise<JudgmentSnapshot | null>;
}): void {
  if (deps.notifyByType) _notifyByType = deps.notifyByType;
  if (deps.markRecovered) _markRecovered = deps.markRecovered;
  if (deps.notifyUser) _notifyUser = deps.notifyUser;
  if (deps.getDirectorPlusUsers) _getDirectorPlusUsers = deps.getDirectorPlusUsers;
  if (deps.getClientOwners) _getClientOwners = deps.getClientOwners;
  if (deps.getSystemSetting) _getSystemSetting = deps.getSystemSetting;
  if (deps.loadPreviousJudgment) _loadPreviousJudgment = deps.loadPreviousJudgment;
}

export function __resetClientRiskShiftDepsForTest(): void {
  _notifyByType = notifyByType;
  _markRecovered = markRecovered;
  _notifyUser = notifyUser;
  _getDirectorPlusUsers = getDirectorPlusUsers;
  _getClientOwners = (clientId) => getClientAccountManagers(clientId);
  _getSystemSetting = (key) => getSystemSetting(key);
  _loadPreviousJudgment = async (clientId, beforeDate) => {
    const recent = await storage.getClientDailyJudgments(clientId, 10);
    const prev = recent.find((j) => j.judgmentDate < beforeDate);
    if (!prev) return null;
    return {
      status: prev.overallStatus ?? prev.status ?? null,
      riskScore: typeof prev.riskScore === "number" ? prev.riskScore : null,
    };
  };
}
