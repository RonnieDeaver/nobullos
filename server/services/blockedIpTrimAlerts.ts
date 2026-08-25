/**
 * Task #780 — out-of-band notifications when blocked-IP change-history rows
 * are auto-trimmed by the per-IP retention cap.
 *
 * Before this service, trim events were only visible in the Rate Limit
 * Dashboard's in-page badge. Admins watching the dashboard would notice;
 * everyone else would not. This service surfaces the same events through
 * the canonical Slack dispatcher (`notifyByType`) and SendGrid (`sendEmail`)
 * so admins are notified out-of-band.
 *
 * Design notes:
 * - Opt-in: master `blocked_ip_trim_alert_enabled` defaults to `false`.
 *   Email recipients are configured separately and blank = no email.
 * - Throttled / batched: trims are accumulated in-memory and flushed once
 *   per `blocked_ip_trim_alert_batch_window_seconds` (default 60s) so a
 *   noisy IP cannot flood admins.
 * - Per-IP cooldown: each scope can only trigger an alert once per
 *   `blocked_ip_trim_alert_per_ip_cooldown_minutes` (default 60min).
 *   Trims that arrive while a scope is still in cooldown are folded
 *   into the in-memory pending bucket *until the next scheduled flush*.
 *   On that flush they appear in the diagnostic `perScope` array as
 *   `skipped_cooldown` and are then dropped — they are NOT carried over
 *   into the next batch. This keeps the alert count proportional to
 *   the cooldown setting (the goal — prevent flooding) at the cost of
 *   under-reporting the absolute trim total during a sustained burst.
 *   Admins who want the exact totals can consult the in-page badge or
 *   the `admin_setting_audit` rows written by `recordAdminSettingChange`.
 * - Slack channel: looked up via `notification_settings` for
 *   `usage.blocked_ip_audit.trimmed`, falling back to the legacy
 *   `rate_limit_alert_slack_channel_id` so existing setups keep working.
 */

import { getSystemSetting } from "../storage/settingsStorage";
import { sendEmail, isMailerConfigured } from "./mailer";

export const NOTIFICATION_ID = "usage.blocked_ip_audit.trimmed";

export const SETTING_ENABLED = "blocked_ip_trim_alert_enabled";
export const SETTING_EMAIL = "blocked_ip_trim_alert_email";
export const SETTING_MIN_TRIMS = "blocked_ip_trim_alert_min_trims";
export const SETTING_BATCH_WINDOW = "blocked_ip_trim_alert_batch_window_seconds";
export const SETTING_COOLDOWN = "blocked_ip_trim_alert_per_ip_cooldown_minutes";
// Task #1238 — per-IP-prefix overrides for `minTrims` / `perIpCooldownMinutes`.
// Stored as a JSON-stringified array of `{ scopePattern, minTrims?, perIpCooldownMinutes? }`.
// The first override whose `scopePattern` matches the trim event's scope wins;
// any field not provided on the override falls back to the global value.
export const SETTING_OVERRIDES = "blocked_ip_trim_alert_overrides";

export const DEFAULTS = {
  enabled: false,
  email: "",
  minTrims: 1,
  batchWindowSeconds: 60,
  perIpCooldownMinutes: 60,
  overrides: [] as BlockedIpTrimAlertOverride[],
};

export interface BlockedIpTrimAlertOverride {
  scopePattern: string;
  minTrims?: number;
  perIpCooldownMinutes?: number;
}

export interface BlockedIpTrimAlertConfig {
  enabled: boolean;
  email: string;
  emailRecipients: string[];
  minTrims: number;
  batchWindowSeconds: number;
  perIpCooldownMinutes: number;
  overrides: BlockedIpTrimAlertOverride[];
}

function parseBool(raw: string | undefined | null, fallback: boolean): boolean {
  if (raw == null) return fallback;
  const v = String(raw).trim().toLowerCase();
  if (v === "true" || v === "1" || v === "on" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "off" || v === "no") return false;
  return fallback;
}

