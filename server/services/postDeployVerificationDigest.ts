/**
 * Task #973 — Email or Slack a deploy-verification report after every deploy.
 *
 * Task #928 surfaced the §8 runbook checklist as `runPostDeployVerification()`
 * and a one-click /admin/health panel. This service closes the last manual
 * step: shortly after server boot it runs the same checklist and posts a
 * compact pass/warn/fail summary (plus the comparison-to-baseline diff) to
 * Slack via the unified `notifyByType` dispatcher.
 *
 * Routing:
 *   - overall=`fail`  → `infra.deployment.post_deploy_verification_failed`
 *                        (on-call/paging channel)
 *   - overall=`warn`  → `infra.deployment.post_deploy_verification`
 *                        (also surfaced in the daily health digest so the
 *                         warn appears in two places — boot post + digest)
 *   - overall=`pass`  → `infra.deployment.post_deploy_verification`
 *                        (one-line green confirmation)
 *
 * One attempt per server boot — guarded by a per-process flag so retried
 * imports / scheduler restarts can't double-fire. Skipping when disabled
 * via `system_settings.post_deploy_verification_digest_enabled`.
 */

import { withDbAttribution } from "../db";
import { getSystemSetting } from "../storage/settingsStorage";
import {
  runPostDeployVerification,
  AUTO_BASELINE_BOOT_DELAY_MS,
  type VerificationReport,
  type CheckStatus,
  type ComparisonRow,
} from "./postDeployVerification";
import {
  sendEmail,
  isMailerConfigured,
  type SendEmailOptions,
  type SendEmailResult,
} from "./mailer";

const NOTIFICATION_ID_PASS_OR_WARN = "infra.deployment.post_deploy_verification";
const NOTIFICATION_ID_FAIL = "infra.deployment.post_deploy_verification_failed";

export const SETTING_ENABLED = "post_deploy_verification_digest_enabled";
/** Comma-separated list of email recipients for the per-deploy report. */
export const SETTING_EMAIL_RECIPIENTS =
  "post_deploy_verification_digest_email_recipients";

/** Default: fire ~2 minutes AFTER the auto-baseline attempt so the digest
 *  reflects the just-saved baseline (when the run passed). */
export const POST_DEPLOY_DIGEST_BOOT_DELAY_MS =
  AUTO_BASELINE_BOOT_DELAY_MS + 2 * 60_000;

let alreadySentThisBoot = false;

type NotifyByTypeFn = (
  id: string,
  payload: { text: string; preview?: string },
  options: {
    triggerSource: string;
    bypassDedupe?: boolean;
    metadata?: Record<string, unknown>;
  },
) => Promise<{ delivered: boolean; status?: string; skipReason?: string }>;

type SendEmailFn = (opts: SendEmailOptions) => Promise<SendEmailResult>;

let dispatcherOverride: NotifyByTypeFn | null = null;
let reportFnOverride: (() => Promise<VerificationReport>) | null = null;
let mailerOverride: SendEmailFn | null = null;

function parseEmailRecipients(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.includes("@"));
}

function parseBool(raw: string | undefined | null, fallback: boolean): boolean {
  if (raw == null) return fallback;
  const v = String(raw).trim().toLowerCase();
  if (v === "true" || v === "1" || v === "on" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "off" || v === "no") return false;
  return fallback;
}

function buildPanelLink(): string {
  const base =
    process.env.APP_BASE_URL ||
    process.env.PUBLIC_BASE_URL ||
    process.env.REPLIT_DEPLOYMENT_URL ||
    "";
  const path = "/admin/health#post-deploy-verification";
  if (!base) return path;
  return `${base.replace(/\/$/, "")}${path}`;
}

function fmtNum(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  // Avoid trailing ".00" for whole numbers; keep 2 decimals otherwise.
  return Number.isInteger(n) ? String(n) : Number(n).toFixed(2);
}

function fmtComparisonRow(row: ComparisonRow): string {
  const cur = fmtNum(row.current);
  const base = fmtNum(row.baseline);
  if (row.delta == null) {
    return `• ${row.label}: ${cur} (baseline ${base})`;
  }
  const arrow =
    row.drift === "better" ? "↓ better" : row.drift === "worse" ? "↑ worse" : "·";
  const delta = row.delta > 0 ? `+${fmtNum(row.delta)}` : fmtNum(row.delta);
  return `• ${row.label}: ${cur} (baseline ${base}, Δ ${delta} ${arrow})`;
}

/**
 * Build the Slack message body for a verification report. Exported for
 * tests (and the manual "send now" route).
 */
