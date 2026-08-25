/* test-registration
{
  "name": "Ads OS Pyramid page — real PyramidTool.tsx mounts in jsdom for full-AI / rules_only (null scores+confidence) / partial-empty / ineligible payloads: summary card, tier-nav counts, campaign cards, killer-keyword table, relevancy table (Task #3641)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3641: the Pyramid REVIEW PAGE itself — mounts the real component in jsdom against full-AI, rules_only (null relevancy/confidence), empty, and ineligible payloads. Backend suites can't see a null-field render crash that blanks the page; DB-free, network-free, ~2s.",
  "extraNodeArgs": [
    "--import",
    "./tests/ads-os-pyramid-tool-setup.mjs"
  ],
  "extraEnv": {
    "NODE_ENV": "test",
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #3641 — catch a blank Pyramid page before it ships.
 *
 * Mounts the REAL PyramidTool page component (client/src/pages/adsOs/
 * PyramidTool.tsx) in jsdom with a stubbed fetch and proves it renders
 * without throwing for every payload shape the backend can serve:
 *
 *   1. FULL AI payload — summary card (exec summary, AI-status badge, stats,
 *      action chips), tier-nav counts, campaign cards (confidence, budget
 *      recommendation, flag badges, ad-group rows), killer-keyword table
 *      (path column, rule badge, AI-dissent chip), and the relevancy table
 *      (scored chips, matched keywords, added/excluded tags, term filter).
 *   2. rules_only payload — no relevancy scores anywhere (null relevancy /
 *      "" labels), null confidence, rollup.relevancy_avg null, no criteria:
 *      the degraded path the task calls out (a null-field access here blanks
 *      the whole review page).
 *   3. partial payload with ZERO campaigns and empty rollup lists — the
 *      empty-map edge (campaigns, killer keywords, terms all empty states).
 *   4. ineligible payload — the not-enrolled panel with the scope note.
 *
 * DB-free / network-free. Harness per memory note
 * mount-large-client-component-jsdom: heavyClientLoader stubs the
 * `import "../adsOs.css"` side-effect (setup: tests/ads-os-pyramid-tool-setup.mjs),
 * TSX_TSCONFIG_PATH=./tsconfig.tests.json for the react-jsx transform, and
 * wouter needs bare `location`/`history`/`addEventListener` globals.
 */
import { strict as assert } from "node:assert";

import { JSDOM } from "jsdom";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — .mjs helper without type declarations
import { createFetchStub } from "./helpers/createFetchStub.mjs";

const CID = "1112223333";

// ── jsdom bootstrap (must precede the dynamic client imports) ──
const dom = new JSDOM(
  "<!doctype html><html><body><div id='root'></div></body></html>",
  { pretendToBeVisual: true, url: `http://localhost/ads-os/a/${CID}/pyramid` },
);
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
(globalThis as any).navigator = dom.window.navigator;
(globalThis as any).location = dom.window.location;
(globalThis as any).history = dom.window.history;
(globalThis as any).localStorage = dom.window.localStorage;
(globalThis as any).dispatchEvent = dom.window.dispatchEvent.bind(dom.window);
(globalThis as any).addEventListener = dom.window.addEventListener.bind(dom.window);
(globalThis as any).removeEventListener = dom.window.removeEventListener.bind(dom.window);
(globalThis as any).HTMLElement = dom.window.HTMLElement;
(globalThis as any).HTMLInputElement = dom.window.HTMLInputElement;
(globalThis as any).HTMLButtonElement = dom.window.HTMLButtonElement;
(globalThis as any).HTMLAnchorElement = dom.window.HTMLAnchorElement;
(globalThis as any).HTMLSelectElement = dom.window.HTMLSelectElement;
(globalThis as any).Element = dom.window.Element;
(globalThis as any).Node = dom.window.Node;
(globalThis as any).MouseEvent = dom.window.MouseEvent;
(globalThis as any).Event = dom.window.Event;
(globalThis as any).CustomEvent = dom.window.CustomEvent;
(globalThis as any).getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
(globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) =>
  setTimeout(() => cb(0), 0) as unknown as number;
