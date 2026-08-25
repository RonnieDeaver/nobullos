/* test-registration
{
  "name": "Client file trash retention purge (Task #4023)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4023: retention sweep for client-file Trash — default-OFF master switch honored, expired-only selection (fresh trash untouched), objects-deleted-FIRST ordering with per-file failure isolation (a failed storage delete keeps the DB row for retry; the next clean tick purges it), version objects included in the delete fan-out, and purged-row activity attributed to the retention sweep. A drift here either deletes restorable files early or strands paid storage forever.",
  "tier": "small"
}
test-registration */
/**
 * Task #4023 — Retention purge sweep for client-file Trash.
 *
 * Exercises runClientFileTrashPurgeTick against real DB rows (created via
 * the real claimUploadedFile/trashFiles service paths, then backdated with
 * SQL) with an injected deleteObject recorder so no bucket is touched:
 *
 *   1. Disabled by default — with no system-setting row and no force env,
 *      the tick reports enabled=false and deletes NOTHING.
 *   2. Objects first, rows second — with CLIENT_FILE_TRASH_PURGE_FORCE_ENABLE
 *      set, an expired file is purged only after ALL its objects (current
 *      content + prior version) were deleted; the version object is part of
 *      the fan-out. The purged file leaves a client-level "purged" activity
 *      row attributed to the Retention sweep (via=retention_sweep).
 *   3. Failure isolation — a file whose storage delete throws is counted in
 *      filesWithErrors and its DB row is RETAINED (still restorable /
 *      retryable); the next tick with a healthy store purges it.
 *   4. Retention window — freshly-trashed files are never selected; their
 *      objects are never deleted.
 *
 * The force-enable env var is captured and restored in finally so the
 * global switch never leaks into other suites (the master system setting
 * itself is never written — the env bypass keeps this suite setting-free).
 */

import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";

import { db } from "../server/db";
import { runClientFileTrashPurgeTick } from "../server/services/clientFileTrashPurge";
import {
  claimUploadedFile,
  trashFiles,
  type FileActor,
} from "../server/services/clientFileService";

const HEX = randomBytes(4).toString("hex");
const RUN = `t4023p-${HEX}`;
const USER_ID = `${RUN}-sweeper`;
const CLIENT_ID = `d4023d04-${HEX}-${randomBytes(3).toString("hex")}`;
const ACTOR: FileActor = { id: USER_ID, name: "Task4023 Sweeper" };

const KEY_A1 = `client-files/${CLIENT_ID}/${randomBytes(8).toString("hex")}`; // becomes the version
const KEY_A2 = `client-files/${CLIENT_ID}/${randomBytes(8).toString("hex")}`; // current content
const KEY_B = `client-files/${CLIENT_ID}/${randomBytes(8).toString("hex")}`;
const KEY_C = `client-files/${CLIENT_ID}/${randomBytes(8).toString("hex")}`;

function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

async function fileExists(fileId: string): Promise<boolean> {
  const r = await db.execute(sql`SELECT 1 FROM client_files WHERE id = ${fileId}`);
  return (r as any).rows.length > 0;
}

async function versionCount(fileId: string): Promise<number> {
  const r = await db.execute(
    sql`SELECT count(*)::int AS n FROM client_file_versions WHERE file_id = ${fileId}`,
  );
  return (r as any).rows[0].n as number;
}

let failures = 0;
async function step(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err: any) {
    failures += 1;
    console.error(`  ✗ ${name}`);
    console.error(`      ${err?.message ?? err}`);
  }
}

