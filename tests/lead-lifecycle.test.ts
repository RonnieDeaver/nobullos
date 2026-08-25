/* test-registration
{
  "name": "Lead intake & lifecycle stages (Task #4330)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4330: lifecycle foundation for lead intake — the central prospect gate on client enumeration (a drift leaks lead records into reports/churn/service-desk surfaces built for paying clients), the match-or-create identity path both intake sources share (a drift mints duplicate accounts or cross-links strangers to customer records), forward-only automatic advancement with its same-transaction audit trail (deal-created ⇒ opportunity, deal-won ⇒ customer; a backwards auto-move silently corrupts every funnel metric built on it), the settings-gated booking auto-deal with its open-deal dedupe, and the AM+/sales access split on the Leads routes. Later CRM tasks (scoring, sequences, attribution) all hang off these semantics.",
  "tier": "small"
}
test-registration */
/**
 * Task #4330 — Lead intake & lifecycle coverage.
 *
 * Runs the REAL registerLeadsRoutes + registerWebsiteRoutes against a real
 * Express app with an injected passport-shaped session (switchable acting
 * user, following tests/deals-routes.test.ts) and the real db (hermetic
 * per-run DB under `npm test`).
 *
 *   1. Storage gate — getClients/getActiveClients exclude prospects;
 *      getClientsIncludingProspects includes them.
 *   2. Website inquiry (real POST) — creates a lead: stage 'lead', source
 *      stamped, NO client code, contact row (email+normalized phone),
 *      creation history row, inquiry row linked.
 *   3. Repeat inquiry — matches (no duplicate), bumps last activity.
 *   4. Customer-email inquiry — links the inquiry, never touches the
 *      customer's stage (no history row).
 *   5. Booking hook — anonymous confirmed meeting creates a
 *      'session_booked' lead and links meeting.client_id; existing lead
 *      advances lead → session_booked; auto-deal stays OFF by default.
 *   6. Auto-deal ON — creates ONE deal in the default pipeline at the
 *      configured stage; deal-created hook advances to 'opportunity';
 *      rebooking dedupes (no second deal).
 *   7. Deal hooks — createDeal on a lead ⇒ opportunity; move to closed-won
 *      ⇒ customer (audited); the record leaves the default Leads list.
 *   8. Forward-only — auto-advance backwards is a no-op without history;
 *      manual correction moves backwards WITH actor + history.
 *   9. Routes — 401 unauth; AM sees prospects w/ stage+source filters and
 *      open-deal annotation; sales scoped to owned leads; lifecycle POST is
 *      AM+ (sales 403, bad stage 400).
 *  10. Write boundary — insert/update schemas strip lifecycle columns; a
 *      smuggled lifecycleStage through updateClient cannot move the stage.
 *  11. Merge (Task #4424) — POST /api/leads/:id/merge relinks inquiries,
 *      meetings, deals, contacts, history, sequence enrollments (colliding
 *      same-sequence active duplicates are cancelled, contact-entity rows
 *      keep their entity), and booking tokens to the winner in one tx,
 *      keeps the furthest-forward stage + earliest created_at, writes a
 *      manual audit entry, deletes the loser; merging into a customer
 *      cancels arriving active enrollments post-commit; sales 403;
 *      customer-loser and self-merge 400.
 *  12. Merge-target search (Task #4584) — GET /api/leads/merge-candidates
 *      is AM+ (401/403), bounds the query (short q 400, ≤20 rows), finds a
 *      CUSTOMER by email (the beyond-the-current-page case the UI picker
 *      needs), and honors exclude=.
 *
 * All fixtures are RUN-suffixed and removed in finally; list assertions
 * filter to RUN-prefixed rows, never totals (shared-DB hygiene). The
 * seeded 'sales' pipeline is left in place — it IS the lazy-ensure global.
 * The auto-deal setting is pinned via setSystemSetting (actor "test") and
 * restored in finally.
 */

import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import { randomBytes } from "node:crypto";
import { eq, like, sql, inArray } from "drizzle-orm";

import { db } from "../server/db";
import { registerLeadsRoutes } from "../server/routes/leads";
import { registerWebsiteRoutes } from "../server/routes/website";
import {
  bookingClientTokens,
  bookingPages,
  clientContacts,
  clientLifecycleHistory,
  clients,
  deals,
  emailSequenceEnrollments,
  emailSequences,
  insertClientSchema,
  scheduledMeetings,
  systemSettings,
  updateClientSchema,
  websiteInquiries,
} from "@shared/schema";
import { storage } from "../server/storage";
import {
  advanceClientLifecycle,
  getProspectClients,
  matchOrCreateLeadClient,
  setClientLifecycleManual,
} from "../server/storage/leadLifecycleStorage";
import { handleBookingConfirmedForLifecycle, LEADS_BOOKING_AUTO_DEAL_ENABLED_KEY } from "../server/services/leadIntake";
import { createDeal, ensureDefaultDealPipelineSeeded, getDefaultPipeline, listPipelinesWithStages, moveDealStage } from "../server/storage/dealsStorage";
import { setSystemSetting, deleteSystemSetting, getSystemSetting } from "../server/storage/settingsStorage";

const HEX = randomBytes(4).toString("hex");
const RUN = `t4330-${HEX}`;

const AM_ID = `${RUN}-am`;       // account_manager → sees all leads
const SALES_ID = `${RUN}-sales`; // sales → scoped to owned leads

const CUSTOMER_ID = `${RUN}-customer`;
const CUSTOMER_EMAIL = `${RUN}-customer@example.test`;

