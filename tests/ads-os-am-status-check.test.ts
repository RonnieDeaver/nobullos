/* test-registration
{
  "name": "Ads OS AM Dashboard backend — status-verification guards (ClickUp down / no targets / all-errored each keep the last batch), GAQL channel scoping + name caps, deep-link capture (substring field name, http(s)-only, trim, last-write-wins) + 46-entry seed, payload sort/labels/roll-up/clickup_ok (Task #3988)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3988: the verification sweep's three no-persist guards are the difference between a transient outage and silently wiping every ✓/✗ chip app-wide, and buildAmDashboard IS the AM board. Stubbed ClickUp/OAuth/GAQL fetch; store writes go to an isolated schema; a few seconds.",
  "extraEnv": {
    "NODE_ENV": "test"
  },
  "tier": "small"
}
test-registration */
/**
 * Ads OS — AM Dashboard backend (Task #3988).
 *
 * Covers, in one ClickUp-fixture-driven pass:
 *
 *  (1) Deep-link capture (clickUpDirectory): any subtask custom field whose
 *      NAME contains "account link" / "deep link" (case-insensitive substring)
 *      yields a launch URL — value trimmed, http/https only (a javascript:
 *      value never lands), later fields overwrite earlier ones.
 *  (2) The shipped seed (amDeeplinksSeed): exactly 46 entries, every key
 *      "product:cid", every value http(s) — the scheme filter in seedLinks()
 *      must have nothing to drop, and a future edit that violates this fails
 *      here first.
 *  (3) buildAmDashboard payload: case-insensitive client sort, zero-account
 *      clients dropped, offboarded absent, Off accounts present, gads rows
 *      before lsa rows, labels ("Google Ads" / "LSA - City" / bare "LSA"),
 *      deep_link precedence ClickUp field → seed → null, missing Doer/Checker
 *      → null, alert roll-up (critical/high/medium counted; unknown severities
 *      LISTED last but never counted; detail capped), managers/checkers
 *      derived from data, clickup_ok, status_checked_at null before the first
 *      verification run.
 *  (4) runStatusChecks: only ClickUp-Paused/Off enrolled accounts are queried
 *      (On accounts never), LSA scoped `= 'LOCAL_SERVICES'` vs GAds
 *      `!= 'LOCAL_SERVICES'`, both status/serving_status conditions present,
 *      offending-name list capped at 5 names × 80 chars, per-account error
 *      entries, one shared `now` per batch, saved:true summary.
 *  (5) The three keep-last-batch guards, each against a pre-existing batch:
 *      ClickUp down → {skipped:"clickup_unavailable"}; roster all-On →
 *      {skipped:"no_targets"}; every account errored →
 *      {skipped:"all_errored", errors:N} — and the stored doc's generated_at
 *      never moves.
 *  (6) Post-verification payload: paused/off accounts carry their entry
 *      (✗ mismatch names / ✓ match / error), On accounts stay null,
 *      status_checked_at equals the batch's generated_at; a stale-but-served
 *      roster keeps clickup_ok true, an EMPTY roster (fresh cache + ClickUp
 *      down) flips it false with clients:[].
 *
 * Hermetic: fetch stubbed in-process (ClickUp + Google OAuth + GAQL
 * searchStream); the two store tables are cloned into an isolated schema so
 * nothing touches shared rows.
 */

process.env.NODE_ENV = "test";
process.env.CLICKUP_API_TOKEN = "pk_fake_am_dash_test";
process.env.ACCOUNT_ENROLLMENT = "auto";
process.env.GOOGLE_ADS_DEVELOPER_TOKEN = "fake-dev-token";
process.env.GOOGLE_ADS_CLIENT_ID = "fake-client-id";
process.env.GOOGLE_ADS_CLIENT_SECRET = "fake-client-secret";
process.env.GOOGLE_ADS_REFRESH_TOKEN = "fake-refresh-token";
process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID = "9999999999";

import { strict as assert } from "node:assert";
import {
  EMPTY_CLICKUP_PRACTICE_AREA_FIELDS,
  isClickUpListFieldPath,
} from "./helpers/clickUpPracticeAreaFixture";

