/* test-registration
{
  "name": "Notification recipient helpers (Task #1688)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.0s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
// Task #1688 — recipient-resolution helpers.
// Verifies the helpers in server/services/notifications/recipients.ts:
//   - getClientAccountManagers / getConversationOwners
//   - getAssignedUserForThread
//   - getRoutedCallUser (routed user + AM fallback)
//   - getResponsibleAdminsForAlert
//   - resolveMentionsToUserIds
//   - excludeActor
// Usage: tsx tests/notification-recipients.test.ts

import { runInTxSandbox } from "./db-sandbox";
import { getDb } from "../server/db";
import {
  clients,
  threadAssignments,
  twilioCalls,
  twilioConversations,
  users,
} from "@shared/schema";
import {
  excludeActor,
  getAssignedUserForThread,
  getClientAccountManagers,
  getConversationOwners,
  getResponsibleAdminsForAlert,
  getRoutedCallUser,
  resolveMentionsToUserIds,
} from "../server/services/notifications/recipients";

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

async function seedUser(args: {
  suffix: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  role?: string;
}): Promise<string> {
  const id = `u-${Date.now()}-${Math.floor(Math.random() * 1e6)}-${args.suffix}`;
  await getDb().insert(users).values({
    id,
    email: args.email ?? `${id}@test.local`,
    firstName: args.firstName ?? null,
    lastName: args.lastName ?? null,
    role: (args.role as any) ?? "specialist",
  });
  return id;
}

async function main(): Promise<void> {
  console.log("Task #1688 — notification recipient helpers");

  await runInTxSandbox(async () => {
    const am = await seedUser({ suffix: "am" });
    const assignee = await seedUser({ suffix: "as" });
    const routed = await seedUser({ suffix: "rt" });
    const ceo = await seedUser({ suffix: "ceo", role: "ceo" });
    const lead = await seedUser({ suffix: "lead", role: "team_lead" });
    const writer = await seedUser({ suffix: "w" });
    const mentioned = await seedUser({
      suffix: "m",
      email: "jane.doe@firm.test",
      firstName: "Jane",
      lastName: "Doe",
    });

    // Empty / missing inputs return [].
    check("getClientAccountManagers(null) → []",
      (await getClientAccountManagers(null)).length === 0);
    check("getAssignedUserForThread('') → []",
      (await getAssignedUserForThread("")).length === 0);
    check("resolveMentionsToUserIds(null) → []",
      (await resolveMentionsToUserIds(null)).length === 0);
    check("getRoutedCallUser({}) → []",
      (await getRoutedCallUser({})).length === 0);

    // Seed a client + thread assignment + call.
    const clientRows = await getDb()
      .insert(clients)
      .values({ firmName: "Acme Law", ownerId: am })
      .returning({ id: clients.id });
    const clientId = clientRows[0].id;

    const threadKey = `direct:+15550001111:+15550002222`;
    // twilio_conversations row required because threadAssignments references it
    // by directThreadKey via the unified-key model used elsewhere; the
    // helper itself only reads thread_assignments.
    await getDb()
      .insert(twilioConversations)
      .values({
        id: `conv-${Date.now()}`,
        contactNumber: "+15550001111",
        contactPhone: "+15550001111",
        twilioPhoneNumber: "+15550002222",
        directThreadKey: threadKey,
      } as any)
      .onConflictDoNothing();
    await getDb().insert(threadAssignments).values({
      threadKey,
      assignedToUserId: assignee,
      status: "open",
      updatedByUserId: assignee,
    });

    const ams = await getClientAccountManagers(clientId);
    check("getClientAccountManagers returns the client owner",
      ams.length === 1 && ams[0] === am);

    const assignees = await getAssignedUserForThread(threadKey);
    check("getAssignedUserForThread returns the row's assignee",
      assignees.length === 1 && assignees[0] === assignee);

    const owners = await getConversationOwners({ threadKey, clientId });
    check("getConversationOwners merges assignee + AM (deduped)",
      owners.length === 2 && owners.includes(am) && owners.includes(assignee));

    // Routed call → returns the routed user.
    const callId = `call-${Date.now()}`;
    await getDb().insert(twilioCalls).values({
      id: callId,
      twilioSid: `CA${Date.now()}`,
      fromNumber: "+15550001111",
      toNumber: "+15550002222",
      direction: "inbound",
      routedToUserId: routed,
      clientId,
    } as any);
    const routedOut = await getRoutedCallUser({ callId, clientId });
    check("getRoutedCallUser prefers routedToUserId over AM",
      routedOut.length === 1 && routedOut[0] === routed);

    // Routed call with no routed user → AM fallback.
    const callId2 = `call-${Date.now()}-2`;
    await getDb().insert(twilioCalls).values({
      id: callId2,
      twilioSid: `CA${Date.now()}-2`,
      fromNumber: "+15550001111",
      toNumber: "+15550002222",
      direction: "inbound",
      clientId,
    } as any);
    const fallback = await getRoutedCallUser({ callId: callId2 });
    check("getRoutedCallUser falls back to client AM when not routed",
      fallback.length === 1 && fallback[0] === am);

    // Admin alert recipients = ceo + team_lead seeded above.
    const admins = await getResponsibleAdminsForAlert();
    check("getResponsibleAdminsForAlert includes ceo",
      admins.includes(ceo));
    check("getResponsibleAdminsForAlert includes team_lead",
      admins.includes(lead));
    check("getResponsibleAdminsForAlert excludes non-admins",
      !admins.includes(writer) && !admins.includes(assignee));

    // Mention parsing — matches local-part, first.last, and first-name.
    const byLocal = await resolveMentionsToUserIds(
      "hey @jane.doe please look at this",
    );
    check("mention @jane.doe resolves via firstName.lastName",
      byLocal.includes(mentioned));
    const byFirst = await resolveMentionsToUserIds("@jane can you check?");
    check("mention @jane resolves via first-name",
      byFirst.includes(mentioned));
    const noise = await resolveMentionsToUserIds("@nobodyhere thanks");
    check("unknown handle resolves to []", noise.length === 0);

    // excludeActor scrubs the actor from a recipient list.
    const filtered = excludeActor([am, assignee, routed], assignee);
    check("excludeActor removes the actor",
      filtered.length === 2 && !filtered.includes(assignee));
    check("excludeActor passes through when actor is null",
      excludeActor([am, assignee], null).length === 2);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

// The shared test teardown in server/db.ts disables the pg-pool idle reaper
// and unref's idle sockets in test mode, so the loop drains and the child
// exits on its own once main() settles — no manual process.exit() (Task #2084).
main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
