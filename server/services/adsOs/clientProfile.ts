/**
 * Ads OS — client profile: everything the per-client page needs, assembled
 * read-only. Port of backend/app/client_profile.py (+ find_sibling from
 * combined_dashboard.py, resolved via the ClickUp directory here — same source
 * the rest of this port uses for client↔account grouping).
 *
 * Sources the app already keeps warm, so a profile open is cheap and
 * consistent: the combined-dashboard cache supplies the account list +
 * combined KPIs (numbers match the Main Dashboard exactly; zero extra Ads API
 * calls on a warm cache), the pacing / hygiene / traffic-quality / pyramid /
 * alerts stores supply the live overlays (never stale — same discipline as the
 * dashboards), and the ClickUp directory supplies identity plus the
 * "Paid Search Client Log" link. The AI log summary is NOT built here — it's a
 * separate, lazier endpoint (clientLog.ts) the page fetches async.
 */

import { clientBlocks, clientRecord, normClientName } from "./clickUpDirectory";
import { sheetIdFromUrl } from "./clientLog";
import { buildCombinedDashboardCached } from "./combinedDashboardService";
import {
  auditScoresStore,
  budgetPacingStore,
  getStatusCheckDoc,
  lsaAuditScoresStore,
  lsaBudgetPacingStore,
  pyramidBreakdownStore,
  trafficQualityStore,
} from "./store";

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * The profile payload for one client (matched by normalized name against the
 * combined dashboard's client rows), or null when no monitored client matches.
 */
export async function buildClientProfile(
  name: string,
  window: number | unknown = 30,
  compare: string | unknown = "previous",
): Promise<Record<string, any> | null> {
  const { resp, fromCache } = await buildCombinedDashboardCached(false, window, compare);
  const want = normClientName(name);
  const row = resp.rows.find((r) => normClientName(r.client) === want);
  if (!row) return null;

  const rec = await clientRecord(row.client);
  const logUrl = rec?.log_url ?? null;

  // Morning Paused/Off verification verdicts (Task #3989, mirroring the AM
  // Dashboard): ONE read of the single-document batch — no Ads API calls, and
  // no per-account gets that could tear across the batch's generated_at.
  const checkDoc = await getStatusCheckDoc();
  const statusChecks: Record<string, any> = checkDoc.checks || {};

  const accounts: Record<string, any>[] = [];
  const pacingRows: Record<string, any>[] = [];
  const hygiene: Record<string, any>[] = [];
  const quality: Record<string, any>[] = [];
  const pyramid: Record<string, any>[] = [];
  for (const m of row.members) {
    const gads = m.product === "gads";
    accounts.push({
      product: m.product,
      customer_id: m.customer_id,
      name: m.descriptive_name,
      city: m.city,
      // ClickUp Ads Status: "on"|"paused"|"off"|null (null = blank, treated as
      // On). Off accounts are always listed here (with the tag) even though
      // they drop off the monitoring dashboards.
      ads_status: m.ads_status,
      // The morning verification result for Paused/Off claims (null for On
      // accounts, or when the check hasn't run yet) — same key convention as
      // the AM Dashboard so both surfaces show the SAME verdict.
      status_check:
        m.ads_status === "paused" || m.ads_status === "off"
          ? (statusChecks[`${m.product}:${m.customer_id}`] ?? null)
          : null,
      // Task #4964: "Setup needed — no labeled campaigns" (active campaigns,
      // zero monitor labels — the $0s below are not real zeros).
      zero_label: m.zero_label === true,
      currency: m.currency_code,
      spend_30d: m.spend_30d,
      spend_prev: m.spend_prev,
      leads_30d: m.leads_30d,
      leads_prev: m.leads_prev,
      cpl_30d: m.cpl_30d,
      // Members don't carry a previous-window CPL; derive it the same way the
      // dashboards do (prev spend / prev leads).
      cpl_prev: m.leads_prev > 0 ? round2(m.spend_prev / m.leads_prev) : null,
    });

    // Pacing straight from the per-product stores (they carry expected-to-date
    // + the recommendation, which the dashboard overlay doesn't attach).
    const p =
      ((gads ? await budgetPacingStore.get(m.customer_id) : await lsaBudgetPacingStore.get(m.customer_id)) ??
        {}) as Record<string, any>;
    const budget = (p.monthly_budget ?? null) as number | null;
    const mtd = (p.mtd_spend ?? null) as number | null;
    const expected = (p.expected_to_date ?? null) as number | null;
    pacingRows.push({
      product: m.product,
      customer_id: m.customer_id,
      name: m.descriptive_name,
      city: m.city,
      budget,
      mtd,
      used_pct: budget && mtd !== null ? round1((mtd / budget) * 100) : null,
      expected_pct: budget && expected !== null ? round1((expected / budget) * 100) : null,
      pace_pct: (gads ? p.budget_pacing_pct : p.pacing_pct) ?? null,
      budget_hit: budget !== null && mtd !== null && mtd >= budget,
      recommended: (gads ? p.recommended_daily_budget : p.recommended_weekly_budget) ?? null,
      recommended_per: gads ? "day" : "week",
    });

    // Latest hygiene score + the compact next-steps snapshot persisted by the
    // audit engines (null for audits run before that snapshot existed).
    const s =
      ((gads ? await auditScoresStore.get(m.customer_id) : await lsaAuditScoresStore.get(m.customer_id)) ??
        {}) as Record<string, any>;
    hygiene.push({
      product: m.product,
      customer_id: m.customer_id,
      name: m.descriptive_name,
      city: m.city,
      score: s.final_score ?? null,
      band: s.band ?? null,
      at: s.generated_at ?? null,
      next_steps: s.next_steps ?? null,
    });

    if (gads) {
      // Latest Pyramid Breakdown snapshot (compact — persisted by every run).
      // Accounts with no snapshot are still listed (action_counts=null) so the
      // profile can offer a "Run review" chip, mirroring the hygiene section.
      const py = ((await pyramidBreakdownStore.get(m.customer_id)) ?? {}) as Record<string, any>;
      pyramid.push({
        customer_id: m.customer_id,
        name: m.descriptive_name,
        action_counts: py.action_counts ?? null,
        flagged_keywords: py.flagged_keywords ?? null,
        flagged_keyword_cost: py.flagged_keyword_cost ?? null,
        irrelevant_term_cost: py.irrelevant_term_cost ?? null,
        top_recommendations: py.top_recommendations ?? null,
        ai_status: py.ai_status ?? null,
        lookback_days: py.lookback_days ?? null,
        at: py.generated_at ?? null,
      });

      const q = (await trafficQualityStore.get(m.customer_id)) as Record<string, any> | null;
      if (q) {
        quality.push({
          customer_id: m.customer_id,
          name: m.descriptive_name,
          score: q.traffic_quality ?? null,
          coverage: q.coverage ?? null,
          window_days: q.lookback_days ?? null,
          at: q.generated_at ?? null,
        });
      }
    }

  }

  let combined: Record<string, any> | null = null;
  // Reuse the combined dashboard's canonical aggregate instead of rebuilding
  // it from a second set of store reads. This keeps the profile row and Main
  // Dashboard identical even for multi-account/shared-CID clients and for
  // spend contributed by an account with no configured budget.
  if (row.pacing_budget !== null && row.pacing_budget > 0 && row.pacing_mtd !== null) {
    combined = {
      budget: row.pacing_budget,
      mtd: row.pacing_mtd,
      used_pct: round1((row.pacing_mtd / row.pacing_budget) * 100),
      expected_pct:
        row.pacing_expected != null
          ? round1((row.pacing_expected / row.pacing_budget) * 100)
          : null,
      pace_pct: row.pacing_pct,
      budget_hit: row.pacing_hit,
    };
  }

  // The single "Client criteria" button edits the client's primary account's
  // criteria — the GAds account when there is one, else the first LSA account.
  const gadsMembers = row.members.filter((m) => m.product === "gads");
  const criteriaMember = gadsMembers[0] ?? row.members[0] ?? null;

  return {
    client: row.client,
    doer: row.doer,
    checker: row.checker,
    currency_code: row.currency_code,
    has_gads: row.has_gads,
    has_lsa: row.has_lsa,
    kpis: {
      spend_30d: row.spend_30d,
      spend_prev: row.spend_prev,
      leads_30d: row.leads_30d,
      leads_prev: row.leads_prev,
      cpl_30d: row.cpl_30d,
      cpl_prev: row.cpl_prev,
    },
    // Main already overlaid the same live bulk-loaded documents after its
    // metrics cache. Reuse that canonical rollup instead of issuing a second
    // per-account alert read and rebuilding a subtly different summary.
    alerts: row.alerts,
    accounts,
    pacing: { rows: pacingRows, combined },
    hygiene,
    quality,
    pyramid,
    log_url: logUrl,
    has_log: !!sheetIdFromUrl(logUrl),
    criteria_account: criteriaMember
      ? { customer_id: criteriaMember.customer_id, name: criteriaMember.descriptive_name }
      : null,
    generated_at: new Date().toISOString(),
    from_cache: fromCache,
  };
}

/**
 * The same client's account in the OTHER product (GAds <-> LSA), via the
 * ClickUp directory's client blocks. Read-only, directory-only (no Ads API).
 * Null if the account isn't in the directory or the client has no
 * sibling-product account.
 */
export async function findSibling(
  customerId: string,
): Promise<{ client_name: string; sibling_cid: string; sibling_product: "gads" | "lsa" } | null> {
  const cid = customerId.replace(/-/g, "").trim();
  const norm = (xs: string[]) => xs.map((x) => x.replace(/-/g, "").trim());
  for (const c of await clientBlocks()) {
    const gads = norm(c.gads_cids);
    const lsa = norm(c.lsa_cids);
    if (gads.includes(cid) && lsa.length) {
      return { client_name: c.name, sibling_cid: lsa[0], sibling_product: "lsa" };
    }
    if (lsa.includes(cid) && gads.length) {
      return { client_name: c.name, sibling_cid: gads[0], sibling_product: "gads" };
    }
  }
  return null;
}
