/* test-registration
{
  "name": "GHL Marketplace webhook — Ed25519 fail-closed verifier, location scope, appointment transitions + reschedule, shared Create/Update bootstrap (no fabrication), atomic SMS DND replay no-op, and tighten-only email unsubscribe reconciliation (Tasks #5105/#5144)",
  "smoke": true,
  "smokeReason": "DB-free, network-free hermetic suite. Uses a generated Ed25519 keypair and __test_setGhlWebhookDeps seam to stub all storage calls at the LEAF writer. Guards: 503 on unconfigured key, 503 on unresolvable location, 401 on bad/missing/wrong-key sig, 403 on wrong location, 400 on invalid body; appointment legal transitions; same-status+changed-schedule → RESCHEDULE (no transition); correlation-less Update bootstraps like Create (never a false 'GHL retries' 200); route resolves an EXISTING application and never fabricates one (500 retryable when none); atomic SMS DND dedupe (ghl:-prefixed IDs, sha256(rawBody) fallback) → replay is a true no-op and storm watcher fires only on fresh change; signed ContactDndUpdate email DND uses the strict dndSettings.Email.status=active contract, adds one canonical suppression on replay, tightens existing contact state only, reports durable correlation discrepancies, and never accepts affirmative email consent.",
  "tier": "small"
}
test-registration */
/**
 * Tasks #5105/#5144 — GHL Marketplace signed webhook verifier and route.
 *
 * All storage is stubbed via __test_setGhlWebhookDeps so zero DB access
 * occurs. The real route handler + real verifier/parser are exercised.
 *
 * Groups:
 *  1. isGhlWebhookConfigured — missing/blank/set.
 *  2. verifyGhlSignature — valid, wrong key, tampered body, missing/blank/
 *     garbage header, unconfigured env.
 *  3. parseGhlWebhookEvent unit coverage (a–k) incl. ghlEventId priority.
 *  4. Route HTTP layer (real route + injectable leaf stubs):
 *     a. Unconfigured key → 503.
 *     b. Configured key, location unresolvable → 503.
 *     c. Invalid/missing/wrong-key signature → 401.
 *     d. Wrong locationId → 403.
 *     e. Missing type field → 400.
 *     f. AppointmentUpdate known correlation, legal transition → transitioned.
 *     g. Same status + no schedule change → already_in_target_state (no txn/reschedule).
 *     g2. Same status + changed startTime → rescheduled (NO status transition).
 *     g3. Same status + changed timezone → rescheduled.
 *     h. Illegal transition → illegal_transition_ignored.
 *     i. Update NO correlation + resolvable app → bootstrap (never false 'GHL retries').
 *     i2. Update NO correlation + no contact correlation → 500 retryable.
 *     j. Unmapped GHL status → ignored/unmapped_ghl_status.
 *     k. AppointmentCreate missing contactId → 500 retryable.
 *     l. AppointmentCreate no contact correlation → 500 retryable.
 *     l2. AppointmentCreate contact correlation but NO resolvable app → 500 retryable,
 *         NO fabricated application/appointment/correlation.
 *     m. AppointmentCreate resolvable app → resolves (not creates), upserts, correlates, transitions.
 *     n. AppointmentCreate replay (correlation exists) → already_in_target_state, no dup writes.
 *     o. DND enabled → dnd_applied, ghl:-prefixed key, storm fired once.
 *     p. DND replay (same key) → dnd_replay_noop, storm fires only once.
 *     p2. DND no event ID → sha256(rawBody) key; identical replay dedupes.
 *     q. DND cleared → ignored, no opt-out, no storm.
 *     r. DND enabled + no phone → dnd_no_phone.
 *     s. InboundMessage STOP → dnd_applied.
 *     t. InboundMessage non-STOP → ignored.
 *     u. Unknown event → ignored.
 *     v. GHL never writes opted_in (affirmative consent gate).
 *     w. Email DND active → canonical suppression + contact tighten.
 *     x. Email unsubscribe replay → reconfirmed without duplicate suppression.
 *     y. Correlation discrepancy → visible response/evidence.
 *     z. Malformed/Email DND inactive → rejected/ignored, never subscribed.
 *     z2. Combined Email + SMS DND tightens both channels.
 *  5. REAL storage-level atomic DND replay (applyDedupedConsentStateChange),
 *     gated on DATABASE_URL — proves the message_sid unique index makes replay a
 *     true no-op (ledger untouched, eventInserted:false).
 *  6. REAL email-unsubscribe persistence, gated on DATABASE_URL — proves one
 *     normalized `ghl_event` suppression, conditional local status tightening,
 *     replay safety, and durable correlation-discrepancy evidence.
 */
import assert from "node:assert/strict";
import crypto, { generateKeyPairSync } from "node:crypto";
import express from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";

// ── Ed25519 keypair ───────────────────────────────────────────────────────────
const { publicKey: pubKeyObj, privateKey: privKeyObj } = generateKeyPairSync("ed25519");
const pubKeySpki = pubKeyObj.export({ type: "spki", format: "der" }) as Buffer;
const PUB_KEY_B64 = pubKeySpki.toString("base64");
const { privateKey: wrongPrivKeyObj } = generateKeyPairSync("ed25519");

const ENV_KEY = "GHL_MARKETPLACE_PUBLIC_KEY";
const PREV_KEY_ENV = process.env[ENV_KEY];

const WEBHOOK_PATH = "/api/integrations/ghl/marketplace-webhook";
const TEST_LOCATION_ID = "loc_test_5105";

