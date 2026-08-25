/**
 * Task #4334 — Outbound client-facing email: ONE send seam with
 * mailbox-first routing.
 *
 * Routing policy (owner-directed):
 *   1. Every send defaults to the ASSIGNED USER'S OWN MAILBOX via their
 *      Front channel (user_email_identities mapping) — rides real mailbox
 *      reputation; the sent message and replies land in Front and are
 *      auto-captured by the existing sync.
 *   2. When the user's daily cap is exhausted, remaining sends DEFER to the
 *      next UTC window — or route to SendGrid ONLY when the owner-gated
 *      fallback is enabled on a verified marketing domain (SPF + DKIM via
 *      SendGrid domain auth, DMARC via DNS). Enabling without verification
 *      is structurally impossible (the enable path re-verifies server-side).
 *   3. The global suppression list is enforced on EVERY transport path.
 *      Unsubscribe suppressions block marketing only so paid access/receipts
 *      remain deliverable; bounce, complaint, and manual safety blocks apply
 *      to both message classes.
 *
 * Idempotency & at-most-once dispatch (pressure cases P1/P5/P11):
 *   - Per-recipient row ids are deterministic hashes of (batchId, email);
 *     compose re-POSTs collide on ON CONFLICT DO NOTHING.
 *   - The queue handler re-checks row state first (replayed jobs no-op).
 *   - A dispatch claim is CASed before ANY vendor call; ambiguous vendor
 *     outcomes (timeout mid-flight, 5xx on create) mark the row `unknown`,
 *     fire an alert, and are NEVER auto-retried.
 *
 * Sequences/templates/approval queues are the NEXT task — this module is
 * the transport. Future producers reuse composeOutboundEmails with their
 * own consentSource stamp.
 */

import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { randomUUID } from "crypto";
import type { WorkQueueJob, OutboundEmail } from "@shared/schema";
import {
  claimOutboundEmailDispatch,
  countCapWindowSends,
  getOutboundEmail,
  getUserEmailIdentity,
  insertOutboundEmails,
  isEmailSuppressed,
  listOutboundEmailsByBatch,
  bulkInsertEmailSuppressions,
  listWebsiteUnsubscribeEmails,
  normalizeEmailAddress,
  updateOutboundEmail,
  upsertEmailSuppression,
} from "../storage/outboundEmailStorage";
import {
  getSystemSetting,
  getSystemSettingFresh,
  setSystemSetting,
} from "../storage/settingsStorage";

// ── Settings keys ────────────────────────────────────────────────────────────

/** Default per-user daily Front-path cap when the identity has no override. */
export const OUTBOUND_EMAIL_DAILY_CAP_DEFAULT_KEY = "outbound_email_daily_cap_default";
export const OUTBOUND_EMAIL_DAILY_CAP_FALLBACK = 30;

/** Kill switch: 'true' pauses all outbound sending (sends defer, never fail). */
export const OUTBOUND_EMAIL_PAUSED_KEY = "outbound_email_sending_paused";

/** Owner-gated SendGrid overflow switch. Ships OFF; enable re-verifies. */
export const OUTBOUND_SENDGRID_FALLBACK_ENABLED_KEY = "outbound_sendgrid_fallback_enabled";

/** Marketing domain the SendGrid lane must be verified against. */
export const OUTBOUND_MARKETING_DOMAIN_KEY = "outbound_marketing_domain";

/** From address for the SendGrid lane (must be on the marketing domain). */
export const OUTBOUND_SENDGRID_FROM_EMAIL_KEY = "outbound_sendgrid_from_email";

/** JSON snapshot of the last domain verification run. */
export const OUTBOUND_SENDGRID_VERIFICATION_KEY = "outbound_sendgrid_domain_verification";

/** Marker: historical website-unsubscribe seed sweep completed (ISO stamp). */
export const OUTBOUND_SUPPRESSION_SEED_MARKER_KEY = "outbound_email_suppression_seeded_at";

export const OUTBOUND_EMAIL_QUEUE = "outbound_email_send";

/** A row may defer at most this many windows before failing loudly. */
const MAX_DEFERRALS = 14;

/** Dispatch claims older than this are reclaimable (crashed attempt). */
const STALE_CLAIM_MS = 10 * 60 * 1000;

// ── Test seam: injectable vendor-send implementations ────────────────────────
// Hermetic suites replace the two vendor calls (Front channel send, SendGrid
// overflow send) so the seam's routing/claim/cap logic runs for real against
// the per-run test DB with zero network egress and no OAuth token store.
// Everything else (claims, caps, suppression, deferral, alerts) is the
// production code path.

interface OutboundSendTestDeps {
  sendFrontChannelMessage?: (opts: {
    channelId: string;
    to: string;
    subject: string;
    bodyText: string;
    bodyHtml?: string | null;
    sendId: string;
  }) => Promise<{ messageUid: string | null; status: number }>;
  sendMarketingEmail?: typeof import("./mailer").sendMarketingEmail;
}

let testSendDeps: OutboundSendTestDeps | null = null;

export function __setOutboundSendDepsForTests(deps: OutboundSendTestDeps | null): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("__setOutboundSendDepsForTests is test-only");
  }
  testSendDeps = deps;
}

