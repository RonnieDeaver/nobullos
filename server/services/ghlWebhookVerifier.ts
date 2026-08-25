/**
 * Task #5105 — HighLevel Marketplace inbound webhook verifier + event parser.
 *
 * Authentication model:
 *   - HighLevel Marketplace apps sign every webhook delivery with an Ed25519
 *     key pair. The public key is published in the HighLevel developer docs
 *     (https://highlevel.stoplight.io/docs/integrations/). We store it as a
 *     base64-encoded SPKI DER Ed25519 public key in GHL_MARKETPLACE_PUBLIC_KEY
 *     (env var).
 *   - The signature is delivered in the `X-GHL-Signature` request header as a
 *     base64-encoded Ed25519 signature over the raw request body bytes.
 *   - FAIL CLOSED: if the env var is absent/blank the caller must return 503
 *     before touching the body. No unsigned, HMAC, or custom-workflow fallback
 *     is ever accepted.
 *
 * Location scope:
 *   - A non-empty configuredLocationId is REQUIRED to validate that an event
 *     belongs to this NoBull installation. If the configured location ID cannot
 *     be read (DB error, absent setting) the caller must return 503 to prevent
 *     accepting events from any GHL location.
 *
 * DND / opt-out policy (GHL.md):
 *   - GHL may only tighten consent, never relax it.
 *   - Tighten signals write opted_out via the smsConsent storage seam.
 *   - Email unsubscribe is accepted only from ContactDndUpdate where the
 *     channel-specific dndSettings.Email.status is exactly "active".
 *   - GHL is NEVER accepted as affirmative consent authority; no opted_in
 *     or subscribed write is issued from this module under any circumstances.
 *
 * AppointmentCreate handling:
 *   - If no appointment correlation exists, the handler looks up the local
 *     book contact via a GHL contact correlation, finds or creates the audit
 *     application deterministically, creates the appointment row, writes the
 *     appointment correlation, then transitions to scheduled. Missing contact
 *     correlation or ambiguous application → retryable 500, not silent loss.
 */
import crypto from "node:crypto";

/** Env-var name that holds the base64 SPKI DER Ed25519 public key. */
export const GHL_MARKETPLACE_PUBLIC_KEY_ENV = "GHL_MARKETPLACE_PUBLIC_KEY";

/**
 * Returns true when the verifier is fully configured (key present and
 * non-blank). Never reveals the key value.
 */
export function isGhlWebhookConfigured(): boolean {
  const raw = process.env[GHL_MARKETPLACE_PUBLIC_KEY_ENV];
  return typeof raw === "string" && raw.trim().length > 0;
}

/**
 * Verify an X-GHL-Signature Ed25519 signature over the raw body bytes.
 *
 * @param rawBody   The exact bytes delivered in the request (Buffer or string).
 * @param sigHeader The value of the X-GHL-Signature header.
 * @returns true iff the signature is valid and the key is configured.
 */
export function verifyGhlSignature(
  rawBody: Buffer | string,
  sigHeader: string | undefined,
): boolean {
  const keyEnv = process.env[GHL_MARKETPLACE_PUBLIC_KEY_ENV]?.trim();
  if (!keyEnv) return false;
  if (!sigHeader || sigHeader.trim().length === 0) return false;

  try {
    const pubKeyBytes = Buffer.from(keyEnv, "base64");
    const keyObject = crypto.createPublicKey({
      key: pubKeyBytes,
      format: "der",
      type: "spki",
    });
    const sigBytes = Buffer.from(sigHeader.trim(), "base64");
    const bodyBytes = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody);
    return crypto.verify(null, bodyBytes, keyObject, sigBytes);
  } catch {
    return false;
  }
}

// ── GHL event type allow-list ─────────────────────────────────────────────────

export const GHL_APPOINTMENT_EVENT_TYPES = [
  "AppointmentCreate",
  "AppointmentUpdate",
] as const;
export type GhlAppointmentEventType = (typeof GHL_APPOINTMENT_EVENT_TYPES)[number];

export const GHL_DND_EVENT_TYPES = [
  "ContactDndUpdate",
  "InboundMessage",
] as const;
export type GhlDndEventType = (typeof GHL_DND_EVENT_TYPES)[number];

