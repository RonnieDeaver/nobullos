/* test-registration
{
  "name": "Campaigns, UTM capture & first-touch attribution (Task #4337)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4337: the marketing-touch → revenue loop. Guards the public intake capture contract (inquiry POST accepts capped UTM/referrer fields without weakening validation), the immutable first-touch stamp (derived once at lead mint — matched clients are NEVER re-stamped, no-signal captures normalize to 'direct', pre-feature rows stay NULL/'unknown'), deal inheritance + adopt-once semantics (a deal linked to a client later adopts the stamp only while unstamped; unlinking never clears), the by-string-key campaign join (deleting a campaign must not destroy attribution; recreating the key re-claims it), the AM+ gate on every campaign/report route (aggregate revenue), and the source/campaign report math (leads/deals by createdAt, won revenue by stageEnteredAt, inclusive UTC-day bounds). A drift here silently corrupts every 'where did revenue come from' answer downstream.",
  "tier": "small"
}
test-registration */
/**
 * Task #4337 — Campaigns, UTM capture and attribution.
 *
 * Runs the REAL registerCampaignRoutes + registerWebsiteRoutes against an
 * Express app with an injected passport-shaped session (switchable acting
 * user, following tests/lead-lifecycle.test.ts) and the real db (hermetic
 * per-run DB under `npm test`).
 *
 *   1. Pure normalization: source precedence (utm_source > search-engine
 *      referrer > external host > "direct"), campaign key normalization,
 *      cleanAttribution ("" → null), buildCampaignLinkUrl.
 *   2. Capture: inquiry POST persists UTM+referrer on the inquiry row and
 *      mints a lead stamped with the derived first touch; oversize UTM
 *      values 400 (validation not weakened); a smuggled firstTouchSource
 *      body field never reaches the stamp.
 *   3. Immutability: a second inquiry with different UTM matches the same
 *      client and does NOT re-stamp.
 *   4. Booking hook: meeting rows carrying UTM stamp minted leads with the
 *      same derivation (utm wins over referrer; google referrer → google).
 *   5. Deals: createDeal inherits the linked client's stamp in-tx;
 *      updateDeal adopts ONCE when an unstamped deal gains a client link;
 *      re-links never overwrite; unlinking never clears.
 *   6. Campaign routes: 401/403 gating, create normalizes the key,
 *      duplicate keys 409 (code utm_campaign_conflict), PATCH/DELETE,
 *      unknown id 404.
 *   7. Links: computed URL carries the campaign's key + preserves existing
 *      query params; key edits re-tag every link; body cannot smuggle
 *      utm_campaign; non-http destination 400.
 *   8. Report: per-source and per-campaign counts and won amounts, date
 *      windowing (inclusive YYYY-MM-DD UTC days), campaign-record
 *      resolution (untracked keys surface with campaignId null), and the
 *      "unknown" bucket for pre-feature NULL stamps.
 *   9. Campaign delete keeps stamps: attribution rows survive with
 *      campaignId null.
 *
 * Shared-DB hygiene: fixtures are RUN-suffixed with unique utm_source /
 * utm_campaign tokens, so report assertions scope to OUR grouped rows —
 * shared buckets ("direct"/"unknown") get presence checks only, never
 * totals. Meetings stagger slots (host no-overlap exclusion constraint).
 * All fixtures are deleted in finally.
 */

import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import { randomBytes, randomUUID } from "node:crypto";
import { eq, like, sql } from "drizzle-orm";

import { db } from "../server/db";
import { registerCampaignRoutes } from "../server/routes/campaigns";
import { registerWebsiteRoutes } from "../server/routes/website";
import {
  buildCampaignLinkUrl,
  campaignLinks,
  cleanAttribution,
  clients,
  deals,
  deriveFirstTouch,
  insertClientSchema,
  marketingCampaigns,
  normalizeFirstTouchSource,
  normalizeSourceToken,
  normalizeUtmCampaign,
  parseReferrerHost,
  scheduledMeetings,
  websiteInquiries,
} from "@shared/schema";
import { handleBookingConfirmedForLifecycle } from "../server/services/leadIntake";
import { matchOrCreateLeadClient } from "../server/storage/leadLifecycleStorage";
import {
  createDeal,
  ensureDefaultDealPipelineSeeded,
  getDefaultPipeline,
  listPipelinesWithStages,
  moveDealStage,
  updateDeal,
} from "../server/storage/dealsStorage";

