// @db-pool-intent: mixed
  //
  // Task #1721 Phase 2.1 / Task #1723: this file calls `getDb()`. The
  // intent above declares which pool every `getDb()` call in this
  // module is expected to land on. See `scripts/lint-db-pool-tenancy.ts`
  // for the contract and `server/db.ts` for the routing.

  import { db, getDb } from "../db";
import { getPublicBaseUrl } from "./publicUrl";
import { systemSettings, users } from "@shared/schema";
import { eq } from "drizzle-orm";
import * as twilioStorage from "../storage/twilioStorage";
import * as communicationOps from "../storage/communicationStorage";
import { describeTwilioError } from "./twilioErrors";
import { createHash } from "crypto";

// Task #859: re-export so existing call sites can keep importing from
// `./twilioService`. The implementation lives in `./twilioErrors` so it
// can be unit-tested without bootstrapping the DB module.
export { describeTwilioError };

// Task #3896 (audit B-004): bounded 429-only retry, delegated to the Twilio
// SDK's official mechanism. twilio@5.13.1's RequestClient installs a
// response interceptor (only when `autoRetry` is set) that retries ONLY
// `res.status === 429`, with full-jitter exponential backoff
// (`floor(min(maxRetryDelay, 100·2^attempt) · random())`). Network errors and
// timeouts are promise REJECTIONS that bypass the fulfilled-path interceptor,
// so they are never auto-retried — verified against
// node_modules/twilio/lib/base/RequestClient.js.
//
// Retry-layer inventory (must stay exactly ONE automatic 429 layer):
//   - SDK RequestClient interceptor: THIS one. Max HTTP attempts per create
//     = 1 + TWILIO_HTTP_MAX_429_RETRIES = 4; worst-case added delay
//     < 0.2 + 0.4 + 0.8 s ≈ 1.4 s (jitter can only shorten it).
//   - twilioService: none (no loops around client calls).
//   - routes: none.
//   - client (ConversationHub via client/src/lib/sendRetry.ts): re-POSTs are
//     NEW logical operations; a server-tagged `[HTTP 429 …]` is classified
//     permanent there precisely so this layer stays the only automatic 429
//     retry.
export const TWILIO_HTTP_MAX_429_RETRIES = 3;
export const TWILIO_HTTP_MAX_RETRY_DELAY_MS = 3000;

// Task #3896 (audit B-003): a dispatch claim older than this is abandoned
// (the claiming process crashed mid-dispatch) and may be re-claimed. Must
// exceed the worst-case in-flight create: 4 HTTP attempts × 30 s SDK default
// request timeout + <1.4 s backoff ≈ 121.4 s. Five minutes leaves a
// comfortable margin without pinning a crashed operation for long enough to
// matter operationally.
export const TWILIO_DISPATCH_STALE_CLAIM_MS = 5 * 60_000;

// Task #3896: typed error for outbound dispatch failures. `message` keeps
// the exact describeTwilioError() wire format for Twilio create failures —
// the client's sendRetry.ts parses that tag out of the route JSON — while
// the structured fields let routes see that the service already persisted an
// auditable operation row for the failure (so they must skip their legacy
// failed-row insert) without string matching.
export class TwilioOutboundOperationError extends Error {
  readonly operationRowId: string;
  readonly operationTable: "twilio_messages" | "twilio_calls";
  readonly operationState: "in_progress" | "failed" | "lost_ownership";
  constructor(
    message: string,
    opts: {
      operationRowId: string;
      operationTable: "twilio_messages" | "twilio_calls";
      operationState: "in_progress" | "failed" | "lost_ownership";
    },
  ) {
    super(message);
    this.name = "TwilioOutboundOperationError";
    this.operationRowId = opts.operationRowId;
    this.operationTable = opts.operationTable;
    this.operationState = opts.operationState;
  }
}

// Task #4648: route-layer seam for the duplicate-in-flight (409) check.
// tests/twilio-api-compliance.test.ts scans server/routes/twilio.ts for
// snake_case Twilio-status typos — canonical call/message statuses are
// hyphenated (e.g. "in-progress"), so a snake_case literal there would
// silently never match a real Twilio status. The internal operation-state
// union above deliberately spells its in-progress member in snake_case,
// which collides with that scan. Routes therefore consult this predicate
// instead of comparing `operationState` to the literal themselves; the
// literal stays here, next to the union that defines it.
export function isInProgressOutboundOperationError(
  error: unknown,
): error is TwilioOutboundOperationError {
  return error instanceof TwilioOutboundOperationError && error.operationState === "in_progress";
}

// Task #3896: log-safe error classification — numeric HTTP status + Twilio
// code only, NEVER Twilio's message text (it can embed the destination
// phone number, e.g. "The 'To' number +1555… is not a valid phone number").
function classifyTwilioErrorForLog(err: unknown): string {
  const anyErr = err as { status?: unknown; code?: unknown } | null;
  const status = typeof anyErr?.status === "number" ? anyErr.status : "none";
  const code = typeof anyErr?.code === "number" ? anyErr.code : "none";
  return `http_${status}_code_${code}`;
}

function extractTwilioErrorCodeString(err: unknown): string | null {
  const anyErr = err as { code?: unknown } | null;
  return typeof anyErr?.code === "number" ? String(anyErr.code) : null;
}

interface TwilioConfig {
  accountSid: string;
  authToken: string;
  phoneNumbers: string[];
  // Task #876: when present (and non-empty), outbound SMS use this
  // Messaging Service SID instead of `from: <phoneNumber>` so Twilio's
  // channel selection can pick RCS for capable handsets and fall back
  // to SMS otherwise. Empty / unset means the legacy single-number
  // send path is used.
  messagingServiceSid?: string;
}

async function getTwilioConfig(): Promise<TwilioConfig | null> {
  // Task #876: route DB reads through `getDb()` so the tx-sandbox tests can
  // seed config inside a rolled-back transaction. The static `db` export
  // is fine in production (it points at the same pool) but does not
  // participate in the test sandbox's AsyncLocalStorage redirection.
  const dbi = getDb();
  const [sidSetting] = await dbi.select().from(systemSettings).where(eq(systemSettings.key, "twilio_account_sid"));
  const [tokenSetting] = await dbi.select().from(systemSettings).where(eq(systemSettings.key, "twilio_auth_token"));
  const [phonesSetting] = await dbi.select().from(systemSettings).where(eq(systemSettings.key, "twilio_phone_numbers"));
  // Task #876: optional Messaging Service SID. Stored alongside the
  // existing per-number config so a missing row simply keeps the
  // legacy `from: phoneNumber` behavior.
  const [msgServiceSetting] = await dbi
    .select()
    .from(systemSettings)
    .where(eq(systemSettings.key, "twilio_messaging_service_sid"));

  if (!sidSetting?.value || !tokenSetting?.value) return null;

  let phoneNumbers: string[] = [];
  try {
    phoneNumbers = phonesSetting?.value ? JSON.parse(phonesSetting.value) : [];
  } catch { phoneNumbers = []; }

  return {
    accountSid: sidSetting.value,
    authToken: tokenSetting.value,
    phoneNumbers,
    messagingServiceSid: msgServiceSetting?.value?.trim() || undefined,
  };
}

// Task #874: extra config rows needed to mint Voice access tokens for the
// browser SDK (Twilio API Key + TwiML App). These live alongside the existing
// account-level credentials in `system_settings`. Returns null if any of the
// three values is missing so callers can surface a clear 503 instead of
// silently failing inside the Twilio SDK.
export interface BrowserCallingConfig {
  apiKeySid: string;
  apiKeySecret: string;
  twimlAppSid: string;
}

export async function getBrowserCallingConfig(): Promise<BrowserCallingConfig | null> {
  // Mirror getTwilioConfig — route reads through getDb() so the
  // tx-sandbox tests can seed config inside a rolled-back transaction.
  const dbi = getDb();
  const [keySid] = await dbi.select().from(systemSettings).where(eq(systemSettings.key, "twilio_api_key_sid"));
  const [keySecret] = await dbi.select().from(systemSettings).where(eq(systemSettings.key, "twilio_api_key_secret"));
  const [appSid] = await dbi.select().from(systemSettings).where(eq(systemSettings.key, "twilio_twiml_app_sid"));
  if (!keySid?.value || !keySecret?.value || !appSid?.value) return null;
  return {
    apiKeySid: keySid.value,
    apiKeySecret: keySecret.value,
    twimlAppSid: appSid.value,
  };
}

