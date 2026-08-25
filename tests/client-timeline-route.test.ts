/* test-registration
{
  "name": "Unified client activity timeline routes (Task #4328)",
  "regression": true,
  "sweepOnlyReason": "DB-heavy route suite: seeds five source tables (raw comms, twilio conversations/messages/calls, scheduled meetings, sd ticket mapping + clickup tasks, deals) and walks the merged keyset cursor to exhaustion. Pins the aggregation contract — per-source inclusion/exclusion rules, cross-source ordering, cursor stability, type filters, scope binding, and both routes' auth ladders. Runs in the full suite and nightly regression sweep.",
  "tier": "small"
}
test-registration */
/**
 * Task #4328 — Unified client activity timeline route coverage.
 *
 * Runs the REAL registerTimelineRoutes against an Express app with an
 * injected passport-shaped session (switchable acting user, following
 * tests/deals-routes.test.ts) and the real db (hermetic per-run DB under
 * `npm test`).
 *
 *   1. Merge & order — one newest-first feed across raw comms (email /
 *      slack / zoom / manual note), SMS, calls, meetings, and tickets;
 *      future confirmed meetings sort first.
 *   2. Inclusion rules — non-rejected communication_client_links rows from
 *      OTHER owner clients appear; matchStatus='orphaned' rows and
 *      status='creating' meetings do not.
 *   3. Cursor pagination — limit=3 walk to exhaustion: no dupes, no gaps,
 *      byte-identical to the single-page feed; cursor is scope-bound
 *      (client A cursor on client B → 400) and garbage-safe (400).
 *   4. Type filters — types CSV narrows per entry type (zoom raw rows ride
 *      the meeting filter); unknown type / bad limit → 400.
 *   4b. Search + date range (Task #4418) — q ILIKE per arm (raw titles/
 *      previews, sms body/contact, meeting type/invitee, ticket name),
 *      ILIKE wildcards escaped, after/before inclusive UTC-day bounds,
 *      filtered cursor walk stays gap/dupe-free, bad bounds/oversized q →
 *      400, deal route parity.
 *   5. Entry shape — deep-link href per type, actor labels resolved from
 *      users, direction passthrough, voicemail call titling.
 *   6. Auth — client route: 401 unauthed, 404 unknown client, sales GET
 *      allowed (read-only middleware). Deal route: 401 unauthed, 404
 *      unknown deal, non-owner sales 403, owner sales 200, clientless deal
 *      → empty feed, demo client hidden for non-CEO but visible to CEO.
 *
 * The manual-note WRITE path deliberately reuses the pre-existing
 * POST /api/clients/:clientId/communications route (no new write surface);
 * this suite proves manual rows surface as type 'note' via the fixture and
 * keeps that route's own registration out to avoid its fire-and-forget AI
 * analysis in tests. All fixtures are RUN-suffixed with explicit ids and
 * removed in finally (FK-safe order); assertions filter to fixture ids,
 * never totals (shared-DB hygiene).
 */

import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

import { db } from "../server/db";
import { registerTimelineRoutes } from "../server/routes/timeline";

const HEX = randomBytes(4).toString("hex");
const RUN = `t4328-${HEX}`;

// Users
const TL_ID = `${RUN}-tl`;     // team_lead — full access
const SALES_ID = `${RUN}-sal`; // sales — read-only client access, deal owner-scoped
const CEO_ID = `${RUN}-ceo`;   // ceo — sees demo clients

// Clients
const C_A = `${RUN}-client-a`;    // main fixture client
const C_B = `${RUN}-client-b`;    // isolation + link-source client
const C_DEMO = `${RUN}-client-d`; // is_demo=true

