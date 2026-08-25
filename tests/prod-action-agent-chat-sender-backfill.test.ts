/* test-registration
{
  "name": "Prod action: agent-chat sender backfill from activity evidence (Task #4872)",
  "regression": true,
  "sweepOnlyReason": "Task #4872 — evidence-based agent-chat sender backfill e2e: DB-heavy (runInIsolatedSchema: users, clients, client_agent_chats, user_activity_logs) press of the real prod action; runs in the full sweep, not the smoke gate.",
  "tier": "small"
}
test-registration */
/**
 * Task #4872 — `backfill_agent_chat_senders_from_activity`.
 *
 * Presses the real registered prod action against an isolated schema and
 * asserts the evidence rules end to end:
 *
 *   (a) straddle evidence stamps: same-user activity rows on the client's
 *       surface both before and after the chat timestamp within ±60min —
 *       including the NULL-session grouping (the pre-session-stamping era
 *       is exactly the history this backfill targets) and both the base
 *       `/clients/<id>` route and a subpath;
 *   (b) containment evidence stamps: a page_view row written on leave
 *       whose [timestamp − duration, timestamp] dwell interval contains
 *       the chat moment;
 *   (c) two plausible senders → ambiguous → row stays NULL (never guessed);
 *   (d) evidence entirely outside the ±60min window (both straddle rows
 *       beyond the bound, plus a page_view whose dwell does not reach the
 *       chat) counts as no-evidence → row stays NULL;
 *   (e) cross-session rows do NOT merge into a straddle (before-row in one
 *       session, after-row in another) → no candidate;
 *   (f) a sole candidate whose users row is deleted is NOT stamped
 *       (created_by_user_id carries an FK to users; attributing usage to
 *       an invisible member would strand the count);
 *   (g) CAS/operator-edit-wins: a row hand-attributed after the pending
 *       probe is skipped by apply (only-if-still-NULL) and keeps the
 *       operator's value;
 *   (h) assistant-role rows and already-attributed rows are never examined;
 *   (i) audited counts in status/apply details (examined / stampable /
 *       ambiguous / no-evidence / sole-not-live);
 *   (j) convergence: a second press reports not-needed and residual
 *       unattributable rows stay untouched;
 *   (k) pre-launch eligibility boundary: a user-role NULL-sender row
 *       created AFTER the sender-tracking launch cutoff is refused even
 *       with perfect straddle evidence — it signals a write-path defect,
 *       so it stays NULL and every status/apply detail surfaces it loudly
 *       instead of masking the regression by stamping it.
 *
 * Fixture times anchor on the exported AGENT_CHAT_SENDER_TRACKING_LIVE_SINCE
 * cutoff (T0 = cutoff − 90 days), NOT on NOW(): a clock-relative anchor
 * would silently drift across the cutoff as wall-clock time advances and
 * flip every pre-launch case post-launch.
 *
 * Runs inside `runInIsolatedSchema` with `pinGetDbForCrossAsync` because
 * the action reads/writes via `getDb()` — the clone keeps this suite from
 * scanning (or stamping!) live public rows. IDs carry a per-run random
 * suffix as defense in depth against search_path fallthrough.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import { PROD_ACTIONS } from "../server/services/prodActionsRegistry";
import { AGENT_CHAT_SENDER_TRACKING_LIVE_SINCE } from "../server/services/prodActions/platformOpsActions";
import { runInIsolatedSchema } from "./db-sandbox";

const RUN = randomUUID().slice(0, 8);
const U1 = `test-4872-u1-${RUN}`; // live user — straddle candidate
const U2 = `test-4872-u2-${RUN}`; // live user — containment candidate
const U3 = `test-4872-u3-${RUN}`; // live user — second ambiguous candidate / operator's manual pick
const U4 = `test-4872-u4-${RUN}`; // DELETED user — sole candidate that must not be stamped
const U5 = `test-4872-u5-${RUN}`; // live user — evidence candidate for the operator-edited row
const U6 = `test-4872-u6-${RUN}`; // live user — cross-session rows (no straddle)
const U7 = `test-4872-u7-${RUN}`; // live user — evidence only outside the window
const C1 = `test-4872-client-1-${RUN}`;
const C2 = `test-4872-client-2-${RUN}`;

const CH_STRADDLE = `test-4872-ch-straddle-${RUN}`;
const CH_CONTAIN = `test-4872-ch-contain-${RUN}`;
const CH_AMBIG = `test-4872-ch-ambig-${RUN}`;
const CH_NO_EVID = `test-4872-ch-noevid-${RUN}`;
const CH_SPLIT = `test-4872-ch-split-${RUN}`;
const CH_DELETED = `test-4872-ch-deleted-${RUN}`;
const CH_CAS = `test-4872-ch-cas-${RUN}`;
const CH_PREATTR = `test-4872-ch-preattr-${RUN}`;
const CH_ASSIST = `test-4872-ch-assist-${RUN}`;
const CH_POSTLAUNCH = `test-4872-ch-postlaunch-${RUN}`;

async function getSender(isoDb: any, chatId: string): Promise<string | null> {
  const r = await isoDb.execute(
    sql`SELECT created_by_user_id FROM client_agent_chats WHERE id = ${chatId}`,
  );
  return ((r.rows as any[])[0]?.created_by_user_id ?? null) as string | null;
}

async function main(): Promise<void> {
  const action = PROD_ACTIONS.find(
    (a) => a.id === "backfill_agent_chat_senders_from_activity",
  );
  assert.ok(action, "backfill_agent_chat_senders_from_activity must be registered");

  await runInIsolatedSchema(
    async ({ db: isoDb }) => {
      // ── Users (U4 deleted) ──
      await isoDb.execute(sql`
        INSERT INTO users (id, role, authority_level, first_name, last_name, deleted_at)
        VALUES
          (${U1}, 'account_manager', 'core', 'Uma', 'One', NULL),
          (${U2}, 'account_manager', 'core', 'Uri', 'Two', NULL),
          (${U3}, 'account_manager', 'core', 'Ute', 'Three', NULL),
          (${U4}, 'account_manager', 'core', 'Ude', 'Gone', NOW()),
          (${U5}, 'account_manager', 'core', 'Ulf', 'Five', NULL),
          (${U6}, 'account_manager', 'core', 'Una', 'Six', NULL),
          (${U7}, 'account_manager', 'core', 'Uwe', 'Seven', NULL)
      `);
      await isoDb.execute(sql`
        INSERT INTO clients (id, firm_name, owner_id, is_archived, is_demo)
        VALUES
          (${C1}, ${'Backfill Firm One ' + RUN}, ${U1}, false, false),
          (${C2}, ${'Backfill Firm Two ' + RUN}, ${U1}, false, false)
      `);

      // ── Chats (base time T0 = launch cutoff − 90d; one day apart per
      // case so evidence windows can never cross-contaminate; day 95 sits
      // 5 days AFTER the cutoff for the post-launch refusal case) ──
      const chat = (id: string, client: string, role: string, sender: string | null, daysAfterT0: number) => sql`
        (${id}, ${client}, ${role}, ${'msg ' + id}, ${sender},
         ${AGENT_CHAT_SENDER_TRACKING_LIVE_SINCE}::timestamptz - interval '90 days' + make_interval(days => ${daysAfterT0}))
      `;
      await isoDb.execute(sql`
        INSERT INTO client_agent_chats (id, client_id, role, content, created_by_user_id, created_at)
        VALUES
          ${chat(CH_STRADDLE, C1, "user", null, 0)},
          ${chat(CH_CONTAIN, C1, "user", null, 1)},
          ${chat(CH_AMBIG, C1, "user", null, 2)},
          ${chat(CH_NO_EVID, C2, "user", null, 3)},
          ${chat(CH_SPLIT, C2, "user", null, 4)},
          ${chat(CH_DELETED, C2, "user", null, 5)},
          ${chat(CH_CAS, C2, "user", null, 6)},
          ${chat(CH_PREATTR, C1, "user", U1, 0)},
          ${chat(CH_ASSIST, C1, "assistant", null, 0)},
          ${chat(CH_POSTLAUNCH, C1, "user", null, 95)}
      `);

      // ── Activity evidence ──
      // Rows are positioned relative to each chat's created_at via the same
      // T0 + N days anchor, offset by minutes/seconds.
      const evid = (
        user: string,
        route: string,
        session: string | null,
        actionType: string,
        duration: number | null,
        daysAfterT0: number,
        offsetSeconds: number,
      ) => sql`
        (${user}, ${actionType}, ${route}, ${session}, ${duration},
         ${AGENT_CHAT_SENDER_TRACKING_LIVE_SINCE}::timestamptz - interval '90 days' + make_interval(days => ${daysAfterT0}, secs => ${offsetSeconds}))
      `;
      await isoDb.execute(sql`
        INSERT INTO user_activity_logs (user_id, action_type, route, session_id, duration, timestamp)
        VALUES
          -- (a) straddle for CH_STRADDLE: NULL session era, base route before,
          -- subpath route after (±10min).
          ${evid(U1, `/clients/${C1}`, null, "click", null, 0, -600)},
          ${evid(U1, `/clients/${C1}/intel`, null, "click", null, 0, 600)},
          -- (b) containment for CH_CONTAIN: page_view written on leave at
          -- +55s with a 79s dwell → interval [−24s, +55s] contains the chat.
          ${evid(U2, `/clients/${C1}`, `sess-pv-${RUN}`, "page_view", 79, 1, 55)},
          -- (c) ambiguity for CH_AMBIG: two users straddle it.
          ${evid(U1, `/clients/${C1}`, `sess-a1-${RUN}`, "click", null, 2, -300)},
          ${evid(U1, `/clients/${C1}`, `sess-a1-${RUN}`, "click", null, 2, 300)},
          ${evid(U3, `/clients/${C1}`, `sess-a3-${RUN}`, "click", null, 2, -360)},
          ${evid(U3, `/clients/${C1}`, `sess-a3-${RUN}`, "click", null, 2, 360)},
          -- (d) CH_NO_EVID: rows exist but all outside the evidence bar —
          -- straddle rows beyond ±60min, and a page_view whose 60s dwell
          -- (leave at +50min) never reaches back to the chat moment.
          ${evid(U7, `/clients/${C2}`, `sess-n-${RUN}`, "click", null, 3, -5400)},
          ${evid(U7, `/clients/${C2}`, `sess-n-${RUN}`, "click", null, 3, 5400)},
          ${evid(U7, `/clients/${C2}`, `sess-n-${RUN}`, "page_view", 60, 3, 3000)},
          -- (e) CH_SPLIT: before-row and after-row in DIFFERENT sessions —
          -- session-scoped straddle must not merge them.
          ${evid(U6, `/clients/${C2}`, `sess-x-${RUN}`, "click", null, 4, -300)},
          ${evid(U6, `/clients/${C2}`, `sess-y-${RUN}`, "click", null, 4, 300)},
          -- (f) CH_DELETED: clean straddle, but by a deleted user.
          ${evid(U4, `/clients/${C2}`, `sess-d-${RUN}`, "click", null, 5, -300)},
          ${evid(U4, `/clients/${C2}`, `sess-d-${RUN}`, "click", null, 5, 300)},
          -- (g) CH_CAS: clean straddle by U5 — but an operator will
          -- hand-attribute the row to U3 before apply.
          ${evid(U5, `/clients/${C2}`, `sess-c-${RUN}`, "click", null, 6, -300)},
          ${evid(U5, `/clients/${C2}`, `sess-c-${RUN}`, "click", null, 6, 300)},
          -- (k) CH_POSTLAUNCH: PERFECT straddle evidence by U1 — but the
          -- chat sits after the launch cutoff, so eligibility (not lack of
          -- evidence) must be what refuses it.
          ${evid(U1, `/clients/${C1}`, `sess-post-${RUN}`, "click", null, 95, -300)},
          ${evid(U1, `/clients/${C1}`, `sess-post-${RUN}`, "click", null, 95, 300)}
      `);

      // ── status(): pending with honest audited counts ──
      const status1 = await action!.status();
      assert.equal(status1.state, "pending", `expected pending, got ${status1.state}: ${status1.detail}`);
      assert.ok(
        status1.detail?.includes("3 of 7"),
        `status must audit 3 stampable of 7 examined (got: ${status1.detail})`,
      );
      assert.ok(
        status1.detail?.includes("1 ambiguous"),
        `status must audit the ambiguous row (got: ${status1.detail})`,
      );
      assert.ok(
        status1.detail?.includes("2 with no activity-log evidence"),
        `status must audit the no-evidence rows (got: ${status1.detail})`,
      );
      assert.ok(
        status1.detail?.includes("1 whose sole candidate is not a live users row"),
        `status must audit the deleted-user candidate (got: ${status1.detail})`,
      );
      assert.ok(
        status1.detail?.includes("1 user-role chat row(s) created on/after the sender-tracking launch cutoff") &&
          status1.detail?.includes("write-path defect"),
        `(k) status must surface the post-launch NULL row as a write-path defect, not examine it (got: ${status1.detail})`,
      );
      console.log(`  ok  status=pending with audited counts (${status1.detail})`);

      // ── Operator edit between probe and press: CAS must let it win ──
      await isoDb.execute(sql`
        UPDATE client_agent_chats SET created_by_user_id = ${U3} WHERE id = ${CH_CAS}
      `);

      // ── apply(): stamps exactly the evidence-backed rows ──
      const apply1 = await action!.apply();
      assert.equal(apply1.state, "applied", `expected applied, got ${apply1.state}: ${apply1.detail}`);
      assert.equal(apply1.rowsAffected, 2, "exactly the two evidence-backed rows are stamped");
      assert.ok(
        apply1.detail?.includes("Examined 6"),
        `apply must audit the examined count after the operator edit (got: ${apply1.detail})`,
      );
      assert.ok(
        apply1.detail?.includes("stamped 2"),
        `apply must audit the stamped count (got: ${apply1.detail})`,
      );
      assert.ok(
        apply1.detail?.includes(CH_STRADDLE) && apply1.detail?.includes(CH_CONTAIN),
        `apply must list the stamped chat ids (got: ${apply1.detail})`,
      );
      assert.ok(
        apply1.detail?.includes("1 user-role chat row(s) created on/after the sender-tracking launch cutoff"),
        `(k) apply must keep the post-launch defect note in its audit (got: ${apply1.detail})`,
      );
      console.log(`  ok  apply=applied (${apply1.detail})`);

      // ── Row-level outcomes ──
      assert.equal(await getSender(isoDb, CH_STRADDLE), U1, "(a) straddle evidence stamps U1");
      assert.equal(await getSender(isoDb, CH_CONTAIN), U2, "(b) containment evidence stamps U2");
      assert.equal(await getSender(isoDb, CH_AMBIG), null, "(c) ambiguous row stays NULL — never guessed");
      assert.equal(await getSender(isoDb, CH_NO_EVID), null, "(d) out-of-window evidence does not stamp");
      assert.equal(await getSender(isoDb, CH_SPLIT), null, "(e) cross-session rows do not form a straddle");
      assert.equal(await getSender(isoDb, CH_DELETED), null, "(f) deleted-user sole candidate is not stamped");
      assert.equal(await getSender(isoDb, CH_CAS), U3, "(g) operator's manual attribution wins over the press");
      assert.equal(await getSender(isoDb, CH_PREATTR), U1, "(h) already-attributed row untouched");
      assert.equal(await getSender(isoDb, CH_ASSIST), null, "(h) assistant-role row never examined");
      assert.equal(
        await getSender(isoDb, CH_POSTLAUNCH),
        null,
        "(k) post-launch NULL row is refused despite perfect evidence — stays visible for investigation",
      );
      console.log("  ok  row-level outcomes: stamps, refusals, CAS, post-launch refusal");

      // ── Convergence: second press is a no-op; residuals stay put ──
      const apply2 = await action!.apply();
      assert.equal(apply2.state, "not-needed", `second press must converge, got ${apply2.state}: ${apply2.detail}`);
      const status2 = await action!.status();
      assert.equal(status2.state, "not-needed", `post-press status must converge, got ${status2.state}`);
      assert.ok(
        status2.detail?.includes("none meet the evidence bar"),
        `converged status explains the honest residual (got: ${status2.detail})`,
      );
      assert.ok(
        status2.detail?.includes("1 user-role chat row(s) created on/after the sender-tracking launch cutoff"),
        `(k) the post-launch defect note must persist after convergence — the signal never disappears (got: ${status2.detail})`,
      );
      assert.equal(await getSender(isoDb, CH_AMBIG), null, "(j) residual ambiguous row still NULL after re-press");
      console.log(`  ok  second press converges to not-needed (${status2.detail})`);
    },
    {
      tables: ["users", "clients", "client_agent_chats", "user_activity_logs"],
      pinGetDbForCrossAsync: true,
    },
  );
}

main().then(
  () => {
    console.log("prod-action-agent-chat-sender-backfill: all sections passed");
    process.exit(0);
  },
  (err) => {
    console.error("prod-action-agent-chat-sender-backfill: FAILED —", err?.stack ?? err);
    process.exit(1);
  },
);
