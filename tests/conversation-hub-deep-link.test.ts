/* test-registration
{
  "name": "Conversation Hub deep-link resolution (Task #4308)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Pins the CONSUMER side of the profile → Conversation Hub deep-link contract (thread match by threadKey/convId/last-10-digit phone, composer prefill for intent=message, dialer for intent=call, graceful no-match fallback, loading gate) plus source-level lockstep between the producer helper's params and the hub's resolver. Producer suite alone stays green if the hub effect drifts. Pure functions + fs reads: no DB, no network, no DOM, sub-second.",
  "scanPaths": [
    "client/src/pages/ConversationHub.tsx",
    "client/src/lib/contactHubUrl.ts",
    "client/src/lib/conversationDeepLink.ts"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #4308 — the Hub's deep-link handling, extracted into the pure
 * resolver `client/src/lib/conversationDeepLink.ts` precisely so this suite
 * can pin it without mounting the 5,000-line ConversationHub page (per repo
 * test-economics: lowest sufficient layer).
 *
 * What this pins:
 *  1. `resolveDeepLink` — the full decision table: loading gate, matching
 *     precedence (threadKey → convId → phone), last-10-digit phone
 *     normalization, group-thread exclusion, intent routing (message →
 *     compose / call → dialer), and graceful no-match fallbacks.
 *  2. Producer/consumer lockstep — every param `buildContactHubUrl` emits is
 *     a param the resolver consumes (DEEP_LINK_PARAM_KEYS), and the phone
 *     normalization matches `phoneDedupeKey`. Exception: `view` (Task #4373)
 *     routes WITHIN /comms and deliberately survives URL-stripping.
 *     Also pins `legacyConversationsUrlToComms` — the /conversations →
 *     /comms redirect mapper (params preserved, view forced to clients).
 *  3. Host wiring — source-level asserts (paths in scanPaths) that
 *     ConversationHub.tsx actually delegates to the shared resolver and
 *     keeps no private copy of the matching logic.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import {
  DEEP_LINK_PARAM_KEYS,
  normalizeDeepLinkPhone,
  resolveDeepLink,
  type DeepLinkThread,
} from "../client/src/lib/conversationDeepLink";
import { buildContactHubUrl, legacyConversationsUrlToComms, phoneDedupeKey } from "../client/src/lib/contactHubUrl";

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

function section(title: string): void {
  console.log(`\n— ${title} —`);
}

/** Search string exactly as the producer helper would emit it. */
function producerSearch(params: Record<string, string>): string {
  return buildContactHubUrl(params).split("?")[1] ?? "";
}

const threads: DeepLinkThread[] = [
  {
    key: "thread-jane",
    isGroup: false,
    contactPhone: "5551234567", // stored bare; deep links arrive formatted
    smsConversationIds: ["conv-1", "conv-1b"],
  },
  {
    key: "thread-group",
    isGroup: true,
    contactPhone: "+1 (555) 999-0000", // group threads never phone-match
    smsConversationIds: ["conv-g"],
  },
  {
    key: "thread-ops",
    isGroup: false,
    contactPhone: "+1 (555) 999-0000",
    smsConversationIds: ["conv-2"],
  },
];

// ── 1. Loading gate ────────────────────────────────────────────────────────
section("loading gate — thread-matching links wait, clientId-only proceeds");
{
  const p = resolveDeepLink("phone=5551234567&intent=message", [], false);
  assert(p.kind === "wait", "phone link waits until conversations have loaded");
  assert(resolveDeepLink("threadKey=thread-jane", [], false).kind === "wait",
    "threadKey link waits too");
  assert(resolveDeepLink("convId=conv-1", [], false).kind === "wait",
    "convId link waits too");

  const c = resolveDeepLink("clientId=client-1", [], false);
  assert(c.kind === "compose" && c.clientId === "client-1",
    "clientId-only link opens compose immediately (no thread data needed)");

  assert(resolveDeepLink("", threads, true).kind === "none",
    "no deep-link params → none (consumed, nothing changes)");
  assert(resolveDeepLink("intent=message", threads, true).kind === "none",
    "intent alone is not a deep-link trigger");
}