// ── Deterministic ids (P1) ───────────────────────────────────────────────────

/** SHA-256 → UUID-shaped id (version nibble 8 marks derived ids; matches the
 *  twilioService.deriveOutboundOperationId convention). */
function hashToUuidShape(input: string): string {
  const h = createHash("sha256").update(input).digest("hex");
  const variantNibble = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${variantNibble}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function deriveOutboundEmailBatchId(senderUserId: string, clientBatchKey: string): string {
  return hashToUuidShape(`outbound_email_batch\u0000${senderUserId}\u0000${clientBatchKey}`);
}

export function deriveOutboundEmailId(batchId: string, email: string): string {
  return hashToUuidShape(`outbound_email\u0000${batchId}\u0000${normalizeEmailAddress(email)}`);
}

// ── Suppression seed (lazy runtime ensure) ───────────────────────────────────

let seedInFlight: Promise<void> | null = null;

/**
 * One-time seed of the suppression list from historical website unsubscribe
 * inquiries. Lazy runtime ensure (single-flight + marker setting + ON
 * CONFLICT DO NOTHING) — migration INSERTs never reach prod. New unsubscribe
 * inquiries are hooked at the intake route, so the sweep only needs to run
 * once per environment.
 */
export async function ensureSuppressionSeeded(): Promise<void> {
  const marker = await getSystemSetting(OUTBOUND_SUPPRESSION_SEED_MARKER_KEY);
  if (marker?.value) return;
  if (!seedInFlight) {
    seedInFlight = (async () => {
      try {
        const emails = await listWebsiteUnsubscribeEmails();
        const inserted = await bulkInsertEmailSuppressions(
          emails.map((email) => ({
            email,
            reason: "unsubscribe" as const,
            source: "website_unsubscribe_seed" as const,
          })),
        );
        await setSystemSetting(OUTBOUND_SUPPRESSION_SEED_MARKER_KEY, new Date().toISOString(), undefined);
        if (inserted > 0) {
          console.log(`[outbound-email] Seeded ${inserted} suppression(s) from website unsubscribe inquiries`);
        }
      } finally {
        // Marker write failed ⇒ allow a later call to retry the sweep
        // (inserts are conflict-safe, so a re-run is harmless).
        seedInFlight = null;
      }
    })();
  }
  await seedInFlight;
}

// ── Unsubscribe links ────────────────────────────────────────────────────────

/**
 * The per-recipient unsubscribe capability is the row's random 128-bit
 * token: the URL carries `{sendId}.{token}` and redemption compares
 * constant-time against the stored value. No PII in the URL, no signing key
 * to rotate, and revocation is row-scoped.
 */
export function mintUnsubscribeToken(): string {
  return randomBytes(16).toString("hex");
}

export function buildUnsubscribeUrl(baseUrl: string, sendId: string, token: string): string {
  return `${baseUrl.replace(/\/$/, "")}/api/email/unsubscribe?t=${encodeURIComponent(`${sendId}.${token}`)}`;
}

export interface UnsubscribeRedemption {
  ok: boolean;
  email?: string;
  reasonCode?: "malformed" | "not_found" | "token_mismatch";
}

/** Validate an unsubscribe token and suppress the recipient. Idempotent. */
export async function redeemUnsubscribeToken(raw: string): Promise<UnsubscribeRedemption> {
  const dot = raw.indexOf(".");
  if (dot <= 0 || dot === raw.length - 1) return { ok: false, reasonCode: "malformed" };
  const sendId = raw.slice(0, dot);
  const token = raw.slice(dot + 1);
  if (sendId.length > 64 || token.length > 64) return { ok: false, reasonCode: "malformed" };
  const row = await getOutboundEmail(sendId);
  if (!row || !row.unsubscribeToken) return { ok: false, reasonCode: "not_found" };
  const a = Buffer.from(row.unsubscribeToken);
  const b = Buffer.from(token);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reasonCode: "token_mismatch" };
  }
  await addEmailSuppressionWithSideEffects({
    email: row.toEmail,
    reason: "unsubscribe",
    source: "unsubscribe_link",
    cancelNote: "Unsubscribe link redeemed",
  });
  return { ok: true, email: row.toEmail };
}

// ── Suppression side effects (Task #4335) ───────────────────────────────────

/**
 * A new suppression also stops any active sequence enrollments for the
 * address immediately (visible cancel), not just at the next advance-time
 * or compose-time suppression backstop. Dynamic import: sequences depend
 * on this module for compose; the reverse edge stays lazy.
 */
type SuppressionSequenceCancelFn = (
  email: string,
  cancelReason: "suppressed" | "unsubscribed",
  note: string,
) => Promise<void>;

let suppressionSequenceCancelForTests: SuppressionSequenceCancelFn | null = null;

export function __setEmailSuppressionSequenceCancelForTests(
  fn: SuppressionSequenceCancelFn | null,
): void {
  suppressionSequenceCancelForTests = fn;
}