// Raw communication records (explicit ids → entry ids are `comm:<id>`)
const E1 = `${RUN}-e1`; // front_email  May 1  (email)
const M1 = `${RUN}-m1`; // sms inbound  May 2
const N1 = `${RUN}-n1`; // manual note  May 3
const CALL1 = `${RUN}-cl1`; // call     May 4
const S1 = `${RUN}-s1`; // slack        May 5
const M2 = `${RUN}-m2`; // sms outbound May 6
const Z1 = `${RUN}-z1`; // zoom         May 7  (meeting via raw)
const BX = `${RUN}-bx`; // front_email on C_B, LINKED to C_A  May 8
const O1 = `${RUN}-o1`; // orphaned front_email May 9 (excluded)
const MT1 = `${RUN}-mt1`; // confirmed meeting May 10
const MT3 = `${RUN}-mt3`; // creating meeting May 11 (excluded)
const SD1 = `${RUN}-sd1`; // ticket mapping May 12
const SD2 = `${RUN}-sd2`; // ticket mapping May 13 — blank-name task → fallback title
const CT2 = `${RUN}-ct2`; // clickup task with empty name (Task #4418 fallback)
const MT2 = `${RUN}-mt2`; // confirmed meeting, FUTURE (+2 days)
const DC = `${RUN}-dc`;   // raw comm on demo client
const CONV1 = `${RUN}-conv1`;
const CT1 = `${RUN}-ct1`; // clickup task id
const D1 = `${RUN}-d1`;   // deal on C_A owned by TL
const D2 = `${RUN}-d2`;   // deal with NULL client
const D3 = `${RUN}-d3`;   // deal on demo client
const D4 = `${RUN}-d4`;   // deal on C_A owned by SALES
const PIPE = `${RUN}-pipe`;
const STAGE = `${RUN}-stage`;

// Fixture instants: absolute past days (no month-filter semantics in play,
// spacing is free) + one relative future meeting.
const T = (day: number) => `2026-05-${String(day).padStart(2, "0")}T10:00:00Z`;
const FUTURE = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();

/** Expected all-type feed for client A, newest first. */
const EXPECTED_ALL = [
  `meeting:${MT2}`,
  `ticket:${SD2}`,
  `ticket:${SD1}`,
  `meeting:${MT1}`,
  `comm:${BX}`,
  `comm:${Z1}`,
  `sms:${M2}`,
  `comm:${S1}`,
  `call:${CALL1}`,
  `comm:${N1}`,
  `sms:${M1}`,
  `comm:${E1}`,
];

function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

// ── Harness ─────────────────────────────────────────────────────────────────

process.env.NODE_ENV = process.env.NODE_ENV || "test";

let actingUserId: string | null = TL_ID;

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Clerk-era per-request test seam (server/middlewares/requireAuth.ts):
    // a string id authenticates as that user; null → unauthenticated (401).
    // The seeded users rows are committed, so requireAuth's DB lookup finds
    // them without __test_markUserReconciled pre-registration.
    (req as any).__test_clerkUserId = actingUserId;
    next();
  });
  registerTimelineRoutes(app);
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

interface FeedEntry {
  id: string;
  type: string;
  timestamp: string;
  title: string;
  preview: string | null;
  direction: string | null;
  actorLabel: string | null;
  href: string | null;
  hrefExternal: boolean;
  meta: Record<string, unknown>;
}
interface FeedPage {
  entries: FeedEntry[];
  nextCursor: string | null;
  clientId: string | null;
}