// Task #876: test-only injection point so tests can intercept the
// Twilio SDK constructor without monkey-patching the (frozen) ESM
// module wrapper. Production code never calls this. The factory
// receives the resolved config and must return an object that quacks
// like `twilio()` — at minimum, `messages.create({...})`.
let testClientFactoryOverride:
  | ((config: TwilioConfig) => unknown | Promise<unknown>)
  | undefined;

export function __setTwilioClientFactoryForTests(
  factory: ((config: TwilioConfig) => unknown | Promise<unknown>) | undefined,
): void {
  testClientFactoryOverride = factory;
}

// Task #3896: exported so tests can assert the REAL client construction
// (autoRetry/maxRetries/maxRetryDelay) without any HTTP traffic — building a
// Twilio client makes no network calls. Production callers keep using the
// higher-level sendSms/initiateForwardCall entry points.
export async function getTwilioClient() {
  const config = await getTwilioConfig();
  if (!config) throw new Error("Twilio is not configured. Set account SID and auth token in admin settings.");
  if (testClientFactoryOverride) {
    const stub = (await testClientFactoryOverride(config)) as Awaited<
      ReturnType<typeof importRealTwilio>
    >;
    return { client: stub, config };
  }
  const real = await importRealTwilio(config);
  return { client: real, config };
}

async function importRealTwilio(config: TwilioConfig) {
  const twilio = await import("twilio");
  // Task #3896 (audit B-004): explicit, bounded 429-only retry — the SDK's
  // official `autoRetry` mechanism. See TWILIO_HTTP_MAX_429_RETRIES above
  // for the retry-layer inventory and attempt math. Every consumer of this
  // shared constructor inherits it (sendSms, initiateForwardCall, and the
  // read-only status/probe fetches, for which a bounded 429 retry is
  // equally safe).
  return twilio.default(config.accountSid, config.authToken, {
    autoRetry: true,
    maxRetries: TWILIO_HTTP_MAX_429_RETRIES,
    maxRetryDelay: TWILIO_HTTP_MAX_RETRY_DELAY_MS,
  });
}

/**
 * Task #876 (+ #875): build the parameters object passed to
 * `client.messages.create` for an outbound SMS.
 *
 * Always includes:
 *   - `body`, `to`
 *   - `statusCallback` + `statusCallbackEvent` (Task #875). Twilio's SMS
 *     API auto-subscribes to status callbacks when `statusCallback` is
 *     set, so `statusCallbackEvent` is informational on the request side
 *     — but we pass it to make our intent explicit at the call site
 *     (queued → sent → delivered, plus failure paths). The Node SDK type
 *     does not declare `statusCallbackEvent` for messages, so the cast
 *     happens at the call site.
 *
 * Sender selection (Task #876):
 *   - When `messagingServiceSid` is non-empty, route through the Messaging
 *     Service SID (`messagingServiceSid: <MG…>`) so Twilio's channel
 *     selection picks RCS for capable handsets and SMS otherwise. The
 *     sender is chosen from the service's Sender Pool by Twilio.
 *   - Otherwise, fall back to the legacy single-number path
 *     (`from: <phoneNumber>`). This preserves behavior for installations
 *     that haven't completed RCS setup.
 *
 * Inbound thread matching is unaffected by which branch we take — replies
 * always come back as SMS to the real Twilio phone number, so
 * `handleInboundSms` + the conversation-thread lookup match on the
 * From/To phone numbers regardless of the outbound transport.
 *
 * Exported (rather than inlined) so tests can assert the exact params
 * shape under both branches without spinning up the real Twilio SDK.
 */
/**
 * Task #884: pre-save reachability check for the Messaging Service SID.
 *
 * Uses the configured Twilio account credentials to fetch the Messaging
 * Service by SID and inspect its Sender Pool (phone numbers, alpha
 * senders, short codes). This is read-only — it never sends an SMS — so
 * it is safe to call from an admin UI button before persisting the SID.
 *
 * Returns a discriminated-union result:
 *   - `{ ok: true, ... }` when the service exists in this account AND
 *     has at least one sender in its pool.
 *   - `{ ok: false, reason, message }` otherwise. `reason` lets the UI
 *     render a specific message instead of dumping a raw Twilio error.
 *
 * Reasons:
 *   - `credentials_missing` — `twilio_account_sid` / `twilio_auth_token`
 *     are not configured yet, so we can't even attempt the lookup.
 *   - `not_found` — Twilio returned 404 (or error code 20404). The SID
 *     is syntactically valid but does not exist under this account.
 *   - `auth_failed` — Twilio rejected the account credentials.
 *   - `no_senders` — service exists but its Sender Pool is empty, so an
 *     outbound SMS would fail at send time.
 *   - `unknown` — anything else; `message` carries `describeTwilioError`.
 */
export type MessagingServiceTestResult =
  | {
      ok: true;
      friendlyName: string | null;
      senderCount: number;
      breakdown: { phoneNumbers: number; alphaSenders: number; shortCodes: number };
    }
  | {
      ok: false;
      reason: "credentials_missing" | "not_found" | "auth_failed" | "no_senders" | "unknown";
      message: string;
    };

export async function fetchMessagingServiceStatus(
  messagingServiceSid: string,
): Promise<MessagingServiceTestResult> {
  const config = await getTwilioConfig();
  if (!config) {
    return {
      ok: false,
      reason: "credentials_missing",
      message: "Twilio account credentials are not configured. Save the Account SID and Auth Token first.",
    };
  }

  let client: any;
  try {
    client = testClientFactoryOverride
      ? await testClientFactoryOverride(config)
      : await importRealTwilio(config);
  } catch (err: unknown) {
    return { ok: false, reason: "unknown", message: describeTwilioError(err) };
  }

  try {
    const svc = await client.messaging.v1.services(messagingServiceSid).fetch();
    const [phoneNumbers, alphaSenders, shortCodes] = await Promise.all([
      client.messaging.v1.services(messagingServiceSid).phoneNumbers.list({ limit: 1000 }),
      client.messaging.v1.services(messagingServiceSid).alphaSenders.list({ limit: 1000 }),
      client.messaging.v1.services(messagingServiceSid).shortCodes.list({ limit: 1000 }),
    ]);
    const breakdown = {
      phoneNumbers: Array.isArray(phoneNumbers) ? phoneNumbers.length : 0,
      alphaSenders: Array.isArray(alphaSenders) ? alphaSenders.length : 0,
      shortCodes: Array.isArray(shortCodes) ? shortCodes.length : 0,
    };
    const senderCount = breakdown.phoneNumbers + breakdown.alphaSenders + breakdown.shortCodes;
    if (senderCount === 0) {
      return {
        ok: false,
        reason: "no_senders",
        message: "Messaging Service exists but its Sender Pool is empty. Add a phone number to the service in the Twilio Console.",
      };
    }
    return {
      ok: true,
      friendlyName: (svc as { friendlyName?: string | null })?.friendlyName ?? null,
      senderCount,
      breakdown,
    };
  } catch (err: unknown) {
    const e = err as { status?: number; code?: number; message?: string };
    if (e?.status === 404 || e?.code === 20404) {
      return {
        ok: false,
        reason: "not_found",
        message: "Messaging Service not found in this Twilio account. Double-check the SID and that it belongs to the configured account.",
      };
    }
    if (e?.status === 401 || e?.code === 20003) {
      return {
        ok: false,
        reason: "auth_failed",
        message: "Twilio rejected the configured account credentials. Re-save the Account SID and Auth Token.",
      };
    }
    return { ok: false, reason: "unknown", message: describeTwilioError(err) };
  }
}

/**
 * Task #3406 — cheap authenticated probe for the Integrations Hub badge.
 *
 * Fetches the configured Account resource
 * (`GET /2010-04-01/Accounts/{Sid}.json` via
 * `client.api.v2010.accounts(sid).fetch()` — read-only, never sends an
 * SMS or places a call). Per the Twilio IAM Account docs the response
 * carries `status` ∈ {active, suspended, closed}; auth failures surface
 * as HTTP 401 / error code 20003, an unknown SID as 404 / 20404.
 *
 * Outcome contract (Task #1861):
 *   - `connected` — credentials valid AND account status is `active`.
 *   - `unauthorized` — credentials missing, rejected (401/20003),
 *     account not found (404/20404), or account suspended/closed. These
 *     are authoritative "this configuration cannot work" results.
 *   - `probe_failed` — config read blip, 429, 5xx, or network error.
 *     NOT evidence of a bad credential; the loader preserves the last
 *     known badge.
 */