const HEX = randomBytes(4).toString("hex");
const RUN = `t4337-${HEX}`;

const AM_ID = `${RUN}-am`;       // account_manager → full campaign access
const SALES_ID = `${RUN}-sales`; // sales → 403 on every campaign route

// Unique attribution tokens so grouped report rows are OURS alone.
const SRC = `${RUN}-podcast`;            // primary source bucket
const SRC_SOCIAL = `${RUN}-social`;      // secondary source (untracked campaign)
const KEY = `${RUN}-spring-launch`;      // campaign key (normalized form)
const KEY_UNTRACKED = `${RUN}-untracked`; // key with NO campaign record

// Intake identities (all RUN-scoped).
const L1_EMAIL = `${RUN}-l1@example.test`; // SRC + KEY
const L2_EMAIL = `${RUN}-l2@example.test`; // SRC, no campaign
const L3_EMAIL = `${RUN}-l3@example.test`; // no signal → direct
const L4_EMAIL = `${RUN}-l4@example.test`; // SRC_SOCIAL + KEY_UNTRACKED (+ smuggle probe)
const BK1_EMAIL = `${RUN}-bk1@example.test`;   // booking: utm beats referrer
const BK2_EMAIL = `${RUN}-bk2@example.test`;   // booking: google referrer only

