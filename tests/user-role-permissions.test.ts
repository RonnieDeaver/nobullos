/* test-registration
{
  "name": "User role functions + authority permissions (Task #1758)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.0s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
// Task #1758 — function + authority permission helpers.
// Verifies:
//   1. expandFunctions auto-includes the three RE lanes for revenue_engineer
//   2. permissive mode caches and can be flipped via __reset helper
//   3. byFunction() recipient helper narrows by assigned function
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../server/db";
import {
  expandFunctions,
  isPermissiveModeEnabled,
  hasFunction,
  canAccessFunction,
  getUserFacet,
  __resetPermissiveModeCacheForTests,
  deriveLegacyRole,
  getAssignedFunctions,
  getEffectiveFunctions,
} from "../server/auth/permissions";
import { byFunction } from "../server/services/notifications/recipients";
import { storage } from "../server/storage";

// Use the cache-aware setter so both the in-process settings cache and
// the Redis read-through cache stay consistent with the DB row. Task
// #1855 banned raw-SQL writes to system_settings in tests for exactly
// this reason.
async function setSetting(key: string, value: string) {
  await storage.setSystemSetting(key, value, "system");
}

async function createUser(opts: {
  functions: string[];
  authorityLevel?: string;
  role?: string;
}): Promise<{ id: string; functions: string[]; authorityLevel: string; role: string }> {
  const id = `test-1758-${randomUUID()}`;
  const authorityLevel = opts.authorityLevel ?? "core";
  const role = opts.role ?? "account_manager";
  const fnsLiteral = `{${opts.functions.join(",")}}`;
  await db.execute(sql`
    INSERT INTO users (id, email, first_name, last_name, role, functions, authority_level)
    VALUES (${id}, ${`${id}@test.example`}, 'Test', 'User',
            ${role},
            ${fnsLiteral}::text[],
            ${authorityLevel})
  `);
  return { id, functions: opts.functions, authorityLevel, role };
}

async function cleanup(ids: string[]) {
  if (!ids.length) return;
  const literal = `{${ids.join(",")}}`;
  await db.execute(sql`DELETE FROM users WHERE id = ANY(${literal}::text[])`);
}

async function main() {
  // 1. expandFunctions
  const expanded = expandFunctions(["revenue_engineer"]).sort();
  assert.ok(expanded.includes("marketing_engineer"));
  assert.ok(expanded.includes("intake_engineer"));
  assert.ok(expanded.includes("sales_engineer"));
  assert.ok(expanded.includes("revenue_engineer"));
  assert.deepEqual(expandFunctions(["gbp_expert"]), ["gbp_expert"]);
  console.log("✓ expandFunctions auto-includes RE lanes for revenue_engineer");

  // 2. getUserFacet (operates on UserLike)
  assert.equal(getUserFacet({ functions: [], authorityLevel: "core", role: null } as any), "Unassigned");
  assert.equal(
    getUserFacet({ functions: ["revenue_engineer"], authorityLevel: "core", role: null } as any),
    "Revenue Engineering",
  );
  assert.equal(
    getUserFacet({ functions: ["gbp_expert"], authorityLevel: "core", role: null } as any),
    "Fulfillment",
  );
  assert.equal(
    getUserFacet({ functions: ["revenue_engineer", "gbp_expert"], authorityLevel: "core", role: null } as any),
    "Revenue Engineering + Fulfillment",
  );
  console.log("✓ getUserFacet maps function sets to facet");

  // 3. deriveLegacyRole
  assert.equal(deriveLegacyRole("ceo", null), "ceo");
  assert.equal(deriveLegacyRole("lead", null), "team_lead");
  assert.equal(deriveLegacyRole("director", null), "team_lead");
  assert.equal(deriveLegacyRole("core", null), "account_manager");
  assert.equal(deriveLegacyRole("core", "sales"), "sales");
  console.log("✓ deriveLegacyRole preserves sales but otherwise maps from authority");

  // 4. permissive mode cache + flip
  await setSetting("role_permissions_permissive_mode", "true");
  __resetPermissiveModeCacheForTests();
  assert.equal(await isPermissiveModeEnabled(), true);
  await setSetting("role_permissions_permissive_mode", "false");
  // Without cache reset, the cached value still wins (TTL ~5s in helper).
  assert.equal(await isPermissiveModeEnabled(), true);
  __resetPermissiveModeCacheForTests();
  assert.equal(await isPermissiveModeEnabled(), false);
  console.log("✓ permissive mode cache + flip via __resetPermissiveModeCacheForTests");

  // 5. hasFunction / canAccessFunction in strict mode
  await setSetting("role_permissions_permissive_mode", "false");
  __resetPermissiveModeCacheForTests();
  const ids: string[] = [];
  try {
    const reUser = await createUser({ functions: ["revenue_engineer"], authorityLevel: "core" });
    const gbpUser = await createUser({ functions: ["gbp_expert"], authorityLevel: "lead" });
    const emptyUser = await createUser({ functions: [], authorityLevel: "core" });
    ids.push(reUser.id, gbpUser.id, emptyUser.id);

    // hasFunction is "effective" semantics — RE expands to MIS.
    assert.equal(hasFunction(reUser, "revenue_engineer"), true);
    assert.equal(hasFunction(reUser, "marketing_engineer"), true);
    assert.equal(hasFunction(gbpUser, "marketing_engineer"), false);
    // getAssignedFunctions is the literal column (no expansion).
    assert.deepEqual(getAssignedFunctions(reUser).sort(), ["revenue_engineer"]);
    console.log("✓ hasFunction expands RE; getAssignedFunctions does not");

    // In strict mode, canAccessFunction gates on effective function.
    assert.equal(await canAccessFunction(reUser, "marketing_engineer"), true);
    assert.equal(await canAccessFunction(emptyUser, "marketing_engineer"), false);
    console.log("✓ canAccessFunction gates in strict mode");

    // getEffectiveFunctions in strict mode mirrors expansion
    const effStrict = (await getEffectiveFunctions(reUser)).sort();
    assert.ok(effStrict.includes("marketing_engineer"));
    assert.ok(effStrict.includes("revenue_engineer"));

    // In permissive mode, everyone passes canAccessFunction and effective = all.
    await setSetting("role_permissions_permissive_mode", "true");
    __resetPermissiveModeCacheForTests();
    assert.equal(await canAccessFunction(emptyUser, "marketing_engineer"), true);
    const effPerm = await getEffectiveFunctions(emptyUser);
    assert.ok(effPerm.length >= 8, "permissive effective functions should cover all 8");
    console.log("✓ permissive mode opens canAccessFunction and getEffectiveFunctions");

    // 6. byFunction reads ASSIGNED, with revenue_engineer auto-expansion.
    const marketingRecipients = await byFunction("marketing_engineer");
    assert.ok(marketingRecipients.includes(reUser.id), "revenue_engineer user should match marketing_engineer query");
    assert.ok(!marketingRecipients.includes(gbpUser.id), "gbp_expert user must NOT match marketing_engineer query");
    assert.ok(!marketingRecipients.includes(emptyUser.id), "user with no functions must NOT match");

    const gbpRecipients = await byFunction("gbp_expert");
    assert.ok(gbpRecipients.includes(gbpUser.id));
    assert.ok(!gbpRecipients.includes(reUser.id), "revenue_engineer should NOT match gbp_expert query");
    console.log("✓ byFunction narrows by assigned function with RE auto-expansion");
  } finally {
    await cleanup(ids);
    await setSetting("role_permissions_permissive_mode", "true");
    __resetPermissiveModeCacheForTests();
  }

  console.log("user-role-permissions: PASSED");
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main().catch((e) => {
  console.error("user-role-permissions: FAILED");
  console.error(e);
  process.exitCode = 1;
});
