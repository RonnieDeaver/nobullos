// @db-pool-intent: api
/**
 * Task #5105 — HighLevel Marketplace inbound appointment/DND webhook.
 *
 * Route: POST /api/integrations/ghl/marketplace-webhook
 * Limiter: WEBHOOK_PATHS (webhookLimiter). No session auth.
 *
 * ── Authentication ─────────────────────────────────────────────────────────
 * Ed25519 signature in X-GHL-Signature over the exact raw body bytes.
 * GHL_MARKETPLACE_PUBLIC_KEY (env, base64 SPKI DER) is the sole trust anchor.
 * Fail closed:
 *   - absent/blank public key            → 503 (never process unverifiable events)
 *   - configured location ID unreadable  → 503 (cannot scope to this location)
 *   - invalid/missing/wrong-key sig      → 401
 *   - wrong locationId in payload        → 403
 *
 * ── Appointment events (single shared bootstrap path) ──────────────────────
 * AppointmentCreate AND AppointmentUpdate share ONE bootstrap routine:
 *   1. If an appointment correlation exists:
 *        - same mapped status + changed startTime/timezone → RESCHEDULE
 *          (update schedule only, no status transition) → 200 "rescheduled".
 *        - same status, no schedule change → 200 "already_in_target_state".
 *        - different status → legal BookAppointment transition.
 *   2. If no appointment correlation exists (Create OR Update):
 *        - Require a GHL contact correlation → local book contact.
 *        - RESOLVE (never fabricate) an existing audit application via the
 *          deterministic key "ghl-appt:<ghlApptId>" then the most-recent
 *          qualified/submitted application for the contact.
 *        - No contact correlation / no resolvable application / no contactId →
 *          retryable 500 (operator reconciliation; GHL redelivers).
 *        - Otherwise: upsert appointment on the resolved application, write the
 *          appointment correlation, then transition into the mapped status.
 *   - Idempotent on replay: provider correlation + lifecycle idempotency keys
 *     make every step a DB-level no-op on redelivery.
 *
 * ── DND / opt-out (tighten-only, replay-safe) ──────────────────────────────
 * ContactDndUpdate (DND enabled) / InboundMessage (STOP-family):
 *   - The GHL event ID is prefixed "ghl:" and, when the payload lacks any ID,
 *     a deterministic sha256(rawBody) key is derived so every delivery has a
 *     stable dedupe key.
 *   - applyDedupedConsentStateChange runs a SINGLE transaction: it inserts the
 *     event row (ON CONFLICT (message_sid) DO NOTHING) and ONLY upserts the
 *     ledger when the event was newly inserted. Replays are true no-ops — no
 *     optedOutAt/evidence churn.
 *   - The opt-out-storm watcher fires ONLY when eventInserted && changed.
 *   - GHL is NEVER accepted as affirmative consent authority — no opted_in
 *     write is ever issued.
 *   - DND cleared / non-STOP InboundMessage → 200 ignored, no mutation.
 *
 * ContactDndUpdate email unsubscribe:
 *   - Accept ONLY the owner-approved channel-specific contract:
 *     dndSettings.Email.status === "active", with `id` (GHL contact ID) and a
 *     valid `email`, after signature + location verification.
 *   - Add/reconfirm the address in the canonical NoBull email suppression list,
 *     cancel promotional sequence enrollment, and conditionally tighten the
 *     matching book contact to `unsubscribed`.
 *   - Never create a contact and never write `subscribed`.
 *   - Source/notes remain visible in the existing operator suppression list,
 *     including missing-correlation or email-mismatch discrepancies.
 *
 * ── Opportunity status (advisory-only, GHL never authoritative) ────────────
 * GHL opportunity stage movement (won/lost/close) is, per GHL.md §9/§17, a
 * GHL-INTERNAL salesperson workflow. The official inbound Marketplace
 * opportunity event field shape is not proven in this repo, so this route does
 * NOT parse opportunity events as authoritative. Revenue/payment authority
 * stays with NoBull OS (Stripe). Opportunity close/lost reconciliation is an
 * operator action (GHL.md §17). See GHL.md "Inbound Marketplace webhook".
 *
 * Unknown event types → 200 ignored. Structurally invalid body → 400.
 * Transient processing errors → 500 (keeps GHL redelivery alive).
 */