(globalThis as any).cancelAnimationFrame = (id: number) => clearTimeout(id);
if (!(globalThis as any).IS_REACT_ACT_ENVIRONMENT) {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
}

type AnyRec = Record<string, any>;

// ── Fixtures — shapes mirror client/src/pages/adsOs/lib/types.ts (which
// mirrors server/services/adsOs/pyramid/models.ts; numbers borrowed from
// tests/ads-os-pyramid-engine.test.ts's canonical fixture). ──

function term(over: AnyRec = {}): AnyRec {
  return {
    search_term: "t",
    targeting_status: "NONE",
    matched_keywords: ["kw"],
    cost: 0,
    conversions: 0,
    clicks: 0,
    impressions: 100,
    relevancy: null,
    relevancy_label: "",
    relevancy_reason: "",
    ...over,
  };
}
function kw(over: AnyRec = {}): AnyRec {
  return {
    criterion_id: "k0",
    text: "kw",
    match_type: "EXACT",
    status: "ENABLED",
    quality_score: 7,
    cost: 0,
    conversions: 0,
    clicks: 0,
    impressions: 0,
    cpl: null,
    flags: [],
    action: "keep",
    rationale: "",
    ai_agrees: null,
    insufficient_data: false,
    campaign_name: "",
    ad_group_name: "",
    ...over,
  };
}
function ag(over: AnyRec = {}): AnyRec {
  return {
    id: "g0",
    name: "AG",
    status: "ENABLED",
    cost: 0,
    conversions: 0,
    clicks: 0,
    impressions: 0,
    cpl: null,
    relevancy_avg: null,
    irrelevant_cost_pct: null,
    flags: [],
    action: "keep",
    rationale: "",
    insufficient_data: false,
    keywords: [],
    keywords_total: 0,
    search_terms: [],
    search_terms_total: 0,
    ...over,
  };
}
function camp(over: AnyRec = {}): AnyRec {
  return {
    id: "c0",
    name: "Camp",
    status: "ENABLED",
    channel_type: "SEARCH",
    bidding_strategy_type: "MAXIMIZE_CONVERSIONS",
    target_cpa: null,
    daily_budget: null,
    cost: 0,
    conversions: 0,
    clicks: 0,
    impressions: 0,
    cpl: null,
    baseline_cpl: null,
    baseline_source: "none",
    search_is: null,
    lost_is_budget: null,
    lost_is_rank: null,
    flags: [],
    action: "keep",
    rationale: "",
    confidence: null,
    recommended_budget_change_pct: null,
    insufficient_data: false,
    scale_candidate: false,
    ad_groups: [],
    ...over,
  };
}
function emptyRollup(over: AnyRec = {}): AnyRec {
  return {
    action_counts: {},
    campaign_actions: {},
    ad_group_actions: {},
    keyword_actions: {},
    flagged_keywords: 0,
    flagged_keyword_cost: 0,
    killer_keywords: [],
    worst_terms: [],
    scored_terms: 0,
    scored_term_cost: 0,
    irrelevant_term_cost: 0,
    relevancy_avg: null,
    ...over,
  };
}
function baseReport(over: AnyRec = {}): AnyRec {
  return {
    customer_id: CID,
    account_name: "NoBull Law",
    currency_code: "USD",
    generated_at: "2026-07-27T00:00:00Z",
    lookback_days: 30,
    window_start: "2026-06-26",
    window_end: "2026-07-25",
    account_cost: 0,
    account_conversions: 0,
    account_cpl: null,
    baseline_note: "",
    executive_summary: "",
    next_steps: [],
    campaigns: [],
    rollup: emptyRollup(),
    ai_status: "rules_only",
    ai_model_used: "",
    eligible: true,
    monitored_campaigns: 0,
    scope_note: "",
    has_criteria: false,
    warnings: [],
    from_cache: false,
    ...over,
  };
}