export type TwilioProbeResult =
  | { outcome: "connected" }
  | { outcome: "unauthorized"; reason: string }
  | { outcome: "probe_failed"; reason: string };

export async function probeTwilioConnection(): Promise<TwilioProbeResult> {
  let config: TwilioConfig | null;
  try {
    config = await getTwilioConfig();
  } catch (err: any) {
    // The settings read itself blipped (degraded DB). This is NOT
    // evidence the credentials are missing — preserve the last badge.
    return {
      outcome: "probe_failed",
      reason: `config_read_failed: ${err?.message ?? "unknown"}`.slice(0, 120),
    };
  }
  if (!config) {
    return { outcome: "unauthorized", reason: "credentials_missing" };
  }

  let client: any;
  try {
    client = testClientFactoryOverride
      ? await testClientFactoryOverride(config)
      : await importRealTwilio(config);
  } catch (err: any) {
    return {
      outcome: "probe_failed",
      reason: `client_init_failed: ${err?.message ?? "unknown"}`.slice(0, 120),
    };
  }

  try {
    const account = await client.api.v2010.accounts(config.accountSid).fetch();
    const status: string | undefined = (account as { status?: string })?.status;
    if (status && status !== "active") {
      // suspended / closed — the credential authenticates but the
      // account cannot send/receive, so the badge must go red with the
      // specific reason.
      return { outcome: "unauthorized", reason: `account_${status}` };
    }
    return { outcome: "connected" };
  } catch (err: any) {
    const e = err as { status?: number; code?: number; message?: string };
    if (e?.status === 401 || e?.code === 20003) {
      return { outcome: "unauthorized", reason: "auth_failed" };
    }
    if (e?.status === 404 || e?.code === 20404) {
      return { outcome: "unauthorized", reason: "account_not_found" };
    }
    if (e?.status === 429) {
      return { outcome: "probe_failed", reason: "rate_limited" };
    }
    if (typeof e?.status === "number" && e.status >= 500) {
      return { outcome: "probe_failed", reason: `http_${e.status}` };
    }
    return {
      outcome: "probe_failed",
      reason: (e?.message || "probe_threw").slice(0, 120),
    };
  }
}

export function buildOutboundSmsCreateParams(params: {
  to: string;
  body: string;
  fromNumber: string;
  messagingServiceSid?: string;
  baseUrl: string;
}): Record<string, unknown> {
  const baseParams: Record<string, unknown> = {
    body: params.body,
    to: params.to,
    statusCallback: `${params.baseUrl}/api/twilio/webhooks/sms-status`,
    statusCallbackEvent: ["sent", "delivered", "failed", "undelivered"],
  };
  if (params.messagingServiceSid && params.messagingServiceSid.trim().length > 0) {
    return { ...baseParams, messagingServiceSid: params.messagingServiceSid.trim() };
  }
  return { ...baseParams, from: params.fromNumber };
}

// Task #3896 (audit B-003): derive the durable operation row id for a
// route-submitted outbound operation from the client-supplied idempotency
// key. The client mints ONE `clientOperationId` (UUID) per logical send and
// reuses it across its automatic network retries, so a re-POST of the same
// submission derives the same row id and the claim state machine
// (`claimOutboundSmsOperation` / `claimOutboundCallOperation`) guarantees at
// most one Twilio create.
//
// The id is a server-side SHA-256 over (userId, routeTag, clientKey,
// recipient, scopeId) — NOT the raw client key — so:
//   - a client can never inject an arbitrary/foreign row id (forcing a
//     collision with another user's row would require a preimage attack);
//   - the same key fans out to independent per-recipient operations in the
//     multi-participant send paths (recipient is part of the identity);
//   - two users coincidentally minting the same UUID stay isolated.
// The digest is formatted as a canonical-shape UUID (version nibble pinned
// to 8 = "hashed", RFC-4122 variant bits) so derived ids are disjoint from
// `gen_random_uuid()`/`randomUUID()` v4 ids and look like every other row id.
export function deriveOutboundOperationId(parts: {
  userId: string;
  routeTag: "conv-msg" | "conversations-create" | "send-sms" | "initiate-call";
  clientKey: string;
  recipient: string;
  scopeId?: string;
}): string {
  const canonical = [
    parts.userId,
    parts.routeTag,
    parts.clientKey,
    parts.recipient,
    parts.scopeId ?? "",
  ].join("\u0000");
  const hex = createHash("sha256").update(canonical).digest("hex");
  const variantNibble = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}` +
    `-${variantNibble}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
  );
}