// ── 2. Thread matching by normalized phone ─────────────────────────────────
section("thread match — last-10-digit phone normalization");
{
  // The exact URL a profile Text button produces (formatted phone).
  const search = producerSearch({
    phone: "+1 (555) 123-4567",
    contactName: "Jane Roe",
    clientId: "client-1",
    intent: "message",
  });
  const p = resolveDeepLink(search, threads, true);
  assert(p.kind === "select-thread" && p.threadKey === "thread-jane",
    "formatted profile phone matches the bare-stored thread (last 10 digits)");
  assert(p.kind === "select-thread" && p.openDialer === false,
    "intent=message selects the thread without opening the dialer");

  const bare = resolveDeepLink("phone=5551234567", threads, true);
  assert(bare.kind === "select-thread" && bare.threadKey === "thread-jane",
    "bare digits match too; intent defaults to message");

  const grp = resolveDeepLink("phone=%2B1%20(555)%20999-0000", threads, true);
  assert(grp.kind === "select-thread" && grp.threadKey === "thread-ops",
    "group threads are excluded from phone matching (1:1 thread wins)");

  assert(normalizeDeepLinkPhone("+1 (555) 123-4567") === phoneDedupeKey("+1 (555) 123-4567"),
    "hub phone normalization matches the producer's phoneDedupeKey rule");
}

// ── 3. Matching precedence: threadKey → convId → phone ─────────────────────
section("matching precedence");
{
  const byKey = resolveDeepLink(
    "threadKey=thread-ops&convId=conv-1&phone=5551234567", threads, true);
  assert(byKey.kind === "select-thread" && byKey.threadKey === "thread-ops",
    "threadKey beats convId and phone");

  const byConv = resolveDeepLink("convId=conv-1b&phone=5559990000", threads, true);
  assert(byConv.kind === "select-thread" && byConv.threadKey === "thread-jane",
    "convId (any of the thread's SMS conversation ids) beats phone");

  const stale = resolveDeepLink("threadKey=gone&phone=5551234567", threads, true);
  assert(stale.kind === "select-thread" && stale.threadKey === "thread-jane",
    "a stale threadKey falls through to the phone match");
}

// ── 4. intent=call ─────────────────────────────────────────────────────────
section("intent=call — dialer opens, matched or not");
{
  const matched = resolveDeepLink(
    producerSearch({ phone: "555-123-4567", contactName: "Jane Roe", clientId: "client-1", intent: "call" }),
    threads, true);
  assert(matched.kind === "select-thread" && matched.openDialer === true,
    "call intent on a matched thread selects it AND opens the dialer");

  const unmatched = resolveDeepLink(
    producerSearch({ phone: "555-000-9999", contactName: "New Lead", intent: "call" }),
    threads, true);
  assert(unmatched.kind === "dial" && unmatched.phone === "555-000-9999",
    "call intent with no matching thread opens the dialer pre-filled with the raw phone");
}

// ── 5. Graceful no-match fallback (message intent) ─────────────────────────
section("no thread match — composer prefill, never a dead end");
{
  const p = resolveDeepLink(
    producerSearch({ phone: "555-000-9999", contactName: "New Lead", clientId: "client-7", intent: "message" }),
    threads, true);
  assert(p.kind === "compose" && p.phone === "555-000-9999",
    "message intent with no match opens compose pre-filled with the phone");
  assert(p.kind === "compose" && p.clientId === "client-7",
    "compose fallback carries the clientId for client pre-selection");

  const empty = resolveDeepLink("phone=5551230000", [], true);
  assert(empty.kind === "compose" && empty.phone === "5551230000" && empty.clientId === null,
    "loaded-but-empty inbox still falls through to compose (no clientId → null)");
}