// Campaign/ad-group/keyword/term graph shared by the full-AI and rules_only
// fixtures; `scored` toggles the relevancy/AI-annotation fields so the same
// structure exercises both the populated and the null branches.
function makeCampaigns(scored: boolean): AnyRec[] {
  const k1 = kw({
    criterion_id: "k1",
    text: "cheap divorce lawyer",
    quality_score: 2,
    cost: 250,
    clicks: 30,
    impressions: 900,
    cpl: null,
    flags: ["KW_PAUSE_ZERO_CONV", "KW_LOW_QS"],
    action: "pause",
    rationale: scored ? "Brand-adjacent, keep it." : "$250 spent with 0 conversions.",
    ai_agrees: scored ? false : null,
  });
  const k2 = kw({
    criterion_id: "k2",
    text: "family lawyer",
    match_type: "PHRASE",
    quality_score: 8,
    cost: 60,
    conversions: 3,
    clicks: 20,
    impressions: 400,
    cpl: 20,
    action: "keep",
  });
  const k4 = kw({
    criterion_id: "k4",
    text: "free consultation lawyer",
    match_type: "BROAD",
    quality_score: 4,
    cost: 450,
    clicks: 50,
    impressions: 1400,
    cpl: null,
    flags: ["KW_PAUSE_ZERO_CONV"],
    action: "pause",
    rationale: scored ? "Yes, waste." : "$450 spent with 0 conversions.",
    ai_agrees: scored ? true : null,
  });
  const t1 = term({
    search_term: "personal injury attorney",
    cost: 120,
    clicks: 15,
    impressions: 800,
    relevancy: scored ? 10 : null,
    relevancy_label: scored ? "irrelevant" : "",
    relevancy_reason: scored ? "Injury, not family law" : "",
  });
  const t2 = term({
    search_term: "divorce attorney near me",
    targeting_status: "ADDED",
    matched_keywords: ["divorce attorney", "attorney near me"],
    cost: 100,
    conversions: 2,
    clicks: 12,
    impressions: 500,
    relevancy: scored ? 95 : null,
    relevancy_label: scored ? "high_intent" : "",
    relevancy_reason: scored ? "Core divorce intent" : "",
  });
  const t5 = term({
    search_term: "free legal aid",
    targeting_status: "EXCLUDED",
    cost: 30,
    clicks: 6,
    impressions: 200,
  });
  const g1 = ag({
    id: "g1",
    name: "AG One",
    cost: 600,
    conversions: 6,
    clicks: 120,
    impressions: 2500,
    cpl: 100,
    relevancy_avg: scored ? 48.6 : null,
    irrelevant_cost_pct: scored ? 54.5 : null,
    flags: scored ? ["AG_IRRELEVANT_TRAFFIC"] : [],
    action: "watch",
    rationale: "Traffic mix needs negatives work.",
    keywords: [k1, k2],
    keywords_total: 2,
    search_terms: [t1, t2, t5],
    search_terms_total: 3,
  });
  const g4 = ag({
    id: "g4",
    name: "AG Two",
    cost: 690,
    clicks: 95,
    impressions: 2900,
    cpl: null,
    flags: ["AG_PAUSE_ZERO_CONV"],
    action: "pause",
    rationale: "$690 with 0 conversions.",
    keywords: [k4],
    keywords_total: 1,
    search_terms: [],
    search_terms_total: 0,
  });
  return [
    camp({
      id: "c1",
      name: "Alpha Search",
      cost: 1000,
      conversions: 10,
      clicks: 200,
      impressions: 5000,
      cpl: 100,
      baseline_cpl: 100,
      baseline_source: "campaign",
      daily_budget: 40,
      search_is: 60.4,
      lost_is_budget: 5.2,
      lost_is_rank: 8.9,
      action: "keep",
      rationale: "Alpha has headroom.",
      confidence: scored ? 0.9 : null,
      recommended_budget_change_pct: scored ? 25 : null,
      ad_groups: [g1],
    }),
    camp({
      id: "c2",
      name: "Beta Zero",
      status: "PAUSED",
      channel_type: "PERFORMANCE_MAX",
      cost: 700,
      clicks: 100,
      impressions: 3000,
      cpl: null,
      baseline_cpl: 201,
      baseline_source: "account",
      target_cpa: 90,
      flags: ["CAMP_PAUSE_ZERO_CONV"],
      action: "pause",
      rationale: "Kill it.",
      confidence: scored ? 1 : null,
      ad_groups: [g4],
    }),
  ];
}