function parsePositiveInt(raw: string | undefined | null, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

/**
 * Parse the JSON-encoded `blocked_ip_trim_alert_overrides` setting. Invalid
 * entries (missing `scopePattern`, non-positive numeric overrides) are dropped
 * silently — the caller has no clean recovery path and a bad override should
 * never break the prune path.
 */
export function parseOverrides(raw: string | undefined | null): BlockedIpTrimAlertOverride[] {
  if (!raw) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out: BlockedIpTrimAlertOverride[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const scopePattern =
      typeof rec.scopePattern === "string" ? rec.scopePattern.trim() : "";
    if (!scopePattern) continue;
    const override: BlockedIpTrimAlertOverride = { scopePattern };
    if (rec.minTrims != null) {
      const n = Number.parseInt(String(rec.minTrims), 10);
      if (Number.isFinite(n) && n > 0) override.minTrims = n;
    }
    if (rec.perIpCooldownMinutes != null) {
      const n = Number.parseInt(String(rec.perIpCooldownMinutes), 10);
      if (Number.isFinite(n) && n >= 0) override.perIpCooldownMinutes = n;
    }
    if (override.minTrims === undefined && override.perIpCooldownMinutes === undefined) {
      // No-op override — drop so it doesn't pollute matching.
      continue;
    }
    out.push(override);
  }
  return out;
}

/**
 * Validate that an override `scopePattern` is well-formed. Returns `null`
 * on success or a human-readable reason string on failure. Used by the
 * PUT route to reject malformed patterns at the API boundary instead of
 * silently never-matching at flush time.
 */
export function validateScopePattern(pattern: string): string | null {
  if (typeof pattern !== "string") return "must be a string";
  const trimmed = pattern.trim();
  if (!trimmed) return "must not be empty";

  // CIDR-shaped patterns must parse cleanly.
  const cidrMatch = /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\/(\d{1,2})$/.exec(trimmed);
  if (cidrMatch) {
    const bits = Number.parseInt(cidrMatch[2], 10);
    if (!Number.isFinite(bits) || bits < 0 || bits > 32) {
      return `CIDR bits must be 0–32, got ${cidrMatch[2]}`;
    }
    if (ipv4ToInt(cidrMatch[1]) === null) {
      return `invalid IPv4 in CIDR: ${cidrMatch[1]}`;
    }
    return null;
  }
  // Any other slash-containing pattern looks like a malformed CIDR — reject.
  if (trimmed.includes("/")) {
    return `looks like CIDR but does not parse as <ipv4>/<bits>`;
  }
  // Glob / exact: must compile as a regex once escaped (sanity check).
  try {
    const escaped = trimmed.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    new RegExp("^" + escaped + "$");
  } catch (err: any) {
    return `pattern does not compile: ${err?.message ?? "unknown"}`;
  }
  return null;
}

/**
 * Match a trim scope against an override pattern. Supports:
 *   - exact match: `"ip:1.2.3.4"`
 *   - glob with `*`: `"ip:1.2.3.*"`, `"*:1.2.3.4"`
 *   - IPv4 CIDR: `"203.0.113.0/24"` — matched against the first dotted-quad
 *     IPv4 substring found inside the scope (so `"ip:203.0.113.7"` matches
 *     `"203.0.113.0/24"`).
 *
 * Exported for tests.
 */
export function matchScopePattern(scope: string | null, pattern: string): boolean {
  if (!pattern) return false;
  const target = scope ?? "";
  const trimmed = pattern.trim();
  if (!trimmed) return false;

  // CIDR: <ipv4>/<bits>
  const cidrMatch = /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\/(\d{1,2})$/.exec(trimmed);
  if (cidrMatch) {
    const bits = Number.parseInt(cidrMatch[2], 10);
    if (!Number.isFinite(bits) || bits < 0 || bits > 32) return false;
    const baseInt = ipv4ToInt(cidrMatch[1]);
    if (baseInt === null) return false;
    const ipInScope = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/.exec(target);
    if (!ipInScope) return false;
    const targetInt = ipv4ToInt(ipInScope[1]);
    if (targetInt === null) return false;
    if (bits === 0) return true;
    const mask = bits === 32 ? 0xffffffff : (0xffffffff << (32 - bits)) >>> 0;
    return (baseInt & mask) === (targetInt & mask);
  }

  // Glob (with `*`) or exact match.
  if (trimmed.includes("*")) {
    const escaped = trimmed.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp("^" + escaped + "$").test(target);
  }
  return trimmed === target;
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let acc = 0;
  for (const part of parts) {
    const n = Number.parseInt(part, 10);
    if (!Number.isFinite(n) || n < 0 || n > 255 || String(n) !== part) return null;
    acc = (acc * 256 + n) >>> 0;
  }
  return acc >>> 0;
}

/**
 * Merge the global config with the first matching override for a given scope,
 * returning the effective `minTrims` / `perIpCooldownMinutes` that should apply.
 */
export function resolveScopeConfig(
  scope: string | null,
  config: BlockedIpTrimAlertConfig,
): { minTrims: number; perIpCooldownMinutes: number; matchedPattern: string | null } {
  for (const ov of config.overrides) {
    if (matchScopePattern(scope, ov.scopePattern)) {
      return {
        minTrims: ov.minTrims ?? config.minTrims,
        perIpCooldownMinutes:
          ov.perIpCooldownMinutes ?? config.perIpCooldownMinutes,
        matchedPattern: ov.scopePattern,
      };
    }
  }
  return {
    minTrims: config.minTrims,
    perIpCooldownMinutes: config.perIpCooldownMinutes,
    matchedPattern: null,
  };
}

function parseEmailList(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return String(raw)
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && /.+@.+\..+/.test(s));
}

