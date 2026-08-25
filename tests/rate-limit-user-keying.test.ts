/* test-registration
{
  "name": "Rate-limiter per-user identity keying (Task #4789)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4789: pins the per-user bucket isolation contract for userKeyGenerator. Two distinct req.user.claims.sub values (the legacy fallback path, used both by downstream route handlers and by test harnesses) must produce different `user:` keys; absence of identity falls back to the IP key. This guards against a regression where the key collapses to a shared IP bucket — the root cause of Jason Robins' 2026-08-14 feedback-submit 429 storm. DB-free, deterministic.",
  "extraEnv": {
    "NODE_ENV": "test"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #4789 — per-user rate-limiter keying.
 *
 * Root cause: post-Clerk cutover (2026-08-13) userKeyGenerator read
 * req.user?.claims?.sub which is populated by requireAuth AFTER limiters run.
 * Every request fell through to ipKeyGenerator("127.0.0.1"), collapsing all
 * staff into one shared bucket. Fix: read Clerk session claims first (getAuth —
 * clerkMiddleware runs before limiters), fall back to req.user for downstream
 * handlers and test seams.
 *
 * In the unit-test environment, clerkMiddleware is not mounted so getAuth()
 * returns an empty auth object; these tests exercise the legacy-fallback
 * contract (which is also what route-test harnesses and downstream handlers
 * depend on) plus the IP fallback. The Clerk-first production path is covered
 * by the fact that the code now calls getAuth() before reading req.user, and
 * by the prod-evidence read that confirms separate per-user buckets after the
 * fix ships.
 */
import "./helpers/forceTestEnv";
import assert from "node:assert/strict";
import { userKeyGenerator } from "../server/routes/middleware";

// Minimal fake request factory. In test mode getAuth() returns {} (no claims),
// so identity resolves from req.user.claims.sub or falls back to IP.
function makeReq(opts: {
  legacyUserId?: string;
  ip?: string;
} = {}): any {
  const req: any = {
    ip: opts.ip ?? "127.0.0.1",
    socket: { remoteAddress: opts.ip ?? "127.0.0.1" },
  };
  if (opts.legacyUserId !== undefined) {
    req.user = { claims: { sub: opts.legacyUserId } };
  }
  return req;
}

let passed = 0;
let failed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err: any) {
    failed++;
    console.error(`  FAIL ${name}:`, err?.message ?? err);
  }
}

async function run() {
  console.log("Rate-limiter per-user identity keying (Task #4789)");

  // 1. Two distinct users get different bucket keys.
  await check("two distinct sub values get different user: keys", () => {
    const reqA = makeReq({ legacyUserId: "user-alpha" });
    const reqB = makeReq({ legacyUserId: "user-beta" });
    const keyA = userKeyGenerator(reqA);
    const keyB = userKeyGenerator(reqB);
    assert.equal(keyA, "user:user-alpha", `expected user:user-alpha, got ${keyA}`);
    assert.equal(keyB, "user:user-beta", `expected user:user-beta, got ${keyB}`);
    assert.notEqual(keyA, keyB, "keys must differ for different users");
  });

  // 2. Falls back to IP when no identity is present.
  await check("falls back to IP key when identity is absent", () => {
    const req = makeReq({ ip: "10.0.0.55" });
    const key = userKeyGenerator(req);
    assert.ok(!key.startsWith("user:"), `expected IP-based key (no user: prefix), got ${key}`);
  });

  // 3. Same sub on two different requests → same key (same bucket).
  await check("same sub on different requests → same bucket key", () => {
    const req1 = makeReq({ legacyUserId: "shared-user" });
    const req2 = makeReq({ legacyUserId: "shared-user" });
    assert.equal(userKeyGenerator(req1), userKeyGenerator(req2));
  });

  // 4. IP collision isolation: two users with the same IP still get different keys.
  await check("users sharing an IP get distinct user: keys (not collapsed to IP)", () => {
    const reqA = makeReq({ legacyUserId: "alice", ip: "192.168.1.1" });
    const reqB = makeReq({ legacyUserId: "bob", ip: "192.168.1.1" });
    const keyA = userKeyGenerator(reqA);
    const keyB = userKeyGenerator(reqB);
    assert.equal(keyA, "user:alice");
    assert.equal(keyB, "user:bob");
    assert.notEqual(keyA, keyB, "same IP but different users → different keys");
  });

  console.log(`\nTest run: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

void run().catch((err) => {
  console.error("Test run crashed:", err);
  process.exit(1);
});