const DAY_MS = 86_400_000;

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

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
    // Gated on NODE_ENV=test, which the hermetic runner sets.
    (req as any).__test_clerkUserId = actingUserId;
    next();
  });
  registerCampaignRoutes(app);
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
      (${AM_ID}, ${`${AM_ID}@t4337.example`}, 'Task4337', 'Manager', 'account_manager', 'core'),
      (${SALES_ID}, ${`${SALES_ID}@t4337.example`}, 'Task4337', 'Seller', 'sales', 'core')
  `);
}

// Stagger slots — scheduled_meetings has a host no-overlap exclusion
// constraint, so every fixture meeting gets its own hour.
let meetingSlot = 0;

async function insertConfirmedMeeting(input: {
  inviteeEmail: string;
  utmSource?: string | null;
  utmCampaign?: string | null;
  referrer?: string | null;
}): Promise<any> {
  meetingSlot += 2;
  const rows = await db
    .insert(scheduledMeetings)
    .values({
      clientId: null,
      accountManagerUserId: AM_ID,
      meetingTypeName: `${RUN} Strategy Session`,
      bookingSource: "public",
      inviteeName: `${RUN} Invitee`,
      inviteeEmail: input.inviteeEmail,
      startTimeUtc: new Date(Date.now() + (24 + meetingSlot) * 3600 * 1000),
      endTimeUtc: new Date(Date.now() + (25 + meetingSlot) * 3600 * 1000),
      timezone: "America/New_York",
      status: "confirmed",
      utmSource: input.utmSource ?? null,
      utmCampaign: input.utmCampaign ?? null,
      referrer: input.referrer ?? null,
    })
    .returning();
  return rows[0];
}

async function cleanup(): Promise<void> {
  await db.delete(deals).where(like(deals.name, `%${RUN}%`));
  await db.delete(scheduledMeetings).where(like(scheduledMeetings.inviteeEmail, `${RUN}%`));
  await db.delete(websiteInquiries).where(like(websiteInquiries.email, `${RUN}%`));
  await db.delete(clients).where(like(clients.firmName, `%${RUN}%`));
  await db.delete(clients).where(like(clients.contactEmail, `${RUN}%`));
  // campaign_links cascade on campaign delete.
  await db.delete(marketingCampaigns).where(like(marketingCampaigns.utmCampaign, `${RUN}%`));
  await db.execute(sql`DELETE FROM users WHERE id LIKE ${`${RUN}%`}`);
}

async function getClientByEmail(email: string): Promise<any | null> {
  const rows = await db
    .select()
    .from(clients)
    .where(sql`lower(${clients.contactEmail}) = ${email.toLowerCase()}`);
  return rows[0] ?? null;
}

/**
 * POST a website inquiry with optional flat attribution fields.
 *
 * Phones are RUN-unique AND per-call-unique: lead intake matches existing
 * clients by email OR phone (findClientByIdentity), so a shared phone would
 * silently collapse every fixture into one client — and a phone colliding
 * with another suite's leftover row would attach to THEIR client.
 *
 * Budget note: the public inquiry endpoint is rate-limited to 6/min per IP.
 * This suite makes exactly 6 POSTs (the limiter store resets between
 * batched suites via the module-state reset registry). Adding a 7th POST
 * requires widening the limiter or dropping one.
 */
let phoneSeq = 0;
const PHONE_BASE = String(parseInt(HEX, 16) % 1_000_000).padStart(6, "0");
async function postInquiry(
  email: string,
  name: string,
  attribution: Record<string, unknown> = {},
): Promise<{ status: number; json: any }> {
  phoneSeq += 1;
  return api("POST", "/api/website/inquiry", {
    kind: "contact",
    fullName: name,
    email,
    phone: `+1999${PHONE_BASE}${String(phoneSeq).padStart(2, "0")}`,
    message: "Attribution test inquiry.",
    page: "/services",
    ...attribution,
  });
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

  await seed();
  const app = buildApp();
  const started = await listen(app);
  const server = started.server;
  baseUrl = started.baseUrl;

  let l1Id = "";        // SRC + KEY lead
  let l2Id = "";        // SRC-only lead
  let campaignId = "";  // campaign record for KEY
  let d1Id = "";        // won deal inheriting SRC + KEY
  const wonAmount = 12345;

  try {
    await step("normalization: precedence, keys, cleaning, URL builder", async () => {
      // utm_source wins over any referrer.
      assertEq(
        normalizeFirstTouchSource({ utmSource: "  NewsLetter  ", referrer: "https://www.google.com/" }),
        "newsletter",
        "explicit utm_source wins",
      );
      // Search-engine referrers map to canonical names.
      assertEq(
        normalizeFirstTouchSource({ utmSource: null, referrer: "https://www.google.co.uk/search?q=x" }),
        "google",
        "google referrer",
      );
      assertEq(
        normalizeFirstTouchSource({ referrer: "https://duckduckgo.com/?q=x" }),
        "duckduckgo",
        "ddg referrer",
      );
      // Other external hosts keep the host (www stripped).
      assertEq(
        normalizeFirstTouchSource({ referrer: "https://www.partner-blog.example/post/1" }),
        "partner-blog.example",
        "external host referrer",
      );
      // No signal at all → direct, never blank.
      assertEq(normalizeFirstTouchSource({}), "direct", "no signal → direct");
      assertEq(normalizeFirstTouchSource({ utmSource: "   ", referrer: "not a url" }), "direct", "junk → direct");

      assertEq(normalizeSourceToken("  Google  Ads "), "google-ads", "token collapses whitespace");
      assertEq(normalizeSourceToken("\u0001\u0002"), null, "control-only token → null");
      assertEq(normalizeUtmCampaign("  Spring   LAUNCH 2026 "), "spring-launch-2026", "campaign key normalized");
      assertEq(normalizeUtmCampaign(undefined), null, "absent campaign → null");
      assertEq(parseReferrerHost("https://WWW.Example.com/a?b=c"), "example.com", "host parse strips www");
      assertEq(parseReferrerHost("garbage"), null, "unparseable referrer → null");

      const cleaned = cleanAttribution({ utmSource: "  ", utmCampaign: " x ", referrer: "" });
      assertEq(cleaned.utmSource, null, "blank utmSource → null");
      assertEq(cleaned.utmCampaign, "x", "trimmed campaign kept");
      assertEq(cleaned.referrer, null, "blank referrer → null");

      const dt = deriveFirstTouch({ utmSource: "Podcast", utmCampaign: "Spring Launch", referrer: null });
      assertEq(dt.source, "podcast", "deriveFirstTouch source");
      assertEq(dt.campaign, "spring-launch", "deriveFirstTouch campaign");

      const url = new URL(
        buildCampaignLinkUrl("https://nobull.example/pricing?ref=keep", {
          utmSource: "Newsletter",
          utmMedium: "email",
          utmCampaign: "spring-launch",
          utmTerm: null,
          utmContent: "  ",
        }),
      );
      assertEq(url.searchParams.get("ref"), "keep", "existing query params preserved");
      assertEq(url.searchParams.get("utm_source"), "Newsletter", "utm_source set verbatim");
      assertEq(url.searchParams.get("utm_campaign"), "spring-launch", "utm_campaign set");
      assertEq(url.searchParams.get("utm_term"), null, "empty params omitted");
    });

    await step("capture: inquiry POST persists UTM + mints stamped lead", async () => {
      const res = await postInquiry(L1_EMAIL, `${RUN} LeadOne`, {
        utmSource: `${RUN}-PODCAST`, // mixed case → normalized stamp
        utmMedium: "audio",
        utmCampaign: `${RUN} Spring Launch`,
        utmTerm: "growth",
        utmContent: "episode-12",
        referrer: "https://www.google.com/", // loses to utm_source
      });
      assertEq(res.status, 200, "inquiry POST status");

      const inqs = await db.select().from(websiteInquiries).where(eq(websiteInquiries.email, L1_EMAIL));
      assertEq(inqs.length, 1, "inquiry row stored");
      assertEq(inqs[0].utmSource, `${RUN}-PODCAST`, "raw utm_source persisted verbatim");
      assertEq(inqs[0].utmMedium, "audio", "utm_medium persisted");
      assertEq(inqs[0].utmCampaign, `${RUN} Spring Launch`, "raw utm_campaign persisted");
      assertEq(inqs[0].utmTerm, "growth", "utm_term persisted");
      assertEq(inqs[0].utmContent, "episode-12", "utm_content persisted");
      assertEq(inqs[0].referrer, "https://www.google.com/", "referrer persisted");

      const lead = await getClientByEmail(L1_EMAIL);
      assert(lead, "lead minted");
      l1Id = lead.id;
      assertEq(lead.firstTouchSource, SRC, "stamp normalized from utm_source");
      assertEq(lead.firstTouchCampaign, KEY, "campaign key normalized onto the stamp");

      // Oversize UTM value 400s — capture never weakens public validation.
      const oversize = await postInquiry(`${RUN}-oversize@example.test`, `${RUN} Oversize`, {
        utmSource: "x".repeat(201),
      });
      assertEq(oversize.status, 400, "oversize utm_source rejected");
    });

    await step("immutability: matched client is never re-stamped", async () => {
      const res = await postInquiry(L1_EMAIL, `${RUN} LeadOne Again`, {
        utmSource: `${RUN}-DIFFERENT`,
        utmCampaign: `${RUN}-other-campaign`,
      });
      assertEq(res.status, 200, "second inquiry status");
      const lead = await getClientByEmail(L1_EMAIL);
      assertEq(lead.firstTouchSource, SRC, "source stamp unchanged");
      assertEq(lead.firstTouchCampaign, KEY, "campaign stamp unchanged");
    });

    await step("capture: no signal → 'direct'; referrer-only → host/engine", async () => {
      await postInquiry(L2_EMAIL, `${RUN} LeadTwo`, { utmSource: SRC });
      const l2 = await getClientByEmail(L2_EMAIL);
      l2Id = l2.id;
      assertEq(l2.firstTouchSource, SRC, "L2 source stamped");
      assertEq(l2.firstTouchCampaign, null, "L2 has no campaign");

      await postInquiry(L3_EMAIL, `${RUN} LeadThree`);
      const l3 = await getClientByEmail(L3_EMAIL);
      assertEq(l3.firstTouchSource, "direct", "no-signal capture stamps 'direct', never blank");
      assertEq(l3.firstTouchCampaign, null, "no campaign for direct");
      // (Referrer-host → source e2e is covered by the booking-hook step
      // below; the pure-unit step covers the full precedence matrix. A
      // seventh inquiry POST here would blow the 6/min rate budget.)
    });

    await step("write boundary: smuggled stamp fields never reach the lead", async () => {
      const res = await postInquiry(L4_EMAIL, `${RUN} LeadFour`, {
        utmSource: SRC_SOCIAL,
        utmCampaign: KEY_UNTRACKED,
        firstTouchSource: "evil-smuggle",
        firstTouchCampaign: "evil-campaign",
      });
      assertEq(res.status, 200, "L4 inquiry status (unknown keys strip)");
      const l4 = await getClientByEmail(L4_EMAIL);
      assertEq(l4.firstTouchSource, SRC_SOCIAL, "stamp derived, not smuggled");
      assertEq(l4.firstTouchCampaign, KEY_UNTRACKED, "campaign derived, not smuggled");

      const parsed = insertClientSchema.parse({
        firmName: `${RUN} Smuggle`,
        firstTouchSource: "evil",
        firstTouchCampaign: "evil",
      } as any);
      assert(!("firstTouchSource" in parsed), "insertClientSchema strips firstTouchSource");
      assert(!("firstTouchCampaign" in parsed), "insertClientSchema strips firstTouchCampaign");
    });

    await step("booking hook: meeting UTM stamps the minted lead", async () => {
      const m1 = await insertConfirmedMeeting({
        inviteeEmail: BK1_EMAIL,
        utmSource: `${RUN}-WEBINAR`,
        utmCampaign: `${RUN} Webinar Push`,
        referrer: "https://www.google.com/",
      });
      const out1 = await handleBookingConfirmedForLifecycle(m1);
      assert(out1.clientId, "booking lead minted");
      const b1 = await getClientByEmail(BK1_EMAIL);
      assertEq(b1.firstTouchSource, `${RUN}-webinar`, "utm_source wins over referrer");
      assertEq(b1.firstTouchCampaign, `${RUN}-webinar-push`, "meeting campaign normalized");

      const m2 = await insertConfirmedMeeting({
        inviteeEmail: BK2_EMAIL,
        referrer: "https://www.google.com/search?q=marketing",
      });
      await handleBookingConfirmedForLifecycle(m2);
      const b2 = await getClientByEmail(BK2_EMAIL);
      assertEq(b2.firstTouchSource, "google", "search referrer maps to engine source");
      assertEq(b2.firstTouchCampaign, null, "no campaign from bare referrer");
    });

    await step("deals: inherit at creation; adopt-once on later link; never overwrite/clear", async () => {
      await ensureDefaultDealPipelineSeeded();
      const pipeline = (await getDefaultPipeline())!;
      const stages = (await listPipelinesWithStages()).find((p) => p.id === pipeline.id)!.stages;
      const firstOpen = stages.find((s) => s.stageType === "open")!;
      const won = stages.find((s) => s.stageType === "won")!;

      // D1: created linked to L1 → inherits SRC + KEY in the same tx.
      const d1 = await createDeal({
        name: `${RUN} d1 won`,
        pipelineId: pipeline.id,
        stageId: firstOpen.id,
        clientId: l1Id,
        contactIds: [],
        amount: wonAmount,
        expectedCloseDate: null,
        ownerId: AM_ID,
        notes: null,
        createdBy: AM_ID,
      });
      d1Id = d1.id;
      assertEq(d1.firstTouchSource, SRC, "deal inherits client source");
      assertEq(d1.firstTouchCampaign, KEY, "deal inherits client campaign");
      await moveDealStage(d1.id, { toStageId: won.id, movedByUserId: AM_ID });

      // D2: created linked to L2 (SRC only), stays open.
      const d2 = await createDeal({
        name: `${RUN} d2 open`,
        pipelineId: pipeline.id,
        stageId: firstOpen.id,
        clientId: l2Id,
        contactIds: [],
        amount: 500,
        expectedCloseDate: null,
        ownerId: AM_ID,
        notes: null,
        createdBy: AM_ID,
      });
      assertEq(d2.firstTouchSource, SRC, "D2 inherits source");
      assertEq(d2.firstTouchCampaign, null, "D2 inherits null campaign");

      // D3: clientless at creation → unstamped; adopts ONCE when linked.
      const d3 = await createDeal({
        name: `${RUN} d3 adopt`,
        pipelineId: pipeline.id,
        stageId: firstOpen.id,
        clientId: null,
        contactIds: [],
        amount: 100,
        expectedCloseDate: null,
        ownerId: AM_ID,
        notes: null,
        createdBy: AM_ID,
      });
      assertEq(d3.firstTouchSource, null, "clientless deal starts unstamped");

      const adopted = await updateDeal(d3.id, { clientId: l1Id });
      assertEq(adopted!.firstTouchSource, SRC, "adopt-once on gaining a client link");
      assertEq(adopted!.firstTouchCampaign, KEY, "campaign adopted too");

      // Re-link to a differently-stamped client: stamp must NOT move.
      const relinked = await updateDeal(d3.id, { clientId: l2Id });
      assertEq(relinked!.firstTouchSource, SRC, "existing stamp never overwritten");
      assertEq(relinked!.firstTouchCampaign, KEY, "campaign stamp never overwritten");

      // Unlink: stamp survives.
      const unlinked = await updateDeal(d3.id, { clientId: null });
      assertEq(unlinked!.firstTouchSource, SRC, "unlinking never clears the stamp");
    });

    await step("campaign routes: 401/403 gating", async () => {
      actingUserId = null;
      assertEq((await api("GET", "/api/campaigns")).status, 401, "unauthenticated list 401");
      assertEq((await api("GET", "/api/attribution/report")).status, 401, "unauthenticated report 401");

      actingUserId = SALES_ID;
      assertEq((await api("GET", "/api/campaigns")).status, 403, "sales list 403");
      assertEq(
        (await api("POST", "/api/campaigns", { name: "x", utmCampaign: "x" })).status,
        403,
        "sales create 403",
      );
      assertEq((await api("GET", "/api/attribution/report")).status, 403, "sales report 403");

      actingUserId = AM_ID;
    });

    await step("campaign CRUD: create normalizes key, 409 on dup, patch, 404s", async () => {
      const created = await api("POST", "/api/campaigns", {
        name: `${RUN} Spring`,
        utmCampaign: `${RUN}-Spring-Launch`, // mixed case → normalized
        startDate: isoDay(Date.now() - 30 * DAY_MS),
        endDate: null,
        notes: `${RUN} notes`,
        // Server-owned fields — must strip, not apply.
        id: "evil-id",
        createdBy: "evil-user",
        isArchived: true,
      });
      assertEq(created.status, 201, "create status");
      campaignId = created.json.id;
      assert(campaignId && campaignId !== "evil-id", "id is server-minted");
      assertEq(created.json.utmCampaign, KEY, "key stored normalized");
      assertEq(created.json.createdBy, AM_ID, "createdBy is the actor, not the body");
      assertEq(created.json.isArchived, false, "isArchived not settable at create");

      // Same key modulo case/whitespace → 409 with the typed code.
      const dup = await api("POST", "/api/campaigns", {
        name: `${RUN} Dup`,
        utmCampaign: `${RUN} SPRING   LAUNCH`,
      });
      assertEq(dup.status, 409, "duplicate key 409");
      assertEq(dup.json.code, "utm_campaign_conflict", "conflict code");

      const blankKey = await api("POST", "/api/campaigns", { name: `${RUN} Blank`, utmCampaign: "   " });
      assertEq(blankKey.status, 400, "whitespace-only key 400");

      const list = await api("GET", "/api/campaigns");
      assertEq(list.status, 200, "list status");
      const mine = (list.json.data as any[]).find((c) => c.id === campaignId);
      assert(mine, "created campaign listed");
      assert(mine.stats && typeof mine.stats.leads === "number", "list rows carry stats");

      const patched = await api("PATCH", `/api/campaigns/${campaignId}`, {
        notes: `${RUN} updated notes`,
        isArchived: true,
      });
      assertEq(patched.status, 200, "patch status");
      assertEq(patched.json.notes, `${RUN} updated notes`, "notes updated");
      assertEq(patched.json.isArchived, true, "archive toggled");
      await api("PATCH", `/api/campaigns/${campaignId}`, { isArchived: false });

      assertEq((await api("GET", `/api/campaigns/${randomUUID()}`)).status, 404, "unknown id 404");
      assertEq((await api("PATCH", `/api/campaigns/${randomUUID()}`, { name: "x" })).status, 404, "patch unknown 404");
      assertEq((await api("DELETE", `/api/campaigns/${randomUUID()}`)).status, 404, "delete unknown 404");
    });

    await step("links: computed URL, key-edit re-tag, smuggle-proof, validation", async () => {
      const link = await api("POST", `/api/campaigns/${campaignId}/links`, {
        label: `${RUN} newsletter cta`,
        destinationUrl: "https://nobull.example/pricing?ref=keep",
        utmSource: "Newsletter",
        utmMedium: "email",
        utmCampaign: "evil-override", // not a schema field — must strip
      });
      assertEq(link.status, 201, "link create status");
      const linkId = link.json.id;
      const u1 = new URL(link.json.url);
      assertEq(u1.searchParams.get("ref"), "keep", "destination query preserved");
      assertEq(u1.searchParams.get("utm_source"), "Newsletter", "utm_source applied");
      assertEq(u1.searchParams.get("utm_campaign"), KEY, "utm_campaign is ALWAYS the campaign key");

      // Key edit re-tags every link's computed URL.
      const keyV2 = `${KEY}-v2`;
      const rekeyed = await api("PATCH", `/api/campaigns/${campaignId}`, { utmCampaign: keyV2 });
      assertEq(rekeyed.status, 200, "key edit status");
      const detail = await api("GET", `/api/campaigns/${campaignId}`);
      assertEq(detail.status, 200, "detail status");
      const dLink = (detail.json.links as any[]).find((l) => l.id === linkId);
      assertEq(
        new URL(dLink.url).searchParams.get("utm_campaign"),
        keyV2,
        "link URL re-tagged after key edit",
      );
      // Restore the original key — attribution steps below depend on it.
      await api("PATCH", `/api/campaigns/${campaignId}`, { utmCampaign: KEY });

      const badDest = await api("POST", `/api/campaigns/${campaignId}/links`, {
        destinationUrl: "ftp://nope.example/file",
      });
      assertEq(badDest.status, 400, "non-http destination 400");

      const del = await api("DELETE", `/api/campaigns/${campaignId}/links/${linkId}`);
      assertEq(del.status, 200, "link delete status");
      const detail2 = await api("GET", `/api/campaigns/${campaignId}`);
      assert(
        !(detail2.json.links as any[]).some((l) => l.id === linkId),
        "deleted link gone from detail",
      );
      assertEq(
        (await api("DELETE", `/api/campaigns/${campaignId}/links/${linkId}`)).status,
        404,
        "re-delete 404",
      );
    });

    await step("campaign detail: stats + attributed leads/deals by key", async () => {
      const detail = await api("GET", `/api/campaigns/${campaignId}`);
      assertEq(detail.status, 200, "detail status");
      assertEq(detail.json.stats.leads, 1, "one attributed lead (L1)");
      assertEq(detail.json.stats.deals, 2, "attributed deals = D1 + D3 (adopted KEY)");
      assertEq(detail.json.stats.wonDeals, 1, "won deals = D1");
      assertEq(detail.json.stats.wonAmount, wonAmount, "won amount = D1's");

      const leadRows = detail.json.attributedLeads as any[];
      assert(leadRows.some((l) => l.id === l1Id), "L1 in attributed leads");
      assert(!leadRows.some((l) => l.id === l2Id), "L2 (no campaign) NOT attributed");

      const dealRows = detail.json.attributedDeals as any[];
      assert(dealRows.some((d) => d.id === d1Id), "D1 in attributed deals");
      const d1Row = dealRows.find((d) => d.id === d1Id);
      assertEq(d1Row.stageType, "won", "D1 shows its won stage type");
    });

    await step("report: source/campaign rollups, date windows, unknown bucket", async () => {
      // Pre-feature row: minted with NO firstTouch → NULL stamp.
      const unknownLead = await matchOrCreateLeadClient({
        email: `${RUN}-unknown@example.test`,
        name: `${RUN} PreFeature`,
        initialStage: "lead",
        leadSource: "manual",
        changeSource: "manual",
      });
      const unknownRow = await getClientByEmail(`${RUN}-unknown@example.test`);
      assert(unknownLead?.created, "pre-feature probe minted");
      assertEq(unknownRow.firstTouchSource, null, "no capture → NULL stamp (renders Unknown)");

      const from = isoDay(Date.now() - DAY_MS);
      const to = isoDay(Date.now() + DAY_MS);
      const rep = await api("GET", `/api/attribution/report?from=${from}&to=${to}`);
      assertEq(rep.status, 200, "report status");

      const srcRow = (rep.json.sources as any[]).find((r) => r.source === SRC);
      assert(srcRow, "our source bucket present");
      assertEq(srcRow.leads, 2, "SRC leads = L1 + L2");
      assertEq(srcRow.deals, 3, "SRC deals = D1 + D2 + D3(adopted)");
      assertEq(srcRow.wonDeals, 1, "SRC won deals = D1");
      assertEq(srcRow.wonAmount, wonAmount, "SRC won amount");

      const socialRow = (rep.json.sources as any[]).find((r) => r.source === SRC_SOCIAL);
      assert(socialRow && socialRow.leads === 1, "secondary source bucket counts L4");

      assert(
        (rep.json.sources as any[]).some((r) => r.source === "direct"),
        "'direct' bucket present (contains our L3)",
      );
      assert(
        (rep.json.sources as any[]).some((r) => r.source === "unknown"),
        "'unknown' bucket present for NULL-stamp rows",
      );

      const campRow = (rep.json.campaigns as any[]).find((r) => r.utmCampaign === KEY);
      assert(campRow, "our campaign key row present");
      assertEq(campRow.campaignId, campaignId, "key resolved to the campaign record");
      assertEq(campRow.campaignName, `${RUN} Spring`, "campaign name resolved");
      assertEq(campRow.leads, 1, "KEY leads = L1");
      assertEq(campRow.deals, 2, "KEY deals = D1 + D3(adopted)");
      assertEq(campRow.wonDeals, 1, "KEY won = D1");
      assertEq(campRow.wonAmount, wonAmount, "KEY won amount");

      const untracked = (rep.json.campaigns as any[]).find((r) => r.utmCampaign === KEY_UNTRACKED);
      assert(untracked, "untracked key surfaces in the report");
      assertEq(untracked.campaignId, null, "untracked key has no campaign record");
      assertEq(untracked.leads, 1, "untracked key counts L4");

      // Future-only window: our buckets vanish (leads/deals count by
      // createdAt, won by stageEnteredAt — all 'now').
      const futureFrom = isoDay(Date.now() + 2 * DAY_MS);
      const future = await api("GET", `/api/attribution/report?from=${futureFrom}`);
      assertEq(future.status, 200, "future-window status");
      assert(
        !(future.json.sources as any[]).some((r) => r.source === SRC),
        "date filter excludes our source bucket",
      );
      assert(
        !(future.json.campaigns as any[]).some((r) => r.utmCampaign === KEY),
        "date filter excludes our campaign bucket",
      );

      // Inverted range 400s.
      assertEq(
        (await api("GET", `/api/attribution/report?from=${to}&to=${from}`)).status,
        400,
        "from > to rejected",
      );
      assertEq(
        (await api("GET", "/api/attribution/report?from=nonsense")).status,
        400,
        "malformed date rejected",
      );
    });

    await step("campaign delete: record gone, stamps + report survive", async () => {
      const del = await api("DELETE", `/api/campaigns/${campaignId}`);
      assertEq(del.status, 200, "delete status");
      assertEq((await api("GET", `/api/campaigns/${campaignId}`)).status, 404, "detail 404 after delete");

      const l1 = await getClientByEmail(L1_EMAIL);
      assertEq(l1.firstTouchCampaign, KEY, "lead stamp survives campaign delete");
      const [d1Row] = await db.select().from(deals).where(eq(deals.id, d1Id));
      assertEq(d1Row.firstTouchCampaign, KEY, "deal stamp survives campaign delete");

      const rep = await api("GET", "/api/attribution/report");
      const campRow = (rep.json.campaigns as any[]).find((r) => r.utmCampaign === KEY);
      assert(campRow, "key still reported after delete");
      assertEq(campRow.campaignId, null, "…as an untracked key (no record)");

      // Recreating the key re-claims the history.
      const recreated = await api("POST", "/api/campaigns", {
        name: `${RUN} Spring Reborn`,
        utmCampaign: KEY,
      });
      assertEq(recreated.status, 201, "recreate status");
      const detail = await api("GET", `/api/campaigns/${recreated.json.id}`);
      assertEq(detail.json.stats.wonDeals, 1, "recreated campaign re-claims won history");
    });
  } finally {
    server.close();
    await cleanup();
  }

  if (failures > 0) {
    console.error(`${failures} step(s) failed`);
    process.exit(1);
  }
  console.log("campaign-attribution: all steps passed");
}

main().catch((err) => {
  console.error("campaign-attribution suite crashed:", err);
  process.exit(1);
});