export async function sendSms(params: {
  to: string;
  body: string;
  userId: string;
  conversationId?: string;
  // Task #3896 (audit B-003): optional durable operation identity. When
  // supplied it is used as the `twilio_messages` row id, and repeated calls
  // with the same id can never create a second Twilio message (stored-SID
  // short-circuit / in-flight rejection / stale-claim recovery — see
  // `claimOutboundSmsOperation`). The HTTP routes derive it via
  // `deriveOutboundOperationId` whenever the client supplies a
  // `clientOperationId`; when omitted, each call mints a fresh row = a fresh
  // logical operation, exactly the pre-#3896 contract.
  operationId?: string;
}): Promise<{ messageId: string; twilioSid: string; conversationId: string; status: string }> {
  const { client, config } = await getTwilioClient();
  const fromNumber = config.phoneNumbers[0];
  if (!fromNumber) throw new Error("No Twilio phone numbers configured");

  // Task #875: ask Twilio to POST delivery-status updates to our
  // webhook so the thread view can move the badge from
  // queued → sent → delivered (or → failed/undelivered) in real time.
  // We use the same base-URL derivation as the outbound voice call
  // (`initiateCall` above) so dev (Replit dev domain) and production
  // both work without code changes.
  const baseUrl = getPublicBaseUrl({ allowLocalhostFallback: true });

  // Task #883: capture the actual transport used so we can persist it
  // onto the `twilio_messages` row. Mutually exclusive with `fromNumber`
  // as a "real sender" indicator — see the schema comment on
  // `messaging_service_sid` for the full contract.
  const sentViaMessagingServiceSid =
    config.messagingServiceSid && config.messagingServiceSid.trim().length > 0
      ? config.messagingServiceSid.trim()
      : null;

  // Task #3896 (B-003): resolve the conversation BEFORE the Twilio create so
  // the pre-create operation row can satisfy its conversation_id FK. This
  // block used to run after the create; the only visible difference is that
  // a Twilio-rejected send to a brand-new number now leaves behind the
  // conversation shell plus an auditable failed message row, where it used
  // to leave nothing at all.
  let conversationId = params.conversationId;
  if (!conversationId) {
    let conv = await twilioStorage.getTwilioConversationByPhone(params.to, fromNumber);
    if (!conv) {
      const match = await twilioStorage.findClientByPhone(params.to);
      conv = await twilioStorage.createTwilioConversation({
        contactPhone: params.to,
        twilioPhoneNumber: fromNumber,
        clientId: match?.clientId || null,
        clientContactId: match?.contactId || null,
        contactName: match?.contactName || null,
        status: "active",
        lastMessageAt: new Date(),
        lastMessagePreview: params.body.substring(0, 100),
        unreadCount: 0,
      });
    }
    conversationId = conv.id;
  }

  // Task #3896 (B-003): claim the durable operation row BEFORE calling
  // Twilio. The row id is the operation identity; the claim token gives this
  // invocation exclusive dispatch ownership. See TWILIO.md "Outbound
  // dispatch reliability" for the full state machine.
  const claim = await twilioStorage.claimOutboundSmsOperation({
    operationId: params.operationId,
    staleClaimMs: TWILIO_DISPATCH_STALE_CLAIM_MS,
    data: {
      conversationId,
      fromNumber,
      toNumber: params.to,
      body: params.body,
      messagingServiceSid: sentViaMessagingServiceSid,
      sentByUserId: params.userId,
    },
  });
  if (claim.kind === "already_sent") {
    // Stored-SID short-circuit: this operation already produced a Twilio
    // message in an earlier invocation. Return the persisted result — never
    // create a second Twilio resource, never touch the row (its delivery
    // status may already have advanced past the initial state).
    console.log(
      `[Twilio][dispatch] op=${claim.row.id} table=twilio_messages outcome=already_sent status=${claim.row.status}`,
    );
    return {
      messageId: claim.row.id,
      twilioSid: claim.row.twilioSid as string,
      conversationId: claim.row.conversationId,
      status: claim.row.status,
    };
  }
  if (claim.kind === "in_progress") {
    console.log(
      `[Twilio][dispatch] op=${claim.row.id} table=twilio_messages outcome=rejected_in_progress`,
    );
    throw new TwilioOutboundOperationError(
      `Twilio send operation ${claim.row.id} is already in progress`,
      {
        operationRowId: claim.row.id,
        operationTable: "twilio_messages",
        operationState: "in_progress",
      },
    );
  }
  const opRow = claim.row;
  const claimToken = claim.claimToken;
  console.log(
    `[Twilio][dispatch] op=${opRow.id} table=twilio_messages outcome=claimed mode=${claim.mode}`,
  );

  let message;
  try {
    const createParams = buildOutboundSmsCreateParams({
      to: params.to,
      body: params.body,
      fromNumber,
      messagingServiceSid: config.messagingServiceSid,
      baseUrl,
    }) as unknown as Parameters<typeof client.messages.create>[0];
    message = await client.messages.create(createParams);
  } catch (err: unknown) {
    // Task #859 (+#3896): preserve the exact describeTwilioError wire format
    // (client/src/lib/sendRetry.ts parses it out of the route JSON) while
    // recording an explicit, investigable failure state on the operation
    // row. NO automatic re-dispatch happens for ANY failure class here —
    // for ambiguous outcomes (timeout / connection reset) the Twilio-side
    // result is unknown and only a fresh HUMAN retry may re-dispatch, which
    // can duplicate the message at Twilio (inherent without a provider-side
    // idempotency mechanism — documented in TWILIO.md).
    const description = describeTwilioError(err);
    console.error(
      `[Twilio][dispatch] op=${opRow.id} table=twilio_messages outcome=create_failed err=${classifyTwilioErrorForLog(err)}`,
    );
    try {
      await twilioStorage.failClaimedSmsOperation(opRow.id, claimToken, {
        errorMessage: description,
        errorCode: extractTwilioErrorCodeString(err),
      });
    } catch (persistErr: unknown) {
      console.error(
        `[Twilio][dispatch] op=${opRow.id} failed-state persistence error:`,
        persistErr instanceof Error ? persistErr.message : persistErr,
      );
    }
    // Task #4336 — error 21610 means the recipient is on Twilio's opt-out
    // block list for our number (a STOP we may have missed, e.g. while the
    // webhook was down). Reconcile the consent ledger so the automated-send
    // gate blocks this number going forward. Best-effort — the original
    // send failure below is the caller-visible outcome either way.
    if (extractTwilioErrorCodeString(err) === "21610") {
      try {
        const { recordTwilioBlockOptOut } = await import("./smsConsent");
        await recordTwilioBlockOptOut({
          phone: params.to,
          operationId: opRow.id,
          detail: `op=${opRow.id} create rejected: ${description}`.slice(0, 300),
        });
      } catch (consentErr: unknown) {
        console.error(
          `[Twilio][dispatch] 21610 consent reconciliation failed:`,
          consentErr instanceof Error ? consentErr.message : consentErr,
        );
      }
    }
    throw new TwilioOutboundOperationError(description, {
      operationRowId: opRow.id,
      operationTable: "twilio_messages",
      operationState: "failed",
    });
  }

  // Task #875 (+#3896): store whatever Twilio returns instead of hard-coding
  // "sent". The very first response from `messages.create` is typically
  // `queued` or `accepted`; the thread view will move it through
  // sent → delivered (or failed/undelivered) as the status-callback
  // webhook fires. Using `String(...)` because the SDK type allows the
  // status enum to be undefined in edge cases — defaulting to "queued"
  // mirrors Twilio's own initial state.
  const initialStatus = String(message.status || "queued");

  // Task #3896 (B-003): ownership-checked finalize — persists the SID onto
  // the operation row and releases the claim. Status callbacks map to the
  // same row by SID from this point on, exactly as before. If we lost the
  // claim mid-flight (a stale-claim recovery re-claimed the row), we must
  // NOT write the SID with a dead token; report the row's current state
  // instead.
  const finalized = await twilioStorage.finalizeClaimedSmsOperation(opRow.id, claimToken, {
    twilioSid: message.sid,
    status: initialStatus,
  });
  if (!finalized) {
    const current = await twilioStorage.getTwilioMessage(opRow.id);
    if (current?.twilioSid) {
      console.warn(
        `[Twilio][dispatch] op=${opRow.id} table=twilio_messages outcome=lost_ownership_settled`,
      );
      return {
        messageId: current.id,
        twilioSid: current.twilioSid,
        conversationId: current.conversationId,
        status: current.status,
      };
    }
    console.error(
      `[Twilio][dispatch] op=${opRow.id} table=twilio_messages outcome=lost_ownership_unsettled`,
    );
    throw new TwilioOutboundOperationError(
      `Twilio send operation ${opRow.id} lost dispatch ownership after the Twilio create; the operation row needs manual review`,
      {
        operationRowId: opRow.id,
        operationTable: "twilio_messages",
        operationState: "lost_ownership",
      },
    );
  }
  console.log(
    `[Twilio][dispatch] op=${opRow.id} table=twilio_messages outcome=finalized`,
  );

  await twilioStorage.updateTwilioConversation(conversationId, {
    lastMessageAt: new Date(),
    lastMessagePreview: params.body.substring(0, 100),
  });

  const conv = await twilioStorage.getTwilioConversation(conversationId);

  const commRecord = await communicationOps.createRawCommunication({
    clientId: conv?.clientId || undefined,
    sourceType: "twilio_sms",
    title: `SMS to ${params.to}`,
    timestamp: new Date(),
    direction: "outbound",
    contentText: params.body,
    contentPreview: params.body.substring(0, 200),
    externalSourceId: message.sid,
    processingStatus: "processed",
    reviewStatus: "no_updates_needed",
  });
  // Post-#3896 the message row exists before the comm record, so the link is
  // an update by SID rather than part of the insert.
  await twilioStorage.linkMessageRawCommunication(message.sid, commRecord.id);

  // Task #1703 — Per-user inbox: notify teammates who have previously
  // engaged with this thread (prior note authors / past or current
  // assignees) that a colleague replied. Best-effort; failures here
  // must never block the outbound send.
  try {
    const threadKey = conv?.directThreadKey ?? conversationId;
    const { getThreadParticipants, excludeActor } = await import(
      "./notifications/recipients"
    );
    const { notifyUser } = await import("./notifications/userInbox");
    const recipients = excludeActor(
      await getThreadParticipants(threadKey),
      params.userId,
    );
    if (recipients.length > 0) {
      const [actor] = await getDb()
        .select({ firstName: users.firstName, lastName: users.lastName, email: users.email })
        .from(users)
        .where(eq(users.id, params.userId))
        .limit(1);
      const actorLabel =
        [actor?.firstName, actor?.lastName].filter(Boolean).join(" ").trim() ||
        actor?.email ||
        "A teammate";
      const preview = params.body.length > 140
        ? params.body.slice(0, 137) + "..."
        : params.body;
      // Per-thread / per-author / per-hour dedupe so a chatty thread
      // can't flood the bell. Sliding hour bucket keyed off send time.
      const hourBucket = Math.floor(Date.now() / (60 * 60 * 1000));
      for (const uid of recipients) {
        await notifyUser(uid, {
          category: "mention",
          title: `${actorLabel} replied to a thread you're watching`,
          body: preview,
          deepLink: `/conversation-hub?threadKey=${encodeURIComponent(threadKey)}`,
          dedupeKey: `thread-reply:${threadKey}:${params.userId}:${hourBucket}:${uid}`,
          metadata: {
            threadKey,
            conversationId,
            messageSid: message.sid,
            actorUserId: params.userId,
            replyKind: "sms",
          },
        });
      }
    }
  } catch (err: any) {
    console.warn(
      "[Twilio] outbound SMS thread-participant notifyUser fan-out failed:",
      err?.message ?? err,
    );
  }

  return { messageId: opRow.id, twilioSid: message.sid, conversationId, status: initialStatus };
}