async function cancelSequenceEnrollmentsForSuppression(
  email: string,
  cancelReason: "suppressed" | "unsubscribed",
  note: string,
  throwOnFailure: boolean,
): Promise<void> {
  try {
    if (suppressionSequenceCancelForTests) {
      await suppressionSequenceCancelForTests(email, cancelReason, note);
      return;
    }
    const sequences = await import("./emailSequences");
    if (throwOnFailure) {
      await sequences.cancelActiveEnrollmentsForEmailOrThrow(
        email,
        cancelReason,
        note,
      );
    } else {
      await sequences.cancelActiveEnrollmentsForEmail(
        email,
        cancelReason,
        note,
      );
    }
  } catch (err) {
    console.error(
      "[outbound-email] sequence cancel on suppression failed:",
      err instanceof Error ? err.message : err,
    );
    if (throwOnFailure) throw err;
  }
}

/**
 * The single write path for NEW suppressions — manual admin route,
 * unsubscribe redeem, and SendGrid bounce/complaint/unsubscribe events
 * all go through here so the sequence-cancel side effect can never be
 * forgotten by a new caller. The one-time historical seed
 * (`ensureSuppressionSeeded`) is exempt: it imports pre-sequences data,
 * and the advance-time/compose-time backstops still apply to it.
 */
export async function addEmailSuppressionWithSideEffects(
  params: Parameters<typeof upsertEmailSuppression>[0] & {
    cancelNote?: string;
    /** Webhook callers return retryable 500 when eager cancellation fails. */
    requireSequenceCancellation?: boolean;
  },
): Promise<Awaited<ReturnType<typeof upsertEmailSuppression>>> {
  const {
    cancelNote,
    requireSequenceCancellation = false,
    ...upsert
  } = params;
  const result = await upsertEmailSuppression(upsert);
  await cancelSequenceEnrollmentsForSuppression(
    upsert.email,
    upsert.reason === "unsubscribe" ? "unsubscribed" : "suppressed",
    cancelNote ?? `Suppression added (${upsert.source})`,
    requireSequenceCancellation,
  );
  return result;
}

/**
 * Marketing opt-outs do not suppress paid access, receipts, shipment notices,
 * or appointment logistics. Delivery-safety suppressions still block every
 * class because sending to a bounced/complaining/manual-blocked address is not
 * safe merely because the content is transactional.
 */
export function emailSuppressionAppliesToMessageClass(
  suppression: { reason: string },
  messageClass: string,
): boolean {
  return messageClass === "marketing" || suppression.reason !== "unsubscribe";
}

// ── Compose (the seam) ───────────────────────────────────────────────────────

export interface ComposeRecipient {
  email: string;
  clientId?: string | null;
}

export interface ComposeParams {
  senderUserId: string;
  createdBy: string;
  subject: string;
  bodyText: string;
  bodyHtml?: string | null;
  messageClass: "transactional" | "marketing";
  /** Producer-stamped consent provenance; one-off composes use the default. */
  consentSource?: string;
  recipients: ComposeRecipient[];
  /**
   * Optional caller idempotency key: the same (sender, key) always derives
   * the same batchId, so a re-POST cannot fan out duplicate rows/jobs.
   */
  clientBatchKey?: string;
}

export interface ComposeResult {
  batchId: string;
  total: number;
  enqueued: number;
  suppressed: number;
  alreadyExisted: number;
}

export async function composeOutboundEmails(params: ComposeParams): Promise<ComposeResult> {
  const { enqueueJob } = await import("./workScheduler");
  await ensureSuppressionSeeded();

  const batchId = params.clientBatchKey
    ? deriveOutboundEmailBatchId(params.senderUserId, params.clientBatchKey)
    : randomUUID();

  // Normalize + de-dupe recipients within the batch.
  const seen = new Set<string>();
  const recipients: ComposeRecipient[] = [];
  for (const r of params.recipients) {
    const email = normalizeEmailAddress(r.email);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    recipients.push({ email, clientId: r.clientId ?? null });
  }

  let suppressed = 0;
  const rows = [] as Parameters<typeof insertOutboundEmails>[0];
  for (const r of recipients) {
    const suppression = await isEmailSuppressed(r.email);
    const isSuppressed =
      !!suppression &&
      emailSuppressionAppliesToMessageClass(suppression, params.messageClass);
    if (isSuppressed) suppressed++;
    rows.push({
      id: deriveOutboundEmailId(batchId, r.email),
      batchId,
      senderUserId: params.senderUserId,
      clientId: r.clientId ?? null,
      toEmail: r.email,
      subject: params.subject,
      bodyText: params.bodyText,
      bodyHtml: params.bodyHtml ?? null,
      messageClass: params.messageClass,
      consentSource: params.consentSource ?? "manual_compose",
      // Suppressed recipients are recorded VISIBLY as skipped — never sent,
      // and never silently dropped from the log.
      status: isSuppressed ? "suppressed" : "queued",
      errorCode: isSuppressed ? "suppressed" : null,
      errorMessage: isSuppressed ? `Recipient is on the suppression list (${suppression!.reason})` : null,
      unsubscribeToken: params.messageClass === "marketing" ? mintUnsubscribeToken() : null,
      createdBy: params.createdBy,
    });
  }

  const inserted = await insertOutboundEmails(rows);
  const alreadyExisted = rows.length - inserted.length;

  // Enqueue for every row of this batch still in `queued` — newly inserted
  // rows AND previously inserted rows whose job vanished (heal path). The
  // queue's dedupe key (partial-unique on non-terminal jobs) collapses
  // duplicates from concurrent re-POSTs.
  const batchRows = await listOutboundEmailsByBatch(batchId);
  let enqueued = 0;
  for (const row of batchRows) {
    if (row.status !== "queued") continue;
    // Gentle stagger so a 100-recipient compose doesn't burst the mailbox.
    const delayMs = enqueued * 2_000;
    await enqueueJob({
      queueName: OUTBOUND_EMAIL_QUEUE,
      workloadClass: "interactive",
      payload: { sendId: row.id },
      dedupeKey: `outbound_email:${row.id}`,
      maxAttempts: 3,
      ...(delayMs > 0 ? { retryAt: new Date(Date.now() + delayMs) } : {}),
    });
    enqueued++;
  }

  return { batchId, total: recipients.length, enqueued, suppressed, alreadyExisted };
}