// @db-pool-intent: api
import crypto from "node:crypto";
import type { Express } from "express";
import {
  isGhlWebhookConfigured,
  verifyGhlSignature,
  parseGhlWebhookEvent,
} from "../services/ghlWebhookVerifier";
import { storage } from "../storage";
import { GHL_LOCATION_ID_SETTING_KEY } from "../services/ghlIntegration";
import {
  transitionBookAppointment,
  insertBookProviderCorrelation,
  upsertBookAppointment,
  updateBookAppointmentSchedule,
  resolveBookAuditApplicationForBootstrap,
  type BookAppointmentStatus,
} from "../storage/bookCommerceEngagementStorage";
import {
  bookContacts,
  bookAppointments,
  bookProviderCorrelations,
  bookEmailMarketingTightenableStates,
} from "@shared/schema";
import { eq, and, inArray } from "drizzle-orm";
import { getDb, withDbAttribution } from "../db";
import { normalizeToE164, getPhoneMatchKey } from "../services/phoneNormalization";
import { applyDedupedConsentStateChange } from "../storage/smsConsentStorage";
import { recordSmsOptOutAndEvaluate } from "../services/smsOptOutStormAlerts";
import { addEmailSuppressionWithSideEffects } from "../services/outboundEmail";
import { normalizeEmailAddress } from "../storage/outboundEmailStorage";

// ── Provider constants ────────────────────────────────────────────────────────

const GHL_PROVIDER = "ghl";
const GHL_APPOINTMENT_ENTITY_TYPE = "appointment";
const GHL_CONTACT_ENTITY_TYPE = "contact";
const LOCAL_APPOINTMENT_ENTITY_TYPE = "appointment";

// ── Injectable storage seams (test overrides) ─────────────────────────────────
//
// The `__test_set*` helpers install in-memory stubs so the hermetic test suite
// can exercise the full route without any DB access. Production code never
// calls these; they are exported only for the test file.

type LocationResolver = () => Promise<string | null>;
type AppointmentByGhlIdFn = (
  ghlAppointmentId: string,
) => Promise<{
  id: string;
  status: string;
  contactId: string | null;
  scheduledAt: Date | null;
  timezone: string | null;
} | null>;
type ContactByGhlIdFn = (
  ghlContactId: string,
) => Promise<{ id: string } | null>;
type ResolveApplicationFn = (params: {
  contactId: string;
  deterministicIdempotencyKey: string;
}) => Promise<{ id: string; status: string } | null>;
type UpsertAppointmentFn = (params: {
  auditApplicationId: string;
  scheduledAt?: Date | undefined;
  timezone?: string | undefined;
}) => Promise<{ id: string; status: string }>;
type WriteAppointmentCorrelationFn = (params: {
  ghlAppointmentId: string;
  localAppointmentId: string;
}) => Promise<void>;
type RescheduleAppointmentFn = (params: {
  appointmentId: string;
  scheduledAt?: Date | undefined;
  timezone?: string | undefined;
}) => Promise<{ updated: boolean }>;
type TransitionAppointmentFn = (params: {
  appointmentId: string;
  fromStatus: BookAppointmentStatus;
  toStatus: BookAppointmentStatus;
  scheduledAt?: Date | undefined;
  timezone?: string | undefined;
  cancelledReason?: string | undefined;
}) => Promise<{ transitioned: boolean }>;
type ApplyDndOptOutFn = (params: {
  phoneE164: string;
  phoneMatchKey: string;
  dedupeKey: string;
  evidence: string;
}) => Promise<{ eventInserted: boolean; changed: boolean }>;
type EmailCorrelationStatus =
  | "matched"
  | "missing_contact_correlation"
  | "correlated_email_mismatch";
type ApplyEmailUnsubscribeFn = (params: {
  email: string;
  ghlContactId: string;
  dedupeKey: string;
  evidence: string;
}) => Promise<{
  suppressionInserted: boolean;
  contactStatusChanged: boolean;
  correlationStatus: EmailCorrelationStatus;
}>;