// ── ClickUp Client List fixture (config default field ids) ──────────────────
const F_CID = "a886aa6f-c7f8-41cc-940b-8afef551bf49";
const F_STATUS = "e8717288-345d-4a2b-8169-0992b78bc809";
const F_DOER = "21335dc5-98ba-470c-b8a9-944e3cfed343";
const F_CHECKER = "0bfb4a38-47e4-4343-bb83-051a9fd40122";
const F_LOG = "0d573e9c-d786-44f4-a5d3-ac86c20e7510";

const statusField = (optName: "On" | "Paused" | "Off") => ({
  id: F_STATUS,
  value: `opt-${optName.toLowerCase()}`,
  type_config: {
    options: [
      { id: "opt-on", name: "On", orderindex: 0 },
      { id: "opt-paused", name: "Paused", orderindex: 1 },
      { id: "opt-off", name: "Off", orderindex: 2 },
    ],
  },
});

const CID_G_ON = "5551110001"; // Beta Legal GAds — On, ClickUp deep link
const CID_L_CITY = "5551110002"; // Beta Legal LSA (Springfield) — Paused
const CID_SEED = "1142840199"; // ACME Law GAds — Paused, REAL seed key, no ClickUp link
const CID_L_NOCITY = "5551110004"; // ACME Law LSA, no city — Off, no link anywhere
const CID_G_ERR = "5551110005"; // alpha co GAds — Paused, GAQL errors
const CID_OFF = "5551110006"; // Gone LLC (offboarded)

const GADS_LINK = "https://ads.google.com/aw/overview?ocid=111";
const LSA_LINK = "https://ads.google.com/localservices/accountpicker?cid=222";

/** Ads Status per fixture mode: the guard scenarios flip the whole roster On. */
let statusMode: "mixed" | "allOn" = "mixed";
const st = (mixed: "On" | "Paused" | "Off") => statusField(statusMode === "allOn" ? "On" : mixed);

function clickUpTasks() {
  return {
    last_page: true,
    tasks: [
      {
        id: "p1",
        name: "Beta Legal",
        status: { status: "open" },
        custom_fields: [
          { id: F_DOER, value: [{ username: "Dana Doer" }] },
          { id: F_CHECKER, value: [{ username: "Carl Checker" }] },
          { id: F_LOG, value: "https://app.clickup.com/log/beta" },
        ],
      },
      {
        id: "s1",
        parent: "p1",
        name: "GOOGLE ADS – Beta",
        custom_fields: [
          { id: F_CID, value: CID_G_ON },
          st("On"),
          // Scheme filter: a matching NAME with a javascript: value must never land.
          { id: "cf-js", name: "Account Link (js)", value: "javascript:alert(1)" },
          // Substring match + last-write-wins: this one lands first…
          { id: "cf-old", name: "OLD deep link", value: "https://old.example/aw" },
          // …then this later field overwrites it. Value deliberately padded: capture trims.
          { id: "cf-new", name: "Client Account Link", value: `  ${GADS_LINK}  ` },
        ],
      },
      {
        id: "s2",
        parent: "p1",
        name: "LSA (Springfield)",
        custom_fields: [
          { id: F_CID, value: CID_L_CITY },
          st("Paused"),
          { id: "cf-lsa", name: "LSA Deep Link", value: LSA_LINK },
        ],
      },
      {
        id: "p2",
        name: "ACME Law", // no doer/checker/log fields → nulls in the payload
        status: { status: "open" },
        custom_fields: [],
      },
      {
        id: "s3",
        parent: "p2",
        name: "GOOGLE ADS – Acme",
        // No link field → the shipped seed must supply this CID's URL.
        custom_fields: [{ id: F_CID, value: CID_SEED }, st("Paused")],
      },
      {
        id: "s4",
        parent: "p2",
        name: "LSA", // no "(City)" suffix → bare "LSA" label
        custom_fields: [{ id: F_CID, value: CID_L_NOCITY }, st("Off")],
      },
      {
        id: "p3",
        name: "alpha co", // lowercase on purpose: sort must be case-insensitive
        status: { status: "open" },
        custom_fields: [],
      },
      {
        id: "s5",
        parent: "p3",
        name: "GOOGLE ADS – alpha",
        custom_fields: [{ id: F_CID, value: CID_G_ERR }, st("Paused")],
      },
      // Offboarded client: absent from the payload entirely.
      { id: "p4", name: "Gone LLC", status: { status: "offboarded" }, custom_fields: [] },
      {
        id: "s6",
        parent: "p4",
        name: "GOOGLE ADS – Gone",
        custom_fields: [{ id: F_CID, value: CID_OFF }, st("Paused")],
      },
      // Zero-account client: filtered out of the payload (no launch card).
      { id: "p5", name: "Empty Client", status: { status: "open" }, custom_fields: [] },
    ],
  };
}