// ── 5b. Stale identifier-only links are a no-op ────────────────────────────
section("stale threadKey/convId with nothing to prefill — consumed, no state change");
{
  const staleKey = resolveDeepLink("threadKey=deleted-thread", threads, true);
  assert(staleKey.kind === "consumed",
    "unmatched threadKey-only link is consumed — never surprise-opens the composer");

  const staleConv = resolveDeepLink("convId=conv-gone&intent=call", threads, true);
  assert(staleConv.kind === "consumed",
    "unmatched convId-only link is consumed even with intent=call (no phone to dial)");

  const staleWithClient = resolveDeepLink("threadKey=deleted-thread&clientId=client-3", threads, true);
  assert(staleWithClient.kind === "compose" && staleWithClient.clientId === "client-3",
    "stale threadKey WITH a clientId still falls through to client-preselected compose");
}

// ── 6. Producer/consumer param lockstep ────────────────────────────────────
section("param lockstep with buildContactHubUrl");
{
  const url = buildContactHubUrl({
    threadKey: "t", convId: "c", phone: "555", contactName: "N", clientId: "x", intent: "message",
  });
  assert(url.startsWith("/comms?view=clients&"),
    "links target the /comms clients view (Task #4373 convergence)");
  const emitted = [...new URLSearchParams(url.split("?")[1] ?? "").keys()];
  for (const k of emitted) {
    // Task #4373: `view` routes WITHIN /comms (which view to show). It is
    // deliberately NOT a DEEP_LINK_PARAM_KEY — the hub strips only its own
    // consumed params, so `view=clients` survives and the page stays on the
    // clients view after the deep link is consumed.
    if (k === "view") continue;
    assert((DEEP_LINK_PARAM_KEYS as readonly string[]).includes(k),
      `producer param "${k}" is a consumed (and URL-stripped) deep-link key`);
  }
  assert(!(DEEP_LINK_PARAM_KEYS as readonly string[]).includes("view"),
    "view stays OUT of DEEP_LINK_PARAM_KEYS — stripping it would knock /comms off the clients view");
}

// ── 6b. Legacy /conversations → /comms redirect mapping (Task #4373) ───────
section("legacyConversationsUrlToComms — redirect preserves deep-link intent");
{
  assert(
    legacyConversationsUrlToComms("?phone=%2B15551234567&intent=call&clientId=c1")
      === "/comms?view=clients&phone=%2B15551234567&intent=call&clientId=c1",
    "legacy params carry over verbatim with view=clients prepended");
  assert(legacyConversationsUrlToComms("") === "/comms?view=clients",
    "bare /conversations lands on the clients view");
  assert(
    legacyConversationsUrlToComms("?view=emoji&convId=c9") === "/comms?view=clients&convId=c9",
    "a stale view param in the legacy URL is dropped, never steers the comms view");
  const qs = producerSearch({ threadKey: "tk", intent: "message" });
  assert(legacyConversationsUrlToComms(`?${qs}`) === `/comms?${qs}`,
    "builder output round-trips through the mapper unchanged");
}

// ── 7. Host wiring — the hub delegates to the shared resolver ──────────────
section("host wiring — ConversationHub uses the shared resolver (scanPaths)");
{
  const hub = fs.readFileSync(
    path.resolve(process.cwd(), "client/src/pages/ConversationHub.tsx"), "utf8");
  assert(hub.includes('from "@/lib/conversationDeepLink"'),
    "ConversationHub imports the shared deep-link resolver");
  assert(hub.includes("resolveDeepLink(searchString"),
    "the deep-link effect delegates decisions to resolveDeepLink");
  assert(hub.includes("DEEP_LINK_PARAM_KEYS.forEach"),
    "URL param stripping uses the shared key list (stays in lockstep)");
  assert(!/\.replace\(\/\\D\/g, ""\)\.slice\(-10\)/.test(hub),
    "no private copy of the last-10-digit phone normalization remains in the hub");
}

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.error("conversation-hub-deep-link: FAILED");
  process.exit(1);
}
console.log("conversation-hub-deep-link: PASSED");
process.exit(0);
