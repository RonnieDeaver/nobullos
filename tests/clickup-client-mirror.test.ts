/* test-registration
{
  "name": "ClickUp client lifecycle mirror — durable intent, ambiguity adoption, drift refusal, and safe retry predicates (Task #5245)",
  "tier": "medium",
  "tierReason": "The suite keeps the medium tier because its hermetic database setup and lifecycle-claim adapter path exercise a heavier resource boundary than its short last measured duration suggests.",
  "smoke": true,
  "regression": true,
  "smokeReason": "Hermetic DB plus an injected adapter exercises the production claim/process/finalize path with zero network egress, covering timeout-after-success adoption and review-state safety in one bounded suite.",
  "scanPaths": [
    "server/routes/serviceDesk/departments.ts",
    "client/src/pages/admin/RoleAssignments.tsx"
  ]
}
test-registration */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { getDb, runWithWorkerDb } from "../server/db";
import {
  __test_setClientMirrorDeps,
  claimClientMirrorCommand,
  listClientMirrorStatuses,
  processClientMirrorCommand,
  retryClientMirrorCommand,
  type ClientMirrorDeps,
} from "../server/services/clickUpClientMirror";
import {
  clientMirrorRevision,
  stageClientMirrorIntentInTx,
} from "../server/services/clickUpClientMirrorKick";
import {
  clientIdentityMarker,
  ClientMirrorVendorError,
  type RemoteClientParent,
} from "../server/services/clickUpClientMirrorClient";
import { CANONICAL_PRODUCTION_LIST_ID } from "../server/services/adsOs/paidSearchRoleContract";
import { isKillSwitchEnabled, setKillSwitch } from "../server/services/killSwitches";

const db = getDb();
async function clean() {
  await db.execute(sql`DELETE FROM work_queue WHERE queue_name = 'clickup_client_mirror'`);
  await db.execute(sql`DELETE FROM cu_client_list_mappings`);
  await db.execute(sql`DELETE FROM cu_client_mirror_commands`);
}

function remote(clientId: string, overrides: Partial<RemoteClientParent> = {}): RemoteClientParent {
  return {
    id: `task-${clientId}`,
    name: `Name ${clientId}`,
    description: clientIdentityMarker(clientId),
    archived: false,
    listId: CANONICAL_PRODUCTION_LIST_ID,
    parentId: null,
    ...overrides,
  };
}

async function stage(clientId: string, name: string, archived = false) {
  await db.transaction((tx) => stageClientMirrorIntentInTx(tx, {
    clientId,
    desiredName: name,
    desiredArchived: archived,
  }));
}

