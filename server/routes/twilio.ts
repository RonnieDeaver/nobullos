// @db-pool-intent: api
// @cross-instance-safe: per-connection SSE heartbeat writing to one client's response; no shared side effect.
  //
  // Task #1721 Phase 2.1 / Task #1723: this file calls `getDb()`. The
  // intent above declares which pool every `getDb()` call in this
  // module is expected to land on. See `scripts/lint-db-pool-tenancy.ts`
  // for the contract and `server/db.ts` for the routing.

  import type { Express, Request, Response, NextFunction } from "express";
import { isAuthenticated } from "../middlewares/requireAuth";
import { getPublicBaseUrl } from "../services/publicUrl";
import { requireTwilioAccess, requireCeo, requireTeamLead, requireAccountManager } from "./middleware";
import * as twilioStorage from "../storage/twilioStorage";
// @periodic-request-pool-exception: the only periodic construct is a no-DB SSE heartbeat ping; every db use in this file serves inbound HTTP requests, which is exactly what the request pool is for (routes file).
import { db, getDb } from "../db";
import { eq, sql, inArray } from "drizzle-orm";
import { users, systemSettings, callArchiveRequeueAudit, twilioConversations, threadReadStates } from "@shared/schema";
import { desc } from "drizzle-orm";
import { z } from "zod";
import { insertActivityLogs } from "../storage/activityStorage";
// Task #855: route every contact-by-phone resolution through the shared
// normalization module so we have one canonical implementation (and one
// indexed lookup helper). Inline normalizePhone has been removed.
import { normalizeToE164 } from "../services/phoneNormalization";
// Task #877: presence tracker for in-browser inbound call routing.
import { isUserBrowserOnline } from "../services/browserPresence";

const normalizePhone = normalizeToE164;

// Task #1273: test seam for the live call-status endpoint. Production code
// constructs the Twilio REST client via `(await import("twilio")).default`,
// which makes a real HTTPS call against api.twilio.com. Tests can override
// the factory to inject a fake client (or throw to simulate REST errors)
// without standing up real Twilio credentials or network traffic. Only the
// GET /api/twilio/calls/:id/status handler consults this seam — every other
// Twilio path still uses the real SDK directly.
type TwilioCallStatusClientFactory = (
  accountSid: string,
  authToken: string,
) => {
  calls(sid: string): {
    fetch(): Promise<{
      status: string;
      duration: string | number | null | undefined;
      startTime: Date | null | undefined;
      endTime: Date | null | undefined;
    }>;
  };
};
let __twilioCallStatusClientFactory: TwilioCallStatusClientFactory | null = null;
export function __test_setTwilioCallStatusClientFactory(
  factory: TwilioCallStatusClientFactory | null,
): void {
  __twilioCallStatusClientFactory = factory;
}

// Task #859 (audit step 5): exported so integration tests can mount this
// directly on a test Express app and exercise the real signature flow
// (token lookup, header handling, proxy URL reconstruction, twilio.validateRequest).
export async function validateTwilioWebhook(req: Request, res: Response, next: NextFunction) {
  try {
    const [tokenSetting] = await getDb().select().from(systemSettings).where(eq(systemSettings.key, "twilio_auth_token"));
    if (!tokenSetting?.value) {
      // Task #859 (audit step 4): in production, refuse to process
      // unsigned webhook traffic. A misconfigured deployment must NOT
      // silently accept arbitrary inbound SMS / call payloads. In dev /
      // test, log loudly and allow through so local iteration works.
      // Twilio webhook security: https://www.twilio.com/docs/usage/webhooks/webhooks-security
      if (process.env.NODE_ENV === "production") {
        console.error(
          "[Twilio Webhook] Refusing webhook: no twilio_auth_token configured in system_settings — cannot verify X-Twilio-Signature in production",
          { path: req.originalUrl },
        );
        return res.status(503).type("text/xml").send("<Response></Response>");
      }
      console.warn("[Twilio Webhook] No auth token configured, skipping signature validation (non-production)");
      (res.locals as Record<string, unknown>).twilioSignatureValid = "skipped";
      return next();
    }

    const twilioSignature = req.headers["x-twilio-signature"] as string;
    if (!twilioSignature) {
      console.warn("[Twilio Webhook] Missing X-Twilio-Signature header");
      return res.status(403).type("text/xml").send("<Response></Response>");
    }

    try {
      // Task #859: typed dynamic import — `twilio` exports both a default
      // function and a namespace containing `validateRequest` (see
      // node_modules/twilio/lib/index.d.ts). The defensive lookup
      // (default-then-namespace) is kept in case of CJS/ESM interop
      // shenanigans, but no `any` casts are needed.
      const twilioMod = await import("twilio");
      const sdk = twilioMod.default ?? twilioMod;
      const validateRequest =
        typeof sdk.validateRequest === "function"
          ? sdk.validateRequest
          : typeof twilioMod.validateRequest === "function"
            ? twilioMod.validateRequest
            : undefined;
      if (!validateRequest) {
        console.error("[Twilio Webhook] validateRequest helper not found on twilio module — refusing webhook for safety");
        return res.status(500).type("text/xml").send("<Response></Response>");
      }
      const protocol = req.headers["x-forwarded-proto"] || "https";
      const host = req.headers["host"] || "";
      const url = `${protocol}://${host}${req.originalUrl}`;
      const isValid = validateRequest(tokenSetting.value, twilioSignature, url, req.body || {});
      if (!isValid) {
        console.warn("[Twilio Webhook] Invalid signature", {
          url,
          path: req.originalUrl,
          hasBody: !!req.body && Object.keys(req.body).length > 0,
        });
        return res.status(403).type("text/xml").send("<Response></Response>");
      }
    } catch (err: any) {
      console.error("[Twilio Webhook] Signature validation error:", err?.message ?? String(err), err?.stack);
      return res.status(500).type("text/xml").send("<Response></Response>");
    }

    (res.locals as Record<string, unknown>).twilioSignatureValid = true;
    next();
  } catch (err: any) {
    console.error("[Twilio Webhook] Middleware error:", err.message);
    res.status(500).type("text/xml").send("<Response></Response>");
  }
}

// Task #944B: friendly fallback TwiML used when *any* failure occurs in the
// browser-outbound voice chain (voice-twiml-browser / voice-whisper). The
// goal is that Twilio never plays its built-in "an application error has
// occurred" prompt: we always return HTTP 200 with valid TwiML that either
// says something useful or falls back to a hangup. Status MUST be 200 — any
// non-2xx triggers Twilio's default error voice.
const FALLBACK_TWIML_BODY = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>The call could not be connected. Please try again.</Say>
  <Hangup/>
</Response>`;

// Task #944B: empty <Response/> used when we want Twilio to skip a step
// without playing the default error voice (e.g. whisper that couldn't load
// the disclosure — better to bridge silently than to fail the call).
const EMPTY_TWIML_BODY = `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`;

// Task #944C: stable failure-category tags so a future on-call can grep
// for `category=` across hops and see the exact reason a fallback fired.
// Add new values when a new failure mode is introduced — never reuse a
// tag for a different meaning. The `category` field is also surfaced on
// the structured exit log emitted by `logVoiceWebhookExit`.
type VoiceFallbackCategory =
  | "missing_auth_token"
  | "missing_signature_header"
  | "invalid_signature"
  | "validate_request_helper_missing"
  | "signature_validation_threw"
  | "middleware_threw"
  | "resolve_base_url_failed"
  | "unhandled_handler_error";

function sendFallbackTwiml(
  res: Response,
  label: string,
  reason: string,
  level: "warn" | "error" = "warn",
  category: VoiceFallbackCategory = "unhandled_handler_error",
): void {
  if (res.headersSent) return;
  const log = level === "error" ? console.error : console.warn;
  // Structured single-line log (Task #944C). Shape is intentionally simple
  // — a flat key=value tail after the existing prefix — so existing
  // greps for `[Twilio Webhook][<label>]` keep working and a future
  // debugger can pull the category with `rg 'fallback_twiml=true category='`.
  log(
    `[Twilio Webhook][${label}] fallback_twiml=true category=${category} reason=${JSON.stringify(reason)}`,
  );
  // Mark the response so logVoiceWebhookExit knows a fallback was returned
  // even if it runs after this function (e.g. via afterResponse hooks).
  (res as Response & { locals: Record<string, unknown> }).locals = {
    ...((res as Response & { locals: Record<string, unknown> }).locals || {}),
    twilioFallbackCategory: category,
  };
  res.status(200).type("text/xml").send(FALLBACK_TWIML_BODY);
}

// Task #944C: structured request entry/exit logging used across every
// voice webhook in the browser-outbound chain. Logs are intentionally
// compact, single-line, and use a stable shape so a future on-call can:
//   1. grep for `[Twilio Voice]` to see the full chain at a glance.
//   2. grep for `callSid=<sid>` to follow a single call across hops.
//   3. grep for `category=` to find every hop that returned a fallback.
//
// The middleware (validateTwilioWebhookTwimlSafe / validateTwilioWebhook)
// stamps `res.locals.twilioSignatureValid` so the entry log can record
// whether we trusted the request before doing any work.
function fmtKv(record: Record<string, unknown>): string {
  return Object.entries(record)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}=${typeof v === "string" ? JSON.stringify(v) : v}`)
    .join(" ");
}

interface VoiceWebhookEntryFields {
  callSid?: string;
  parentCallSid?: string;
  to?: string;
  from?: string;
  baseUrl?: string;
  // Extra hop-specific fields (e.g. dialCallStatus, recordingStatus). Kept
  // open-ended so callers don't need to extend this interface for every
  // new field they want to pin to the entry log.
  [key: string]: string | number | boolean | undefined;
}

function logVoiceWebhookEntry(
  label: string,
  req: Request,
  res: Response,
  fields: VoiceWebhookEntryFields = {},
): bigint {
  const start = process.hrtime.bigint();
  (res as Response & { locals: Record<string, unknown> }).locals = {
    ...((res as Response & { locals: Record<string, unknown> }).locals || {}),
    twilioVoiceLogStart: start,
    twilioVoiceLogLabel: label,
  };
  const sigValidated = (res as Response & { locals: Record<string, unknown> })
    .locals?.twilioSignatureValid;
  const sig =
    sigValidated === true
      ? "valid"
      : sigValidated === "skipped"
        ? "skipped"
        : "unknown";
  console.log(
    `[Twilio Voice] entry hop=${label} ${fmtKv({ ...fields, signature: sig })}`,
  );
  return start;
}

function logVoiceWebhookExit(
  label: string,
  req: Request,
  res: Response,
  start: bigint,
  extra: Record<string, unknown> = {},
): void {
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  const fallbackCategory = (
    res as Response & { locals: Record<string, unknown> }
  ).locals?.twilioFallbackCategory as string | undefined;
  console.log(
    `[Twilio Voice] exit hop=${label} ${fmtKv({
      status: res.statusCode,
      elapsedMs: Math.round(elapsedMs * 10) / 10,
      fallback: fallbackCategory ? true : undefined,
      category: fallbackCategory,
      ...extra,
    })}`,
  );
}

// Task #944B: TwiML-safe variant of validateTwilioWebhook for the two
// voice routes the called party actually hears (voice-twiml-browser,
// voice-whisper). Signature validation still runs the same way; the only
// difference is the *failure response* — we return HTTP 200 + friendly
// TwiML instead of 403/500/503 + empty <Response>, so Twilio will read the
// fallback prompt to the recipient and hang up cleanly. Validation is NOT
// disabled — every failure mode is logged loudly so 944C can detect them.
export async function validateTwilioWebhookTwimlSafe(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const label = req.path.replace(/^\/api\/twilio\/webhooks\//, "");
  try {
    const [tokenSetting] = await getDb()
      .select()
      .from(systemSettings)
      .where(eq(systemSettings.key, "twilio_auth_token"));
    if (!tokenSetting?.value) {
      if (process.env.NODE_ENV === "production") {
        // No token in production — we can't verify. Don't pretend to bridge
        // a call we can't authenticate; play the friendly fallback so the
        // recipient hears a sentence instead of Twilio's default error voice.
        sendFallbackTwiml(
          res,
          label,
          "no twilio_auth_token configured (production)",
          "error",
          "missing_auth_token",
        );
        return;
      }
      console.warn(`[Twilio Webhook][${label}] No auth token configured, skipping signature validation (non-production)`);
      // Task #944C: stamp the skipped state so the entry log on the handler
      // surfaces signature=skipped instead of signature=unknown.
      (res.locals as Record<string, unknown>).twilioSignatureValid = "skipped";
      next();
      return;
    }

    const twilioSignature = req.headers["x-twilio-signature"] as string | undefined;
    if (!twilioSignature) {
      sendFallbackTwiml(
        res,
        label,
        "missing X-Twilio-Signature header",
        "warn",
        "missing_signature_header",
      );
      return;
    }

    try {
      const twilioMod = await import("twilio");
      const sdk = twilioMod.default ?? twilioMod;
      const validateRequest =
        typeof sdk.validateRequest === "function"
          ? sdk.validateRequest
          : typeof twilioMod.validateRequest === "function"
            ? twilioMod.validateRequest
            : undefined;
      if (!validateRequest) {
        sendFallbackTwiml(
          res,
          label,
          "validateRequest helper not found on twilio module",
          "error",
          "validate_request_helper_missing",
        );
        return;
      }
      const protocol = req.headers["x-forwarded-proto"] || "https";
      const host = req.headers["host"] || "";
      const url = `${protocol}://${host}${req.originalUrl}`;
      const isValid = validateRequest(tokenSetting.value, twilioSignature, url, req.body || {});
      if (!isValid) {
        // Log the same diagnostics the JSON middleware logs so 944C can
        // see signature mismatches even on the TwiML-safe routes.
        console.warn(`[Twilio Webhook][${label}] Invalid signature`, {
          url,
          path: req.originalUrl,
          hasBody: !!req.body && Object.keys(req.body).length > 0,
        });
        sendFallbackTwiml(res, label, "invalid X-Twilio-Signature", "warn", "invalid_signature");
        return;
      }
    } catch (err: any) {
      sendFallbackTwiml(
        res,
        label,
        `signature validation error: ${err?.message ?? String(err)}`,
        "error",
        "signature_validation_threw",
      );
      return;
    }

    // Task #944C: signature confirmed. Stamp res.locals so the handler's
    // entry log can surface signature=valid instead of signature=unknown.
    (res.locals as Record<string, unknown>).twilioSignatureValid = true;
    next();
  } catch (err: any) {
    sendFallbackTwiml(
      res,
      label,
      `middleware error: ${err?.message ?? String(err)}`,
      "error",
      "middleware_threw",
    );
  }
}

// Task #944B: wrap a voice-TwiML route handler so any synchronous throw
// during request setup (config lookup, env access, sync errors before the
// handler's own try/catch) still produces a valid 200 + fallback TwiML
// response instead of bubbling to Express's default error page.
// Task #1292: strict public-base-url resolver shared by every TwiML route
// handler. The lenient `getPublicBaseUrl({ allowLocalhostFallback: true })`
// would silently emit TwiML pointing Twilio at `https://localhost:5000`
// when neither REPLIT_DOMAINS nor REPLIT_DEV_DOMAIN is set — Twilio
// cannot reach that host, so the called party would hear the generic
// "an application error has occurred" prompt (the same failure mode
// Task #874 fixed once for the outbound bridge path). Routes call this
// helper instead; on failure it emits a friendly fallback TwiML via
// `sendFallbackTwiml` (category `resolve_base_url_failed`) and returns
// `null` so the handler can early-return without dialing localhost.
function resolvePublicBaseUrlOrFallback(
  res: Response,
  label: string,
): string | null {
  try {
    return getPublicBaseUrl();
  } catch (err: any) {
    sendFallbackTwiml(
      res,
      label,
      `getPublicBaseUrl failed: ${err?.message ?? String(err)}`,
      "error",
      "resolve_base_url_failed",
    );
    return null;
  }
}

function safeTwimlHandler(
  label: string,
  handler: (req: Request, res: Response) => Promise<void> | void,
) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      await Promise.resolve(handler(req, res));
    } catch (err: any) {
      sendFallbackTwiml(
        res,
        label,
        `unhandled handler error: ${err?.message ?? String(err)}`,
        "error",
        "unhandled_handler_error",
      );
    }
  };
}

type Participant = { phone: string; name?: string; contactId?: string };

// Task #3896 (audit B-003): optional client-supplied idempotency key for the
// four outbound send/call routes. The client mints ONE UUID per logical
// submission and reuses it across its automatic network retries; the route
// derives the durable per-recipient operation id from it via
// `deriveOutboundOperationId` so a duplicate POST (double-submit, replayed
// request, response-lost retry) can never create a second Twilio resource.
// Optional: requests without it keep the legacy fresh-operation-per-call
// contract.
const clientOperationIdSchema = z
  .string()
  .uuid("clientOperationId must be a UUID")
  .optional();

const sendSmsSchema = z.object({
  to: z.string().min(1, "Phone number is required"),
  body: z.string().min(1, "Message body is required").max(1600, "Message too long"),
  clientOperationId: clientOperationIdSchema,
});

const createConversationSchema = z.object({
  clientId: z.string().min(1).nullish(),
  contacts: z.array(z.object({
    phone: z.string().min(1),
    name: z.string().optional(),
    contactId: z.string().optional(),
  })).min(1, "At least one contact is required"),
  body: z.string().min(1, "Message body is required").max(1600, "Message too long"),
  clientOperationId: clientOperationIdSchema,
});

const updateParticipantsSchema = z.object({
  add: z.array(z.object({
    phone: z.string().min(1),
    name: z.string().optional(),
    contactId: z.string().optional(),
  })).optional(),
  remove: z.array(z.string()).optional(),
});

const initiateCallSchema = z.object({
  to: z.string().min(1, "Phone number is required"),
  clientOperationId: clientOperationIdSchema,
});

// Task #874: per-user call mode. `browser` (default) routes through the Twilio
// Voice JS SDK; `forward` rings the user's `callRoutingPhone` first and bridges
// on pickup. See server/services/twilioService.ts.
const callModeSchema = z.enum(["browser", "forward"]);

const messageBodySchema = z.object({
  body: z.string().min(1, "Message body is required").max(1600, "Message too long"),
  clientOperationId: clientOperationIdSchema,
});

const ivrMenuOptionSchema = z.object({
  digit: z.string().min(1).max(1),
  label: z.string().min(1).max(100),
  phone: z.string().min(1).max(20),
});

// Task #859 (audit step 8): Twilio requires E.164 for all `From`
// numbers. Validate on the write path so a typo at config time fails
// fast instead of producing a Twilio 21212 ("Invalid 'From' Number") on
// every outbound send. E.164: leading `+`, 1–15 digits, first digit
// 1–9. https://www.twilio.com/docs/glossary/what-e164
const e164Regex = /^\+[1-9]\d{1,14}$/;

const twilioConfigSchema = z.object({
  accountSid: z.string().optional(),
  authToken: z.string().optional(),
  phoneNumbers: z
    .array(
      z
        .string()
        .trim()
        .regex(e164Regex, "Phone numbers must be E.164 (e.g. +15551234567)"),
    )
    .optional(),
  ivrGreeting: z.string().max(500).optional(),
  ivrMenuOptions: z.array(ivrMenuOptionSchema).max(9).optional(),
  // Task #874: browser-calling credentials. Stored as separate system_settings
  // rows (twilio_api_key_sid, twilio_api_key_secret, twilio_twiml_app_sid).
  // The secret is never round-tripped to the client in plaintext on GET.
  // Each field is optional on the request (admins may save SMS-only config),
  // but if a field IS provided it must be non-empty. Clearing a stored value
  // requires the explicit `null` sentinel — this prevents accidentally
  // wiping browser-calling config by submitting an empty string from a form.
  apiKeySid: z
    .union([z.string().trim().min(1, "API Key SID is required"), z.null()])
    .optional(),
  apiKeySecret: z
    .union([z.string().trim().min(1, "API Key Secret is required"), z.null()])
    .optional(),
  // Drive folder for "unmatched" call recordings (calls with no matched
  // client). Empty string disables the unmatched mirror entirely.
  twimlAppSid: z
    .union([z.string().trim().min(1, "TwiML App SID is required"), z.null()])
    .optional(),
  // Task #876: Twilio Messaging Service SID (RCS-ready). When set, all
  // outbound SMS go through `messagingServiceSid: <MG…>` instead of
  // `from: <phoneNumber>` so Twilio can pick RCS for capable handsets and
  // fall back to SMS otherwise. Format-validated as `MG` + 32 hex chars
  // (Twilio Messaging Service SID format). Empty string / null clears the
  // setting and reverts to legacy `from` behavior.
  messagingServiceSid: z
    .union([
      z
        .string()
        .trim()
        .regex(
          /^MG[0-9a-fA-F]{32}$/,
          "Messaging Service SID must be 'MG' followed by 32 hex characters",
        ),
      z.literal(""),
      z.null(),
    ])
    .optional(),
});

const phoneRegex = /^\+?[1-9]\d{1,14}$/;

const userSettingsSchema = z.object({
  callerIdName: z.string().max(100).optional(),
  smsSignOff: z.string().max(500).optional(),
  callRoutingPhone: z.string().max(50).optional().refine(
    (val) => {
      if (!val || !val.trim()) return true;
      const digits = val.replace(/\D/g, "");
      return digits.length >= 10 && digits.length <= 15;
    },
    { message: "Phone number must contain 10-15 digits (e.g., 555-123-4567 or +15551234567)" }
  ),
  // Task #874: per-user calling preference.
  callMode: callModeSchema.optional(),
});

type IvrMenuOption = { digit: string; label: string; phone: string };

async function getIvrConfig(): Promise<{ greeting: string; options: IvrMenuOption[] }> {
  const [greetingSetting] = await db.select().from(systemSettings).where(eq(systemSettings.key, "twilio_ivr_greeting"));
  const [optionsSetting] = await db.select().from(systemSettings).where(eq(systemSettings.key, "twilio_ivr_menu_options"));

  const defaultGreeting = "Thank you for calling. Press 1 for Sales, or press 2 for Account Management.";
  const defaultOptions: IvrMenuOption[] = [
    { digit: "1", label: "Sales", phone: process.env.TWILIO_IVR_SALES_NUMBER || process.env.TWILIO_FORWARD_NUMBER || "" },
    { digit: "2", label: "Account Management", phone: process.env.TWILIO_IVR_AM_NUMBER || process.env.TWILIO_FORWARD_NUMBER || "" },
  ];

  let greeting = defaultGreeting;
  let options = defaultOptions;

  if (greetingSetting?.value) greeting = greetingSetting.value;
  if (optionsSetting?.value) {
    try { options = JSON.parse(optionsSetting.value); } catch {}
  }

  return { greeting, options };
}