let _locationResolver: LocationResolver = defaultLocationResolver;
let _appointmentByGhlId: AppointmentByGhlIdFn = defaultAppointmentByGhlId;
let _contactByGhlId: ContactByGhlIdFn = defaultContactByGhlId;
let _resolveApplication: ResolveApplicationFn = defaultResolveApplication;
let _upsertAppointment: UpsertAppointmentFn = defaultUpsertAppointment;
let _writeAppointmentCorrelation: WriteAppointmentCorrelationFn = defaultWriteAppointmentCorrelation;
let _rescheduleAppointment: RescheduleAppointmentFn = defaultRescheduleAppointment;
let _transitionAppointment: TransitionAppointmentFn = defaultTransitionAppointment;
let _applyDndOptOut: ApplyDndOptOutFn = defaultApplyDndOptOut;
let _applyEmailUnsubscribe: ApplyEmailUnsubscribeFn = defaultApplyEmailUnsubscribe;

/** Install test seams. Pass null to restore production defaults. */
export function __test_setGhlWebhookDeps(overrides: {
  locationResolver?: LocationResolver | null;
  appointmentByGhlId?: AppointmentByGhlIdFn | null;
  contactByGhlId?: ContactByGhlIdFn | null;
  resolveApplication?: ResolveApplicationFn | null;
  upsertAppointment?: UpsertAppointmentFn | null;
  writeAppointmentCorrelation?: WriteAppointmentCorrelationFn | null;
  rescheduleAppointment?: RescheduleAppointmentFn | null;
  transitionAppointment?: TransitionAppointmentFn | null;
  applyDndOptOut?: ApplyDndOptOutFn | null;
  applyEmailUnsubscribe?: ApplyEmailUnsubscribeFn | null;
}): void {
  if ("locationResolver" in overrides)
    _locationResolver = overrides.locationResolver ?? defaultLocationResolver;
  if ("appointmentByGhlId" in overrides)
    _appointmentByGhlId = overrides.appointmentByGhlId ?? defaultAppointmentByGhlId;
  if ("contactByGhlId" in overrides)
    _contactByGhlId = overrides.contactByGhlId ?? defaultContactByGhlId;
  if ("resolveApplication" in overrides)
    _resolveApplication = overrides.resolveApplication ?? defaultResolveApplication;
  if ("upsertAppointment" in overrides)
    _upsertAppointment = overrides.upsertAppointment ?? defaultUpsertAppointment;
  if ("writeAppointmentCorrelation" in overrides)
    _writeAppointmentCorrelation = overrides.writeAppointmentCorrelation ?? defaultWriteAppointmentCorrelation;
  if ("rescheduleAppointment" in overrides)
    _rescheduleAppointment = overrides.rescheduleAppointment ?? defaultRescheduleAppointment;
  if ("transitionAppointment" in overrides)
    _transitionAppointment = overrides.transitionAppointment ?? defaultTransitionAppointment;
  if ("applyDndOptOut" in overrides)
    _applyDndOptOut = overrides.applyDndOptOut ?? defaultApplyDndOptOut;
  if ("applyEmailUnsubscribe" in overrides)
    _applyEmailUnsubscribe =
      overrides.applyEmailUnsubscribe ?? defaultApplyEmailUnsubscribe;
}

// ── Production default implementations ───────────────────────────────────────

async function defaultLocationResolver(): Promise<string | null> {
  try {
    const setting = await storage.getSystemSetting(GHL_LOCATION_ID_SETTING_KEY);
    const val = setting?.value?.trim() ?? "";
    return val.length > 0 ? val : null;
  } catch {
    return null;
  }
}

async function defaultAppointmentByGhlId(
  ghlAppointmentId: string,
): Promise<{
  id: string;
  status: string;
  contactId: string | null;
  scheduledAt: Date | null;
  timezone: string | null;
} | null> {
  return withDbAttribution("book-commerce:ghl-webhook-appt-lookup", async () => {
    const db = getDb();
    const [row] = await db
      .select({
        id: bookAppointments.id,
        status: bookAppointments.status,
        contactId: bookAppointments.contactId,
        scheduledAt: bookAppointments.scheduledAt,
        timezone: bookAppointments.timezone,
      })
      .from(bookProviderCorrelations)
      .innerJoin(
        bookAppointments,
        and(
          eq(bookAppointments.id, bookProviderCorrelations.localEntityId),
          eq(bookProviderCorrelations.localEntityType, LOCAL_APPOINTMENT_ENTITY_TYPE),
        ),
      )
      .where(
        and(
          eq(bookProviderCorrelations.provider, GHL_PROVIDER),
          eq(bookProviderCorrelations.providerEntityType, GHL_APPOINTMENT_ENTITY_TYPE),
          eq(bookProviderCorrelations.providerEntityId, ghlAppointmentId),
        ),
      )
      .limit(1);
    return row ?? null;
  });
}