await runWithWorkerDb(async () => {
  await clean();
  const priorProjectionKillSwitch = isKillSwitchEnabled("clickup_role_projection");
  try {
    // Same desired revision is a true no-op: it preserves the first wake and
    // does not reset command state.
    await stage("mirror-a", "Alpha");
    await stage("mirror-a", "Alpha");
    const staged = await db.execute(sql`
      SELECT c.revision, count(w.id)::int AS wakes
      FROM cu_client_mirror_commands c
      JOIN work_queue w ON w.dedupe_key LIKE 'clickup_client_mirror:mirror-a:%'
      WHERE c.client_id='mirror-a' GROUP BY c.revision
    `);
    assert.equal((staged.rows as any[])[0].revision, clientMirrorRevision({
      clientId: "mirror-a", desiredName: "Alpha", desiredArchived: false,
    }));
    assert.equal((staged.rows as any[])[0].wakes, 1);

    // Timeout-after-success: first attempt becomes ambiguous; retry performs a
    // fresh marker lookup and adopts the one existing parent without create.
    let creates = 0;
    let visible: RemoteClientParent[] = [];
    const deps: ClientMirrorDeps = {
      killSwitchActive: async () => false,
      findByMarker: async () => visible,
      getParent: async () => { throw new Error("unexpected mapped read"); },
      createParent: async (clientId) => {
        creates++;
        visible = [remote(clientId, { name: "Alpha" })];
        throw new ClientMirrorVendorError("lost create response", "timeout", true);
      },
      updateParent: async () => {},
    };
    const concurrentClaims = await Promise.all([
      claimClientMirrorCommand(),
      claimClientMirrorCommand(),
    ]);
    assert.equal(concurrentClaims.filter(Boolean).length, 1);
    let command = concurrentClaims[0] ?? concurrentClaims[1];
    assert(command);
    await processClientMirrorCommand(command, deps);
    await db.execute(sql`
      UPDATE cu_client_mirror_commands SET next_attempt_at='2000-01-01'::timestamp
      WHERE client_id='mirror-a'
    `);
    const afterAmbiguous = await db.execute(sql`
      SELECT status, attempt_count, max_attempts, terminal_at, lease_token,
             next_attempt_at, last_error_code
      FROM cu_client_mirror_commands WHERE client_id='mirror-a'
    `);
    command = await claimClientMirrorCommand();
    assert(command, JSON.stringify(afterAmbiguous.rows));
    await processClientMirrorCommand(command, deps);
    assert.equal(creates, 1);
    const synced = await listClientMirrorStatuses();
    assert.equal(synced.find((row) => row.clientId === "mirror-a")?.status, "synced");

    // A direct ClickUp rename does not get overwritten; it becomes reviewable.
    await stage("mirror-b", "Bravo New");
    await db.execute(sql`
      INSERT INTO cu_client_list_mappings
        (client_id,list_id,task_id,provenance,sync_state,ownership_verified_at,owned_name,owned_archived)
      VALUES ('mirror-b',${CANONICAL_PRODUCTION_LIST_ID},'task-mirror-b','{}','verified',now(),'Bravo Old',false)
    `);
    command = await claimClientMirrorCommand();
    assert(command);
    let writes = 0;
    await processClientMirrorCommand(command, {
      ...deps,
      getParent: async () => remote("mirror-b", { name: "Changed in ClickUp" }),
      updateParent: async () => { writes++; },
    });
    assert.equal(writes, 0);
    assert.equal((await listClientMirrorStatuses()).find((row) => row.clientId === "mirror-b")?.status, "drift");

    // Wrong-list mappings refuse all egress.
    await stage("mirror-c", "Charlie");
    await db.execute(sql`
      INSERT INTO cu_client_list_mappings
        (client_id,list_id,task_id,provenance,sync_state,ownership_verified_at)
      VALUES ('mirror-c','wrong-list','wrong-task','{}','verified',now())
    `);
    command = await claimClientMirrorCommand();
    assert(command);
    let egress = 0;
    await processClientMirrorCommand(command, {
      ...deps,
      findByMarker: async () => { egress++; return []; },
      getParent: async () => { egress++; return remote("mirror-c"); },
    });
    assert.equal(egress, 0);

    // Only safe terminal failures can be manually retried. Drift and ambiguity
    // are intentionally excluded, and the predicate also requires no lease.
    await db.execute(sql`
      INSERT INTO cu_client_mirror_commands
        (client_id,desired_name,desired_archived,revision,status,last_error_code,terminal_at)
      VALUES ('mirror-d','Delta',false,'r','failed','timeout',now())
    `);
    const status = (await listClientMirrorStatuses()).find((row) => row.clientId === "mirror-d");
    assert.equal(status?.retryEligible, true);
    assert.equal(await retryClientMirrorCommand(status!.id), true);
    assert.equal(await retryClientMirrorCommand(status!.id), false);
    await setKillSwitch("clickup_role_projection", true, "test");
    assert.equal(
      await retryClientMirrorCommand(status!.id),
      false,
      "the server-side safe retry predicate must honor the shared ClickUp kill switch",
    );

    // The operator surface is deliberately read-only for review states: it
    // shows every durable status and delegates the final retry decision to the
    // server rather than letting the browser reset ambiguity or drift.
    const routeSource = readFileSync("server/routes/serviceDesk/departments.ts", "utf8");
    assert.match(
      routeSource,
      /app\.get\(\s*"\/api\/service-desk\/client-mirror\/status",\s*isAuthenticated,\s*requireTeamLead/s,
    );
    assert.match(
      routeSource,
      /app\.post\(\s*"\/api\/service-desk\/client-mirror\/:commandId\/retry",\s*isAuthenticated,\s*requireTeamLead/s,
    );
    assert.match(routeSource, /retryClientMirrorCommand\(parsed\.data\.commandId\)/);
    const pageSource = readFileSync("client/src/pages/admin/RoleAssignments.tsx", "utf8");
    assert.match(pageSource, /data-testid="client-mirror-status-section"/);
    assert.match(pageSource, /row\.retryEligible &&/);
    assert.match(pageSource, /query\.isError/);
  } finally {
    await setKillSwitch("clickup_role_projection", priorProjectionKillSwitch, "test");
    __test_setClientMirrorDeps(null);
    await clean();
  }
});

console.log("clickup-client-mirror: all tests passed (Task #5245).");