function killerRollupKeywords(scored: boolean): AnyRec[] {
  return [
    kw({
      criterion_id: "k4",
      text: "free consultation lawyer",
      match_type: "BROAD",
      quality_score: 4,
      cost: 450,
      clicks: 50,
      flags: ["KW_PAUSE_ZERO_CONV"],
      action: "pause",
      rationale: scored ? "Yes, waste." : "$450 spent with 0 conversions.",
      ai_agrees: scored ? true : null,
      campaign_name: "Beta Zero",
      ad_group_name: "AG Two",
    }),
    kw({
      criterion_id: "k1",
      text: "cheap divorce lawyer",
      quality_score: 2,
      cost: 250,
      clicks: 30,
      flags: ["KW_PAUSE_ZERO_CONV", "KW_LOW_QS"],
      action: "pause",
      rationale: scored ? "Brand-adjacent, keep it." : "$250 spent with 0 conversions.",
      ai_agrees: scored ? false : null,
      campaign_name: "Alpha Search",
      ad_group_name: "AG One",
    }),
  ];
}

const FULL_REPORT = baseReport({
  account_cost: 2010,
  account_conversions: 10,
  account_cpl: 201,
  executive_summary:
    "Beta Zero burns $700 with zero conversions — pause it and reinvest in Alpha Search.",
  next_steps: [
    { priority: 1, step: "Pause Beta Zero" },
    { priority: 2, step: "Add negatives to AG One" },
  ],
  campaigns: makeCampaigns(true),
  rollup: emptyRollup({
    action_counts: { keep: 2, pause: 4, watch: 2 },
    flagged_keywords: 2,
    flagged_keyword_cost: 700,
    killer_keywords: killerRollupKeywords(true),
    worst_terms: [],
    scored_terms: 2,
    scored_term_cost: 220,
    irrelevant_term_cost: 120,
    relevancy_avg: 48.6,
  }),
  ai_status: "full",
  ai_model_used: "gpt-5.5",
  monitored_campaigns: 2,
  scope_note: "Reviewing 2 labeled campaign(s), last 30 full days.",
  has_criteria: true,
  warnings: ["geo names query failed (kept going)"],
  from_cache: true,
});

// The degraded no-AI path: no relevancy scores, "" labels, null confidence,
// null relevancy_avg, no criteria — every null branch of the component.
const RULES_ONLY_REPORT = baseReport({
  account_cost: 2010,
  account_conversions: 10,
  account_cpl: 201,
  executive_summary: "Rules-only review: Beta Zero is past the pause line.",
  campaigns: makeCampaigns(false),
  rollup: emptyRollup({
    action_counts: { keep: 2, pause: 4, watch: 2 },
    flagged_keywords: 2,
    flagged_keyword_cost: 700,
    killer_keywords: killerRollupKeywords(false),
  }),
  ai_status: "rules_only",
  ai_model_used: "",
  monitored_campaigns: 2,
  scope_note: "Reviewing 2 labeled campaign(s), last 30 full days.",
  has_criteria: false,
});

// Partial AI with ZERO campaigns/keywords/terms — the empty-map edge.
const PARTIAL_EMPTY_REPORT = baseReport({
  executive_summary: "No campaign had activity in the window.",
  ai_status: "partial",
  ai_model_used: "",
  monitored_campaigns: 2,
  warnings: ["Relevancy scoring failed — showing rule verdicts only."],
});

const INELIGIBLE_REPORT = baseReport({
  eligible: false,
  scope_note:
    "This account isn't enrolled. Add it to the ClickUp Client List (a subtask " +
    "with this account's Google CID) to include it in the Pyramid Breakdown.",
});