let baseUrl = "";
async function get(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`);
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

// ── Fixtures ────────────────────────────────────────────────────────────────

async function seed(): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, email, first_name, last_name, role, authority_level)
    VALUES
      (${TL_ID}, ${`${TL_ID}@t4328.example`}, 'Task4328', 'Lead', 'team_lead', 'lead'),
      (${SALES_ID}, ${`${SALES_ID}@t4328.example`}, 'Task4328', 'Seller', 'sales', 'core'),
      (${CEO_ID}, ${`${CEO_ID}@t4328.example`}, 'Task4328', 'Chief', 'ceo', 'executive')
  `);
  await db.execute(sql`
    INSERT INTO clients (id, firm_name, owner_id, is_archived, is_demo)
    VALUES
      (${C_A}, ${`${RUN} Firm A`}, ${TL_ID}, false, false),
      (${C_B}, ${`${RUN} Firm B`}, ${TL_ID}, false, false),
      (${C_DEMO}, ${`${RUN} Demo Firm`}, ${TL_ID}, false, true)
  `);

  // Raw communication records: email, note, slack, zoom on C_A; orphaned
  // excluded; BX lives on C_B but is linked (confirmed) to C_A; DC on demo.
  await db.execute(sql`
    INSERT INTO raw_communication_records
      (id, client_id, source_type, source_subtype, title, timestamp, direction,
       content_preview, external_url, match_status, created_by)
    VALUES
      (${E1}, ${C_A}, 'front_email', 'front_email', ${`${RUN} intake email`}, ${T(1)}, 'inbound',
       'Hello, we would like to talk.', 'https://front.example/open/cnv_t4328', 'matched', NULL),
      (${N1}, ${C_A}, 'manual', 'manual_note', ${`${RUN} kickoff note`}, ${T(3)}, 'internal',
       'Client prefers afternoon calls.', NULL, NULL, ${TL_ID}),
      (${S1}, ${C_A}, 'slack', 'slack_message', ${`${RUN} slack ping`}, ${T(5)}, 'internal',
       'Internal chatter about launch.', 'https://nobull.slack.com/archives/C1/p1', 'matched', NULL),
      (${Z1}, ${C_A}, 'zoom', 'zoom_meeting', ${`${RUN} zoom sync`}, ${T(7)}, NULL,
       'Recorded call about strategy.', 'https://zoom.us/rec/t4328', 'matched', NULL),
      (${BX}, ${C_B}, 'front_email', 'front_email', ${`${RUN} shared thread`}, ${T(8)}, 'outbound',
       'CC thread that involves Firm A.', 'https://front.example/open/cnv_t4328b', 'matched', NULL),
      (${O1}, ${C_A}, 'front_email', 'front_email', ${`${RUN} orphaned`}, ${T(9)}, 'inbound',
       'Should never render.', NULL, 'orphaned', NULL),
      (${DC}, ${C_DEMO}, 'manual', 'manual_note', ${`${RUN} demo note`}, ${T(2)}, 'internal',
       'Demo-client-only content.', NULL, NULL, ${TL_ID})
  `);
  await db.execute(sql`
    INSERT INTO communication_client_links
      (raw_communication_record_id, client_id, status, match_method)
    VALUES (${BX}, ${C_A}, 'confirmed', 'domain')
  `);

  // Twilio: one conversation on C_A with an inbound + an outbound message.
  await db.execute(sql`
    INSERT INTO twilio_conversations (id, client_id, contact_phone, contact_name, twilio_phone_number)
    VALUES (${CONV1}, ${C_A}, '+15550004328', ${`${RUN} Contact`}, '+15550009999')
  `);
  await db.execute(sql`
    INSERT INTO twilio_messages (id, conversation_id, direction, from_number, to_number, body, status, sent_by_user_id, created_at)
    VALUES
      (${M1}, ${CONV1}, 'inbound', '+15550004328', '+15550009999', 'Can we reschedule?', 'received', NULL, ${T(2)}),
      (${M2}, ${CONV1}, 'outbound', '+15550009999', '+15550004328', 'Sure — how about Friday?', 'delivered', ${TL_ID}, ${T(6)})
  `);
  await db.execute(sql`
    INSERT INTO twilio_calls (id, client_id, direction, from_number, to_number, status, duration, routed_to_user_id, created_at)
    VALUES (${CALL1}, ${C_A}, 'inbound', '+15550004328', '+15550009999', 'completed', 300, ${TL_ID}, ${T(4)})
  `);

  // Meetings: past confirmed + future confirmed included, creating excluded.
  await db.execute(sql`
    INSERT INTO scheduled_meetings
      (id, client_id, account_manager_user_id, booking_source, invitee_name, invitee_email,
       start_time_utc, end_time_utc, timezone, status, meeting_type_name)
    VALUES
      (${MT1}, ${C_A}, ${TL_ID}, 'admin', ${`${RUN} Invitee`}, 'invitee@t4328.example',
       ${T(10)}, ${T(10)}, 'America/New_York', 'confirmed', 'Strategy Review'),
      (${MT2}, ${C_A}, ${TL_ID}, 'admin', ${`${RUN} Invitee`}, 'invitee@t4328.example',
       ${FUTURE}, ${FUTURE}, 'America/New_York', 'confirmed', 'Kickoff Call'),
      (${MT3}, ${C_A}, ${TL_ID}, 'admin', ${`${RUN} Invitee`}, 'invitee@t4328.example',
       ${T(11)}, ${T(11)}, 'America/New_York', 'creating', 'Never Booked')
  `);

  // Service desk: clickup task + mapping on C_A.
  await db.execute(sql`
    INSERT INTO clickup_tasks (id, list_id, name, status, status_color)
    VALUES
      (${CT1}, ${`${RUN}-list`}, ${`${RUN} intake form bug`}, 'in progress', '#5f55ee'),
      (${CT2}, ${`${RUN}-list`}, '', 'in progress', '#5f55ee')
  `);
  await db.execute(sql`
    INSERT INTO sd_ticket_mapping (id, clickup_task_id, client_uuid, requester_user_id, created_at, updated_at)
    VALUES
      (${SD1}, ${CT1}, ${C_A}, ${TL_ID}, ${T(12)}, ${T(12)}),
      (${SD2}, ${CT2}, ${C_A}, ${TL_ID}, ${T(13)}, ${T(13)})
  `);

  // Deals: minimal pipeline + stage, then the four scope-test deals.
  await db.execute(sql`
    INSERT INTO deal_pipelines (id, name, slug) VALUES (${PIPE}, ${`${RUN} Pipeline`}, ${`${RUN}-pipe`})
  `);
  await db.execute(sql`
    INSERT INTO deal_stages (id, pipeline_id, slug, name, position)
    VALUES (${STAGE}, ${PIPE}, ${`${RUN}-stage`}, ${`${RUN} Stage`}, 0)
  `);
  await db.execute(sql`
    INSERT INTO deals (id, pipeline_id, stage_id, name, client_id, owner_id)
    VALUES
      (${D1}, ${PIPE}, ${STAGE}, ${`${RUN} deal A`}, ${C_A}, ${TL_ID}),
      (${D2}, ${PIPE}, ${STAGE}, ${`${RUN} deal noclient`}, NULL, ${TL_ID}),
      (${D3}, ${PIPE}, ${STAGE}, ${`${RUN} deal demo`}, ${C_DEMO}, ${TL_ID}),
      (${D4}, ${PIPE}, ${STAGE}, ${`${RUN} deal sales`}, ${C_A}, ${SALES_ID})
  `);
}

