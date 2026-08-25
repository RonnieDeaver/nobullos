/* test-registration
{
  "name": "Ads OS AM Dashboard filters — URL-query-over-localStorage precedence (any query = every param URL-specified), default omission in the URL mirror, stale doer/checker reset, and the platform → empty-client → people → name/CID search pipeline (Task #3988)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3988: a shared AM-board link must reproduce the sharer's exact view and a saved filter naming a departed teammate must not blank the board — both are pure functions (amFilters.ts) exercised here with zero DOM/DB/network; milliseconds.",
  "extraEnv": {
    "NODE_ENV": "test"
  },
  "tier": "small"
}
test-registration */
/**
 * AM Dashboard filter semantics (Task #3988) — the pure half the board
 * delegates every decision to (client/src/pages/adsOs/lib/amFilters.ts):
 *
 *  (1) initialAmFilters: no query → localStorage (missing keys → defaults);
 *      ANY query → every param is URL-specified — a param absent from a
 *      shared link means the SHARER's default, never the recipient's saved
 *      filter (defaults are omitted when the URL is written, so filling gaps
 *      from localStorage would reproduce a different view than was shared).
 *      Boolean params: only "0" (and any value ≠ "0"… treated truthy) —
 *      "gads=0" hides, "gads=1" shows. Parsed from location.search shape
 *      (leading "?" tolerated), never a hash.
 *  (2) amFiltersQuery: pristine filters → "" (URL stays /ads-os/am); each
 *      non-default emitted; q trimmed; round-trips through initialAmFilters.
 *  (3) resetStalePeople: a doer/checker no longer present in the payload's
 *      people lists resets to "all"; present people and "all" untouched.
 *  (4) visibleAmClients: platform switches hide ACCOUNTS, a client with no
 *      remaining accounts drops; doer/checker match on FIRST name; search
 *      matches client names case-insensitively OR account CIDs digits-only
 *      ("683-725-1501", "683 725 1501" and "6837251501" all hit the same
 *      account) — and the CID search only sees accounts that survived the
 *      platform switches (pipeline order).
 */

process.env.NODE_ENV = "test";

import { strict as assert } from "node:assert";

import {
  AM_LS_KEYS,
  amFiltersQuery,
  initialAmFilters,
  normId,
  resetStalePeople,
  visibleAmClients,
  type AmFilters,
} from "../client/src/pages/adsOs/lib/amFilters";
import type { AmClient } from "../client/src/pages/adsOs/lib/types";

let passed = 0;
function ok(cond: boolean, label: string): void {
  assert.equal(cond, true, label);
  passed++;
  console.log(`  ✓ ${label}`);
}

const storeOf = (entries: Record<string, string>) => ({
  getItem: (k: string) => (k in entries ? entries[k] : null),
});
const EMPTY_STORE = storeOf({});
const SAVED_STORE = storeOf({
  [AM_LS_KEYS.doer]: "Dana",
  [AM_LS_KEYS.checker]: "Carl",
  [AM_LS_KEYS.gads]: "0",
  [AM_LS_KEYS.lsa]: "1",
});

// ── (1) initialAmFilters ─────────────────────────────────────────────────────
console.log("phase 1: initialAmFilters");
assert.deepEqual(
  initialAmFilters("", EMPTY_STORE),
  { doer: "all", checker: "all", gads: true, lsa: true, q: "" },
  "no query, empty store → defaults",
);
passed++;
assert.deepEqual(
  initialAmFilters("", SAVED_STORE),
  { doer: "Dana", checker: "Carl", gads: false, lsa: true, q: "" },
  "no query → localStorage wins (gads '0' = hidden)",
);
passed++;
assert.deepEqual(
  initialAmFilters("?doer=Juan", SAVED_STORE),
  { doer: "Juan", checker: "all", gads: true, lsa: true, q: "" },
  "ANY query → every param URL-specified: missing params are the sharer's defaults, not saved filters",
);
passed++;
assert.deepEqual(
  initialAmFilters("?checker=Ana&lsa=0&q=acme", SAVED_STORE),
  { doer: "all", checker: "Ana", gads: true, lsa: false, q: "acme" },
  "shared link reproduces the sharer's exact view",
);
passed++;
assert.deepEqual(
  initialAmFilters("gads=0", EMPTY_STORE).gads,
  false,
  "leading '?' optional (location.search shape tolerated either way)",
);
passed++;
ok(initialAmFilters("?gads=1&lsa=1", SAVED_STORE).gads === true, "explicit gads=1 shows despite saved '0'");

// ── (2) amFiltersQuery ───────────────────────────────────────────────────────
console.log("phase 2: amFiltersQuery");
const DEFAULTS: AmFilters = { doer: "all", checker: "all", gads: true, lsa: true, q: "" };
ok(amFiltersQuery(DEFAULTS) === "", "pristine filters → empty string (URL stays /ads-os/am)");
ok(
  amFiltersQuery({ ...DEFAULTS, q: "   " }) === "",
  "whitespace-only search is omitted (trimmed)",
);
{
  const qs = amFiltersQuery({ doer: "Juan", checker: "all", gads: true, lsa: false, q: " smith " });
  const p = new URLSearchParams(qs.slice(1));
  ok(qs.startsWith("?"), "non-default filters → ?query");
  ok(p.get("doer") === "Juan" && p.get("checker") === null, "only non-defaults emitted");
  ok(p.get("lsa") === "0" && p.get("gads") === null, "hidden platform emitted as =0");
  ok(p.get("q") === "smith", "search trimmed into the URL");

  // Round-trip: parsing the emitted query reproduces the filters exactly.
  assert.deepEqual(
    initialAmFilters(qs, SAVED_STORE),
    { doer: "Juan", checker: "all", gads: true, lsa: false, q: "smith" },
    "emitted query round-trips through initialAmFilters (recipient sees the sharer's view)",
  );
  passed++;
}