// Task #874 (+ #944B): shared helper so the outbound bridge TwiML and the
// call-status webhook reconstruct the same public base URL the rest of the
// integration uses. Centralized so a future move off REPLIT_DEV_DOMAIN only
// touches one place.
//
// Resolution order (most-specific first):
//   1. REPLIT_DOMAINS (production deployment hostname[s], comma-separated).
//      This is the canonical Twilio-reachable URL once the app is published.
//   2. REPLIT_DEV_DOMAIN (workspace dev URL — Twilio can reach this when the
//      workspace is awake; used during development).
//   3. REPL_SLUG / REPL_OWNER (legacy `*.repl.co`). Only used when the two
//      above are missing — Twilio cannot always reach this in current Replit
//      deployments, so we treat it as best-effort.
//
// If none of the above resolve to a public hostname, throw loudly instead of
// silently returning `localhost:5000` — Twilio cannot reach localhost, and a
// silent `localhost` callback URL is exactly what makes the recipient hear
// the default "an application error has occurred" prompt.
export function resolveBaseUrl(): string {
  // Task #864: thin wrapper that delegates to the shared helper. Kept as a
  // named export so existing call sites (`server/routes/twilio.ts`) continue
  // to import `resolveBaseUrl` from this module without churn.
  return getPublicBaseUrl();
}

// Task #874: "forward to my phone" mode. Places a call to the user's
// `callRoutingPhone` first; on pickup, Twilio fetches
// `/voice-twiml-forward-bridge` which returns valid <Dial> TwiML that bridges
// to the destination with the configured Twilio number as caller ID. Validates
// `routingPhone` is present BEFORE calling Twilio so a missing config is a
// clean pre-call 400 instead of a mid-call "an error has occurred" prompt.
//
// `browser` mode is NOT routed through this function — the browser SDK calls
// `Device.connect({ params: { To } })` which triggers the
// `voice-twiml-browser` webhook directly. See `initiateForwardCall` below
// vs the browser TwiML handler in `server/routes/twilio.ts`.
export async function initiateForwardCall(params: {
  to: string;
  routingPhone: string;
  userId: string;
  callerIdName?: string;
  // Task #3896 (audit B-003): optional durable operation identity — same
  // contract as `sendSms.operationId`, backed by the `twilio_calls` row id.
  operationId?: string;
}): Promise<{ callId: string; twilioSid: string }> {
  if (!params.routingPhone || !params.routingPhone.trim()) {
    // Belt-and-suspenders — the route validates this too, but assert here
    // so a programmer error never reaches Twilio with an empty `to`.
    throw new Error("Forward-to-phone mode requires a call routing phone");
  }

  const { client, config } = await getTwilioClient();
  const fromNumber = config.phoneNumbers[0];
  if (!fromNumber) throw new Error("No Twilio phone numbers configured");

  const baseUrl = resolveBaseUrl();

  // Encode the destination + caller-ID into the bridge URL so the TwiML
  // webhook (which is signature-validated and otherwise stateless) can
  // produce a complete <Dial> response without another DB lookup.
  const bridgeUrl = new URL(`${baseUrl}/api/twilio/webhooks/voice-twiml-forward-bridge`);
  bridgeUrl.searchParams.set("to", params.to);
  bridgeUrl.searchParams.set("callerId", fromNumber);
  if (params.callerIdName) bridgeUrl.searchParams.set("callerIdName", params.callerIdName);

  // Call-log row attribution: we record the *destination* as the toNumber so
  // the Calls tab and follow-up prompts treat this row identically to a
  // browser-mode call. The first leg dialing the user's cell is bookkeeping.
  // Task #3896: this read-only lookup moved BEFORE the create so the
  // pre-create operation row carries the client attribution.
  const match = await twilioStorage.findClientByPhone(params.to);

  // Task #3896 (B-003): claim the durable operation row BEFORE calling
  // Twilio — same state machine as sendSms (see TWILIO.md "Outbound
  // dispatch reliability").
  const claim = await twilioStorage.claimOutboundCallOperation({
    operationId: params.operationId,
    staleClaimMs: TWILIO_DISPATCH_STALE_CLAIM_MS,
    data: {
      clientId: match?.clientId || null,
      clientContactId: match?.contactId || null,
      fromNumber,
      toNumber: params.to,
      initiatedByUserId: params.userId,
    },
  });
  if (claim.kind === "already_sent") {
    console.log(
      `[Twilio][dispatch] op=${claim.row.id} table=twilio_calls outcome=already_created status=${claim.row.status}`,
    );
    return { callId: claim.row.id, twilioSid: claim.row.twilioSid as string };
  }
  if (claim.kind === "in_progress") {
    console.log(
      `[Twilio][dispatch] op=${claim.row.id} table=twilio_calls outcome=rejected_in_progress`,
    );
    throw new TwilioOutboundOperationError(
      `Twilio call operation ${claim.row.id} is already in progress`,
      {
        operationRowId: claim.row.id,
        operationTable: "twilio_calls",
        operationState: "in_progress",
      },
    );
  }
  const opRow = claim.row;
  const claimToken = claim.claimToken;
  console.log(
    `[Twilio][dispatch] op=${opRow.id} table=twilio_calls outcome=claimed mode=${claim.mode}`,
  );

  let call;
  try {
    call = await client.calls.create({
      from: fromNumber,
      to: params.routingPhone,
      url: bridgeUrl.toString(),
      statusCallback: `${baseUrl}/api/twilio/webhooks/call-status`,
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
    });
  } catch (err: unknown) {
    // Task #859 (+#3896): surface Twilio error code/status/moreInfo while
    // recording an explicit failure state on the operation row. No automatic
    // re-dial for any failure class — see the sendSms catch block for the
    // ambiguous-outcome rationale.
    const description = describeTwilioError(err);
    console.error(
      `[Twilio][dispatch] op=${opRow.id} table=twilio_calls outcome=create_failed err=${classifyTwilioErrorForLog(err)}`,
    );
    try {
      await twilioStorage.failClaimedCallOperation(opRow.id, claimToken);
    } catch (persistErr: unknown) {
      console.error(
        `[Twilio][dispatch] op=${opRow.id} failed-state persistence error:`,
        persistErr instanceof Error ? persistErr.message : persistErr,
      );
    }
    throw new TwilioOutboundOperationError(description, {
      operationRowId: opRow.id,
      operationTable: "twilio_calls",
      operationState: "failed",
    });
  }

  // Task #3896 (B-003): ownership-checked finalize — persists the SID and
  // releases the claim. The call-status webhook keeps mapping to this row by
  // SID exactly as before.
  const finalized = await twilioStorage.finalizeClaimedCallOperation(opRow.id, claimToken, {
    twilioSid: call.sid,
    status: "initiated",
  });
  if (!finalized) {
    const current = await twilioStorage.getTwilioCall(opRow.id);
    if (current?.twilioSid) {
      console.warn(
        `[Twilio][dispatch] op=${opRow.id} table=twilio_calls outcome=lost_ownership_settled`,
      );
      return { callId: current.id, twilioSid: current.twilioSid };
    }
    console.error(
      `[Twilio][dispatch] op=${opRow.id} table=twilio_calls outcome=lost_ownership_unsettled`,
    );
    throw new TwilioOutboundOperationError(
      `Twilio call operation ${opRow.id} lost dispatch ownership after the Twilio create; the operation row needs manual review`,
      {
        operationRowId: opRow.id,
        operationTable: "twilio_calls",
        operationState: "lost_ownership",
      },
    );
  }
  console.log(
    `[Twilio][dispatch] op=${opRow.id} table=twilio_calls outcome=finalized`,
  );

  const commRecord = await communicationOps.createRawCommunication({
    clientId: match?.clientId || undefined,
    sourceType: "twilio_call",
    title: `Outbound call to ${params.to}`,
    timestamp: new Date(),
    direction: "outbound",
    externalSourceId: call.sid,
    processingStatus: "processed",
    reviewStatus: "no_updates_needed",
  });
  // Post-#3896 the call row exists before the comm record, so the link is an
  // update rather than part of the insert.
  await twilioStorage.updateTwilioCall(opRow.id, { rawCommunicationRecordId: commRecord.id });

  return { callId: opRow.id, twilioSid: call.sid };
}

// Task #874: legacy export kept so any internal caller importing the old name
// gets a clear runtime error instead of silently invoking removed code. The
// only call site (POST /api/twilio/initiate-call) was rewritten in this task.
export function initiateCall(): Promise<never> {
  throw new Error(
    "initiateCall() was replaced by initiateForwardCall() / browser SDK in task #874. Update the caller.",
  );
}