async function generateIvrTwiml(baseUrl: string, callSid: string): Promise<string> {
  const { greeting } = await getIvrConfig();
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather numDigits="1" action="${baseUrl}/api/twilio/webhooks/voice-ivr?callSid=${callSid}" method="POST" timeout="10">
    <Say>${escapeXml(greeting)}</Say>
  </Gather>
  <Say>We didn't receive your selection. Goodbye.</Say>
</Response>`;
}

// Generic recording-disclosure greeting played to (a) inbound callers
// before the call is bridged to anyone, and (b) outbound called parties
// via Dial whisper. Stored in system_settings so admins can edit the
// wording without redeploying. Falls back to a jurisdiction-safe
// default suitable for two-party-consent states.
const DEFAULT_RECORDING_DISCLOSURE =
  "This call may be recorded for quality assurance and compliance purposes.";
async function getRecordingDisclosure(): Promise<string> {
  const [row] = await db
    .select()
    .from(systemSettings)
    .where(eq(systemSettings.key, "twilio_recording_disclosure"));
  const v = row?.value?.trim();
  return v && v.length > 0 ? v : DEFAULT_RECORDING_DISCLOSURE;
}

// Task #852: voicemail greeting played to the caller before the beep
// when an inbound call falls through to the <Record> verb (chain
// exhausted with no answer). Editable via system_settings.
const DEFAULT_VOICEMAIL_GREETING =
  "The person you are trying to reach is not available. Please leave a message after the beep, and press the pound key when finished.";
async function getVoicemailGreeting(): Promise<string> {
  const [row] = await db
    .select()
    .from(systemSettings)
    .where(eq(systemSettings.key, "twilio_voicemail_greeting"));
  const v = row?.value?.trim();
  return v && v.length > 0 ? v : DEFAULT_VOICEMAIL_GREETING;
}

// Task #852: TwiML for the voicemail recording leg. Distinct from
// dialRecordAttributes (which sits inside <Dial>) — this is a
// standalone <Record> verb at the end of an unanswered inbound call.
// recordingStatusCallback/transcribeCallback point at dedicated
// /voicemail-* handlers so they don't collide with the Dial-recording
// pipeline. action="" on <Record> fires when recording finishes
// (caller hangs up or finishOnKey pressed) — we just hang up.
async function generateVoicemailTwiml(baseUrl: string): Promise<string> {
  const greeting = await getVoicemailGreeting();
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>${escapeXml(greeting)}</Say>
  <Record action="${baseUrl}/api/twilio/webhooks/voicemail-action" method="POST" maxLength="180" finishOnKey="#" playBeep="true" trim="trim-silence" transcribe="true" transcribeCallback="${baseUrl}/api/twilio/webhooks/voicemail-transcription" recordingStatusCallback="${baseUrl}/api/twilio/webhooks/voicemail-recording-status" recordingStatusCallbackMethod="POST" recordingStatusCallbackEvent="completed"/>
  <Say>We did not receive a recording. Goodbye.</Say>
  <Hangup/>
</Response>`;
}

// Standard set of <Dial> recording attributes so all four bridging
// flows record the same way (dual-channel, both legs from answer)
// and all post recording status to the same handler.
//
// Note on `recordingStatusCallbackEvent`: the valid event names for
// the <Dial> verb are `in-progress`, `completed`, and `absent`
// (NOT `failed` — that's only valid on the Recordings REST API). We
// subscribe to `in-progress` and `completed` so the UI can render a
// "processing…" placeholder the moment recording starts and swap to
// the audio player when the file finalises.
function dialRecordAttributes(baseUrl: string): string {
  return [
    `record="record-from-answer-dual"`,
    `recordingStatusCallback="${baseUrl}/api/twilio/webhooks/recording-status"`,
    `recordingStatusCallbackMethod="POST"`,
    `recordingStatusCallbackEvent="in-progress completed"`,
    `recordingTrack="both"`,
  ].join(" ");
}

function escapeXml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

// Task #877: render the inner dialee for an inbound routing target. When
// the target user has callMode='browser' AND their browser SDK is currently
// registered (heartbeat-tracked in browserPresence), we dial
// <Client>${userId}</Client> so the call rings in the open tab. Otherwise
// we fall back to <Number>${callRoutingPhone}</Number>, preserving the
// pre-#877 forward-to-cell behavior. If a browser-mode user is offline AND
// has no callRoutingPhone, we still emit an empty <Number></Number> so the
// <Dial> immediately fails and `voice-routing-callback` advances to the
// next tier — that mirrors the legacy "no-answer" path.
function renderRoutingDialee(target: {
  userId?: string;
  phone?: string;
  callMode?: "browser" | "forward";
}): string {
  if (target.callMode === "browser" && target.userId && isUserBrowserOnline(target.userId)) {
    return `<Client>${escapeXml(target.userId)}</Client>`;
  }
  return `<Number>${escapeXml(target.phone || "")}</Number>`;
}