// ── Fetch stub: scenario-switchable pyramid payload ──
// Setting `currentReport = null` makes the pyramid route answer a 500 with a
// `detail` body, exercising the ApiError → error-panel path.
let currentReport: AnyRec | null = FULL_REPORT;
const fetchStub = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    {
      path: `/api/ads-os/pyramid/${CID}`,
      respond: () =>
        currentReport
          ? { status: 200, json: currentReport }
          : { status: 500, json: { detail: "Google Ads pull failed (boom)" } },
    },
    {
      path: "/api/ads-os/monitored-accounts",
      json: { accounts: [{ customer_id: CID, descriptive_name: "NoBull Law (list)" }] },
    },
  ],
  defaultJson: {},
});
(globalThis as any).fetch = fetchStub;

// ── Harness ──
const React = (await import("react")).default ?? (await import("react"));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
// AdsOsShell calls the real use-auth hook to role-gate the CEO-only System
// Checks tab (Task #4375); react-query hooks throw without a provider, so the
// mount wraps in a QueryClientProvider. The Clerk stub in the setup file is
// signed-OUT, which keeps use-auth's /api/auth/user query disabled — no fetch,
// user stays null, the tab simply stays hidden (irrelevant to these asserts).
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const PyramidToolPage = (await import("../client/src/pages/adsOs/PyramidTool")).default;

let failed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err: any) {
    failed++;
    console.error(`  ✗ ${name}\n    ${err?.stack ?? err}`);
  }
}

const flush = async (times = 10) => {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
};

const $t = (id: string): HTMLElement | null =>
  document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const text = (sel: string): string =>
  Array.from(document.querySelectorAll(sel))
    .map((e) => e.textContent ?? "")
    .join(" | ");

/** Mount the real page with `report` as the pyramid payload; run `fn` against
 *  the settled DOM; always unmount. React re-throws render errors through
 *  act(), so a null-field crash in ANY scenario fails that check loudly
 *  instead of blanking silently. */
async function withMounted(report: AnyRec | null, fn: () => void | Promise<void>): Promise<void> {
  currentReport = report;
  const container = document.getElementById("root")!;
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        React.createElement(
          QueryClientProvider as any,
          { client: queryClient },
          React.createElement(PyramidToolPage as any),
        ),
      );
    });
    await flush();
    await fn();
  } finally {
    await act(async () => {
      root.unmount();
    });
  }
}

// ---------------------------------------------------------------------------
console.log("PyramidTool render — full AI payload");
// ---------------------------------------------------------------------------