// Task #874: persistence helper used by the browser-originated TwiML webhook
// to record the call as soon as Twilio invokes our voice URL. Mirrors the
// shape `initiateForwardCall` writes so the Calls tab + analysis pipeline
// treat both modes identically.
export async function recordBrowserOutboundCall(params: {
  twilioSid: string;
  fromNumber: string;
  toNumber: string;
  userId: string | null;
}): Promise<void> {
  // De-dupe: Twilio retries voice URL fetches; we don't want two log rows.
  const existing = await twilioStorage.getTwilioCallByTwilioSid(params.twilioSid);
  if (existing) return;

  const match = await twilioStorage.findClientByPhone(params.toNumber);
  const commRecord = await communicationOps.createRawCommunication({
    clientId: match?.clientId || undefined,
    sourceType: "twilio_call",
    title: `Outbound call to ${params.toNumber}`,
    timestamp: new Date(),
    direction: "outbound",
    externalSourceId: params.twilioSid,
    processingStatus: "processed",
    reviewStatus: "no_updates_needed",
  });
  await twilioStorage.createTwilioCall({
    clientId: match?.clientId || null,
    clientContactId: match?.contactId || null,
    twilioSid: params.twilioSid,
    direction: "outbound",
    fromNumber: params.fromNumber,
    toNumber: params.toNumber,
    status: "initiated",
    initiatedByUserId: params.userId,
    rawCommunicationRecordId: commRecord.id,
  });
}

export async function handleInboundSms(params: {
  from: string;
  to: string;
  body: string;
  messageSid: string;
  /**
   * Task #4336 — Twilio's `OptOutType` webhook field (START|STOP|HELP),
   * present only when the sending product attaches opt-out metadata. Used
   * as a classification hint; the body keyword remains the primary signal.
   */
  optOutType?: string | null;
}): Promise<void> {
  // Task #849 — fast-path SID dedupe so Twilio webhook retries become a
  // clean no-op without any side effects.
  if (params.messageSid) {
    const { findExistingInboundMessageBySid } = await import("./conversationDedupe");
    const existing = await findExistingInboundMessageBySid(params.messageSid);
    if (existing) {
      console.log(
        `[Twilio] Inbound webhook retry for MessageSid=${params.messageSid} — message already on conv=${existing.conversationId}, skipping`,
      );
      return;
    }
  }

  const match = await twilioStorage.findClientByPhone(params.from);

  let conv = await twilioStorage.getTwilioConversationByPhone(params.from, params.to);
  if (!conv) {
    conv = await twilioStorage.findConversationByParticipantPhone(params.from, params.to);
    // Self-heal: if we matched a legacy direct row whose canonical key was
    // never backfilled, stamp it now so subsequent inbound traffic hits the
    // fast canonical-key path instead of falling back to JSONB scan. This
    // block is strictly best-effort — any failure here must not abort the
    // inbound webhook (Twilio sees 200 OK, so a thrown error would silently
    // drop the message). On a 23505 unique-violation, the canonical sibling
    // already exists; re-bind to it so this inbound message lands on the
    // canonical thread instead of the losing legacy row.
    if (conv && !conv.directThreadKey) {
      try {
        const { buildNormalizedFields, findDirectConversationByKey } = await import(
          "./conversationDedupe"
        );
        const normalized = buildNormalizedFields({
          contactPhone: params.from,
          twilioPhoneNumber: params.to,
          conversationType: conv.conversationType,
        });
        if (normalized.directThreadKey) {
          try {
            const updated = await twilioStorage.updateTwilioConversation(conv.id, normalized);
            if (updated) conv = updated;
            console.log(
              `[Twilio] Self-healed legacy conv=${conv.id} with directThreadKey=${normalized.directThreadKey}`,
            );
          } catch (err: unknown) {
            if (err && typeof err === "object" && (err as { code?: string }).code === "23505") {
              const canonical = await findDirectConversationByKey(normalized.directThreadKey);
              if (canonical) {
                console.log(
                  `[Twilio] Self-heal conflict on conv=${conv.id} — re-binding inbound to canonical conv=${canonical.id}`,
                );
                conv = canonical;
              }
            } else {
              console.error(
                `[Twilio] Self-heal stamp failed for conv=${conv.id} (continuing best-effort):`,
                err,
              );
            }
          }
        }
      } catch (err: unknown) {
        console.error("[Twilio] Self-heal block failed (continuing best-effort):", err);
      }
    }
  }
  let newlyCreated = false;
  if (!conv) {
    const { findOrCreateDirectConversation } = await import("./conversationDedupe");
    const result = await findOrCreateDirectConversation({
      data: {
        contactPhone: params.from,
        twilioPhoneNumber: params.to,
        clientId: match?.clientId || null,
        clientContactId: match?.contactId || null,
        contactName: match?.contactName || null,
        status: "active",
        conversationType: "direct",
        participants: [{
          phone: params.from,
          name: match?.contactName || undefined,
          contactId: match?.contactId || undefined,
        }],
        lastMessageAt: new Date(),
        lastMessagePreview: params.body.substring(0, 100),
        unreadCount: 1,
      },
      preferClientId: match?.clientId || undefined,
    });
    conv = result.conversation;
    newlyCreated = result.created;
  }

  // Insert the message first, keyed by MessageSid. The partial unique
  // index is the source of truth — any concurrent retry that lost the
  // race aborts here without touching conversation state or creating an
  // orphaned raw_communication_records row.
  let messageInserted = false;
  let insertedMessage: Awaited<ReturnType<typeof twilioStorage.createTwilioMessage>> | undefined;
  try {
    insertedMessage = await twilioStorage.createTwilioMessage({
      conversationId: conv.id,
      twilioSid: params.messageSid,
      direction: "inbound",
      fromNumber: params.from,
      toNumber: params.to,
      body: params.body,
      status: "received",
      rawCommunicationRecordId: null,
    });
    messageInserted = true;
  } catch (err: unknown) {
    if (err && typeof err === "object" && (err as { code?: string }).code === "23505") {
      console.log(
        `[Twilio] Inbound webhook race for MessageSid=${params.messageSid} — losing insert, no side effects`,
      );
      // Task #1284 — feed the collision-rate watcher. Best-effort, must
      // not throw (the import is sync because the watcher module is
      // small and side-effect-free at import time).
      try {
        const { recordTwilioSidCollision } = await import(
          "./twilioWebhookCollisionAlerts"
        );
        // Pass the error so the watcher can require the violation be on
        // the `twilio_msg_twilio_sid_uniq` constraint specifically.
        recordTwilioSidCollision(
          params.messageSid,
          err as { code?: string; constraint?: string; message?: string; detail?: string },
        );
      } catch {}
      return;
    }
    throw err;
  }

  if (!messageInserted) return;

  // Task #4336 — consent keyword handling (STOP/START/HELP families). Runs
  // only for messages that WON the SID-dedupe insert (replayed webhook
  // deliveries returned above), so each keyword is recorded at most once;
  // the partial unique index on sms_consent_events.message_sid is the
  // database-level second belt. Best-effort: a consent-ledger failure must
  // never fail the webhook. Note the app NEVER auto-replies here — our
  // toll-free number's Twilio edge handling already sent the STOP/HELP
  // confirmation (see TWILIO.md "SMS consent & opt-out").
  try {
    const { recordInboundConsentKeyword } = await import("./smsConsent");
    const consentOutcome = await recordInboundConsentKeyword({
      fromPhone: params.from,
      body: params.body,
      messageSid: params.messageSid,
      optOutTypeHint: params.optOutType ?? null,
    });
    if (consentOutcome) {
      console.log(
        `[Twilio] Consent keyword ${consentOutcome.match.kind} ("${consentOutcome.match.keyword}") recorded for MessageSid=${params.messageSid}`,
      );
    }
  } catch (consentErr: unknown) {
    console.error(
      `[Twilio] Consent keyword handling failed (inbound message preserved):`,
      consentErr instanceof Error ? consentErr.message : consentErr,
    );
  }

  // Now that we own this message, mutate conversation state and create
  // the raw_communication_records row. If the conversation was newly
  // created, its initial values already reflect this message — skip the
  // counter bump in that case.
  if (!newlyCreated) {
    await twilioStorage.updateTwilioConversation(conv.id, {
      lastMessageAt: new Date(),
      lastMessagePreview: params.body.substring(0, 100),
      unreadCount: (conv.unreadCount || 0) + 1,
    });
  }

  const commRecord = await communicationOps.createRawCommunication({
    clientId: match?.clientId || undefined,
    sourceType: "twilio_sms",
    title: `SMS from ${params.from}`,
    timestamp: new Date(),
    direction: "inbound",
    contentText: params.body,
    contentPreview: params.body.substring(0, 200),
    externalSourceId: params.messageSid,
    matchMethod: match ? "phone_lookup" : undefined,
    matchConfidence: match ? 1.0 : undefined,
    matchStatus: match ? "matched" : "unmatched",
  });

  await twilioStorage.linkMessageRawCommunication(params.messageSid, commRecord.id);

  // Task #853: push the freshly persisted inbound message to any
  // Conversation Hub clients that have an SSE connection open. We
  // broadcast after all DB writes so subscribers see a fully consistent
  // payload (message row + conversation preview/unread bump). Failures
  // here are best-effort — the next 5s poll picks it up if push drops.
  if (insertedMessage) {
    try {
      const { broadcastTwilioEvent } = await import("./twilioEvents");
      const createdAtIso =
        insertedMessage.createdAt instanceof Date
          ? insertedMessage.createdAt.toISOString()
          : new Date(insertedMessage.createdAt as unknown as string).toISOString();
      const updatedAtIso =
        insertedMessage.updatedAt instanceof Date
          ? insertedMessage.updatedAt.toISOString()
          : insertedMessage.updatedAt
            ? new Date(insertedMessage.updatedAt as unknown as string).toISOString()
            : undefined;
      broadcastTwilioEvent({
        type: "message:new",
        conversationId: conv.id,
        message: {
          id: insertedMessage.id,
          conversationId: conv.id,
          twilioSid: insertedMessage.twilioSid ?? null,
          direction: "inbound",
          fromNumber: params.from,
          toNumber: params.to,
          body: params.body,
          status: insertedMessage.status ?? "received",
          errorCode: null,
          errorMessage: null,
          sentByUserId: null,
          createdAt: createdAtIso,
          updatedAt: updatedAtIso,
        },
        conversationPreview: {
          id: conv.id,
          lastMessageAt: createdAtIso,
          lastMessagePreview: params.body.substring(0, 100),
          // Newly-created convs initialised unreadCount=1 above; only
          // bump callers if we incremented an existing conv.
          unreadCountDelta: newlyCreated ? 0 : 1,
        },
      });
    } catch (err: unknown) {
      console.error("[Twilio] Failed to broadcast inbound SMS event:", err);
    }
  }

  if (match) {
    try {
      const { analyzeCommunication } = await import("./communicationAnalysis");
      await analyzeCommunication(commRecord.id);
    } catch (err: any) {
      console.error("[Twilio] Failed to analyze inbound SMS:", err.message);
    }
  }

  // Task #1688 — Per-user inbox: notify the thread assignee + the
  // client's account manager about an inbound SMS. Best-effort.
  try {
    const { getConversationOwners } = await import("./notifications/recipients");
    const { notifyUser } = await import("./notifications/userInbox");
    const recipients = await getConversationOwners({
      threadKey: conv.directThreadKey ?? conv.id,
      clientId: match?.clientId ?? null,
    });
    const preview = params.body.length > 140
      ? params.body.slice(0, 137) + "..."
      : params.body;
    const fromLabel = match?.contactName ? `${match.contactName} (${params.from})` : params.from;
    for (const uid of recipients) {
      await notifyUser(uid, {
        category: "comms.sms",
        title: `New SMS from ${fromLabel}`,
        body: preview,
        deepLink: `/conversation-hub?threadKey=${encodeURIComponent(conv.directThreadKey ?? conv.id)}`,
        dedupeKey: `sms-inbound:${params.messageSid}`,
        metadata: {
          conversationId: conv.id,
          messageSid: params.messageSid,
          clientId: match?.clientId ?? null,
        },
      });
    }
  } catch (err: any) {
    console.warn("[Twilio] inbound SMS notifyUser fan-out failed:", err?.message ?? err);
  }

  // Task #2779 — Slack channel alert (#client-texts by default): post
  // the inbound text to the team channel and @-mention the conversation
  // owners. Best-effort; never blocks the webhook 200.
  try {
    const { getConversationOwners } = await import("./notifications/recipients");
    const { sendClientTextSlackAlert } = await import(
      "./notifications/clientTextSlackAlert"
    );
    const owners = await getConversationOwners({
      threadKey: conv.directThreadKey ?? conv.id,
      clientId: match?.clientId ?? null,
    });
    const preview = params.body.length > 140
      ? params.body.slice(0, 137) + "..."
      : params.body;
    const fromLabel = match?.contactName
      ? `${match.contactName} (${params.from})`
      : params.from;
    await sendClientTextSlackAlert({
      recipientUserIds: owners,
      fromLabel,
      preview,
      clientId: match?.clientId ?? null,
      messageSid: params.messageSid,
      threadKey: conv.directThreadKey ?? conv.id,
    });
  } catch (err: any) {
    console.warn("[Twilio] client-text Slack alert failed:", err?.message ?? err);
  }
}

