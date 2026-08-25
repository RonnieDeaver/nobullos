/* test-registration
{
  "name": "Comms bookmarks SSE cache-invalidation — right channel invalidates, other channel/type ignored (Task #3287)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3287: bookmark SSE cache-invalidation smoke. Guards makeBookmarkSseHandler: right-channel comms:bookmark events invalidate the bookmarks query; other channels/event types/bad payloads ignored. Fast, DB-free pure unit.",
  "tier": "small"
}
test-registration */
/**
 * Bookmark SSE cache-invalidation smoke (Task #3287).
 *
 * Guards makeBookmarkSseHandler (client/src/components/comms/bookmarkSse.ts),
 * the listener MessagePane attaches via addSseListener:
 *   - a comms:bookmark event for the handler's channel invalidates the
 *     `/api/comms/channels/{id}/bookmarks` query
 *   - a comms:bookmark event for a DIFFERENT channel is ignored
 *   - a different event type for the same channel is ignored
 *   - unparseable payloads are swallowed (no throw, no invalidation)
 *
 * Uses a deterministic recording invalidator instead of the React Query
 * runtime. Registered in tests/run-all.ts.
 */

import {
  makeBookmarkSseHandler,
  type BookmarkQueryInvalidator,
  type BookmarkSseEvent,
} from "../client/src/components/comms/bookmarkSse";

let passed = 0;
let failed = 0;

function assert(cond: unknown, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

const CHANNEL_A = "chan-aaa";
const CHANNEL_B = "chan-bbb";

const invalidated: unknown[][] = [];
const qc: BookmarkQueryInvalidator = {
  invalidateQueries(opts) {
    invalidated.push(opts.queryKey);
  },
};

function sse(data: unknown): BookmarkSseEvent {
  return {
    data: typeof data === "string" ? data : JSON.stringify(data),
  };
}

const handler = makeBookmarkSseHandler(qc, CHANNEL_A);

// 1. Matching channel → invalidated
handler(sse({ type: "comms:bookmark", action: "created", channelId: CHANNEL_A }));
assert(
  invalidated.length === 1 &&
    invalidated[0][0] === `/api/comms/channels/${CHANNEL_A}/bookmarks`,
  "comms:bookmark for the handler's channel invalidates its bookmarks query",
);

// 2. Different channel → ignored
handler(sse({ type: "comms:bookmark", action: "deleted", channelId: CHANNEL_B }));
assert(
  invalidated.length === 1,
  "comms:bookmark for a different channel is ignored",
);

// 3. Different event type, same channel → ignored
handler(sse({ type: "comms:message", channelId: CHANNEL_A }));
assert(
  invalidated.length === 1,
  "non-bookmark event type for the same channel is ignored",
);

// 4. Unparseable payload → swallowed, no invalidation, no throw
let threw = false;
try {
  handler(sse("not-json{{{"));
} catch {
  threw = true;
}
assert(!threw && invalidated.length === 1, "unparseable payload is swallowed");

// 5. Reorder + delete actions for the right channel also invalidate
handler(sse({ type: "comms:bookmark", action: "reordered", channelId: CHANNEL_A }));
handler(sse({ type: "comms:bookmark", action: "deleted", channelId: CHANNEL_A }));
assert(
  invalidated.length === 3,
  "reordered and deleted actions for the right channel also invalidate",
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