export function composeDigestMessage(report: VerificationReport): {
  text: string;
  preview: string;
} {
  const overall = report.overall.toUpperCase();
  const tag =
    report.overall === "fail"
      ? ":rotating_light:"
      : report.overall === "warn"
        ? ":warning:"
        : ":white_check_mark:";

  const lines: string[] = [];
  lines.push(`${tag} *Post-deploy verification: ${overall}*`);

  // Per-group status
  const groupSummary = report.groups
    .map((g) => `${g.id} ${g.status.toUpperCase()}`)
    .join(" · ");
  lines.push(`Groups: ${groupSummary}`);

  // Failing/warn checks (cap to keep the post compact)
  const noisy = report.groups
    .flatMap((g) =>
      g.checks
        .filter((c) => c.status !== "pass")
        .map((c) => ({ group: g.id, ...c })),
    )
    .slice(0, 8);
  if (noisy.length > 0) {
    lines.push("");
    lines.push(`*Checks needing attention (${noisy.length}):*`);
    for (const c of noisy) {
      const sev = c.status === "fail" ? "FAIL" : "WARN";
      lines.push(`• [${sev}] ${c.group} — ${c.label}: ${c.detail}`);
    }
  }

  // Comparison-to-baseline (only show drifted rows so the post stays small)
  if (report.baseline && report.comparison.length > 0) {
    const drifted = report.comparison.filter(
      (r) => r.drift === "better" || r.drift === "worse",
    );
    if (drifted.length > 0) {
      lines.push("");
      lines.push(
        `*Vs baseline saved ${new Date(report.baseline.savedAt).toISOString()}:*`,
      );
      for (const r of drifted.slice(0, 6)) {
        lines.push(fmtComparisonRow(r));
      }
    }
  } else if (!report.baseline) {
    lines.push("");
    lines.push("_No baseline saved yet — open the panel to save the first one._");
  }

  lines.push("");
  lines.push(`Full detail: ${buildPanelLink()}`);

  const text = lines.join("\n");
  const preview = `post-deploy verification ${overall} (${report.groups
    .map((g) => `${g.id}=${g.status}`)
    .join(",")})`;
  return { text, preview };
}

async function dispatch(
  id: string,
  payload: { text: string; preview: string },
  metadata: Record<string, unknown>,
): Promise<{ delivered: boolean; status?: string; skipReason?: string }> {
  if (dispatcherOverride) {
    return dispatcherOverride(
      id,
      payload,
      { triggerSource: "scheduled", bypassDedupe: true, metadata },
    );
  }
  const { notifyByType } = await import("./notifications/dispatcher");
  const r = await notifyByType(
    id,
    { text: payload.text, preview: payload.preview },
    {
      triggerSource: "scheduled",
      bypassDedupe: true,
      metadata,
    },
  );
  return { delivered: r.delivered, status: r.status, skipReason: r.skipReason };
}

async function loadReport(): Promise<VerificationReport> {
  if (reportFnOverride) return reportFnOverride();
  return runPostDeployVerification();
}

export interface SendDigestResult {
  attempted: boolean;
  /** True iff at least one delivery channel (Slack OR email) succeeded. */
  sent: boolean;
  reason: string;
  overall?: CheckStatus;
  notificationId?: string;
  slack?: { delivered: boolean; reason?: string };
  email?: { delivered: boolean; recipients: number; reason?: string };
}

function buildEmailBody(
  text: string,
  overall: CheckStatus,
  generatedAt: number,
): { subject: string; body: string } {
  const overallTag = overall.toUpperCase();
  const subject = `[NoBull OS] Post-deploy verification: ${overallTag}`;
  // Email gets the same plain-text body as the Slack post (Slack will
  // render the *bold* / :emoji: markers; email recipients see the
  // characters but the content is fully readable as plain text).
  const body = `${text}\n\nGenerated at ${new Date(generatedAt).toISOString()}\n`;
  return { subject, body };
}

async function dispatchEmail(
  message: { text: string; preview: string },
  overall: CheckStatus,
  generatedAt: number,
): Promise<{ delivered: boolean; recipients: number; reason?: string }> {
  const recipients = parseEmailRecipients(
    (await getSystemSetting(SETTING_EMAIL_RECIPIENTS).catch(() => null))?.value,
  );
  if (recipients.length === 0) {
    return { delivered: false, recipients: 0, reason: "no_recipients" };
  }
  const sendFn = mailerOverride ?? sendEmail;
  if (!mailerOverride && !isMailerConfigured()) {
    return {
      delivered: false,
      recipients: recipients.length,
      reason: "mailer_not_configured",
    };
  }
  const { subject, body } = buildEmailBody(message.text, overall, generatedAt);
  try {
    const r = await sendFn({
      to: recipients,
      subject,
      text: body,
      logPrefix: "[PostDeployDigest]",
    });
    return {
      delivered: r.ok,
      recipients: recipients.length,
      reason: r.ok ? undefined : r.reason,
    };
  } catch (err: any) {
    return {
      delivered: false,
      recipients: recipients.length,
      reason: `exception:${String(err?.message ?? err).slice(0, 120)}`,
    };
  }
}