async function defaultContactByGhlId(
  ghlContactId: string,
): Promise<{ id: string } | null> {
  return withDbAttribution("book-commerce:ghl-webhook-contact-lookup", async () => {
    const db = getDb();
    const [row] = await db
      .select({ id: bookProviderCorrelations.localEntityId })
      .from(bookProviderCorrelations)
      .where(
        and(
          eq(bookProviderCorrelations.provider, GHL_PROVIDER),
          eq(bookProviderCorrelations.providerEntityType, GHL_CONTACT_ENTITY_TYPE),
          eq(bookProviderCorrelations.providerEntityId, ghlContactId),
        ),
      )
      .limit(1);
    return row ? { id: row.id } : null;
  });
}

async function defaultResolveApplication(params: {
  contactId: string;
  deterministicIdempotencyKey: string;
}): Promise<{ id: string; status: string } | null> {
  const app = await resolveBookAuditApplicationForBootstrap(params);
  return app ? { id: app.id, status: app.status } : null;
}

async function defaultUpsertAppointment(params: {
  auditApplicationId: string;
  scheduledAt?: Date | undefined;
  timezone?: string | undefined;
}): Promise<{ id: string; status: string }> {
  const result = await upsertBookAppointment({
    auditApplicationId: params.auditApplicationId,
    scheduledAt: params.scheduledAt,
    timezone: params.timezone,
  });
  return { id: result.appointment.id, status: result.appointment.status };
}

async function defaultWriteAppointmentCorrelation(params: {
  ghlAppointmentId: string;
  localAppointmentId: string;
}): Promise<void> {
  await insertBookProviderCorrelation({
    provider: GHL_PROVIDER,
    providerEntityType: GHL_APPOINTMENT_ENTITY_TYPE,
    providerEntityId: params.ghlAppointmentId,
    localEntityType: LOCAL_APPOINTMENT_ENTITY_TYPE,
    localEntityId: params.localAppointmentId,
  });
}

async function defaultRescheduleAppointment(params: {
  appointmentId: string;
  scheduledAt?: Date | undefined;
  timezone?: string | undefined;
}): Promise<{ updated: boolean }> {
  const result = await updateBookAppointmentSchedule({
    appointmentId: params.appointmentId,
    scheduledAt: params.scheduledAt,
    timezone: params.timezone ?? null,
  });
  return { updated: result.updated };
}

async function defaultTransitionAppointment(params: {
  appointmentId: string;
  fromStatus: BookAppointmentStatus;
  toStatus: BookAppointmentStatus;
  scheduledAt?: Date | undefined;
  timezone?: string | undefined;
  cancelledReason?: string | undefined;
}): Promise<{ transitioned: boolean }> {
  return transitionBookAppointment({
    appointmentId: params.appointmentId,
    fromStatus: params.fromStatus,
    toStatus: params.toStatus,
    actorUserId: null,
    scheduledAt: params.scheduledAt,
    timezone: params.timezone ?? null,
    cancelledReason: params.cancelledReason,
  });
}

async function defaultApplyDndOptOut(params: {
  phoneE164: string;
  phoneMatchKey: string;
  dedupeKey: string;
  evidence: string;
}): Promise<{ eventInserted: boolean; changed: boolean }> {
  const result = await applyDedupedConsentStateChange({
    phoneE164: params.phoneE164,
    phoneMatchKey: params.phoneMatchKey,
    newState: "opted_out",
    source: "ghl_dnd",
    evidence: params.evidence,
    event: {
      eventType: "opt_out",
      // Required dedupe key — the sms_consent_events partial unique index on
      // message_sid makes GHL redeliveries a true atomic no-op.
      messageSid: params.dedupeKey,
      detail: params.evidence,
    },
  });

  // Feed the opt-out-storm watcher ONLY when this delivery actually changed
  // state (fresh event AND state moved). Replays and no-ops never trigger it.
  if (result.eventInserted && result.changed) {
    recordSmsOptOutAndEvaluate(params.phoneE164).catch((err: any) => {
      console.warn(
        `[ghl-marketplace-webhook] opt-out storm evaluation failed: ${err?.message}`,
      );
    });
  }

  return { eventInserted: result.eventInserted, changed: result.changed };
}