// Distinct intake identities (all RUN-scoped).
const INQ_EMAIL = `${RUN}-lead1@example.test`;
const BOOK_EMAIL = `${RUN}-book1@example.test`;
const AUTO_EMAIL = `${RUN}-auto1@example.test`;
const DEALHOOK_EMAIL = `${RUN}-dealhook@example.test`;

function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

// ── Harness ─────────────────────────────────────────────────────────────────

let actingUserId: string | null = AM_ID;

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Clerk test seam (server/middlewares/requireAuth.ts): a string
    // authenticates as that user id; null is explicit-unauthenticated.
    // (The pre-Clerk passport-shape injection stopped working when auth
    // migrated — requireAuth ignores req.user/req.isAuthenticated.)
    (req as any).__test_clerkUserId = actingUserId;
    next();
  });
  registerLeadsRoutes(app);
  registerWebsiteRoutes(app, {
    verifyRecaptcha: async () => ({ ok: true }),
    kickContactSlackRelay: async () => ({
      status: "delivered",
      reason: null,
    }),
  });
  return app;
}

async function listen(app: express.Express): Promise<{ server: Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

let baseUrl = "";

async function api(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

// ── Fixtures ────────────────────────────────────────────────────────────────

async function seed(): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, email, first_name, last_name, role, authority_level)
    VALUES
      (${AM_ID}, ${`${AM_ID}@t4330.example`}, 'Task4330', 'Manager', 'account_manager', 'core'),
      (${SALES_ID}, ${`${SALES_ID}@t4330.example`}, 'Task4330', 'Seller', 'sales', 'core')
  `);
  // Existing paying client (column default backfills lifecycle 'customer').
  await db.execute(sql`
    INSERT INTO clients (id, firm_name, contact_email, owner_id, is_archived, is_demo)
    VALUES (${CUSTOMER_ID}, ${`${RUN} Customer Firm`}, ${CUSTOMER_EMAIL}, ${AM_ID}, false, false)
  `);
}

// Stagger slots — scheduled_meetings has a host no-overlap exclusion
// constraint, so every fixture meeting gets its own hour.
let meetingSlot = 0;

async function insertConfirmedMeeting(input: {
  inviteeEmail: string;
  inviteeName?: string;
  clientId?: string | null;
  meetingTypeName?: string;
}): Promise<any> {
  meetingSlot += 2;
  const rows = await db
    .insert(scheduledMeetings)
    .values({
      clientId: input.clientId ?? null,
      accountManagerUserId: AM_ID,
      meetingTypeName: input.meetingTypeName ?? `${RUN} Strategy Session`,
      bookingSource: "public",
      inviteeName: input.inviteeName ?? `${RUN} Invitee`,
      inviteeEmail: input.inviteeEmail,
      startTimeUtc: new Date(Date.now() + (24 + meetingSlot) * 3600 * 1000),
      endTimeUtc: new Date(Date.now() + (25 + meetingSlot) * 3600 * 1000),
      timezone: "America/New_York",
      status: "confirmed",
    })
    .returning();
  return rows[0];
}

async function cleanup(): Promise<void> {
  // Sequences cascade enrollments; booking pages cascade tokens.
  await db.delete(emailSequences).where(like(emailSequences.name, `${RUN}%`));
  await db.delete(bookingPages).where(like(bookingPages.slug, `${RUN}%`));
  // Deals cascade contacts + stage history on delete.
  await db.delete(deals).where(like(deals.name, `%${RUN}%`));
  await db.delete(scheduledMeetings).where(like(scheduledMeetings.inviteeEmail, `${RUN}%`));
  await db.delete(websiteInquiries).where(like(websiteInquiries.email, `${RUN}%`));
  // Clients cascade client_contacts + client_lifecycle_history.
  await db.delete(clients).where(like(clients.firmName, `%${RUN}%`));
  // Any lead minted from a RUN email whose derived firm name lacks the RUN
  // prefix pattern (defensive — display names are the email local part,
  // which IS RUN-prefixed, but keep the sweep exhaustive).
  await db.delete(clients).where(like(clients.contactEmail, `${RUN}%`));
  await db.execute(sql`DELETE FROM users WHERE id LIKE ${`${RUN}%`}`);
}

async function getClientByEmail(email: string): Promise<any | null> {
  const rows = await db.select().from(clients).where(eq(clients.contactEmail, email));
  return rows[0] ?? null;
}

async function historyFor(clientId: string): Promise<any[]> {
  return db
    .select()
    .from(clientLifecycleHistory)
    .where(eq(clientLifecycleHistory.clientId, clientId))
    .orderBy(clientLifecycleHistory.createdAt);
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  let failures = 0;
  async function step(name: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
      console.log(`ok - ${name}`);
    } catch (err: any) {
      failures += 1;
      console.error(`FAIL - ${name}`);
      console.error(`  ${err?.message ?? err}`);
      if (err?.cause) console.error(`  cause: ${err.cause?.message ?? err.cause}`);
    }
  }

  // Pin the auto-deal setting OFF for the default-path steps; restore after.
  const priorAutoDeal = await getSystemSetting(LEADS_BOOKING_AUTO_DEAL_ENABLED_KEY);

  await seed();
  const app = buildApp();
  const started = await listen(app);
  const server = started.server;
  baseUrl = started.baseUrl;

  let inqLeadId = "";     // lead minted by the website inquiry
  let bookLeadId = "";    // lead minted by the anonymous booking
  let autoLeadId = "";    // lead minted by the auto-deal booking
  let dealHookLeadId = ""; // lead used for direct deal-hook steps

  try {
    await step("storage gate: prospect rows invisible to customer enumerations", async () => {
      const minted = await matchOrCreateLeadClient({
        email: `${RUN}-gate@example.test`,
        name: `${RUN} Gate Probe`,
        initialStage: "lead",
        leadSource: "manual",
        changeSource: "manual",
      });
      assert(minted?.created, "gate probe lead minted");
      const gateId = minted!.client.id;

      const all = await storage.getClients();
      assert(!all.some((c) => c.id === gateId), "getClients must exclude prospects");
      assert(all.some((c) => c.id === CUSTOMER_ID), "getClients must include customers");

      const active = await storage.getActiveClients();
      assert(!active.some((c) => c.id === gateId), "getActiveClients must exclude prospects");

      const inclusive = await storage.getClientsIncludingProspects();
      assert(inclusive.some((c) => c.id === gateId), "getClientsIncludingProspects must include prospects");

      const single = await storage.getClient(gateId);
      assert(single && single.id === gateId, "getClient(id) stays ungated for by-id resolution");

      // Owner-scoped enumerations gate too.
      const byOwner = await storage.getClientsByOwner(AM_ID);
      assert(!byOwner.some((c) => c.id === gateId), "getClientsByOwner must exclude prospects");
    });

    await step("website inquiry POST mints a lead (source, contact, history, link)", async () => {
      const res = await api("POST", "/api/website/inquiry", {
        kind: "contact",
        fullName: `${RUN} Web Lead`,
        email: INQ_EMAIL,
        phone: "(704) 555-0142",
        message: "Need help with intake marketing.",
        page: "/services",
      });
      assertEq(res.status, 200, "inquiry POST status");

      const lead = await getClientByEmail(INQ_EMAIL);
      assert(lead, "lead client row exists");
      inqLeadId = lead.id;
      assertEq(lead.lifecycleStage, "lead", "lifecycle stage");
      assertEq(lead.leadSource, "website_inquiry", "lead source stamped");
      assertEq(lead.clientCode, null, "lead must NOT consume an NB-XXXX client code");
      assertEq(lead.firmName, `${RUN} Web Lead`, "firm name from full name");
      assert(lead.leadLastActivityAt, "last activity stamped");

      const contacts = await db.select().from(clientContacts).where(eq(clientContacts.clientId, lead.id));
      assertEq(contacts.length, 1, "one contact row minted");
      assert((contacts[0].emails as string[]).includes(INQ_EMAIL), "contact email recorded");
      assert(
        (contacts[0].phonesNormalized as string[]).includes("+17045550142"),
        `contact phone normalized for Twilio matching, got ${JSON.stringify(contacts[0].phonesNormalized)}`,
      );

      const hist = await historyFor(lead.id);
      assertEq(hist.length, 1, "exactly one creation history row");
      assertEq(hist[0].fromStage, null, "creation entry fromStage null");
      assertEq(hist[0].toStage, "lead", "creation entry toStage");
      assertEq(hist[0].source, "website_inquiry", "creation entry source");
      assertEq(hist[0].changedByUserId, null, "system-initiated (no actor)");

      const inqs = await db.select().from(websiteInquiries).where(eq(websiteInquiries.email, INQ_EMAIL));
      assertEq(inqs.length, 1, "one inquiry row");
      assertEq(inqs[0].leadClientId, lead.id, "inquiry linked to the lead");
    });

    await step("repeat inquiry matches — no duplicate, activity bumped", async () => {
      const before = await getClientByEmail(INQ_EMAIL);
      const beforeActivity = new Date(before.leadLastActivityAt).getTime();
      await new Promise((r) => setTimeout(r, 25));

      const res = await api("POST", "/api/website/inquiry", {
        kind: "contact",
        fullName: `${RUN} Web Lead Again`,
        email: INQ_EMAIL.toUpperCase(), // case-insensitive match
        phone: "(704) 555-0142",
        message: "Following up!",
      });
      assertEq(res.status, 200, "second inquiry POST status");

      const leadRows = await db.select().from(clients).where(sql`lower(${clients.contactEmail}) = ${INQ_EMAIL}`);
      assertEq(leadRows.length, 1, "still exactly one client row for the email");
      const after = leadRows[0];
      assertEq(after.lifecycleStage, "lead", "stage unchanged (advance to same rank is a no-op)");
      assert(
        new Date(after.leadLastActivityAt as any).getTime() > beforeActivity,
        "last activity bumped by the repeat inquiry",
      );
      const hist = await historyFor(after.id);
      assertEq(hist.length, 1, "no-op advance writes NO history");

      const inqs = await db.select().from(websiteInquiries).where(sql`lower(${websiteInquiries.email}) = ${INQ_EMAIL}`);
      assertEq(inqs.length, 2, "both inquiry rows stored");
      assert(inqs.every((i) => i.leadClientId === after.id), "both inquiries linked to the same lead");
    });

    await step("customer-email inquiry links without touching the customer", async () => {
      const res = await api("POST", "/api/website/inquiry", {
        kind: "contact",
        fullName: `${RUN} Existing Customer`,
        email: CUSTOMER_EMAIL,
        phone: "(704) 555-0000",
        message: "I am already a client.",
      });
      assertEq(res.status, 200, "customer inquiry POST status");

      const customer = await storage.getClient(CUSTOMER_ID);
      assertEq(customer!.lifecycleStage, "customer", "customer stage untouched");
      assertEq(customer!.leadSource, null, "customer leadSource stays null");
      const hist = await historyFor(CUSTOMER_ID);
      assertEq(hist.length, 0, "no history rows on the customer");

      const inqs = await db.select().from(websiteInquiries).where(eq(websiteInquiries.email, CUSTOMER_EMAIL));
      assertEq(inqs.length, 1, "customer inquiry stored");
      assertEq(inqs[0].leadClientId, CUSTOMER_ID, "inquiry linked to the existing customer");

      const customersOnly = await db.select().from(clients).where(eq(clients.contactEmail, CUSTOMER_EMAIL));
      assertEq(customersOnly.length, 1, "no duplicate record minted for the customer email");
    });

    await step("booking hook: anonymous confirm mints session_booked lead + links meeting", async () => {
      const meeting = await insertConfirmedMeeting({ inviteeEmail: BOOK_EMAIL, inviteeName: `${RUN} Booker` });
      const outcome = await handleBookingConfirmedForLifecycle(meeting);
      assert(outcome.clientId, "outcome carries the lead id");
      bookLeadId = outcome.clientId!;
      assertEq(outcome.createdLead, true, "lead was created");
      assertEq(outcome.linkedMeeting, true, "meeting linked to the lead");
      assertEq(outcome.autoDealId, null, "auto-deal stays OFF by default");

      const lead = await storage.getClient(bookLeadId);
      assertEq(lead!.lifecycleStage, "session_booked", "created directly at session_booked");
      assertEq(lead!.leadSource, "booking", "source stamped");
      const meetingRow = (await db.select().from(scheduledMeetings).where(eq(scheduledMeetings.id, meeting.id)))[0];
      assertEq(meetingRow.clientId, bookLeadId, "meeting.client_id stamped");

      const dealsRows = await db.select().from(deals).where(eq(deals.clientId, bookLeadId));
      assertEq(dealsRows.length, 0, "no deal created while the setting is off");
    });

    await step("booking hook: existing lead advances lead → session_booked (audited)", async () => {
      const meeting = await insertConfirmedMeeting({ inviteeEmail: INQ_EMAIL });
      const outcome = await handleBookingConfirmedForLifecycle(meeting);
      assertEq(outcome.clientId, inqLeadId, "matched the inquiry lead by email");
      assertEq(outcome.createdLead, false, "no duplicate lead");

      const lead = await storage.getClient(inqLeadId);
      assertEq(lead!.lifecycleStage, "session_booked", "advanced to session_booked");
      const hist = await historyFor(inqLeadId);
      assertEq(hist.length, 2, "advance wrote a history row");
      const last = hist[hist.length - 1];
      assertEq(last.fromStage, "lead", "history fromStage");
      assertEq(last.toStage, "session_booked", "history toStage");
      assertEq(last.source, "booking", "history source");
    });

    await step("auto-deal ON: one deal at the configured stage, lifecycle → opportunity, rebooking dedupes", async () => {
      await setSystemSetting(LEADS_BOOKING_AUTO_DEAL_ENABLED_KEY, "true", "test");
      try {
        const meeting = await insertConfirmedMeeting({ inviteeEmail: AUTO_EMAIL, inviteeName: `${RUN} Auto` });
        const outcome = await handleBookingConfirmedForLifecycle(meeting);
        assert(outcome.clientId, "auto lead minted");
        autoLeadId = outcome.clientId!;
        assert(outcome.autoDealId, "auto-deal created");

        const pipeline = await getDefaultPipeline();
        assert(pipeline, "default pipeline exists");
        const pipelines = await listPipelinesWithStages();
        const stages = pipelines.find((p) => p.id === pipeline!.id)!.stages;
        const discovery = stages.find((s) => s.slug === "discovery-call");
        assert(discovery, "discovery-call stage exists in default pipeline");

        const dealRows = await db.select().from(deals).where(eq(deals.clientId, autoLeadId));
        assertEq(dealRows.length, 1, "exactly one auto-deal");
        assertEq(dealRows[0].stageId, discovery!.id, "auto-deal in configured stage (discovery-call)");
        assertEq(dealRows[0].ownerId, AM_ID, "auto-deal owned by the host AM");
        assertEq(dealRows[0].createdBy, AM_ID, "auto-deal created-by the host AM");

        // Deal-created storage hook advanced the lifecycle.
        const lead = await storage.getClient(autoLeadId);
        assertEq(lead!.lifecycleStage, "opportunity", "deal-created hook advanced to opportunity");
        const hist = await historyFor(autoLeadId);
        const lastEntry = hist[hist.length - 1];
        assertEq(lastEntry.toStage, "opportunity", "opportunity history entry");
        assertEq(lastEntry.source, "deal_created", "opportunity entry source");

        // Rebooking: no second deal.
        const meeting2 = await insertConfirmedMeeting({ inviteeEmail: AUTO_EMAIL });
        const outcome2 = await handleBookingConfirmedForLifecycle(meeting2);
        assertEq(outcome2.autoDealId, null, "rebooking dedupes on the open deal");
        const dealRows2 = await db.select().from(deals).where(eq(deals.clientId, autoLeadId));
        assertEq(dealRows2.length, 1, "still exactly one deal");
      } finally {
        if (priorAutoDeal?.value !== undefined && priorAutoDeal !== undefined) {
          await setSystemSetting(LEADS_BOOKING_AUTO_DEAL_ENABLED_KEY, priorAutoDeal.value, "test");
        } else {
          await deleteSystemSetting(LEADS_BOOKING_AUTO_DEAL_ENABLED_KEY);
        }
      }
    });

    await step("deal hooks: createDeal ⇒ opportunity; won move ⇒ customer; leaves Leads list", async () => {
      const minted = await matchOrCreateLeadClient({
        email: DEALHOOK_EMAIL,
        name: `${RUN} DealHook`,
        initialStage: "lead",
        leadSource: "manual",
        changeSource: "manual",
      });
      dealHookLeadId = minted!.client.id;

      await ensureDefaultDealPipelineSeeded();
      const pipeline = (await getDefaultPipeline())!;
      const stages = (await listPipelinesWithStages()).find((p) => p.id === pipeline.id)!.stages;
      const firstOpen = stages.find((s) => s.stageType === "open")!;
      const won = stages.find((s) => s.stageType === "won")!;

      const deal = await createDeal({
        name: `${RUN} hook deal`,
        pipelineId: pipeline.id,
        stageId: firstOpen.id,
        clientId: dealHookLeadId,
        contactIds: [],
        amount: 1000,
        expectedCloseDate: null,
        ownerId: AM_ID,
        notes: null,
        createdBy: AM_ID,
      });
      let lead = await storage.getClient(dealHookLeadId);
      assertEq(lead!.lifecycleStage, "opportunity", "createDeal advanced lead → opportunity");

      await moveDealStage(deal.id, { toStageId: won.id, movedByUserId: AM_ID });
      lead = await storage.getClient(dealHookLeadId);
      assertEq(lead!.lifecycleStage, "customer", "won move advanced → customer");
      const hist = await historyFor(dealHookLeadId);
      const lastEntry = hist[hist.length - 1];
      assertEq(lastEntry.source, "deal_won", "customer entry source deal_won");
      assertEq(lastEntry.changedByUserId, AM_ID, "won-move actor recorded");

      // Now a customer: gone from the default prospect list, visible to
      // customer enumerations.
      const prospects = await getProspectClients({ limit: 200 });
      assert(!prospects.data.some((r) => r.id === dealHookLeadId), "converted record left the Leads list");
      const all = await storage.getClients();
      assert(all.some((c) => c.id === dealHookLeadId), "converted record now in getClients");
    });

    await step("forward-only: auto backwards is a silent no-op; manual backwards is audited", async () => {
      const before = await storage.getClient(autoLeadId);
      assertEq(before!.lifecycleStage, "opportunity", "precondition: opportunity");
      const histBefore = (await historyFor(autoLeadId)).length;

      const noop = await advanceClientLifecycle(autoLeadId, "lead", { source: "booking" });
      assertEq(noop.changed, false, "auto-advance backwards must not move");
      const after = await storage.getClient(autoLeadId);
      assertEq(after!.lifecycleStage, "opportunity", "stage unchanged");
      assertEq((await historyFor(autoLeadId)).length, histBefore, "no-op writes no history");

      const manual = await setClientLifecycleManual(autoLeadId, "session_booked", AM_ID, "misqualified");
      assertEq(manual.changed, true, "manual correction moves backwards");
      const corrected = await storage.getClient(autoLeadId);
      assertEq(corrected!.lifecycleStage, "session_booked", "manual backwards applied");
      const hist = await historyFor(autoLeadId);
      const last = hist[hist.length - 1];
      assertEq(last.source, "manual", "manual entry source");
      assertEq(last.changedByUserId, AM_ID, "manual entry actor");
      assertEq(last.reason, "misqualified", "manual entry reason");
    });

    await step("routes: auth, filters, open-deal annotation, sales scoping", async () => {
      actingUserId = null;
      assertEq((await api("GET", "/api/leads")).status, 401, "unauthenticated 401");

      actingUserId = AM_ID;
      const list = await api("GET", "/api/leads?limit=200");
      assertEq(list.status, 200, "AM list 200");
      const runRows = (list.json.data as any[]).filter((r) => String(r.contactEmail ?? "").startsWith(RUN));
      assert(runRows.some((r) => r.id === inqLeadId), "inquiry lead listed");
      assert(runRows.some((r) => r.id === bookLeadId), "booking lead listed");
      assert(!runRows.some((r) => r.id === dealHookLeadId), "customer NOT in default list");

      const autoRow = runRows.find((r) => r.id === autoLeadId);
      assert(autoRow, "auto lead listed");
      assert(autoRow.openDealId, "open-deal annotation present");

      const staged = await api("GET", "/api/leads?stage=session_booked&limit=200");
      const stagedRun = (staged.json.data as any[]).filter((r) => String(r.contactEmail ?? "").startsWith(RUN));
      assert(stagedRun.every((r) => r.lifecycleStage === "session_booked"), "stage filter applied");
      assert(stagedRun.some((r) => r.id === inqLeadId), "session_booked filter finds the advanced lead");

      const sourced = await api("GET", "/api/leads?source=website_inquiry&limit=200");
      const sourcedRun = (sourced.json.data as any[]).filter((r) => String(r.contactEmail ?? "").startsWith(RUN));
      assert(sourcedRun.every((r) => r.leadSource === "website_inquiry"), "source filter applied");

      const customers = await api("GET", "/api/leads?stage=customer&limit=200");
      const customersRun = (customers.json.data as any[]).filter((r) => String(r.contactEmail ?? "").startsWith(RUN));
      assert(customersRun.some((r) => r.id === dealHookLeadId), "explicit customer filter shows converted record");

      // Sales scoping: unowned leads invisible; owned lead visible.
      actingUserId = SALES_ID;
      const salesList = await api("GET", "/api/leads?limit=200");
      assertEq(salesList.status, 200, "sales list 200");
      const salesRun = (salesList.json.data as any[]).filter((r) => String(r.contactEmail ?? "").startsWith(RUN));
      assertEq(salesRun.length, 0, "sales sees no unowned leads");

      await db.update(clients).set({ ownerId: SALES_ID }).where(eq(clients.id, bookLeadId));
      const salesList2 = await api("GET", "/api/leads?limit=200");
      const salesRun2 = (salesList2.json.data as any[]).filter((r) => String(r.contactEmail ?? "").startsWith(RUN));
      assertEq(salesRun2.length, 1, "sales sees exactly the owned lead");
      assertEq(salesRun2[0].id, bookLeadId, "owned lead id");

      actingUserId = AM_ID;
    });

    await step("routes: detail payload + manual lifecycle endpoint gating", async () => {
      const detail = await api("GET", `/api/leads/${inqLeadId}`);
      assertEq(detail.status, 200, "detail 200");
      assertEq(detail.json.client.id, inqLeadId, "detail client");
      assert(detail.json.history.length >= 2, "detail history present");
      assert(detail.json.inquiries.length >= 2, "detail inquiries linked");
      assert(detail.json.meetings.length >= 1, "detail meetings linked");
      assert(Array.isArray(detail.json.deals), "detail deals array");

      // Sales (below AM) cannot correct lifecycle.
      actingUserId = SALES_ID;
      const salesSet = await api("POST", `/api/leads/${inqLeadId}/lifecycle`, { stage: "lead" });
      assertEq(salesSet.status, 403, "sales lifecycle POST 403");

      actingUserId = AM_ID;
      const badStage = await api("POST", `/api/leads/${inqLeadId}/lifecycle`, { stage: "vip" });
      assertEq(badStage.status, 400, "invalid stage 400");

      const set = await api("POST", `/api/leads/${inqLeadId}/lifecycle`, { stage: "lead", reason: "requalifying" });
      assertEq(set.status, 200, "AM lifecycle POST 200");
      assertEq(set.json.changed, true, "changed");
      const lead = await storage.getClient(inqLeadId);
      assertEq(lead!.lifecycleStage, "lead", "manual endpoint moved the stage backwards");
      const hist = await historyFor(inqLeadId);
      const last = hist[hist.length - 1];
      assertEq(last.changedByUserId, AM_ID, "endpoint actor audited");
      assertEq(last.reason, "requalifying", "endpoint reason audited");
    });

    await step("merge (Task #4424): relinks children, keeps stage/created_at, audits, deletes loser", async () => {
      // Two duplicate identities of the same person.
      const winnerEmail = `${RUN}-merge-win@example.test`;
      const loserEmail = `${RUN}-merge-lose@example.test`;
      const winner = (await matchOrCreateLeadClient({
        email: winnerEmail,
        name: `${RUN} Merge Winner`,
        initialStage: "lead",
        leadSource: "manual",
        changeSource: "manual",
      }))!.client;
      const loser = (await matchOrCreateLeadClient({
        email: loserEmail,
        name: `${RUN} Merge Loser`,
        initialStage: "lead",
        leadSource: "manual",
        changeSource: "manual",
      }))!.client;

      // Loser accumulates history + children: advance to session_booked
      // (history row), an inquiry, a meeting, and an earlier created_at.
      await advanceClientLifecycle(loser.id, "session_booked", { source: "booking" });
      await db.execute(sql`UPDATE clients SET created_at = created_at - interval '30 days' WHERE id = ${loser.id}`);
      const inqRes = await api("POST", "/api/website/inquiry", {
        kind: "contact",
        fullName: `${RUN} Merge Loser`,
        email: loserEmail,
        phone: "(704) 555-0199",
        message: "second address inquiry",
        page: "/services",
      });
      assertEq(inqRes.status, 200, "loser inquiry POST");
      const meeting = await insertConfirmedMeeting({ inviteeEmail: loserEmail, clientId: loser.id });

      // Sequence enrollments + booking tokens: both leads active in seqA
      // (collision against the partial unique index), the loser alone in
      // seqB (clean relink), plus a contact-entity enrollment and a booking
      // token belonging to the loser.
      const [seqA] = await db.insert(emailSequences).values({ name: `${RUN} Seq A`, createdBy: AM_ID }).returning();
      const [seqB] = await db.insert(emailSequences).values({ name: `${RUN} Seq B`, createdBy: AM_ID }).returning();
      const enroll = (entityType: "client" | "contact", entityId: string, clientId: string, sequenceId: string) =>
        db.insert(emailSequenceEnrollments).values({
          sequenceId, entityType, entityId, clientId,
          recipientEmail: loserEmail, senderUserId: AM_ID, status: "active",
        }).returning();
      await enroll("client", winner.id, winner.id, seqA.id);
      const [collidingEnr] = await enroll("client", loser.id, loser.id, seqA.id);
      const [cleanEnr] = await enroll("client", loser.id, loser.id, seqB.id);
      const [loserContact] = await db.select().from(clientContacts).where(eq(clientContacts.clientId, loser.id));
      assert(!!loserContact, "loser has a contact row");
      const [contactEnr] = await enroll("contact", loserContact.id, loser.id, seqB.id);
      const [page] = await db.insert(bookingPages).values({ accountManagerUserId: AM_ID, slug: `${RUN}-merge-page` }).returning();
      const [token] = await db.insert(bookingClientTokens).values({
        tokenHash: `${RUN}-merge-token-hash`, clientId: loser.id, accountManagerUserId: AM_ID,
        bookingPageId: page.id, expiresAt: new Date(Date.now() + 86400000),
      }).returning();

      const loserRow = (await db.select().from(clients).where(eq(clients.id, loser.id)))[0];
      const loserHistCount = (await historyFor(loser.id)).length;
      assert(loserHistCount >= 2, "loser has history to move");

      // Gating: sales cannot merge; self-merge and bad body are 400.
      actingUserId = SALES_ID;
      assertEq(
        (await api("POST", `/api/leads/${loser.id}/merge`, { targetClientId: winner.id })).status,
        403,
        "sales merge 403",
      );
      actingUserId = AM_ID;
      assertEq(
        (await api("POST", `/api/leads/${loser.id}/merge`, { targetClientId: loser.id })).status,
        400,
        "self-merge 400",
      );
      assertEq(
        (await api("POST", `/api/leads/${loser.id}/merge`, {})).status,
        400,
        "missing target 400",
      );
      // A customer record can never be merged away.
      assertEq(
        (await api("POST", `/api/leads/${CUSTOMER_ID}/merge`, { targetClientId: winner.id })).status,
        400,
        "customer loser 400",
      );

      const res = await api("POST", `/api/leads/${loser.id}/merge`, {
        targetClientId: winner.id,
        reason: "same person, work vs personal email",
      });
      assertEq(res.status, 200, "merge 200");
      assertEq(res.json.merged, true, "merged flag");
      assert(res.json.moved.inquiries >= 1, "moved inquiry count");
      assert(res.json.moved.meetings >= 1, "moved meeting count");
      assert(res.json.moved.contacts >= 1, "moved contact count");
      assertEq(res.json.moved.historyEntries, loserHistCount, "moved all history entries");
      assertEq(res.json.moved.sequenceEnrollments, 3, "moved enrollment count (incl. cancelled duplicate + contact-entity)");
      assertEq(res.json.moved.bookingTokens, 1, "moved booking token count");

      // Loser gone everywhere.
      assertEq(await storage.getClient(loser.id), undefined as any, "loser row deleted");
      const strayContacts = await db.select().from(clientContacts).where(eq(clientContacts.clientId, loser.id));
      assertEq(strayContacts.length, 0, "no contacts left on the loser id");
      const strayInqs = await db.select().from(websiteInquiries).where(eq(websiteInquiries.leadClientId, loser.id));
      assertEq(strayInqs.length, 0, "no inquiries left on the loser id");
      const meetingRow = (await db.select().from(scheduledMeetings).where(eq(scheduledMeetings.id, meeting.id)))[0];
      assertEq(meetingRow.clientId, winner.id, "meeting relinked to the winner");

      // Enrollment collision semantics + relinks.
      const [collided] = await db.select().from(emailSequenceEnrollments).where(eq(emailSequenceEnrollments.id, collidingEnr.id));
      assertEq(collided.status, "cancelled", "colliding same-sequence enrollment cancelled, not crashed");
      assertEq(collided.cancelReason, "manual", "collision cancel reason manual");
      assert(String(collided.cancelNote).includes(loser.id), "collision cancel note names the merge");
      assertEq(collided.clientId, winner.id, "cancelled duplicate still relinked for history");
      const [cleanMoved] = await db.select().from(emailSequenceEnrollments).where(eq(emailSequenceEnrollments.id, cleanEnr.id));
      assertEq(cleanMoved.status, "active", "non-colliding enrollment stays active");
      assertEq(cleanMoved.clientId, winner.id, "non-colliding enrollment clientId relinked");
      assertEq(cleanMoved.entityId, winner.id, "client-entity enrollment entityId relinked");
      const [contactMoved] = await db.select().from(emailSequenceEnrollments).where(eq(emailSequenceEnrollments.id, contactEnr.id));
      assertEq(contactMoved.clientId, winner.id, "contact-entity enrollment clientId relinked");
      assertEq(contactMoved.entityId, loserContact.id, "contact-entity enrollment keeps its contact entity");
      assertEq(contactMoved.status, "active", "contact-entity enrollment stays active");
      const [tokenMoved] = await db.select().from(bookingClientTokens).where(eq(bookingClientTokens.id, token.id));
      assertEq(tokenMoved.clientId, winner.id, "booking token relinked to the winner");

      // Winner: furthest-forward stage, earliest created_at, merged history
      // + the manual merge audit entry naming the actor.
      const survivor = (await db.select().from(clients).where(eq(clients.id, winner.id)))[0];
      assertEq(survivor.lifecycleStage, "session_booked", "winner kept the furthest-forward stage");
      assertEq(
        new Date(survivor.createdAt as any).getTime(),
        new Date(loserRow.createdAt as any).getTime(),
        "winner kept the earliest created_at",
      );
      const hist = await historyFor(winner.id);
      const mergeEntry = hist[hist.length - 1];
      assertEq(mergeEntry.source, "manual", "merge entry source manual");
      assertEq(mergeEntry.changedByUserId, AM_ID, "merge entry actor");
      assert(String(mergeEntry.reason).includes(loser.id), "merge entry names the merged-away id");
      assert(String(mergeEntry.reason).includes("same person, work vs personal email"), "merge entry keeps the operator reason");
      assertEq(mergeEntry.fromStage, "lead", "merge entry fromStage = winner's prior stage");
      assertEq(mergeEntry.toStage, "session_booked", "merge entry toStage = final stage");
      // Winner timeline now contains the loser's creation entry too.
      assertEq(hist.length, 1 + loserHistCount + 1, "winner history = own creation + loser timeline + merge entry");

      // Task #4584 — merge-target search: bounded typeahead over ALL
      // clients (customers included) by name/email, AM+-gated, source
      // record excludable. This is what feeds the UI picker below.
      actingUserId = null;
      assertEq((await api("GET", `/api/leads/merge-candidates?q=${RUN}`)).status, 401, "search unauth 401");
      actingUserId = SALES_ID;
      assertEq((await api("GET", `/api/leads/merge-candidates?q=${RUN}`)).status, 403, "sales search 403");
      actingUserId = AM_ID;
      assertEq((await api("GET", "/api/leads/merge-candidates?q=x")).status, 400, "short query 400");
      // Email search finds the CUSTOMER record (the exact case the old
      // list-fed picker could not reach).
      const custSearch = await api("GET", `/api/leads/merge-candidates?q=${encodeURIComponent(CUSTOMER_EMAIL)}`);
      assertEq(custSearch.status, 200, "customer email search 200");
      assertEq(custSearch.json.data.length, 1, "customer email search: exactly the customer");
      assertEq(custSearch.json.data[0].id, CUSTOMER_ID, "customer email search: right row");
      assertEq(custSearch.json.data[0].lifecycleStage, "customer", "search row carries lifecycleStage");
      // Name search matches RUN-prefixed rows only (shared-DB hygiene:
      // assert on fixture membership, never totals) and honors exclude=.
      const nameSearch = await api("GET", `/api/leads/merge-candidates?q=${RUN}&exclude=${winner.id}`);
      assertEq(nameSearch.status, 200, "name search 200");
      assert(nameSearch.json.data.every((c: any) => !String(c.firmName).includes("Winner")), "exclude= drops the named record");
      assert(nameSearch.json.data.some((c: any) => c.id === CUSTOMER_ID), "name search includes the customer");
      assert(nameSearch.json.data.length <= 20, "search respects the hard bound");

      // Merging into a CUSTOMER winner (former client wrote in with a new
      // address) — server-supported via the API; the post-commit lifecycle
      // policy cancels the arriving active enrollments.
      const loser2 = (await matchOrCreateLeadClient({
        email: `${RUN}-merge-lose2@example.test`,
        name: `${RUN} Merge Loser Two`,
        initialStage: "lead",
        leadSource: "manual",
        changeSource: "manual",
      }))!.client;
      const [custEnr] = await enroll("client", loser2.id, loser2.id, seqB.id);
      const res2 = await api("POST", `/api/leads/${loser2.id}/merge`, { targetClientId: CUSTOMER_ID });
      assertEq(res2.status, 200, "merge into customer 200");
      assertEq(await storage.getClient(loser2.id), undefined as any, "customer-merge loser deleted");
      const custRow = (await db.select().from(clients).where(eq(clients.id, CUSTOMER_ID)))[0];
      assertEq(custRow.lifecycleStage, "customer", "customer winner stays customer (never demoted)");
      const [custEnrAfter] = await db.select().from(emailSequenceEnrollments).where(eq(emailSequenceEnrollments.id, custEnr.id));
      assertEq(custEnrAfter.clientId, CUSTOMER_ID, "enrollment relinked to the customer");
      assertEq(custEnrAfter.status, "cancelled", "post-commit policy cancelled the active enrollment on customer entry");
      assertEq(custEnrAfter.cancelReason, "lifecycle_exit", "customer-entry cancel reason");
    });

    await step("write boundary: lifecycle columns are server-owned", async () => {
      const parsed = insertClientSchema.parse({
        firmName: `${RUN} Smuggle`,
        lifecycleStage: "lead",
        leadSource: "website_inquiry",
        leadLastActivityAt: new Date().toISOString(),
      } as any);
      assert(!("lifecycleStage" in parsed), "insert schema strips lifecycleStage");
      assert(!("leadSource" in parsed), "insert schema strips leadSource");
      assert(!("leadLastActivityAt" in parsed), "insert schema strips leadLastActivityAt");

      const parsedUpdate = updateClientSchema.parse({ lifecycleStage: "lead" } as any);
      assert(!("lifecycleStage" in parsedUpdate), "update schema strips lifecycleStage");

      // End-to-end: a smuggled patch through the storage writer cannot move
      // the stage.
      const before = await storage.getClient(CUSTOMER_ID);
      await storage.updateClient(CUSTOMER_ID, { notes: `${RUN} note`, lifecycleStage: "lead" } as any);
      const after = await storage.getClient(CUSTOMER_ID);
      assertEq(after!.lifecycleStage, before!.lifecycleStage, "updateClient cannot move lifecycle");
    });
  } finally {
    server.close();
    // Restore the auto-deal setting defensively (the step already restores;
    // this covers a failure before its finally ran).
    try {
      const current = await getSystemSetting(LEADS_BOOKING_AUTO_DEAL_ENABLED_KEY);
      if (priorAutoDeal?.value !== undefined && priorAutoDeal !== undefined) {
        if (current?.value !== priorAutoDeal.value) {
          await setSystemSetting(LEADS_BOOKING_AUTO_DEAL_ENABLED_KEY, priorAutoDeal.value, "test");
        }
      } else if (current) {
        await deleteSystemSetting(LEADS_BOOKING_AUTO_DEAL_ENABLED_KEY);
      }
    } catch (err) {
      console.error("setting restore failed:", err);
    }
    await cleanup();
  }

  if (failures > 0) {
    console.error(`${failures} step(s) failed`);
    process.exit(1);
  }
  console.log("lead-lifecycle: all steps passed");
}

main().catch((err) => {
  console.error("lead-lifecycle suite crashed:", err);
  process.exit(1);
});