await withMounted(FULL_REPORT, async () => {
  await check("page mounts past the loading spinner", () => {
    assert.ok($t("page-ads-os-pyramid"), "page root renders");
    assert.equal(document.querySelector(".panel.loading"), null, "spinner gone");
    assert.equal($t("text-pyramid-error"), null, "no error panel");
  });

  await check("header: resolved account name + window + cache tag", () => {
    const top = document.querySelector(".report-title")!.textContent!;
    assert.match(top, /NoBull Law \(list\)/); // monitored-accounts lookup won
    assert.match(top, /2026-06-26 → 2026-07-25/);
    assert.match(top, /cached/);
    assert.match(top, /2 labeled campaign\(s\)/);
  });

  await check("summary card: exec summary, AI badge, stats, action chips", () => {
    assert.match(text(".pyr-exec"), /Beta Zero burns \$700/);
    assert.equal(
      document.querySelector(".pyr-ai-status")!.textContent,
      "AI review · gpt-5.5",
    );
    const stats = text(".ki-stat");
    assert.match(stats, /Spend \(30d\)/);
    assert.match(stats, /Account CPL/);
    assert.match(stats, /2 keyword\(s\)/); // killer-keyword sub
    assert.match(stats, /avg relevancy 49\/100/); // Math.round(48.6)
    const chips = text(".pyr-action-chips .pyr-chip");
    assert.match(chips, /Keep 2/);
    assert.match(chips, /Pause 4/);
    assert.match(chips, /Watch 2/);
    // next steps list renders both steps
    assert.equal(document.querySelectorAll(".pyr-steps li").length, 2);
    // saved criteria → no "Add criteria" hint
    assert.equal(document.querySelector(".ki-hint"), null);
  });

  await check("warnings banner renders the pull warning", () => {
    assert.match(text(".banner-amber"), /geo names query failed/);
  });

  await check("tier nav: campaign/ad-group/keyword/term counts", () => {
    const tiers = Array.from(document.querySelectorAll(".pyr-tier")).map(
      (e) => e.textContent!.replace(/\s+/g, " "),
    );
    assert.equal(tiers.length, 4);
    assert.match(tiers[0], /Campaigns2/);
    assert.match(tiers[0], /1 to action/); // Beta pause; Alpha keep isn't flagged
    assert.match(tiers[1], /Ad groups2/);
    assert.match(tiers[1], /2 flagged/); // g1 watch + g4 pause
    assert.match(tiers[2], /Keywords3/);
    assert.match(tiers[2], /2 to pause/);
    assert.match(tiers[3], /Search terms3/);
    assert.match(tiers[3], /2 scored/);
  });

  await check("campaign cards: names, confidence, budget rec, flags, ad groups", () => {
    const cards = document.querySelectorAll("#pyr-campaigns .pyr-camp");
    assert.equal(cards.length, 2);
    const all = text("#pyr-campaigns .pyr-camp");
    assert.match(all, /Alpha Search/);
    assert.match(all, /Beta Zero/);
    assert.match(all, /90% confident/); // Alpha 0.9
    assert.match(all, /▲ Raise daily budget ~25%/);
    assert.match(all, /\(\$40\.00 → \$50\.00\)/); // 40 * 1.25
    assert.match(all, /paused/); // Beta's non-ENABLED status pill
    assert.match(all, /performance max/i); // non-SEARCH channel label
    assert.match(text(".pyr-flags .pyr-rule"), /0 conv · >3× CPL spent/); // CAMP_PAUSE_ZERO_CONV badge
    // ad-group rows (Alpha auto-collapsed on keep; Beta pause auto-opens g4)
    assert.match(text(".pyr-ag-row"), /AG Two/);
  });

  await check("killer-keyword table: rows, path, rule badge, AI dissent", () => {
    const rows = document.querySelectorAll("#pyr-keywords tbody tr");
    assert.equal(rows.length, 2);
    const body = text("#pyr-keywords tbody");
    assert.match(body, /free consultation lawyer/);
    assert.match(body, /cheap divorce lawyer/);
    assert.match(body, /Beta Zero › AG Two/); // showPath column
    assert.match(body, /0 conv · >2× CPL spent/); // KW_PAUSE rule label
    assert.match(body, /AI dissents/); // k1 ai_agrees === false
    assert.match(text("#pyr-keywords .pyr-section-h"), /\$700\.00 in the window/);
  });

  await check("relevancy table: scored chips, tags, matched keywords, filter", () => {
    const rows = document.querySelectorAll("#pyr-terms tbody tr");
    assert.equal(rows.length, 3); // flattened + deduped account-wide list
    const body = text("#pyr-terms tbody");
    assert.match(body, /personal injury attorney/);
    assert.match(body, /divorce attorney near me/);
    assert.match(body, /free legal aid/);
    assert.match(body, /Injury, not family law/); // relevancy_reason column
    assert.match(text(".pyr-rel.irr"), /10/); // scored chip
    assert.match(text(".pyr-rel.hi"), /95/);
    assert.ok(document.querySelector(".pyr-rel.unscored"), "excluded term unscored chip");
    assert.ok(document.querySelector(".pyr-ts.added"), "'added' tag renders");
    assert.ok(document.querySelector(".pyr-ts.excluded"), "'excluded' tag renders");
    assert.match(body, /divorce attorney, attorney near me/); // matched keywords cell
    const filter = $t("select-term-filter")!;
    assert.match(filter.textContent!, /All terms \(3\)/);
    assert.match(text("#pyr-terms .pyr-section-h"), /2 terms scored/);
  });
});

// ---------------------------------------------------------------------------
console.log("PyramidTool render — rules_only payload (no scores, null confidence)");
// ---------------------------------------------------------------------------

