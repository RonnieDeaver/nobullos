/* test-registration
{
  "name": "CEO-tools auth timing-safe token comparison (audit A-005)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Fast, DB-free guard on the requireCeoToolsAuth security boundary: length-safe constant-time comparison must never throw on unequal-length tokens and must never leak token material into logs or responses.",
  "tier": "small"
}
test-registration */
/**
 * Audit A-005 — `requireCeoToolsAuth` must use a length-safe constant-time
 * comparison instead of `!==`.
 *
 * Proves:
 *   1. Correct token succeeds (next() called).
 *   2. Same-length incorrect token fails with 403.
 *   3. Shorter incorrect token fails without throwing.
 *   4. Longer incorrect token fails without throwing.
 *   5. Blank and missing tokens fail through the existing response contract
 *      (missing/malformed header → 401; blank bearer token → 403).
 *   6. No token material appears in captured logs or error responses.
 *
 * The expected token is pinned via process.env BEFORE the middleware module
 * is imported (it captures CEO_TOOLS_API_TOKEN at module load).
 */
import assert from "node:assert/strict";

// Unique, obviously-test-only token. Set before importing the middleware
// module so its module-level CEO_TOOLS_TOKEN capture sees this value.
const TEST_TOKEN = `t_a005_${process.pid}_${Date.now().toString(36)}_secret`;
process.env.CEO_TOOLS_API_TOKEN = TEST_TOKEN;

interface MockRes {
  statusCode: number | null;
  body: any;
  status(code: number): MockRes;
  json(obj: any): MockRes;
}

function makeRes(): MockRes {
  return {
    statusCode: null,
    body: null,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(obj: any) {
      this.body = obj;
      return this;
    },
  };
}

async function main(): Promise<void> {
  // Capture console output across every invocation so we can assert the
  // token value never lands in a log line.
  const captured: string[] = [];
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;
  const capture =
    (orig: (...a: any[]) => void) =>
    (...args: any[]) => {
      captured.push(args.map((a) => String(a)).join(" "));
      orig(...args);
    };
  console.log = capture(origLog);
  console.warn = capture(origWarn);
  console.error = capture(origError);

  let passed = 0;
  try {
    const { requireCeoToolsAuth } = await import("../server/routes/middleware");

    const run = (authHeader: string | undefined) => {
      const req: any = { headers: authHeader === undefined ? {} : { authorization: authHeader } };
      const res = makeRes();
      let nextCalled = false;
      // Must never throw regardless of token length/content.
      requireCeoToolsAuth(req, res as any, () => {
        nextCalled = true;
      });
      return { res, nextCalled };
    };

    // 1. Correct token succeeds.
    {
      const { res, nextCalled } = run(`Bearer ${TEST_TOKEN}`);
      assert.equal(nextCalled, true, "correct token must call next()");
      assert.equal(res.statusCode, null, "correct token must not write a status");
      passed++;
    }

    // 2. Same-length incorrect token fails with 403.
    {
      const wrong = TEST_TOKEN.slice(0, -1) + (TEST_TOKEN.endsWith("x") ? "y" : "x");
      assert.equal(wrong.length, TEST_TOKEN.length, "fixture must be same length");
      const { res, nextCalled } = run(`Bearer ${wrong}`);
      assert.equal(nextCalled, false);
      assert.equal(res.statusCode, 403, "same-length wrong token → 403");
      passed++;
    }

    // 3. Shorter incorrect token fails without throwing.
    {
      const { res, nextCalled } = run(`Bearer short`);
      assert.equal(nextCalled, false);
      assert.equal(res.statusCode, 403, "shorter wrong token → 403");
      passed++;
    }

    // 4. Longer incorrect token fails without throwing.
    {
      const { res, nextCalled } = run(`Bearer ${TEST_TOKEN}${TEST_TOKEN}`);
      assert.equal(nextCalled, false);
      assert.equal(res.statusCode, 403, "longer wrong token → 403");
      passed++;
    }

    // 5a. Blank bearer token fails (403 — existing contract).
    {
      const { res, nextCalled } = run("Bearer ");
      assert.equal(nextCalled, false);
      assert.equal(res.statusCode, 403, "blank bearer token → 403");
      passed++;
    }

    // 5b. Missing / malformed authorization header → 401 (existing contract).
    {
      const missing = run(undefined);
      assert.equal(missing.nextCalled, false);
      assert.equal(missing.res.statusCode, 401, "missing header → 401");
      const basic = run("Basic abcdef");
      assert.equal(basic.nextCalled, false);
      assert.equal(basic.res.statusCode, 401, "non-Bearer header → 401");
      passed++;
    }

    // 6. No token material in logs or error responses.
    {
      const responses = [
        run(`Bearer ${TEST_TOKEN.slice(0, -1)}z`).res.body,
        run("Bearer ").res.body,
        run(undefined).res.body,
      ];
      for (const body of responses) {
        const s = JSON.stringify(body ?? {});
        assert.ok(!s.includes(TEST_TOKEN), "response body must not contain the expected token");
        assert.ok(!s.includes("t_a005_"), "response body must not contain token fragments");
      }
      const allLogs = captured.join("\n");
      assert.ok(!allLogs.includes(TEST_TOKEN), "logs must not contain the expected token");
      passed++;
    }

    console.log(`ceo-tools-auth-timing-safe: ${passed} groups passed`);
  } finally {
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
  }
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exitCode = 1;
});
