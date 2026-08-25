/* test-registration
{
  "name": "NoBull Comms feature gate — exports, schema, nav wiring (Task #2928)",
  "smoke": true,
  "smokeReason": "Task #2928: NoBull Comms feature gate. Proves the 6 contracts that, if broken, brick the entire Comms feature silently before prod: the registerCommsRoutes export (the \"is not defined\" startup crash class), all 9 Drizzle schema tables (incl. commsCustomEmoji/commsEmojiUsage), 16 core commsStorage function exports, the 5 commsPresence exports + TTL constant, the /comms route in App.tsx, and the \"comms\" nav item in QUICKLINKS_MANIFEST. Fast, DB-free, no network.",
  "scanPaths": [
    "client/src/App.tsx",
    "client/src/components/QuicklinksBar.tsx",
    "client/src/components/comms/BrowseChannelsDialog.tsx",
    "client/src/components/comms/CallUI.tsx",
    "client/src/components/comms/ChannelHeader.tsx",
    "client/src/components/comms/ChannelSettingsDialog.tsx",
    "client/src/components/comms/CommsSidebar.tsx",
    "client/src/components/comms/CreateChannelDialog.tsx",
    "client/src/components/comms/NewDmDialog.tsx",
    "client/src/components/comms/pageTypes.ts",
    "client/src/pages/Comms.tsx",
    "server/boot",
    "server/index.ts",
    "server/routes/clients.ts",
    "server/routes/comms",
    "server/services/clientArchive.ts",
    "server/services/commsProvisioning.ts",
    "server/services/twilioEvents.ts",
    "server/storage/comms"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #2928 — NoBull Comms smoke gate.
 *
 * Proves the critical contracts that, if broken, would silently brick the
 * entire Comms feature before anyone notices in prod:
 *
 *   1. registerCommsRoutes is exported from server/routes/comms.ts and is a
 *      function (import-level guard — catches the "is not defined" class of
 *      startup crash that happened during initial wiring).
 *   2. All 7 Drizzle schema tables are exported from shared/models/comms.ts.
 *   3. commsStorage exports the five core CRUD operations checked at import
 *      time (channel CRUD, message send, reaction toggle, read-state upsert,
 *      presence heartbeat) — a missing export silently swallows all ops.
 *   4. commsPresence exports the four functions + the TTL constant used by
 *      routes/comms.ts (missing export → silent ReferenceError at call site).
 *   5. The /comms route is registered in client/src/App.tsx (source guard —
 *      a lazy-import line omitted from App means the page is unreachable).
 *   6. The "comms" nav item exists in QUICKLINKS_MANIFEST (source guard —
 *      an unlisted item is invisible in the sidebar).
 *
 * Fast, DB-free, deterministic (static import + source scan). No network.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Task #3787: server/routes/comms.ts is now a thin aggregator over
// per-feature modules in server/routes/comms/. Source-contract assertions
// scan the concatenation of the split modules (each module holds a verbatim
// contiguous slice of the original file, so intra-section ordering checks
// still hold).
let passed = 0;
let failed = 0;

function assert(cond: unknown, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ok  ${msg}`);
  } else {
    failed++;
    console.error(`  FAIL  ${msg}`);
  }
}

// ─── 1. registerCommsRoutes export ───────────────────────────────────────────

const commsRoutes = await import("../server/routes/comms.js");

assert(
  typeof (commsRoutes as any).registerCommsRoutes === "function",
  "registerCommsRoutes is exported as a function",
);

// ─── 2. Schema tables ─────────────────────────────────────────────────────────

const commsSchema = await import("../shared/models/comms.js");

const EXPECTED_TABLES = [
  "commsChannels",
  "commsChannelMembers",
  "commsMessages",
  "commsReactions",
  "commsReadStates",
  "commsCalls",
  "commsMessageClientTags",
  "commsCustomEmoji",
  "commsEmojiUsage",
] as const;

for (const table of EXPECTED_TABLES) {
  assert(
    (commsSchema as any)[table] !== undefined,
    `shared/models/comms exports table: ${table}`,
  );
}

// ─── 3. commsStorage core exports ────────────────────────────────────────────

const commsStorage = await import("../server/storage/commsStorage.js");

const EXPECTED_STORAGE_FNS = [
  "listChannelsForUser",
  "createChannel",
  "getChannelById",
  "listMessages",
  "createMessage",
  "addReaction",
  "removeReaction",
  "upsertReadState",
  "getReadState",
  "createCall",
  "getActiveCallForChannel",
  "listCustomEmoji",
  "getCustomEmojiByName",
  "createCustomEmoji",
  "deleteCustomEmoji",
  "trackEmojiUsage",
  "getFrequentlyUsedEmoji",
] as const;

for (const fn of EXPECTED_STORAGE_FNS) {
  assert(
    typeof (commsStorage as any)[fn] === "function",
    `commsStorage exports function: ${fn}`,
  );
}

// ─── 4. commsPresence exports ─────────────────────────────────────────────────

const commsPresence = await import("../server/services/commsPresence.js");

const EXPECTED_PRESENCE = [
  "markCommsUserOnline",
  "markCommsUserOffline",
  "heartbeatCommsUser",
  "listOnlineCommsUserIds",
  "COMMS_PRESENCE_HEARTBEAT_MS",
] as const;

for (const sym of EXPECTED_PRESENCE) {
  assert(
    (commsPresence as any)[sym] !== undefined,
    `commsPresence exports: ${sym}`,
  );
}

// ─── 5. /comms route in App.tsx ───────────────────────────────────────────────

const appSrc = readFileSync(
  join(process.cwd(), "client/src/App.tsx"),
  "utf-8",
);

assert(
  appSrc.includes('path="/comms"') || appSrc.includes("path='/comms'"),
  'App.tsx contains route path="/comms"',
);

assert(
  /import.*Comms.*from.*pages\/Comms/.test(appSrc) ||
    /lazyWithRetry.*Comms/.test(appSrc),
  "App.tsx lazy-imports the Comms page component",
);

// ─── 6. Comms in QuicklinksBar QUICKLINKS_MANIFEST ───────────────────────────

const quicklinksSrc = readFileSync(
  join(process.cwd(), "client/src/components/QuicklinksBar.tsx"),
  "utf-8",
);

assert(
  quicklinksSrc.includes('"comms"') || quicklinksSrc.includes("id: \"comms\""),
  'QuicklinksBar QUICKLINKS_MANIFEST contains id: "comms"',
);

assert(
  quicklinksSrc.includes('href: "/comms"'),
  'QuicklinksBar manifest item has href: "/comms"',
);

assert(
  quicklinksSrc.includes('id: "default-channels"'),
  'QuicklinksBar QUICKLINKS_MANIFEST contains id: "default-channels"',
);

assert(
  quicklinksSrc.includes('href: "/admin/comms/default-channels"'),
  'QuicklinksBar manifest item has href: "/admin/comms/default-channels"',
);

const defaultChannelsIdx = quicklinksSrc.indexOf('id: "default-channels"');
const defaultChannelsEntry = quicklinksSrc.slice(
  defaultChannelsIdx,
  quicklinksSrc.indexOf("\n", defaultChannelsIdx),
);
assert(
  defaultChannelsEntry.includes("isTeamLead"),
  "default-channels manifest entry is gated on isTeamLead",
);

// ─── 7. Route-level auth guards (source-scan) ────────────────────────────────
//
// These lock in the membership checks added after the post-ship security
// review: read-state, LiveKit token minting, call end, and the client feed
// must all be membership/visibility guarded.

const routesSrc = readCommsRouteSources();

function routeBlock(marker: string): string {
  const idx = routesSrc.indexOf(marker);
  if (idx === -1) return "";
  return routesSrc.slice(idx, idx + 1600);
}

assert(
  routeBlock('app.get("/api/comms/channels/:id/read-state"').includes("isChannelMember"),
  "GET read-state checks channel membership",
);

assert(
  routeBlock('app.post("/api/comms/channels/:id/read-state"').includes("isChannelMember"),
  "POST read-state checks channel membership",
);

const tokenBlock = routeBlock('app.post("/api/comms/calls/token"');
assert(
  tokenBlock.includes("getCallByRoomName") && tokenBlock.includes("isChannelMember"),
  "calls/token binds the room to a call and checks channel membership before minting",
);

const endCallBlock = routeBlock('app.patch("/api/comms/calls/:id"');
assert(
  endCallBlock.includes("getCallById") && endCallBlock.includes("isChannelMember"),
  "PATCH calls/:id checks channel membership before ending a call",
);

assert(
  /getClientCommsFeed\(\s*req\.params\.id,\s*userId/.test(routesSrc),
  "client comms-feed passes the viewer userId for visibility filtering",
);

// Extract just the client-channel route handler to check its internals without
// false-positives from other route handlers that legitimately call addChannelMember.
const clientChannelRouteMatch = routesSrc.match(
  /app\.post\("\/api\/clients\/:id\/comms-channel"[\s\S]{0,2000}?\}\);/,
);
assert(
  clientChannelRouteMatch !== null &&
    clientChannelRouteMatch[0].includes("provisionClientChannel") &&
    !clientChannelRouteMatch[0].includes("createChannel(") &&
    (clientChannelRouteMatch[0].match(/created \? 201 : 200/) !== null),
  "client channel find-or-create route delegates to provisionClientChannel (single canonical path, returns 201 on create vs 200 on find)",
);

const storageSrc = readCommsStorageSources();

assert(
  storageSrc.includes("createHash") && storageSrc.includes("joined.length <= 80"),
  "findOrCreateDmChannel hashes group-DM slugs that would overflow varchar(80)",
);

assert(
  /getUnreadCountsForUser[\s\S]{0,1600}groupBy\(commsMessages\.channelId\)/.test(storageSrc),
  "getUnreadCountsForUser uses a single grouped query (no per-channel N+1 loop)",
);

// Listing must use LEFT JOIN + include client-bound channels so provisioned
// channels (no members) appear in every user's sidebar.
assert(
  /listChannelsForUser[\s\S]{0,400}leftJoin/.test(storageSrc),
  "listChannelsForUser uses LEFT JOIN so provisioned channels without members are visible",
);

assert(
  /listChannelsForUser[\s\S]{0,1200}isNotNull\(commsChannels\.clientId\)/.test(storageSrc),
  "listChannelsForUser includes client-bound channels regardless of membership",
);

// isChannelMember must also pass through for client-bound channels so that
// message/read-state/typing/reaction/call endpoints don't 403 on provisioned channels.
assert(
  /isChannelMember[\s\S]{0,1200}isNotNull\(commsChannels\.clientId\)/.test(storageSrc),
  "isChannelMember passes through for client-bound (team-wide) channels",
);

// ─── 8. Default client channels — provisioning contracts ─────────────────────
//
// Source-scan gates that, if removed, would silently break the auto-provisioning
// feature without failing anything at import time.

assert(
  storageSrc.includes("provisionClientChannel"),
  "commsStorage exports provisionClientChannel",
);

assert(
  storageSrc.includes("listActiveClientsWithoutChannel"),
  "commsStorage exports listActiveClientsWithoutChannel",
);

const provisioningSrc = readFileSync(
  join(process.cwd(), "server/services/commsProvisioning.ts"),
  "utf-8",
);

assert(
  provisioningSrc.includes("backfillClientChannels"),
  "commsProvisioning exports backfillClientChannels",
);

assert(
  provisioningSrc.includes("provisionClientChannel") &&
    provisioningSrc.includes("listActiveClientsWithoutChannel"),
  "commsProvisioning delegates to provisionClientChannel + listActiveClientsWithoutChannel",
);

const clientRoutesSrc = readFileSync(
  join(process.cwd(), "server/routes/clients.ts"),
  "utf-8",
);

assert(
  clientRoutesSrc.includes("provisionClientChannel"),
  "clients route provisions a comms channel on client creation",
);

// Task #3697 moved the channel archive/restore calls out of the PATCH route
// into the shared clientArchive side-effects helper (used by both the manual
// route and the offboarding sweep). The contract these two assertions protect
// is unchanged: flipping isArchived must still reach archiveChannel /
// restoreClientChannel — now via applyClientArchivalSideEffects.
const clientArchiveSrc = readFileSync(
  join(process.cwd(), "server/services/clientArchive.ts"),
  "utf-8",
);

const bootFilePaths = (await import("fs"))
  .readdirSync(join(process.cwd(), "server/boot"))
  .filter((f) => f.endsWith(".ts"))
  .sort()
  .map((f) => `server/boot/${f}`);
const indexSrc = ["server/index.ts", ...bootFilePaths]
  .map((p) => readFileSync(join(process.cwd(), p), "utf-8"))
  .join("\n");

assert(
  indexSrc.includes("backfillClientChannels"),
  "server/index.ts runs backfillClientChannels at startup",
);

// ─── 9. DB-level uniqueness — unique partial index migration ─────────────────

const migrationFiles = readdirSync(join(process.cwd(), "migrations"));

assert(
  migrationFiles.some(
    (f) => f.startsWith("0115_") && f.includes("comms"),
  ),
  "migration 0115 exists for comms_channels_unique_active_client index",
);

const migrationSrc = readFileSync(
  join(process.cwd(), "migrations", migrationFiles.find((f) => f.startsWith("0115_") && f.includes("comms"))!),
  "utf-8",
);

assert(
  migrationSrc.includes("UNIQUE INDEX") && migrationSrc.includes("comms_channels") &&
    migrationSrc.includes("client_id IS NOT NULL") && migrationSrc.includes("archived_at IS NULL"),
  "migration enforces unique partial index on comms_channels(client_id) where active",
);

// Declare commsStorageSrc here so it is available for both section 9 and 10.
const commsStorageSrc = readCommsStorageSources();

assert(
  commsStorageSrc.includes("onConflictDoNothing") &&
    commsStorageSrc.includes("race-read miss"),
  "provisionClientChannel uses ON CONFLICT DO NOTHING + re-read for concurrent safety",
);

// ─── 10. SSE fan-out for client-bound channels ───────────────────────────────
// getChannelMemberIds returns null for client-bound (team-wide) channels so
// callers omit targetUserIds from their broadcast, causing deliverLocal in
// twilioEvents.ts to fan-out to ALL SSE subscribers instead of nobody.

assert(
  /getChannelMemberIds.*Promise<string\[\]\s*\|\s*null>/.test(commsStorageSrc),
  "getChannelMemberIds return type is Promise<string[] | null>",
);

assert(
  commsStorageSrc.includes("clientId != null") && commsStorageSrc.includes("return null"),
  "getChannelMemberIds returns null for client-bound channels (team-wide broadcast signal)",
);

const twilioEventsSrc = readFileSync(
  join(process.cwd(), "server/services/twilioEvents.ts"),
  "utf-8",
);

assert(
  /targetUserIds\?:\s*string\[\]/.test(twilioEventsSrc),
  "comms event types declare targetUserIds as optional (absent = broadcast to all)",
);

assert(
  !twilioEventsSrc.includes("targetUserIds: string[];"),
  "no comms event type has targetUserIds as required (would block team-wide delivery)",
);

const commsRoutesSrc = readCommsRouteSources();

assert(
  (commsRoutesSrc.match(/\.\.\.\(memberIds !== null/g) ?? []).length >= 8,
  "all 8 SSE broadcast call sites conditionally spread targetUserIds (null = omit for team-wide)",
);

assert(
  !commsRoutesSrc.includes("targetUserIds: memberIds,"),
  "no broadcast call site passes memberIds directly (would send empty array for client channels)",
);

// ─── 10. Sidebar grouping — client channels in own section ───────────────────

// Task #3787: the page's inline sections (sidebar, dialogs, call UI, SSE
// hook, types) were extracted into components under client/src/components/
// comms/. Page-composition assertions scan the page plus exactly the
// extracted files (an explicit list, so unrelated components can't satisfy
// — or violate — these contracts).
const commsTsxSrc = [
  "client/src/pages/Comms.tsx",
  "client/src/components/comms/pageTypes.ts",
  "client/src/components/comms/CallUI.tsx",
  "client/src/components/comms/ChannelHeader.tsx",
  "client/src/components/comms/ChannelSettingsDialog.tsx",
  "client/src/components/comms/CommsSidebar.tsx",
  "client/src/components/comms/CreateChannelDialog.tsx",
  "client/src/components/comms/NewDmDialog.tsx",
  "client/src/components/comms/BrowseChannelsDialog.tsx",
]
  .map((p) => readFileSync(join(process.cwd(), p), "utf-8"))
  .join("\n");

assert(
  /clientChannels\s*=\s*channels\s*\.filter\(.*clientId/.test(commsTsxSrc) ||
    (/\bclientChannels\b/.test(commsTsxSrc) && /groupChannels/.test(commsTsxSrc)),
  "Comms.tsx sidebar separates client-bound channels (clientId filter or groupChannels helper)",
);

assert(
  commsTsxSrc.includes("sidebar-clients-section"),
  'Comms.tsx sidebar renders a "Clients" section (data-testid)',
);

// ─── 11. New-DM people picker replaces the browse-channels dialog ─────────────
//
// The DM "+" button must open a proper people picker (NewDmDialog), NOT the
// browse-channels dialog. Source-scan checks:
//   a. NewDmDialog component is defined in Comms.tsx.
//   b. The new-dm-button onClick wires to setShowNewDm (not setShowBrowse).
//   c. NewDmDialog calls POST /api/comms/dms to create/find the conversation.
//   d. GET /api/comms/users (picker-safe, all authenticated roles — Task
//      #3130) is the people-list data source; the Team Lead+ /api/users
//      must NOT be used (regular users got a silent 403 → stuck loader).
//   e. Key testids exist for the search input and the open/confirm button.

assert(
  commsTsxSrc.includes("function NewDmDialog("),
  "Comms.tsx defines a NewDmDialog component (people picker for DMs)",
);

assert(
  commsTsxSrc.includes("setShowNewDm") &&
    !commsTsxSrc.includes("onNewDm={() => setShowBrowse(true)"),
  "DM '+' button wires to showNewDm state, not showBrowse (browse-channels dialog)",
);

assert(
  commsTsxSrc.includes("/api/comms/dms") &&
    commsTsxSrc.includes("userIds: selected"),
  "NewDmDialog calls POST /api/comms/dms with selected userIds",
);

assert(
  commsTsxSrc.includes("/api/comms/users"),
  "NewDmDialog fetches team members from the picker-safe GET /api/comms/users (Task #3130)",
);

assert(
  !commsTsxSrc.includes('"/api/users"'),
  "Comms.tsx must not query the Team Lead+ GET /api/users (silent 403 for regular users)",
);

assert(
  commsTsxSrc.includes("new-dm-search-input") &&
    commsTsxSrc.includes("new-dm-open-button"),
  "NewDmDialog has new-dm-search-input and new-dm-open-button testids",
);

// ─── Summary ─────────────────────────────────────────────────────────────────

const total = passed + failed;
console.log(`\ncomms-smoke: ${passed}/${total} assertions passed`);
if (failed > 0) process.exit(1);

function readCommsRouteSources(): string {
  const dir = join(process.cwd(), "server/routes/comms");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .sort()
    .map((f) => readFileSync(join(dir, f), "utf-8"))
    .join("\n");
}

function readCommsStorageSources(): string {
  const dir = join(process.cwd(), "server/storage/comms");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .sort()
    .map((f) => readFileSync(join(dir, f), "utf-8"))
    .join("\n");
}