async function defaultApplyEmailUnsubscribe(params: {
  email: string;
  ghlContactId: string;
  dedupeKey: string;
  evidence: string;
}): Promise<{
  suppressionInserted: boolean;
  contactStatusChanged: boolean;
  correlationStatus: EmailCorrelationStatus;
}> {
  const email = normalizeEmailAddress(params.email);

  const correlatedContact = await withDbAttribution(
    "book-commerce:ghl-webhook-email-correlation",
    async () => {
      const db = getDb();
      const [row] = await db
        .select({
          id: bookContacts.id,
          email: bookContacts.email,
        })
        .from(bookProviderCorrelations)
        .innerJoin(
          bookContacts,
          and(
            eq(bookContacts.id, bookProviderCorrelations.localEntityId),
            eq(bookProviderCorrelations.localEntityType, "contact"),
          ),
        )
        .where(
          and(
            eq(bookProviderCorrelations.provider, GHL_PROVIDER),
            eq(bookProviderCorrelations.providerEntityType, GHL_CONTACT_ENTITY_TYPE),
            eq(bookProviderCorrelations.providerEntityId, params.ghlContactId),
          ),
        )
        .limit(1);
      return row ?? null;
    },
  );

  const correlationStatus: EmailCorrelationStatus =
    correlatedContact === null
      ? "missing_contact_correlation"
      : normalizeEmailAddress(correlatedContact.email) === email
        ? "matched"
        : "correlated_email_mismatch";

  const notes =
    `${params.evidence}; dedupeKey=${params.dedupeKey}; ` +
    `correlation=${correlationStatus}`;

  // Canonical NoBull suppression is the primary safety write. If a later
  // contact-status update fails, GHL's retry reconfirms this unique-email row
  // and completes the secondary snapshot update without duplicate suppression.
  const suppression = await addEmailSuppressionWithSideEffects({
    email,
    reason: "unsubscribe",
    source: "ghl_event",
    notes,
    cancelNote: "GHL email unsubscribe",
    // The suppression row is already durable if cancellation fails. Returning
    // 500 makes GHL retry until active promotional enrollment is also cancelled.
    requireSequenceCancellation: true,
  });

  // Tighten by normalized email, never by an inconsistent correlation. This
  // updates an existing local contact only; a signed vendor event cannot create
  // a NoBull contact or relax an unsubscribed status.
  const contactStatusChanged = await withDbAttribution(
    "book-commerce:ghl-webhook-email-tighten",
    async () => {
      const updated = await getDb()
        .update(bookContacts)
        .set({
          emailMarketingStatus: "unsubscribed",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(bookContacts.email, email),
            inArray(
              bookContacts.emailMarketingStatus,
              [...bookEmailMarketingTightenableStates],
            ),
          ),
        )
        .returning({ id: bookContacts.id });
      return updated.length > 0;
    },
  );

  return {
    suppressionInserted: suppression.inserted,
    contactStatusChanged,
    correlationStatus,
  };
}

// ── Route registration ────────────────────────────────────────────────────────