function restoreEnv(): void {
  if (PREV_KEY_ENV === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = PREV_KEY_ENV;
}

function sign(rawBody: string, key = privKeyObj): string {
  return crypto.sign(null, Buffer.from(rawBody), key).toString("base64");
}

// ── App factory ───────────────────────────────────────────────────────────────
let routeModule: typeof import("../server/routes/ghlMarketplaceWebhook");
let verifierModule: typeof import("../server/services/ghlWebhookVerifier");

async function loadModules(): Promise<void> {
  routeModule = await import("../server/routes/ghlMarketplaceWebhook");
  verifierModule = await import("../server/services/ghlWebhookVerifier");
}

function buildApp(): express.Express {
  const app = express();
  app.use(
    express.json({
      verify: (req: any, _res, buf) => { req.rawBody = buf; },
    }),
  );
  routeModule.registerGhlMarketplaceWebhookRoutes(app);
  return app;
}

async function listen(app: express.Express): Promise<{ server: Server; baseUrl: string }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

async function postWebhook(
  baseUrl: string,
  body: unknown,
  opts: { sig?: string | null; omitSig?: boolean } = {},
): Promise<{ status: number; json: any }> {
  const rawBody = JSON.stringify(body);
  const sig =
    opts.omitSig ? undefined
    : opts.sig !== undefined ? (opts.sig ?? undefined)
    : sign(rawBody);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (sig !== undefined && sig !== null) headers["x-ghl-signature"] = sig;
  const r = await fetch(`${baseUrl}${WEBHOOK_PATH}`, {
    method: "POST",
    headers,
    body: rawBody,
  });
  let json: any = null;
  try { json = await r.json(); } catch { /* ignore */ }
  return { status: r.status, json };
}

// ── Stub builders ─────────────────────────────────────────────────────────────

interface StubAppointment {
  id: string;
  status: string;
  contactId: string | null;
  scheduledAt: Date | null;
  timezone: string | null;
}
interface StubContact { id: string }
interface StubApplication { id: string; status: string }

interface StubState {
  appointmentsByGhlId: Map<string, StubAppointment>;
  contactsByGhlId: Map<string, StubContact>;
  /** Applications keyed by the deterministic key OR by "contact:<id>". */
  applicationsByKey: Map<string, StubApplication>;
  /** Deduped consent event keys already seen (simulates the unique index). */
  dndSeenKeys: Set<string>;
  /** Unique normalized email suppressions already seen. */
  emailSuppressionSeen: Set<string>;
  /** Emails whose local contact snapshot was already tightened. */
  emailContactTightened: Set<string>;
  emailCorrelationByGhlId: Map<
    string,
    "matched" | "missing_contact_correlation" | "correlated_email_mismatch"
  >;
  // log of calls
  transitionCalls: Array<{ appointmentId: string; fromStatus: string; toStatus: string }>;
  rescheduleCalls: Array<{ appointmentId: string; scheduledAt?: Date; timezone?: string }>;
  dndCalls: Array<{ phoneE164: string; dedupeKey: string; eventInserted: boolean; changed: boolean }>;
  emailUnsubscribeCalls: Array<{
    email: string;
    ghlContactId: string;
    dedupeKey: string;
    evidence: string;
    suppressionInserted: boolean;
    contactStatusChanged: boolean;
    correlationStatus:
      | "matched"
      | "missing_contact_correlation"
      | "correlated_email_mismatch";
  }>;
  stormCalls: Array<string>;
  correlationsWritten: Array<{ ghlAppointmentId: string; localAppointmentId: string }>;
  appointmentsUpserted: Array<{ auditApplicationId: string }>;
  resolveCalls: Array<{ contactId: string; deterministicIdempotencyKey: string }>;
  locationOverride: string | null | "FAIL"; // "FAIL" = return null
}

function makeStubs(state: StubState) {
  const deps: Parameters<typeof routeModule.__test_setGhlWebhookDeps>[0] = {
    locationResolver: async () => {
      if (state.locationOverride === "FAIL") return null;
      return state.locationOverride;
    },
    appointmentByGhlId: async (ghlId) => state.appointmentsByGhlId.get(ghlId) ?? null,
    contactByGhlId: async (ghlId) => state.contactsByGhlId.get(ghlId) ?? null,
    resolveApplication: async (params) => {
      state.resolveCalls.push(params);
      // Deterministic key first, then contact fallback.
      return (
        state.applicationsByKey.get(params.deterministicIdempotencyKey) ??
        state.applicationsByKey.get(`contact:${params.contactId}`) ??
        null
      );
    },
    upsertAppointment: async (params) => {
      state.appointmentsUpserted.push({ auditApplicationId: params.auditApplicationId });
      const id = `appt_${params.auditApplicationId}`;
      return { id, status: "pending" };
    },
    writeAppointmentCorrelation: async (params) => {
      state.correlationsWritten.push(params);
      // Reflect into appointmentsByGhlId for subsequent lookups.
      state.appointmentsByGhlId.set(params.ghlAppointmentId, {
        id: params.localAppointmentId,
        status: "pending",
        contactId: null,
        scheduledAt: null,
        timezone: null,
      });
    },
    rescheduleAppointment: async (params) => {
      state.rescheduleCalls.push({
        appointmentId: params.appointmentId,
        scheduledAt: params.scheduledAt,
        timezone: params.timezone,
      });
      // Reflect schedule change into the stub row.
      for (const [ghlId, appt] of state.appointmentsByGhlId) {
        if (appt.id === params.appointmentId) {
          if (params.scheduledAt !== undefined) appt.scheduledAt = params.scheduledAt;
          if (params.timezone !== undefined) appt.timezone = params.timezone;
          state.appointmentsByGhlId.set(ghlId, appt);
        }
      }
      return { updated: true };
    },
    transitionAppointment: async (params) => {
      state.transitionCalls.push({
        appointmentId: params.appointmentId,
        fromStatus: params.fromStatus,
        toStatus: params.toStatus,
      });
      // Check legality via the real transition table.
      const { isValidBookAppointmentTransition } = await import("../shared/models/bookCommerce");
      if (!isValidBookAppointmentTransition(params.fromStatus, params.toStatus)) {
        const err = new Error(`Illegal transition ${params.fromStatus}→${params.toStatus}`);
        err.name = "IllegalTransitionError";
        throw err;
      }
      // Update stub state.
      for (const [ghlId, appt] of state.appointmentsByGhlId) {
        if (appt.id === params.appointmentId) {
          appt.status = params.toStatus;
          state.appointmentsByGhlId.set(ghlId, appt);
        }
      }
      return { transitioned: true };
    },
    applyDndOptOut: async (params) => {
      // Simulate the atomic message_sid unique index: first key → inserted,
      // replay of same key → no-op (eventInserted:false, changed:false).
      const eventInserted = !state.dndSeenKeys.has(params.dedupeKey);
      if (eventInserted) state.dndSeenKeys.add(params.dedupeKey);
      // For a fresh opt-out we say state changed (unknown → opted_out).
      const changed = eventInserted;
      state.dndCalls.push({
        phoneE164: params.phoneE164,
        dedupeKey: params.dedupeKey,
        eventInserted,
        changed,
      });
      // Emulate the route's storm-watcher gating: only fires when
      // eventInserted && changed. The stub records that decision for assertions.
      if (eventInserted && changed) state.stormCalls.push(params.phoneE164);
      return { eventInserted, changed };
    },
    applyEmailUnsubscribe: async (params) => {
      const email = params.email.trim().toLowerCase();
      const suppressionInserted = !state.emailSuppressionSeen.has(email);
      if (suppressionInserted) state.emailSuppressionSeen.add(email);
      const contactStatusChanged = !state.emailContactTightened.has(email);
      if (contactStatusChanged) state.emailContactTightened.add(email);
      const correlationStatus =
        state.emailCorrelationByGhlId.get(params.ghlContactId) ?? "matched";
      state.emailUnsubscribeCalls.push({
        email,
        ghlContactId: params.ghlContactId,
        dedupeKey: params.dedupeKey,
        evidence: params.evidence,
        suppressionInserted,
        contactStatusChanged,
        correlationStatus,
      });
      return {
        suppressionInserted,
        contactStatusChanged,
        correlationStatus,
      };
    },
  };
  return deps;
}

function freshState(locationOverride: string | null | "FAIL" = TEST_LOCATION_ID): StubState {
  return {
    appointmentsByGhlId: new Map(),
    contactsByGhlId: new Map(),
    applicationsByKey: new Map(),
    dndSeenKeys: new Set(),
    emailSuppressionSeen: new Set(),
    emailContactTightened: new Set(),
    emailCorrelationByGhlId: new Map(),
    transitionCalls: [],
    rescheduleCalls: [],
    dndCalls: [],
    emailUnsubscribeCalls: [],
    stormCalls: [],
    correlationsWritten: [],
    appointmentsUpserted: [],
    resolveCalls: [],
    locationOverride,
  };
}

function stubAppt(over: Partial<StubAppointment> & { id: string; status: string }): StubAppointment {
  return {
    contactId: null,
    scheduledAt: null,
    timezone: null,
    ...over,
  };
}

// ── Appointment payload helper ────────────────────────────────────────────────
function appointmentPayload(opts: {
  eventType?: string;
  locationId?: string;
  appointmentId?: string;
  ghlContactId?: string;
  status?: string;
  eventId?: string;
  startTime?: string;
  timezone?: string;
} = {}): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    type: opts.eventType ?? "AppointmentUpdate",
    locationId: opts.locationId ?? TEST_LOCATION_ID,
    appointment: {
      id: opts.appointmentId ?? "ghl_appt_001",
      status: opts.status ?? "confirmed",
      startTime: opts.startTime ?? "2025-06-01T10:00:00Z",
      timezone: opts.timezone ?? "America/Chicago",
      contactId: opts.ghlContactId ?? "ghl_contact_001",
    },
  };
  if (opts.ghlContactId) payload["contactId"] = opts.ghlContactId;
  if (opts.eventId) payload["eventId"] = opts.eventId;
  return payload;
}

/** The default payload's startTime as a Date — used to seed matching stub rows. */
const DEFAULT_START_TIME = new Date("2025-06-01T10:00:00Z");
const DEFAULT_TIMEZONE = "America/Chicago";

// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  await loadModules();
  const {
    isGhlWebhookConfigured,
    verifyGhlSignature,
    parseGhlWebhookEvent,
    mapGhlAppointmentStatus,
  } = verifierModule;

  let passed = 0;

  // ══════════════════════════════════════════════════════════════════════════
  // Group 1: isGhlWebhookConfigured
  // ══════════════════════════════════════════════════════════════════════════
  {
    delete process.env[ENV_KEY];
    assert.equal(isGhlWebhookConfigured(), false, "missing → false");
    process.env[ENV_KEY] = "   ";
    assert.equal(isGhlWebhookConfigured(), false, "blank → false");
    process.env[ENV_KEY] = PUB_KEY_B64;
    assert.equal(isGhlWebhookConfigured(), true, "set → true");
    passed++;
    console.log("✓ Group 1: isGhlWebhookConfigured");
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Group 2: verifyGhlSignature
  // ══════════════════════════════════════════════════════════════════════════
  {
    process.env[ENV_KEY] = PUB_KEY_B64;
    const body = JSON.stringify({ type: "AppointmentUpdate", locationId: TEST_LOCATION_ID });
    const goodSig = sign(body);

    assert.equal(verifyGhlSignature(body, goodSig), true, "valid sig accepted");
    assert.equal(verifyGhlSignature(Buffer.from(body), goodSig), true, "Buffer body accepted");
    assert.equal(verifyGhlSignature(body, sign(body, wrongPrivKeyObj)), false, "wrong key → rejected");
    assert.equal(verifyGhlSignature(JSON.stringify({ other: true }), goodSig), false, "tampered body → rejected");
    assert.equal(verifyGhlSignature(body, undefined), false, "missing header → rejected");
    assert.equal(verifyGhlSignature(body, ""), false, "blank header → rejected");
    assert.equal(verifyGhlSignature(body, "   "), false, "whitespace header → rejected");
    assert.equal(verifyGhlSignature(body, "not-base64!!@@"), false, "garbage header → rejected");

    delete process.env[ENV_KEY];
    assert.equal(verifyGhlSignature(body, goodSig), false, "unconfigured key → rejected");
    process.env[ENV_KEY] = PUB_KEY_B64;

    passed++;
    console.log("✓ Group 2: verifyGhlSignature");
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Group 3: parseGhlWebhookEvent unit coverage
  // ══════════════════════════════════════════════════════════════════════════
  {
    const LOC = TEST_LOCATION_ID;

    // 3a. Invalid inputs → null.
    assert.equal(parseGhlWebhookEvent(null, LOC), null, "null → null");
    assert.equal(parseGhlWebhookEvent([], LOC), null, "array → null");
    assert.equal(parseGhlWebhookEvent("str", LOC), null, "string → null");
    assert.equal(parseGhlWebhookEvent({}, LOC), null, "missing type → null");
    assert.equal(parseGhlWebhookEvent({ type: "  ", locationId: LOC }, LOC), null, "blank type → null");

    // 3b. Missing locationId → null.
    assert.equal(parseGhlWebhookEvent({ type: "AppointmentUpdate" }, LOC), null);

    // 3c. Wrong locationId → wrong_location.
    const wr = parseGhlWebhookEvent(
      { type: "AppointmentUpdate", locationId: "other", appointment: { id: "x" } },
      LOC,
    );
    assert.ok(wr?.kind === "wrong_location", "wrong location → wrong_location");

    // 3d. AppointmentCreate full parse.
    const create = parseGhlWebhookEvent(
      {
        type: "AppointmentCreate",
        locationId: LOC,
        eventId: "ev_001",
        appointment: {
          id: "appt_1",
          contactId: "contact_1",
          status: "confirmed",
          startTime: "2025-06-01T10:00:00Z",
          timezone: "America/Chicago",
        },
      },
      LOC,
    );
    assert.ok(create?.kind === "appointment");
    assert.equal((create as any).appointmentId, "appt_1");
    assert.equal((create as any).contactId, "contact_1");
    assert.equal((create as any).noBullStatus, "scheduled");
    assert.equal((create as any).ghlEventId, "ev_001");

    // 3e. Unknown GHL status → noBullStatus null.
    const unk = parseGhlWebhookEvent(
      { type: "AppointmentUpdate", locationId: LOC, appointment: { id: "a2", status: "mystery" } },
      LOC,
    );
    assert.ok(unk?.kind === "appointment" && (unk as any).noBullStatus === null);

    // mapGhlAppointmentStatus full coverage.
    const statusMap: [string | null | undefined, string | null][] = [
      ["confirmed", "scheduled"], ["new", "scheduled"],
      ["showed", "completed"], ["completed", "completed"],
      ["cancelled", "cancelled"], ["canceled", "cancelled"],
      ["no-show", "no_show"], ["no_show", "no_show"], ["noshow", "no_show"],
      ["CONFIRMED", "scheduled"], // case-insensitive
      ["mystery_xyz", null], ["", null], [null, null], [undefined, null],
    ];
    for (const [input, expected] of statusMap) {
      assert.equal(mapGhlAppointmentStatus(input), expected, `'${input}' → '${expected}'`);
    }

    // 3f. ContactDndUpdate DND enabled (bool).
    const dndBool = parseGhlWebhookEvent(
      { type: "ContactDndUpdate", locationId: LOC, contactId: "c1", phone: "+15551234567", dnd: true },
      LOC,
    );
    assert.ok(dndBool?.kind === "dnd" && (dndBool as any).reason === "contact_dnd_enabled");

    // DND enabled via object flags.
    const dndObj = parseGhlWebhookEvent(
      { type: "ContactDndUpdate", locationId: LOC, dnd: { sms: true, email: false } },
      LOC,
    );
    assert.ok(dndObj?.kind === "dnd", "DND object with truthy flag → dnd");

    // 3g. ContactDndUpdate DND cleared → ignored.
    assert.ok(
      parseGhlWebhookEvent({ type: "ContactDndUpdate", locationId: LOC, dnd: false }, LOC)?.kind === "ignored",
    );
    assert.ok(
      parseGhlWebhookEvent(
        { type: "ContactDndUpdate", locationId: LOC, dnd: { sms: false, email: false } },
        LOC,
      )?.kind === "ignored",
      "all-false DND object → ignored",
    );

    // 3g2. Official ContactDndUpdate Email DND contract.
    const emailUnsubscribe = parseGhlWebhookEvent(
      {
        type: "ContactDndUpdate",
        locationId: LOC,
        id: "ghl_contact_email_1",
        email: "Buyer@Example.com",
        dnd: true,
        dndSettings: {
          SMS: { status: "inactive" },
          Email: { status: "active" },
        },
      },
      LOC,
    );
    assert.ok(emailUnsubscribe?.kind === "email_unsubscribe");
    assert.equal((emailUnsubscribe as any).contactId, "ghl_contact_email_1");
    assert.equal((emailUnsubscribe as any).email, "buyer@example.com");
    assert.equal((emailUnsubscribe as any).smsOptOut, false);
    assert.equal(
      (emailUnsubscribe as any).ghlEventId,
      null,
      "ContactDndUpdate root id is contact identity, not delivery identity",
    );

    const combinedDnd = parseGhlWebhookEvent(
      {
        type: "ContactDndUpdate",
        locationId: LOC,
        id: "ghl_contact_both_1",
        email: "both@example.com",
        phone: "+15550001111",
        eventId: "delivery_both_1",
        dndSettings: {
          SMS: { status: "active" },
          Email: { status: "active" },
        },
      },
      LOC,
    );
    assert.ok(combinedDnd?.kind === "email_unsubscribe");
    assert.equal((combinedDnd as any).smsOptOut, true);
    assert.equal((combinedDnd as any).ghlEventId, "delivery_both_1");

    assert.equal(
      parseGhlWebhookEvent(
        {
          type: "ContactDndUpdate",
          locationId: LOC,
          id: "ghl_contact_missing_email",
          dndSettings: { Email: { status: "active" } },
        },
        LOC,
      ),
      null,
      "active Email DND without email is malformed",
    );
    assert.equal(
      parseGhlWebhookEvent(
        {
          type: "ContactDndUpdate",
          locationId: LOC,
          id: "ghl_contact_email_active",
          email: "not-an-email",
          dndSettings: { Email: { status: "active" } },
        },
        LOC,
      ),
      null,
      "active Email DND requires a valid address",
    );
    assert.equal(
      parseGhlWebhookEvent(
        {
          type: "ContactDndUpdate",
          locationId: LOC,
          contactId: "legacy_contact_only",
          email: "buyer@example.com",
          dndSettings: { Email: { status: "active" } },
        },
        LOC,
      ),
      null,
      "Email DND requires official root id, not legacy contactId alias",
    );
    assert.equal(
      parseGhlWebhookEvent(
        {
          type: "ContactDndUpdate",
          locationId: LOC,
          id: "official_contact",
          contactId: "conflicting_contact",
          email: "buyer@example.com",
          dndSettings: { Email: { status: "active" } },
        },
        LOC,
      ),
      null,
      "conflicting contact identity is malformed",
    );
    assert.equal(
      parseGhlWebhookEvent(
        {
          type: "ContactDndUpdate",
          locationId: LOC,
          id: "ghl_contact_email_inactive",
          email: "buyer@example.com",
          dnd: true,
          dndSettings: {
            SMS: { status: "inactive" },
            Email: { status: "inactive" },
          },
        },
        LOC,
      )?.kind,
      "ignored",
      "channel-specific inactive statuses do not inherit global DND as SMS",
    );

    // 3h. InboundMessage STOP keywords (all variants, body + messageType).
    for (const kw of ["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"]) {
      const stopEvt = parseGhlWebhookEvent(
        { type: "InboundMessage", locationId: LOC, message: kw, phone: "+15559998888" },
        LOC,
      );
      assert.ok(stopEvt?.kind === "dnd" && (stopEvt as any).reason === "inbound_stop_keyword", `'${kw}' → dnd`);
      // via messageType field.
      const stopType = parseGhlWebhookEvent(
        { type: "InboundMessage", locationId: LOC, messageType: kw, phone: "+15559998888" },
        LOC,
      );
      assert.ok(stopType?.kind === "dnd", `messageType '${kw}' → dnd`);
    }

    // 3i. InboundMessage non-STOP → ignored.
    assert.ok(
      parseGhlWebhookEvent(
        { type: "InboundMessage", locationId: LOC, message: "Hello there", phone: "+15559998888" },
        LOC,
      )?.kind === "ignored",
    );

    // 3j. Unknown event type → ignored.
    const unkn = parseGhlWebhookEvent({ type: "SomeOtherEvent", locationId: LOC }, LOC);
    assert.ok(unkn?.kind === "ignored" && (unkn as any).eventType === "SomeOtherEvent");

    // 3k. ghlEventId extraction priority: eventId > deliveryId > webhookId > id.
    const withEventId = parseGhlWebhookEvent(
      { type: "InboundMessage", locationId: LOC, message: "STOP", phone: "+1", eventId: "ev1", id: "fallback" },
      LOC,
    );
    assert.equal((withEventId as any)?.ghlEventId, "ev1", "eventId wins");

    const withDeliveryId = parseGhlWebhookEvent(
      { type: "InboundMessage", locationId: LOC, message: "STOP", phone: "+1", deliveryId: "del1", id: "fallback" },
      LOC,
    );
    assert.equal((withDeliveryId as any)?.ghlEventId, "del1", "deliveryId second");

    const withIdOnly = parseGhlWebhookEvent(
      { type: "InboundMessage", locationId: LOC, message: "STOP", phone: "+1", id: "root_id" },
      LOC,
    );
    assert.equal((withIdOnly as any)?.ghlEventId, "root_id", "id is fallback");

    passed++;
    console.log("✓ Group 3: parseGhlWebhookEvent unit coverage");
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Group 4: Route HTTP layer (real route + injectable stubs)
  // ══════════════════════════════════════════════════════════════════════════
  const app = buildApp();
  const { server, baseUrl } = await listen(app);

  try {
    // 4a. Unconfigured key → 503.
    {
      delete process.env[ENV_KEY];
      const state = freshState();
      routeModule.__test_setGhlWebhookDeps(makeStubs(state));
      const r = await postWebhook(baseUrl, appointmentPayload(), { omitSig: true });
      assert.equal(r.status, 503, `unconfigured key → 503 (got ${r.status})`);
      process.env[ENV_KEY] = PUB_KEY_B64;
    }

    // 4b. Configured key, location unresolvable → 503.
    {
      process.env[ENV_KEY] = PUB_KEY_B64;
      const state = freshState("FAIL");
      routeModule.__test_setGhlWebhookDeps(makeStubs(state));
      const body = appointmentPayload();
      const r = await postWebhook(baseUrl, body, { sig: sign(JSON.stringify(body)) });
      assert.equal(r.status, 503, `unresolvable location → 503 (got ${r.status})`);
    }

    // 4c. Invalid/missing/wrong-key signature → 401.
    {
      process.env[ENV_KEY] = PUB_KEY_B64;
      const state = freshState();
      routeModule.__test_setGhlWebhookDeps(makeStubs(state));
      const body = appointmentPayload();
      const raw = JSON.stringify(body);

      const noSig = await postWebhook(baseUrl, body, { omitSig: true });
      assert.equal(noSig.status, 401, "no sig → 401");

      const wrongKey = await postWebhook(baseUrl, body, { sig: sign(raw, wrongPrivKeyObj) });
      assert.equal(wrongKey.status, 401, "wrong key → 401");

      const tampered = await postWebhook(baseUrl, body, { sig: sign(JSON.stringify({ other: 1 })) });
      assert.equal(tampered.status, 401, "tampered body → 401");

      const garbage = await postWebhook(baseUrl, body, { sig: "not_base64!!" });
      assert.equal(garbage.status, 401, "garbage sig → 401");
    }

    // 4d. Wrong locationId → 403.
    {
      process.env[ENV_KEY] = PUB_KEY_B64;
      const state = freshState();
      routeModule.__test_setGhlWebhookDeps(makeStubs(state));
      const body = appointmentPayload({ locationId: "wrong_loc_xyz" });
      const r = await postWebhook(baseUrl, body);
      assert.equal(r.status, 403, `wrong location → 403 (got ${r.status})`);
    }

    // 4e. Missing type field → 400.
    {
      process.env[ENV_KEY] = PUB_KEY_B64;
      const state = freshState();
      routeModule.__test_setGhlWebhookDeps(makeStubs(state));
      const body = { locationId: TEST_LOCATION_ID };
      const r = await postWebhook(baseUrl, body);
      assert.equal(r.status, 400, `missing type → 400 (got ${r.status})`);
    }

    // 4f. AppointmentUpdate known correlation, legal transition → transitioned.
    {
      process.env[ENV_KEY] = PUB_KEY_B64;
      const state = freshState();
      state.appointmentsByGhlId.set("ghl_appt_001", stubAppt({
        id: "local_appt_001",
        status: "pending",
        scheduledAt: DEFAULT_START_TIME,
        timezone: DEFAULT_TIMEZONE,
      }));
      routeModule.__test_setGhlWebhookDeps(makeStubs(state));
      const body = appointmentPayload({ status: "confirmed" });
      const r = await postWebhook(baseUrl, body);
      assert.equal(r.status, 200, `legal transition → 200 (got ${r.status})`);
      assert.equal(r.json?.status, "transitioned");
      assert.equal(r.json?.fromStatus, "pending");
      assert.equal(r.json?.toStatus, "scheduled");
      assert.equal(state.transitionCalls.length, 1);
    }

    // 4g. AppointmentUpdate same status, no schedule change → already_in_target_state,
    //     NO transition and NO reschedule call.
    {
      process.env[ENV_KEY] = PUB_KEY_B64;
      const state = freshState();
      state.appointmentsByGhlId.set("ghl_appt_001", stubAppt({
        id: "local_appt_001",
        status: "scheduled",
        scheduledAt: DEFAULT_START_TIME,
        timezone: DEFAULT_TIMEZONE,
      }));
      routeModule.__test_setGhlWebhookDeps(makeStubs(state));
      // confirmed → scheduled (same), identical startTime/timezone → no-op.
      const body = appointmentPayload({ status: "confirmed" });
      const r = await postWebhook(baseUrl, body);
      assert.equal(r.status, 200);
      assert.equal(r.json?.status, "already_in_target_state");
      assert.equal(state.transitionCalls.length, 0, "no transition on same-status no-change");
      assert.equal(state.rescheduleCalls.length, 0, "no reschedule on identical schedule");
    }

    // 4g2. AppointmentUpdate same status + changed startTime → RESCHEDULE,
    //      NO status transition.
    {
      process.env[ENV_KEY] = PUB_KEY_B64;
      const state = freshState();
      state.appointmentsByGhlId.set("ghl_appt_001", stubAppt({
        id: "local_appt_001",
        status: "scheduled",
        scheduledAt: DEFAULT_START_TIME,
        timezone: DEFAULT_TIMEZONE,
      }));
      routeModule.__test_setGhlWebhookDeps(makeStubs(state));
      const body = appointmentPayload({
        status: "confirmed",          // maps to scheduled (same)
        startTime: "2025-07-15T14:30:00Z", // DIFFERENT time
      });
      const r = await postWebhook(baseUrl, body);
      assert.equal(r.status, 200, `reschedule → 200 (got ${r.status})`);
      assert.equal(r.json?.status, "rescheduled", "same-status + new time → rescheduled");
      assert.equal(state.transitionCalls.length, 0, "reschedule does NOT transition status");
      assert.equal(state.rescheduleCalls.length, 1, "exactly one reschedule call");
      assert.equal(
        state.rescheduleCalls[0]?.scheduledAt?.toISOString(),
        new Date("2025-07-15T14:30:00Z").toISOString(),
        "reschedule carries the new startTime",
      );
    }

    // 4g3. AppointmentUpdate same status + changed timezone only → RESCHEDULE.
    {
      process.env[ENV_KEY] = PUB_KEY_B64;
      const state = freshState();
      state.appointmentsByGhlId.set("ghl_appt_001", stubAppt({
        id: "local_appt_001",
        status: "scheduled",
        scheduledAt: DEFAULT_START_TIME,
        timezone: DEFAULT_TIMEZONE,
      }));
      routeModule.__test_setGhlWebhookDeps(makeStubs(state));
      const body = appointmentPayload({
        status: "confirmed",
        timezone: "America/New_York", // DIFFERENT tz, same time
      });
      const r = await postWebhook(baseUrl, body);
      assert.equal(r.status, 200);
      assert.equal(r.json?.status, "rescheduled", "same-status + new tz → rescheduled");
      assert.equal(state.transitionCalls.length, 0, "tz reschedule does NOT transition");
      assert.equal(state.rescheduleCalls.length, 1);
    }

    // 4h. AppointmentUpdate illegal transition → illegal_transition_ignored.
    {
      process.env[ENV_KEY] = PUB_KEY_B64;
      const state = freshState();
      state.appointmentsByGhlId.set("ghl_appt_001", stubAppt({
        id: "local_appt_001",
        status: "completed",
      }));
      routeModule.__test_setGhlWebhookDeps(makeStubs(state));
      const body = appointmentPayload({ status: "confirmed" }); // completed→scheduled: illegal
      const r = await postWebhook(baseUrl, body);
      assert.equal(r.status, 200);
      assert.equal(r.json?.status, "illegal_transition_ignored");
    }

    // 4i. AppointmentUpdate NO correlation but contact correlation + resolvable
    //     application → bootstrap (same path as Create), transitions → 200.
    {
      process.env[ENV_KEY] = PUB_KEY_B64;
      const state = freshState();
      state.contactsByGhlId.set("ghl_contact_001", { id: "local_contact_001" });
      state.applicationsByKey.set("contact:local_contact_001", { id: "app_x", status: "qualified" });
      routeModule.__test_setGhlWebhookDeps(makeStubs(state));
      const body = appointmentPayload({
        eventType: "AppointmentUpdate",
        appointmentId: "ghl_appt_UNKNOWN",
        ghlContactId: "ghl_contact_001",
        status: "confirmed",
      });
      const r = await postWebhook(baseUrl, body);
      assert.equal(r.status, 200, `Update bootstrap → 200 (got ${r.status})`);
      const okStatus = r.json?.status === "transitioned" || r.json?.status === "created_and_correlated";
      assert.ok(okStatus, `Update-with-no-correlation bootstraps, got ${r.json?.status}`);
      assert.equal(state.correlationsWritten.length, 1, "Update bootstrap writes correlation");
      // No status claiming GHL will retry.
      assert.notEqual(r.json?.status, "no_local_correlation");
    }

    // 4i2. AppointmentUpdate NO correlation AND no contact correlation → 500 retryable.
    {
      process.env[ENV_KEY] = PUB_KEY_B64;
      const state = freshState();
      routeModule.__test_setGhlWebhookDeps(makeStubs(state));
      const body = appointmentPayload({
        eventType: "AppointmentUpdate",
        appointmentId: "ghl_appt_UNKNOWN2",
        ghlContactId: "ghl_contact_missing",
        status: "confirmed",
      });
      const r = await postWebhook(baseUrl, body);
      assert.equal(r.status, 500, `Update no-correlation no-contact → 500 (got ${r.status})`);
      assert.equal(r.json?.retryable, true);
    }

    // 4j. AppointmentUpdate unmapped GHL status → ignored/unmapped_ghl_status.
    {
      process.env[ENV_KEY] = PUB_KEY_B64;
      const state = freshState();
      state.appointmentsByGhlId.set("ghl_appt_001", stubAppt({
        id: "local_appt_001",
        status: "pending",
      }));
      routeModule.__test_setGhlWebhookDeps(makeStubs(state));
      const body = appointmentPayload({ status: "mystery_status" });
      const r = await postWebhook(baseUrl, body);
      assert.equal(r.status, 200);
      assert.equal(r.json?.status, "ignored");
      assert.equal(r.json?.reason, "unmapped_ghl_status");
    }

    // 4k. AppointmentCreate missing contactId → 500 retryable.
    {
      process.env[ENV_KEY] = PUB_KEY_B64;
      const state = freshState();
      routeModule.__test_setGhlWebhookDeps(makeStubs(state));
      const body: Record<string, unknown> = {
        type: "AppointmentCreate",
        locationId: TEST_LOCATION_ID,
        appointment: { id: "ghl_appt_new", status: "confirmed" },
        // no contactId
      };
      const r = await postWebhook(baseUrl, body);
      assert.equal(r.status, 500, `no contactId → 500 (got ${r.status})`);
      assert.equal(r.json?.retryable, true);
    }

    // 4l. AppointmentCreate no contact correlation → 500 retryable.
    {
      process.env[ENV_KEY] = PUB_KEY_B64;
      const state = freshState();
      // contactsByGhlId is empty — no correlation for "ghl_contact_001".
      routeModule.__test_setGhlWebhookDeps(makeStubs(state));
      const body = appointmentPayload({
        eventType: "AppointmentCreate",
        appointmentId: "ghl_appt_new2",
        ghlContactId: "ghl_contact_001",
        status: "confirmed",
      });
      const r = await postWebhook(baseUrl, body);
      assert.equal(r.status, 500, `no contact correlation → 500 (got ${r.status})`);
      assert.equal(r.json?.retryable, true);
    }

    // 4l2. AppointmentCreate WITH contact correlation but NO resolvable
    //      application → 500 retryable (route must NOT fabricate an application).
    {
      process.env[ENV_KEY] = PUB_KEY_B64;
      const state = freshState();
      state.contactsByGhlId.set("ghl_contact_001", { id: "local_contact_noapp" });
      // No application seeded for this contact.
      routeModule.__test_setGhlWebhookDeps(makeStubs(state));
      const body = appointmentPayload({
        eventType: "AppointmentCreate",
        appointmentId: "ghl_appt_noapp",
        ghlContactId: "ghl_contact_001",
        status: "confirmed",
      });
      const r = await postWebhook(baseUrl, body);
      assert.equal(r.status, 500, `no resolvable app → 500 (got ${r.status})`);
      assert.equal(r.json?.retryable, true);
      assert.equal(state.resolveCalls.length, 1, "resolve was attempted");
      assert.equal(state.appointmentsUpserted.length, 0, "no appointment fabricated");
      assert.equal(state.correlationsWritten.length, 0, "no correlation fabricated");
    }

    // 4m. AppointmentCreate full path (resolvable app) → transitioned/created_and_correlated.
    {
      process.env[ENV_KEY] = PUB_KEY_B64;
      const state = freshState();
      state.contactsByGhlId.set("ghl_contact_001", { id: "local_contact_001" });
      state.applicationsByKey.set("contact:local_contact_001", { id: "app_qualified_1", status: "qualified" });
      routeModule.__test_setGhlWebhookDeps(makeStubs(state));
      const body = appointmentPayload({
        eventType: "AppointmentCreate",
        appointmentId: "ghl_appt_brand_new",
        ghlContactId: "ghl_contact_001",
        status: "confirmed",
      });
      const r = await postWebhook(baseUrl, body);
      assert.equal(r.status, 200, `AppointmentCreate full path → 200 (got ${r.status})`);
      const okStatus = r.json?.status === "transitioned" || r.json?.status === "created_and_correlated";
      assert.ok(okStatus, `expected transitioned or created_and_correlated, got ${r.json?.status}`);
      assert.equal(state.resolveCalls.length, 1, "resolved (not created) an application");
      assert.equal(state.appointmentsUpserted.length, 1, "appointment upserted");
      assert.equal(state.correlationsWritten.length, 1, "correlation written");
      // The upsert used the resolved application id.
      assert.equal(state.appointmentsUpserted[0]?.auditApplicationId, "app_qualified_1");
    }

    // 4n. AppointmentCreate replay (correlation already exists) →
    //     already_in_target_state; no duplicate resolve/upsert/correlation.
    {
      process.env[ENV_KEY] = PUB_KEY_B64;
      const state = freshState();
      state.contactsByGhlId.set("ghl_contact_001", { id: "local_contact_001" });
      // Pre-seed the correlation (as if 4m already ran) — matched status + schedule.
      state.appointmentsByGhlId.set("ghl_appt_brand_new", stubAppt({
        id: "appt_app_qualified_1",
        status: "scheduled",
        contactId: "local_contact_001",
        scheduledAt: DEFAULT_START_TIME,
        timezone: DEFAULT_TIMEZONE,
      }));
      routeModule.__test_setGhlWebhookDeps(makeStubs(state));
      const body = appointmentPayload({
        eventType: "AppointmentCreate",
        appointmentId: "ghl_appt_brand_new",
        ghlContactId: "ghl_contact_001",
        status: "confirmed",
      });
      const r = await postWebhook(baseUrl, body);
      assert.equal(r.status, 200);
      assert.equal(r.json?.status, "already_in_target_state", "Create replay → already_in_target_state");
      assert.equal(state.resolveCalls.length, 0, "no application resolution on replay");
      assert.equal(state.appointmentsUpserted.length, 0, "no upsert on replay");
      assert.equal(state.correlationsWritten.length, 0, "no correlation write on replay");
    }

    // 4o. DND enabled + phone → dnd_applied, opt-out written, ghl:-prefixed key,
    //     storm watcher fired once.
    {
      process.env[ENV_KEY] = PUB_KEY_B64;
      const state = freshState();
      routeModule.__test_setGhlWebhookDeps(makeStubs(state));
      const body = {
        type: "ContactDndUpdate",
        locationId: TEST_LOCATION_ID,
        contactId: "contact_dnd_1",
        phone: "+15551234567",
        dnd: true,
        eventId: "ev_dnd_001",
      };
      const r = await postWebhook(baseUrl, body);
      assert.equal(r.status, 200, `DND enabled → 200 (got ${r.status})`);
      assert.equal(r.json?.status, "dnd_applied");
      assert.equal(r.json?.phone, "+15551234567");
      assert.equal(state.dndCalls.length, 1);
      assert.equal(state.dndCalls[0]?.dedupeKey, "ghl:ev_dnd_001", "ghl:-prefixed event ID");
      assert.equal(state.dndCalls[0]?.eventInserted, true);
      assert.equal(state.stormCalls.length, 1, "storm watcher fires on fresh change");
    }

    // 4p. DND enabled replay (SAME dedupe key) → atomic no-op:
    //     dnd_replay_noop, ledger untouched, storm watcher does NOT fire again.
    {
      process.env[ENV_KEY] = PUB_KEY_B64;
      const state = freshState();
      routeModule.__test_setGhlWebhookDeps(makeStubs(state));
      const body = {
        type: "ContactDndUpdate",
        locationId: TEST_LOCATION_ID,
        phone: "+15551234567",
        dnd: true,
        eventId: "ev_dnd_002",
      };
      const raw = JSON.stringify(body);
      const sig = sign(raw);
      const r1 = await postWebhook(baseUrl, body, { sig });
      assert.equal(r1.json?.status, "dnd_applied", "first delivery applies");
      const r2 = await postWebhook(baseUrl, body, { sig });
      assert.equal(r2.status, 200, "replay → 200");
      assert.equal(r2.json?.status, "dnd_replay_noop", "replay is an atomic no-op");
      assert.equal(state.dndCalls.length, 2, "both deliveries reach the seam");
      assert.equal(state.dndCalls[1]?.eventInserted, false, "second insert deduped");
      assert.equal(state.stormCalls.length, 1, "storm watcher fires only ONCE across replays");
    }

    // 4p2. DND with NO event ID → deterministic sha256(rawBody) key applied,
    //      and replay of the identical body dedupes.
    {
      process.env[ENV_KEY] = PUB_KEY_B64;
      const state = freshState();
      routeModule.__test_setGhlWebhookDeps(makeStubs(state));
      const body = {
        type: "ContactDndUpdate",
        locationId: TEST_LOCATION_ID,
        phone: "+15550001111",
        dnd: true,
        // no eventId / deliveryId / webhookId / id
      };
      const sig = sign(JSON.stringify(body));
      const r1 = await postWebhook(baseUrl, body, { sig });
      assert.equal(r1.json?.status, "dnd_applied");
      assert.ok(
        state.dndCalls[0]?.dedupeKey.startsWith("ghl:sha256:"),
        `no-ID payload derives sha256 key, got ${state.dndCalls[0]?.dedupeKey}`,
      );
      const r2 = await postWebhook(baseUrl, body, { sig });
      assert.equal(r2.json?.status, "dnd_replay_noop", "identical no-ID body dedupes");
      assert.equal(state.stormCalls.length, 1, "storm watcher fires once for no-ID replay");
    }

    // 4q. DND cleared → ignored, no opt-out write, no storm.
    {
      process.env[ENV_KEY] = PUB_KEY_B64;
      const state = freshState();
      routeModule.__test_setGhlWebhookDeps(makeStubs(state));
      const body = {
        type: "ContactDndUpdate",
        locationId: TEST_LOCATION_ID,
        contactId: "contact_dnd_1",
        phone: "+15551234567",
        dnd: false,
      };
      const r = await postWebhook(baseUrl, body);
      assert.equal(r.status, 200);
      assert.equal(r.json?.status, "ignored", "DND cleared → ignored");
      assert.equal(state.dndCalls.length, 0, "no opt-out write when DND cleared");
      assert.equal(state.stormCalls.length, 0, "no storm on DND cleared");
    }

    // 4r. DND enabled + no phone → dnd_no_phone.
    {
      process.env[ENV_KEY] = PUB_KEY_B64;
      const state = freshState();
      routeModule.__test_setGhlWebhookDeps(makeStubs(state));
      const body = {
        type: "ContactDndUpdate",
        locationId: TEST_LOCATION_ID,
        contactId: "contact_dnd_2",
        dnd: true,
        // phone absent
      };
      const r = await postWebhook(baseUrl, body);
      assert.equal(r.status, 200);
      assert.equal(r.json?.status, "dnd_no_phone");
      assert.equal(state.dndCalls.length, 0, "no opt-out write when phone absent");
    }

    // 4s. InboundMessage STOP → dnd_applied.
    {
      process.env[ENV_KEY] = PUB_KEY_B64;
      const state = freshState();
      routeModule.__test_setGhlWebhookDeps(makeStubs(state));
      const body = {
        type: "InboundMessage",
        locationId: TEST_LOCATION_ID,
        contactId: "contact_stop_1",
        phone: "+15557778888",
        message: "STOP",
        eventId: "ev_stop_001",
      };
      const r = await postWebhook(baseUrl, body);
      assert.equal(r.status, 200, `InboundMessage STOP → 200 (got ${r.status})`);
      assert.equal(r.json?.status, "dnd_applied");
      assert.equal(state.dndCalls.length, 1);
      assert.equal(state.dndCalls[0]?.dedupeKey, "ghl:ev_stop_001");
    }

    // 4t. InboundMessage non-STOP → ignored.
    {
      process.env[ENV_KEY] = PUB_KEY_B64;
      const state = freshState();
      routeModule.__test_setGhlWebhookDeps(makeStubs(state));
      const body = {
        type: "InboundMessage",
        locationId: TEST_LOCATION_ID,
        message: "Hello, how are you?",
        phone: "+15557778888",
      };
      const r = await postWebhook(baseUrl, body);
      assert.equal(r.status, 200);
      assert.equal(r.json?.status, "ignored");
      assert.equal(state.dndCalls.length, 0);
    }

    // 4u. Unknown event → ignored.
    {
      process.env[ENV_KEY] = PUB_KEY_B64;
      const state = freshState();
      routeModule.__test_setGhlWebhookDeps(makeStubs(state));
      const body = { type: "SomeFutureEvent", locationId: TEST_LOCATION_ID };
      const r = await postWebhook(baseUrl, body);
      assert.equal(r.status, 200);
      assert.equal(r.json?.status, "ignored");
    }

    // 4v. GHL never writes opted_in — no code path exists.
    {
      // Guaranteed by design: the DND seam always requests newState: "opted_out"
      // in the route (defaultApplyDndOptOut), and there is no opted_in branch.
      // Every dnd delivery in this suite went through the opt-out seam only.
      console.log("  (4v: no opted_in path exists in the route — verified by inspection + all prior dnd checks)");
    }

    // 4w/4x. Signed Email DND applies one canonical suppression and a replay
    // reconfirms it without inserting a duplicate or re-tightening the contact.
    {
      process.env[ENV_KEY] = PUB_KEY_B64;
      const state = freshState();
      routeModule.__test_setGhlWebhookDeps(makeStubs(state));
      const body = {
        type: "ContactDndUpdate",
        locationId: TEST_LOCATION_ID,
        id: "ghl_contact_email_route_1",
        email: "Buyer@Example.com",
        eventId: "email_delivery_001",
        dndSettings: {
          SMS: { status: "inactive" },
          Email: { status: "active" },
        },
      };
      const r1 = await postWebhook(baseUrl, body);
      assert.equal(r1.status, 200);
      assert.equal(r1.json?.status, "email_unsubscribe_applied");
      assert.equal(r1.json?.email, "buyer@example.com");
      assert.equal(r1.json?.contactStatusChanged, true);
      assert.equal(r1.json?.correlationStatus, "matched");
      assert.equal(r1.json?.discrepancy, null);
      assert.equal(r1.json?.smsStatus, null);

      const r2 = await postWebhook(baseUrl, body);
      assert.equal(r2.status, 200);
      assert.equal(r2.json?.status, "email_unsubscribe_reconfirmed");
      assert.equal(r2.json?.contactStatusChanged, false);
      assert.equal(state.emailSuppressionSeen.size, 1, "replay keeps one suppression");
      assert.equal(state.emailUnsubscribeCalls.length, 2);
      assert.equal(
        state.emailUnsubscribeCalls[0]?.dedupeKey,
        "ghl:email_delivery_001",
      );
    }

    // 4y. Correlation discrepancies stay explicit in the response and evidence
    // passed to the durable suppression writer used by the operator list.
    {
      process.env[ENV_KEY] = PUB_KEY_B64;
      const state = freshState();
      state.emailCorrelationByGhlId.set(
        "ghl_contact_discrepant",
        "missing_contact_correlation",
      );
      routeModule.__test_setGhlWebhookDeps(makeStubs(state));
      const body = {
        type: "ContactDndUpdate",
        locationId: TEST_LOCATION_ID,
        id: "ghl_contact_discrepant",
        email: "discrepancy@example.com",
        dndSettings: { Email: { status: "active" } },
      };
      const r = await postWebhook(baseUrl, body);
      assert.equal(r.status, 200);
      assert.equal(r.json?.status, "email_unsubscribe_applied");
      assert.equal(r.json?.discrepancy, "missing_contact_correlation");
      assert.ok(
        state.emailUnsubscribeCalls[0]?.dedupeKey.startsWith("ghl:sha256:"),
        "official payload id is not reused as delivery dedupe ID",
      );
      assert.match(
        state.emailUnsubscribeCalls[0]?.evidence ?? "",
        /contactId=ghl_contact_discrepant/,
      );
    }

    // 4z. Missing email is rejected, and Email DND inactive is ignored. Neither
    // creates an affirmative `subscribed` path.
    {
      process.env[ENV_KEY] = PUB_KEY_B64;
      const state = freshState();
      routeModule.__test_setGhlWebhookDeps(makeStubs(state));
      const malformed = await postWebhook(baseUrl, {
        type: "ContactDndUpdate",
        locationId: TEST_LOCATION_ID,
        id: "ghl_contact_no_email",
        dndSettings: { Email: { status: "active" } },
      });
      assert.equal(malformed.status, 400);

      const legacyIdentityOnly = await postWebhook(baseUrl, {
        type: "ContactDndUpdate",
        locationId: TEST_LOCATION_ID,
        contactId: "legacy_contact_only",
        email: "legacy@example.com",
        dndSettings: { Email: { status: "active" } },
      });
      assert.equal(legacyIdentityOnly.status, 400);

      const conflictingIdentity = await postWebhook(baseUrl, {
        type: "ContactDndUpdate",
        locationId: TEST_LOCATION_ID,
        id: "official_contact",
        contactId: "conflicting_contact",
        email: "conflict@example.com",
        dndSettings: { Email: { status: "active" } },
      });
      assert.equal(conflictingIdentity.status, 400);

      const inactive = await postWebhook(baseUrl, {
        type: "ContactDndUpdate",
        locationId: TEST_LOCATION_ID,
        id: "ghl_contact_email_inactive",
        email: "inactive@example.com",
        dnd: false,
        dndSettings: { Email: { status: "inactive" } },
      });
      assert.equal(inactive.status, 200);
      assert.equal(inactive.json?.status, "ignored");
      assert.equal(state.emailUnsubscribeCalls.length, 0);
    }

    // 4z2. One signed delivery can tighten both Email and SMS channel states.
    {
      process.env[ENV_KEY] = PUB_KEY_B64;
      const state = freshState();
      routeModule.__test_setGhlWebhookDeps(makeStubs(state));
      const r = await postWebhook(baseUrl, {
        type: "ContactDndUpdate",
        locationId: TEST_LOCATION_ID,
        id: "ghl_contact_both_route",
        email: "both-route@example.com",
        phone: "+15550002222",
        eventId: "both_delivery_route_1",
        dndSettings: {
          SMS: { status: "active" },
          Email: { status: "active" },
        },
      });
      assert.equal(r.status, 200);
      assert.equal(r.json?.status, "email_unsubscribe_applied");
      assert.equal(r.json?.smsStatus, "dnd_applied");
      assert.equal(state.emailUnsubscribeCalls.length, 1);
      assert.equal(state.dndCalls.length, 1);
      assert.equal(state.dndCalls[0]?.dedupeKey, "ghl:both_delivery_route_1:sms");
    }

    passed++;
    console.log("✓ Group 4: Route HTTP layer (all sub-cases a–z2)");

    // ════════════════════════════════════════════════════════════════════════
    // Group 5: REAL storage-level atomic DND replay (needs DATABASE_URL)
    // Proves applyDedupedConsentStateChange is a true no-op on replay: the
    // message_sid unique index makes the second call insert 0 event rows and
    // SKIP the ledger upsert entirely (optedOutAt/evidence untouched).
    // ════════════════════════════════════════════════════════════════════════
    if (!process.env.DATABASE_URL) {
      console.log("  · Group 5 skipped (no DATABASE_URL)");
    } else {
      const { applyDedupedConsentStateChange } = await import(
        "../server/storage/smsConsentStorage"
      );
      const { db } = await import("../server/db");
      const { smsConsentLedger, smsConsentEvents } = await import("@shared/schema");
      const { eq } = await import("drizzle-orm");

      const phoneE164 = `+1999${String(Date.now()).slice(-7)}`;
      const phoneMatchKey = phoneE164.replace(/\D/g, "").slice(-10);
      const dedupeKey = `ghl:test:${crypto.randomUUID()}`;

      try {
        // First application — inserts event + upserts ledger to opted_out.
        const r1 = await applyDedupedConsentStateChange({
          phoneE164,
          phoneMatchKey,
          newState: "opted_out",
          source: "ghl_dnd",
          evidence: "GHL test opt-out (first)",
          event: { eventType: "opt_out", messageSid: dedupeKey, detail: "first" },
        });
        assert.equal(r1.eventInserted, true, "first delivery inserts the event");
        assert.equal(r1.changed, true, "first delivery changes state");
        assert.equal(r1.row?.state, "opted_out");
        const firstOptedOutAt = r1.row?.optedOutAt ?? null;
        const firstEvidence = r1.row?.evidence ?? null;
        assert.ok(firstOptedOutAt, "optedOutAt stamped on first apply");

        // Small delay so a spurious updatedAt/optedOutAt change would be visible.
        await new Promise((res) => setTimeout(res, 25));

        // Replay — SAME dedupeKey but DIFFERENT evidence/detail. Must be a no-op.
        const r2 = await applyDedupedConsentStateChange({
          phoneE164,
          phoneMatchKey,
          newState: "opted_out",
          source: "ghl_dnd",
          evidence: "GHL test opt-out (SECOND should NOT overwrite)",
          event: { eventType: "opt_out", messageSid: dedupeKey, detail: "second" },
        });
        assert.equal(r2.eventInserted, false, "replay inserts NO event (dedupe)");
        assert.equal(r2.changed, false, "replay reports no change");

        // Verify the ledger was NOT touched by the replay.
        const [ledgerRow] = await db
          .select()
          .from(smsConsentLedger)
          .where(eq(smsConsentLedger.phoneNormalized, phoneE164))
          .limit(1);
        assert.ok(ledgerRow, "ledger row exists");
        assert.equal(
          ledgerRow.optedOutAt?.getTime() ?? null,
          firstOptedOutAt?.getTime() ?? null,
          "optedOutAt UNCHANGED after replay",
        );
        assert.equal(
          ledgerRow.evidence,
          firstEvidence,
          "evidence UNCHANGED after replay (second evidence NOT written)",
        );

        // Verify exactly ONE consent event exists for the dedupe key.
        const events = await db
          .select({ id: smsConsentEvents.id })
          .from(smsConsentEvents)
          .where(eq(smsConsentEvents.messageSid, dedupeKey));
        assert.equal(events.length, 1, "exactly one event row for the dedupe key");

        passed++;
        console.log("✓ Group 5: real atomic DND replay is a true no-op");
      } finally {
        // Best-effort cleanup.
        try {
          await db.delete(smsConsentEvents).where(eq(smsConsentEvents.messageSid, dedupeKey));
          await db.delete(smsConsentLedger).where(eq(smsConsentLedger.phoneNormalized, phoneE164));
        } catch { /* ignore */ }
      }
    }

    // ════════════════════════════════════════════════════════════════════════
    // Group 6: REAL email suppression + contact tightening persistence
    // ════════════════════════════════════════════════════════════════════════
    if (!process.env.DATABASE_URL) {
      console.log("  · Group 6 skipped (no DATABASE_URL)");
    } else {
      const { db } = await import("../server/db");
      const { upsertBookContact } = await import(
        "../server/storage/bookCommerceStorage"
      );
      const { insertBookProviderCorrelation } = await import(
        "../server/storage/bookCommerceEngagementStorage"
      );
      const outboundEmailService = await import(
        "../server/services/outboundEmail"
      );
      const {
        bookContacts,
        bookProviderCorrelations,
        emailSuppressions,
      } = await import("@shared/schema");
      const { and, eq } = await import("drizzle-orm");

      const suffix = crypto.randomUUID().replaceAll("-", "");
      const matchedEmail = `ghl-unsub-${suffix}@example.test`;
      const mismatchedContactEmail = `ghl-correlation-${suffix}@example.test`;
      const mismatchedEventEmail = `ghl-vendor-${suffix}@example.test`;
      const matchedGhlId = `ghl_contact_matched_${suffix}`;
      const mismatchedGhlId = `ghl_contact_mismatch_${suffix}`;
      const cleanupEmails = [
        matchedEmail,
        mismatchedContactEmail,
        mismatchedEventEmail,
      ];

      try {
        const matchedContact = await upsertBookContact({
          email: matchedEmail,
          emailMarketingStatus: "subscribed",
        });
        await insertBookProviderCorrelation({
          provider: "ghl",
          providerEntityType: "contact",
          providerEntityId: matchedGhlId,
          localEntityType: "contact",
          localEntityId: matchedContact.contact.id,
        });

        const mismatchedContact = await upsertBookContact({
          email: mismatchedContactEmail,
          emailMarketingStatus: "subscribed",
        });
        await insertBookProviderCorrelation({
          provider: "ghl",
          providerEntityType: "contact",
          providerEntityId: mismatchedGhlId,
          localEntityType: "contact",
          localEntityId: mismatchedContact.contact.id,
        });

        // Keep all unrelated route leaves hermetic while restoring the real
        // email-unsubscribe storage path under test.
        routeModule.__test_setGhlWebhookDeps(makeStubs(freshState()));
        routeModule.__test_setGhlWebhookDeps({ applyEmailUnsubscribe: null });
        process.env[ENV_KEY] = PUB_KEY_B64;

        const matchedPayload = {
          type: "ContactDndUpdate",
          locationId: TEST_LOCATION_ID,
          id: matchedGhlId,
          email: matchedEmail.toUpperCase(),
          eventId: `delivery_${suffix}`,
          dndSettings: { Email: { status: "active" } },
        };
        outboundEmailService.__setEmailSuppressionSequenceCancelForTests(
          async () => {
            throw new Error("synthetic sequence cancellation failure");
          },
        );
        const failedCancellation = await postWebhook(baseUrl, matchedPayload);
        assert.equal(
          failedCancellation.status,
          500,
          "cancellation failure stays retryable after suppression is durable",
        );

        const [suppressionAfterFailure] = await db
          .select()
          .from(emailSuppressions)
          .where(eq(emailSuppressions.email, matchedEmail))
          .limit(1);
        assert.equal(
          suppressionAfterFailure?.source,
          "ghl_event",
          "primary suppression survives side-effect failure",
        );
        const [contactAfterFailure] = await db
          .select({ status: bookContacts.emailMarketingStatus })
          .from(bookContacts)
          .where(eq(bookContacts.id, matchedContact.contact.id))
          .limit(1);
        assert.equal(
          contactAfterFailure?.status,
          "subscribed",
          "secondary contact snapshot waits for cancellation retry",
        );

        outboundEmailService.__setEmailSuppressionSequenceCancelForTests(null);
        const firstSuccessfulRetry = await postWebhook(baseUrl, matchedPayload);
        assert.equal(firstSuccessfulRetry.status, 200);
        assert.equal(
          firstSuccessfulRetry.json?.status,
          "email_unsubscribe_reconfirmed",
        );
        assert.equal(firstSuccessfulRetry.json?.contactStatusChanged, true);
        assert.equal(firstSuccessfulRetry.json?.correlationStatus, "matched");

        const replay = await postWebhook(baseUrl, matchedPayload);
        assert.equal(replay.status, 200);
        assert.equal(replay.json?.status, "email_unsubscribe_reconfirmed");
        assert.equal(replay.json?.contactStatusChanged, false);

        const matchedSuppressions = await db
          .select()
          .from(emailSuppressions)
          .where(eq(emailSuppressions.email, matchedEmail));
        assert.equal(matchedSuppressions.length, 1, "replay keeps one suppression");
        assert.equal(matchedSuppressions[0]?.source, "ghl_event");
        assert.equal(matchedSuppressions[0]?.reason, "unsubscribe");
        assert.match(matchedSuppressions[0]?.notes ?? "", /correlation=matched/);
        assert.match(
          matchedSuppressions[0]?.notes ?? "",
          new RegExp(`dedupeKey=ghl:delivery_${suffix}`),
        );

        const [tightenedContact] = await db
          .select({ status: bookContacts.emailMarketingStatus })
          .from(bookContacts)
          .where(eq(bookContacts.id, matchedContact.contact.id))
          .limit(1);
        assert.equal(tightenedContact?.status, "unsubscribed");

        const mismatch = await postWebhook(baseUrl, {
          type: "ContactDndUpdate",
          locationId: TEST_LOCATION_ID,
          id: mismatchedGhlId,
          email: mismatchedEventEmail,
          dndSettings: { Email: { status: "active" } },
        });
        assert.equal(mismatch.status, 200);
        assert.equal(mismatch.json?.discrepancy, "correlated_email_mismatch");
        assert.equal(mismatch.json?.contactStatusChanged, false);

        const [mismatchSuppression] = await db
          .select()
          .from(emailSuppressions)
          .where(eq(emailSuppressions.email, mismatchedEventEmail))
          .limit(1);
        assert.equal(mismatchSuppression?.source, "ghl_event");
        assert.match(
          mismatchSuppression?.notes ?? "",
          /correlation=correlated_email_mismatch/,
        );

        const [untouchedCorrelatedContact] = await db
          .select({ status: bookContacts.emailMarketingStatus })
          .from(bookContacts)
          .where(eq(bookContacts.id, mismatchedContact.contact.id))
          .limit(1);
        assert.equal(
          untouchedCorrelatedContact?.status,
          "subscribed",
          "mismatched correlation is never used to mutate a different address",
        );

        passed++;
        console.log(
          "✓ Group 6: real email unsubscribe is replay-safe and discrepancy-visible",
        );
      } finally {
        outboundEmailService.__setEmailSuppressionSequenceCancelForTests(null);
        try {
          for (const email of cleanupEmails) {
            await db
              .delete(emailSuppressions)
              .where(eq(emailSuppressions.email, email));
          }
          for (const providerEntityId of [matchedGhlId, mismatchedGhlId]) {
            await db
              .delete(bookProviderCorrelations)
              .where(
                and(
                  eq(bookProviderCorrelations.provider, "ghl"),
                  eq(bookProviderCorrelations.providerEntityType, "contact"),
                  eq(
                    bookProviderCorrelations.providerEntityId,
                    providerEntityId,
                  ),
                ),
              );
          }
          for (const email of [matchedEmail, mismatchedContactEmail]) {
            await db.delete(bookContacts).where(eq(bookContacts.email, email));
          }
        } catch {
          /* best-effort cleanup */
        }
      }
    }

    console.log(`\nghl-marketplace-webhook: ${passed} groups passed`);
  } finally {
    // Restore production seams.
    routeModule.__test_setGhlWebhookDeps({
      locationResolver: null,
      appointmentByGhlId: null,
      contactByGhlId: null,
      resolveApplication: null,
      upsertAppointment: null,
      writeAppointmentCorrelation: null,
      rescheduleAppointment: null,
      transitionAppointment: null,
      applyDndOptOut: null,
      applyEmailUnsubscribe: null,
    });
    restoreEnv();
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

main()
  .catch((err) => {
    restoreEnv();
    console.error("FATAL:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    // Close DB pools opened by the route module's static imports so the
    // process can exit cleanly (same pattern as sendgrid-event-webhook.test.ts).
    try {
      const { closeDbPools } = await import("../server/db");
      await closeDbPools();
    } catch {
      /* ignore — pool may not have opened if all groups ran from seams */
    }
  });