await withMounted(RULES_ONLY_REPORT, async () => {
  await check("rules_only renders the full review without throwing", () => {
    assert.ok($t("page-ads-os-pyramid"));
    assert.equal($t("text-pyramid-error"), null);
    assert.equal(document.querySelector(".pyr-ai-status")!.textContent, "rules-only review");
    assert.equal(document.querySelectorAll("#pyr-campaigns .pyr-camp").length, 2);
    assert.equal(document.querySelectorAll("#pyr-keywords tbody tr").length, 2);
    assert.equal(document.querySelectorAll("#pyr-terms tbody tr").length, 3);
  });

  await check("null confidence / null relevancy branches render their fallbacks", () => {
    assert.equal(document.querySelector(".pyr-conf"), null, "no confidence pill");
    assert.equal(document.querySelector(".pyr-budget-rec"), null, "no budget rec");
    // every term chip is the unscored em-dash; no scored classes anywhere
    assert.equal(document.querySelectorAll(".pyr-rel.unscored").length, 3);
    assert.equal(document.querySelector(".pyr-rel.hi, .pyr-rel.irr, .pyr-rel.rel, .pyr-rel.adj"), null);
    assert.match(text(".ki-stat"), /not scored/); // relevancy_avg === null sub
    assert.equal(document.querySelector(".pyr-dissent"), null, "no AI dissent chip");
    // has_criteria false → the Add-criteria hint renders
    assert.match(text(".ki-hint"), /No saved criteria/);
    // scored_terms 0 → the tier shows no "scored" suffix and no section stats
    assert.doesNotMatch(text(".pyr-tier"), /scored/);
  });
});

// ---------------------------------------------------------------------------
console.log("PyramidTool render — partial payload with zero campaigns (empty maps)");
// ---------------------------------------------------------------------------

await withMounted(PARTIAL_EMPTY_REPORT, async () => {
  await check("empty campaigns/keywords/terms render their empty states", () => {
    assert.ok($t("page-ads-os-pyramid"));
    assert.equal(document.querySelector(".pyr-ai-status")!.textContent, "partial AI review");
    assert.match(text(".banner-amber"), /Relevancy scoring failed/);
    assert.match(text("#pyr-campaigns .panel"), /No campaign activity in this window/);
    assert.match(text("#pyr-keywords .panel"), /No keywords need pausing/);
    assert.match(text("#pyr-terms .panel"), /No search terms in this view/);
    const tiers = text(".pyr-tier").replace(/\s+/g, " ");
    assert.match(tiers, /Campaigns0/);
    assert.match(tiers, /Search terms0/);
  });
});

// ---------------------------------------------------------------------------
console.log("PyramidTool render — ineligible payload");
// ---------------------------------------------------------------------------

await withMounted(INELIGIBLE_REPORT, async () => {
  await check("not-enrolled panel renders the scope note, no review sections", () => {
    assert.ok($t("page-ads-os-pyramid"));
    const panel = document.querySelector(".ki-notenrolled")!;
    assert.ok(panel, "not-enrolled panel renders");
    assert.match(panel.textContent!, /Not enrolled in Pyramid Breakdown/);
    assert.match(panel.textContent!, /ClickUp Client List/);
    assert.equal(document.querySelector(".pyr-summary-card"), null);
    assert.equal(document.querySelector(".pyr-tiers"), null);
  });
});

// ---------------------------------------------------------------------------
console.log("PyramidTool render — API error");
// ---------------------------------------------------------------------------

await withMounted(null, async () => {
  await check("a failed pyramid pull renders the error panel, never a blank page", () => {
    assert.ok($t("page-ads-os-pyramid"));
    const panel = $t("text-pyramid-error");
    assert.ok(panel, "error panel renders");
    assert.equal(panel!.textContent, "Google Ads pull failed (boom)");
    assert.equal(document.querySelector(".panel.loading"), null, "not stuck on the spinner");
    assert.equal(document.querySelector(".pyr-summary-card"), null);
  });
});

console.log(failed === 0 ? "ALL PASS" : `${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
