/* test-registration
{
  "name": "Front recovery dedupe-key version slot (Task #1887)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.3s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #1887 — `extractFrontConvMessageVersion` regression tests.
 *
 * The dedupe key built for Front discovery/recovery used to collapse to
 * `front:recovery:<convId>:` (trailing empty colon) whenever Front's list
 * response omitted the embedded `last_message` object. Every message on a
 * conv then shared a single dedupe entry, and `source_event_log`'s UNIQUE
 * on `dedupe_key` silently dropped new inbound messages on already-seen
 * threads. These tests pin the resolution order so the version slot is
 * never empty.
 */

import { extractFrontConvMessageVersion } from "../server/services/frontConvMessageVersion";

let failed = 0;
async function run(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(
      `  FAIL ${name}\n    ${(e as Error).stack ?? (e as Error).message}`,
    );
    failed++;
  }
}
function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

async function main() {
  await run("prefers embedded last_message.id when present", () => {
    const v = extractFrontConvMessageVersion({
      id: "cnv_x",
      last_message: { id: "msg_abc", created_at: 1700000000 },
    });
    assert(v === "msg_abc", `expected msg_abc, got ${v}`);
  });

  await run("falls back to _links.related.last_message URL", () => {
    const v = extractFrontConvMessageVersion({
      id: "cnv_x",
      last_message: null,
      _links: {
        related: {
          last_message:
            "https://api2.frontapp.com/conversations/cnv_x/messages/msg_zzz",
        },
      },
    });
    assert(v === "msg_zzz", `expected msg_zzz, got ${v}`);
  });

  await run("strips query/hash suffixes when extracting from URL", () => {
    const v = extractFrontConvMessageVersion({
      _links: {
        related: {
          last_message:
            "https://api2.frontapp.com/conversations/cnv_x/messages/msg_qq?foo=1",
        },
      },
    });
    assert(v === "msg_qq", `expected msg_qq, got ${v}`);
  });

  await run("falls back to last_message.created_at timestamp", () => {
    const v = extractFrontConvMessageVersion({
      id: "cnv_x",
      last_message: { created_at: 1700000000 },
    });
    assert(v === "t1700000000", `expected t1700000000, got ${v}`);
  });

  await run("falls back to waiting_since, then updated_at", () => {
    const v1 = extractFrontConvMessageVersion({
      id: "cnv_x",
      waiting_since: 1700000001,
      updated_at: 1500000000,
    });
    assert(v1 === "t1700000001", `expected t1700000001, got ${v1}`);

    const v2 = extractFrontConvMessageVersion({
      id: "cnv_x",
      updated_at: 1500000000,
    });
    assert(v2 === "t1500000000", `expected t1500000000, got ${v2}`);
  });

  await run("never returns empty (sentinel) when nothing usable", () => {
    const v = extractFrontConvMessageVersion({
      id: "cnv_x",
      last_message: null,
      created_at: 1234567890, // intentionally NOT used — fixed at conv creation
    });
    assert(v === "noversion", `expected noversion, got ${v}`);
    assert(v.length > 0, "version slot must never be the empty string");
  });

  await run("does not use conv.created_at (no false-versioning)", () => {
    // The whole point of versioned discovery is that a NEW message on an
    // already-seen conv produces a NEW dedupe key. `conv.created_at` is
    // fixed at conv creation and would defeat that, so it must not be a
    // fallback source.
    const v = extractFrontConvMessageVersion({
      id: "cnv_x",
      created_at: 1234567890,
    });
    assert(v === "noversion", `expected noversion, got ${v}`);
  });

  await run("handles ISO string timestamps", () => {
    const v = extractFrontConvMessageVersion({
      id: "cnv_x",
      last_message: { created_at: "2026-05-26T22:00:00Z" },
    });
    assert(v === "t2026-05-26T22:00:00Z", `unexpected: ${v}`);
  });

  // Task #1891 — Bumped-thread contract. The whole point of the version
  // slot is that a NEW message on an already-seen conv produces a NEW
  // dedupe key so it re-enters the pipeline instead of silently being
  // deduplicated by `source_event_log` UNIQUE on `dedupe_key`. These
  // tests pin the contract end-to-end against the full
  // `front:recovery:<convId>:<version>` shape the call sites use.
  const buildKey = (conv: any) =>
    `front:recovery:${conv.id}:${extractFrontConvMessageVersion(conv)}`;

  await run(
    "bumped thread with new last_message.id produces a distinct dedupe key",
    () => {
      const before = buildKey({
        id: "cnv_bump",
        last_message: { id: "msg_001", created_at: 1700000000 },
      });
      const after = buildKey({
        id: "cnv_bump",
        last_message: { id: "msg_002", created_at: 1700000500 },
      });
      assert(before !== after, `expected distinct keys, got ${before} == ${after}`);
    },
  );

  await run(
    "bumped thread (Front list-payload shape: last_message=null, _links populated) produces distinct keys",
    () => {
      const before = buildKey({
        id: "cnv_listshape",
        last_message: null,
        _links: {
          related: {
            last_message:
              "https://api2.frontapp.com/conversations/cnv_listshape/messages/msg_aaa",
          },
        },
      });
      const after = buildKey({
        id: "cnv_listshape",
        last_message: null,
        _links: {
          related: {
            last_message:
              "https://api2.frontapp.com/conversations/cnv_listshape/messages/msg_bbb",
          },
        },
      });
      assert(before !== after, `expected distinct keys, got ${before} == ${after}`);
    },
  );

  await run(
    "bumped thread with only updated_at advancing produces distinct keys",
    () => {
      const before = buildKey({ id: "cnv_ts", updated_at: 1700000000 });
      const after = buildKey({ id: "cnv_ts", updated_at: 1700000500 });
      assert(before !== after, `expected distinct keys, got ${before} == ${after}`);
    },
  );

  await run("dedupe key never has the trailing-empty-colon shape", () => {
    // Worst-case payload: nothing resolvable. The sentinel must still
    // produce a non-empty suffix so the key cannot collapse to
    // `front:recovery:<convId>:`, which was the production bug.
    const k = buildKey({ id: "cnv_empty" });
    assert(!k.endsWith(":"), `key collapsed to trailing colon: ${k}`);
    assert(k === "front:recovery:cnv_empty:noversion", `unexpected: ${k}`);
  });

  await run(
    "two different convs with worst-case payloads still produce distinct keys",
    () => {
      const a = buildKey({ id: "cnv_a" });
      const b = buildKey({ id: "cnv_b" });
      assert(a !== b, `expected distinct keys, got ${a} == ${b}`);
    },
  );

  if (failed > 0) {
    console.error(`\n${failed} test(s) failed`);
    process.exitCode = 1;
  }
  console.log("\nall tests passed");
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main().then(
  () => {},
  (err) => {
    console.error(err);
    process.exitCode = 1;
  },
);