// ── (3) resetStalePeople ─────────────────────────────────────────────────────
console.log("phase 3: resetStalePeople");
const MANAGERS = ["Dana Doer", "Juan Antoniazzi"];
const CHECKERS = ["Carl Checker"];
assert.deepEqual(
  resetStalePeople({ ...DEFAULTS, doer: "Dana", checker: "Carl" }, MANAGERS, CHECKERS),
  { ...DEFAULTS, doer: "Dana", checker: "Carl" },
  "people still in the data are kept",
);
passed++;
assert.deepEqual(
  resetStalePeople({ ...DEFAULTS, doer: "Ghost", checker: "Nobody" }, MANAGERS, CHECKERS),
  { ...DEFAULTS, doer: "all", checker: "all" },
  "departed doer AND checker reset to all (board never silently blank)",
);
passed++;
assert.deepEqual(
  resetStalePeople(DEFAULTS, [], []),
  DEFAULTS,
  "'all' never resets, even against empty people lists",
);
passed++;

// ── (4) visibleAmClients ─────────────────────────────────────────────────────
console.log("phase 4: visibleAmClients");
ok(normId("683-725-1501") === "6837251501", "normId strips non-digits");

const acct = (product: "gads" | "lsa", cid: string) => ({
  product,
  customer_id: cid,
  label: product === "gads" ? "Google Ads" : "LSA",
  ads_status: "on",
  deep_link: null,
  status_check: null,
});
const CLIENTS: AmClient[] = [
  {
    client: "Beta Legal",
    doer: "Dana Doer",
    checker: "Carl Checker",
    log_url: null,
    accounts: [acct("gads", "6837251501"), acct("lsa", "1112223334")],
    alerts: { critical: 0, high: 0, medium: 0, total: 0, items: [] },
  },
  {
    client: "ACME Law",
    doer: "Juan Antoniazzi",
    checker: null,
    log_url: null,
    accounts: [acct("gads", "4445556667")],
    alerts: { critical: 0, high: 0, medium: 0, total: 0, items: [] },
  },
  {
    client: "LSA Only Co",
    doer: "Dana Doer",
    checker: "Carl Checker",
    log_url: null,
    accounts: [acct("lsa", "9998887776")],
    alerts: { critical: 0, high: 0, medium: 0, total: 0, items: [] },
  },
];
const names = (f: Partial<AmFilters>) =>
  visibleAmClients(CLIENTS, { ...DEFAULTS, ...f }).map((c) => c.client);

assert.deepEqual(names({}), ["Beta Legal", "ACME Law", "LSA Only Co"], "default filters show all");
passed++;
{
  const v = visibleAmClients(CLIENTS, { ...DEFAULTS, gads: false });
  assert.deepEqual(v.map((c) => c.client), ["Beta Legal", "LSA Only Co"], "gads off drops the emptied client");
  passed++;
  ok(
    v[0].accounts.length === 1 && v[0].accounts[0].product === "lsa",
    "gads off hides the gads ACCOUNT on mixed clients",
  );
}
assert.deepEqual(names({ lsa: false }), ["Beta Legal", "ACME Law"], "lsa off drops the LSA-only client");
passed++;
assert.deepEqual(names({ gads: false, lsa: false }), [], "both platforms off → empty board");
passed++;
assert.deepEqual(names({ doer: "Juan" }), ["ACME Law"], "doer filters by FIRST name");
passed++;
assert.deepEqual(names({ doer: "Dana" }), ["Beta Legal", "LSA Only Co"], "doer matches every card they own");
passed++;
assert.deepEqual(names({ checker: "Carl" }), ["Beta Legal", "LSA Only Co"], "checker filter (null checker excluded)");
passed++;
assert.deepEqual(names({ q: "acme" }), ["ACME Law"], "name search is case-insensitive (lowercase query)");
passed++;
assert.deepEqual(names({ q: "ACME" }), ["ACME Law"], "name search is case-insensitive (uppercase query)");
passed++;
assert.deepEqual(names({ q: "683-725" }), ["Beta Legal"], "CID search ignores hyphens");
passed++;
assert.deepEqual(names({ q: "683 725 1501" }), ["Beta Legal"], "CID search ignores spaces");
passed++;
assert.deepEqual(names({ q: "6837251501" }), ["Beta Legal"], "plain digits match too");
passed++;
assert.deepEqual(names({ q: "zzz" }), [], "no match → empty");
passed++;
assert.deepEqual(
  names({ gads: false, q: "6837251501" }),
  [],
  "pipeline order: platform switch first — a hidden gads account is not searchable",
);
passed++;
assert.deepEqual(
  names({ doer: "Dana", q: "999" }),
  ["LSA Only Co"],
  "people + search compose",
);
passed++;

console.log(`\nads-os-am-filters: ${passed} assertion(s) passed.`);
