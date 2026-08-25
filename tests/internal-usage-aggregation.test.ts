/* test-registration
{
  "name": "Internal tool-usage aggregation endpoint (Task #3721)",
  "regression": true,
  "sweepOnlyReason": "Task #3721 — internal usage aggregation e2e: DB-heavy (runInIsolatedSchema: users, clients + 6 domain tables) + real HTTP server; runs in the full sweep, not the smoke gate.",
  "tier": "small"
}
test-registration */
/**
 * Task #3721 — Internal tool-usage tracker: aggregation endpoint e2e.
 *
 * Boots the real `GET /api/internal-usage` Express route (leadership gate
 * included) against an isolated schema seeded with representative rows
 * across the five source tables, then asserts over the parsed HTTP JSON
 * body that:
 *
 *   1. The gate holds: an account_manager gets 403, a team_lead gets 200.
 *   2. Per-tool overall totals count all in-range actions — inbound
 *      SMS/calls, assistant-role chat rows and rows outside the requested
 *      range are excluded, while actor-less outbound SMS/calls and AM-less
 *      bookings surface ONLY in the card-level `*Unattributed` buckets
 *      (accuracy audit follow-up to Task #3721), mirroring agent chat's
 *      historical bucket.
 *   3. Per-member totals attribute bookings to the account manager (with
 *      the direct vs public-link breakdown), outbound SMS to the sender,
 *      outbound calls to the initiator, intel entries to the creator and
 *      user-role chat messages to the stamped sender.
 *   4. The per-member client × tool matrix covers ALL of the member's
 *      assigned (non-archived, non-demo) clients — including a client
 *      with zero activity, flagged `noActivity` — and excludes archived
 *      clients.
 *   5. Historical user-role chat rows without a sender surface per client
 *      only (`agentChatUnattributed` + the top-level rollup), never under
 *      any member.
 *   6. Task #4872 — the all-time window (`days=all`) counts rows older
 *      than ANY numeric preset (seeded beyond the 365-day cap), echoes the
 *      literal "all", and reports an honest `since`/`coverageStart` equal
 *      to the earliest counted row; numeric windows expose `coverageStart`
 *      too (earliest counted row inside the window, not the boundary).
 *
 * Everything runs inside `runInIsolatedSchema` with `pinGetDbForCrossAsync`
 * so the HTTP handler (a separate async context) reads the cloned tables,
 * not live `public`. IDs still carry a per-run random suffix as defense in
 * depth against any search_path fallthrough.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import { registerInternalUsageRoutes } from "../server/routes/internalUsage";
import {
  __test_markUserReconciled,
  __test_resetReconciledUsers,
} from "../server/middlewares/requireAuth";
import { runInIsolatedSchema } from "./db-sandbox";

const RUN = randomUUID().slice(0, 8);
const TL_ID = `test-3721-tl-${RUN}`;
const AM_A = `test-3721-am-a-${RUN}`;
const AM_B = `test-3721-am-b-${RUN}`;
const C1 = `test-3721-client-1-${RUN}`; // owned by AM_A, active usage
const C2 = `test-3721-client-2-${RUN}`; // owned by AM_A, zero activity
const C3 = `test-3721-client-3-${RUN}`; // owned by AM_B
const C4 = `test-3721-client-4-${RUN}`; // owned by AM_A but archived — excluded from grid

function buildApp(actingUserId: string): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Clerk per-request test seam (server/middlewares/requireAuth.ts): a string
    // authenticates as that user id; null is explicit-unauthenticated. The
    // pre-Clerk passport-shape injection stopped working when auth migrated.
    (req as any).__test_clerkUserId = actingUserId;
    next();
  });
  registerInternalUsageRoutes(app);
  return app;
}

async function listen(app: express.Express): Promise<{ server: Server; baseUrl: string }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

async function get(baseUrl: string, p: string): Promise<{ status: number; body: any }> {
  const r = await fetch(`${baseUrl}${p}`);
  const text = await r.text();
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: r.status, body: parsed };
}

async function main(): Promise<void> {
  await runInIsolatedSchema(
    async ({ db: isoDb }) => {
      // ── Seed users (roles drive both the gate and member membership) ──
      await isoDb.execute(sql`
        INSERT INTO users (id, role, authority_level, first_name, last_name)
        VALUES
          (${TL_ID}, 'team_lead', 'director', 'Tessa', 'Lead'),
          (${AM_A}, 'account_manager', 'core', 'Alice', 'Alpha'),
          (${AM_B}, 'account_manager', 'core', 'Bob', 'Bravo')
      `);
      // Users are seeded in the isolated (uncommitted) schema, but requireAuth
      // resolves identity via its direct ambient `db` import (PUBLIC schema),
      // which never sees these rows. Pre-register each acting identity so
      // requireAuth admits them without JIT-provisioning a public row; the
      // requireTeamLead gate still reads the isolated-schema role via
      // storage.getUser (pinGetDbForCrossAsync).
      __test_markUserReconciled(TL_ID, {
        id: TL_ID,
        firstName: "Tessa",
        lastName: "Lead",
        role: "team_lead",
      });
      __test_markUserReconciled(AM_A, {
        id: AM_A,
        firstName: "Alice",
        lastName: "Alpha",
        role: "account_manager",
      });
      __test_markUserReconciled(AM_B, {
        id: AM_B,
        firstName: "Bob",
        lastName: "Bravo",
        role: "account_manager",
      });

      // ── Clients: C1/C2 owned by Alice, C3 by Bob, C4 archived (Alice) ──
      await isoDb.execute(sql`
        INSERT INTO clients (id, firm_name, owner_id, is_archived, is_demo)
        VALUES
          (${C1}, ${'Firm One ' + RUN}, ${AM_A}, false, false),
          (${C2}, ${'Firm Two ' + RUN}, ${AM_A}, false, false),
          (${C3}, ${'Firm Three ' + RUN}, ${AM_B}, false, false),
          (${C4}, ${'Firm Archived ' + RUN}, ${AM_A}, true, false)
      `);

      // ── Bookings ──
      // in-range: Alice direct (client_profile) + Alice public_link on C1;
      // Bob client_bound_public_link on C3; AM-less row (m4) counts card-level
      // as unattributed only. Excluded: 200d-old row.
      await isoDb.execute(sql`
        INSERT INTO scheduled_meetings
          (id, client_id, account_manager_user_id, booking_source, start_time_utc, end_time_utc, timezone, status, created_at)
        VALUES
          (${`m1-${RUN}`}, ${C1}, ${AM_A}, 'client_profile', NOW(), NOW() + interval '30 min', 'UTC', 'scheduled', NOW() - interval '2 days'),
          (${`m2-${RUN}`}, ${C1}, ${AM_A}, 'public_link', NOW(), NOW() + interval '30 min', 'UTC', 'scheduled', NOW() - interval '3 days'),
          (${`m3-${RUN}`}, ${C3}, ${AM_B}, 'client_bound_public_link', NOW(), NOW() + interval '30 min', 'UTC', 'scheduled', NOW() - interval '1 day'),
          (${`m4-${RUN}`}, ${C1}, NULL, 'public_link', NOW(), NOW() + interval '30 min', 'UTC', 'scheduled', NOW() - interval '1 day'),
          (${`m5-${RUN}`}, ${C1}, ${AM_A}, 'client_profile', NOW(), NOW() + interval '30 min', 'UTC', 'scheduled', NOW() - interval '200 days'),
          (${`m6-${RUN}`}, ${C1}, ${AM_A}, 'client_profile', NOW(), NOW() + interval '30 min', 'UTC', 'scheduled', NOW() - interval '400 days')
      `);

      // ── SMS: conversations map messages → clients ──
      await isoDb.execute(sql`
        INSERT INTO twilio_conversations (id, client_id, contact_phone, twilio_phone_number)
        VALUES
          (${`conv1-${RUN}`}, ${C1}, '+15550000001', '+15559990001'),
          (${`convn-${RUN}`}, NULL, '+15550000002', '+15559990001')
      `);
      // Counted: 2 outbound by Alice on C1, 1 outbound by Bob on the
      // client-less thread, plus 1 sender-less outbound row (s4) that counts
      // card-level as unattributed only. Excluded: inbound row, out-of-range
      // outbound row.
      await isoDb.execute(sql`
        INSERT INTO twilio_messages
          (id, conversation_id, direction, from_number, to_number, body, status, sent_by_user_id, created_at)
        VALUES
          (${`s1-${RUN}`}, ${`conv1-${RUN}`}, 'outbound', '+15559990001', '+15550000001', 'hi 1', 'delivered', ${AM_A}, NOW() - interval '2 days'),
          (${`s2-${RUN}`}, ${`conv1-${RUN}`}, 'outbound', '+15559990001', '+15550000001', 'hi 2', 'delivered', ${AM_A}, NOW() - interval '1 day'),
          (${`s3-${RUN}`}, ${`conv1-${RUN}`}, 'inbound', '+15550000001', '+15559990001', 'reply', 'received', NULL, NOW() - interval '1 day'),
          (${`s4-${RUN}`}, ${`conv1-${RUN}`}, 'outbound', '+15559990001', '+15550000001', 'automated', 'sent', NULL, NOW() - interval '1 day'),
          (${`s5-${RUN}`}, ${`convn-${RUN}`}, 'outbound', '+15559990001', '+15550000002', 'bob msg', 'sent', ${AM_B}, NOW() - interval '1 day'),
          (${`s6-${RUN}`}, ${`conv1-${RUN}`}, 'outbound', '+15559990001', '+15550000001', 'old', 'delivered', ${AM_A}, NOW() - interval '200 days')
      `);

      // ── Calls: 1 outbound by Alice on C1; 1 initiator-less outbound (c4,
      // e.g. a browser-call webhook that couldn't resolve the identity)
      // counts card-level as unattributed only; inbound + out-of-range
      // excluded ──
      await isoDb.execute(sql`
        INSERT INTO twilio_calls
          (id, client_id, direction, from_number, to_number, status, initiated_by_user_id, created_at)
        VALUES
          (${`c1-${RUN}`}, ${C1}, 'outbound', '+15559990001', '+15550000001', 'completed', ${AM_A}, NOW() - interval '2 days'),
          (${`c2-${RUN}`}, ${C1}, 'inbound', '+15550000001', '+15559990001', 'completed', NULL, NOW() - interval '1 day'),
          (${`c3-${RUN}`}, ${C3}, 'outbound', '+15559990001', '+15550000003', 'completed', ${AM_B}, NOW() - interval '200 days'),
          (${`c4-${RUN}`}, ${C1}, 'outbound', '+15559990001', '+15550000001', 'completed', NULL, NOW() - interval '3 days')
      `);

      // ── Intel notes: 1 by Bob on C3 in range; Alice's is out of range.
      // i3 sits beyond even the 365-day cap (Task #4872): only the all-time
      // window can count it, and as the oldest seeded row anywhere it pins
      // the all-time coverage start. ──
      await isoDb.execute(sql`
        INSERT INTO intelligence_feed_entries
          (id, client_id, created_by, entry_type, title, status, created_at)
        VALUES
          (${`i1-${RUN}`}, ${C3}, ${AM_B}, 'insight', 'Bob note', 'draft', NOW() - interval '2 days'),
          (${`i2-${RUN}`}, ${C1}, ${AM_A}, 'insight', 'Old note', 'draft', NOW() - interval '200 days'),
          (${`i3-${RUN}`}, ${C1}, ${AM_A}, 'insight', 'Ancient note', 'draft', NOW() - interval '420 days')
      `);

      // ── Agent chat: attributed user row (Alice/C1), assistant row
      // (excluded), historical sender-less user row (C3, per-client only),
      // out-of-range user row (excluded) ──
      await isoDb.execute(sql`
        INSERT INTO client_agent_chats (id, client_id, role, content, created_by_user_id, created_at)
        VALUES
          (${`g1-${RUN}`}, ${C1}, 'user', 'question', ${AM_A}, NOW() - interval '1 day'),
          (${`g2-${RUN}`}, ${C1}, 'assistant', 'answer', NULL, NOW() - interval '1 day'),
          (${`g3-${RUN}`}, ${C3}, 'user', 'historical question', NULL, NOW() - interval '2 days'),
          (${`g4-${RUN}`}, ${C3}, 'user', 'ancient question', ${AM_B}, NOW() - interval '200 days')
      `);

      // ── 1. Gate: account_manager → 403 ──
      {
        const app = buildApp(AM_A);
        const { server, baseUrl } = await listen(app);
        try {
          const r = await get(baseUrl, "/api/internal-usage?days=30");
          assert.equal(r.status, 403, "account_manager must get 403");
        } finally {
          server.close();
        }
      }
      console.log("  ok  account_manager blocked with 403");

      // ── 2-5. team_lead → 200 + full aggregation assertions ──
      const app = buildApp(TL_ID);
      const { server, baseUrl } = await listen(app);
      try {
        const r = await get(baseUrl, "/api/internal-usage?days=30");
        assert.equal(r.status, 200, `team_lead must get 200 (got ${r.status}: ${JSON.stringify(r.body)})`);
        const body = r.body;
        assert.equal(body.days, 30, "echoes the requested range");

        // Task #4872 — numeric windows expose the true coverage start: the
        // earliest COUNTED row (the −3d seeds), not the window boundary.
        assert.ok(body.coverageStart, "30d response carries coverageStart");
        {
          const covMs = new Date(body.coverageStart).getTime();
          const sinceMs = new Date(body.since).getTime();
          assert.ok(
            covMs > sinceMs,
            "coverage start sits inside the window (later than the 30d boundary)",
          );
          assert.ok(
            Math.abs(covMs - (Date.now() - 3 * 86_400_000)) < 86_400_000,
            `30d coverage start ≈ the oldest in-window seed at −3d (got ${body.coverageStart})`,
          );
        }

        // Overall totals — attributed + card-level unattributed; inbound,
        // assistant-role and out-of-range rows stay excluded.
        assert.equal(body.totals.bookings, 4, "bookings total (m1,m2,m3 + AM-less m4; old excluded)");
        assert.equal(body.totals.bookingsAttributed, 3, "3 AM-attributed bookings");
        assert.equal(body.totals.bookingsUnattributed, 1, "AM-less booking surfaces card-level");
        assert.equal(body.totals.bookingsDirect, 1, "1 direct booking (client_profile)");
        assert.equal(body.totals.bookingsPublicLink, 3, "3 public-link bookings (incl. AM-less m4)");
        assert.equal(
          body.totals.bookingsDirect + body.totals.bookingsPublicLink,
          body.totals.bookings,
          "direct/link split covers ALL counted bookings",
        );
        assert.equal(body.totals.sms, 4, "sms total (incl. sender-less s4; inbound + old excluded)");
        assert.equal(body.totals.smsAttributed, 3, "3 sender-attributed sms");
        assert.equal(body.totals.smsUnattributed, 1, "sender-less outbound sms surfaces card-level");
        assert.equal(body.totals.calls, 2, "calls total (incl. initiator-less c4; inbound + old excluded)");
        assert.equal(body.totals.callsAttributed, 1, "1 initiator-attributed call");
        assert.equal(body.totals.callsUnattributed, 1, "initiator-less outbound call surfaces card-level");
        assert.equal(body.totals.intel, 1, "intel total (old excluded)");
        assert.equal(body.totals.agentChatAttributed, 1, "1 attributed user-role chat");
        assert.equal(body.totals.agentChatUnattributed, 1, "1 historical sender-less user-role chat");
        assert.equal(body.totals.agentChat, 2, "chat total = attributed + unattributed (assistant excluded)");

        // Members present (seeded trio at minimum; isolated schema is fresh).
        const byId = new Map<string, any>(body.members.map((m: any) => [m.userId, m]));
        const alice = byId.get(AM_A);
        const bob = byId.get(AM_B);
        const tessa = byId.get(TL_ID);
        assert.ok(alice, "Alice appears as a member");
        assert.ok(bob, "Bob appears as a member");
        assert.ok(tessa, "zero-usage team_lead still appears as a member");

        // Alice's per-tool counts.
        assert.deepEqual(
          alice.counts,
          {
            bookings: 2,
            bookingsDirect: 1,
            bookingsPublicLink: 1,
            sms: 2,
            calls: 1,
            intel: 0,
            agentChat: 1,
          },
          "Alice per-tool counts",
        );
        assert.equal(alice.total, 6, "Alice total actions");
        assert.equal(alice.assignedClientCount, 2, "archived client excluded from Alice's book");

        // Alice's client × tool grid: C1 active, C2 all-zero gap, C4 absent.
        const aliceClients = new Map<string, any>(alice.clients.map((c: any) => [c.clientId, c]));
        assert.ok(aliceClients.has(C1) && aliceClients.has(C2), "grid covers both active clients");
        assert.ok(!aliceClients.has(C4), "archived client not in the grid");
        const c1Row = aliceClients.get(C1);
        assert.deepEqual(
          c1Row.counts,
          { bookings: 2, bookingsDirect: 1, bookingsPublicLink: 1, sms: 2, calls: 1, intel: 0, agentChat: 1 },
          "C1 cell counts for Alice",
        );
        assert.equal(c1Row.noActivity, false, "C1 is active");
        const c2Row = aliceClients.get(C2);
        assert.equal(c2Row.total, 0, "C2 has zero member usage");
        assert.equal(c2Row.agentChatUnattributed, 0, "C2 has no historical chat");
        assert.equal(c2Row.noActivity, true, "C2 flagged as no-activity gap");
        assert.equal(alice.clientsWithNoActivity, 1, "Alice has exactly one idle client");

        // Bob: public-link booking + client-less SMS + intel; chat only via
        // the unattributed per-client bucket (never under Bob).
        assert.deepEqual(
          bob.counts,
          {
            bookings: 1,
            bookingsDirect: 0,
            bookingsPublicLink: 1,
            sms: 1,
            calls: 0,
            intel: 1,
            agentChat: 0,
          },
          "Bob per-tool counts (historical chat NOT attributed to him)",
        );
        assert.equal(bob.total, 3, "Bob total actions (client-less SMS still counts)");
        const bobClients = new Map<string, any>(bob.clients.map((c: any) => [c.clientId, c]));
        const c3Row = bobClients.get(C3);
        assert.ok(c3Row, "C3 in Bob's grid");
        assert.equal(c3Row.counts.sms, 0, "client-less SMS does not land on C3");
        assert.equal(c3Row.counts.agentChat, 0, "no attributed chat on C3");
        assert.equal(c3Row.agentChatUnattributed, 1, "historical chat surfaces per-client on C3");
        assert.equal(c3Row.noActivity, false, "C3 not idle (booking + intel + historical chat)");

        // Zero-usage leadership member.
        assert.equal(tessa.total, 0, "team_lead with no usage shows zero total");
        assert.equal(tessa.assignedClientCount, 0, "no assigned clients for the team_lead");

        // Unattributed rows are card-level only: summed member counts equal
        // the attributed totals exactly, so no member absorbed the AM-less
        // booking, sender-less SMS or initiator-less call.
        const memberSums = (body.members as any[]).reduce(
          (acc, m) => {
            acc.bookings += m.counts.bookings;
            acc.sms += m.counts.sms;
            acc.calls += m.counts.calls;
            return acc;
          },
          { bookings: 0, sms: 0, calls: 0 },
        );
        assert.equal(memberSums.bookings, body.totals.bookingsAttributed, "AM-less booking not attributed to any member");
        assert.equal(memberSums.sms, body.totals.smsAttributed, "sender-less SMS not attributed to any member");
        assert.equal(memberSums.calls, body.totals.callsAttributed, "initiator-less call not attributed to any member");

        // Top-level unattributed rollup names the client.
        const unattr = (body.unattributedAgentChat as any[]).find((u) => u.clientId === C3);
        assert.ok(unattr, "unattributed chat rollup includes C3");
        assert.equal(unattr.count, 1, "one historical chat row on C3");

        console.log("  ok  aggregation body: totals, per-member counts, client grids, unattributed chat");

        // Range behaviour: a 365-day window picks up the 200-day-old rows
        // (attributed and unattributed buckets both honour the window).
        const wide = await get(baseUrl, "/api/internal-usage?days=365");
        assert.equal(wide.status, 200);
        assert.equal(wide.body.totals.bookings, 5, "365d window includes the old booking (4 attributed + 1 AM-less)");
        assert.equal(wide.body.totals.bookingsAttributed, 4, "365d attributed bookings");
        assert.equal(wide.body.totals.bookingsUnattributed, 1, "AM-less booking still card-level in 365d");
        assert.equal(wide.body.totals.sms, 5, "365d window includes the old SMS (4 attributed + 1 sender-less)");
        assert.equal(wide.body.totals.smsAttributed, 4, "365d attributed SMS");
        assert.equal(wide.body.totals.calls, 3, "365d window includes the old call (2 attributed + 1 initiator-less)");
        assert.equal(wide.body.totals.callsAttributed, 2, "365d attributed calls");
        assert.equal(wide.body.totals.intel, 2, "365d window still excludes the 420d-old intel note");
        console.log("  ok  date-range filter honours the days parameter");

        // Task #4872 — all-time window: rows older than ANY numeric preset
        // (m6 at −400d, i3 at −420d — both beyond the 365-day cap) are
        // counted, `days` echoes the literal "all", and `since` /
        // `coverageStart` honestly report the earliest counted row instead
        // of a fake epoch or a sliding boundary.
        const all = await get(baseUrl, "/api/internal-usage?days=all");
        assert.equal(all.status, 200);
        assert.equal(all.body.days, "all", "echoes the all-time range as the literal 'all'");
        assert.equal(all.body.totals.bookings, 6, "all-time includes the 400d-old booking");
        assert.equal(all.body.totals.bookingsAttributed, 5, "all-time attributed bookings");
        assert.equal(all.body.totals.intel, 3, "all-time includes the 420d-old intel note");
        assert.equal(all.body.totals.sms, 5, "all-time sms matches 365d (nothing older seeded)");
        assert.equal(all.body.totals.agentChat, 3, "all-time chat total (assistant still excluded)");
        assert.ok(all.body.coverageStart, "all-time reports a coverage start");
        assert.equal(
          all.body.since,
          all.body.coverageStart,
          "all-time since = earliest counted row (honest, never an epoch placeholder)",
        );
        {
          const covMs = new Date(all.body.coverageStart).getTime();
          assert.ok(
            Math.abs(covMs - (Date.now() - 420 * 86_400_000)) < 2 * 86_400_000,
            `all-time coverage start ≈ the 420d-old intel row (got ${all.body.coverageStart})`,
          );
        }
        console.log("  ok  all-time window counts pre-preset history with an honest coverage start");
      } finally {
        server.close();
        __test_resetReconciledUsers();
      }
    },
    {
      tables: [
        "users",
        "clients",
        "scheduled_meetings",
        "twilio_conversations",
        "twilio_messages",
        "twilio_calls",
        "intelligence_feed_entries",
        "client_agent_chats",
      ],
      pinGetDbForCrossAsync: true,
    },
  );
}

main().then(
  () => {
    console.log("internal-usage-aggregation: all sections passed");
    process.exit(0);
  },
  (err) => {
    console.error("internal-usage-aggregation: FAILED —", err?.stack ?? err);
    process.exit(1);
  },
);