// ── GHL appointment status → NoBull status mapping ───────────────────────────

export type NoBullAppointmentStatus =
  | "scheduled"
  | "completed"
  | "cancelled"
  | "no_show";

const GHL_TO_NOBULL_STATUS: Record<string, NoBullAppointmentStatus> = {
  confirmed: "scheduled",
  new:       "scheduled",
  showed:    "completed",
  completed: "completed",
  cancelled: "cancelled",
  canceled:  "cancelled",
  "no-show": "no_show",
  no_show:   "no_show",
  noshow:    "no_show",
};

/**
 * Map a GHL appointment status string to the NoBull BookAppointmentStatus, or
 * null if no mapping exists (event should be ignored).
 */
export function mapGhlAppointmentStatus(
  ghlStatus: string | undefined | null,
): NoBullAppointmentStatus | null {
  if (!ghlStatus) return null;
  return GHL_TO_NOBULL_STATUS[ghlStatus.toLowerCase().trim()] ?? null;
}

// ── Parsed event shapes ───────────────────────────────────────────────────────

export interface GhlParsedAppointmentEvent {
  kind: "appointment";
  eventType: GhlAppointmentEventType;
  locationId: string;
  /** GHL appointment ID — primary correlation key. */
  appointmentId: string;
  /** GHL contact ID — secondary correlation key for AppointmentCreate. */
  contactId: string | null;
  /** Mapped NoBull status — null means ignore (unknown GHL status). */
  noBullStatus: NoBullAppointmentStatus | null;
  /** Raw GHL status string for evidence. */
  ghlStatus: string | null;
  /** ISO-8601 scheduled start time, if present. */
  startTime: string | null;
  /** IANA timezone, if present. */
  timezone: string | null;
  /**
   * GHL-supplied event/delivery ID for durable replay dedupe.
   * Keyed from body.id, body.eventId, or body.deliveryId.
   */
  ghlEventId: string | null;
}

export interface GhlParsedDndEvent {
  kind: "dnd";
  eventType: GhlDndEventType;
  locationId: string;
  /** GHL contact ID. */
  contactId: string | null;
  /** Phone number as delivered by GHL (may need normalization). */
  phone: string | null;
  /** Why this is a DND/opt-out signal. */
  reason: "contact_dnd_enabled" | "inbound_stop_keyword";
  /**
   * GHL-supplied event/delivery ID for durable replay dedupe.
   * Used as the messageSid equivalent in sms_consent_events.
   */
  ghlEventId: string | null;
}

export interface GhlParsedEmailUnsubscribeEvent {
  kind: "email_unsubscribe";
  eventType: "ContactDndUpdate";
  locationId: string;
  /** GHL contact ID (`id` in the documented ContactDndUpdate payload). */
  contactId: string;
  /** Address GHL marked Email DND active. */
  email: string;
  /** A combined channel update may tighten SMS in the same signed delivery. */
  smsOptOut: boolean;
  phone: string | null;
  reason: "email_dnd_active";
  /**
   * GHL delivery ID when one is supplied. `id` is deliberately excluded here:
   * the documented ContactDndUpdate contract uses it for the contact ID.
   */
  ghlEventId: string | null;
}

export interface GhlIgnoredEvent {
  kind: "ignored";
  eventType: string;
  locationId: string | null;
}

/** Sentinel sub-type for wrong-location rejections. */
export interface GhlWrongLocationEvent {
  kind: "wrong_location";
  payloadLocationId: string;
}

export type GhlParsedEvent =
  | GhlParsedAppointmentEvent
  | GhlParsedDndEvent
  | GhlParsedEmailUnsubscribeEvent
  | GhlIgnoredEvent
  | GhlWrongLocationEvent;

/** STOP-family keywords GHL may deliver as message body or messageType. */
const STOP_KEYWORDS = new Set([
  "STOP",
  "STOPALL",
  "UNSUBSCRIBE",
  "CANCEL",
  "END",
  "QUIT",
]);

/**
 * Extract a GHL event/delivery ID from a payload object for replay dedupe.
 * GHL uses inconsistent field names across event types; we probe in priority order.
 */