// ── fetch stub (ClickUp + Google OAuth + GAQL searchStream) ─────────────────
let clickUpDown = false;
/** Per-CID GAQL behaviour for the status-check query. */
const gaqlRows: Record<string, string[]> = {};
let gaqlAllError = false;
const gaqlLog: Array<{ cid: string; query: string }> = [];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(typeof input === "string" ? input : input?.url ?? input);
  // Dispatch on URL *path shape*, never on live vendor hostnames — naming the
  // real API hosts here would make this test a net-new raw vendor-host caller
  // under lint-vendor-confinement.
  let pathname = "";
  try {
    pathname = new URL(url).pathname;
  } catch {
    // Non-absolute input: fall through to realFetch below.
  }

  if (pathname.startsWith("/api/v2/")) {
    if (clickUpDown) return jsonResponse({ err: "outage" }, 503);
    if (isClickUpListFieldPath(pathname)) {
      return jsonResponse(EMPTY_CLICKUP_PRACTICE_AREA_FIELDS);
    }
    return jsonResponse(clickUpTasks());
  }
  if (pathname === "/token") {
    return jsonResponse({ access_token: "fake-access", expires_in: 3599 });
  }
  if (pathname.includes("googleAds:search")) {
    const cid = url.match(/customers\/(\d+)\//)?.[1] ?? "";
    const query: string = JSON.parse(String(init?.body ?? "{}"))?.query ?? "";
    if (query.includes("FROM campaign")) {
      gaqlLog.push({ cid, query });
      if (gaqlAllError || !(cid in gaqlRows)) {
        return jsonResponse(
          { error: { code: 500, message: `stubbed ads outage for ${cid}`, status: "INTERNAL" } },
          500,
        );
      }
      return jsonResponse([{ results: gaqlRows[cid].map((name) => ({ campaign: { name } })) }]);
    }
    // Anything else (labels, customer_client, …) is irrelevant here.
    return jsonResponse([{ results: [] }]);
  }
  return realFetch(input, init);
}) as typeof fetch;

// ── Modules under test (AFTER env + fetch stub) ──────────────────────────────
const directory = await import("../server/services/adsOs/clickUpDirectory");
const { runStatusChecks } = await import("../server/services/adsOs/statusCheck");
const { buildAmDashboard } = await import("../server/services/adsOs/amDashboard");
const { AM_DEEPLINKS_SEED } = await import("../server/services/adsOs/amDeeplinksSeed");
const {
  CLIENT_ALERT_ITEMS_MAX,
  normalizeClientAlertSummary,
} = await import("../server/services/adsOs/clientAlertRollup");
const { putAlerts, getStatusCheckDoc } = await import("../server/services/adsOs/store");
const { runInIsolatedSchema } = await import("./db-sandbox");

// Company-token accessor: env-only fallback, no settings/DB read; noop alert
// hooks so the real dispatcher chain never loads (same seam as the liveness suite).
const __tok = await import("../server/services/clickUpCompanyToken");
__tok.__setClickUpCompanyTokenStoreForTest({
  async get() {
    return undefined;
  },
  async set() {},
  async del() {},
  async recordAudit() {},
});
directory.__setDirectoryAlertHooksForTest({ onSuccess: async () => {}, onFailure: async () => {} });

let passed = 0;
function ok(cond: boolean, label: string): void {
  assert.equal(cond, true, label);
  passed++;
  console.log(`  ✓ ${label}`);
}