export function registerGhlMarketplaceWebhookRoutes(app: Express): void {
  app.post(
    "/api/integrations/ghl/marketplace-webhook",
    async (req: any, res) => {
      try {
        // ── 1. Fail closed: public key must be configured ────────────────
        if (!isGhlWebhookConfigured()) {
          console.error(
            "[ghl-marketplace-webhook] GHL_MARKETPLACE_PUBLIC_KEY not configured — rejecting (fail closed).",
          );
          return res
            .status(503)
            .json({ error: "GHL webhook public key not configured" });
        }

        // ── 2. Fail closed: configured location ID must be resolvable ────
        const configuredLocationId = await _locationResolver();
        if (configuredLocationId === null) {
          console.error(
            "[ghl-marketplace-webhook] GHL location ID not configured or unreadable — rejecting (fail closed).",
          );
          return res
            .status(503)
            .json({ error: "GHL location ID not configured" });
        }

        // ── 3. Ed25519 signature verification (raw body) ─────────────────
        const sigHeader = req.headers["x-ghl-signature"] as string | undefined;
        const rawBody: Buffer | string | undefined = req.rawBody as
          | Buffer
          | string
          | undefined;

        if (!rawBody) {
          return res.status(400).json({ error: "Raw body unavailable" });
        }

        if (!verifyGhlSignature(rawBody, sigHeader)) {
          return res.status(401).json({ error: "Invalid signature" });
        }

        // ── 4. Parse and validate event ──────────────────────────────────
        const parsed = parseGhlWebhookEvent(req.body, configuredLocationId);

        if (parsed === null) {
          return res.status(400).json({ error: "Invalid or missing event payload" });
        }

        if (parsed.kind === "wrong_location") {
          return res.status(403).json({ error: "Location ID mismatch" });
        }

        if (parsed.kind === "ignored") {
          return res.json({ ok: true, status: "ignored", eventType: parsed.eventType });
        }

        // ── 5. Email unsubscribe (strict channel contract, tighten-only) ──
        if (parsed.kind === "email_unsubscribe") {
          const dedupeKey = deriveGhlDedupeKey(parsed.ghlEventId, rawBody);
          const evidence =
            `GHL ${parsed.eventType} (${parsed.reason}; ` +
            `contactId=${parsed.contactId})`;
          const result = await _applyEmailUnsubscribe({
            email: parsed.email,
            ghlContactId: parsed.contactId,
            dedupeKey,
            evidence,
          });

          let smsStatus: string | null = null;
          if (parsed.smsOptOut) {
            const phoneE164 = parsed.phone ? normalizeToE164(parsed.phone) : null;
            const phoneMatchKey = parsed.phone
              ? getPhoneMatchKey(parsed.phone)
              : null;
            if (phoneE164 && phoneMatchKey !== null) {
              const smsResult = await _applyDndOptOut({
                phoneE164,
                phoneMatchKey,
                dedupeKey: `${dedupeKey}:sms`,
                evidence:
                  `GHL ${parsed.eventType} (contact_dnd_enabled; ` +
                  `contactId=${parsed.contactId})`,
              });
              smsStatus = smsResult.eventInserted
                ? "dnd_applied"
                : "dnd_replay_noop";
            } else {
              smsStatus = "dnd_unnormalisable_phone";
            }
          }

          return res.json({
            ok: true,
            status: result.suppressionInserted
              ? "email_unsubscribe_applied"
              : "email_unsubscribe_reconfirmed",
            email: parsed.email,
            contactStatusChanged: result.contactStatusChanged,
            correlationStatus: result.correlationStatus,
            discrepancy:
              result.correlationStatus === "matched"
                ? null
                : result.correlationStatus,
            smsStatus,
          });
        }

        // ── 6. DND / opt-out events (tighten-only, atomic dedupe) ────────
        if (parsed.kind === "dnd") {
          const phone = parsed.phone;
          if (!phone) {
            console.warn(
              `[ghl-marketplace-webhook] DND event (${parsed.eventType}) missing phone — skipped`,
            );
            return res.json({ ok: true, status: "dnd_no_phone" });
          }

          const phoneE164 = normalizeToE164(phone);
          const phoneMatchKey = getPhoneMatchKey(phone);

          if (!phoneE164 || phoneMatchKey === null) {
            console.warn(
              `[ghl-marketplace-webhook] DND event (${parsed.eventType}) — phone unnormalisable`,
            );
            return res.json({ ok: true, status: "dnd_unnormalisable_phone" });
          }

          // Dedupe key: prefix GHL event IDs with "ghl:"; when the payload
          // carried no ID, derive a deterministic sha256(rawBody) so every
          // delivery still has a stable idempotency key.
          const dedupeKey = deriveGhlDedupeKey(parsed.ghlEventId, rawBody);

          const evidence = `GHL ${parsed.eventType} (${parsed.reason}; contactId=${parsed.contactId ?? "unknown"})`;

          const { eventInserted, changed } = await _applyDndOptOut({
            phoneE164,
            phoneMatchKey,
            dedupeKey,
            evidence,
          });

          return res.json({
            ok: true,
            status: eventInserted ? "dnd_applied" : "dnd_replay_noop",
            phone: phoneE164,
            changed,
          });
        }

        // ── 7. Appointment events (single shared bootstrap path) ─────────
        // parsed.kind === "appointment"
        const {
          eventType,
          appointmentId: ghlApptId,
          contactId: ghlContactId,
          noBullStatus,
          ghlStatus,
          startTime,
          timezone,
        } = parsed;

        // Unknown / unmapped GHL status — safe no-op.
        if (noBullStatus === null) {
          return res.json({
            ok: true,
            status: "ignored",
            eventType,
            reason: "unmapped_ghl_status",
            ghlStatus,
          });
        }

        const scheduledAt = startTime ? new Date(startTime) : undefined;
        const tz = timezone ?? undefined;

        // ── 6a. Existing appointment correlation → update in place ───────
        const localAppt = await _appointmentByGhlId(ghlApptId);

        if (localAppt) {
          const fromStatus = localAppt.status as BookAppointmentStatus;

          // Same mapped status: this is a reschedule OR a no-op, never a
          // status transition.
          if (fromStatus === noBullStatus) {
            const scheduleChanged = isScheduleChanged(
              localAppt.scheduledAt,
              localAppt.timezone,
              scheduledAt,
              tz,
            );
            if (scheduleChanged) {
              const { updated } = await _rescheduleAppointment({
                appointmentId: localAppt.id,
                scheduledAt,
                timezone: tz,
              });
              return res.json({
                ok: true,
                status: updated ? "rescheduled" : "already_in_target_state",
                appointmentId: localAppt.id,
                currentStatus: fromStatus,
              });
            }
            return res.json({
              ok: true,
              status: "already_in_target_state",
              appointmentId: localAppt.id,
              currentStatus: fromStatus,
            });
          }

          // Different status → legal transition.
          return await applyAppointmentTransition(res, {
            appointmentId: localAppt.id,
            fromStatus,
            noBullStatus,
            eventType,
            scheduledAt,
            timezone: tz,
            ghlStatus,
          });
        }

        // ── 6b. No correlation → shared bootstrap (Create AND Update) ────
        // An AppointmentUpdate with no correlation is NOT silently acked; it is
        // bootstrapped exactly like a Create when a contact correlation exists,
        // else it is a retryable 500 for operator reconciliation.
        return await bootstrapAppointmentFromGhl(res, {
          ghlApptId,
          ghlContactId,
          noBullStatus,
          eventType,
          scheduledAt,
          timezone: tz,
          ghlStatus,
        });
      } catch (err: any) {
        console.error("[ghl-marketplace-webhook] Unhandled error:", err?.message ?? err);
        return res.status(500).json({ error: "Internal error processing GHL webhook" });
      }
    },
  );
}