/**
 * Task #875: handle Twilio's SMS delivery-status callback.
 *
 * Twilio POSTs `MessageSid`, `MessageStatus`, and (on failure paths)
 * `ErrorCode` + `ErrorMessage` whenever a queued SMS transitions
 * through `sent → delivered` (success) or `failed` / `undelivered`
 * (failure). We look up the persisted row by `twilioSid` and write the
 * new status + diagnostic info so the thread view can reflect it.
 *
 * If no matching row is found we silently no-op: the alternative
 * (throwing) would force Twilio to retry forever for messages we never
 * persisted (e.g. a transient DB failure on the original send), which
 * adds nothing useful and floods our logs. We do log a warning so the
 * mismatch is visible.
 */
/**
 * Task #881: fetch the current delivery status of a previously-sent SMS
 * straight from Twilio's REST API. Used by the admin backfill endpoint
 * to normalize history for rows that were sent before the status-callback
 * webhook (Task #875) shipped — those rows are stuck on whatever status
 * was written at send time (typically `sent` or `queued`) because Twilio
 * only fires status callbacks at send-time and never re-delivers them.
 *
 * Returns `null` if Twilio reports the message no longer exists (e.g. it
 * has aged out of the account's retention window) so the caller can mark
 * the row as "unknown" rather than failing the whole backfill batch.
 */

// Minimal structural type for the Twilio MessageInstance fields we read.
// Avoids depending on the SDK's internal type paths and lets the test
// stub return a plain object without satisfying the full SDK type.
interface TwilioMessageFetchResult {
  status?: string | null;
  errorCode?: number | string | null;
  errorMessage?: string | null;
}

interface TwilioRestErrorShape {
  status?: number;
  code?: number;
}

export async function fetchMessageStatus(twilioSid: string): Promise<{
  status: string;
  errorCode: string | null;
  errorMessage: string | null;
} | null> {
  const { client } = await getTwilioClient();
  try {
    // The Twilio SDK exposes `client.messages(sid).fetch()` — the SDK's
    // generated types use a callable interface that TS narrows away when
    // the client is hidden behind our test-injection factory's `unknown`
    // return. Assert the minimal callable shape here so the rest of the
    // function stays fully typed without an `any`.
    const messages = (
      client as { messages: (sid: string) => { fetch: () => Promise<TwilioMessageFetchResult> } }
    ).messages;
    const msg = await messages(twilioSid).fetch();
    return {
      status: String(msg.status ?? ""),
      errorCode: msg.errorCode != null ? String(msg.errorCode) : null,
      errorMessage: msg.errorMessage ?? null,
    };
  } catch (err: unknown) {
    // Twilio returns HTTP 404 with code 20404 for messages that no
    // longer exist. Treat as a "soft miss" so the backfill loop can
    // continue with the next row.
    const e = err as TwilioRestErrorShape;
    if (e?.status === 404 || e?.code === 20404) return null;
    throw new Error(describeTwilioError(err));
  }
}