export async function getBlockedIpTrimAlertConfig(): Promise<BlockedIpTrimAlertConfig> {
  const [enabledRow, emailRow, minRow, windowRow, cooldownRow, overridesRow] = await Promise.all([
    getSystemSetting(SETTING_ENABLED).catch(() => null),
    getSystemSetting(SETTING_EMAIL).catch(() => null),
    getSystemSetting(SETTING_MIN_TRIMS).catch(() => null),
    getSystemSetting(SETTING_BATCH_WINDOW).catch(() => null),
    getSystemSetting(SETTING_COOLDOWN).catch(() => null),
    getSystemSetting(SETTING_OVERRIDES).catch(() => null),
  ]);
  const email = (emailRow?.value ?? DEFAULTS.email).trim();
  return {
    enabled: parseBool(enabledRow?.value, DEFAULTS.enabled),
    email,
    emailRecipients: parseEmailList(email),
    minTrims: parsePositiveInt(minRow?.value, DEFAULTS.minTrims),
    batchWindowSeconds: parsePositiveInt(windowRow?.value, DEFAULTS.batchWindowSeconds),
    perIpCooldownMinutes: parsePositiveInt(cooldownRow?.value, DEFAULTS.perIpCooldownMinutes),
    overrides: parseOverrides(overridesRow?.value),
  };
}

interface PendingTrim {
  scope: string | null;
  count: number;
  cap: number;
  firstAt: number;
  lastAt: number;
}

const pending = new Map<string, PendingTrim>();
const lastAlertedAt = new Map<string, number>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushInFlight: Promise<void> | null = null;

function scopeKey(scope: string | null): string {
  return scope ?? "(no-scope)";
}

export interface EnqueueResult {
  enqueued: boolean;
  reason?: "alerts_disabled";
  scheduledFlushInMs?: number;
}

/**
 * Called by `auditRetention.recordBlockedIpTrimNotifications` after trim
 * audit rows are written. Best-effort; never throws.
 */
export async function recordTrimEventsForAlerting(
  events: Array<{ scope: string | null; count: number }>,
  cap: number,
): Promise<EnqueueResult> {
  if (!events || events.length === 0) return { enqueued: false };
  let config: BlockedIpTrimAlertConfig;
  try {
    config = await getBlockedIpTrimAlertConfig();
  } catch (err: any) {
    console.warn(
      "[BlockedIpTrimAlerts] config load failed, skipping alert:",
      err?.message ?? err,
    );
    return { enqueued: false };
  }
  if (!config.enabled) {
    return { enqueued: false, reason: "alerts_disabled" };
  }

  const now = Date.now();
  for (const ev of events) {
    if (!ev || typeof ev.count !== "number" || ev.count <= 0) continue;
    const key = scopeKey(ev.scope);
    const prev = pending.get(key);
    if (prev) {
      prev.count += ev.count;
      prev.lastAt = now;
      prev.cap = cap;
    } else {
      pending.set(key, {
        scope: ev.scope,
        count: ev.count,
        cap,
        firstAt: now,
        lastAt: now,
      });
    }
  }

  const windowMs = config.batchWindowSeconds * 1000;
  if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void runFlushOnce("scheduled");
    }, windowMs);
    if (typeof (flushTimer as any).unref === "function") {
      (flushTimer as any).unref();
    }
  }
  return { enqueued: true, scheduledFlushInMs: windowMs };
}

export interface FlushResult {
  evaluatedAt: string;
  enabled: boolean;
  pendingScopes: number;
  alertedScopes: number;
  totalTrimmed: number;
  slack: { delivered: boolean; status?: string; skipReason?: string } | null;
  email: { delivered: boolean; recipients: number; reason?: string } | null;
  perScope: Array<{
    scope: string | null;
    count: number;
    decision:
      | "alerted"
      | "skipped_below_min"
      | "skipped_cooldown"
      | "skipped_disabled"
      | "skipped_no_destination";
    skipReason?: string;
  }>;
}