// ── Routing decisions ────────────────────────────────────────────────────────

export async function getDefaultDailyCap(): Promise<number> {
  const setting = await getSystemSetting(OUTBOUND_EMAIL_DAILY_CAP_DEFAULT_KEY);
  const parsed = setting?.value ? parseInt(setting.value, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : OUTBOUND_EMAIL_DAILY_CAP_FALLBACK;
}

export function utcDayOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function nextUtcWindowStart(now: Date): Date {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return next;
}

export interface SendgridVerificationSnapshot {
  domain: string;
  sendgridValid: boolean;
  spfValid: boolean;
  dkimValid: boolean;
  dmarcFound: boolean;
  dmarcPolicy?: string | null;
  checkedAt: string;
  error?: string | null;
}

export function isVerificationPassing(snapshot: SendgridVerificationSnapshot | null | undefined): boolean {
  return !!snapshot && snapshot.sendgridValid && snapshot.spfValid && snapshot.dkimValid && snapshot.dmarcFound;
}

export async function readVerificationSnapshot(): Promise<SendgridVerificationSnapshot | null> {
  const setting = await getSystemSettingFresh(OUTBOUND_SENDGRID_VERIFICATION_KEY);
  if (!setting?.value) return null;
  try {
    return JSON.parse(setting.value) as SendgridVerificationSnapshot;
  } catch {
    return null;
  }
}

export type FallbackDecision =
  | { usable: true; fromEmail: string }
  | { usable: false; reason: "disabled" | "not_verified" | "no_from_email" | "from_email_off_domain" };

/**
 * Whether the SendGrid overflow lane may be used RIGHT NOW. The enabled
 * flag is read FRESH (a 300s-stale cached read on a disable switch is how
 * sends keep flowing five minutes after the owner turned them off), and the
 * verification snapshot is re-validated as defense in depth — the enable
 * ceremony is the authoritative gate.
 */
export async function resolveSendgridFallbackDecision(): Promise<FallbackDecision> {
  const enabled = await getSystemSettingFresh(OUTBOUND_SENDGRID_FALLBACK_ENABLED_KEY);
  if (enabled?.value !== "true") return { usable: false, reason: "disabled" };
  const snapshot = await readVerificationSnapshot();
  if (!isVerificationPassing(snapshot)) return { usable: false, reason: "not_verified" };
  const fromSetting = await getSystemSettingFresh(OUTBOUND_SENDGRID_FROM_EMAIL_KEY);
  const fromEmail = fromSetting?.value ? normalizeEmailAddress(fromSetting.value) : "";
  if (!fromEmail) return { usable: false, reason: "no_from_email" };
  if (!fromEmail.endsWith(`@${snapshot!.domain}`)) return { usable: false, reason: "from_email_off_domain" };
  return { usable: true, fromEmail };
}

// ── Domain verification ──────────────────────────────────────────────────────

type DnsTxtResolver = (hostname: string) => Promise<string[][]>;
let dnsTxtResolverOverride: DnsTxtResolver | null = null;

/** Test seam: inject a fake DNS TXT resolver (no real egress from tests). */
export function __setDnsTxtResolverForTests(resolver: DnsTxtResolver | null): void {
  dnsTxtResolverOverride = resolver;
}

async function resolveDmarc(domain: string): Promise<{ found: boolean; policy: string | null }> {
  try {
    let records: string[][];
    if (dnsTxtResolverOverride) {
      records = await dnsTxtResolverOverride(`_dmarc.${domain}`);
    } else {
      const dns = await import("node:dns/promises");
      records = await dns.resolveTxt(`_dmarc.${domain}`);
    }
    for (const chunks of records) {
      const txt = chunks.join("");
      if (/^v=DMARC1\b/i.test(txt.trim())) {
        const policy = /;\s*p=([a-z]+)/i.exec(txt)?.[1] ?? null;
        return { found: true, policy };
      }
    }
    return { found: false, policy: null };
  } catch {
    return { found: false, policy: null };
  }
}

/**
 * Run SPF/DKIM (SendGrid domain auth) + DMARC (DNS) verification for the
 * configured marketing domain and persist the snapshot. Returns the snapshot;
 * `null` domain means nothing is configured yet.
 */
export async function runSendgridDomainVerification(actorId: string | undefined): Promise<SendgridVerificationSnapshot | null> {
  const domainSetting = await getSystemSettingFresh(OUTBOUND_MARKETING_DOMAIN_KEY);
  const domain = domainSetting?.value?.trim().toLowerCase();
  if (!domain) return null;
  const { fetchSendgridDomainAuthStatus } = await import("./mailer");
  const auth = await fetchSendgridDomainAuthStatus(domain);
  const dmarc = await resolveDmarc(domain);
  const snapshot: SendgridVerificationSnapshot = {
    domain,
    sendgridValid: auth.valid,
    spfValid: auth.spfValid,
    dkimValid: auth.dkimValid,
    dmarcFound: dmarc.found,
    dmarcPolicy: dmarc.policy,
    checkedAt: new Date().toISOString(),
    error: auth.error ?? null,
  };
  await setSystemSetting(OUTBOUND_SENDGRID_VERIFICATION_KEY, JSON.stringify(snapshot), actorId);
  return snapshot;
}

export class SendgridEnableBlockedError extends Error {
  failures: string[];
  constructor(failures: string[]) {
    super(`SendGrid fallback cannot be enabled: ${failures.join(", ")}`);
    this.name = "SendgridEnableBlockedError";
    this.failures = failures;
  }
}

/**
 * Owner-gated enable/disable. Enabling RE-VERIFIES server-side and throws
 * unless every check passes — there is no code path that turns the flag on
 * without a passing, just-refreshed verification snapshot. Disabling is
 * always allowed.
 */
export async function setSendgridFallbackEnabled(enabled: boolean, actorId: string): Promise<SendgridVerificationSnapshot | null> {
  if (!enabled) {
    await setSystemSetting(OUTBOUND_SENDGRID_FALLBACK_ENABLED_KEY, "false", actorId);
    return readVerificationSnapshot();
  }
  const snapshot = await runSendgridDomainVerification(actorId);
  const failures: string[] = [];
  if (!snapshot) failures.push("marketing domain not configured");
  else {
    if (snapshot.error) failures.push(snapshot.error);
    if (!snapshot.sendgridValid) failures.push("SendGrid domain authentication not valid");
    if (!snapshot.spfValid) failures.push("SPF not verified");
    if (!snapshot.dkimValid) failures.push("DKIM not verified");
    if (!snapshot.dmarcFound) failures.push("DMARC record not found");
  }
  const fromSetting = await getSystemSettingFresh(OUTBOUND_SENDGRID_FROM_EMAIL_KEY);
  const fromEmail = fromSetting?.value ? normalizeEmailAddress(fromSetting.value) : "";
  if (!fromEmail) failures.push("fallback from-address not configured");
  else if (snapshot && !fromEmail.endsWith(`@${snapshot.domain}`)) {
    failures.push("fallback from-address is not on the marketing domain");
  }
  if (failures.length > 0) throw new SendgridEnableBlockedError(failures);
  await setSystemSetting(OUTBOUND_SENDGRID_FALLBACK_ENABLED_KEY, "true", actorId);
  return snapshot;
}

// ── Alerts ───────────────────────────────────────────────────────────────────

type OutboundEmailAlertNotify = (
  registryId: string,
  dedupeKey: string,
  text: string,
  preview: Record<string, unknown>,
) => void | Promise<void>;

/** Test-injected alert sink (house pattern, see Task #4184's ATS seam):
 *  under NODE_ENV=test the real dispatcher is never touched — with no stub
 *  installed the alert path is inert, keeping hermetic suites free of
 *  notification-table writes. */
let testAlertNotify: OutboundEmailAlertNotify | null = null;

export function __setOutboundEmailAlertNotifyForTests(fn: OutboundEmailAlertNotify | null): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("__setOutboundEmailAlertNotifyForTests is test-only");
  }
  testAlertNotify = fn;
}