async function cleanup(): Promise<void> {
  // Links cascade from raw records, but delete explicitly for clarity.
  await db.execute(sql`DELETE FROM communication_client_links WHERE raw_communication_record_id LIKE ${`${RUN}%`}`);
  await db.execute(sql`DELETE FROM raw_communication_records WHERE id LIKE ${`${RUN}%`}`);
  await db.execute(sql`DELETE FROM twilio_messages WHERE id LIKE ${`${RUN}%`}`);
  await db.execute(sql`DELETE FROM twilio_conversations WHERE id LIKE ${`${RUN}%`}`);
  await db.execute(sql`DELETE FROM twilio_calls WHERE id LIKE ${`${RUN}%`}`);
  await db.execute(sql`DELETE FROM scheduled_meetings WHERE id LIKE ${`${RUN}%`}`);
  await db.execute(sql`DELETE FROM sd_ticket_mapping WHERE id LIKE ${`${RUN}%`}`);
  await db.execute(sql`DELETE FROM clickup_tasks WHERE id LIKE ${`${RUN}%`}`);
  await db.execute(sql`DELETE FROM deals WHERE id LIKE ${`${RUN}%`}`);
  await db.execute(sql`DELETE FROM deal_stages WHERE id LIKE ${`${RUN}%`}`);
  await db.execute(sql`DELETE FROM deal_pipelines WHERE id LIKE ${`${RUN}%`}`);
  await db.execute(sql`DELETE FROM clients WHERE id LIKE ${`${RUN}%`}`);
  await db.execute(sql`DELETE FROM users WHERE id LIKE ${`${RUN}%`}`);
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
    }
  }

  await seed();
  const app = buildApp();
  const { server, baseUrl: url } = await listen(app);
  baseUrl = url;

  try {
    await step("client feed merges all sources newest-first (incl. future meeting, linked comm; excl. orphaned + creating)", async () => {
      actingUserId = TL_ID;
      const { status, body } = await get(`/api/clients/${C_A}/timeline?limit=50`);
      assertEq(status, 200, "status");
      const page = body as FeedPage;
      assertEq(page.clientId, C_A, "clientId echo");
      assertEq(page.nextCursor, null, "single page → no cursor");
      const runIds = page.entries.filter((e) => e.id.includes(RUN)).map((e) => e.id);
      assertEq(JSON.stringify(runIds), JSON.stringify(EXPECTED_ALL), "merged order");
      // Timestamps strictly non-increasing across the WHOLE page (not just fixtures).
      for (let i = 1; i < page.entries.length; i++) {
        assert(
          page.entries[i - 1].timestamp >= page.entries[i].timestamp,
          `feed not sorted at index ${i}`,
        );
      }
    });

    await step("entry shape: deep links, actor labels, directions, previews", async () => {
      const { body } = await get(`/api/clients/${C_A}/timeline?limit=50`);
      const byId = new Map<string, FeedEntry>(
        (body as FeedPage).entries.map((e) => [e.id, e]),
      );
      const email = byId.get(`comm:${E1}`)!;
      assertEq(email.type, "email", "email type");
      assertEq(email.href, "https://front.example/open/cnv_t4328", "email href");
      assertEq(email.hrefExternal, true, "email external");
      assertEq(email.direction, "inbound", "email direction");

      const note = byId.get(`comm:${N1}`)!;
      assertEq(note.type, "note", "note type");
      assertEq(note.actorLabel, "Task4328 Lead", "note actor from created_by");

      const zoomRaw = byId.get(`comm:${Z1}`)!;
      assertEq(zoomRaw.type, "meeting", "zoom raw rides meeting type");

      const sms = byId.get(`sms:${M2}`)!;
      assertEq(sms.type, "sms", "sms type");
      assertEq(sms.direction, "outbound", "sms direction");
      assertEq(sms.href, `/comms?view=clients&convId=${encodeURIComponent(CONV1)}`, "sms href");
      assertEq(sms.hrefExternal, false, "sms internal link");
      assertEq(sms.actorLabel, "Task4328 Lead", "sms actor from sent_by_user_id");

      const call = byId.get(`call:${CALL1}`)!;
      assertEq(call.href, `/comms?view=clients&phone=${encodeURIComponent("+15550004328")}`, "call href");
      assert((call.meta as any).durationSeconds === 300, "call duration meta");

      const meeting = byId.get(`meeting:${MT1}`)!;
      assertEq(meeting.title, "Strategy Review", "meeting title from type name");
      assertEq(meeting.href, `/clients/${C_A}?tab=scheduling`, "meeting href");
      assert(String(meeting.preview ?? "").includes(`${RUN} Invitee`), "meeting preview names invitee");

      const ticket = byId.get(`ticket:${SD1}`)!;
      assertEq(ticket.href, `/admin/service-desk/tickets/${CT1}`, "ticket href");
      assert(ticket.title.includes("intake form bug"), "ticket title from clickup task");
    });

    await step("cursor walk (limit=3) reaches exhaustion with no dupes or gaps", async () => {
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const qs: string = cursor
          ? `limit=3&cursor=${encodeURIComponent(cursor)}`
          : "limit=3";
        const { status, body } = await get(`/api/clients/${C_A}/timeline?${qs}`);
        assertEq(status, 200, `page ${pages} status`);
        const page = body as FeedPage;
        assert(page.entries.length <= 3, "page respects limit");
        for (const e of page.entries) {
          assert(!seen.includes(e.id), `duplicate across pages: ${e.id}`);
          seen.push(e.id);
        }
        cursor = page.nextCursor;
        pages += 1;
        assert(pages < 30, "runaway pagination");
      } while (cursor);
      const runIds = seen.filter((id) => id.includes(RUN));
      assertEq(JSON.stringify(runIds), JSON.stringify(EXPECTED_ALL), "walk = single page feed");
      assert(pages >= 4, `expected ≥4 pages for 11 fixture entries, got ${pages}`);
    });

    await step("type filters narrow the feed; zoom raw rows ride 'meeting'", async () => {
      const meetings = await get(`/api/clients/${C_A}/timeline?types=meeting&limit=50`);
      const meetingIds = (meetings.body as FeedPage).entries
        .filter((e) => e.id.includes(RUN))
        .map((e) => e.id);
      assertEq(
        JSON.stringify(meetingIds),
        JSON.stringify([`meeting:${MT2}`, `meeting:${MT1}`, `comm:${Z1}`]),
        "meeting filter",
      );

      const notes = await get(`/api/clients/${C_A}/timeline?types=note&limit=50`);
      const noteIds = (notes.body as FeedPage).entries
        .filter((e) => e.id.includes(RUN))
        .map((e) => e.id);
      assertEq(JSON.stringify(noteIds), JSON.stringify([`comm:${N1}`]), "note filter");

      const pair = await get(`/api/clients/${C_A}/timeline?types=email,ticket&limit=50`);
      const pairIds = (pair.body as FeedPage).entries
        .filter((e) => e.id.includes(RUN))
        .map((e) => e.id);
      assertEq(
        JSON.stringify(pairIds),
        JSON.stringify([`ticket:${SD2}`, `ticket:${SD1}`, `comm:${BX}`, `comm:${E1}`]),
        "email+ticket filter",
      );
    });

    await step("q searches each arm's title/preview text (Task #4418)", async () => {
      // 'kickoff' → manual note title + meeting type name.
      const kick = await get(`/api/clients/${C_A}/timeline?q=kickoff&limit=50`);
      assertEq(kick.status, 200, "q status");
      const kickIds = (kick.body as FeedPage).entries
        .filter((e) => e.id.includes(RUN))
        .map((e) => e.id);
      assertEq(
        JSON.stringify(kickIds),
        JSON.stringify([`meeting:${MT2}`, `comm:${N1}`]),
        "q=kickoff hits note title + meeting type name",
      );

      // 'intake' → email title + clickup ticket name (left-joined mirror).
      const intake = await get(`/api/clients/${C_A}/timeline?q=intake&limit=50`);
      const intakeIds = (intake.body as FeedPage).entries
        .filter((e) => e.id.includes(RUN))
        .map((e) => e.id);
      assertEq(
        JSON.stringify(intakeIds),
        JSON.stringify([`ticket:${SD1}`, `comm:${E1}`]),
        "q=intake hits email title + ticket name",
      );

      // 'reschedule' lives only in an SMS body (preview-equivalent).
      const sms = await get(`/api/clients/${C_A}/timeline?q=reschedule&limit=50`);
      const smsIds = (sms.body as FeedPage).entries
        .filter((e) => e.id.includes(RUN))
        .map((e) => e.id);
      assertEq(JSON.stringify(smsIds), JSON.stringify([`sms:${M1}`]), "q=reschedule hits sms body");

      // ILIKE wildcards are escaped: a literal '%' matches nothing here.
      const pct = await get(`/api/clients/${C_A}/timeline?q=${encodeURIComponent("%")}&limit=50`);
      assertEq(pct.status, 200, "q=% status");
      const pctIds = (pct.body as FeedPage).entries
        .filter((e) => e.id.includes(RUN))
        .map((e) => e.id);
      assertEq(JSON.stringify(pctIds), JSON.stringify([]), "literal % matches nothing");

      // q composes with type filters.
      const noteOnly = await get(`/api/clients/${C_A}/timeline?q=kickoff&types=note&limit=50`);
      const noteOnlyIds = (noteOnly.body as FeedPage).entries
        .filter((e) => e.id.includes(RUN))
        .map((e) => e.id);
      assertEq(JSON.stringify(noteOnlyIds), JSON.stringify([`comm:${N1}`]), "q + types compose");
    });

    await step("q matches derived + fallback titles the user actually sees (Task #4418)", async () => {
      const cases: Array<[string, string[]]> = [
        // Derived SMS title prefix ("SMS to <contact>").
        ["SMS to", [`sms:${M2}`]],
        // Derived call title ("Call from <number>"); no voicemail fixture,
        // so "Voicemail" matches nothing.
        ["Call from", [`call:${CALL1}`]],
        ["Voicemail", []],
        // Rendered ticket title prefix + the no-name fallback label.
        ["Ticket: ", [`ticket:${SD1}`]],
        ["Service desk ticket", [`ticket:${SD2}`]],
      ];
      for (const [term, expected] of cases) {
        const { status, body } = await get(
          `/api/clients/${C_A}/timeline?q=${encodeURIComponent(term)}&limit=50`,
        );
        assertEq(status, 200, `q='${term}' status`);
        const ids = (body as FeedPage).entries
          .filter((e) => e.id.includes(RUN))
          .map((e) => e.id);
        assertEq(JSON.stringify(ids), JSON.stringify(expected), `q='${term}' rendered-title match`);
      }
    });

    await step("after/before bound the feed inclusively (Task #4418)", async () => {
      // May 3 .. May 6 inclusive → note(3), call(4), slack(5), sms out(6).
      const { status, body } = await get(
        `/api/clients/${C_A}/timeline?after=2026-05-03&before=2026-05-06&limit=50`,
      );
      assertEq(status, 200, "range status");
      const ids = (body as FeedPage).entries
        .filter((e) => e.id.includes(RUN))
        .map((e) => e.id);
      assertEq(
        JSON.stringify(ids),
        JSON.stringify([`sms:${M2}`, `comm:${S1}`, `call:${CALL1}`, `comm:${N1}`]),
        "inclusive date-range slice",
      );

      // ISO timestamps also accepted; after alone lower-bounds.
      const tail = await get(
        `/api/clients/${C_A}/timeline?after=${encodeURIComponent("2026-05-10T00:00:00Z")}&limit=50`,
      );
      const tailIds = (tail.body as FeedPage).entries
        .filter((e) => e.id.includes(RUN))
        .map((e) => e.id);
      assertEq(
        JSON.stringify(tailIds),
        JSON.stringify([`meeting:${MT2}`, `ticket:${SD2}`, `ticket:${SD1}`, `meeting:${MT1}`]),
        "after-only lower bound",
      );
    });

    await step("filtered cursor walk stays dupe/gap-free (Task #4418)", async () => {
      // q=<RUN> matches every fixture whose searchable text carries the run
      // prefix: all raw comm titles, both meetings (invitee name), the
      // ticket (clickup name), both SMS (contact name) — NOT the call
      // (rendered title is just "Call from <number>", null transcript) and
      // NOT the fallback-titled ticket ("Service desk ticket").
      const expected = EXPECTED_ALL.filter(
        (id) => id !== `call:${CALL1}` && id !== `ticket:${SD2}`,
      );
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const qs: string = `q=${encodeURIComponent(RUN)}&limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
        const { status, body } = await get(`/api/clients/${C_A}/timeline?${qs}`);
        assertEq(status, 200, `filtered page ${pages} status`);
        const page = body as FeedPage;
        for (const e of page.entries) {
          assert(!seen.includes(e.id), `duplicate across filtered pages: ${e.id}`);
          seen.push(e.id);
        }
        cursor = page.nextCursor;
        pages += 1;
        assert(pages < 30, "runaway filtered pagination");
      } while (cursor);
      const runIds = seen.filter((id) => id.includes(RUN));
      assertEq(JSON.stringify(runIds), JSON.stringify(expected), "filtered walk = filtered single page");
    });

    await step("bad search/range inputs 400 (Task #4418)", async () => {
      assertEq((await get(`/api/clients/${C_A}/timeline?after=notadate`)).status, 400, "garbage after");
      assertEq((await get(`/api/clients/${C_A}/timeline?before=2026-13-45`)).status, 400, "garbage before");
      // Overflow calendar dates must NOT silently normalize (2026-02-30 ≠ March 2).
      assertEq((await get(`/api/clients/${C_A}/timeline?after=2026-02-30`)).status, 400, "overflow after");
      assertEq(
        (await get(`/api/clients/${C_A}/timeline?before=${encodeURIComponent("2026-02-30T10:00:00Z")}`)).status,
        400,
        "overflow ISO before",
      );
      assertEq(
        (await get(`/api/clients/${C_A}/timeline?after=${encodeURIComponent("2026-05-01T25:00:00Z")}`)).status,
        400,
        "bad ISO hour",
      );
      assertEq(
        (await get(`/api/clients/${C_A}/timeline?after=2026-06-01&before=2026-05-01`)).status,
        400,
        "after later than before",
      );
      assertEq(
        (await get(`/api/clients/${C_A}/timeline?q=${"x".repeat(201)}`)).status,
        400,
        "q over 200 chars",
      );
    });

    await step("bad inputs 400: unknown type, garbage cursor, foreign-scope cursor, bad limit", async () => {
      assertEq((await get(`/api/clients/${C_A}/timeline?types=bogus`)).status, 400, "unknown type");
      assertEq((await get(`/api/clients/${C_A}/timeline?cursor=zzz`)).status, 400, "garbage cursor");
      assertEq((await get(`/api/clients/${C_A}/timeline?limit=0`)).status, 400, "limit 0");
      assertEq((await get(`/api/clients/${C_A}/timeline?limit=abc`)).status, 400, "limit NaN");

      // Mint a real cursor on client A, replay it against client B.
      const first = await get(`/api/clients/${C_A}/timeline?limit=3`);
      const minted = (first.body as FeedPage).nextCursor;
      assert(minted, "expected a cursor from a full page");
      const replay = await get(`/api/clients/${C_B}/timeline?limit=3&cursor=${encodeURIComponent(minted!)}`);
      assertEq(replay.status, 400, "cursor bound to other client rejected");
    });

    await step("isolation: client B sees only its own record", async () => {
      const { body } = await get(`/api/clients/${C_B}/timeline?limit=50`);
      const runIds = (body as FeedPage).entries
        .filter((e) => e.id.includes(RUN))
        .map((e) => e.id);
      assertEq(JSON.stringify(runIds), JSON.stringify([`comm:${BX}`]), "B feed");
    });

    await step("client route auth: 401 unauthed, 404 unknown client, sales GET allowed", async () => {
      actingUserId = null;
      assertEq((await get(`/api/clients/${C_A}/timeline`)).status, 401, "unauthed");
      actingUserId = TL_ID;
      assertEq((await get(`/api/clients/${randomUUID()}/timeline`)).status, 404, "unknown client");
      actingUserId = SALES_ID;
      assertEq((await get(`/api/clients/${C_A}/timeline?limit=5`)).status, 200, "sales GET");
      actingUserId = TL_ID;
    });

    await step("deal route: same feed scoped to the deal's client", async () => {
      const viaDeal = await get(`/api/deals/${D1}/timeline?limit=50`);
      assertEq(viaDeal.status, 200, "deal timeline status");
      const dealPage = viaDeal.body as FeedPage;
      assertEq(dealPage.clientId, C_A, "deal timeline clientId");
      const runIds = dealPage.entries.filter((e) => e.id.includes(RUN)).map((e) => e.id);
      assertEq(JSON.stringify(runIds), JSON.stringify(EXPECTED_ALL), "deal feed = client feed");

      // Task #4418 — search + range work identically via the deal route.
      const dealQ = await get(`/api/deals/${D1}/timeline?q=kickoff&after=2026-05-01&limit=50`);
      assertEq(dealQ.status, 200, "deal q status");
      const dealQIds = (dealQ.body as FeedPage).entries
        .filter((e) => e.id.includes(RUN))
        .map((e) => e.id);
      assertEq(
        JSON.stringify(dealQIds),
        JSON.stringify([`meeting:${MT2}`, `comm:${N1}`]),
        "deal route q parity",
      );
    });

    await step("deal route auth ladder: 401 / 404 / sales scoping / clientless / demo", async () => {
      actingUserId = null;
      assertEq((await get(`/api/deals/${D1}/timeline`)).status, 401, "unauthed");
      actingUserId = TL_ID;
      assertEq((await get(`/api/deals/${randomUUID()}/timeline`)).status, 404, "unknown deal");

      actingUserId = SALES_ID;
      assertEq((await get(`/api/deals/${D1}/timeline`)).status, 403, "sales non-owner 403");
      const own = await get(`/api/deals/${D4}/timeline?limit=5`);
      assertEq(own.status, 200, "sales owner 200");
      assertEq((own.body as FeedPage).clientId, C_A, "sales owner sees client scope");

      actingUserId = TL_ID;
      const noClient = await get(`/api/deals/${D2}/timeline`);
      assertEq(noClient.status, 200, "clientless deal 200");
      assertEq((noClient.body as FeedPage).entries.length, 0, "clientless deal empty");
      assertEq((noClient.body as FeedPage).nextCursor, null, "clientless deal no cursor");
      assertEq((noClient.body as FeedPage).clientId, null, "clientless deal null clientId");

      // Demo client: hidden for non-CEO, visible for CEO.
      const demoTl = await get(`/api/deals/${D3}/timeline?limit=50`);
      assertEq(demoTl.status, 200, "demo deal 200 for TL");
      assertEq((demoTl.body as FeedPage).entries.length, 0, "demo hidden for TL");
      actingUserId = CEO_ID;
      const demoCeo = await get(`/api/deals/${D3}/timeline?limit=50`);
      const demoIds = (demoCeo.body as FeedPage).entries
        .filter((e) => e.id.includes(RUN))
        .map((e) => e.id);
      assertEq(JSON.stringify(demoIds), JSON.stringify([`comm:${DC}`]), "CEO sees demo feed");
      actingUserId = TL_ID;
    });

    await step("manual note write path surfaces inline as type 'note'", async () => {
      // The UI composer POSTs the pre-existing communications route; here we
      // pin the storage-level write it lands on (sourceType manual) so a feed
      // regression on fresh notes can't hide behind fixture timing.
      const noteId = `${RUN}-live-note`;
      // content_preview mirrors createRawCommunication's derivation from
      // contentText (substring 200) — the route write path always sets it.
      await db.execute(sql`
        INSERT INTO raw_communication_records
          (id, client_id, source_type, source_subtype, title, timestamp, direction, content_text, content_preview, created_by)
        VALUES (${noteId}, ${C_A}, 'manual', 'manual_note', ${`${RUN} fresh note`}, NOW(), 'internal',
                'Called them; renewal confirmed.', 'Called them; renewal confirmed.', ${TL_ID})
      `);
      const { body } = await get(`/api/clients/${C_A}/timeline?types=note&limit=5`);
      const ids = (body as FeedPage).entries.map((e) => e.id);
      assertEq(ids[0], `comm:${noteId}`, "fresh note first in note filter");
      const entry = (body as FeedPage).entries[0];
      assertEq(entry.actorLabel, "Task4328 Lead", "fresh note actor");
      assert(String(entry.preview ?? "").includes("renewal confirmed"), "fresh note preview");
    });
  } finally {
    server.close();
    await cleanup();
  }

  if (failures > 0) {
    throw new Error(`${failures} step(s) failed`);
  }
  console.log("client-timeline-route: all steps passed");
}

// Test teardown in server/db.ts drains the pg pools in test mode, so the
// process exits on its own once work settles — no manual process.exit().
let exitCode = 0;
main()
  .catch((err) => {
    console.error("client-timeline-route: FAILED");
    console.error(err?.message ?? err);
    exitCode = 1;
  })
  .finally(() => {
    process.exitCode = exitCode;
  });