// ── Dedupe-key derivation ─────────────────────────────────────────────────────

/**
 * Derive a stable DND dedupe key. Prefer the GHL-supplied event ID (prefixed
 * `ghl:`); when absent, hash the exact raw body so a redelivery of the same
 * payload still collapses to one consent event via the message_sid unique index.
 */
function deriveGhlDedupeKey(
  ghlEventId: string | null,
  rawBody: Buffer | string,
): string {
  if (ghlEventId && ghlEventId.trim().length > 0) {
    return `ghl:${ghlEventId.trim()}`;
  }
  const bytes = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody);
  const hash = crypto.createHash("sha256").update(bytes).digest("hex");
  return `ghl:sha256:${hash}`;
}

// ── Schedule-change detection ─────────────────────────────────────────────────

function isScheduleChanged(
  currentScheduledAt: Date | null,
  currentTimezone: string | null,
  nextScheduledAt: Date | undefined,
  nextTimezone: string | undefined,
): boolean {
  // Only compare a field the event actually carried; a missing field is not a
  // change (GHL may omit unchanged fields).
  const startChanged =
    nextScheduledAt !== undefined &&
    (currentScheduledAt?.getTime() ?? null) !== nextScheduledAt.getTime();
  const tzChanged =
    nextTimezone !== undefined && (currentTimezone ?? null) !== nextTimezone;
  return startChanged || tzChanged;
}

