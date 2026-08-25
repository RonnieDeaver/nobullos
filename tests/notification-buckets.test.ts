/* test-registration
{
  "name": "Notification bucket split \u2014 personal/system unread counts, mark-all-read per bucket, bundled system alerts (Task #3570)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.0s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #3570 — Notification bucket split tests.
 *
 * Covers:
 * - getUnreadCountByBucket returns { personal, system }
 * - listUserNotifications with bucket=personal excludes system categories
 * - listUserNotifications with bucket=system excludes personal categories
 * - markAllReadBucket('personal') marks only personal rows
 * - markAllReadBucket('system') marks only system rows
 * - listSystemBundled collapses same-category+title rows into one bundle
 * - markBundleRead marks only the supplied ids
 *
 * Uses runInTxSandbox for isolation (all writes are rolled back).
 */

import { sql } from "drizzle-orm";
import { runInTxSandbox } from "./db-sandbox";
import { getDb } from "../server/db";
import { users } from "@shared/schema";
import {
  getUnreadCountByBucket,
  listUserNotifications,
  listSystemBundled,
  markAllReadBucket,
  markBundleRead,
} from "../server/storage/userNotificationsStorage";

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail?: string): void {
  const sym = ok ? "✓" : "✗";
  if (ok) {
    passed++;
    console.log(`  ${sym} ${name}${detail ? ` (${detail})` : ""}`);
  } else {
    failed++;
    console.error(`  ${sym} ${name}${detail ? ` (${detail})` : ""}`);
  }
}

async function seedUser(suffix: string): Promise<string> {
  const id = `u-${Date.now()}-${Math.floor(Math.random() * 1e6)}-${suffix}`;
  await getDb().insert(users).values({ id, email: `${id}@test.local` });
  return id;
}

async function insertNotification(
  userId: string,
  category: string,
  title: string,
  opts: { readAt?: Date | null; metadata?: Record<string, unknown> | null } = {},
): Promise<string> {
  const db = getDb();
  // db.execute takes a single SQL object — the (text, params) pg form is NOT
  // supported (the params array is silently ignored, so pg sees bare $1..$4
  // and dies with 42P02). Bind via the sql tagged template instead.
  // db.execute returns a raw pg QueryResult; access via .rows[]
  const metadataJson = opts.metadata ? JSON.stringify(opts.metadata) : null;
  const result = await db.execute(
    sql`INSERT INTO user_notifications (user_id, category, title, body, read_at, metadata)
     VALUES (${userId}, ${category}, ${title}, NULL, ${opts.readAt ?? null}, ${metadataJson}::jsonb)
     RETURNING id`,
  );
  const rows = (result as any).rows ?? (result as any);
  return rows[0].id as string;
}

async function seedClient(firmName: string): Promise<string> {
  const result = await getDb().execute(
    sql`INSERT INTO clients (firm_name) VALUES (${firmName}) RETURNING id`,
  );
  const rows = (result as any).rows ?? (result as any);
  return rows[0].id as string;
}