function extractGhlEventId(
  b: Record<string, unknown>,
  options: { includeRootId?: boolean } = {},
): string | null {
  const fields = options.includeRootId === false
    ? ["eventId", "deliveryId", "webhookId"]
    : ["eventId", "deliveryId", "webhookId", "id"];
  for (const field of fields) {
    if (typeof b[field] === "string" && (b[field] as string).trim().length > 0) {
      return (b[field] as string).trim();
    }
  }
  return null;
}

function channelDndStatus(
  body: Record<string, unknown>,
  channel: "Email" | "SMS",
): string | null {
  const settings = body["dndSettings"];
  if (settings === null || typeof settings !== "object" || Array.isArray(settings)) {
    return null;
  }
  const channelSettings = (settings as Record<string, unknown>)[channel];
  if (
    channelSettings === null ||
    typeof channelSettings !== "object" ||
    Array.isArray(channelSettings)
  ) {
    return null;
  }
  const status = (channelSettings as Record<string, unknown>)["status"];
  return typeof status === "string" ? status.trim().toLowerCase() : null;
}

function isValidEmailAddress(value: string): boolean {
  return (
    value.length <= 320 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
  );
}

function isSafeOpaqueIdentifier(value: string): boolean {
  return value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
}

/**
 * Parse and tightly validate a GHL Marketplace webhook payload.
 *
 * @param body                 The JSON-parsed request body (unknown).
 * @param configuredLocationId The location ID from system_settings. Must be
 *   non-empty; if empty the caller must have already returned 503.
 */