export async function handleSmsStatus(params: {
  messageSid: string;
  messageStatus: string;
  errorCode?: string;
  errorMessage?: string;
  // Task #883: Twilio includes `MessagingServiceSid` on every status
  // callback for messages routed through a service. We forward it so
  // historical rows (sent before #883 added the column) get backfilled
  // the next time a delivery-status callback fires.
  messagingServiceSid?: string;
}): Promise<void> {
  if (!params.messageSid) return;
  const updated = await twilioStorage.updateTwilioMessageStatusBySid(params.messageSid, {
    status: params.messageStatus,
    errorCode: params.errorCode || null,
    errorMessage: params.errorMessage || null,
    messagingServiceSid: params.messagingServiceSid?.trim() || undefined,
  });
  if (!updated) {
    console.warn(
      `[Twilio] SMS status callback for unknown MessageSid=${params.messageSid} status=${params.messageStatus} — no twilio_messages row, skipping`,
    );
    return;
  }

  // Task #882: push the status change to any Conversation Hub clients
  // viewing this thread so the badge transitions queued → sent →
  // delivered (or failed/undelivered) within ~1s of the Twilio
  // callback, instead of waiting for the next thread-messages poll.
  // Best-effort — if broadcast fails the next poll picks it up.
  try {
    const { broadcastTwilioEvent } = await import("./twilioEvents");
    const toIso = (v: Date | string | null | undefined): string =>
      v instanceof Date
        ? v.toISOString()
        : v
          ? new Date(v).toISOString()
          : new Date().toISOString();
    const updatedAtIso = toIso(updated.updatedAt);
    broadcastTwilioEvent({
      type: "message:status",
      conversationId: updated.conversationId,
      message: {
        id: updated.id,
        conversationId: updated.conversationId,
        twilioSid: updated.twilioSid ?? null,
        status: updated.status ?? params.messageStatus,
        errorCode: updated.errorCode ?? null,
        errorMessage: updated.errorMessage ?? null,
        updatedAt: updatedAtIso,
      },
    });
  } catch (err: unknown) {
    console.error("[Twilio] Failed to broadcast SMS status event:", err);
  }

  // Task #1688 — Per-user inbox: notify the sender if the outbound SMS
  // failed so they see a bell badge without waiting for the thread
  // refresh. Inbound rows don't have a sender; skip them.
  const isFailed =
    params.messageStatus === "failed" || params.messageStatus === "undelivered";
  if (isFailed && updated.direction === "outbound" && updated.sentByUserId) {
    try {
      const { notifyUser } = await import("./notifications/userInbox");
      await notifyUser(updated.sentByUserId, {
        category: "comms.sms",
        title: "SMS failed to deliver",
        body: `To ${updated.toNumber ?? "?"} — ${params.errorMessage ?? params.errorCode ?? params.messageStatus}`,
        deepLink: `/conversation-hub?conversationId=${encodeURIComponent(updated.conversationId)}`,
        dedupeKey: `sms-failed:${params.messageSid}`,
        metadata: {
          messageSid: params.messageSid,
          status: params.messageStatus,
          errorCode: params.errorCode ?? null,
          errorMessage: params.errorMessage ?? null,
        },
      });
    } catch (err: any) {
      console.warn("[Twilio] failed-SMS notifyUser failed:", err?.message ?? err);
    }
  }
}

export async function handleCallStatus(params: {
  callSid: string;
  callStatus: string;
  callDuration?: number;
  from?: string;
  to?: string;
  direction?: string;
}): Promise<void> {
  let call = await twilioStorage.getTwilioCallByTwilioSid(params.callSid);

  if (!call && params.direction === "inbound" && params.from && params.to) {
    const match = await twilioStorage.findClientByPhone(params.from);

    const commRecord = await communicationOps.createRawCommunication({
      clientId: match?.clientId || undefined,
      sourceType: "twilio_call",
      title: `Inbound call from ${params.from}`,
      timestamp: new Date(),
      direction: "inbound",
      externalSourceId: params.callSid,
      matchMethod: match ? "phone_lookup" : undefined,
      matchConfidence: match ? 1.0 : undefined,
      matchStatus: match ? "matched" : "unmatched",
    });

    call = await twilioStorage.createTwilioCall({
      clientId: match?.clientId || null,
      clientContactId: match?.contactId || null,
      twilioSid: params.callSid,
      direction: "inbound",
      fromNumber: params.from,
      toNumber: params.to,
      status: params.callStatus,
      rawCommunicationRecordId: commRecord.id,
    });
  }

  if (call) {
    const updateData: Record<string, string | number | Date> = {};
    const missedStatuses = ["no-answer", "busy", "failed", "canceled"];
    const isInboundMissed = call.direction === "inbound" && missedStatuses.includes(call.status) && !call.answeredAt;
    if (isInboundMissed && params.callStatus === "completed") {
      if (params.callDuration !== undefined) updateData.duration = params.callDuration;
    } else {
      updateData.status = params.callStatus;
      if (params.callDuration !== undefined) updateData.duration = params.callDuration;
    }
    if (Object.keys(updateData).length > 0) {
      await twilioStorage.updateTwilioCall(call.id, updateData);
    }

    if (call.rawCommunicationRecordId && params.callDuration) {
      await communicationOps.updateRawCommunication(call.rawCommunicationRecordId, {
        contentText: `Call duration: ${params.callDuration} seconds`,
        contentPreview: `Call duration: ${params.callDuration}s`,
      });
    }

    // Task #1272: push the live status to the operator's open
    // Conversation Hub tab so the Active Call Bar updates the instant
    // Twilio reports the transition, instead of waiting on a 2s poll
    // of the Twilio REST API. Scoped to the user who placed the call
    // (initiatedByUserId) so other operators don't see cross-talk.
    // Best-effort — if broadcast fails, the call timeline refresh on
    // terminal status still reconciles the UI.
    if (call.initiatedByUserId) {
      try {
        const { broadcastTwilioEvent } = await import("./twilioEvents");
        broadcastTwilioEvent({
          type: "call:status",
          userId: call.initiatedByUserId,
          call: {
            id: call.id,
            twilioSid: call.twilioSid ?? null,
            status: params.callStatus,
            duration:
              params.callDuration !== undefined
                ? params.callDuration
                : null,
            updatedAt: new Date().toISOString(),
          },
        });
      } catch (err: unknown) {
        console.error("[Twilio] Failed to broadcast call status event:", err);
      }
    }

    // Task #1688 — Per-user inbox notifications for call outcomes:
    //   - inbound missed call → notify the routed user / client AM
    //   - outbound failed call → notify the initiator
    try {
      const isInboundMissedFinal =
        call.direction === "inbound" &&
        ["no-answer", "busy", "failed", "canceled"].includes(params.callStatus) &&
        !call.answeredAt;
      const isOutboundFailed =
        call.direction === "outbound" &&
        ["failed", "busy", "no-answer", "canceled"].includes(params.callStatus);
      if (isInboundMissedFinal) {
        const { getRoutedCallUser } = await import("./notifications/recipients");
        const { notifyUser } = await import("./notifications/userInbox");
        const recipients = await getRoutedCallUser({
          callId: call.id,
          callSid: call.twilioSid ?? null,
          clientId: call.clientId ?? null,
        });
        for (const uid of recipients) {
          await notifyUser(uid, {
            category: "comms.call",
            title: `Missed call from ${call.fromNumber ?? "?"}`,
            body: `Status: ${params.callStatus}`,
            deepLink: `/conversation-hub?callId=${encodeURIComponent(call.id)}`,
            dedupeKey: `call-missed:${call.twilioSid ?? call.id}`,
            metadata: {
              callId: call.id,
              callSid: call.twilioSid ?? null,
              from: call.fromNumber ?? null,
              status: params.callStatus,
            },
          });
        }
      } else if (isOutboundFailed && call.initiatedByUserId) {
        const { notifyUser } = await import("./notifications/userInbox");
        await notifyUser(call.initiatedByUserId, {
          category: "comms.call",
          title: "Outbound call failed",
          body: `To ${call.toNumber ?? "?"} — ${params.callStatus}`,
          deepLink: `/conversation-hub?callId=${encodeURIComponent(call.id)}`,
          dedupeKey: `call-failed:${call.twilioSid ?? call.id}`,
          metadata: {
            callId: call.id,
            callSid: call.twilioSid ?? null,
            status: params.callStatus,
          },
        });
      }
    } catch (err: any) {
      console.warn("[Twilio] call notifyUser fan-out failed:", err?.message ?? err);
    }
  }
}

export { getTwilioConfig };