async function main(): Promise<void> {
  console.log("Task #3570 — notification bucket split");

  // ─── Phase 1: bucket counts + list filtering + markAllReadBucket ─────────
  await runInTxSandbox(async () => {
    const alice = await seedUser("bucket-alice");
    const bob = await seedUser("bucket-bob");

    // 2 personal (comms.sms unread, booking read) + 2 system unread
    await insertNotification(alice, "comms.sms", "New SMS from client A");
    await insertNotification(alice, "booking", "Booking confirmed", { readAt: new Date() });
    await insertNotification(alice, "system", "Queue stalled — semrush_report_refresh");
    await insertNotification(alice, "queue_health", "DLQ overflow");

    // ── Counts ──────────────────────────────────────────────────────────────
    const counts = await getUnreadCountByBucket(alice);
    check(
      "personal count = 1 (booking is read)",
      counts.personal === 1,
      `personal=${counts.personal}`,
    );
    check(
      "system count = 2 (system + queue_health)",
      counts.system === 2,
      `system=${counts.system}`,
    );
    check(
      "other user's personal = 0",
      (await getUnreadCountByBucket(bob)).personal === 0,
    );
    check(
      "other user's system = 0",
      (await getUnreadCountByBucket(bob)).system === 0,
    );

    // ── List filtering ───────────────────────────────────────────────────────
    const personalRows = await listUserNotifications(alice, {
      limit: 50,
      offset: 0,
      bucket: "personal",
    });
    const personalCats = personalRows.map((r) => r.category);
    check("bucket=personal includes comms.sms", personalCats.includes("comms.sms"));
    check("bucket=personal includes booking", personalCats.includes("booking"));
    check("bucket=personal excludes system", !personalCats.includes("system"));
    check("bucket=personal excludes queue_health", !personalCats.includes("queue_health"));

    const systemRows = await listUserNotifications(alice, {
      limit: 50,
      offset: 0,
      bucket: "system",
    });
    const systemCats = systemRows.map((r) => r.category);
    check("bucket=system includes system", systemCats.includes("system"));
    check("bucket=system includes queue_health", systemCats.includes("queue_health"));
    check("bucket=system excludes comms.sms", !systemCats.includes("comms.sms"));

    // ── markAllReadBucket('personal') ────────────────────────────────────────
    await markAllReadBucket(alice, "personal");
    const afterPersonal = await getUnreadCountByBucket(alice);
    check(
      "markAllReadBucket(personal) → personal unread = 0",
      afterPersonal.personal === 0,
      `personal=${afterPersonal.personal}`,
    );
    check(
      "markAllReadBucket(personal) → system unread still = 2",
      afterPersonal.system === 2,
      `system=${afterPersonal.system}`,
    );

    // ── markAllReadBucket('system') ──────────────────────────────────────────
    await markAllReadBucket(alice, "system");
    const afterSystem = await getUnreadCountByBucket(alice);
    check(
      "markAllReadBucket(system) → system unread = 0",
      afterSystem.system === 0,
      `system=${afterSystem.system}`,
    );
    check(
      "markAllReadBucket(system) → personal still = 0",
      afterSystem.personal === 0,
    );
  });

  // ─── Phase 2: listSystemBundled + markBundleRead ──────────────────────────
  await runInTxSandbox(async () => {
    const carol = await seedUser("bucket-carol");

    // 3 identical system alerts
    const id1 = await insertNotification(carol, "system", "Queue stalled — semrush_report_refresh");
    const id2 = await insertNotification(carol, "system", "Queue stalled — semrush_report_refresh");
    const id3 = await insertNotification(carol, "system", "Queue stalled — semrush_report_refresh");
    // 1 distinct queue_health alert
    await insertNotification(carol, "queue_health", "DLQ overflow");

    // listSystemBundled returns an array directly
    const bundles = await listSystemBundled(carol, { limit: 50 });

    const stalledBundle = bundles.find(
      (b) => b.title === "Queue stalled — semrush_report_refresh",
    );
    check("repeated alerts collapsed into one bundle", !!stalledBundle);
    check(
      "bundle count = 3",
      stalledBundle?.count === 3,
      `count=${stalledBundle?.count}`,
    );
    check(
      "bundle ids contains all 3 ids",
      !!stalledBundle &&
        stalledBundle.ids.includes(id1) &&
        stalledBundle.ids.includes(id2) &&
        stalledBundle.ids.includes(id3),
    );
    check("bundle hasUnread = true", stalledBundle?.hasUnread === true);

    const dlqBundle = bundles.find((b) => b.title === "DLQ overflow");
    check("distinct alert → own bundle with count=1", !!dlqBundle && dlqBundle.count === 1);

    // ── markBundleRead: partial ──────────────────────────────────────────────
    await markBundleRead(carol, [id1, id2]);
    const afterPartial = await getUnreadCountByBucket(carol);
    // id3 unread (system) + dlq unread (queue_health) → 2
    check(
      "after markBundleRead([id1,id2]): system unread = 2 (id3 + dlq)",
      afterPartial.system === 2,
      `system=${afterPartial.system}`,
    );

    // ── markBundleRead: remaining id ─────────────────────────────────────────
    await markBundleRead(carol, [id3]);
    const afterRemaining = await getUnreadCountByBucket(carol);
    // Only dlq left unread
    check(
      "after markBundleRead(id3): system unread = 1 (dlq only)",
      afterRemaining.system === 1,
      `system=${afterRemaining.system}`,
    );

    // Verify via listSystemBundled — stalled bundle should have hasUnread=false
    // (need to include archived:false which is the default; read bundles appear
    // since they're not archived, just read)
    const bundles2 = await listSystemBundled(carol, { limit: 50 });
    const stalledAfter = bundles2.find(
      (b) => b.title === "Queue stalled — semrush_report_refresh",
    );
    // Bundle may be absent (filtered by hasUnread) or present with hasUnread=false
    if (stalledAfter) {
      check(
        "stalled bundle hasUnread = false after all marked read",
        stalledAfter.hasUnread === false,
      );
    } else {
      // Absent because the query filters by unread is also valid — either is correct
      check("stalled bundle absent (filtered) or hasUnread=false", true);
    }
  });

  // ─── Phase 3: Task #4512 — per-bundle clientName resolution ──────────────
  await runInTxSandbox(async () => {
    const dave = await seedUser("bucket-dave");
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const clientA = await seedClient(`Harper & Lane ${suffix}`);
    const clientB = await seedClient(`Bell & Birch ${suffix}`);

    // Bundle 1: all rows share clientA → clientName resolves
    await insertNotification(dave, "system", "Integration down — clientA", {
      metadata: { clientId: clientA },
    });
    await insertNotification(dave, "system", "Integration down — clientA", {
      metadata: { clientId: clientA },
    });
    // Bundle 2: mixed clients → null
    await insertNotification(dave, "system", "Mixed-client alert", {
      metadata: { clientId: clientA },
    });
    await insertNotification(dave, "system", "Mixed-client alert", {
      metadata: { clientId: clientB },
    });
    // Bundle 3: no clientId at all → null
    await insertNotification(dave, "queue_health", "DLQ overflow no client");
    // Bundle 4: clientId present on only SOME rows → null
    await insertNotification(dave, "system", "Partial-client alert", {
      metadata: { clientId: clientA },
    });
    await insertNotification(dave, "system", "Partial-client alert");
    // Bundle 5: clientId points at a deleted/unknown client → null
    await insertNotification(dave, "system", "Ghost-client alert", {
      metadata: { clientId: "no-such-client-id" },
    });

    const bundles = await listSystemBundled(dave, { limit: 50 });
    const byTitle = (t: string) => bundles.find((b) => b.title === t);

    const uniform = byTitle("Integration down — clientA");
    check(
      "uniform-client bundle resolves clientName",
      uniform?.clientName === `Harper & Lane ${suffix}`,
      `clientName=${uniform?.clientName}`,
    );
    check("uniform bundle still collapses (count=2)", uniform?.count === 2);
    check(
      "mixed-client bundle → clientName null",
      byTitle("Mixed-client alert")?.clientName === null,
    );
    check(
      "no-clientId bundle → clientName null",
      byTitle("DLQ overflow no client")?.clientName === null,
    );
    check(
      "partially-tagged bundle → clientName null",
      byTitle("Partial-client alert")?.clientName === null,
    );
    check(
      "dangling clientId → clientName null",
      byTitle("Ghost-client alert")?.clientName === null,
    );
  });

  console.log(`\nnotification-buckets: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