export function parseGhlWebhookEvent(
  body: unknown,
  configuredLocationId: string,
): GhlParsedEvent | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }
  const b = body as Record<string, unknown>;

  const eventType = typeof b["type"] === "string" ? b["type"].trim() : null;
  if (!eventType) return null;

  const payloadLocationId =
    typeof b["locationId"] === "string" ? b["locationId"].trim() : null;

  // locationId is mandatory in every GHL Marketplace webhook payload.
  if (!payloadLocationId) return null;

  // Location scope: configured location must match.
  if (payloadLocationId !== configuredLocationId) {
    return { kind: "wrong_location", payloadLocationId };
  }

  const ghlEventId = extractGhlEventId(b);

  // ── Appointment events ──────────────────────────────────────────────────────
  if (eventType === "AppointmentCreate" || eventType === "AppointmentUpdate") {
    // GHL may embed appointment facts under body.appointment or at root.
    const appt =
      b["appointment"] !== null &&
      typeof b["appointment"] === "object" &&
      !Array.isArray(b["appointment"])
        ? (b["appointment"] as Record<string, unknown>)
        : b;

    const appointmentId =
      typeof appt["id"] === "string" ? appt["id"].trim() :
      typeof appt["appointmentId"] === "string" ? appt["appointmentId"].trim() :
      null;
    if (!appointmentId) return null;

    const contactId =
      typeof appt["contactId"] === "string" ? appt["contactId"].trim() :
      typeof b["contactId"] === "string" ? b["contactId"].trim() :
      null;

    const ghlStatus =
      typeof appt["status"] === "string" ? appt["status"].trim() :
      typeof b["status"] === "string" ? b["status"].trim() :
      null;

    const startTime =
      typeof appt["startTime"] === "string" ? appt["startTime"].trim() :
      typeof appt["start_time"] === "string" ? appt["start_time"].trim() :
      null;

    const timezone =
      typeof appt["timezone"] === "string" ? appt["timezone"].trim() :
      typeof b["timezone"] === "string" ? b["timezone"].trim() :
      null;

    return {
      kind: "appointment",
      eventType: eventType as GhlAppointmentEventType,
      locationId: payloadLocationId,
      appointmentId,
      contactId,
      noBullStatus: mapGhlAppointmentStatus(ghlStatus),
      ghlStatus,
      startTime: startTime || null,
      timezone: timezone || null,
      ghlEventId,
    };
  }

  // ── DND events ──────────────────────────────────────────────────────────────
  if (eventType === "ContactDndUpdate") {
    const emailDndActive = channelDndStatus(b, "Email") === "active";
    const smsDndActive = channelDndStatus(b, "SMS") === "active";
    const contactId =
      typeof b["contactId"] === "string" && b["contactId"].trim().length > 0
        ? b["contactId"].trim()
        : typeof b["id"] === "string" && b["id"].trim().length > 0
          ? b["id"].trim()
          : null;
    const emailContactId =
      typeof b["id"] === "string" && b["id"].trim().length > 0
        ? b["id"].trim()
        : null;
    const legacyContactId =
      typeof b["contactId"] === "string" && b["contactId"].trim().length > 0
        ? b["contactId"].trim()
        : null;
    const email =
      typeof b["email"] === "string" ? b["email"].trim().toLowerCase() : null;
    const phone =
      typeof b["phone"] === "string" ? b["phone"].trim() :
      typeof b["phoneNumber"] === "string" ? b["phoneNumber"].trim() :
      null;

    // Owner-approved email unsubscribe contract: the official, signed
    // ContactDndUpdate payload must identify the contact and address, and the
    // channel-specific Email DND status must be active. Missing identity makes
    // the subscribed-state transition unverifiable, so reject it as malformed.
    if (emailDndActive) {
      if (
        !emailContactId ||
        !isSafeOpaqueIdentifier(emailContactId) ||
        (legacyContactId !== null && legacyContactId !== emailContactId) ||
        !email ||
        !isValidEmailAddress(email)
      ) {
        return null;
      }
      const deliveryId = extractGhlEventId(b, { includeRootId: false });
      return {
        kind: "email_unsubscribe",
        eventType: "ContactDndUpdate",
        locationId: payloadLocationId,
        contactId: emailContactId,
        email,
        smsOptOut: smsDndActive,
        phone,
        reason: "email_dnd_active",
        // Root `id` is the contact ID for this event contract, never a delivery
        // ID. A payload without a delivery ID is deduped by raw-body hash.
        ghlEventId:
          deliveryId && isSafeOpaqueIdentifier(deliveryId) ? deliveryId : null,
      };
    }

    const dndPayload = b["dnd"];
    const hasChannelSettings =
      b["dndSettings"] !== null &&
      typeof b["dndSettings"] === "object" &&
      !Array.isArray(b["dndSettings"]);
    // Tighten-only: process documented SMS DND when active. Preserve the
    // legacy boolean/object shape only when channel settings are absent.
    const isDndEnabled =
      smsDndActive ||
      (!hasChannelSettings &&
        (dndPayload === true ||
          (dndPayload !== null &&
            typeof dndPayload === "object" &&
            !Array.isArray(dndPayload) &&
            Object.values(dndPayload as Record<string, unknown>).some((v) => v === true))));

    if (!isDndEnabled) {
      return { kind: "ignored", eventType, locationId: payloadLocationId };
    }

    return {
      kind: "dnd",
      eventType: "ContactDndUpdate",
      locationId: payloadLocationId,
      contactId,
      phone,
      reason: "contact_dnd_enabled",
      // Root `id` is the contact ID in the official ContactDndUpdate shape.
      ghlEventId: extractGhlEventId(b, { includeRootId: false }),
    };
  }

  if (eventType === "InboundMessage") {
    const msgType =
      typeof b["messageType"] === "string"
        ? b["messageType"].trim().toUpperCase()
        : null;
    const msgBody =
      typeof b["message"] === "string"
        ? b["message"].trim().toUpperCase()
        : typeof b["body"] === "string"
        ? b["body"].trim().toUpperCase()
        : null;

    const isStop =
      (msgType !== null && STOP_KEYWORDS.has(msgType)) ||
      (msgBody !== null && STOP_KEYWORDS.has(msgBody));

    if (!isStop) {
      return { kind: "ignored", eventType, locationId: payloadLocationId };
    }

    const contactId =
      typeof b["contactId"] === "string" ? b["contactId"].trim() : null;
    const phone =
      typeof b["phone"] === "string" ? b["phone"].trim() :
      typeof b["from"] === "string" ? b["from"].trim() :
      typeof b["phoneNumber"] === "string" ? b["phoneNumber"].trim() :
      null;

    return {
      kind: "dnd",
      eventType: "InboundMessage",
      locationId: payloadLocationId,
      contactId,
      phone,
      reason: "inbound_stop_keyword",
      ghlEventId,
    };
  }

  // Unrecognised event type — safe acknowledged ignore.
  return { kind: "ignored", eventType, locationId: payloadLocationId };
}