await runInIsolatedSchema(
  async () => {
    // ── (1) Deep-link capture ────────────────────────────────────────────────
    console.log("phase 1: deep-link capture");
    await directory.getClientDirectory({ force: true });
    const links = await directory.clickUpDeepLinks();
    ok(links.gads[CID_G_ON] === GADS_LINK, "later link field overwrites earlier (trimmed, js rejected)");
    ok(links.lsa[CID_L_CITY] === LSA_LINK, "LSA deep link captured from name-matched field");
    ok(links.gads[CID_SEED] === undefined, "no ClickUp link for the seed-backed CID");
    ok(links.lsa[CID_L_NOCITY] === undefined, "no ClickUp link for the linkless CID");

    // ── (2) Shipped seed integrity ───────────────────────────────────────────
    console.log("phase 2: seed");
    const seedEntries = Object.entries(AM_DEEPLINKS_SEED);
    ok(seedEntries.length === 46, "seed ships exactly 46 entries");
    ok(
      seedEntries.every(([k]) => /^(gads|lsa):\d+$/.test(k)),
      "every seed key is product:cid with digits-only cid",
    );
    ok(
      seedEntries.every(([, v]) => /^https?:\/\//.test(v)),
      "every seed value is http(s) — the scheme filter has nothing to drop",
    );

    // ── (3) Payload before any verification run ─────────────────────────────
    console.log("phase 3: payload pre-verification");
    // Alert fixtures: detail >200 chars must be capped; "weird" severity must
    // be listed-but-not-counted.
    const gadsAlertsAt = "2026-08-23T09:00:00.000Z";
    const lsaAlertsAt = "2026-08-23T09:05:00.000Z";
    await putAlerts("gads", CID_G_ON, {
      account_name: "Beta GAds",
      product: "gads",
      alerts: [
        { severity: "medium", title: "Budget pacing", detail: "m".repeat(300) },
        { severity: "weird", title: "Novel severity", detail: "listed, never counted" },
        { severity: "critical", title: "CPC spike", detail: "critical detail" },
      ],
      counts: { medium: 1, weird: 1, critical: 1 },
      generated_at: gadsAlertsAt,
    });
    await putAlerts("lsa", CID_L_CITY, {
      account_name: "Beta LSA",
      product: "lsa",
      alerts: [{ severity: "high", title: "Zero leads", detail: "high detail" }],
      counts: { high: 1 },
      generated_at: lsaAlertsAt,
    });

    let payload = await buildAmDashboard();
    assert.deepEqual(
      payload.clients.map((c) => c.client),
      ["ACME Law", "alpha co", "Beta Legal"],
      "clients sorted case-insensitively; offboarded + zero-account clients absent",
    );
    passed++;
    const beta = payload.clients[2];
    const acme = payload.clients[0];
    const alpha = payload.clients[1];

    assert.deepEqual(
      beta.accounts.map((a) => a.product),
      ["gads", "lsa"],
      "gads rows precede lsa rows",
    );
    passed++;
    ok(beta.accounts[0].label === "Google Ads", "gads label");
    ok(beta.accounts[1].label === "LSA - Springfield", "LSA city label");
    ok(acme.accounts[1].label === "LSA", "LSA without city keeps the bare label");
    ok(beta.doer === "Dana Doer" && beta.checker === "Carl Checker", "doer/checker from parent fields");
    ok(beta.log_url === "https://app.clickup.com/log/beta", "client log url");
    ok(acme.doer === null && acme.checker === null && acme.log_url === null, "missing people/log → null");
    ok(beta.accounts[0].deep_link === GADS_LINK, "deep link precedence: ClickUp field first");
    ok(
      acme.accounts[0].deep_link === AM_DEEPLINKS_SEED[`gads:${CID_SEED}`],
      "deep link precedence: seed fills ClickUp-less CID",
    );
    ok(acme.accounts[1].deep_link === null, "no field, no seed → null (never a guessed URL)");
    ok(acme.accounts[1].ads_status === "off", "Off account still shown (full book)");
    ok(
      beta.accounts.every((a) => a.status_check === null) &&
        acme.accounts.every((a) => a.status_check === null),
      "no verification run yet → every status_check null",
    );
    ok(payload.status_checked_at === null, "status_checked_at null before the first batch");
    ok(payload.clickup_ok === true, "clickup_ok true with a live roster");

    assert.deepEqual(
      { critical: beta.alerts.critical, high: beta.alerts.high, medium: beta.alerts.medium, total: beta.alerts.total },
      { critical: 1, high: 1, medium: 1, total: 3 },
      "roll-up counts critical/high/medium only — unknown severity not counted",
    );
    passed++;
    ok(beta.alerts.items.length === 4, "unknown-severity alert still LISTED");
    ok(beta.alerts.items[3].severity === "weird", "unknown severity sorts last");
    ok(beta.alerts.needs_attention === true, "critical/high roll-up explicitly qualifies needs attention");
    ok(beta.alerts.items_truncated === 0, "untruncated payload reports zero omitted details");
    assert.deepEqual(
      beta.alerts.items.slice(0, 3).map((i) => i.severity),
      ["critical", "high", "medium"],
      "known severities sort critical → high → medium",
    );
    passed++;
    ok(
      beta.alerts.items.every((i) => i.detail.length <= 200),
      "alert detail capped at 200 chars",
    );
    assert.deepEqual(
      beta.alerts.accounts,
      [
        {
          product: "gads",
          customer_id: CID_G_ON,
          account: "Google Ads",
          alerts_at: gadsAlertsAt,
        },
        {
          product: "lsa",
          customer_id: CID_L_CITY,
          account: "LSA - Springfield",
          alerts_at: lsaAlertsAt,
        },
      ],
      "AM roll-up preserves account labels and per-document freshness",
    );
    passed++;
    ok(alpha.alerts.total === 0 && alpha.alerts.items.length === 0, "no stored docs → zero roll-up");
    ok(
      alpha.alerts.accounts.length === 1 && alpha.alerts.accounts[0].alerts_at === null,
      "missing AM alert document keeps an empty account freshness contribution",
    );

    const capped = normalizeClientAlertSummary([
      {
        product: "gads",
        customer_id: "123-456-7890",
        account: "Cap Fixture",
        document: {
          generated_at: gadsAlertsAt,
          alerts: Array.from({ length: CLIENT_ALERT_ITEMS_MAX + 5 }, (_, i) => ({
            severity: i === 0 ? "critical" : "medium",
            title: `Alert ${i}`,
            detail: "d".repeat(300),
          })),
        },
      },
    ]);
    ok(capped.total === CLIENT_ALERT_ITEMS_MAX + 5, "item cap never changes full known-severity counts");
    ok(capped.items.length === CLIENT_ALERT_ITEMS_MAX, "normalized roll-up caps emitted item details");
    ok(capped.items_truncated === 5, "normalized roll-up reports omitted item-detail count");
    assert.deepEqual(payload.managers, ["Dana Doer"], "managers derived from data");
    passed++;
    assert.deepEqual(payload.checkers, ["Carl Checker"], "checkers derived from data");
    passed++;

    // ── (4) runStatusChecks — mixed batch ────────────────────────────────────
    console.log("phase 4: verification sweep");
    const longName = "Very Long Campaign Name ".repeat(5); // >80 chars
    gaqlRows[CID_L_CITY] = [longName, "C2", "C3", "C4", "C5", "C6"]; // 6 enabled → mismatch
    gaqlRows[CID_SEED] = []; // paused claim holds
    gaqlRows[CID_L_NOCITY] = []; // off claim holds
    delete gaqlRows[CID_G_ERR]; // → stubbed 500 → per-account error entry
    gaqlLog.length = 0;

    const run1 = await runStatusChecks();
    assert.deepEqual(
      run1,
      { checked: 4, mismatches: 1, errors: 1, saved: true },
      "mixed batch summary (checked/mismatches/errors/saved)",
    );
    passed++;

    ok(
      !gaqlLog.some((l) => l.cid === CID_G_ON),
      "On account never queried — targets are paused/off only",
    );
    const lsaQ = gaqlLog.find((l) => l.cid === CID_L_CITY)?.query ?? "";
    const gadsQ = gaqlLog.find((l) => l.cid === CID_SEED)?.query ?? "";
    ok(lsaQ.includes("advertising_channel_type = 'LOCAL_SERVICES'"), "LSA scoped = LOCAL_SERVICES");
    ok(gadsQ.includes("advertising_channel_type != 'LOCAL_SERVICES'"), "GAds scoped != LOCAL_SERVICES");
    ok(
      [lsaQ, gadsQ].every(
        (q) => q.includes("campaign.status = 'ENABLED'") && q.includes("campaign.serving_status != 'ENDED'"),
      ),
      "both queries require ENABLED and serving_status != ENDED",
    );

    const doc1 = await getStatusCheckDoc();
    const mm = doc1.checks[`lsa:${CID_L_CITY}`];
    ok(mm?.matches === false && mm?.enabled_campaigns === 6, "mismatch entry: matches false, real count");
    ok(mm?.enabled_campaign_names.length === 5, "offending names capped at 5");
    ok(
      mm?.enabled_campaign_names.every((n: string) => n.length <= 80),
      "each offending name capped at 80 chars",
    );
    ok(doc1.checks[`gads:${CID_SEED}`]?.matches === true, "holding paused claim → matches true");
    ok(doc1.checks[`lsa:${CID_L_NOCITY}`]?.matches === true, "holding off claim → matches true");
    const errEntry = doc1.checks[`gads:${CID_G_ERR}`];
    ok(
      typeof errEntry?.error === "string" && errEntry.matches === undefined,
      "errored account records error, no verdict",
    );
    const stamps = new Set(Object.values(doc1.checks).map((c: any) => c.checked_at));
    ok(stamps.size === 1 && doc1.generated_at === [...stamps][0], "one shared now per batch");

    // ── (6a) Payload after verification ─────────────────────────────────────
    console.log("phase 5: payload post-verification");
    payload = await buildAmDashboard();
    const beta2 = payload.clients[2];
    const acme2 = payload.clients[0];
    const alpha2 = payload.clients[1];
    ok(beta2.accounts[0].status_check === null, "On account still carries no chip data");
    ok(
      beta2.accounts[1].status_check?.matches === false &&
        beta2.accounts[1].status_check?.enabled_campaign_names?.length === 5,
      "paused-but-serving account carries the ✗ entry with names",
    );
    ok(acme2.accounts[1].status_check?.matches === true, "off-and-silent account carries the ✓ entry");
    ok(typeof alpha2.accounts[0].status_check?.error === "string", "errored account carries the error entry");
    ok(payload.status_checked_at === doc1.generated_at, "status_checked_at = the batch's generated_at");

    // ── (5) The three keep-last-batch guards ────────────────────────────────
    console.log("phase 6: no_targets guard");
    statusMode = "allOn";
    await directory.getClientDirectory({ force: true });
    const run2 = await runStatusChecks();
    assert.deepEqual(run2, { skipped: "no_targets" }, "all-On roster skips with no_targets");
    passed++;
    ok((await getStatusCheckDoc()).generated_at === doc1.generated_at, "no_targets kept the last batch");

    console.log("phase 7: all_errored guard");
    statusMode = "mixed";
    await directory.getClientDirectory({ force: true });
    gaqlAllError = true;
    const run3 = await runStatusChecks();
    assert.deepEqual(run3, { skipped: "all_errored", errors: 4 }, "MCC-wide outage skips with all_errored");
    passed++;
    ok((await getStatusCheckDoc()).generated_at === doc1.generated_at, "all_errored kept the last batch");
    gaqlAllError = false;

    console.log("phase 8: clickup_unavailable guard");
    clickUpDown = true;
    await directory.getClientDirectory({ force: true }); // failed refresh → stale bundle, not live
    const run4 = await runStatusChecks();
    assert.deepEqual(run4, { skipped: "clickup_unavailable" }, "dead directory skips before any query");
    passed++;
    ok((await getStatusCheckDoc()).generated_at === doc1.generated_at, "clickup_unavailable kept the last batch");

    // ── (6b) clickup_ok semantics ────────────────────────────────────────────
    payload = await buildAmDashboard();
    ok(
      payload.clients.length === 3 && payload.clickup_ok === true,
      "stale-but-served roster keeps the board up (clickup_ok true)",
    );

    console.log("phase 9: empty roster");
    directory.__testResetDirectoryCache();
    await directory.getClientDirectory({ force: true }); // down + no cache → empty bundle
    payload = await buildAmDashboard();
    ok(
      payload.clients.length === 0 && payload.clickup_ok === false,
      "fresh cache + ClickUp down → empty board flagged clickup_ok false",
    );
    clickUpDown = false;
  },
  { tables: ["ads_os_status_checks", "ads_os_account_alerts"] },
);

console.log(`\nads-os-am-status-check: ${passed} assertion(s) passed.`);