async function alertOutboundEmail(
  registryId: string,
  dedupeKey: string,
  text: string,
  preview: Record<string, unknown>,
): Promise<void> {
  try {
    if (process.env.NODE_ENV === "test") {
      await testAlertNotify?.(registryId, dedupeKey, text, preview);
      return;
    }
    const { notifyByType } = await import("./notifications/dispatcher");
    await notifyByType(
      registryId,
      { text, preview },
      { triggerSource: "alert_service", dedupeKey, mirrorDeepLink: "/admin/outbound-email" },
    );
  } catch (err) {
    // Alerting must never take the send pipeline down with it.
    console.error(`[outbound-email] alert dispatch failed (${registryId}):`, err instanceof Error ? err.message : err);
  }
}

// ── Body assembly ────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function appendUnsubscribeFooter(params: {
  bodyText: string;
  bodyHtml: string | null;
  unsubscribeUrl: string;
}): { text: string; html: string | null } {
  const text = `${params.bodyText}\n\n—\nTo stop receiving these emails, unsubscribe here: ${params.unsubscribeUrl}`;
  const html = params.bodyHtml
    ? `${params.bodyHtml}<hr style="margin-top:24px;border:none;border-top:1px solid #ddd" /><p style="font-size:12px;color:#777">To stop receiving these emails, <a href="${escapeHtml(params.unsubscribeUrl)}">unsubscribe here</a>.</p>`
    : null;
  return { text, html };
}