// ── Shared bootstrap helper (Create AND correlation-less Update) ──────────────

async function bootstrapAppointmentFromGhl(
  res: any,
  opts: {
    ghlApptId: string;
    ghlContactId: string | null;
    noBullStatus: BookAppointmentStatus;
    eventType: string;
    scheduledAt: Date | undefined;
    timezone: string | undefined;
    ghlStatus: string | null;
  },
): Promise<any> {
  const { ghlApptId, ghlContactId, noBullStatus, eventType, scheduledAt, timezone, ghlStatus } = opts;

  if (!ghlContactId) {
    console.error(
      `[ghl-marketplace-webhook] ${eventType} for GHL appt ${ghlApptId} missing contactId — retryable`,
    );
    return res.status(500).json({
      error: `${eventType} missing contactId — cannot bootstrap local appointment`,
      retryable: true,
    });
  }

  const localContact = await _contactByGhlId(ghlContactId);
  if (!localContact) {
    console.error(
      `[ghl-marketplace-webhook] ${eventType}: no book contact correlation for GHL contact ${ghlContactId} — needs reconciliation`,
    );
    return res.status(500).json({
      error: "No local contact correlation for GHL contact — needs reconciliation",
      retryable: true,
    });
  }

  // RESOLVE an existing application — NEVER fabricate one for a signed event.
  const appIdempotencyKey = `ghl-appt:${ghlApptId}`;
  const application = await _resolveApplication({
    contactId: localContact.id,
    deterministicIdempotencyKey: appIdempotencyKey,
  });
  if (!application) {
    console.error(
      `[ghl-marketplace-webhook] ${eventType}: no resolvable audit application for contact ${localContact.id} (GHL appt ${ghlApptId}) — needs reconciliation`,
    );
    return res.status(500).json({
      error: "No resolvable audit application for contact — needs reconciliation",
      retryable: true,
    });
  }

  // Upsert the appointment row on the resolved application (carries schedule).
  const newAppt = await _upsertAppointment({
    auditApplicationId: application.id,
    scheduledAt,
    timezone,
  });

  // Write the appointment correlation (idempotent ON CONFLICT DO NOTHING).
  await _writeAppointmentCorrelation({
    ghlAppointmentId: ghlApptId,
    localAppointmentId: newAppt.id,
  });

  // Transition into the mapped status if not already there.
  if (newAppt.status !== noBullStatus) {
    return await applyAppointmentTransition(res, {
      appointmentId: newAppt.id,
      fromStatus: newAppt.status as BookAppointmentStatus,
      noBullStatus,
      eventType,
      scheduledAt,
      timezone,
      ghlStatus,
    });
  }

  return res.json({
    ok: true,
    status: "created_and_correlated",
    appointmentId: newAppt.id,
    toStatus: newAppt.status,
  });
}

// ── Shared transition helper ──────────────────────────────────────────────────

async function applyAppointmentTransition(
  res: any,
  opts: {
    appointmentId: string;
    fromStatus: BookAppointmentStatus;
    noBullStatus: BookAppointmentStatus;
    eventType: string;
    scheduledAt: Date | undefined;
    timezone: string | undefined;
    ghlStatus: string | null;
  },
): Promise<any> {
  const { appointmentId, fromStatus, noBullStatus, eventType, scheduledAt, timezone, ghlStatus } = opts;

  try {
    const result = await _transitionAppointment({
      appointmentId,
      fromStatus,
      toStatus: noBullStatus,
      scheduledAt,
      timezone,
      cancelledReason:
        noBullStatus === "cancelled"
          ? `GHL ${eventType} (ghlStatus=${ghlStatus})`
          : undefined,
    });

    if (!result.transitioned) {
      // CAS miss — concurrent transition won. Current state is final.
      return res.json({
        ok: true,
        status: "concurrent_transition_lost",
        appointmentId,
      });
    }

    return res.json({
      ok: true,
      status: "transitioned",
      appointmentId,
      fromStatus,
      toStatus: noBullStatus,
    });
  } catch (err: any) {
    if (err?.name === "IllegalTransitionError") {
      return res.json({
        ok: true,
        status: "illegal_transition_ignored",
        reason: err.message,
      });
    }
    throw err; // re-throw for the outer handler to return 500
  }
}