/**
 * Run the verification checklist and post the result. Safe to call
 * multiple times — the per-boot guard suppresses re-sends unless `force`
 * is set (used by the manual "send now" route).
 */
export async function maybeSendPostDeployDigest(opts?: {
  force?: boolean;
}): Promise<SendDigestResult> {
  const force = !!opts?.force;
  if (alreadySentThisBoot && !force) {
    return { attempted: false, sent: false, reason: "already sent this boot" };
  }
  const enabled = parseBool(
    (await getSystemSetting(SETTING_ENABLED).catch(() => null))?.value,
    true,
  );
  if (!enabled && !force) {
    return { attempted: false, sent: false, reason: "digest disabled" };
  }

  let report: VerificationReport;
  try {
    report = await loadReport();
  } catch (err: any) {
    return {
      attempted: true,
      sent: false,
      reason: `verification run failed: ${String(err?.message ?? err).slice(0, 160)}`,
    };
  }

  const message = composeDigestMessage(report);
  const id =
    report.overall === "fail"
      ? NOTIFICATION_ID_FAIL
      : NOTIFICATION_ID_PASS_OR_WARN;

  // Dispatch Slack + email in parallel — neither depends on the other,
  // and "sent" is true if either channel succeeds (so a Slack outage
  // doesn't block the email summary, and vice versa).
  const [dispatched, emailResult] = await Promise.all([
    dispatch(id, message, {
      overall: report.overall,
      generatedAt: report.generatedAt,
      groupStatuses: report.groups.map((g) => ({ id: g.id, status: g.status })),
      baselineSavedAt: report.baseline?.savedAt ?? null,
    }),
    dispatchEmail(message, report.overall, report.generatedAt),
  ]);

  const slack = {
    delivered: dispatched.delivered,
    reason: dispatched.delivered
      ? undefined
      : dispatched.skipReason ?? dispatched.status ?? "not_delivered",
  };
  const sent = dispatched.delivered || emailResult.delivered;
  if (sent && !force) alreadySentThisBoot = true;
  return {
    attempted: true,
    sent,
    reason: sent
      ? `delivered via ${[
          dispatched.delivered ? "slack" : null,
          emailResult.delivered ? "email" : null,
        ]
          .filter(Boolean)
          .join("+")}`
      : `slack=${slack.reason ?? "?"} email=${emailResult.reason ?? "?"}`,
    overall: report.overall,
    notificationId: id,
    slack,
    email: emailResult,
  };
}

/**
 * Schedule a single boot-time post of the verification report. Returns the
 * timer handle so the caller can register it with the bootstrap timer
 * tracker.
 */
export function schedulePostDeployVerificationDigest(opts?: {
  delayMs?: number;
  isShutdown?: () => boolean;
}): ReturnType<typeof setTimeout> {
  const delayMs = opts?.delayMs ?? POST_DEPLOY_DIGEST_BOOT_DELAY_MS;
  const isShutdown = opts?.isShutdown ?? (() => false);
  return setTimeout(() => {
    if (isShutdown()) return;
    void withDbAttribution("scheduler:post-deploy-verification-digest", async () => {
      try {
        const r = await maybeSendPostDeployDigest();
        if (r.sent) {
          console.log(
            `[PostDeployDigest] sent (overall=${r.overall}, id=${r.notificationId})`,
          );
        } else {
          console.log(`[PostDeployDigest] skipped: ${r.reason}`);
        }
      } catch (err: any) {
        console.warn("[PostDeployDigest] tick failed:", err?.message ?? err);
      }
    });
  }, delayMs);
}

export const __testHelpers = {
  setDispatcherForTests(fn: NotifyByTypeFn | null): void {
    dispatcherOverride = fn;
  },
  setReportFnForTests(fn: (() => Promise<VerificationReport>) | null): void {
    reportFnOverride = fn;
  },
  setMailerForTests(fn: SendEmailFn | null): void {
    mailerOverride = fn;
  },
  resetBootGuardForTests(): void {
    alreadySentThisBoot = false;
  },
  NOTIFICATION_ID_PASS_OR_WARN,
  NOTIFICATION_ID_FAIL,
  SETTING_ENABLED,
  SETTING_EMAIL_RECIPIENTS,
};