async function resolvePublicBase(): Promise<string> {
  const { getPublicBaseUrl } = await import("./publicUrl");
  return getPublicBaseUrl({ allowLocalhostFallback: true });
}

// ── The queue handler ────────────────────────────────────────────────────────

/**
 * Per-recipient send job. Terminal row states complete the job silently
 * (replay-safe); definitive pre-send failures rethrow for the queue's
 * bounded retry; POST-claim outcomes are always terminal for the row and
 * never rethrow (the claim is the at-most-once boundary).
 */
export async function handleOutboundEmailSend(job: WorkQueueJob): Promise<void> {
  const sendId = (job.payload as any)?.sendId as string | undefined;
  if (!sendId) {
    console.warn(`[outbound-email] job ${job.id} missing payload.sendId — dropping`);
    return;
  }
  const row = await getOutboundEmail(sendId);
  if (!row) {
    console.warn(`[outbound-email] job ${job.id}: send ${sendId} not found — dropping`);
    return;
  }
  // Replay gate (P5): only queued/deferred rows are actionable.
  if (row.status !== "queued" && row.status !== "deferred") {
    return;
  }

  const { enqueueJob } = await import("./workScheduler");
  const now = new Date();

  // Kill switch — pause defers, never fails. Fresh read: a stale cached
  // 'paused' flag must not keep sends flowing.
  const paused = await getSystemSettingFresh(OUTBOUND_EMAIL_PAUSED_KEY);
  if (paused?.value === "true") {
    const resumeAt = new Date(now.getTime() + 30 * 60 * 1000);
    await updateOutboundEmail(row.id, { status: "deferred", scheduledFor: resumeAt });
    const bucket = resumeAt.toISOString().slice(0, 13); // hour bucket bounds job litter
    await enqueueJob({
      queueName: OUTBOUND_EMAIL_QUEUE,
      workloadClass: "interactive",
      payload: { sendId: row.id },
      dedupeKey: `outbound_email:${row.id}:paused:${bucket}`,
      maxAttempts: 3,
      retryAt: resumeAt,
    });
    return;
  }

  // Suppression — rechecked on EVERY send attempt, with class-aware policy.
  const suppression = await isEmailSuppressed(row.toEmail);
  if (
    suppression &&
    emailSuppressionAppliesToMessageClass(suppression, row.messageClass)
  ) {
    await updateOutboundEmail(row.id, {
      status: "suppressed",
      errorCode: "suppressed",
      errorMessage: `Recipient is on the suppression list (${suppression.reason})`,
    });
    return;
  }

  // Identity: no mapping ⇒ block with a clear error. Never silently re-route.
  const identity = await getUserEmailIdentity(row.senderUserId);
  if (!identity || !identity.active) {
    await updateOutboundEmail(row.id, {
      status: "blocked_no_mailbox",
      errorCode: "no_mailbox_mapping",
      errorMessage:
        "Sender has no active Front mailbox mapping. Map their own-mailbox channel under Admin → Outbound Email → Mailboxes.",
    });
    return;
  }

  // Daily cap — Front path consumption for today's UTC window.
  const capWindowDay = utcDayOf(now);
  const cap = identity.dailyCap ?? (await getDefaultDailyCap());
  const used = await countCapWindowSends(row.senderUserId, capWindowDay);

  if (used >= cap) {
    const fallback = await resolveSendgridFallbackDecision();
    if (fallback.usable) {
      await sendViaSendgrid(row, fallback.fromEmail, capWindowDay, job);
      return;
    }
    // Defer to the next UTC window.
    if ((row.deferredCount ?? 0) >= MAX_DEFERRALS) {
      await updateOutboundEmail(row.id, {
        status: "failed",
        errorCode: "deferral_limit",
        errorMessage: `Deferred ${MAX_DEFERRALS} windows without capacity — giving up. Raise the daily cap, enable the fallback, or re-compose.`,
      });
      return;
    }
    const windowStart = nextUtcWindowStart(now);
    await updateOutboundEmail(row.id, {
      status: "deferred",
      scheduledFor: windowStart,
      deferredCount: (row.deferredCount ?? 0) + 1,
    });
    await enqueueJob({
      queueName: OUTBOUND_EMAIL_QUEUE,
      workloadClass: "interactive",
      payload: { sendId: row.id },
      dedupeKey: `outbound_email:${row.id}:w:${utcDayOf(windowStart)}`,
      maxAttempts: 3,
      retryAt: windowStart,
    });
    return;
  }

  await sendViaFrontChannel(row, identity.frontChannelId, capWindowDay, job);
}

/** Test-only: drive the post-gate dispatch with a STALE row snapshot to
 *  exercise the claim ledger's TOCTOU protection (row already sent in the DB
 *  while a concurrent worker still holds a `queued` snapshot). */
export function __test_sendViaFrontChannel(
  row: OutboundEmail,
  frontChannelId: string,
  capWindowDay: string,
  job: WorkQueueJob,
): Promise<void> {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("__test_sendViaFrontChannel is test-only");
  }
  return sendViaFrontChannel(row, frontChannelId, capWindowDay, job);
}