async function runFlushOnce(
  trigger: "scheduled" | "manual" | "test" = "scheduled",
): Promise<FlushResult | null> {
  if (flushInFlight) {
    return flushInFlight.then(() => null);
  }
  flushInFlight = (async () => {
    try {
      const r = await flushNow(trigger);
      if (r.alertedScopes > 0) {
        console.log(
          `[BlockedIpTrimAlerts] flush trigger=${trigger} ` +
            `scopes=${r.pendingScopes} alerted=${r.alertedScopes} ` +
            `trimmed=${r.totalTrimmed}`,
        );
      }
    } catch (err: any) {
      console.error("[BlockedIpTrimAlerts] flush failed:", err?.message ?? err);
    } finally {
      flushInFlight = null;
    }
  })();
  await flushInFlight;
  return null;
}

type NotifyByTypeFn = typeof import("./notifications/dispatcher").notifyByType;
let dispatcherOverride: NotifyByTypeFn | null = null;
type SendEmailFn = typeof sendEmail;
let mailerOverride: SendEmailFn | null = null;

export async function flushNow(
  trigger: "scheduled" | "manual" | "test" = "manual",
): Promise<FlushResult> {
  const config = await getBlockedIpTrimAlertConfig();
  const now = Date.now();
  const result: FlushResult = {
    evaluatedAt: new Date(now).toISOString(),
    enabled: config.enabled,
    pendingScopes: pending.size,
    alertedScopes: 0,
    totalTrimmed: 0,
    slack: null,
    email: null,
    perScope: [],
  };

  if (!config.enabled && trigger !== "test") {
    // Drop everything queued — admins disabled alerts.
    for (const [, p] of pending) {
      result.perScope.push({
        scope: p.scope,
        count: p.count,
        decision: "skipped_disabled",
        skipReason: "alerts disabled",
      });
    }
    pending.clear();
    return result;
  }

  const eligible: PendingTrim[] = [];
  const carryOver = new Map<string, PendingTrim>();

  for (const [key, p] of pending) {
    // Task #1238 — apply the first matching per-prefix override before
    // evaluating min-trims / cooldown thresholds.
    const eff = resolveScopeConfig(p.scope, config);
    const effMinTrims = eff.minTrims;
    const effCooldownMs = eff.perIpCooldownMinutes * 60_000;
    const overrideSuffix = eff.matchedPattern
      ? ` (override: ${eff.matchedPattern})`
      : "";
    if (p.count < effMinTrims) {
      // Too small on its own — keep for next batch in case more arrive.
      carryOver.set(key, p);
      result.perScope.push({
        scope: p.scope,
        count: p.count,
        decision: "skipped_below_min",
        skipReason: `count ${p.count} < min ${effMinTrims}${overrideSuffix}`,
      });
      continue;
    }
    const last = lastAlertedAt.get(key) ?? 0;
    if (trigger === "scheduled" && now - last < effCooldownMs) {
      result.perScope.push({
        scope: p.scope,
        count: p.count,
        decision: "skipped_cooldown",
        skipReason: `last alert ${(now - last) / 60_000 | 0}m ago < ${eff.perIpCooldownMinutes}m${overrideSuffix}`,
      });
      // Drop — folded into the prior alert window.
      continue;
    }
    eligible.push(p);
  }

  pending.clear();
  for (const [k, v] of carryOver) pending.set(k, v);

  if (eligible.length === 0) {
    return result;
  }

  result.totalTrimmed = eligible.reduce((sum, p) => sum + p.count, 0);

  const cap = eligible[0]?.cap ?? 0;
  const lines = eligible
    .slice(0, 25)
    .map(
      (p) =>
        `• ${p.scope ?? "(unscoped)"} — ${p.count} row${p.count === 1 ? "" : "s"} trimmed`,
    );
  const overflow = eligible.length > 25 ? `\n…and ${eligible.length - 25} more IP(s).` : "";
  const slackText =
    `:scissors: *Blocked-IP change history was trimmed*\n` +
    `${eligible.length} IP scope${eligible.length === 1 ? "" : "s"} trimmed ` +
    `${result.totalTrimmed} row${result.totalTrimmed === 1 ? "" : "s"} ` +
    `(per-IP cap: ${cap}).\n` +
    `${lines.join("\n")}${overflow}\n` +
    `Review history in the Rate Limit Dashboard → Blocked IPs panel.`;
  const emailSubject =
    `[NoBull OS] Blocked-IP history trimmed (${result.totalTrimmed} row` +
    `${result.totalTrimmed === 1 ? "" : "s"} across ` +
    `${eligible.length} IP${eligible.length === 1 ? "" : "s"})`;
  const emailBody =
    `The per-IP retention cap (${cap}) trimmed older blocked-IP audit rows.\n\n` +
    eligible
      .map(
        (p) =>
          `  - ${p.scope ?? "(unscoped)"}: ${p.count} row(s) trimmed ` +
          `(first ${new Date(p.firstAt).toISOString()}, ` +
          `last ${new Date(p.lastAt).toISOString()})`,
      )
      .join("\n") +
    `\n\nTotal trimmed in this batch: ${result.totalTrimmed}.\n` +
    `To change the per-IP cap, batching window, or alert recipients, ` +
    `visit Admin → Audit Retention.\n`;

  let slackOk = false;
  try {
    const notifyByType =
      dispatcherOverride ??
      (await import("./notifications/dispatcher")).notifyByType;
    const r = await notifyByType(
      NOTIFICATION_ID,
      { text: slackText, preview: slackText.slice(0, 280) },
      {
        triggerSource: trigger === "test" ? "test" : "alert_service",
        // Per-IP cooldown is enforced above; let the dispatcher fire each
        // batch through the channel.
        bypassDedupe: true,
        metadata: {
          scopes: eligible.length,
          totalTrimmed: result.totalTrimmed,
          cap,
          trigger,
        },
      },
    );
    slackOk = r.delivered;
    result.slack = {
      delivered: r.delivered,
      status: r.status,
      skipReason: r.skipReason,
    };
  } catch (err: any) {
    console.error(
      "[BlockedIpTrimAlerts] Slack dispatch failed:",
      err?.message ?? err,
    );
    result.slack = { delivered: false, skipReason: `dispatch_error:${err?.message}` };
  }

  let emailOk = false;
  if (config.emailRecipients.length === 0) {
    result.email = { delivered: false, recipients: 0, reason: "no_recipients" };
  } else if (!mailerOverride && !isMailerConfigured()) {
    result.email = {
      delivered: false,
      recipients: config.emailRecipients.length,
      reason: "mailer_not_configured",
    };
  } else {
    try {
      const sendFn = mailerOverride ?? sendEmail;
      const r = await sendFn({
        to: config.emailRecipients,
        subject: emailSubject,
        text: emailBody,
        logPrefix: "[BlockedIpTrimAlerts]",
      });
      emailOk = r.ok;
      result.email = {
        delivered: r.ok,
        recipients: config.emailRecipients.length,
        reason: r.ok ? undefined : r.reason,
      };
    } catch (err: any) {
      console.error(
        "[BlockedIpTrimAlerts] Email send failed:",
        err?.message ?? err,
      );
      result.email = {
        delivered: false,
        recipients: config.emailRecipients.length,
        reason: `exception:${err?.message ?? "unknown"}`,
      };
    }
  }

  // If neither Slack nor email could deliver, mark every scope as
  // skipped_no_destination so the diagnostics view is honest.
  if (!slackOk && !emailOk) {
    for (const p of eligible) {
      result.perScope.push({
        scope: p.scope,
        count: p.count,
        decision: "skipped_no_destination",
        skipReason:
          (result.slack?.skipReason ?? "slack_undelivered") +
          " / " +
          (result.email?.reason ?? "email_undelivered"),
      });
    }
    return result;
  }

  for (const p of eligible) {
    lastAlertedAt.set(scopeKey(p.scope), now);
    result.alertedScopes += 1;
    result.perScope.push({
      scope: p.scope,
      count: p.count,
      decision: "alerted",
    });
  }

  return result;
}

export async function triggerBlockedIpTrimAlertFlushNow(): Promise<FlushResult> {
  return flushNow("manual");
}

export async function sendBlockedIpTrimAlertTest(): Promise<FlushResult> {
  // Inject a synthetic event into the queue so a test send always has
  // something to report on.
  const synthetic: PendingTrim = {
    scope: "test:198.51.100.42",
    count: 3,
    cap: 100,
    firstAt: Date.now(),
    lastAt: Date.now(),
  };
  pending.set(scopeKey(synthetic.scope), synthetic);
  return flushNow("test");
}

export const __testHelpers = {
  reset(): void {
    pending.clear();
    lastAlertedAt.clear();
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
  },
  setDispatcher(fn: NotifyByTypeFn | null): void {
    dispatcherOverride = fn;
  },
  setMailer(fn: SendEmailFn | null): void {
    mailerOverride = fn;
  },
  pendingCount(): number {
    return pending.size;
  },
  forceFlush(trigger: "scheduled" | "manual" | "test" = "manual"): Promise<FlushResult> {
    return flushNow(trigger);
  },
};