async function main(): Promise<void> {
  const originalForce = process.env.CLIENT_FILE_TRASH_PURGE_FORCE_ENABLE;
  delete process.env.CLIENT_FILE_TRASH_PURGE_FORCE_ENABLE;

  let fileA = "";
  let fileB = "";
  let fileC = "";

  try {
    await db.execute(sql`
      INSERT INTO users (id, email, first_name, last_name, role, authority_level)
      VALUES (${USER_ID}, ${`${USER_ID}@t4023.example`}, 'Task4023', 'Sweeper', 'account_manager', 'core')
    `);
    await db.execute(sql`
      INSERT INTO clients (id, firm_name, owner_id, is_archived, is_demo)
      VALUES (${CLIENT_ID}, ${`${RUN} Purge Firm`}, ${USER_ID}, false, false)
    `);

    // fileA: two same-name claims → current KEY_A2 + version row KEY_A1.
    const a1 = await claimUploadedFile({
      clientId: CLIENT_ID,
      folderId: null,
      name: `${RUN}-old.txt`,
      objectKey: KEY_A1,
      mimeType: "text/plain",
      sizeBytes: 11,
      actor: ACTOR,
    });
    fileA = a1.file.id;
    const a2 = await claimUploadedFile({
      clientId: CLIENT_ID,
      folderId: null,
      name: `${RUN}-old.txt`,
      objectKey: KEY_A2,
      mimeType: "text/plain",
      sizeBytes: 13,
      actor: ACTOR,
    });
    assertEq(a2.file.id, fileA, "same-name claim superseded fileA");
    assertEq(a2.supersededVersionNumber, 1, "fileA has a prior version");

    const b = await claimUploadedFile({
      clientId: CLIENT_ID,
      folderId: null,
      name: `${RUN}-stuck.bin`,
      objectKey: KEY_B,
      mimeType: "application/octet-stream",
      sizeBytes: 7,
      actor: ACTOR,
    });
    fileB = b.file.id;
    const c = await claimUploadedFile({
      clientId: CLIENT_ID,
      folderId: null,
      name: `${RUN}-fresh.txt`,
      objectKey: KEY_C,
      mimeType: "text/plain",
      sizeBytes: 5,
      actor: ACTOR,
    });
    fileC = c.file.id;

    // Trash all three, then backdate A and B past the 30-day default window.
    await trashFiles({ clientId: CLIENT_ID, fileIds: [fileA, fileB, fileC], actor: ACTOR });
    await db.execute(sql`
      UPDATE client_files SET trashed_at = now() - interval '40 days'
      WHERE id IN (${fileA}, ${fileB})
    `);

    await step("tick is a no-op while the master switch is off", async () => {
      const deleted: string[] = [];
      const result = await runClientFileTrashPurgeTick({
        deleteObject: async (key) => {
          deleted.push(key);
          return true;
        },
      });
      assertEq(result.enabled, false, "disabled by default");
      assertEq(result.reason, "purge disabled in system_settings", "disabled reason");
      assertEq(deleted.length, 0, "no objects touched while disabled");
      assert(await fileExists(fileA), "fileA row intact while disabled");
    });

    process.env.CLIENT_FILE_TRASH_PURGE_FORCE_ENABLE = "1";

    await step("expired files purge objects-first; failures retain the row", async () => {
      const deleted: string[] = [];
      const result = await runClientFileTrashPurgeTick({
        deleteObject: async (key) => {
          if (key === KEY_B) throw new Error("simulated storage outage");
          deleted.push(key);
          return true;
        },
      });
      assertEq(result.enabled, true, "force-enabled");
      assertEq(result.expired, 2, "only the two backdated files selected");
      assertEq(result.purgedFiles, 1, "one file fully purged");
      assertEq(result.filesWithErrors, 1, "one file blocked by the failed delete");
      assert(deleted.includes(KEY_A2), "current object deleted");
      assert(deleted.includes(KEY_A1), "version object included in the fan-out");
      assert(!deleted.includes(KEY_C), "fresh trash never touched");
      assertEq(await fileExists(fileA), false, "purged row gone");
      assertEq(await versionCount(fileA), 0, "version rows cascaded away");
      assertEq(await fileExists(fileB), true, "failed file RETAINED for retry");
      assertEq(await fileExists(fileC), true, "fresh trash retained");

      const activity = await db.execute(sql`
        SELECT action, actor_name, file_id, detail
        FROM client_file_activity
        WHERE client_id = ${CLIENT_ID} AND action = 'purged'
      `);
      const rows = (activity as any).rows;
      assertEq(rows.length, 1, "one purged activity row");
      assertEq(rows[0].actor_name, "Retention sweep", "attributed to the sweep");
      assertEq(rows[0].file_id, null, "client-level entry survives the file row");
      const detail = typeof rows[0].detail === "string" ? JSON.parse(rows[0].detail) : rows[0].detail;
      assertEq(detail.via, "retention_sweep", "via recorded");
      assertEq(detail.name, `${RUN}-old.txt`, "purged file name recorded");
    });

    await step("next healthy tick purges the previously-failed file", async () => {
      const deleted: string[] = [];
      const result = await runClientFileTrashPurgeTick({
        deleteObject: async (key) => {
          deleted.push(key);
          return true;
        },
      });
      assertEq(result.purgedFiles, 1, "retry purged fileB");
      assert(deleted.includes(KEY_B), "fileB object deleted on retry");
      assertEq(await fileExists(fileB), false, "fileB row gone after retry");
      assertEq(await fileExists(fileC), true, "fresh trash STILL retained");
    });
  } finally {
    if (originalForce === undefined) {
      delete process.env.CLIENT_FILE_TRASH_PURGE_FORCE_ENABLE;
    } else {
      process.env.CLIENT_FILE_TRASH_PURGE_FORCE_ENABLE = originalForce;
    }
    try {
      await db.execute(sql`DELETE FROM clients WHERE id = ${CLIENT_ID}`);
    } catch {}
    try {
      await db.execute(sql`DELETE FROM users WHERE id = ${USER_ID}`);
    } catch {}
  }

  if (failures > 0) throw new Error(`${failures} test step(s) failed`);
  console.log("\nAll client-file purge tests passed");
}

let exitCode = 0;
main()
  .catch((err) => {
    console.error("client-files-purge: FAILED");
    console.error(err?.message ?? err);
    exitCode = 1;
  })
  .finally(() => {
    process.exitCode = exitCode;
  });