async function sendViaFrontChannel(
  row: OutboundEmail,
  frontChannelId: string,
  capWindowDay: string,
  job: WorkQueueJob,
): Promise<void> {
  const claim = await claimOutboundEmailDispatch({
    id: row.id,
    path: "front_channel",
    frontChannelId,
    capWindowDay,
    staleClaimMs: STALE_CLAIM_MS,
  });
  if (claim.kind === "already_sent") {
    await alertOutboundEmail(
      "workflow.outbound_email.duplicate_send_attempt",
      `outbound_email:dup:${row.id}`,
      `Duplicate send attempt blocked for ${row.toEmail} (send ${row.id}) — the message was already dispatched. The claim ledger stopped a double-send.`,
      { sendId: row.id, toEmail: row.toEmail, path: claim.row.path },
    );
    return;
  }
  if (claim.kind !== "claimed") return; // in-flight or not claimable — never re-send

  // Marketing sends get a working unsubscribe link on BOTH paths.
  let bodyText = row.bodyText;
  let bodyHtml = row.bodyHtml;
  if (row.messageClass === "marketing" && row.unsubscribeToken) {
    const base = await resolvePublicBase();
    const url = buildUnsubscribeUrl(base, row.id, row.unsubscribeToken);
    const withFooter = appendUnsubscribeFooter({ bodyText, bodyHtml, unsubscribeUrl: url });
    bodyText = withFooter.text;
    bodyHtml = withFooter.html;
  }

  const frontModule = await import("./frontIntegration");
  const { FrontSendOutcomeUnknownError, FrontSendRejectedError } = frontModule;
  const sendFrontChannelMessage =
    testSendDeps?.sendFrontChannelMessage ?? frontModule.sendFrontChannelMessage;
  try {
    const result = await sendFrontChannelMessage({
      channelId: frontChannelId,
      to: row.toEmail,
      subject: row.subject,
      bodyText,
      bodyHtml,
      sendId: row.id,
    });
    await updateOutboundEmail(row.id, {
      status: "sent",
      frontMessageId: result.messageUid,
      sentAt: new Date(),
      errorCode: null,
      errorMessage: null,
    });
  } catch (err) {
    if (err instanceof FrontSendOutcomeUnknownError) {
      // Ambiguous — the send MAY have gone out. Terminal-by-policy: alert,
      // never auto-retry (P11).
      await updateOutboundEmail(row.id, {
        status: "unknown",
        errorCode: "outcome_unknown",
        errorMessage: err.message,
      });
      await alertOutboundEmail(
        "workflow.outbound_email.unknown_outcome",
        `outbound_email:unknown:${row.id}`,
        `Outbound email to ${row.toEmail} has an UNKNOWN outcome (send ${row.id}): ${err.message}. It was NOT auto-retried — check the recipient mailbox/Front before re-sending manually.`,
        { sendId: row.id, toEmail: row.toEmail, path: "front_channel" },
      );
      return;
    }
    if (err instanceof FrontSendRejectedError) {
      await updateOutboundEmail(row.id, {
        status: "failed",
        errorCode: `front_${err.status}`,
        errorMessage: err.message,
      });
      return;
    }
    // Definitive pre-send failure (auth, pre-connection, rate-limit
    // exhaustion): the vendor never processed a send. Release the claim and
    // either retry via the queue or fail terminally on the last attempt.
    await handleDefinitivePreSendFailure(row, err, job);
  }
}

async function sendViaSendgrid(
  row: OutboundEmail,
  fromEmail: string,
  capWindowDay: string,
  job: WorkQueueJob,
): Promise<void> {
  const claim = await claimOutboundEmailDispatch({
    id: row.id,
    path: "sendgrid",
    frontChannelId: null,
    capWindowDay,
    staleClaimMs: STALE_CLAIM_MS,
  });
  if (claim.kind === "already_sent") {
    await alertOutboundEmail(
      "workflow.outbound_email.duplicate_send_attempt",
      `outbound_email:dup:${row.id}`,
      `Duplicate send attempt blocked for ${row.toEmail} (send ${row.id}) — the message was already dispatched. The claim ledger stopped a double-send.`,
      { sendId: row.id, toEmail: row.toEmail, path: claim.row.path },
    );
    return;
  }
  if (claim.kind !== "claimed") return;

  // Every SendGrid send carries one-click unsubscribe headers (bulk-sender
  // rules apply the moment SendGrid enters), so ensure a token exists even
  // for transactional overflow.
  let token = row.unsubscribeToken;
  if (!token) {
    token = mintUnsubscribeToken();
    await updateOutboundEmail(row.id, { unsubscribeToken: token });
  }
  const base = await resolvePublicBase();
  const unsubscribeUrl = buildUnsubscribeUrl(base, row.id, token);

  let bodyText = row.bodyText;
  let bodyHtml = row.bodyHtml;
  if (row.messageClass === "marketing") {
    const withFooter = appendUnsubscribeFooter({ bodyText, bodyHtml, unsubscribeUrl });
    bodyText = withFooter.text;
    bodyHtml = withFooter.html;
  }

  const sendMarketingEmail =
    testSendDeps?.sendMarketingEmail ?? (await import("./mailer")).sendMarketingEmail;
  const result = await sendMarketingEmail({
    to: row.toEmail,
    fromEmail,
    subject: row.subject,
    text: bodyText,
    html: bodyHtml,
    unsubscribeUrl,
    sendId: row.id,
  });

  if (result.ok) {
    await updateOutboundEmail(row.id, {
      status: "sent",
      sendgridMessageId: result.sendgridMessageId,
      sentAt: new Date(),
      errorCode: null,
      errorMessage: null,
    });
    return;
  }
  if (result.reason === "unknown_outcome") {
    await updateOutboundEmail(row.id, {
      status: "unknown",
      errorCode: "outcome_unknown",
      errorMessage: result.message ?? "SendGrid outcome unknown",
    });
    await alertOutboundEmail(
      "workflow.outbound_email.unknown_outcome",
      `outbound_email:unknown:${row.id}`,
      `Outbound email to ${row.toEmail} has an UNKNOWN outcome (send ${row.id}, SendGrid path): ${result.message ?? "no detail"}. It was NOT auto-retried.`,
      { sendId: row.id, toEmail: row.toEmail, path: "sendgrid" },
    );
    return;
  }
  if (result.reason === "not_attempted") {
    await handleDefinitivePreSendFailure(row, new Error(`SendGrid unreachable (${result.message ?? "network"})`), job);
    return;
  }
  // rejected / missing_config — definitive, terminal.
  await updateOutboundEmail(row.id, {
    status: "failed",
    errorCode: result.reason === "missing_config" ? "sendgrid_missing_config" : `sendgrid_${result.status ?? "rejected"}`,
    errorMessage: result.message ?? result.reason,
  });
}