export function registerTwilioRoutes(app: Express) {
  app.post("/api/twilio/webhooks/sms", validateTwilioWebhook, async (req, res) => {
    try {
      const { From, To, Body, MessageSid, OptOutType } = req.body;
      if (!From || !To || !Body) {
        return res.status(400).type("text/xml").send("<Response></Response>");
      }

      const { handleInboundSms } = await import("../services/twilioService");
      const { withDbHoldLabel } = await import("../db");
      // Task #818 Phase 0: tag the API-side Twilio SMS webhook receiver.
      await withDbHoldLabel("twilio_sms_receive", () =>
        handleInboundSms({
          from: normalizePhone(From),
          to: normalizePhone(To),
          body: Body,
          messageSid: MessageSid,
          // Task #4336 — optional consent-keyword hint (STOP|START|HELP).
          optOutType: typeof OptOutType === "string" ? OptOutType : null,
        }),
      );

      res.type("text/xml").send("<Response></Response>");
    } catch (error: any) {
      console.error("[Twilio Webhook] SMS error:", error.message);
      res.type("text/xml").send("<Response></Response>");
    }
  });

  // Task #875: Twilio SMS delivery-status callback. Twilio POSTs
  // MessageSid + MessageStatus (queued|sent|delivered|failed|
  // undelivered, etc.) here, plus ErrorCode/ErrorMessage on failure
  // paths. We look the row up by SID and write the new status so the
  // thread view can move the badge from queued → sent → delivered (or
  // failed/undelivered). Reuses the existing signature middleware.
  app.post("/api/twilio/webhooks/sms-status", validateTwilioWebhook, async (req, res) => {
    try {
      const { MessageSid, MessageStatus, ErrorCode, ErrorMessage, MessagingServiceSid } = req.body;
      if (!MessageSid || !MessageStatus) {
        return res.status(400).type("text/xml").send("<Response></Response>");
      }

      const { handleSmsStatus } = await import("../services/twilioService");
      const { withDbHoldLabel } = await import("../db");
      // Match the existing webhook tagging convention used by /sms and
      // /call-status so DB-hold attribution stays consistent.
      await withDbHoldLabel("twilio_sms_status_receive", () =>
        handleSmsStatus({
          messageSid: String(MessageSid),
          messageStatus: String(MessageStatus),
          errorCode: ErrorCode ? String(ErrorCode) : undefined,
          errorMessage: ErrorMessage ? String(ErrorMessage) : undefined,
          // Task #883: Twilio includes MessagingServiceSid on every
          // status callback for messages routed through a service. This
          // backfills `twilio_messages.messaging_service_sid` for rows
          // sent before the column existed.
          messagingServiceSid: MessagingServiceSid ? String(MessagingServiceSid) : undefined,
        }),
      );

      res.type("text/xml").send("<Response></Response>");
    } catch (error: any) {
      console.error("[Twilio Webhook] SMS status error:", error.message);
      res.type("text/xml").send("<Response></Response>");
    }
  });

  app.post("/api/twilio/webhooks/call-status", validateTwilioWebhook, async (req, res) => {
    try {
      const { CallSid, CallStatus, CallDuration, From, To, Direction } = req.body;
      if (!CallSid) {
        return res.status(400).type("text/xml").send("<Response></Response>");
      }

      const { handleCallStatus } = await import("../services/twilioService");
      const { withDbHoldLabel } = await import("../db");
      // Task #818 Phase 0: tag the API-side Twilio call-status webhook.
      await withDbHoldLabel("twilio_call_status_receive", () =>
        handleCallStatus({
          callSid: CallSid,
          callStatus: CallStatus,
          callDuration: CallDuration ? parseInt(CallDuration) : undefined,
          from: From ? normalizePhone(From) : undefined,
          to: To ? normalizePhone(To) : undefined,
          direction: Direction,
        }),
      );

      res.type("text/xml").send("<Response></Response>");
    } catch (error: any) {
      console.error("[Twilio Webhook] Call status error:", error.message);
      res.type("text/xml").send("<Response></Response>");
    }
  });

  app.post("/api/twilio/webhooks/voice-twiml", validateTwilioWebhook, async (req, res) => {
    try {
      const { From, To, CallSid } = req.body;
      const callerPhone = From ? normalizePhone(From) : "";

      const { resolveRoutingChain } = await import("../services/callRoutingService");
      const chain = await resolveRoutingChain(callerPhone);

      const match = await twilioStorage.findClientByPhone(callerPhone);
      const { createRawCommunication } = await import("../storage/communicationStorage");
      const commRecord = await createRawCommunication({
        clientId: match?.clientId || undefined,
        sourceType: "twilio_call",
        title: `Inbound call from ${callerPhone}`,
        timestamp: new Date(),
        direction: "inbound",
        externalSourceId: CallSid,
        matchMethod: match ? "phone_lookup" : undefined,
        matchConfidence: match ? 1.0 : undefined,
        matchStatus: match ? "matched" : "unmatched",
      });

      await twilioStorage.createTwilioCall({
        clientId: match?.clientId || null,
        clientContactId: match?.contactId || null,
        twilioSid: CallSid,
        direction: "inbound",
        fromNumber: callerPhone,
        toNumber: To ? normalizePhone(To) : "",
        status: "ringing",
        rawCommunicationRecordId: commRecord.id,
      });

      const baseUrl = resolvePublicBaseUrlOrFallback(res, "voice-twiml");
      if (!baseUrl) return;

      // Compliance: announce recording to the inbound caller BEFORE we
      // bridge or run the IVR. Played once at the very start of the
      // call so two-party-consent jurisdictions are covered without
      // requiring the answering rep to remember to say it.
      const disclosure = await getRecordingDisclosure();
      const disclosureXml = `  <Say>${escapeXml(disclosure)}</Say>\n`;

      if (chain.targets.length > 0) {
        const target = chain.targets[0];
        const dialeeXml = renderRoutingDialee(target);
        res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
${disclosureXml}  <Dial timeout="25" ${dialRecordAttributes(baseUrl)} action="${baseUrl}/api/twilio/webhooks/voice-routing-callback?tier=${target.tier}&amp;callSid=${CallSid}&amp;routingData=${encodeURIComponent(JSON.stringify(chain))}" callerId="${To || ""}">
    ${dialeeXml}
  </Dial>
</Response>`);
      } else {
        // generateIvrTwiml only handles the menu; prepend the
        // disclosure so callers who fall through to the IVR also hear
        // it before making a selection.
        const ivr = await generateIvrTwiml(baseUrl, CallSid);
        res.type("text/xml").send(
          ivr.replace("<Response>", `<Response>\n${disclosureXml.trimEnd()}`)
        );
      }
    } catch (error: any) {
      console.error("[Twilio Webhook] Voice TwiML error:", error.message);
      res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>We're sorry, we're experiencing technical difficulties. Please try again later.</Say>
</Response>`);
    }
  });

  app.post("/api/twilio/webhooks/voice-routing-callback", validateTwilioWebhook, async (req, res) => {
    try {
      const { DialCallStatus, CallSid: reqCallSid } = req.body;
      const tier = parseInt(req.query.tier as string) || 1;
      const callSid = (req.query.callSid as string) || reqCallSid;
      let chain: { targets: Array<{ userId: string; phone: string; tier: number }>; clientId?: string; accountManagerUserId?: string };

      try {
        chain = JSON.parse(decodeURIComponent(req.query.routingData as string));
      } catch {
        chain = { targets: [] };
      }

      const baseUrl = resolvePublicBaseUrlOrFallback(res, "voice-routing-callback");
      if (!baseUrl) return;

      if (DialCallStatus === "completed" || DialCallStatus === "answered") {
        const currentTargetIdx = chain.targets.findIndex(t => t.tier === tier);
        const currentTarget = currentTargetIdx >= 0 ? chain.targets[currentTargetIdx] : null;
        if (currentTarget && callSid) {
          const call = await twilioStorage.getTwilioCallByTwilioSid(callSid);
          if (call) {
            await twilioStorage.updateTwilioCall(call.id, {
              routedToUserId: currentTarget.userId,
              routingTier: currentTarget.tier,
              answeredAt: new Date(),
              status: "completed",
            });
          }
        }
        res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`);
        return;
      }

      if (callSid && DialCallStatus) {
        const call = await twilioStorage.getTwilioCallByTwilioSid(callSid);
        if (call && !call.answeredAt) {
          await twilioStorage.updateTwilioCall(call.id, { status: DialCallStatus });
        }
      }

      const currentIdx = chain.targets.findIndex(t => t.tier === tier);
      const nextTarget = currentIdx >= 0 && currentIdx + 1 < chain.targets.length
        ? chain.targets[currentIdx + 1]
        : null;
      if (nextTarget) {
        const dialeeXml = renderRoutingDialee(nextTarget);
        res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial timeout="25" ${dialRecordAttributes(baseUrl)} action="${baseUrl}/api/twilio/webhooks/voice-routing-callback?tier=${nextTarget.tier}&amp;callSid=${callSid}&amp;routingData=${encodeURIComponent(JSON.stringify(chain))}" callerId="${req.body.To || ""}">
    ${dialeeXml}
  </Dial>
</Response>`);
      } else {
        // Task #852: routing chain exhausted with no answer — fall through
        // to voicemail. Mark the call no-answer first so the inbox renders
        // it as a missed call; the voicemail-recording-status callback
        // then writes the recording URL onto the same row, and the
        // call-status callback's isInboundMissed branch preserves the
        // no-answer status when the caller hangs up after recording.
        if (callSid) {
          const call = await twilioStorage.getTwilioCallByTwilioSid(callSid);
          if (call && !call.answeredAt) {
            await twilioStorage.updateTwilioCall(call.id, { status: "no-answer" });
          }
        }
        res.type("text/xml").send(await generateVoicemailTwiml(baseUrl));
      }
    } catch (error: any) {
      console.error("[Twilio Webhook] Routing callback error:", error.message);
      res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say>Please try again later.</Say></Response>`);
    }
  });

  app.post("/api/twilio/webhooks/voice-ivr", validateTwilioWebhook, async (req, res) => {
    try {
      const { Digits } = req.body;
      const { options } = await getIvrConfig();
      const selected = options.find((o) => o.digit === Digits);

      if (selected && selected.phone) {
        const baseUrlIvr = resolvePublicBaseUrlOrFallback(res, "voice-ivr");
        if (!baseUrlIvr) return;
        res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Connecting you to ${escapeXml(selected.label)}.</Say>
  <Dial ${dialRecordAttributes(baseUrlIvr)}><Number>${selected.phone}</Number></Dial>
</Response>`);
      } else {
        res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Invalid selection. Goodbye.</Say>
</Response>`);
      }

      const callSid = req.query.callSid as string;
      if (callSid) {
        const call = await twilioStorage.getTwilioCallByTwilioSid(callSid);
        if (call) {
          await twilioStorage.updateTwilioCall(call.id, { routingTier: 3 });
        }
      }
    } catch (error: any) {
      console.error("[Twilio Webhook] IVR error:", error.message);
      res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say>Please try again later.</Say></Response>`);
    }
  });

  // Task #874: legacy outbound TwiML endpoint. Originally returned a bare
  // <Say>Connecting your call now.</Say> with no <Dial> verb, which is what
  // produced the "an error has occurred, goodbye" prompt the moment the
  // called party answered. We now return a complete bridging TwiML
  // document IF query params identify the destination (so any in-flight call
  // started before this fix still completes), and otherwise return a clear
  // error <Say>. Real outbound calls now go through `voice-twiml-browser`
  // (browser SDK) or `voice-twiml-forward-bridge` (forward-to-cell mode).
  app.post("/api/twilio/webhooks/voice-twiml-outbound", validateTwilioWebhook, (req, res) => {
    const to = (req.query.to as string) || (req.body?.To as string) || "";
    const callerId = (req.query.callerId as string) || "";
    if (!to || !callerId) {
      console.warn("[Twilio Webhook][voice-twiml-outbound] Missing to/callerId — replying with explicit error TwiML", {
        query: req.query,
        callSid: req.body?.CallSid,
      });
      res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>This call could not be connected because the outbound destination was not provided. Please try again from the application.</Say>
  <Hangup/>
</Response>`);
      return;
    }
    const baseUrlOut = resolvePublicBaseUrlOrFallback(res, "voice-twiml-outbound");
    if (!baseUrlOut) return;
    res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial callerId="${escapeXml(callerId)}" answerOnBridge="true" ${dialRecordAttributes(baseUrlOut)}>
    <Number url="${baseUrlOut}/api/twilio/webhooks/voice-whisper" method="POST">${escapeXml(normalizePhone(to))}</Number>
  </Dial>
</Response>`);
  });

  // Task #874: forward-to-cell bridge. Twilio fetches this as the voice URL
  // for the user's cell-leg call (placed by `initiateForwardCall`). The
  // destination + caller ID arrive as query params (encoded by
  // `initiateForwardCall`) so this endpoint stays stateless and free of DB
  // lookups in the call critical path. `answerOnBridge="true"` means the
  // first leg only hears ringback while the second leg rings — there is no
  // gap where the user picks up and hears silence/synthetic voice.
  app.post("/api/twilio/webhooks/voice-twiml-forward-bridge", validateTwilioWebhook, (req, res) => {
    const to = (req.query.to as string) || "";
    const callerId = (req.query.callerId as string) || "";
    if (!to || !callerId) {
      console.warn("[Twilio Webhook][voice-twiml-forward-bridge] Missing to/callerId — replying with error TwiML", {
        query: req.query,
        callSid: req.body?.CallSid,
      });
      res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>We could not connect your call because the destination was missing. Please try again.</Say>
  <Hangup/>
</Response>`);
      return;
    }
    const baseUrlBridge = resolvePublicBaseUrlOrFallback(res, "voice-twiml-forward-bridge");
    if (!baseUrlBridge) return;
    // Outbound: the user (initiator) doesn't need to hear the
    // disclosure — they already know calls are recorded. The whisper
    // URL on <Number> plays the disclosure to the called party only,
    // the moment they pick up, before the audio bridges.
    res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial callerId="${escapeXml(callerId)}" answerOnBridge="true" ${dialRecordAttributes(baseUrlBridge)}>
    <Number url="${baseUrlBridge}/api/twilio/webhooks/voice-whisper" method="POST">${escapeXml(normalizePhone(to))}</Number>
  </Dial>
</Response>`);
  });

  // Task #874: voice URL pointed at by the TwiML App used for browser-SDK
  // outbound calls. The browser invokes `Device.connect({ params: { To } })`,
  // so Twilio POSTs `To`, `From=client:<identity>`, and `CallSid` here. We
  // record the call in our log immediately and return <Dial> TwiML using the
  // configured Twilio phone number as caller ID. The status callback updates
  // the same row as it transitions through ringing/answered/completed.
  app.post(
    "/api/twilio/webhooks/voice-twiml-browser",
    validateTwilioWebhookTwimlSafe,
    safeTwimlHandler("voice-twiml-browser", async (req, res) => {
      const rawTo = (req.body?.To as string) || "";
      const callSid = (req.body?.CallSid as string) || "";
      const fromIdentity = (req.body?.From as string) || ""; // e.g. "client:<userId>"
      const start = logVoiceWebhookEntry("voice-twiml-browser", req, res, {
        callSid,
        to: rawTo,
        from: fromIdentity,
      });
      if (!rawTo) {
        console.warn("[Twilio Webhook][voice-twiml-browser] Missing To param", { callSid, body: req.body });
        res.status(200).type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>No destination number was provided.</Say>
  <Hangup/>
</Response>`);
        logVoiceWebhookExit("voice-twiml-browser", req, res, start, { reason: "missing_to" });
        return;
      }

      const { getTwilioConfig, recordBrowserOutboundCall, resolveBaseUrl } = await import("../services/twilioService");
      const tConfig = await getTwilioConfig();
      const fromNumber = tConfig?.phoneNumbers?.[0];
      if (!fromNumber) {
        console.error("[Twilio Webhook][voice-twiml-browser] No Twilio phone number configured — refusing browser bridge", { callSid });
        res.status(200).type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>This account has no Twilio phone number configured for outbound calls.</Say>
  <Hangup/>
</Response>`);
        logVoiceWebhookExit("voice-twiml-browser", req, res, start, { reason: "missing_from_number" });
        return;
      }

      const to = normalizePhone(rawTo);
      const userId = fromIdentity.startsWith("client:") ? fromIdentity.slice("client:".length) : null;

      // Persist before returning TwiML so the call appears in the log even
      // if the connect fails mid-bridge. Best-effort — a DB blip here must
      // not produce a mid-call "an error has occurred" prompt.
      if (callSid) {
        try {
          await recordBrowserOutboundCall({ twilioSid: callSid, fromNumber, toNumber: to, userId });
        } catch (err: any) {
          console.error("[Twilio Webhook][voice-twiml-browser] Failed to record call (continuing best-effort):", err?.message);
        }
      }

      // Task #944B: resolveBaseUrl now throws if no public hostname is
      // configured (it used to silently return localhost — a Twilio-unreachable
      // URL that produced the default error prompt). Catch the throw here and
      // play the friendly fallback so the recipient still hears a sentence.
      let baseUrl: string;
      try {
        baseUrl = resolveBaseUrl();
      } catch (err: any) {
        sendFallbackTwiml(
          res,
          "voice-twiml-browser",
          `resolveBaseUrl failed: ${err?.message ?? String(err)}`,
          "error",
          "resolve_base_url_failed",
        );
        logVoiceWebhookExit("voice-twiml-browser", req, res, start);
        return;
      }

      // Use Dial's `action` (fires once when the bridged call ends) routed to
      // a dedicated handler that knows about DialCallStatus / DialCallDuration
      // and updates the *parent* call_logs row keyed by the parent CallSid.
      // The standard /webhooks/call-status handler expects CallStatus /
      // CallDuration shape, so we cannot point Dial.action at it directly.
      res.status(200).type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial callerId="${escapeXml(fromNumber)}" answerOnBridge="true" ${dialRecordAttributes(baseUrl)} action="${baseUrl}/api/twilio/webhooks/voice-twiml-browser-dial-status" method="POST">
    <Number url="${baseUrl}/api/twilio/webhooks/voice-whisper" method="POST">${escapeXml(to)}</Number>
  </Dial>
</Response>`);
      logVoiceWebhookExit("voice-twiml-browser", req, res, start, { baseUrl, to });
    }),
  );

  // Compliance whisper: Twilio fetches this URL on the called party's
  // leg the moment they pick up. The TwiML returned is played to the
  // called party only (not the initiator) before the audio bridges.
  // Stateless — no DB lookups in the call critical path beyond the
  // disclosure setting. Task #944B: signature validation now runs via
  // the TwiML-safe variant — any signature failure returns 200 +
  // friendly fallback TwiML instead of 403, so Twilio can never play
  // its built-in error voice from this hop, and the endpoint is no
  // longer reachable as an unauthenticated TwiML emitter.
  app.post(
    "/api/twilio/webhooks/voice-whisper",
    validateTwilioWebhookTwimlSafe,
    safeTwimlHandler("voice-whisper", async (req, res) => {
      const callSid = (req.body?.CallSid as string) || "";
      const parentCallSid = (req.body?.ParentCallSid as string) || "";
      const start = logVoiceWebhookEntry("voice-whisper", req, res, {
        callSid,
        parentCallSid,
        to: req.body?.To,
        from: req.body?.From,
      });
      try {
        const disclosure = await getRecordingDisclosure();
        res.status(200).type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>${escapeXml(disclosure)}</Say>
</Response>`);
        logVoiceWebhookExit("voice-whisper", req, res, start, { whisper: "disclosure" });
      } catch (err: any) {
        console.error("[Twilio Webhook][voice-whisper] Error generating disclosure TwiML:", err?.message);
        // Empty <Response> = no whisper, audio bridges immediately. Better
        // to skip the disclosure on a transient DB blip than to fail the call.
        // Tag with category so 944C diagnostics show "fallback fired here".
        (res.locals as Record<string, unknown>).twilioFallbackCategory = "unhandled_handler_error";
        console.warn(
          `[Twilio Webhook][voice-whisper] fallback_twiml=true category=unhandled_handler_error reason=${JSON.stringify(
            `disclosure lookup failed: ${err?.message ?? String(err)}`,
          )}`,
        );
        res.status(200).type("text/xml").send(EMPTY_TWIML_BODY);
        logVoiceWebhookExit("voice-whisper", req, res, start, { whisper: "empty" });
      }
    }),
  );

  // Recording status callback. Twilio POSTs here when the Dial-verb
  // recording finishes (or fails). The parent `CallSid` matches the SID
  // we stored on `twilio_calls.twilio_sid` for inbound, browser-outbound,
  // and forward-outbound flows alike, so a single lookup-by-SID handler
  // covers all three. RecordingStatus values mirror Twilio's:
  //   completed | failed | absent | in-progress
  app.post("/api/twilio/webhooks/recording-status", validateTwilioWebhook, async (req, res) => {
    const parentCallSid = (req.body?.CallSid as string) || "";
    const recordingSid = (req.body?.RecordingSid as string) || "";
    const recordingUrl = (req.body?.RecordingUrl as string) || "";
    const recordingStatus = (req.body?.RecordingStatus as string) || "";
    const recordingDurationRaw = req.body?.RecordingDuration as string | undefined;
    const recordingDuration = recordingDurationRaw ? parseInt(recordingDurationRaw, 10) : null;
    const recordingChannelsRaw = req.body?.RecordingChannels as string | undefined;
    const recordingChannels = recordingChannelsRaw ? parseInt(recordingChannelsRaw, 10) : null;
    const start = logVoiceWebhookEntry("recording-status", req, res, {
      parentCallSid,
      recordingSid,
      recordingStatus,
      recordingDuration: recordingDuration ?? undefined,
      recordingChannels: recordingChannels ?? undefined,
    });
    try {

      if (!parentCallSid) {
        res.status(200).type("text/xml").send("<Response></Response>");
        logVoiceWebhookExit("recording-status", req, res, start, { reason: "missing_parent_call_sid" });
        return;
      }

      const { withDbHoldLabel } = await import("../db");
      let archiveTargetCallId: string | null = null;
      let isCompleted = false;
      let isAbsent = false;
      await withDbHoldLabel("twilio_recording_status_receive", async () => {
        const call = await twilioStorage.getTwilioCallByTwilioSid(parentCallSid);
        if (!call) {
          console.warn("[Twilio Webhook][recording-status] No twilio_calls row for parent CallSid", { parentCallSid, recordingSid });
          return;
        }
        await twilioStorage.updateTwilioCall(call.id, {
          recordingSid: recordingSid || call.recordingSid,
          recordingUrl: recordingUrl || call.recordingUrl,
          recordingStatus: recordingStatus || call.recordingStatus,
          recordingDuration: recordingDuration ?? call.recordingDuration,
          recordingChannels: recordingChannels ?? call.recordingChannels,
        });
        archiveTargetCallId = call.id;
        isCompleted = recordingStatus === "completed";
        isAbsent = recordingStatus === "absent";
      });

      // Hand off to the archive pipeline once the recording is finalised.
      // We do this AFTER the metadata write so the worker sees recording_url.
      // Fire-and-forget so the webhook still returns 200 quickly.
      if (archiveTargetCallId) {
        const { enqueueCallArchive, markCallArchiveSkipped } = await import("../services/callArchivePipeline");
        if (isCompleted) {
          enqueueCallArchive(archiveTargetCallId).catch((err) =>
            console.error("[Twilio Webhook][recording-status] enqueueCallArchive failed", err?.message),
          );
        } else if (isAbsent) {
          markCallArchiveSkipped(archiveTargetCallId, "RecordingStatus=absent").catch((err) =>
            console.error("[Twilio Webhook][recording-status] markCallArchiveSkipped failed", err?.message),
          );
        }
      }

      res.status(200).type("text/xml").send("<Response></Response>");
      logVoiceWebhookExit("recording-status", req, res, start, {
        archiveTargetCallId: archiveTargetCallId ?? undefined,
        archiveAction: isCompleted ? "enqueued" : isAbsent ? "skipped_absent" : "metadata_only",
      });
    } catch (err: any) {
      console.error(
        `[Twilio Webhook][recording-status] fallback_twiml=true category=unhandled_handler_error reason=${JSON.stringify(
          err?.message ?? String(err),
        )}`,
        err?.stack,
      );
      (res.locals as Record<string, unknown>).twilioFallbackCategory = "unhandled_handler_error";
      // Always 200 to Twilio so it doesn't retry-storm us; we logged the failure.
      res.status(200).type("text/xml").send("<Response></Response>");
      logVoiceWebhookExit("recording-status", req, res, start);
    }
  });

  // Task #852: voicemail recording-status callback. Twilio POSTs here
  // when the standalone <Record> verb finishes (RecordingStatusCallbackEvent
  // is filtered to "completed" only). Writes the recording URL/SID/duration
  // onto the parent twilio_calls row keyed by CallSid. We do NOT enqueue
  // the call-archive pipeline here — voicemails are streamed direct from
  // Twilio via the dedicated voicemail-recording proxy.
  app.post("/api/twilio/webhooks/voicemail-recording-status", validateTwilioWebhook, async (req, res) => {
    const callSid = (req.body?.CallSid as string) || "";
    const recordingSid = (req.body?.RecordingSid as string) || "";
    const recordingUrl = (req.body?.RecordingUrl as string) || "";
    const recordingDurationRaw = req.body?.RecordingDuration as string | undefined;
    const recordingDuration = recordingDurationRaw ? parseInt(recordingDurationRaw, 10) : null;
    try {
      if (!callSid || !recordingUrl) {
        res.status(200).type("text/xml").send("<Response></Response>");
        return;
      }
      const call = await twilioStorage.getTwilioCallByTwilioSid(callSid);
      if (!call) {
        console.warn("[Twilio Webhook][voicemail-recording-status] No twilio_calls row for CallSid", { callSid, recordingSid });
        res.status(200).type("text/xml").send("<Response></Response>");
        return;
      }
      await twilioStorage.updateTwilioCall(call.id, {
        voicemailRecordingSid: recordingSid || call.voicemailRecordingSid,
        voicemailRecordingUrl: recordingUrl || call.voicemailRecordingUrl,
        voicemailRecordingDuration: recordingDuration ?? call.voicemailRecordingDuration,
        voicemailTranscriptionStatus: call.voicemailTranscriptionStatus || "in-progress",
      });
      res.status(200).type("text/xml").send("<Response></Response>");
    } catch (err: any) {
      console.error("[Twilio Webhook][voicemail-recording-status] error", err?.message);
      res.status(200).type("text/xml").send("<Response></Response>");
    }
  });

  // Task #852: voicemail transcription callback. Twilio's classic
  // <Record transcribe="true"> POSTs the finished transcript here a
  // few seconds after the recording completes. TranscriptionStatus is
  // "completed" or "failed".
  app.post("/api/twilio/webhooks/voicemail-transcription", validateTwilioWebhook, async (req, res) => {
    const callSid = (req.body?.CallSid as string) || "";
    const transcriptionText = (req.body?.TranscriptionText as string) || "";
    const transcriptionStatus = (req.body?.TranscriptionStatus as string) || "";
    try {
      if (!callSid) {
        res.status(200).type("text/xml").send("<Response></Response>");
        return;
      }
      const call = await twilioStorage.getTwilioCallByTwilioSid(callSid);
      if (!call) {
        res.status(200).type("text/xml").send("<Response></Response>");
        return;
      }
      await twilioStorage.updateTwilioCall(call.id, {
        voicemailTranscriptionText: transcriptionText || call.voicemailTranscriptionText,
        voicemailTranscriptionStatus: transcriptionStatus || "completed",
      });

      // Task #1688 — Per-user inbox: notify the routed user (or client
      // AM fallback) when a voicemail transcript lands. Best-effort.
      try {
        const { getRoutedCallUser } = await import("../services/notifications/recipients");
        const { notifyUser } = await import("../services/notifications/userInbox");
        const recipients = await getRoutedCallUser({
          callId: call.id,
          callSid: call.twilioSid ?? null,
          clientId: call.clientId ?? null,
        });
        const preview = (transcriptionText || "").trim().slice(0, 240);
        for (const uid of recipients) {
          await notifyUser(uid, {
            category: "comms.voicemail",
            title: `Voicemail from ${call.fromNumber ?? "?"}`,
            body: preview || "(no transcript)",
            deepLink: `/conversation-hub?callId=${encodeURIComponent(call.id)}`,
            dedupeKey: `voicemail:${call.twilioSid ?? call.id}`,
            metadata: {
              callId: call.id,
              callSid: call.twilioSid ?? null,
              transcriptionStatus: transcriptionStatus || "completed",
            },
          });
        }
      } catch (err: any) {
        console.warn("[Twilio] voicemail notifyUser fan-out failed:", err?.message ?? err);
      }

      res.status(200).type("text/xml").send("<Response></Response>");
    } catch (err: any) {
      console.error("[Twilio Webhook][voicemail-transcription] error", err?.message);
      res.status(200).type("text/xml").send("<Response></Response>");
    }
  });

  // Task #852: <Record action=""> fires when the recording finishes
  // (caller hangs up or finishOnKey pressed). We just hang up so
  // Twilio doesn't continue executing TwiML beyond the <Record>.
  app.post("/api/twilio/webhooks/voicemail-action", validateTwilioWebhook, (_req, res) => {
    res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
  });

  // Task #874: Dedicated dial-action handler for browser-originated outbound
  // calls. Twilio POSTs Dial action callbacks with `DialCallStatus` /
  // `DialCallDuration` and the *parent* call's `CallSid`. We translate to the
  // CallStatus shape the rest of the pipeline expects and update the parent
  // call_logs row that voice-twiml-browser created.
  app.post("/api/twilio/webhooks/voice-twiml-browser-dial-status", validateTwilioWebhook, async (req, res) => {
    const parentCallSid = (req.body?.CallSid as string) || "";
    const dialCallStatus = (req.body?.DialCallStatus as string) || "";
    const dialCallDurationRaw = req.body?.DialCallDuration as string | undefined;
    const dialCallDuration = dialCallDurationRaw ? parseInt(dialCallDurationRaw, 10) : undefined;
    const start = logVoiceWebhookEntry("voice-twiml-browser-dial-status", req, res, {
      parentCallSid,
      dialCallStatus,
      dialCallDuration,
    });
    try {
      if (parentCallSid && dialCallStatus) {
        const { handleCallStatus } = await import("../services/twilioService");
        // Map a few DialCallStatus values that don't line up 1:1 with CallStatus:
        //   "answered" → "completed" (Dial reports answered when caller hung up after answer)
        const normalizedStatus = dialCallStatus === "answered" ? "completed" : dialCallStatus;
        await handleCallStatus({
          callSid: parentCallSid,
          callStatus: normalizedStatus,
          callDuration: Number.isFinite(dialCallDuration) ? dialCallDuration : undefined,
          direction: "outbound",
        });
      }

      // Empty TwiML so Twilio cleanly hangs up the parent leg.
      res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
      logVoiceWebhookExit("voice-twiml-browser-dial-status", req, res, start);
    } catch (err: any) {
      console.error(
        `[Twilio Webhook][voice-twiml-browser-dial-status] fallback_twiml=true category=unhandled_handler_error reason=${JSON.stringify(
          err?.message ?? String(err),
        )}`,
        err?.stack,
      );
      (res.locals as Record<string, unknown>).twilioFallbackCategory = "unhandled_handler_error";
      res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
      logVoiceWebhookExit("voice-twiml-browser-dial-status", req, res, start);
    }
  });

  // Task #853: Server-Sent Events stream for real-time inbound replies.
  // Conversation Hub subscribes once on mount; the inbound SMS webhook
  // broadcasts a `message:new` event after persisting each row so new
  // replies render in <1s without waiting for the next 5s poll. Clients
  // continue polling at a slower cadence as a fallback.
  app.get("/api/twilio/events", isAuthenticated, requireTwilioAccess, async (req: any, res) => {
    const { addTwilioEventSubscriber } = await import("../services/twilioEvents");
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders?.();
    res.write(`event: ready\ndata: {}\n\n`);
    // Task #1272: scope the subscriber to the authenticated user so
    // `call:status` events for that user's outbound forward calls are
    // only delivered to their own browser tabs. SMS events (message:new
    // / message:status) ignore the userId filter and still broadcast.
    const userId = req.user?.claims?.sub ?? null;
    const unsubscribe = addTwilioEventSubscriber(res, { userId });
    // Heartbeat every 25s to keep proxies (and EventSource) from
    // dropping idle connections.
    const heartbeat = setInterval(() => {
      try {
        res.write(`: heartbeat\n\n`);
      } catch {
        /* connection closed; cleanup happens via 'close' below */
      }
    }, 25000);
    // Task #2855 — connection-lifetime observability (mirrors Task #2840 on
    // /api/notifications/events). Express's request logger only fires on
    // `finish`, which a dropped SSE socket never reaches (it emits `close`
    // without `finish`), so established-stream drops were invisible in the
    // logs. Log the lifetime on close, guarded against close+aborted
    // double-fire, so a genuine proxy/LB drop pattern shows up with real
    // durations.
    const connectedAt = Date.now();
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearInterval(heartbeat);
      unsubscribe();
      const lifetimeMs = Date.now() - connectedAt;
      console.log(
        `[twilioEvents] SSE closed user=${userId} after ${Math.round(lifetimeMs / 1000)}s`,
      );
    };
    req.on("close", cleanup);
    req.on("aborted", cleanup);
  });

  app.get("/api/twilio/conversations", isAuthenticated, requireTwilioAccess, async (req: any, res) => {
    // Task #848: route-level timing for before/after verification. Gated
    // behind DEBUG_TWILIO_PERF=1 so we don't log on every request in prod
    // (avoids noisy logs and incidental exposure of search terms).
    const perf = process.env.DEBUG_TWILIO_PERF === "1";
    const t0 = perf ? process.hrtime.bigint() : null;
    try {
      const conversations = await twilioStorage.listTwilioConversationsWithClients({
        clientId: req.query.clientId as string,
        status: req.query.status as string,
        search: req.query.search as string,
      });
      if (perf && t0) {
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        console.log(`[Twilio][perf] GET /conversations storage=${ms.toFixed(1)}ms rows=${conversations.length}`);
      }
      res.json(conversations);
    } catch (error: any) {
      console.error("[Twilio] List conversations error:", error.message);
      res.status(500).json({ error: "Failed to list conversations" });
    }
  });

  app.get("/api/twilio/conversations/:id", isAuthenticated, requireTwilioAccess, async (req: any, res) => {
    try {
      const conv = await twilioStorage.getTwilioConversation(req.params.id);
      if (!conv) return res.status(404).json({ error: "Conversation not found" });
      res.json(conv);
    } catch (error: any) {
      res.status(500).json({ error: "Failed to get conversation" });
    }
  });

  app.get("/api/twilio/conversations/:id/messages", isAuthenticated, requireTwilioAccess, async (req: any, res) => {
    const perf = process.env.DEBUG_TWILIO_PERF === "1";
    const t0 = perf ? process.hrtime.bigint() : null;
    try {
      const limit = req.query.limit ? parseInt(req.query.limit as string) : 100;
      // Task #848 Phase 5: optional incremental fetch via afterId/since.
      // Existing callers without these params get the same response shape.
      // Task #875: also accept `updatedSince` so the thread view can poll
      // for in-place status mutations (queued → sent → delivered) that
      // never bump created_at and would otherwise be invisible to the
      // afterId-based incremental fetch.
      const afterId = (req.query.afterId as string) || undefined;
      const sinceRaw = (req.query.since as string) || undefined;
      const updatedSinceRaw = (req.query.updatedSince as string) || undefined;
      const since = sinceRaw ? new Date(sinceRaw) : undefined;
      const updatedSince = updatedSinceRaw ? new Date(updatedSinceRaw) : undefined;
      const messages = await twilioStorage.listTwilioMessages(req.params.id, limit, {
        afterId,
        since: since && !isNaN(since.getTime()) ? since : undefined,
        updatedSince: updatedSince && !isNaN(updatedSince.getTime()) ? updatedSince : undefined,
      });
      if (perf && t0) {
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        const mode = afterId ? "incremental" : (since ? "since" : "full");
        console.log(`[Twilio][perf] GET /messages mode=${mode} storage=${ms.toFixed(1)}ms rows=${messages.length}`);
      }
      res.json(messages);
    } catch (error: any) {
      console.error("[Twilio] List messages error:", error.message);
      res.status(500).json({ error: "Failed to list messages" });
    }
  });

  app.post("/api/twilio/conversations/:id/messages", isAuthenticated, requireTwilioAccess, async (req: any, res) => {
    // Task #848: route timing with step-level breakdown — gated behind
    // DEBUG_TWILIO_PERF=1 so production logs stay clean.
    const perf = process.env.DEBUG_TWILIO_PERF === "1";
    const tStart = perf ? process.hrtime.bigint() : 0n;
    const mark = (label: string, from: bigint) =>
      `${label}=${(Number(process.hrtime.bigint() - from) / 1e6).toFixed(1)}ms`;
    try {
      const tConv = perf ? process.hrtime.bigint() : 0n;
      const conv = await twilioStorage.getTwilioConversation(req.params.id);
      const convMark = perf ? mark("conv", tConv) : "";
      if (!conv) return res.status(404).json({ error: "Conversation not found" });

      const parsed = messageBodySchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

      let body = parsed.data.body;

      // Task #848 Phase 9: single user lookup at the top, sign-off appended once,
      // then reused for every recipient.
      const tUser = perf ? process.hrtime.bigint() : 0n;
      const [user] = await db.select().from(users).where(eq(users.id, req.user.claims.sub));
      const userMark = perf ? mark("user", tUser) : "";
      if (user?.smsSignOff) {
        body = `${body}\n\n${user.smsSignOff}`;
      }

      const { sendSms, getTwilioConfig, TwilioOutboundOperationError, deriveOutboundOperationId } = await import("../services/twilioService");

      // Task #3896 (audit B-003): when the client supplied an idempotency
      // key, derive a stable per-recipient operation id so a duplicate POST
      // of this same submission reuses the same durable rows instead of
      // dispatching again. `scopeId` = the conversation id so the same key
      // can never collide across threads.
      const clientKey = parsed.data.clientOperationId;
      const opIdFor = (recipient: string): string | undefined =>
        clientKey
          ? deriveOutboundOperationId({
              userId: req.user.claims.sub,
              routeTag: "conv-msg",
              clientKey,
              recipient,
              scopeId: conv.id,
            })
          : undefined;

      // Task #883: read the configured Messaging Service SID once so the
      // per-recipient failed-row writes can record what transport the
      // send would have used, matching what `sendSms` writes on the
      // success path.
      const tCfg = await getTwilioConfig();
      const failedMessagingServiceSid = tCfg?.messagingServiceSid?.trim() || null;

      const rawParticipants = conv.participants as Participant[] | null;
      const participants: Participant[] = Array.isArray(rawParticipants) && rawParticipants.length > 0
        ? rawParticipants
        : [{ phone: conv.contactPhone }];

      // Task #848 Phase 6: parallelize Twilio sends. Per-recipient errors are
      // captured per-result so a single failure no longer fails the whole send.
      const tSends = perf ? process.hrtime.bigint() : 0n;
      const settled = await Promise.allSettled(
        participants.map(p =>
          sendSms({ to: p.phone, body, userId: req.user.claims.sub, conversationId: conv.id, operationId: opIdFor(p.phone) })
            .then(result => ({ phone: p.phone, ok: true as const, result }))
            .catch(err => ({ phone: p.phone, ok: false as const, err })),
        ),
      );

      const results: Array<Record<string, unknown>> = [];
      const failedInserts: Promise<unknown>[] = [];
      for (let i = 0; i < settled.length; i++) {
        const r = settled[i];
        if (r.status === "fulfilled" && r.value.ok) {
          results.push({ phone: r.value.phone, ...r.value.result });
        } else {
          const phone = participants[i].phone;
          const errObj = r.status === "fulfilled" ? (r.value.ok === false ? r.value.err : undefined) : r.reason;
          const errMsg = errObj instanceof Error ? errObj.message : "Unknown error";
          // Task #3896: `sendSms` now persists its own failed operation row
          // (with errorMessage) whenever the failure happened at/after the
          // dispatch claim. Only pre-claim failures (Twilio unconfigured,
          // conversation resolution, …) still need this route-level audit
          // row — inserting both would double-record the failure.
          const alreadyPersisted =
            errObj instanceof TwilioOutboundOperationError && !!errObj.operationRowId;
          if (!alreadyPersisted) {
            // Persist a failed message row for audit, in parallel.
            failedInserts.push(
              twilioStorage.createTwilioMessage({
                conversationId: conv.id,
                twilioSid: null,
                direction: "outbound",
                fromNumber: conv.twilioPhoneNumber || "",
                toNumber: phone,
                body,
                status: "failed",
                // Task #883: record what transport the send WOULD have
                // used so the thread badge stays consistent with successful
                // rows. Null = legacy single-`from` path.
                messagingServiceSid: failedMessagingServiceSid,
                sentByUserId: req.user.claims.sub,
              }),
            );
          }
          results.push({ phone, status: "failed", error: errMsg });
        }
      }
      if (failedInserts.length > 0) {
        await Promise.allSettled(failedInserts);
      }

      if (perf) {
        const sendsMark = mark("sends", tSends);
        const totalMark = mark("total", tStart);
        const okCount = results.filter(r => r.status === "sent").length;
        console.log(
          `[Twilio][perf] POST /messages recipients=${participants.length} ok=${okCount} ${convMark} ${userMark} ${sendsMark} ${totalMark}`,
        );
      }

      if (participants.length === 1) {
        res.json(results[0]);
      } else {
        res.json({ results });
      }
    } catch (error: any) {
      console.error("[Twilio] Send message error:", error.message);
      res.status(500).json({ error: error.message || "Failed to send message" });
    }
  });

  // Task #950: lookup-as-you-type for the New Message manual phone input.
  // Returns up to ~5 client-contact matches so the UI can offer a "did you
  // mean this client?" suggestion instead of forcing a client-less thread.
  // Task #969: ranked client suggestions for the Link-to-client picker on
  // the Conversation Hub. Surfaces the most likely firm(s) for an
  // unmatched conversation (saved-contact match, prior matched calls,
  // prior matched conversations) so an admin can one-click instead of
  // searching the full firm list.
  app.get("/api/twilio/client-suggestions", isAuthenticated, requireTwilioAccess, async (req: any, res) => {
    try {
      const phone = typeof req.query.phone === "string" ? req.query.phone : "";
      const limitRaw = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : NaN;
      const limit = Number.isFinite(limitRaw) ? limitRaw : 5;
      const suggestions = await twilioStorage.getClientSuggestionsForPhone(phone, limit);
      res.json(suggestions);
    } catch (error: any) {
      console.error("[Twilio] Client suggestions error:", error.message);
      res.status(500).json({ error: "Failed to fetch suggestions" });
    }
  });

  app.get("/api/twilio/client-contacts/search", isAuthenticated, requireTwilioAccess, async (req: any, res) => {
    try {
      const phone = typeof req.query.phone === "string" ? req.query.phone : "";
      const limitRaw = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : NaN;
      const limit = Number.isFinite(limitRaw) ? limitRaw : 5;
      const matches = await twilioStorage.searchClientContactsByPhone(phone, limit);
      res.json(matches);
    } catch (error: any) {
      console.error("[Twilio] Search client contacts by phone error:", error.message);
      res.status(500).json({ error: "Failed to search contacts" });
    }
  });

  app.post("/api/twilio/conversations/:id/read", isAuthenticated, requireTwilioAccess, async (req: any, res) => {
    try {
      const conv = await twilioStorage.markTwilioConversationRead(req.params.id);
      if (!conv) return res.status(404).json({ error: "Conversation not found" });
      res.json(conv);
    } catch (error: any) {
      res.status(500).json({ error: "Failed to mark as read" });
    }
  });

  // ============================================
  // Task #850: Thread notes + assignments
  // ============================================
  // Bulk fetch — used by the Conversation Hub to merge notes/assignments
  // into the unified thread list in one round-trip.
  app.get("/api/twilio/threads/notes", isAuthenticated, requireTwilioAccess, async (req: any, res) => {
    try {
      // Task #1700 — Bulk fetch used by the Conversation Hub to paint
      // per-thread note counts/badges across the inbox in a single
      // round-trip. Optional `keys` query param (comma-separated, or
      // repeated `?keys=...&keys=...`) narrows the scan; when omitted
      // we return every note (mirrors the assignments endpoint, and
      // the `thread_notes` table is small).
      const raw = req.query?.keys;
      let keys: string[] | null = null;
      if (Array.isArray(raw)) {
        keys = raw
          .flatMap((v: any) => String(v).split(","))
          .map((k) => k.trim())
          .filter(Boolean);
      } else if (typeof raw === "string" && raw.length > 0) {
        keys = raw.split(",").map((k) => k.trim()).filter(Boolean);
      }
      const notes = keys && keys.length > 0
        ? await twilioStorage.listThreadNotesForKeys(keys)
        : await twilioStorage.listAllThreadNotes();
      res.json(notes);
    } catch (error: any) {
      console.error("[Twilio] List thread notes (bulk) error:", error.message);
      res.status(500).json({ error: "Failed to list notes" });
    }
  });

  app.get("/api/twilio/threads/assignments", isAuthenticated, requireTwilioAccess, async (_req: any, res) => {
    try {
      const rows = await twilioStorage.listThreadAssignments();
      res.json(rows);
    } catch (error: any) {
      console.error("[Twilio] List thread assignments error:", error.message);
      res.status(500).json({ error: "Failed to list assignments" });
    }
  });

  app.get("/api/twilio/threads/:key/notes", isAuthenticated, requireTwilioAccess, async (req: any, res) => {
    try {
      const notes = await twilioStorage.listThreadNotes(req.params.key);
      res.json(notes);
    } catch (error: any) {
      console.error("[Twilio] List thread notes error:", error.message);
      res.status(500).json({ error: "Failed to list notes" });
    }
  });

  const threadNoteBodySchema = z.object({
    body: z.string().trim().min(1, "Note cannot be empty").max(5000, "Note too long"),
  });

  app.post("/api/twilio/threads/:key/notes", isAuthenticated, requireTwilioAccess, async (req: any, res) => {
    try {
      const parsed = threadNoteBodySchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
      const note = await twilioStorage.createThreadNote({
        threadKey: req.params.key,
        body: parsed.data.body,
        createdByUserId: req.user.claims.sub,
      });

      // Task #1688 — Per-user inbox: parse @mentions in the note body
      // and notify each mentioned user (excluding the note author).
      const mentionedSet = new Set<string>();
      try {
        const { resolveMentionsToUserIds, excludeActor } = await import(
          "../services/notifications/recipients"
        );
        const { notifyUser } = await import(
          "../services/notifications/userInbox"
        );
        const mentioned = excludeActor(
          await resolveMentionsToUserIds(parsed.data.body),
          req.user.claims.sub,
        );
        for (const uid of mentioned) mentionedSet.add(uid);
        const preview = parsed.data.body.length > 200
          ? parsed.data.body.slice(0, 197) + "..."
          : parsed.data.body;
        for (const uid of mentioned) {
          await notifyUser(uid, {
            category: "mention",
            title: "You were mentioned in a thread note",
            body: preview,
            deepLink: `/conversation-hub?threadKey=${encodeURIComponent(req.params.key)}`,
            dedupeKey: `mention:note:${note.id}:${uid}`,
            metadata: {
              threadKey: req.params.key,
              noteId: note.id,
              actorUserId: req.user.claims.sub,
            },
          });
        }
      } catch (err: any) {
        console.warn("[Twilio] note mention notifyUser failed:", err?.message ?? err);
      }

      // Task #1703 — Per-user inbox: also notify prior thread
      // participants (other note authors / past or current assignees)
      // that a teammate added a note, excluding the actor and anyone
      // we already pinged via @mention above. Per-thread / per-author
      // / per-hour dedupe so a chatty thread doesn't flood the bell.
      try {
        const { getThreadParticipants, excludeActor } = await import(
          "../services/notifications/recipients"
        );
        const { notifyUser } = await import(
          "../services/notifications/userInbox"
        );
        const actorId = req.user.claims.sub as string;
        const participants = excludeActor(
          await getThreadParticipants(req.params.key),
          actorId,
        ).filter((uid) => !mentionedSet.has(uid));
        if (participants.length > 0) {
          const [actor] = await getDb()
            .select({ firstName: users.firstName, lastName: users.lastName, email: users.email })
            .from(users)
            .where(eq(users.id, actorId))
            .limit(1);
          const actorLabel =
            [actor?.firstName, actor?.lastName].filter(Boolean).join(" ").trim() ||
            actor?.email ||
            "A teammate";
          const preview = parsed.data.body.length > 200
            ? parsed.data.body.slice(0, 197) + "..."
            : parsed.data.body;
          const hourBucket = Math.floor(Date.now() / (60 * 60 * 1000));
          for (const uid of participants) {
            await notifyUser(uid, {
              category: "mention",
              title: `${actorLabel} added a note to a thread you're watching`,
              body: preview,
              deepLink: `/conversation-hub?threadKey=${encodeURIComponent(req.params.key)}`,
              dedupeKey: `thread-reply:${req.params.key}:${actorId}:${hourBucket}:${uid}`,
              metadata: {
                threadKey: req.params.key,
                noteId: note.id,
                actorUserId: actorId,
                replyKind: "note",
              },
            });
          }
        }
      } catch (err: any) {
        console.warn(
          "[Twilio] note thread-participant notifyUser failed:",
          err?.message ?? err,
        );
      }

      res.json(note);
    } catch (error: any) {
      console.error("[Twilio] Create thread note error:", error.message);
      res.status(500).json({ error: "Failed to create note" });
    }
  });

  app.delete("/api/twilio/threads/notes/:id", isAuthenticated, requireTwilioAccess, async (req: any, res) => {
    try {
      const ok = await twilioStorage.deleteThreadNote(req.params.id, req.user.claims.sub);
      if (!ok) return res.status(404).json({ error: "Note not found or not yours" });
      res.json({ ok: true });
    } catch (error: any) {
      console.error("[Twilio] Delete thread note error:", error.message);
      res.status(500).json({ error: "Failed to delete note" });
    }
  });

  app.get("/api/twilio/threads/:key/assignment", isAuthenticated, requireTwilioAccess, async (req: any, res) => {
    try {
      const row = await twilioStorage.getThreadAssignment(req.params.key);
      res.json(row || { threadKey: req.params.key, assignedToUserId: null, status: "open", updatedByUserId: null, updatedAt: null });
    } catch (error: any) {
      console.error("[Twilio] Get thread assignment error:", error.message);
      res.status(500).json({ error: "Failed to get assignment" });
    }
  });

  // Task #1698: format-whitelist guard for the unified thread key. The
  // key is virtual (see `resolveThreadKey` in
  // `client/src/lib/conversationModel.ts` and the Task #1685 design note
  // in `replit.md`) and may not have a backing `twilio_conversations`
  // row yet — SMS, call-only, voicemail, and missed-call threads all
  // share this keyspace. We only police the shape so the route can't be
  // used to write assignments against arbitrary garbage strings.
  const ALLOWED_THREAD_KEY_PREFIXES = [
    "group:",
    "contact:",
    "client-phone:",
    "phone:",
    "call:",
    "voicemail:",
    "missed-call:",
  ];
  const isAllowedVirtualThreadKey = (key: string): boolean => {
    for (const p of ALLOWED_THREAD_KEY_PREFIXES) {
      if (key.startsWith(p) && key.length > p.length) return true;
    }
    return false;
  };

  const threadAssignmentBodySchema = z.object({
    assignedToUserId: z.string().nullable().optional(),
    status: z.enum(["open", "needs_follow_up", "resolved"]).optional(),
  }).refine(
    (v) => v.assignedToUserId !== undefined || v.status !== undefined,
    { message: "Provide assignedToUserId and/or status" },
  );

  // Task #1288 — Per-user inbox of "you were assigned to this thread"
  // pings. The Conversation Hub queries unread on load to render a badge
  // on the "Mine" chip and a one-time toast.
  app.get(
    "/api/twilio/threads/assignment-notifications",
    isAuthenticated,
    requireTwilioAccess,
    async (req: any, res) => {
      try {
        const rows = await twilioStorage.listUnreadAssignmentNotifications(req.user.claims.sub);
        res.json(rows);
      } catch (error: any) {
        console.error("[Twilio] List assignment notifications error:", error.message);
        res.status(500).json({ error: "Failed to list assignment notifications" });
      }
    },
  );

  const markAssignmentNotificationsBodySchema = z.object({
    ids: z.array(z.string()).max(500).optional(),
  });

  app.post(
    "/api/twilio/threads/assignment-notifications/mark-read",
    isAuthenticated,
    requireTwilioAccess,
    async (req: any, res) => {
      try {
        const parsed = markAssignmentNotificationsBodySchema.safeParse(req.body ?? {});
        if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
        const updated = await twilioStorage.markAssignmentNotificationsRead(
          req.user.claims.sub,
          parsed.data.ids,
        );
        res.json({ updated });
      } catch (error: any) {
        console.error("[Twilio] Mark assignment notifications read error:", error.message);
        res.status(500).json({ error: "Failed to mark notifications read" });
      }
    },
  );

  // ============================================
  // Task #1685 — read/unread + assignees endpoints
  // ============================================
  //
  // Read/unread is stored GLOBALLY (one row per thread, no `user_id`)
  // because the existing source of truth for unread — the
  // `twilio_conversations.unread_count` column that drives the row badge,
  // the Unread filter chip, and the auto-mark-on-open effect — is itself
  // global. Splitting just the manual toggle into per-user state without
  // also splitting `unread_count` would create two unread sources of
  // truth that immediately drift (operator A clears it for everyone,
  // operator B sees stale unread). The task brief preferred per-user but
  // explicitly allowed keeping global if changing the existing model
  // would be too broad — that's the situation here.
  //
  // Body: `{ read: true | false, smsConversationIds?: string[] }`.
  //  - `read: true`  → manually_unread=false AND mark every SMS conv in
  //    `smsConversationIds` as read (unread_count=0). The hub passes the
  //    thread's SMS conv ids; the server doesn't recompute the threadKey
  //    so call-only / voicemail-only threads still work.
  //  - `read: false` → manually_unread=true. The SMS unread_count column
  //    is left alone — the badge already shows the thread as unread via
  //    the manual flag, and clobbering unread_count would lose the real
  //    inbound count if any.
  const threadReadStateBodySchema = z.object({
    read: z.boolean(),
    smsConversationIds: z.array(z.string().min(1)).max(50).optional(),
  });

  app.get(
    "/api/twilio/threads/read-states",
    isAuthenticated,
    requireTwilioAccess,
    async (_req: any, res) => {
      try {
        const rows = await twilioStorage.listThreadReadStates();
        res.json(rows);
      } catch (error: any) {
        console.error("[Twilio] List thread read states error:", error.message);
        res.status(500).json({ error: "Failed to list read states" });
      }
    },
  );

  app.patch(
    "/api/twilio/threads/:key/read-state",
    isAuthenticated,
    requireTwilioAccess,
    async (req: any, res) => {
      try {
        const parsed = threadReadStateBodySchema.safeParse(req.body);
        if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
        const threadKey = req.params.key;
        if (!threadKey || typeof threadKey !== "string") {
          return res.status(400).json({ error: "Invalid thread key" });
        }
        // Derive the canonical set of SMS conv IDs that actually belong
        // to this thread. Doubles as the existence check: if the key
        // doesn't resolve to a real thread we return 404 without
        // touching any row (review finding #1). Call-only / voicemail
        // threads correctly return an empty list — there's no SMS conv
        // to clear, but the manual flag still writes below.
        const allowedConvIds = new Set(await twilioStorage.listThreadSmsConversationIds(threadKey));
        const exists = allowedConvIds.size > 0 || await twilioStorage.threadKeyExists(threadKey);
        if (!exists) {
          return res.status(404).json({ error: "Thread not found" });
        }
        // Validate every client-supplied conv ID against the thread's
        // own ID set. Without this, an authorized operator could send
        // arbitrary conv IDs and accidentally clear unread counts on
        // unrelated threads (review finding #2).
        const requestedIds = parsed.data.read ? (parsed.data.smsConversationIds ?? []) : [];
        const invalidIds = requestedIds.filter((id) => !allowedConvIds.has(id));
        if (invalidIds.length > 0) {
          return res.status(400).json({
            error: "smsConversationIds contains ids that do not belong to this thread",
            invalidIds,
          });
        }
        // Single transaction so the unread-count clears and the
        // `thread_read_states` upsert succeed or fail as one unit
        // (review finding #1). Any thrown error rolls everything back
        // and the catch block below surfaces a 500.
        const result = await getDb().transaction(async (tx) => {
          const clearedIds: string[] = [];
          if (requestedIds.length > 0) {
            for (const convId of requestedIds) {
              const [updated] = await tx
                .update(twilioConversations)
                .set({ unreadCount: 0, updatedAt: new Date() })
                .where(eq(twilioConversations.id, convId))
                .returning({ id: twilioConversations.id });
              if (updated) clearedIds.push(updated.id);
            }
          }
          const [row] = await tx
            .insert(threadReadStates)
            .values({
              threadKey,
              manuallyUnread: !parsed.data.read,
              updatedByUserId: req.user.claims.sub,
              updatedAt: new Date(),
            })
            .onConflictDoUpdate({
              target: threadReadStates.threadKey,
              set: {
                manuallyUnread: !parsed.data.read,
                updatedByUserId: req.user.claims.sub,
                updatedAt: new Date(),
              },
            })
            .returning();
          return { row, clearedIds };
        });
        res.json({
          threadKey: result.row.threadKey,
          manuallyUnread: result.row.manuallyUnread,
          updatedByUserId: result.row.updatedByUserId,
          updatedAt: result.row.updatedAt,
          smsConversationIdsCleared: result.clearedIds,
        });
      } catch (error: any) {
        console.error("[Twilio] Update thread read state error:", error.message);
        res.status(500).json({ error: "Failed to update read state" });
      }
    },
  );

  // Eligible assignees for the thread-header Assign popover. Returns
  // every internal user; the underlying `users` table has no active /
  // disabled column today (see shared/models/auth.ts), so we don't try
  // to filter by activity status — `requireTwilioAccess` already gates
  // who can even see this endpoint. Sorted by display name for a
  // predictable popover.
  app.get(
    "/api/twilio/threads/assignees",
    isAuthenticated,
    requireTwilioAccess,
    async (_req: any, res) => {
      try {
        const rows = await getDb()
          .select({
            id: users.id,
            firstName: users.firstName,
            lastName: users.lastName,
            email: users.email,
            role: users.role,
          })
          .from(users);
        const sorted = rows.slice().sort((a, b) => {
          const an = [a.firstName, a.lastName].filter(Boolean).join(" ").trim() || a.email || "";
          const bn = [b.firstName, b.lastName].filter(Boolean).join(" ").trim() || b.email || "";
          return an.localeCompare(bn);
        });
        res.json(sorted);
      } catch (error: any) {
        console.error("[Twilio] List assignees error:", error.message);
        res.status(500).json({ error: "Failed to list assignees" });
      }
    },
  );

  app.patch("/api/twilio/threads/:key/assignment", isAuthenticated, requireTwilioAccess, async (req: any, res) => {
    try {
      const parsed = threadAssignmentBodySchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
      const threadKey = req.params.key;
      if (!threadKey || typeof threadKey !== "string") {
        return res.status(400).json({ error: "Invalid thread key" });
      }
      // Task #1685 / Task #1698: the unified thread key is virtual and
      // covers SMS, call-only, voicemail, and missed-call threads that
      // may not yet have a `twilio_conversations` row. Validate the key
      // shape against a whitelist of prefixes produced by
      // `resolveThreadKey` instead of requiring a pre-existing row, so
      // assignment upserts succeed for `phone:<digits>`, `call:<sid>`,
      // `voicemail:<sid>`, etc.
      if (!isAllowedVirtualThreadKey(threadKey)) {
        return res.status(400).json({ error: "Invalid thread key" });
      }
      // Task #1685: validate the assignee against the same eligibility
      // contract exposed by `GET /api/twilio/threads/assignees`. Today
      // that's "exists in the users table" — the route owner gates who
      // can call this endpoint via `requireTwilioAccess`. If/when the
      // users table grows an `active` column, both this check and the
      // assignees listing will start filtering on it together.
      if (parsed.data.assignedToUserId) {
        const [eligible] = await getDb()
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, parsed.data.assignedToUserId))
          .limit(1);
        if (!eligible) {
          return res.status(400).json({ error: "Assignee is not an eligible user" });
        }
      }
      const row = await twilioStorage.upsertThreadAssignment({
        threadKey,
        assignedToUserId: parsed.data.assignedToUserId,
        status: parsed.data.status,
        updatedByUserId: req.user.claims.sub,
      });

      // Task #1688 — Per-user inbox: ping the newly assigned user
      // (skipped if they assigned the thread to themselves).
      if (
        parsed.data.assignedToUserId &&
        parsed.data.assignedToUserId !== req.user.claims.sub
      ) {
        try {
          const { notifyUser } = await import(
            "../services/notifications/userInbox"
          );
          await notifyUser(parsed.data.assignedToUserId, {
            category: "assignment",
            title: "You were assigned to a conversation",
            body: `Thread ${threadKey}`,
            deepLink: `/conversation-hub?threadKey=${encodeURIComponent(threadKey)}`,
            dedupeKey: `assignment:${threadKey}:${parsed.data.assignedToUserId}`,
            metadata: {
              threadKey,
              status: parsed.data.status ?? null,
              actorUserId: req.user.claims.sub,
            },
          });
        } catch (err: any) {
          console.warn("[Twilio] assignment notifyUser failed:", err?.message ?? err);
        }
      }

      res.json(row);
    } catch (error: any) {
      console.error("[Twilio] Upsert thread assignment error:", error.message);
      res.status(500).json({ error: "Failed to update assignment" });
    }
  });

  app.post("/api/twilio/conversations", isAuthenticated, requireTwilioAccess, async (req: any, res) => {
    try {
      const parsed = createConversationSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

      const { contacts, body } = parsed.data;
      const clientId = parsed.data.clientId ?? null;
      // Task #3896 (audit B-003): stable per-recipient operation identity for
      // duplicate POSTs of this same submission. No `scopeId`: the identity
      // is (user, route, key, recipient), so a replayed request dedupes
      // whether it lands on the existing-group path or the create path.
      const clientKey = parsed.data.clientOperationId;
      const seenPhones = new Set<string>();
      const normalizedContacts = contacts
        .map(c => ({ ...c, phone: normalizePhone(c.phone) }))
        .filter(c => {
          if (seenPhones.has(c.phone)) return false;
          seenPhones.add(c.phone);
          return true;
        });
      const isGroup = normalizedContacts.length > 1;

      const allConvs = await twilioStorage.listTwilioConversations({ clientId: clientId ?? undefined });

      if (isGroup) {
        const normalizedSet = new Set(normalizedContacts.map(c => normalizePhone(c.phone)));
        const existingGroup = allConvs.find(c => {
          if (c.conversationType !== "group") return false;
          const convParts = c.participants as Participant[] | null;
          if (!Array.isArray(convParts) || convParts.length !== normalizedSet.size) return false;
          return convParts.every(p => normalizedSet.has(normalizePhone(p.phone)));
        });
        if (existingGroup) {
          let msgBody = body;
          const [user] = await db.select().from(users).where(eq(users.id, req.user.claims.sub));
          if (user?.smsSignOff) msgBody = `${msgBody}\n\n${user.smsSignOff}`;

          const { sendSms, getTwilioConfig, TwilioOutboundOperationError, deriveOutboundOperationId } = await import("../services/twilioService");
          const tConfig = await getTwilioConfig();
          const tFrom = tConfig?.phoneNumbers?.[0] || existingGroup.twilioPhoneNumber || "";
          // Task #883: same transport-recording rule as the per-thread send path.
          const failedMessagingServiceSid = tConfig?.messagingServiceSid?.trim() || null;
          // Task #848 Phase 6: parallel Twilio sends.
          const settled = await Promise.allSettled(
            normalizedContacts.map(contact =>
              sendSms({
                to: contact.phone,
                body: msgBody,
                userId: req.user.claims.sub,
                conversationId: existingGroup.id,
                operationId: clientKey
                  ? deriveOutboundOperationId({
                      userId: req.user.claims.sub,
                      routeTag: "conversations-create",
                      clientKey,
                      recipient: contact.phone,
                    })
                  : undefined,
              })
                .then(result => ({ phone: contact.phone, ok: true as const, result }))
                .catch(err => ({ phone: contact.phone, ok: false as const, err })),
            ),
          );
          const results: Array<Record<string, unknown>> = [];
          const failedInserts: Promise<unknown>[] = [];
          for (let i = 0; i < settled.length; i++) {
            const r = settled[i];
            if (r.status === "fulfilled" && r.value.ok) {
              results.push({ phone: r.value.phone, ...r.value.result });
            } else {
              const phone = normalizedContacts[i].phone;
              const errObj = r.status === "fulfilled" ? (r.value.ok === false ? r.value.err : undefined) : r.reason;
              const errMsg = errObj instanceof Error ? errObj.message : "Unknown error";
              // Task #3896: skip the route-level audit row when sendSms
              // already persisted the failed operation row (see the
              // per-thread send path for the full rationale).
              const alreadyPersisted =
                errObj instanceof TwilioOutboundOperationError && !!errObj.operationRowId;
              if (!alreadyPersisted) {
                failedInserts.push(twilioStorage.createTwilioMessage({
                  conversationId: existingGroup.id,
                  twilioSid: null,
                  direction: "outbound",
                  fromNumber: tFrom,
                  toNumber: phone,
                  body: msgBody,
                  status: "failed",
                  messagingServiceSid: failedMessagingServiceSid,
                  sentByUserId: req.user.claims.sub,
                }));
              }
              results.push({ phone, status: "failed", error: errMsg });
            }
          }
          if (failedInserts.length > 0) await Promise.allSettled(failedInserts);
          return res.json({ conversationId: existingGroup.id, isNew: false, results });
        }
      }

      // Task #849 — direct-thread reuse uses the canonical normalized
      // key (computed against the actual outbound Twilio number, not an
      // arbitrary existing conv's number). We delegate to
      // `findOrCreateDirectConversation` so a thread created earlier
      // with raw `(267) 639-8995` is collapsed against an outbound to
      // `+12676398995` rather than starting a duplicate.
      const { findOrCreateDirectConversation } = await import("../services/conversationDedupe");

      let msgBody = body;
      const [user] = await db.select().from(users).where(eq(users.id, req.user.claims.sub));
      if (user?.smsSignOff) msgBody = `${msgBody}\n\n${user.smsSignOff}`;

      const { getTwilioConfig } = await import("../services/twilioService");
      const twilioConfig = await getTwilioConfig();
      const twilioFrom = twilioConfig?.phoneNumbers?.[0] || "";
      // Task #883: same transport-recording rule as the per-thread send path.
      const failedMessagingServiceSid = twilioConfig?.messagingServiceSid?.trim() || null;

      const primaryContact = normalizedContacts[0];
      let conv: Awaited<ReturnType<typeof twilioStorage.createTwilioConversation>>;
      let isNewThread: boolean;
      if (isGroup) {
        conv = await twilioStorage.createTwilioConversation({
          clientId,
          clientContactId: primaryContact.contactId || null,
          contactPhone: primaryContact.phone,
          contactName: normalizedContacts.map(c => c.name || c.phone).join(", "),
          twilioPhoneNumber: twilioFrom,
          status: "active",
          conversationType: "group",
          participants: normalizedContacts,
          lastMessageAt: new Date(),
          lastMessagePreview: body.substring(0, 100),
          unreadCount: 0,
        });
        isNewThread = true;
      } else {
        // Direct thread: use the dedupe service so two operators creating
        // the same thread concurrently both end up on the same row, and so
        // the row is written with normalized columns + directThreadKey.
        // We ALWAYS send the message after this returns — `created=false`
        // can mean either "found existing thread" (POST is asking us to
        // open a thread AND send a message) or "lost the insert race".
        // Either way, the user clicked "send", so the message must go
        // out. Per-message idempotency is handled at the message layer
        // (Twilio assigns a unique SID per send and the partial unique
        // index on `twilio_messages.twilioSid` prevents inbound webhook
        // double-recording; outbound sends with body always create a new
        // SID).
        const created = await findOrCreateDirectConversation({
          data: {
            clientId,
            clientContactId: primaryContact.contactId || null,
            contactPhone: primaryContact.phone,
            contactName: primaryContact.name || null,
            twilioPhoneNumber: twilioFrom,
            status: "active",
            conversationType: "direct",
            participants: normalizedContacts,
            lastMessageAt: new Date(),
            lastMessagePreview: body.substring(0, 100),
            unreadCount: 0,
          },
          preferClientId: clientId,
        });
        conv = created.conversation;
        isNewThread = created.created;
      }

      const { sendSms, TwilioOutboundOperationError, deriveOutboundOperationId } = await import("../services/twilioService");
      // Task #848 Phase 6: parallel Twilio sends.
      const settled = await Promise.allSettled(
        normalizedContacts.map(contact =>
          sendSms({
            to: contact.phone,
            body: msgBody,
            userId: req.user.claims.sub,
            conversationId: conv.id,
            operationId: clientKey
              ? deriveOutboundOperationId({
                  userId: req.user.claims.sub,
                  routeTag: "conversations-create",
                  clientKey,
                  recipient: contact.phone,
                })
              : undefined,
          })
            .then(result => ({ phone: contact.phone, ok: true as const, result }))
            .catch(err => ({ phone: contact.phone, ok: false as const, err })),
        ),
      );
      const results: Array<Record<string, unknown>> = [];
      const failedInserts: Promise<unknown>[] = [];
      for (let i = 0; i < settled.length; i++) {
        const r = settled[i];
        if (r.status === "fulfilled" && r.value.ok) {
          results.push({ phone: r.value.phone, ...r.value.result });
        } else {
          const phone = normalizedContacts[i].phone;
          const errObj = r.status === "fulfilled" ? (r.value.ok === false ? r.value.err : undefined) : r.reason;
          const errMsg = errObj instanceof Error ? errObj.message : "Unknown error";
          // Task #3896: skip the route-level audit row when sendSms already
          // persisted the failed operation row (see the per-thread send path
          // for the full rationale).
          const alreadyPersisted =
            errObj instanceof TwilioOutboundOperationError && !!errObj.operationRowId;
          if (!alreadyPersisted) {
            failedInserts.push(twilioStorage.createTwilioMessage({
              conversationId: conv.id,
              twilioSid: null,
              direction: "outbound",
              fromNumber: twilioFrom,
              toNumber: phone,
              body: msgBody,
              status: "failed",
              messagingServiceSid: failedMessagingServiceSid,
              sentByUserId: req.user.claims.sub,
            }));
          }
          results.push({ phone, status: "failed", error: errMsg });
        }
      }
      if (failedInserts.length > 0) await Promise.allSettled(failedInserts);

      res.json({ conversationId: conv.id, isNew: isNewThread, results });
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : "Failed to create conversation";
      console.error("[Twilio] Create conversation error:", errMsg);
      res.status(500).json({ error: errMsg });
    }
  });

  // Task #951 / #968: link, reassign, or unlink a Twilio conversation's
  // client. Race-safe in two flavors:
  //   - Link path (no `expectedClientId` in the body): conditional UPDATE
  //     with `WHERE client_id IS NULL` so two operators linking a fresh
  //     row to different clients can never both win — the loser gets 409.
  //   - Reassign / unlink path (`expectedClientId` provided, may be null):
  //     conditional UPDATE with `client_id IS NOT DISTINCT FROM
  //     $expected` so a stale UI that hasn't seen another operator's
  //     reassignment also gets 409 instead of stomping on it.
  // `clientId` may be `null` in the reassign path to detach the
  // conversation entirely; on detach we also clear `client_contact_id`
  // so the next inbound message goes back through normal matching.
  app.patch("/api/twilio/conversations/:id/client", isAuthenticated, requireTwilioAccess, async (req: any, res) => {
    try {
      const conv = await twilioStorage.getTwilioConversation(req.params.id);
      if (!conv) return res.status(404).json({ error: "Conversation not found" });

      const schema = z.object({
        clientId: z.string().min(1).nullable(),
        // `undefined` → original "must currently be null" link path.
        // `null` / string → reassign-or-unlink path keyed off the
        // operator's last-seen client_id for race detection.
        expectedClientId: z.string().min(1).nullable().optional(),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
      const { clientId, expectedClientId } = parsed.data;

      const isReassignPath = Object.prototype.hasOwnProperty.call(req.body ?? {}, "expectedClientId");
      const isUnlink = clientId === null;

      if (isUnlink && !isReassignPath) {
        return res.status(400).json({ error: "expectedClientId is required when unlinking" });
      }

      let resolvedContactId: string | null = null;
      let actionType: string;
      let actionDetail: string;

      if (isUnlink) {
        actionType = "twilio_conversation_unlink_client";
        actionDetail = `Unlinked conversation ${conv.id} from client ${expectedClientId ?? "(none)"}`;
      } else {
        const { getClient } = await import("../storage/clientStorage");
        const client = await getClient(clientId!);
        if (!client) return res.status(404).json({ error: "Client not found" });

        // Task #855: route this auto-fill through the indexed per-client
        // helper (`client_id` + `phones_normalized` GIN) instead of
        // pulling every contact for the client and scanning their phones
        // in JS. Per-client filter preserves the prior deterministic
        // behavior when the same phone exists in multiple firms'
        // rosters — we only ever fill a contact that actually belongs
        // to the client being linked.
        if (conv.contactPhone) {
          const phoneMatch = await twilioStorage.findClientContactByPhoneForClient(
            clientId!,
            conv.contactPhone,
          );
          if (phoneMatch) {
            resolvedContactId = phoneMatch.contactId;
          }
        }

        actionType = isReassignPath
          ? "twilio_conversation_reassign_client"
          : "twilio_conversation_link_client";
        actionDetail = isReassignPath
          ? `Reassigned conversation ${conv.id} from client ${expectedClientId ?? "(none)"} to client ${clientId}`
          : `Linked conversation ${conv.id} to client ${clientId}`;
      }

      const result = isReassignPath
        ? await twilioStorage.reassignConversationClient(conv.id, {
            clientId,
            clientContactId: isUnlink ? null : resolvedContactId,
            expectedClientId: expectedClientId ?? null,
          })
        : await twilioStorage.attachClientToConversation(conv.id, {
            clientId: clientId!,
            clientContactId: resolvedContactId,
          });

      if (!result.ok && result.reason === "not_found") {
        return res.status(404).json({ error: "Conversation not found" });
      }
      if (!result.ok && result.reason === "conflict") {
        return res.status(409).json({
          error: isReassignPath
            ? "This conversation was just changed by another user. Refresh and try again."
            : "This conversation was just linked to a different client by another user.",
          conversation: result.conversation,
        });
      }

      try {
        await insertActivityLogs([{
          userId: req.user?.claims?.sub ?? null,
          actionType,
          route: `/api/twilio/conversations/${conv.id}/client`,
          actionDetail,
          metadata: {
            conversationId: conv.id,
            clientId,
            previousClientId: isReassignPath ? (expectedClientId ?? null) : null,
            clientContactId: isUnlink ? null : resolvedContactId,
          },
          sessionId: null,
          duration: null,
          timestamp: new Date(),
        }]);
      } catch (logErr: any) {
        console.warn("[Twilio] activity log failed for client mutation:", logErr?.message);
      }

      res.json(result.conversation);
    } catch (error: any) {
      console.error("[Twilio] Update conversation client error:", error.message);
      res.status(500).json({ error: error.message || "Failed to update client" });
    }
  });

  app.patch("/api/twilio/conversations/:id/display-name", isAuthenticated, requireTwilioAccess, async (req: any, res) => {
    try {
      const conv = await twilioStorage.getTwilioConversation(req.params.id);
      if (!conv) return res.status(404).json({ error: "Conversation not found" });

      const schema = z.object({ displayName: z.string().max(100).nullable() });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

      const trimmed = parsed.data.displayName?.trim() || null;
      const updated = await twilioStorage.updateConversationDisplayName(conv.id, trimmed);
      res.json(updated);
    } catch (error: any) {
      console.error("[Twilio] Update display name error:", error.message);
      res.status(500).json({ error: "Failed to update display name" });
    }
  });

  app.patch("/api/twilio/conversations/:id/participants", isAuthenticated, requireTwilioAccess, async (req: any, res) => {
    try {
      const conv = await twilioStorage.getTwilioConversation(req.params.id);
      if (!conv) return res.status(404).json({ error: "Conversation not found" });

      const parsed = updateParticipantsSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

      const rawParts = conv.participants as Participant[] | null;
      const currentParticipants: Participant[] =
        (Array.isArray(rawParts) && rawParts.length > 0)
          ? [...rawParts]
          : [{ phone: conv.contactPhone, name: conv.contactName || undefined }];

      const existingPhones = new Set(currentParticipants.map(p => normalizePhone(p.phone)));

      if (parsed.data.add) {
        for (const p of parsed.data.add) {
          const normalized = normalizePhone(p.phone);
          if (!existingPhones.has(normalized)) {
            currentParticipants.push({ ...p, phone: normalized });
            existingPhones.add(normalized);
          }
        }
      }

      if (parsed.data.remove) {
        const removeSet = new Set(parsed.data.remove.map(normalizePhone));
        const filtered = currentParticipants.filter(p => !removeSet.has(normalizePhone(p.phone)));
        if (filtered.length === 0) {
          return res.status(400).json({ error: "Cannot remove all participants" });
        }
        currentParticipants.length = 0;
        currentParticipants.push(...filtered);
      }

      const isGroup = currentParticipants.length > 1;
      const primaryParticipant = currentParticipants[0];
      await twilioStorage.updateTwilioConversation(conv.id, {
        participants: currentParticipants,
        conversationType: isGroup ? "group" : "direct",
        contactPhone: primaryParticipant.phone,
        contactName: isGroup
          ? currentParticipants.map(p => p.name || p.phone).join(", ")
          : (primaryParticipant.name || primaryParticipant.phone),
      });

      const updated = await twilioStorage.getTwilioConversation(conv.id);
      res.json(updated);
    } catch (error: any) {
      console.error("[Twilio] Update participants error:", error.message);
      res.status(500).json({ error: error.message || "Failed to update participants" });
    }
  });

  app.post("/api/twilio/send-sms", isAuthenticated, requireTwilioAccess, async (req: any, res) => {
    try {
      const parsed = sendSmsSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

      let { to, body } = parsed.data;
      to = normalizePhone(to);

      const [user] = await db.select().from(users).where(eq(users.id, req.user.claims.sub));
      if (user?.smsSignOff) {
        body = `${body}\n\n${user.smsSignOff}`;
      }

      const { sendSms, deriveOutboundOperationId } = await import("../services/twilioService");
      // Task #3896 (audit B-003): duplicate POSTs of this same submission
      // (same client-minted key) reuse the same durable operation row —
      // at most one Twilio create.
      const clientKey = parsed.data.clientOperationId;
      const result = await sendSms({
        to,
        body,
        userId: req.user.claims.sub,
        operationId: clientKey
          ? deriveOutboundOperationId({
              userId: req.user.claims.sub,
              routeTag: "send-sms",
              clientKey,
              recipient: to,
            })
          : undefined,
      });
      res.json(result);
    } catch (error: any) {
      // Task #3896: a concurrent duplicate of an in-flight submission is a
      // conflict, not a server fault — 409 so the client surfaces it without
      // auto-retrying (409 is not in its transient-status set). The winning
      // request proceeds untouched. Task #4648: the in-flight state check
      // lives behind a service-layer predicate because this file must stay
      // free of snake_case status-literal spellings (compliance scan —
      // canonical Twilio statuses are hyphenated).
      const { isInProgressOutboundOperationError } = await import("../services/twilioService");
      if (isInProgressOutboundOperationError(error)) {
        console.warn("[Twilio] Send SMS rejected duplicate in-flight operation:", error.message);
        return res.status(409).json({ error: error.message });
      }
      console.error("[Twilio] Send SMS error:", error.message);
      res.status(500).json({ error: error.message || "Failed to send SMS" });
    }
  });

  // Task #874: forward-to-cell entry point. Browser-mode calls do NOT hit
  // this route — they are placed by the Twilio Voice JS SDK on the client
  // and arrive at our `voice-twiml-browser` webhook directly. This endpoint
  // therefore validates that the caller actually wants forward mode and has
  // a usable `callRoutingPhone`, and rejects with a clear 400 otherwise so a
  // misconfigured user never hears Twilio's audio error prompt.
  app.post("/api/twilio/initiate-call", isAuthenticated, requireTwilioAccess, async (req: any, res) => {
    try {
      const parsed = initiateCallSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

      const to = normalizePhone(parsed.data.to);

      const [user] = await getDb().select().from(users).where(eq(users.id, req.user.claims.sub));
      if (!user) {
        console.warn(`[Twilio] initiate-call: user ${req.user.claims.sub} not found`);
        return res.status(404).json({ error: "User not found" });
      }

      const mode = (user.callMode === "forward" ? "forward" : "browser") as "browser" | "forward";

      if (mode === "browser") {
        // Loud, structured failure: the client should be using the browser SDK
        // for browser mode. If it falls back to this endpoint we want the
        // operator to see exactly why in the server logs.
        console.warn(
          `[Twilio] initiate-call rejected: user ${user.id} is in browser mode — calls must originate from the Voice JS SDK, not /initiate-call`,
          { to },
        );
        return res.status(400).json({
          error:
            "Your call mode is set to Browser audio. Calls must be placed from the in-browser dialer, not the forward endpoint.",
        });
      }

      const routingPhone = (user.callRoutingPhone || "").trim();
      if (!routingPhone) {
        console.warn(
          `[Twilio] initiate-call rejected: user ${user.id} is in forward mode but has no callRoutingPhone configured`,
          { to },
        );
        return res.status(400).json({
          error:
            "Forward-to-phone mode requires a Call Routing Phone in your profile. Add one or switch to Browser audio mode.",
        });
      }

      const { initiateForwardCall, deriveOutboundOperationId } = await import("../services/twilioService");
      // Task #3896 (audit B-003): same duplicate-POST protection as the SMS
      // routes — one client-minted key = at most one Twilio call create.
      const clientKey = parsed.data.clientOperationId;
      const result = await initiateForwardCall({
        to,
        routingPhone: normalizePhone(routingPhone),
        userId: user.id,
        callerIdName: user.callerIdName || undefined,
        operationId: clientKey
          ? deriveOutboundOperationId({
              userId: user.id,
              routeTag: "initiate-call",
              clientKey,
              recipient: to,
            })
          : undefined,
      });
      res.json(result);
    } catch (error: any) {
      // Task #3896: concurrent duplicate of an in-flight dial → 409 (see the
      // send-sms route for the rationale, incl. the Task #4648 predicate).
      const { isInProgressOutboundOperationError } = await import("../services/twilioService");
      if (isInProgressOutboundOperationError(error)) {
        console.warn("[Twilio] Initiate call rejected duplicate in-flight operation:", error.message);
        return res.status(409).json({ error: error.message });
      }
      console.error("[Twilio] Initiate call error:", error.message);
      res.status(500).json({ error: error.message || "Failed to initiate call" });
    }
  });

  // Task #874: mint a Twilio Voice access token for the browser SDK. Identity
  // = the authenticated user id so call-log writes from `voice-twiml-browser`
  // can attribute the call. Returns 503 with a structured error payload if
  // any of the three required `system_settings` values is missing — the UI
  // surfaces this as an inline setup-needed error, not a silent failure.
  app.post("/api/twilio/voice-token", isAuthenticated, requireTwilioAccess, async (req: any, res) => {
    try {
      const { getBrowserCallingConfig, getTwilioConfig } = await import("../services/twilioService");
      const accountConfig = await getTwilioConfig();
      if (!accountConfig) {
        console.warn(`[Twilio][voice-token] Refusing token mint for user ${req.user.claims.sub} — Twilio account credentials missing`);
        return res.status(503).json({
          error: "Twilio is not configured. An admin must set the Account SID and Auth Token first.",
          missing: ["accountSid", "authToken"],
        });
      }
      const browserConfig = await getBrowserCallingConfig();
      if (!browserConfig) {
        console.warn(`[Twilio][voice-token] Refusing token mint for user ${req.user.claims.sub} — browser calling config missing`);
        return res.status(503).json({
          error:
            "Browser calling is not configured. An admin must set the Twilio API Key SID, API Key Secret, and TwiML App SID.",
          missing: ["apiKeySid", "apiKeySecret", "twimlAppSid"],
        });
      }

      const identity = req.user.claims.sub;
      // Mirror validateTwilioWebhook's default-then-namespace fallback for
      // bundled CJS interop (see line ~54).
      const twilioMod = await import("twilio");
      const sdk = twilioMod.default ?? twilioMod;
      const jwt = sdk.jwt ?? twilioMod.jwt;
      if (!jwt?.AccessToken?.VoiceGrant) {
        console.error("[Twilio][voice-token] jwt.AccessToken.VoiceGrant missing on twilio module");
        return res.status(500).json({ error: "Twilio SDK voice-token helpers are unavailable on the server" });
      }
      const { AccessToken } = jwt;
      const { VoiceGrant } = AccessToken;

      // 1-hour TTL; the client refreshes ~5 minutes before expiry.
      const ttlSeconds = 60 * 60;
      const token = new AccessToken(
        accountConfig.accountSid,
        browserConfig.apiKeySid,
        browserConfig.apiKeySecret,
        { identity, ttl: ttlSeconds },
      );
      const grant = new VoiceGrant({
        outgoingApplicationSid: browserConfig.twimlAppSid,
        // Task #877: enable inbound. Identity (set above) is the user id, so
        // server-side routing dials <Client>${userId}</Client> to ring this
        // user's browser. Token is still gated by requireTwilioAccess.
        incomingAllow: true,
      });
      token.addGrant(grant);

      res.json({
        token: token.toJwt(),
        identity,
        ttl: ttlSeconds,
        expiresAt: Date.now() + ttlSeconds * 1000,
      });
    } catch (error: any) {
      console.error("[Twilio][voice-token] Token mint failed:", error?.message, error?.stack);
      res.status(500).json({ error: error?.message || "Failed to mint voice token" });
    }
  });

  // Task #851: live call-status lookup for the in-page Active Call Bar.
  // Forward-mode calls have no in-browser SDK, so the UI has nothing
  // local to listen to — it polls this endpoint to learn whether the
  // call is still ringing, has been answered, or has wrapped up. The
  // status is queried straight off Twilio's REST Call resource (source
  // of truth) rather than our DB row, because the DB only updates when
  // the status-callback webhook fires; that webhook can lag a few
  // seconds and would leave the bar stranded on "Connecting".
  app.get("/api/twilio/calls/:id/status", isAuthenticated, requireTwilioAccess, async (req: any, res) => {
    try {
      const call = await twilioStorage.getTwilioCall(req.params.id);
      if (!call) return res.status(404).json({ error: "Call not found" });
      if (!call.twilioSid) return res.status(400).json({ error: "Call has no Twilio SID" });

      const { getTwilioConfig } = await import("../services/twilioService");
      const tConfig = await getTwilioConfig();
      if (!tConfig?.accountSid || !tConfig?.authToken) {
        return res.status(400).json({ error: "Twilio not configured" });
      }
      let twilio: ReturnType<TwilioCallStatusClientFactory>;
      if (__twilioCallStatusClientFactory) {
        twilio = __twilioCallStatusClientFactory(tConfig.accountSid, tConfig.authToken);
      } else {
        const Twilio = (await import("twilio")).default;
        twilio = Twilio(tConfig.accountSid, tConfig.authToken) as unknown as ReturnType<TwilioCallStatusClientFactory>;
      }
      try {
        const remote = await twilio.calls(call.twilioSid).fetch();
        // Twilio CallStatus values: queued, ringing, in-progress, completed,
        // busy, failed, no-answer, canceled. `duration` is a string of
        // seconds once the call ends.
        res.json({
          callId: call.id,
          twilioSid: call.twilioSid,
          status: remote.status,
          duration: remote.duration ? Number(remote.duration) : null,
          startTime: remote.startTime ? remote.startTime.toISOString() : null,
          endTime: remote.endTime ? remote.endTime.toISOString() : null,
        });
      } catch (twErr: unknown) {
        const { describeTwilioError } = await import("../services/twilioErrors");
        return res.status(502).json({ error: describeTwilioError(twErr) });
      }
    } catch (error: any) {
      console.error("[Twilio] Call status error:", error.message);
      res.status(500).json({ error: error.message || "Failed to fetch call status" });
    }
  });

  app.post("/api/twilio/calls/:id/hangup", isAuthenticated, requireTwilioAccess, async (req: any, res) => {
    try {
      const call = await twilioStorage.getTwilioCall(req.params.id);
      if (!call) return res.status(404).json({ error: "Call not found" });
      if (!call.twilioSid) return res.status(400).json({ error: "Call has no Twilio SID" });

      const { getTwilioConfig } = await import("../services/twilioService");
      const tConfig = await getTwilioConfig();
      if (!tConfig?.accountSid || !tConfig?.authToken) {
        return res.status(400).json({ error: "Twilio not configured" });
      }
      const Twilio = (await import("twilio")).default;
      const twilio = Twilio(tConfig.accountSid, tConfig.authToken);
      try {
        // Per Twilio Call resource: PUT to /Calls/{Sid} with Status=completed
        // hangs up an in-progress call.
        // https://www.twilio.com/docs/voice/api/call-resource#update-a-call-resource
        await twilio.calls(call.twilioSid).update({ status: "completed" });
      } catch (twErr: unknown) {
        // Task #859: surface Twilio code/status/moreInfo for hangup failures.
        const { describeTwilioError } = await import("../services/twilioErrors");
        return res.status(502).json({ error: describeTwilioError(twErr) });
      }
      res.json({ success: true });
    } catch (error: any) {
      console.error("[Twilio] Hangup error:", error.message);
      res.status(500).json({ error: error.message || "Failed to hang up" });
    }
  });

  // Authenticated audio proxy. Streams the Dial-verb recording from
  // Twilio's media server using the account's basic-auth credentials so
  // the browser never sees them and unauthenticated users can't fetch
  // the file even with a guessed Twilio URL. Output is whatever Twilio
  // returns (mp3 by default — we suffix .mp3 to force MP3 over WAV so
  // the <audio> tag has consistent codec coverage).
  app.get("/api/twilio/calls/:id/recording", isAuthenticated, requireTwilioAccess, async (req: any, res) => {
    try {
      const call = await twilioStorage.getTwilioCall(req.params.id);
      if (!call) return res.status(404).json({ error: "Call not found" });
      if (!call.recordingUrl || call.recordingStatus !== "completed") {
        return res.status(404).json({ error: "Recording not available" });
      }

      // Prefer the archived copy in private object storage so we can serve
      // even after the 7-day Twilio deletion window. Fall back to streaming
      // from Twilio while the archive pipeline is still in flight (or if
      // object storage is temporarily unreachable).
      if (call.objectStorageKey) {
        try {
          const { ObjectStorageService } = await import("../replit_integrations/object_storage/objectStorage");
          const svc = new ObjectStorageService();
          const file = await svc.getPrivateObjectFileByKey(call.objectStorageKey);
          const { auditedGetMetadata, auditedCreateReadStream } = await import("../replit_integrations/object_storage/audit");
          const [meta] = await auditedGetMetadata(file);
          res.setHeader("Content-Type", meta.contentType || "audio/mpeg");
          if (meta.size != null) res.setHeader("Content-Length", String(meta.size));
          res.setHeader("Cache-Control", "private, max-age=3600");
          auditedCreateReadStream(file)
            .on("error", (err) => {
              console.warn("[Twilio] Object storage stream error, falling back to Twilio", { callId: call.id, err: err.message });
              if (!res.headersSent) res.status(500).end();
              else res.end();
            })
            .pipe(res);
          return;
        } catch (osErr: any) {
          console.warn("[Twilio] Object storage read failed, falling back to Twilio", { callId: call.id, err: osErr?.message });
          // fall through to Twilio fetch
        }
      }

      // If we already deleted from Twilio and object storage failed, we
      // have nothing to serve.
      if (call.twilioRecordingDeletedAt) {
        return res.status(410).json({ error: "Recording archive unavailable" });
      }

      const { getTwilioConfig } = await import("../services/twilioService");
      const cfg = await getTwilioConfig();
      if (!cfg) return res.status(503).json({ error: "Twilio not configured" });

      // SSRF defense: only fetch from Twilio's media domain. Even though
      // recording URLs come from a signature-validated webhook, treat the
      // stored value as untrusted and assert the hostname here so a future
      // bug elsewhere can't turn this into an arbitrary HTTP proxy.
      let parsedRecordingUrl: URL;
      try {
        parsedRecordingUrl = new URL(call.recordingUrl);
      } catch {
        return res.status(400).json({ error: "Stored recording URL is invalid" });
      }
      const allowedHostSuffixes = [".twilio.com"];
      const hostOk = allowedHostSuffixes.some((s) => parsedRecordingUrl.hostname.endsWith(s));
      if (!hostOk) {
        console.warn("[Twilio] Recording host rejected by SSRF guard", { callId: call.id, host: parsedRecordingUrl.hostname });
        return res.status(400).json({ error: "Recording host not allowed" });
      }

      const url = call.recordingUrl.endsWith(".mp3") ? call.recordingUrl : `${call.recordingUrl}.mp3`;
      const auth = Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString("base64");
      const upstream = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
      if (!upstream.ok || !upstream.body) {
        console.warn("[Twilio] Recording fetch failed", { callId: call.id, status: upstream.status });
        return res.status(upstream.status === 404 ? 404 : 502).json({ error: "Failed to fetch recording" });
      }
      res.setHeader("Content-Type", upstream.headers.get("content-type") || "audio/mpeg");
      const len = upstream.headers.get("content-length");
      if (len) res.setHeader("Content-Length", len);
      res.setHeader("Cache-Control", "private, max-age=3600");
      // Pipe via the Web Streams reader — Node 20+ supports this natively.
      const reader = upstream.body.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) res.write(value);
      }
      res.end();
    } catch (err: any) {
      console.error("[Twilio] Recording proxy error:", err?.message, err?.stack);
      if (!res.headersSent) res.status(500).json({ error: "Failed to stream recording" });
      else res.end();
    }
  });

  // Task #852: voicemail audio proxy. Streams the Twilio voicemail
  // recording (stored on twilio_calls.voicemail_recording_url) through
  // the same SSRF-guarded path as the Dial-recording proxy. Voicemails
  // are not archived to object storage in this scope.
  app.get("/api/twilio/calls/:id/voicemail-recording", isAuthenticated, requireTwilioAccess, async (req: any, res) => {
    try {
      const call = await twilioStorage.getTwilioCall(req.params.id);
      if (!call) return res.status(404).json({ error: "Call not found" });
      if (!call.voicemailRecordingUrl) {
        return res.status(404).json({ error: "Voicemail not available" });
      }

      const { getTwilioConfig } = await import("../services/twilioService");
      const cfg = await getTwilioConfig();
      if (!cfg) return res.status(503).json({ error: "Twilio not configured" });

      let parsedUrl: URL;
      try {
        parsedUrl = new URL(call.voicemailRecordingUrl);
      } catch {
        return res.status(400).json({ error: "Stored voicemail URL is invalid" });
      }
      if (!parsedUrl.hostname.endsWith(".twilio.com")) {
        console.warn("[Twilio] Voicemail host rejected by SSRF guard", { callId: call.id, host: parsedUrl.hostname });
        return res.status(400).json({ error: "Voicemail host not allowed" });
      }

      const url = call.voicemailRecordingUrl.endsWith(".mp3")
        ? call.voicemailRecordingUrl
        : `${call.voicemailRecordingUrl}.mp3`;
      const auth = Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString("base64");
      const upstream = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
      if (!upstream.ok || !upstream.body) {
        return res.status(upstream.status === 404 ? 404 : 502).json({ error: "Failed to fetch voicemail" });
      }
      res.setHeader("Content-Type", upstream.headers.get("content-type") || "audio/mpeg");
      const len = upstream.headers.get("content-length");
      if (len) res.setHeader("Content-Length", len);
      res.setHeader("Cache-Control", "private, max-age=3600");
      const reader = upstream.body.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) res.write(value);
      }
      res.end();
    } catch (err: any) {
      console.error("[Twilio] Voicemail proxy error:", err?.message);
      if (!res.headersSent) res.status(500).json({ error: "Failed to stream voicemail" });
      else res.end();
    }
  });

  // Task #852: mark a voicemail as listened. Idempotent — re-marking
  // a previously-listened voicemail is a no-op (the original timestamp
  // is preserved). The "VM" inbox badge counts rows where
  // voicemail_listened_at IS NULL.
  app.post("/api/twilio/calls/:id/voicemail/listened", isAuthenticated, requireTwilioAccess, async (req: any, res) => {
    try {
      const call = await twilioStorage.getTwilioCall(req.params.id);
      if (!call) return res.status(404).json({ error: "Call not found" });
      if (!call.voicemailRecordingUrl) {
        return res.status(400).json({ error: "Call has no voicemail" });
      }
      if (call.voicemailListenedAt) {
        return res.json({ ok: true, voicemailListenedAt: call.voicemailListenedAt });
      }
      const updated = await twilioStorage.updateTwilioCall(call.id, {
        voicemailListenedAt: new Date(),
      });
      res.json({ ok: true, voicemailListenedAt: updated?.voicemailListenedAt });
    } catch (err: any) {
      console.error("[Twilio] Mark voicemail listened error:", err?.message);
      res.status(500).json({ error: "Failed to mark voicemail as listened" });
    }
  });

  app.get("/api/twilio/calls", isAuthenticated, requireTwilioAccess, async (req: any, res) => {
    try {
      const calls = await twilioStorage.listTwilioCallsWithDetails({
        clientId: req.query.clientId as string,
        direction: req.query.direction as string,
        status: req.query.status as string,
        dateFrom: req.query.dateFrom as string,
        dateTo: req.query.dateTo as string,
        sortBy: req.query.sortBy as string,
        sortDir: req.query.sortDir as string,
        limit: req.query.limit ? parseInt(req.query.limit as string) : 200,
      });
      res.json(calls);
    } catch (error: any) {
      console.error("[Twilio] List calls error:", error.message);
      res.status(500).json({ error: "Failed to list calls" });
    }
  });

  app.get("/api/twilio/config", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const [sidSetting] = await db.select().from(systemSettings).where(eq(systemSettings.key, "twilio_account_sid"));
      const [tokenSetting] = await db.select().from(systemSettings).where(eq(systemSettings.key, "twilio_auth_token"));
      const [phonesSetting] = await db.select().from(systemSettings).where(eq(systemSettings.key, "twilio_phone_numbers"));
      const [greetingSetting] = await db.select().from(systemSettings).where(eq(systemSettings.key, "twilio_ivr_greeting"));
      const [optionsSetting] = await db.select().from(systemSettings).where(eq(systemSettings.key, "twilio_ivr_menu_options"));
      // Task #874: surface browser-calling config so the admin UI can show
      // configured/not-configured state per field. The secret is never
      // round-tripped in plaintext — only a boolean flag + masked tail.
      const [apiKeySidSetting] = await db.select().from(systemSettings).where(eq(systemSettings.key, "twilio_api_key_sid"));
      const [apiKeySecretSetting] = await db.select().from(systemSettings).where(eq(systemSettings.key, "twilio_api_key_secret"));
      const [twimlAppSetting] = await db.select().from(systemSettings).where(eq(systemSettings.key, "twilio_twiml_app_sid"));
      // Task #876: Messaging Service SID. Treated like the Auth Token in
      // the admin UI — never round-tripped in plaintext, only an
      // `isSet` flag + masked tail so admins can verify a value is in
      // place without exposing it.
      const [msgServiceSetting] = await db
        .select()
        .from(systemSettings)
        .where(eq(systemSettings.key, "twilio_messaging_service_sid"));

      const { resolveLastEditedUsers, buildLastEdited } = await import("./lastEditedHelper");
      const userMap = await resolveLastEditedUsers([
        sidSetting?.updatedBy,
        tokenSetting?.updatedBy,
        phonesSetting?.updatedBy,
        greetingSetting?.updatedBy,
        optionsSetting?.updatedBy,
        apiKeySidSetting?.updatedBy,
        apiKeySecretSetting?.updatedBy,
        twimlAppSetting?.updatedBy,
        msgServiceSetting?.updatedBy,
      ]);

      const browserCallingReady = !!(apiKeySidSetting?.value && apiKeySecretSetting?.value && twimlAppSetting?.value);

      res.json({
        isConfigured: !!sidSetting?.value,
        phoneNumbers: phonesSetting?.value ? JSON.parse(phonesSetting.value) : [],
        accountSid: sidSetting?.value ? `${sidSetting.value.substring(0, 8)}...` : null,
        ivrGreeting: greetingSetting?.value || "",
        ivrMenuOptions: optionsSetting?.value ? JSON.parse(optionsSetting.value) : [],
        // Task #874: browser calling config view (no plaintext secrets).
        browserCalling: {
          isConfigured: browserCallingReady,
          apiKeySid: apiKeySidSetting?.value
            ? `${apiKeySidSetting.value.substring(0, 8)}...`
            : null,
          apiKeySecretSet: !!apiKeySecretSetting?.value,
          twimlAppSid: twimlAppSetting?.value
            ? `${twimlAppSetting.value.substring(0, 8)}...`
            : null,
        },
        // Task #876: messaging-service config view. `isSet` drives the
        // "Configured" badge in the admin UI and the masked SID lets
        // admins eyeball that the right SID is in place. Empty string
        // is normalized to "off" because the PUT route stores "" to
        // clear the setting.
        messagingService: {
          isSet: !!msgServiceSetting?.value?.trim(),
          messagingServiceSid: msgServiceSetting?.value?.trim()
            ? `${msgServiceSetting.value.trim().substring(0, 8)}...`
            : null,
        },
        lastEdited: {
          accountSid: buildLastEdited(sidSetting?.updatedAt, sidSetting?.updatedBy, userMap),
          authToken: buildLastEdited(tokenSetting?.updatedAt, tokenSetting?.updatedBy, userMap),
          phoneNumbers: buildLastEdited(phonesSetting?.updatedAt, phonesSetting?.updatedBy, userMap),
          ivrGreeting: buildLastEdited(greetingSetting?.updatedAt, greetingSetting?.updatedBy, userMap),
          ivrMenuOptions: buildLastEdited(optionsSetting?.updatedAt, optionsSetting?.updatedBy, userMap),
          apiKeySid: buildLastEdited(apiKeySidSetting?.updatedAt, apiKeySidSetting?.updatedBy, userMap),
          apiKeySecret: buildLastEdited(apiKeySecretSetting?.updatedAt, apiKeySecretSetting?.updatedBy, userMap),
          twimlAppSid: buildLastEdited(twimlAppSetting?.updatedAt, twimlAppSetting?.updatedBy, userMap),
          messagingServiceSid: buildLastEdited(msgServiceSetting?.updatedAt, msgServiceSetting?.updatedBy, userMap),
        },
      });
    } catch (error: any) {
      res.status(500).json({ error: "Failed to get config" });
    }
  });

  // Task #884: pre-save reachability check for the Messaging Service SID.
  // The PUT /api/twilio/config validator only enforces the `MG` + 32 hex
  // format — an admin can paste a syntactically valid SID that doesn't
  // exist in their account or whose Sender Pool is empty, and only learn
  // about it when the next outbound SMS fails. This endpoint uses the
  // configured account credentials to fetch the service via the Twilio
  // SDK and inspect its Sender Pool. Read-only (no SMS is sent).
  app.post("/api/twilio/messaging-service/test", isAuthenticated, async (req: any, res) => {
    try {
      const [user] = await db.select().from(users).where(eq(users.id, req.user.claims.sub));
      if (!user || (user.role !== "ceo" && user.role !== "team_lead")) {
        return res.status(403).json({ ok: false, reason: "forbidden", message: "Only team leads and CEO can test Twilio config" });
      }
      const schema = z.object({
        messagingServiceSid: z
          .string()
          .trim()
          .regex(
            /^MG[0-9a-fA-F]{32}$/,
            "Messaging Service SID must be 'MG' followed by 32 hex characters",
          ),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          ok: false,
          reason: "invalid_format",
          message: parsed.error.issues[0].message,
        });
      }
      const { fetchMessagingServiceStatus } = await import("../services/twilioService");
      const result = await fetchMessagingServiceStatus(parsed.data.messagingServiceSid);
      return res.json(result);
    } catch (err: any) {
      console.error("[Twilio] Test messaging service error:", err?.message);
      return res.status(500).json({
        ok: false,
        reason: "unknown",
        message: "Failed to test Messaging Service",
      });
    }
  });

  app.put("/api/twilio/config", isAuthenticated, async (req: any, res) => {
    try {
      const [user] = await db.select().from(users).where(eq(users.id, req.user.claims.sub));
      if (!user || (user.role !== "ceo" && user.role !== "team_lead")) {
        return res.status(403).json({ error: "Only team leads and CEO can configure Twilio" });
      }

      const parsed = twilioConfigSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

      const { accountSid, authToken, phoneNumbers, ivrGreeting, ivrMenuOptions, apiKeySid, apiKeySecret, twimlAppSid, messagingServiceSid } = parsed.data;

      const { setSystemSetting, getSystemSetting } = await import("../storage/settingsStorage");

      const maskToken = (v: string | null | undefined): string | null => {
        if (v === null || v === undefined || v === "") return v ?? null;
        return v.length <= 4 ? "***" : `***${v.slice(-4)}`;
      };
      const summarizeMenu = (raw: string | null | undefined): string | null => {
        if (!raw) return null;
        try {
          const arr = JSON.parse(raw) as Array<{ digit?: string; label?: string; phone?: string }>;
          if (!Array.isArray(arr) || arr.length === 0) return "(empty)";
          return arr.map(o => `${o.digit ?? "?"}=${o.label ?? ""}→${o.phone ?? ""}`).join("; ");
        } catch {
          return raw;
        }
      };
      const summarizePhones = (raw: string | null | undefined): string | null => {
        if (!raw) return null;
        try {
          const arr = JSON.parse(raw) as string[];
          return Array.isArray(arr) ? arr.join(", ") : raw;
        } catch {
          return raw;
        }
      };

      const oldValues: Record<string, string | null> = {};
      const newValues: Record<string, string | null> = {};

      if (accountSid !== undefined) {
        const prev = (await getSystemSetting("twilio_account_sid"))?.value ?? null;
        await setSystemSetting("twilio_account_sid", accountSid, req.user.claims.sub);
        if (prev !== accountSid) {
          oldValues.accountSid = prev;
          newValues.accountSid = accountSid;
        }
      }
      if (authToken !== undefined) {
        const prev = (await getSystemSetting("twilio_auth_token"))?.value ?? null;
        await setSystemSetting("twilio_auth_token", authToken, req.user.claims.sub);
        if (prev !== authToken) {
          oldValues.authToken = maskToken(prev);
          newValues.authToken = maskToken(authToken);
        }
      }
      if (phoneNumbers !== undefined) {
        const prev = (await getSystemSetting("twilio_phone_numbers"))?.value ?? null;
        const next = JSON.stringify(phoneNumbers);
        await setSystemSetting("twilio_phone_numbers", next, req.user.claims.sub);
        if (prev !== next) {
          oldValues.phoneNumbers = summarizePhones(prev);
          newValues.phoneNumbers = summarizePhones(next);
        }
      }
      if (ivrGreeting !== undefined) {
        const prev = (await getSystemSetting("twilio_ivr_greeting"))?.value ?? null;
        await setSystemSetting("twilio_ivr_greeting", ivrGreeting, req.user.claims.sub);
        if (prev !== ivrGreeting) {
          oldValues.ivrGreeting = prev;
          newValues.ivrGreeting = ivrGreeting;
        }
      }
      if (ivrMenuOptions !== undefined) {
        const prev = (await getSystemSetting("twilio_ivr_menu_options"))?.value ?? null;
        const next = JSON.stringify(ivrMenuOptions);
        await setSystemSetting("twilio_ivr_menu_options", next, req.user.claims.sub);
        if (prev !== next) {
          oldValues.ivrMenuOptions = summarizeMenu(prev);
          newValues.ivrMenuOptions = summarizeMenu(next);
        }
      }
      // Task #874: browser-calling credentials. The schema enforces non-empty
      // strings on write; passing `null` is the explicit "clear this setting"
      // sentinel. The secret is masked in the audit log mirror so old/new
      // values never end up readable in activity_logs.
      if (apiKeySid !== undefined) {
        const prev = (await getSystemSetting("twilio_api_key_sid"))?.value ?? null;
        const next = apiKeySid === null ? "" : apiKeySid.trim();
        await setSystemSetting("twilio_api_key_sid", next, req.user.claims.sub);
        if (prev !== next) {
          oldValues.apiKeySid = prev;
          newValues.apiKeySid = next;
        }
      }
      if (apiKeySecret !== undefined) {
        const prev = (await getSystemSetting("twilio_api_key_secret"))?.value ?? null;
        const next = apiKeySecret === null ? "" : apiKeySecret.trim();
        await setSystemSetting("twilio_api_key_secret", next, req.user.claims.sub);
        if (prev !== next) {
          oldValues.apiKeySecret = maskToken(prev);
          newValues.apiKeySecret = maskToken(next);
        }
      }
      if (twimlAppSid !== undefined) {
        const prev = (await getSystemSetting("twilio_twiml_app_sid"))?.value ?? null;
        const next = twimlAppSid === null ? "" : twimlAppSid.trim();
        await setSystemSetting("twilio_twiml_app_sid", next, req.user.claims.sub);
        if (prev !== next) {
          oldValues.twimlAppSid = prev;
          newValues.twimlAppSid = next;
        }
      }
      // Task #876: Messaging Service SID. Both `null` and `""` clear the
      // setting (legacy `from: phoneNumber` behavior). Anything else is a
      // validated `MG…` SID per the schema. Mask in audit log so the SID
      // is treated as sensitive in activity_logs the same way the auth
      // token is — Twilio docs treat the Messaging Service SID as a
      // tenant identifier rather than a secret, but we mirror the
      // existing pattern for consistency in admin tooling.
      if (messagingServiceSid !== undefined) {
        const prev = (await getSystemSetting("twilio_messaging_service_sid"))?.value ?? null;
        const next = messagingServiceSid === null ? "" : messagingServiceSid.trim();
        await setSystemSetting("twilio_messaging_service_sid", next, req.user.claims.sub);
        if (prev !== next) {
          oldValues.messagingServiceSid = maskToken(prev);
          newValues.messagingServiceSid = maskToken(next);
        }
      }

      const changedKeys = Object.keys(newValues);
      if (changedKeys.length > 0) {
        try {
          await insertActivityLogs([{
            userId: req.user?.claims?.sub ?? null,
            actionType: "twilio_config_updated",
            route: "/api/twilio/config",
            actionDetail: `Updated Twilio config: ${changedKeys.join(", ")}`,
            metadata: { changedKeys, oldValues, newValues },
            sessionId: null,
            duration: null,
            timestamp: new Date(),
          }]);
        } catch (logErr: any) {
          console.error("[Twilio] Config audit log failed:", logErr?.message);
        }
      }

      res.json({ success: true });
    } catch (error: any) {
      console.error("[Twilio] Config update error:", error.message);
      res.status(500).json({ error: "Failed to update config" });
    }
  });

  app.put("/api/users/me/twilio-settings", isAuthenticated, async (req: any, res) => {
    try {
      const parsed = userSettingsSchema.safeParse(req.body);
      if (!parsed.success) {
        const msg = parsed.error.issues[0].message;
        console.warn(`[Twilio] User settings rejected for user ${req.user.claims.sub}: ${msg}`, { body: req.body });
        return res.status(400).json({ error: msg });
      }

      const { callerIdName, smsSignOff, callRoutingPhone, callMode } = parsed.data;
      const updatePayload: Record<string, string | Date | null | undefined> = {
        updatedAt: new Date(),
      };
      if (callerIdName !== undefined) updatePayload.callerIdName = callerIdName;
      if (smsSignOff !== undefined) updatePayload.smsSignOff = smsSignOff;
      if (callRoutingPhone !== undefined) {
        updatePayload.callRoutingPhone = callRoutingPhone.trim()
          ? normalizePhone(callRoutingPhone.trim())
          : null;
      }
      // Task #874: per-user call mode. Validation note — switching to "forward"
      // without a routing phone is allowed at the settings layer because the
      // `/initiate-call` route is the actual gate (clearer error message at
      // the point of attempted use). The UI also reminds them inline.
      if (callMode !== undefined) updatePayload.callMode = callMode;
      const [updated] = await db.update(users)
        .set(updatePayload)
        .where(eq(users.id, req.user.claims.sub))
        .returning();
      res.json(updated);
    } catch (error: any) {
      console.error("[Twilio] User settings error:", error.message);
      res.status(500).json({ error: "Failed to update settings" });
    }
  });

  // Task #877: browser-presence heartbeat. The Voice JS SDK device hook
  // POSTs `{ online: true }` every ~30s while it is registered and ready
  // to take an incoming call, and `{ online: false }` on teardown / page
  // unload. The in-memory tracker has a 75s TTL so a crashed tab also
  // ages out automatically. This endpoint is the only writer; no GET is
  // exposed (callers needn't introspect their own presence).
  app.post("/api/twilio/voice-presence", isAuthenticated, requireTwilioAccess, async (req: any, res) => {
    try {
      const userId: string = req.user.claims.sub;
      const online = req.body?.online === true;
      const { markUserBrowserOnline, markUserBrowserOffline, PRESENCE_HEARTBEAT_MS } = await import(
        "../services/browserPresence"
      );
      if (online) {
        markUserBrowserOnline(userId);
      } else {
        markUserBrowserOffline(userId);
      }
      res.json({ ok: true, heartbeatMs: PRESENCE_HEARTBEAT_MS });
    } catch (err: any) {
      console.error("[Twilio][voice-presence] error:", err?.message);
      res.status(500).json({ error: "Failed to update presence" });
    }
  });

  app.get("/api/users/me/twilio-settings", isAuthenticated, async (req: any, res) => {
    try {
      const [user] = await db.select().from(users).where(eq(users.id, req.user.claims.sub));
      if (!user) return res.status(404).json({ error: "User not found" });
      res.json({
        callerIdName: user.callerIdName || "",
        smsSignOff: user.smsSignOff || "",
        callRoutingPhone: user.callRoutingPhone || "",
        // Task #874: 'browser' is the default, applied client-side too if
        // null somehow round-trips through.
        callMode: (user.callMode === "forward" ? "forward" : "browser"),
      });
    } catch (error: any) {
      res.status(500).json({ error: "Failed to get settings" });
    }
  });

  app.put("/api/users/me/profile", isAuthenticated, async (req: any, res) => {
    try {
      const { firstName, lastName } = req.body;
      const updateData: Record<string, any> = { updatedAt: new Date() };
      if (typeof firstName === "string") updateData.firstName = firstName.trim().slice(0, 100);
      if (typeof lastName === "string") updateData.lastName = lastName.trim().slice(0, 100);
      const [updated] = await db.update(users)
        .set(updateData)
        .where(eq(users.id, req.user.claims.sub))
        .returning();
      res.json(updated);
    } catch (error: any) {
      console.error("[Settings] Profile update error:", error.message);
      res.status(500).json({ error: "Failed to update profile" });
    }
  });

  const MAX_PHOTO_SIZE = 5 * 1024 * 1024;
  app.post("/api/users/me/profile-photo", isAuthenticated, async (req: any, res) => {
    try {
      const contentType = req.headers["content-type"] || "";
      if (!["image/jpeg", "image/png", "image/webp"].includes(contentType)) {
        return res.status(400).json({ error: "Only JPEG, PNG, or WebP images are allowed" });
      }

      const chunks: Buffer[] = [];
      let totalSize = 0;
      for await (const chunk of req) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalSize += buf.length;
        if (totalSize > MAX_PHOTO_SIZE) {
          return res.status(413).json({ error: "Image too large (max 5MB)" });
        }
        chunks.push(buf);
      }
      const buffer = Buffer.concat(chunks);

      const ext = contentType.includes("png") ? "png" : contentType.includes("webp") ? "webp" : "jpg";
      const userId = req.user.claims.sub;
      const filename = `profile-photos/${userId}.${ext}`;

      const { Client } = await import("@replit/object-storage");
      const client = new Client();
      await client.uploadFromBytes(filename, buffer);

      const bucketId = process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID;
      const publicUrl = `https://${bucketId}.replit.dev/${filename}`;

      await db.update(users)
        .set({ profileImageUrl: publicUrl, updatedAt: new Date() })
        .where(eq(users.id, userId));

      res.json({ profileImageUrl: publicUrl });
    } catch (error: any) {
      console.error("[Settings] Photo upload error:", error.message);
      res.status(500).json({ error: "Failed to upload photo" });
    }
  });

  // Task #881: backfill twilio_messages.status / errorCode / errorMessage
  // for rows sent before the Task #875 status-callback webhook shipped.
  // Twilio only fires status callbacks at send-time and never re-delivers
  // them, so historical rows are stuck on whatever status was written at
  // send (typically `sent` or `queued`) regardless of whether they were
  // actually delivered or failed. This admin-triggered, bounded job
  // re-fetches each row's current state from Twilio's REST API.
  //
  // Bounded by `?days=N` (default 30, max 90) to respect Twilio's REST
  // rate limit (~100 req/sec/account); rows are processed sequentially
  // with a small inter-call delay. `?dryRun=true` previews without writes.
  // `?limit=N` caps the total rows fetched (default 1000, max 5000).
  // Only rows with a non-null `twilioSid` are eligible — rows whose send
  // failed before Twilio assigned a SID have nothing to look up.
  app.post("/api/twilio/admin/backfill-statuses", isAuthenticated, requireCeo, async (req: any, res) => {
    try {
      const daysRaw = parseInt(String(req.query?.days ?? req.body?.days ?? "30"), 10);
      const days = Math.min(Math.max(isFinite(daysRaw) ? daysRaw : 30, 1), 90);
      const limitRaw = parseInt(String(req.query?.limit ?? req.body?.limit ?? "1000"), 10);
      const limit = Math.min(Math.max(isFinite(limitRaw) ? limitRaw : 1000, 1), 5000);
      const dryRun =
        req.query?.dryRun === "true" ||
        req.query?.dryRun === "1" ||
        req.body?.dryRun === true;

      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

      // Pull eligible SIDs via Drizzle's typed query builder. We only
      // need rows with a twilio_sid (rows that never got one have
      // nothing to fetch from Twilio's API). Using the typed builder
      // avoids the `(execute().rows as any)` pattern.
      const { twilioMessages } = await import("@shared/schema");
      const { and: drizzleAnd, eq: drizzleEq, gte: drizzleGte, isNotNull, desc: drizzleDesc } = await import("drizzle-orm");
      const rows = await getDb()
        .select({
          id: twilioMessages.id,
          twilioSid: twilioMessages.twilioSid,
          status: twilioMessages.status,
          errorCode: twilioMessages.errorCode,
          errorMessage: twilioMessages.errorMessage,
        })
        .from(twilioMessages)
        .where(
          drizzleAnd(
            isNotNull(twilioMessages.twilioSid),
            drizzleGte(twilioMessages.createdAt, cutoff),
            drizzleEq(twilioMessages.direction, "outbound"),
          ),
        )
        .orderBy(drizzleDesc(twilioMessages.createdAt))
        .limit(limit);

      const { fetchMessageStatus } = await import("../services/twilioService");

      console.log(
        `[admin/twilio-backfill-statuses] Triggered by user=${req.user.claims.sub} days=${days} limit=${limit} dryRun=${dryRun} candidates=${rows.length}`,
      );

      let updated = 0;
      let unchanged = 0;
      let missing = 0;
      let failed = 0;
      const errors: Array<{ twilioSid: string; error: string }> = [];

      // Sequential with a small delay so we stay well under Twilio's REST
      // rate limit (~100 req/sec/account). At ~50ms between calls we top
      // out around 20 req/sec which is comfortable headroom.
      for (const row of rows) {
        // The `isNotNull` predicate above guarantees twilioSid is present;
        // narrow it for TS so we don't have to pass `string | null`.
        const sid = row.twilioSid;
        if (sid == null) continue;
        try {
          const remote = await fetchMessageStatus(sid);
          if (remote === null) {
            missing += 1;
          } else if (
            remote.status === row.status &&
            (remote.errorCode ?? null) === (row.errorCode ?? null) &&
            (remote.errorMessage ?? null) === (row.errorMessage ?? null)
          ) {
            unchanged += 1;
          } else {
            if (!dryRun) {
              const updatedRow = await twilioStorage.updateTwilioMessageStatusBySid(sid, {
                status: remote.status,
                errorCode: remote.errorCode,
                errorMessage: remote.errorMessage,
              });
              // Task #1278: when this backfill discovers a status that
              // diverged from the cached row (e.g. a late delivery /
              // failure that never fired a status callback), push the
              // change over SSE too so an operator with the thread
              // open sees the badge transition without waiting for
              // the next per-thread poll. Best-effort — failures here
              // are logged but don't abort the backfill.
              if (updatedRow) {
                try {
                  const { broadcastTwilioEvent } = await import("../services/twilioEvents");
                  const updatedAtIso =
                    updatedRow.updatedAt instanceof Date
                      ? updatedRow.updatedAt.toISOString()
                      : updatedRow.updatedAt
                        ? new Date(updatedRow.updatedAt as unknown as string).toISOString()
                        : new Date().toISOString();
                  broadcastTwilioEvent({
                    type: "message:status",
                    conversationId: updatedRow.conversationId,
                    message: {
                      id: updatedRow.id,
                      conversationId: updatedRow.conversationId,
                      twilioSid: updatedRow.twilioSid ?? null,
                      status: updatedRow.status ?? remote.status,
                      errorCode: updatedRow.errorCode ?? null,
                      errorMessage: updatedRow.errorMessage ?? null,
                      updatedAt: updatedAtIso,
                    },
                  });
                } catch (err: unknown) {
                  console.error(
                    "[admin/twilio-backfill-statuses] Failed to broadcast SMS status event:",
                    err,
                  );
                }
              }
            }
            updated += 1;
          }
        } catch (err: unknown) {
          failed += 1;
          if (errors.length < 20) {
            const message = err instanceof Error ? err.message : String(err);
            errors.push({ twilioSid: sid, error: message });
          }
        }
        await new Promise((r) => setTimeout(r, 50));
      }

      console.log(
        `[admin/twilio-backfill-statuses] Done dryRun=${dryRun} candidates=${rows.length} updated=${updated} unchanged=${unchanged} missing=${missing} failed=${failed}`,
      );

      res.json({
        dryRun,
        days,
        limit,
        candidates: rows.length,
        updated,
        unchanged,
        missing,
        failed,
        errors,
      });
    } catch (error: any) {
      console.error("[admin/twilio-backfill-statuses] Error:", error);
      res.status(500).json({ error: error?.message || "backfill failed" });
    }
  });

  // CEO-gated one-shot cleanup for legacy duplicate direct conversations.
  // Backfills the canonical direct_thread_key on any legacy rows, then merges
  // duplicate direct threads. Idempotent — safe to run multiple times. Pass
  // ?dryRun=true (or { dryRun: true } in body) to preview without writes.
  app.post("/api/admin/twilio/cleanup-duplicate-conversations", isAuthenticated, requireCeo, async (req: any, res) => {
    try {
      const dryRun =
        req.query?.dryRun === "true" ||
        req.query?.dryRun === "1" ||
        req.body?.dryRun === true;

      const { runBackfill } = await import("../scripts/backfillTwilioConversationNormalization");
      const { runMerge } = await import("../scripts/mergeDuplicateDirectConversations");

      console.log(
        `[admin/twilio-cleanup] Triggered by user=${req.user.claims.sub} dryRun=${dryRun}`,
      );

      const backfill = await runBackfill({ dryRun });
      const merge = await runMerge({ dryRun });

      console.log(
        `[admin/twilio-cleanup] Done dryRun=${dryRun} backfill.updated=${backfill.updated} merge.groupsMerged=${merge.groupsMerged} merge.groupsSkipped=${merge.groupsSkipped}`,
      );

      res.json({ dryRun, backfill, merge });
    } catch (error: any) {
      console.error("[admin/twilio-cleanup] Error:", error);
      res.status(500).json({ error: error?.message || "cleanup failed" });
    }
  });

  // Task #1052: Admin visibility into the call-recording archive pipeline.
  // Lists recent twilio_calls rows with their archive status / attempts /
  // last error / per-stage timestamps so operators can spot stuck rows
  // (the kind of problem Task #1046 surfaced) without querying the DB
  // directly. Filters: ?status=pending|queued|processing|done|failed|skipped
  // (comma-separated allowed), ?stuck=true (status='pending' AND no
  // recording metadata yet — i.e. the recording-status webhook never
  // fired). ?limit caps the page size (default 100, max 500).
  app.get("/api/admin/twilio/call-archive", isAuthenticated, requireCeo, async (req: any, res) => {
    try {
      const ALLOWED = new Set(["pending", "queued", "processing", "done", "failed", "skipped"]);
      const rawStatus = typeof req.query?.status === "string" ? req.query.status : "";
      const statuses = rawStatus
        .split(",")
        .map((s: string) => s.trim())
        .filter((s: string) => ALLOWED.has(s));
      const stuck = req.query?.stuck === "true" || req.query?.stuck === "1";
      const limitRaw = parseInt(String(req.query?.limit ?? "100"), 10);
      const limit = Math.min(Math.max(isFinite(limitRaw) ? limitRaw : 100, 1), 500);

      const conds: any[] = [];
      if (statuses.length > 0) {
        conds.push(sql`archive_status IN (${sql.join(statuses.map((s: string) => sql`${s}`), sql`, `)})`);
      }
      if (stuck) {
        // "stuck" = the recording-status webhook never delivered metadata,
        // so the row sits in `pending` with no recording_url / recording_sid.
        conds.push(sql`(archive_status = 'pending' AND recording_url IS NULL AND recording_sid IS NULL)`);
      }
      const whereClause = conds.length > 0
        ? sql`WHERE ${sql.join(conds, sql` AND `)}`
        : sql``;

      const result = await getDb().execute(sql`
        SELECT
          id, client_id, twilio_sid, direction, from_number, to_number,
          status, duration, created_at, updated_at,
          recording_sid, recording_url, recording_status,
          archive_status, archive_attempts, archive_last_error,
          archive_locked_until, archive_next_attempt_at,
          object_storage_key, object_storage_archived_at,
          transcript_completed_at, transcript_error,
          drive_recording_uploaded_at, drive_recording_web_link,
          drive_transcript_uploaded_at, drive_transcript_web_link,
          client_file_recording_id, client_file_recording_saved_at,
          client_file_transcript_id, client_file_transcript_saved_at,
          twilio_delete_eligible_at, twilio_recording_deleted_at
        FROM twilio_calls
        ${whereClause}
        ORDER BY created_at DESC
        LIMIT ${limit}
      `);
      const rows = (result as any).rows ?? [];

      // Aggregate counters so the UI can render status pills with totals
      // without needing a second round-trip.
      const countResult = await getDb().execute(sql`
        SELECT archive_status, COUNT(*)::int AS count
        FROM twilio_calls
        GROUP BY archive_status
      `);
      const countRows = (countResult as any).rows ?? [];
      const stuckResult = await getDb().execute(sql`
        SELECT COUNT(*)::int AS count
        FROM twilio_calls
        WHERE archive_status = 'pending'
          AND recording_url IS NULL
          AND recording_sid IS NULL
      `);
      const stuckRows = (stuckResult as any).rows ?? [];

      const counts: Record<string, number> = {};
      for (const r of countRows as any[]) {
        counts[r.archive_status ?? "null"] = Number(r.count);
      }
      const stuckCount = Number((stuckRows as any[])[0]?.count ?? 0);

      res.json({
        rows,
        counts,
        stuckCount,
        limit,
        filters: { status: statuses, stuck },
      });
    } catch (error: any) {
      console.error("[admin/call-archive] List error:", error?.message ?? error);
      res.status(500).json({ error: "Failed to load call archive rows" });
    }
  });

  // Task #1079: Surface the same numbers that callArchiveBacklogAlerts
  // evaluates so the admin Twilio page can render an "Archive pipeline
  // health" card without going to psql. Reuses the watcher's config
  // (`pendingHours`, `failedLookbackHours`) so the dashboard never
  // disagrees with the alert that fired.
  app.get("/api/admin/twilio/call-archive/health", isAuthenticated, requireCeo, async (_req: any, res) => {
    try {
      const {
        getCallArchiveBacklogAlertConfig,
        pendingStuckWhere,
        recentFailuresWhere,
        SETTING_ENABLED,
        SETTING_PENDING_HOURS,
        SETTING_PENDING_COUNT,
        SETTING_FAILED_LOOKBACK_HOURS,
        SETTING_FAILED_COUNT,
        SETTING_COOLDOWN,
      } = await import("../services/callArchiveBacklogAlerts");
      const { MAX_ATTEMPTS } = await import("../services/callArchivePipeline");
      const config = await getCallArchiveBacklogAlertConfig();
      const pendingWhere = pendingStuckWhere(config.pendingHours);
      const failedWhere = recentFailuresWhere(config.failedLookbackHours);

      // pending_stuck = same predicate the watcher uses (Task #1081):
      // pending rows with no recording metadata older than pendingHours.
      const pendingResult = await getDb().execute(sql`
        SELECT
          COUNT(*)::int AS count,
          MAX(EXTRACT(EPOCH FROM (NOW() - created_at)))::int AS oldest_age_seconds
        FROM twilio_calls
        WHERE ${pendingWhere}
      `);
      const pendingRow = ((pendingResult as any).rows ?? [])[0] ?? {};
      const pendingCount = Number(pendingRow.count ?? 0);
      const oldestAgeSeconds = pendingRow.oldest_age_seconds == null
        ? null
        : Number(pendingRow.oldest_age_seconds);

      // recent_failures = rows in 'failed' (attempts >= MAX_ATTEMPTS)
      // updated within the lookback window — matches the watcher.
      const failedResult = await getDb().execute(sql`
        SELECT COUNT(*)::int AS count
        FROM twilio_calls
        WHERE ${failedWhere}
      `);
      const failedCount = Number(((failedResult as any).rows ?? [])[0]?.count ?? 0);

      // Up to 10 stuck rows for the drill-in list, ordered oldest-first
      // (created_at ASC) so the operator sees the rows that have been
      // sitting longest at the top — those are the most likely to need
      // a manual re-enqueue.
      const stuckRowsResult = await getDb().execute(sql`
        SELECT id, client_id, twilio_sid, direction, from_number, to_number,
               created_at, recording_sid, archive_status, archive_attempts,
               archive_last_error
        FROM twilio_calls
        WHERE ${pendingWhere}
        ORDER BY created_at ASC
        LIMIT 10
      `);
      const failedRowsResult = await getDb().execute(sql`
        SELECT id, client_id, twilio_sid, direction, from_number, to_number,
               created_at, updated_at, recording_sid, archive_status,
               archive_attempts, archive_last_error
        FROM twilio_calls
        WHERE ${failedWhere}
        ORDER BY updated_at DESC
        LIMIT 10
      `);

      // Task #1095: surface raw threshold values + last-edited metadata
      // so the admin "Alert thresholds" sub-section can render an inline
      // editor (and a LastEditedBadge consistent with other Twilio
      // settings). The six keys live in `system_settings`; we read them
      // here and project the existing `updatedAt` / `updatedBy` columns
      // through `buildLastEdited`.
      const alertSettingKeys = [
        SETTING_ENABLED,
        SETTING_PENDING_HOURS,
        SETTING_PENDING_COUNT,
        SETTING_FAILED_LOOKBACK_HOURS,
        SETTING_FAILED_COUNT,
        SETTING_COOLDOWN,
      ];
      const alertSettingRows = await db
        .select()
        .from(systemSettings)
        .where(inArray(systemSettings.key, alertSettingKeys));
      const alertSettingByKey = new Map(alertSettingRows.map((r) => [r.key, r]));
      const { resolveLastEditedUsers, buildLastEdited } = await import("./lastEditedHelper");
      const userMap = await resolveLastEditedUsers(
        alertSettingRows.map((r) => r.updatedBy),
      );
      const lastEditedFor = (key: string) => {
        const row = alertSettingByKey.get(key);
        return buildLastEdited(row?.updatedAt, row?.updatedBy, userMap);
      };

      res.json({
        config: {
          pendingHours: config.pendingHours,
          failedLookbackHours: config.failedLookbackHours,
          maxAttempts: MAX_ATTEMPTS,
          alertEnabled: config.enabled,
        },
        // Task #1095: full raw threshold values (six knobs) for the
        // inline editor — separate from `config` so the existing card
        // contract stays untouched.
        alertConfig: {
          enabled: config.enabled,
          pendingHours: config.pendingHours,
          pendingCount: config.pendingCount,
          failedLookbackHours: config.failedLookbackHours,
          failedCount: config.failedCount,
          cooldownMinutes: config.cooldownMinutes,
        },
        alertConfigLastEdited: {
          enabled: lastEditedFor(SETTING_ENABLED),
          pendingHours: lastEditedFor(SETTING_PENDING_HOURS),
          pendingCount: lastEditedFor(SETTING_PENDING_COUNT),
          failedLookbackHours: lastEditedFor(SETTING_FAILED_LOOKBACK_HOURS),
          failedCount: lastEditedFor(SETTING_FAILED_COUNT),
          cooldownMinutes: lastEditedFor(SETTING_COOLDOWN),
        },
        pendingStuck: {
          count: pendingCount,
          oldestAgeSeconds,
        },
        recentFailures: {
          count: failedCount,
          lookbackHours: config.failedLookbackHours,
        },
        stuckRows: (stuckRowsResult as any).rows ?? [],
        failedRows: (failedRowsResult as any).rows ?? [],
      });
    } catch (error: any) {
      console.error("[admin/call-archive/health] Error:", error?.message ?? error);
      res.status(500).json({ error: "Failed to load archive pipeline health" });
    }
  });

  // Task #1095: tune the six call-archive alert threshold knobs
  // (`call_archive_alert_*` system_settings) from the admin UI. Gated
  // to CEO like the rest of the archive health card. Each provided
  // field is written via setSystemSetting so the existing updatedAt /
  // updatedBy columns power the LastEditedBadge in the editor and the
  // watcher's getCallArchiveBacklogAlertConfig (no caching) picks up
  // the new value on its next 15-minute tick.
  app.put("/api/admin/twilio/call-archive/alert-config", isAuthenticated, requireCeo, async (req: any, res) => {
    try {
      const schema = z.object({
        enabled: z.boolean().optional(),
        pendingHours: z.number().int().positive().max(24 * 30).optional(),
        pendingCount: z.number().int().positive().max(100_000).optional(),
        failedLookbackHours: z.number().int().positive().max(24 * 30).optional(),
        failedCount: z.number().int().positive().max(100_000).optional(),
        cooldownMinutes: z.number().int().positive().max(60 * 24 * 30).optional(),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0].message });
      }
      const data = parsed.data;
      if (Object.keys(data).length === 0) {
        return res.status(400).json({ error: "Provide at least one threshold to update." });
      }

      const {
        SETTING_ENABLED,
        SETTING_PENDING_HOURS,
        SETTING_PENDING_COUNT,
        SETTING_FAILED_LOOKBACK_HOURS,
        SETTING_FAILED_COUNT,
        SETTING_COOLDOWN,
        getCallArchiveBacklogAlertConfig,
      } = await import("../services/callArchiveBacklogAlerts");
      const { setSystemSetting } = await import("../storage/settingsStorage");
      const userId = req.user.claims.sub;

      const writes: Array<[string, string]> = [];
      if (data.enabled !== undefined) writes.push([SETTING_ENABLED, data.enabled ? "true" : "false"]);
      if (data.pendingHours !== undefined) writes.push([SETTING_PENDING_HOURS, String(data.pendingHours)]);
      if (data.pendingCount !== undefined) writes.push([SETTING_PENDING_COUNT, String(data.pendingCount)]);
      if (data.failedLookbackHours !== undefined) writes.push([SETTING_FAILED_LOOKBACK_HOURS, String(data.failedLookbackHours)]);
      if (data.failedCount !== undefined) writes.push([SETTING_FAILED_COUNT, String(data.failedCount)]);
      if (data.cooldownMinutes !== undefined) writes.push([SETTING_COOLDOWN, String(data.cooldownMinutes)]);

      for (const [key, value] of writes) {
        await setSystemSetting(key, value, userId);
      }

      try {
        await insertActivityLogs([{
          userId,
          actionType: "call_archive_alert_config_updated",
          route: "/api/admin/twilio/call-archive/alert-config",
          actionDetail: `Updated call-archive alert thresholds: ${writes.map(([k]) => k).join(", ")}`,
          metadata: { changedKeys: writes.map(([k]) => k), values: data },
          sessionId: null,
          duration: null,
          timestamp: new Date(),
        }]);
      } catch (logErr: any) {
        console.error("[admin/call-archive/alert-config] audit log failed:", logErr?.message);
      }

      const updated = await getCallArchiveBacklogAlertConfig();
      console.log(`[admin/call-archive/alert-config] Updated ${writes.length} key(s) by user=${userId}`);
      res.json({ alertConfig: updated });
    } catch (error: any) {
      console.error("[admin/call-archive/alert-config] Error:", error?.message ?? error);
      res.status(500).json({ error: "Failed to update alert config" });
    }
  });

  // Task #1094: 24h trend snapshots so the "Archive pipeline health"
  // card and the /admin/twilio/call-archive drill-in can render a
  // sparkline under each counter (pending stuck / oldest age /
  // recent failures). Reads from the periodically-sampled
  // `call_archive_health_snapshots` table — no per-render heavy SQL.
  app.get(
    "/api/admin/twilio/call-archive/health/trend",
    isAuthenticated,
    requireCeo,
    async (req: any, res) => {
      try {
        const { getCallArchiveHealthTrend } = await import(
          "../services/callArchiveBacklogAlerts"
        );
        const rawHours = Number.parseInt(String(req.query.hours ?? "24"), 10);
        const requested = Number.isFinite(rawHours) && rawHours > 0 ? rawHours : 24;
        // Mirror the helper's clamp (max 30d) so the echoed `hours`
        // matches what was actually queried.
        const hours = Math.min(requested, 24 * 30);
        const points = await getCallArchiveHealthTrend(hours);
        res.json({ hours, points });
      } catch (error: any) {
        console.error(
          "[admin/call-archive/health/trend] Error:",
          error?.message ?? error,
        );
        res.status(500).json({ error: "Failed to load archive pipeline trend" });
      }
    },
  );

  // Task #1079: Re-enqueue a single row from the health card. Unlike
  // /requeue (which is restricted to 'failed'), this delegates to
  // enqueueCallArchive so it works for both 'pending' (stuck waiting
  // on the recording-status webhook) and 'failed' (bounded retries
  // exhausted). enqueueCallArchive itself ignores rows that are
  // already in flight (`processing`) or terminal-success (`done` /
  // `skipped`), so this is safe to call against any id.
  app.post("/api/admin/twilio/call-archive/:id/enqueue", isAuthenticated, requireCeo, async (req: any, res) => {
    try {
      const id = String(req.params.id);
      const lookupResult = await getDb().execute(sql`
        SELECT id, archive_status FROM twilio_calls WHERE id = ${id}
      `);
      const row = ((lookupResult as any).rows ?? [])[0];
      if (!row) {
        return res.status(404).json({ error: "Call not found" });
      }
      const { enqueueCallArchive } = await import("../services/callArchivePipeline");
      await enqueueCallArchive(id);
      console.log(`[admin/call-archive] Enqueued call=${id} (was ${row.archive_status ?? "null"}) by user=${req.user.claims.sub}`);
      res.json({ id, previousStatus: row.archive_status ?? null });
    } catch (error: any) {
      console.error("[admin/call-archive/enqueue] Error:", error?.message ?? error);
      res.status(500).json({ error: "Failed to enqueue call" });
    }
  });

  // Task #1079: Batch re-enqueue every currently-stuck pending row
  // (matching the same definition the health card / watcher uses).
  // Bounded to 200 rows per call so an operator can't accidentally
  // enqueue tens of thousands at once.
  app.post("/api/admin/twilio/call-archive/enqueue-stuck", isAuthenticated, requireCeo, async (req: any, res) => {
    try {
      const {
        getCallArchiveBacklogAlertConfig,
        pendingStuckWhere,
      } = await import("../services/callArchiveBacklogAlerts");
      const { enqueueCallArchive } = await import("../services/callArchivePipeline");
      const config = await getCallArchiveBacklogAlertConfig();

      const targets = await getDb().execute(sql`
        SELECT id FROM twilio_calls
        WHERE ${pendingStuckWhere(config.pendingHours)}
        ORDER BY created_at ASC
        LIMIT 200
      `);
      const ids: string[] = ((targets as any).rows ?? []).map((r: any) => String(r.id));
      let enqueued = 0;
      const errors: { id: string; error: string }[] = [];
      for (const id of ids) {
        try {
          await enqueueCallArchive(id);
          enqueued++;
        } catch (err: any) {
          errors.push({ id, error: err?.message ?? "unknown" });
        }
      }
      console.log(`[admin/call-archive] Batch enqueued ${enqueued}/${ids.length} stuck rows by user=${req.user.claims.sub}`);
      res.json({ candidates: ids.length, enqueued, errors });
    } catch (error: any) {
      console.error("[admin/call-archive/enqueue-stuck] Error:", error?.message ?? error);
      res.status(500).json({ error: "Failed to batch-enqueue stuck calls" });
    }
  });

  // Task #1052: One-click requeue for a row that hit the retry ceiling
  // (i.e. landed in `failed` after MAX_ATTEMPTS). Mirrors enqueueCallArchive's
  // behaviour: status=queued, attempts reset to 0 (so the row gets a
  // fresh retry budget — same semantics as the late-recording-status
  // recovery path documented in callArchivePipeline.ts), error cleared,
  // lock cleared, next_attempt_at=now() so the next worker tick picks
  // it up. Strictly limited to `failed` rows: re-queueing a row in
  // `processing` would clear archive_locked_until while a worker may
  // still be active and could double-execute Drive/Twilio side effects;
  // `pending`/`queued` rows are already on a path through the worker
  // so re-queueing them is unnecessary; `done`/`skipped` rows are
  // terminal-success and would redo finished work.
  // Task #1078: stuck-processing inventory for the call recording archive
  // pipeline. Mirrors the work_queue stuck-processing endpoint
  // (`/api/integrations/work-queue/stuck-processing`, Task #1054) but for
  // the call_archive lease, which lives on `twilio_calls.archive_*`
  // columns rather than in `work_queue`.
  //
  // A row is considered "stuck" when archive_status='processing' AND the
  // lease has been released (archive_locked_until <= NOW()) — meaning the
  // heartbeat either revoked the lease (`max_processing_exceeded`, see
  // Task #1055 in callArchivePipeline.ts) or the handler died without
  // writing a terminal status. The next claim tick will reclaim these
  // rows; this endpoint surfaces them so operators can see them live and
  // optionally force-release without waiting.
  // Read-only inventory uses requireAccountManager to match the work_queue
  // stuck-processing endpoint (`/api/integrations/work-queue/stuck-processing`),
  // so the unified Stuck Background Jobs card on the operational health
  // dashboard shows call_archive counts to the same audience that already
  // sees the work_queue counts. The mutating `force-release` action below
  // remains CEO-gated.
  app.get("/api/admin/twilio/call-archive/stuck-processing", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const { getMaxProcessingMs, getEffectiveMaxProcessingMap } = await import(
        "../services/queueMaxProcessing"
      );
      const limitRaw = parseInt(String(req.query?.limit ?? "100"), 10);
      const limit = Math.min(Math.max(isFinite(limitRaw) ? limitRaw : 100, 1), 500);

      // We surface two buckets in one query so the UI can show both:
      //   - lease_released: archive_status='processing' AND archive_locked_until <= NOW()
      //     (the actually-stuck rows — lease ended, row will be reclaimed)
      //   - active: archive_status='processing' AND archive_locked_until > NOW()
      //     (heartbeat still firing — included for visibility so operators
      //     can see how the queue is occupied, capped to `limit` total)
      const result = await getDb().execute(sql`
        SELECT
          id, client_id, twilio_sid, direction, from_number, to_number,
          archive_status, archive_attempts, archive_last_error,
          archive_locked_until, archive_next_attempt_at, archive_leased_at, updated_at,
          recording_sid, recording_status,
          -- Task #1099: prefer the explicit lease epoch (set by the
          -- claim SQL, never touched by the heartbeat) over updated_at
          -- (which can be bumped by intermediate writes like
          -- transcript_error). Fall back to updated_at for legacy rows
          -- where archive_leased_at is still null.
          EXTRACT(EPOCH FROM (NOW() - COALESCE(archive_leased_at, updated_at))) * 1000 AS processing_age_ms,
          EXTRACT(EPOCH FROM (NOW() - archive_locked_until)) * 1000 AS lease_released_ms,
          EXTRACT(EPOCH FROM (archive_locked_until - NOW())) * 1000 AS lease_remaining_ms
        FROM twilio_calls
        WHERE archive_status = 'processing'
        ORDER BY archive_locked_until ASC NULLS FIRST
        LIMIT ${limit}
      `);
      const rows = ((result as any).rows ?? []) as any[];

      const ceilingMs = await getMaxProcessingMs("call_archive");
      const map = await getEffectiveMaxProcessingMap();

      const items = rows.map((r) => {
        const leaseReleasedMs = r.lease_released_ms == null ? null : Number(r.lease_released_ms);
        const leaseRemainingMs = r.lease_remaining_ms == null ? null : Number(r.lease_remaining_ms);
        const processingAgeMs = r.processing_age_ms == null ? null : Number(r.processing_age_ms);
        const leaseReleased = leaseRemainingMs != null && leaseRemainingMs <= 0;
        const overCeiling = processingAgeMs != null && processingAgeMs > ceilingMs;
        return {
          id: r.id,
          clientId: r.client_id,
          twilioSid: r.twilio_sid,
          direction: r.direction,
          fromNumber: r.from_number,
          toNumber: r.to_number,
          archiveStatus: r.archive_status,
          archiveAttempts: Number(r.archive_attempts ?? 0),
          archiveLastError: r.archive_last_error,
          archiveLockedUntil: r.archive_locked_until,
          archiveLeasedAt: r.archive_leased_at,
          updatedAt: r.updated_at,
          recordingStatus: r.recording_status,
          processingAgeMs,
          leaseRemainingMs,
          leaseReleasedMs: leaseReleased ? leaseReleasedMs : null,
          leaseReleased,
          overCeiling,
          willReclaim: leaseReleased,
        };
      });

      // Two separate counters so the UI can distinguish:
      //   - leaseReleasedCount: lease has actually expired/been revoked, the
      //     next claim tick will reclaim. These are the rows "Force release"
      //     can act on.
      //   - overCeilingCount: processing-age has exceeded the ceiling, but the
      //     heartbeat may still be extending the lease (a brief window before
      //     the heartbeat revokes it). Surfaced for visibility, not yet
      //     actionable.
      const leaseReleasedCount = items.filter((i) => i.leaseReleased).length;
      const overCeilingCount = items.filter((i) => i.overCeiling).length;
      // Total "stuck" surface area = anything either over ceiling or with a
      // released lease (deduped). Healthy active processing rows are the
      // remainder.
      const stuckCount = items.filter((i) => i.leaseReleased || i.overCeiling).length;

      res.json({
        rows: items,
        stuckCount,
        leaseReleasedCount,
        overCeilingCount,
        activeCount: items.length - stuckCount,
        totalRows: items.length,
        maxProcessingMs: ceilingMs,
        maxProcessingMap: map,
        queueName: "call_archive",
      });
    } catch (error: any) {
      console.error("[admin/call-archive] stuck-processing error:", error?.message ?? error);
      res.status(500).json({ error: "Failed to load stuck call recordings" });
    }
  });

  // Task #1078: one-click recovery for a stuck-processing call recording.
  // Mirrors the implicit recovery the next claim tick would do (claim SQL
  // bumps `archive_attempts` and resets to processing) but operator-driven
  // so they don't have to wait. Only valid when the lease has actually
  // been released (archive_locked_until <= NOW()) — releasing a still-active
  // lease would race with the running handler. Bumping `archive_attempts`
  // also invalidates any late terminal write the stale handler might still
  // make (recordFailure / done write are lease-guarded on
  // `archive_attempts = expectedAttempts`, see callArchivePipeline.ts).
  app.post("/api/admin/twilio/call-archive/:id/force-release", isAuthenticated, requireCeo, async (req: any, res) => {
    try {
      const id = String(req.params.id);
      const lookupResult = await getDb().execute(sql`
        SELECT id, archive_status, archive_locked_until, archive_attempts
        FROM twilio_calls WHERE id = ${id}
      `);
      const row = ((lookupResult as any).rows ?? [])[0];
      if (!row) {
        return res.status(404).json({ error: "Call not found" });
      }
      if (row.archive_status !== "processing") {
        return res.status(409).json({
          error: `Force-release is only allowed for rows in 'processing' state (this row is '${row.archive_status ?? "null"}')`,
        });
      }
      const lockedUntil = row.archive_locked_until ? new Date(row.archive_locked_until) : null;
      if (lockedUntil && lockedUntil.getTime() > Date.now()) {
        return res.status(409).json({
          error: "Lease is still active (heartbeat is extending it). Wait for the lease to expire or the heartbeat to revoke it before force-releasing.",
        });
      }
      const now = new Date();
      // Bump attempts so any in-flight stale handler write is no-op'd by
      // the lease guard on archive_attempts. Reset to 'queued' so the
      // next claim tick picks it up immediately. Don't reset attempts to
      // 0 — that would defeat the bounded retry budget.
      const updateResult = await getDb().execute(sql`
        UPDATE twilio_calls
        SET archive_status = 'queued',
            archive_attempts = COALESCE(archive_attempts, 0) + 1,
            archive_locked_until = NULL,
            archive_next_attempt_at = ${now},
            archive_last_error = COALESCE(archive_last_error, 'force-released by operator while stuck in processing'),
            updated_at = ${now}
        WHERE id = ${id}
          AND archive_status = 'processing'
          AND archive_attempts = ${Number(row.archive_attempts ?? 0)}
        RETURNING id
      `);
      const updatedRows = ((updateResult as any).rows ?? []) as any[];
      if (updatedRows.length === 0) {
        return res.status(409).json({
          error: "Row state changed concurrently — try again",
        });
      }
      console.log(
        `[admin/call-archive] Force-released stuck row call=${id} prevAttempts=${row.archive_attempts ?? 0} by user=${req.user.claims.sub}`,
      );
      res.json({ id, archiveStatus: "queued" });
    } catch (error: any) {
      console.error("[admin/call-archive] force-release error:", error?.message ?? error);
      res.status(500).json({ error: "Failed to force-release call" });
    }
  });

  // Task #1086: Recent re-queue events feed for the admin UI.
  // Returns the most recent ~20 rows from call_archive_requeue_audit
  // joined with the user's display name/email so the page can render
  // "Operator name re-queued N rows X minutes ago".
  app.get("/api/admin/twilio/call-archive/requeue-audit", isAuthenticated, requireCeo, async (req: any, res) => {
    try {
      const limitParam = Number(req.query?.limit);
      const limit = Number.isFinite(limitParam) && limitParam > 0
        ? Math.min(Math.max(Math.trunc(limitParam), 1), 100)
        : 20;
      const rows = await getDb()
        .select({
          id: callArchiveRequeueAudit.id,
          userId: callArchiveRequeueAudit.userId,
          mode: callArchiveRequeueAudit.mode,
          targetCallId: callArchiveRequeueAudit.targetCallId,
          affectedCount: callArchiveRequeueAudit.affectedCount,
          note: callArchiveRequeueAudit.note,
          createdAt: callArchiveRequeueAudit.createdAt,
          userFirstName: users.firstName,
          userLastName: users.lastName,
          userEmail: users.email,
        })
        .from(callArchiveRequeueAudit)
        .leftJoin(users, eq(users.id, callArchiveRequeueAudit.userId))
        .orderBy(desc(callArchiveRequeueAudit.createdAt))
        .limit(limit);
      res.json({ rows, limit });
    } catch (error: any) {
      console.error("[admin/call-archive] Requeue audit list error:", error?.message ?? error);
      res.status(500).json({ error: "Failed to load re-queue audit history" });
    }
  });

  app.post("/api/admin/twilio/call-archive/:id/requeue", isAuthenticated, requireCeo, async (req: any, res) => {
    try {
      const id = String(req.params.id);
      const lookupResult = await getDb().execute(sql`
        SELECT id, archive_status FROM twilio_calls WHERE id = ${id}
      `);
      const row = ((lookupResult as any).rows ?? [])[0];
      if (!row) {
        return res.status(404).json({ error: "Call not found" });
      }
      if (row.archive_status !== "failed") {
        return res.status(409).json({
          error: `Re-queue is only allowed for rows in 'failed' state (this row is '${row.archive_status ?? "null"}')`,
        });
      }
      const now = new Date();
      await getDb().execute(sql`
        UPDATE twilio_calls
        SET archive_status = 'queued',
            archive_attempts = 0,
            archive_last_error = NULL,
            archive_locked_until = NULL,
            archive_next_attempt_at = ${now},
            updated_at = ${now}
        WHERE id = ${id}
      `);
      console.log(`[admin/call-archive] Requeued call=${id} by user=${req.user.claims.sub}`);
      // Task #1086: persist a row to the in-app re-queue audit trail so
      // operators can see who kicked the pipeline last week without
      // grepping server logs. Failures here must not block the
      // re-queue itself — the row is already updated above.
      try {
        await getDb().insert(callArchiveRequeueAudit).values({
          userId: req.user.claims.sub,
          mode: "single",
          targetCallId: id,
          affectedCount: 1,
        });
      } catch (auditErr: any) {
        console.error(
          "[admin/call-archive] Failed to write requeue audit row:",
          auditErr?.message ?? auditErr,
        );
      }
      res.json({ id, archiveStatus: "queued" });
    } catch (error: any) {
      console.error("[admin/call-archive] Requeue error:", error?.message ?? error);
      res.status(500).json({ error: "Failed to requeue call" });
    }
  });

  // Task #1082: Bulk re-queue. Two modes:
  //   { status: 'failed' }  → re-queue every row in archive_status='failed'
  //   { stuck: true }       → re-queue every "stuck" row (archive_status='pending'
  //                           with no recording_url / recording_sid — the
  //                           recording-status webhook never delivered).
  // Only these two selectors are accepted (the single-row endpoint above
  // documents why other statuses are unsafe). Updates run in a single
  // transaction so a partial failure doesn't leave half the rows
  // re-queued. Returns the affected row count and the operator's user id
  // for the audit log.
  app.post("/api/admin/twilio/call-archive/requeue-bulk", isAuthenticated, requireCeo, async (req: any, res) => {
    try {
      const status = typeof req.body?.status === "string" ? req.body.status : null;
      const stuck = req.body?.stuck === true;
      let mode: "failed" | "stuck";
      let whereClause: any;
      if (status === "failed" && !stuck) {
        mode = "failed";
        whereClause = sql`archive_status = 'failed'`;
      } else if (stuck && !status) {
        mode = "stuck";
        whereClause = sql`archive_status = 'pending' AND recording_url IS NULL AND recording_sid IS NULL`;
      } else {
        return res.status(400).json({
          error: "Body must be exactly one of { status: 'failed' } or { stuck: true }",
        });
      }
      const now = new Date();
      const result = await getDb().transaction(async (tx) => {
        return tx.execute(sql`
          UPDATE twilio_calls
          SET archive_status = 'queued',
              archive_attempts = 0,
              archive_last_error = NULL,
              archive_locked_until = NULL,
              archive_next_attempt_at = ${now},
              updated_at = ${now}
          WHERE ${whereClause}
        `);
      });
      const count = (result as any).rowCount ?? (result as any).rows?.length ?? 0;
      console.log(
        `[admin/call-archive] Bulk re-queue mode=${mode} count=${count} by user=${req.user.claims.sub}`,
      );
      // Task #1086: write one audit row per bulk invocation. We don't
      // record the individual target ids here — the count is enough for
      // the "Recent re-queues" panel and bulk runs can affect hundreds
      // of rows. Audit failure must not roll back the re-queue.
      try {
        await getDb().insert(callArchiveRequeueAudit).values({
          userId: req.user.claims.sub,
          mode: mode === "failed" ? "bulk_failed" : "bulk_stuck",
          targetCallId: null,
          affectedCount: count,
        });
      } catch (auditErr: any) {
        console.error(
          "[admin/call-archive] Failed to write bulk requeue audit row:",
          auditErr?.message ?? auditErr,
        );
      }
      res.json({ mode, count });
    } catch (error: any) {
      console.error("[admin/call-archive] Bulk requeue error:", error?.message ?? error);
      res.status(500).json({ error: "Failed to bulk re-queue calls" });
    }
  });

  app.put("/api/users/me/timezone", isAuthenticated, async (req: any, res) => {
    try {
      const { timezone } = req.body;
      if (!timezone || typeof timezone !== "string") {
        return res.status(400).json({ error: "Invalid timezone" });
      }
      try {
        Intl.DateTimeFormat(undefined, { timeZone: timezone });
      } catch {
        return res.status(400).json({ error: "Invalid timezone identifier" });
      }
      // Task #1033: mark the source as 'user' so the Google Calendar
      // timezone seeder never overwrites this explicit pick.
      const [updated] = await db.update(users)
        .set({ timezone, displayTimezoneSource: "user", updatedAt: new Date() })
        .where(eq(users.id, req.user.claims.sub))
        .returning();
      res.json(updated);
    } catch (error: any) {
      console.error("[Settings] Timezone update error:", error.message);
      res.status(500).json({ error: "Failed to update timezone" });
    }
  });

  // Task #4377 — app-wide dark mode. Persists the per-user theme
  // preference read by the client ThemeProvider from /api/auth/user.
  app.put("/api/users/me/theme", isAuthenticated, async (req: any, res) => {
    try {
      const parsed = z
        .object({ theme: z.enum(["light", "dark", "system"]) })
        .safeParse(req.body);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: parsed.error.issues[0]?.message ?? "Invalid theme" });
      }
      const [updated] = await db.update(users)
        .set({ themePreference: parsed.data.theme, updatedAt: new Date() })
        .where(eq(users.id, req.user.claims.sub))
        .returning();
      res.json(updated);
    } catch (error: any) {
      console.error("[Settings] Theme update error:", error.message);
      res.status(500).json({ error: "Failed to update theme" });
    }
  });
}