/**
 * A definitive pre-send failure after a claim was taken: the vendor provably
 * did not process a send. Release the row back to `queued` (clearing the
 * claim) and rethrow so the queue's bounded retry re-attempts — unless this
 * was the job's final attempt, in which case fail terminally so the row
 * never sticks in limbo.
 */
async function handleDefinitivePreSendFailure(row: OutboundEmail, err: unknown, job: WorkQueueJob): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  const isFinalAttempt = (job.attemptCount ?? 0) + 1 >= (job.maxAttempts ?? 3);
  if (isFinalAttempt) {
    await updateOutboundEmail(row.id, {
      status: "failed",
      errorCode: "transport_failed",
      errorMessage: message,
    });
    return;
  }
  await updateOutboundEmail(row.id, {
    status: "queued",
    dispatchClaimToken: null,
    dispatchClaimedAt: null,
    errorCode: null,
    errorMessage: null,
  });
  throw err instanceof Error ? err : new Error(message);
}

// ── SendGrid event webhook ingestion ─────────────────────────────────────────

/** Event types that feed the suppression list. */
const SUPPRESSING_EVENTS: Record<string, { reason: "bounce" | "complaint" | "unsubscribe" }> = {
  bounce: { reason: "bounce" },
  dropped: { reason: "bounce" },
  spamreport: { reason: "complaint" },
  unsubscribe: { reason: "unsubscribe" },
  group_unsubscribe: { reason: "unsubscribe" },
};

export interface SendgridEventSummary {
  processed: number;
  suppressed: number;
  correlated: number;
}

/**
 * Apply verified SendGrid events: bounce/complaint/unsubscribe feed the
 * suppression list within this processing cycle; delivery-state events
 * annotate the correlated send-log row (custom_args.send_id first,
 * sg_message_id as fallback).
 */
export async function applySendgridEvents(events: any[]): Promise<SendgridEventSummary> {
  const summary: SendgridEventSummary = { processed: 0, suppressed: 0, correlated: 0 };
  for (const ev of Array.isArray(events) ? events : []) {
    if (!ev || typeof ev !== "object") continue;
    summary.processed++;
    const eventType = typeof ev.event === "string" ? ev.event : "";
    const email = typeof ev.email === "string" ? ev.email : "";

    if (email && SUPPRESSING_EVENTS[eventType]) {
      await addEmailSuppressionWithSideEffects({
        email,
        reason: SUPPRESSING_EVENTS[eventType].reason,
        source: "sendgrid_event",
        notes: ev.reason ? String(ev.reason).slice(0, 500) : undefined,
        cancelNote: `SendGrid ${eventType} event`,
      });
      summary.suppressed++;
    }

    // Correlate back to the send-log row.
    const sendId = typeof ev.send_id === "string" ? ev.send_id : undefined;
    let row = sendId ? await getOutboundEmail(sendId) : undefined;
    if (!row && typeof ev.sg_message_id === "string" && ev.sg_message_id) {
      const { findOutboundEmailBySendgridMessageId } = await import("../storage/outboundEmailStorage");
      // SendGrid appends routing suffixes to sg_message_id; the stored
      // X-Message-Id is its prefix.
      const bareId = ev.sg_message_id.split(".")[0];
      row = await findOutboundEmailBySendgridMessageId(bareId);
    }
    if (row) {
      const deliveryStatus = ["delivered", "bounce", "dropped", "spamreport", "unsubscribe", "deferred", "open"].includes(eventType)
        ? eventType
        : null;
      if (deliveryStatus && deliveryStatus !== "open") {
        await updateOutboundEmail(row.id, { deliveryStatus });
        summary.correlated++;
      }
    }
  }
  return summary;
}
