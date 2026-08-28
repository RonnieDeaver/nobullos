/**
 * Ads OS — LSA hygiene audit (port of backend/app/lsa/hygiene.py +
 * lsa/queries.py fetch_all).
 *
 * A scored, automated audit of everything the Google Ads API exposes for Local
 * Services Ads. Mirrors the GAds audit's output: it emits the shared
 * `AuditReport` model so the same React report UI (gauge, gate banner,
 * next-steps, category cards) renders it unchanged. Checks (mapped from the
 * team's LSA hygiene checklist):
 *
 *   VER-01  Business verification all green   (local_services_verification_artifact)
 *   POL-01  Policy / campaign eligibility     (campaign.primary_status)
 *   BUD-02  Last-30d spend vs monthly budget  (scale vs underspend)
 *   PERF-01 Answer rate                       (derived call-connected proxy)
 *   PERF-02 Charged-lead performance          (charged leads / CPL / charge rate)
 *
 * Scoring reuses the GAds engine's generic pieces (status->score, band
 * thresholds); weights use the same impact scale (critical 12 / high 6 /
 * medium 3 / low 1). A failing critical check (verification or eligibility)
 * caps the score like the GAds gate so a non-serving LSA account can't read
 * "Healthy".
 *
 * GAQL facts (validated against a live LSA account + v24 docs — see ADS_OS.md):
 *   - `local_services_lead` is a resource WITHOUT metrics — filter by
 *     `local_services_lead.creation_date_time`, not `segments.date`;
 *     `lead_charged` is omitted when false.
 *   - `local_services_lead_conversation.phone_call_details.call_duration_millis`
 *     is only present on connected calls — the answer-rate proxy.
 *   - `local_services_verification_artifact.status` is the reliable signal
 *     (expiration can read in the past while still PASSED); CANCELLED =
 *     superseded submission.
 */

import { adsOsGaqlSearch, AdsOsCredsMissing } from "./googleAdsClient";
import {
  AUDIT_CACHE_TTL_SECONDS,
  LSA_ANSWERED_CALL_MIN_SECONDS,
  LSA_ANSWER_RATE_GOOD,
  LSA_LEAD_QUALITY_GOOD,
  LSA_LOOKBACK_DAYS,
} from "./config";
import { getSheetBudgets } from "./budgetSource";
import { resolveLsaBudget } from "./lsaPacingEngine";
import { answerRate, cpl, type AnswerRate } from "./lsaDashboardService";
import { addDays, isoDate, plainToday } from "./dateRange";
import { enrolledAccounts, lsaCampaignIds, mccEnabledAccounts } from "./enrollment";
import { KeyedLocks } from "./singleflight";
import { putLsaAuditScoreWithHistory } from "./store";
import { bandFor, statusToScore } from "./audit/scoring";
import {
  Status,
  compactNextSteps,
  type AuditReport,
  type CategoryResult,
  type CheckResult,
  type Evidence,
  type GateTriggered,
  type NextStep,
  type NextSteps,
} from "./audit/models";

// Impact weights (same scale as the GAds audit's impact_weights).
const W_CRITICAL = 12.0;
const W_HIGH = 6.0;
const W_MEDIUM = 3.0;
// Score cap when a critical check is failing (mirrors caps.critical_default / floor).
const CAP_BASE = 65.0;
const CAP_STEP = 10.0;
const CAP_FLOOR = 10.0;

const CATEGORY_NAMES: Record<string, string> = {
  VER: "Business Verification",
  POL: "Policy & Eligibility",
  BUD: "Budget",
  PERF: "Performance",
};

// Next-steps placement, fixed per check (independent of the score gate).
const CRITICAL_STEP_CHECKS = new Set(["VER-01", "POL-01"]); // Critical / Fix ASAP
const EASY_STEP_CHECKS = new Set(["BUD-02", "PERF-01", "PERF-02"]); // Easy wins

// Verification artifact statuses that mean "actively not passing". Per API
// v24's LocalServicesVerificationArtifactStatusEnum (UNSPECIFIED, UNKNOWN,
// PASSED, FAILED, PENDING, NO_SUBMISSION, CANCELLED), only these two are real
// failures: CANCELLED just means a superseded older submission, and
// UNSPECIFIED/UNKNOWN mean Google recorded no status at all — common on
// pre-2022 verifications that the LSA console shows as Verified — so neither
// may fail the check.
const BAD_VERIFY = new Set(["FAILED", "NO_SUBMISSION"]);

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function micros(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n ? n / 1e6 : 0;
}
/** Python f"{x:,.0f}" — thousands separators, no decimals. */
function fmt0(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}
/** Python str.title() — capitalize each word, lowercase the rest. */
function titleCase(s: string): string {
  return s.replace(/\w+/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}
/** "2026-06-25 14:02:23.011383" -> epoch millis, or null when unparseable. */
function parseDtMs(value: unknown): number | null {
  const s = String(value ?? "");
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(s)) return null;
  const ms = Date.parse(s.replace(" ", "T"));
  return Number.isFinite(ms) ? ms : null;
}

// ----------------------------- row types -----------------------------

export interface LsaCampaignRow {
  campaign_id: string;
  name: string;
  status: string;
  primary_status: string;
  primary_status_reasons: string[];
  daily_budget: number; // campaign_budget.amount_micros (period = DAILY)
  cost: number; // spend over the window
}

export interface LeadRow {
  lead_id: string;
  lead_type: string; // PHONE_CALL | MESSAGE | BOOKING
  lead_status: string;
  charged: boolean;
}

export interface VerificationArtifact {
  artifact_id: string;
  artifact_type: string; // LICENSE | INSURANCE | BACKGROUND_CHECK | BUSINESS_REGISTRATION_CHECK
  status: string; // PASSED | FAILED | PENDING | CANCELLED | NO_SUBMISSION | ...
  license_type: string;
  licensee_name: string;
  expiration: string;
  rejection_reason: string;
  creation_ms: number | null;
}

export interface LsaData {
  campaigns: LsaCampaignRow[];
  leads: LeadRow[];
  conversations: Array<{ channel: string; durationMillis: number }>;
  artifacts: VerificationArtifact[];
  warnings: string[];
}

// ----------------------------- queries -----------------------------

/**
 * One bundle for the hygiene audit: campaigns (settings + windowed spend),
 * leads, phone-call conversations, verification artifacts. Queries run
 * concurrently; a failing query isolates into a warning (empty slice) —
 * missing credentials still propagate.
 */
export async function fetchLsaHygieneData(
  customerId: string,
  startIso: string,
  endIso: string,
): Promise<LsaData> {
  const cid = customerId.replace(/-/g, "").trim();
  const warnings: string[] = [];

  const run = async (label: string, query: string): Promise<any[]> => {
    try {
      return await adsOsGaqlSearch(cid, query);
    } catch (err) {
      if (err instanceof AdsOsCredsMissing) throw err;
      warnings.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  };

  const dtClause = (field: string) =>
    `${field} BETWEEN '${startIso} 00:00:00' AND '${endIso} 23:59:59'`;

  const [settingsRows, metricsRows, leadRows, convRows, artifactRows] = await Promise.all([
    run(
      "campaign settings",
      "SELECT campaign.id, campaign.name, campaign.status, campaign.primary_status, " +
        "campaign.primary_status_reasons, campaign_budget.amount_micros, campaign_budget.period " +
        "FROM campaign WHERE campaign.advertising_channel_type = 'LOCAL_SERVICES'",
    ),
    run(
      "campaign spend",
      "SELECT campaign.id, metrics.cost_micros FROM campaign " +
        "WHERE campaign.advertising_channel_type = 'LOCAL_SERVICES' " +
        `AND segments.date BETWEEN '${startIso}' AND '${endIso}'`,
    ),
    run(
      "leads",
      "SELECT local_services_lead.id, local_services_lead.lead_type, " +
        "local_services_lead.lead_status, local_services_lead.lead_charged, " +
        "local_services_lead.category_id, local_services_lead.service_id, " +
        "local_services_lead.creation_date_time FROM local_services_lead " +
        `WHERE ${dtClause("local_services_lead.creation_date_time")}`,
    ),
    run(
      "conversations",
      "SELECT local_services_lead_conversation.id, " +
        "local_services_lead_conversation.conversation_channel, " +
        "local_services_lead_conversation.phone_call_details.call_duration_millis, " +
        "local_services_lead_conversation.event_date_time " +
        "FROM local_services_lead_conversation " +
        `WHERE ${dtClause("local_services_lead_conversation.event_date_time")} ` +
        "AND local_services_lead_conversation.conversation_channel = 'PHONE_CALL'",
    ),
    run(
      "verification artifacts",
      "SELECT local_services_verification_artifact.id, " +
        "local_services_verification_artifact.artifact_type, " +
        "local_services_verification_artifact.status, " +
        "local_services_verification_artifact.creation_date_time, " +
        "local_services_verification_artifact.license_verification_artifact.license_type, " +
        "local_services_verification_artifact.license_verification_artifact.expiration_date_time, " +
        "local_services_verification_artifact.license_verification_artifact.licensee_first_name, " +
        "local_services_verification_artifact.license_verification_artifact.licensee_last_name, " +
        "local_services_verification_artifact.license_verification_artifact.rejection_reason " +
        "FROM local_services_verification_artifact",
    ),
  ]);

  const costById = new Map<string, number>();
  for (const row of metricsRows) {
    const id = String(row.campaign?.id ?? "");
    costById.set(id, (costById.get(id) ?? 0) + micros(row.metrics?.costMicros));
  }
  const campaigns: LsaCampaignRow[] = settingsRows.map((row: any) => {
    const c = row.campaign ?? {};
    const id = String(c.id ?? "");
    return {
      campaign_id: id,
      name: String(c.name ?? ""),
      status: String(c.status ?? "UNKNOWN"),
      primary_status: String(c.primaryStatus ?? ""),
      primary_status_reasons: Array.isArray(c.primaryStatusReasons)
        ? c.primaryStatusReasons.map((r: unknown) => String(r))
        : [],
      daily_budget: micros(row.campaignBudget?.amountMicros),
      cost: round2(costById.get(id) ?? 0),
    };
  });

  const leads: LeadRow[] = leadRows.map((row: any) => {
    const lead = row.localServicesLead ?? {};
    return {
      lead_id: String(lead.id ?? ""),
      lead_type: String(lead.leadType ?? "UNKNOWN"),
      lead_status: String(lead.leadStatus ?? ""),
      // REST omits lead_charged when false; truthy check covers both.
      charged: Boolean(lead.leadCharged),
    };
  });

  const conversations = convRows.map((row: any) => {
    const c = row.localServicesLeadConversation ?? {};
    return {
      channel: String(c.conversationChannel ?? "UNKNOWN"),
      durationMillis: Number(c.phoneCallDetails?.callDurationMillis ?? 0),
    };
  });

  const artifacts: VerificationArtifact[] = artifactRows.map((row: any) => {
    const a = row.localServicesVerificationArtifact ?? {};
    const lic = a.licenseVerificationArtifact ?? {};
    const rejection = String(lic.rejectionReason ?? "");
    return {
      artifact_id: String(a.id ?? ""),
      artifact_type: String(a.artifactType ?? "UNKNOWN"),
      status: String(a.status ?? "UNKNOWN"),
      license_type: String(lic.licenseType ?? ""),
      licensee_name: [lic.licenseeFirstName, lic.licenseeLastName]
        .filter(Boolean)
        .join(" ")
        .trim(),
      expiration: String(lic.expirationDateTime ?? ""),
      rejection_reason: rejection === "UNSPECIFIED" || rejection === "UNKNOWN" ? "" : rejection,
      creation_ms: parseDtMs(a.creationDateTime),
    };
  });

  return { campaigns, leads, conversations, artifacts, warnings };
}

// ----------------------------- checks -----------------------------

function check(
  checkId: string,
  category: string,
  name: string,
  status: Status,
  weight: number,
  impact: string,
  value: string,
  evidence?: Evidence[],
  recommendation = "",
): CheckResult {
  return {
    id: checkId,
    category,
    name,
    status,
    score: statusToScore(status),
    weight: status !== Status.NA ? weight : 0.0,
    impact,
    value,
    evidence: evidence ?? [],
    recommendation,
  };
}

function label(atype: string): string {
  return titleCase(atype.replace(/_/g, " "));
}

export function checkVerification(artifacts: VerificationArtifact[]): CheckResult {
  const name = "Business verification all green";
  if (!artifacts.length) {
    return check(
      "VER-01", "VER", name, Status.OKAY, W_CRITICAL, "critical",
      "No verification artifacts found",
      undefined,
      "Couldn't read any verification artifacts — confirm verification status in the LSA dashboard.",
    );
  }

  const byType = new Map<string, VerificationArtifact[]>();
  for (const a of artifacts) {
    const list = byType.get(a.artifact_type) ?? [];
    list.push(a);
    byType.set(a.artifact_type, list);
  }

  const problemTypes: Array<[string, VerificationArtifact]> = [];
  const pendingTypes: string[] = [];
  // Types where the API gave us no usable verdict: the latest submission has a
  // blank status (UNSPECIFIED/UNKNOWN), or only superseded (CANCELLED)
  // submissions are on file. The console frequently shows these as Verified,
  // so they get a note, never a critical fail.
  const unreportedTypes: Array<[string, VerificationArtifact | null]> = [];
  for (const [atype, items] of byType) {
    if (items.some((a) => a.status === "PASSED")) {
      continue; // a current PASSED supersedes older CANCELLED/failed submissions
    }
    const nonCancelled = items.filter((a) => a.status !== "CANCELLED");
    if (!nonCancelled.length) {
      unreportedTypes.push([atype, null]); // everything superseded, nothing current
      continue;
    }
    // The most recent current submission decides (and describes) the verdict.
    const latest = nonCancelled.reduce((best, a) =>
      (a.creation_ms ?? -Infinity) > (best.creation_ms ?? -Infinity) ? a : best,
    );
    if (latest.status === "PENDING") pendingTypes.push(atype);
    else if (BAD_VERIFY.has(latest.status)) problemTypes.push([atype, latest]);
    else unreportedTypes.push([atype, latest]);
  }

  if (problemTypes.length) {
    const ev: Evidence[] = problemTypes.map(([atype, a]) => {
      let detail = `status ${a.status}`;
      if (a.rejection_reason) detail += ` · ${a.rejection_reason.replace(/_/g, " ").toLowerCase()}`;
      if (a.expiration) detail += ` · doc expiry ${a.expiration.slice(0, 10)}`;
      return {
        name: `${label(atype)}${a.license_type ? ` — ${a.license_type}` : ""}`,
        id: a.artifact_id,
        detail,
      };
    });
    const names = problemTypes.map(([t]) => label(t)).join(", ");
    return check(
      "VER-01", "VER", name, Status.CRITICAL, W_CRITICAL, "critical",
      `${names} not passing`, ev,
      "Escalate on the #paid-search-team-and-verification Slack channel — the account can't " +
        "serve LSA while a required license/insurance isn't verified.",
    );
  }
  if (pendingTypes.length || unreportedTypes.length) {
    const parts: string[] = [];
    const recs: string[] = [];
    const ev: Evidence[] = [];
    if (pendingTypes.length) {
      parts.push(`${pendingTypes.map(label).join(", ")} verification pending`);
      recs.push("Verification is in progress — monitor until it passes.");
    }
    if (unreportedTypes.length) {
      parts.push(
        `${unreportedTypes.map(([t]) => label(t)).join(", ")} status not reported by the API`,
      );
      recs.push(
        "The API returned no status for this artifact (common on pre-2022 verifications) — " +
          "confirm it shows Verified in the LSA console.",
      );
      for (const [atype, a] of unreportedTypes) {
        if (a === null) {
          ev.push({ name: label(atype), detail: "only superseded (cancelled) submissions on file" });
        } else {
          let detail = `status ${a.status || "UNSPECIFIED"}`;
          if (a.creation_ms !== null) {
            detail += ` · submitted ${new Date(a.creation_ms).toISOString().slice(0, 10)}`;
          }
          ev.push({ name: label(atype), id: a.artifact_id, detail });
        }
      }
    }
    return check(
      "VER-01", "VER", name, Status.OKAY, W_CRITICAL, "critical",
      parts.join(" · "), ev, recs.join(" "),
    );
  }
  const passed = Array.from(byType.keys()).map(label).sort().join(", ");
  return check(
    "VER-01", "VER", name, Status.GOOD, W_CRITICAL, "critical",
    `All verification passing (${passed})`,
  );
}

export function checkPolicy(campaigns: LsaCampaignRow[]): CheckResult {
  const name = "Policy & campaign eligibility";
  const serving = campaigns.filter((c) => c.status === "ENABLED");
  if (!serving.length) {
    return check(
      "POL-01", "POL", name, Status.NA, W_CRITICAL, "critical",
      "No enabled Local Services campaign",
    );
  }
  const badStates = new Set(["NOT_ELIGIBLE", "MISCONFIGURED", "SUSPENDED", "REMOVED"]);
  const softStates = new Set(["PENDING", "UNDER_REVIEW", "LIMITED"]);
  const problems = serving.filter((c) => badStates.has(c.primary_status));
  const soft = serving.filter((c) => softStates.has(c.primary_status));
  if (problems.length) {
    const ev: Evidence[] = problems.map((c) => ({
      name: c.name.slice(0, 60),
      id: c.campaign_id,
      detail: `${c.primary_status}: ${
        c.primary_status_reasons.map((r) => r.replace(/_/g, " ").toLowerCase()).join(", ") ||
        "see policy manager"
      }`,
    }));
    return check(
      "POL-01", "POL", name, Status.BAD, W_CRITICAL, "critical",
      `${problems.length} campaign(s) not eligible`, ev,
      "Open Policy Manager, resolve the flagged issues, and escalate to the relevant Slack " +
        "channel if it needs verification/billing support.",
    );
  }
  if (soft.length) {
    const ev: Evidence[] = soft.map((c) => ({
      name: c.name.slice(0, 60),
      id: c.campaign_id,
      detail: c.primary_status,
    }));
    return check(
      "POL-01", "POL", name, Status.OKAY, W_CRITICAL, "critical",
      `${soft.length} campaign(s) under review / limited`, ev,
      "Monitor — eligibility is limited or under review.",
    );
  }
  return check("POL-01", "POL", name, Status.GOOD, W_CRITICAL, "critical", "All campaigns eligible");
}

export function checkMonthlySpend(
  spend30d: number,
  monthlyBudget: number | null,
  currency: string,
): CheckResult {
  const name = "Last-30-day spend vs monthly budget";
  const cur = currency ? ` ${currency}` : "";
  if (monthlyBudget === null || monthlyBudget <= 0) {
    return check(
      "BUD-02", "BUD", name, Status.NA, W_HIGH, "high",
      `spent ${fmt0(spend30d)}${cur} (no budget on record)`,
    );
  }
  const ratio = spend30d / monthlyBudget;
  const val = `spent ${fmt0(spend30d)}${cur} of ${fmt0(monthlyBudget)}${cur} (${Math.round(ratio * 100)}%)`;
  if (ratio >= 0.9) {
    return check(
      "BUD-02", "BUD", name, Status.GOOD, W_HIGH, "high", val, undefined,
      "Spending the full budget — room to scale: recommend a budget increase.",
    );
  }
  if (ratio >= 0.6) {
    return check(
      "BUD-02", "BUD", name, Status.OKAY, W_HIGH, "high", val, undefined,
      "Slightly underspending — consider expanding the service area or service types, or " +
        "easing any bid-strategy cap.",
    );
  }
  return check(
    "BUD-02", "BUD", name, Status.BAD, W_HIGH, "high", val, undefined,
    "Underspending. Options: expand the service area, remove the bid-strategy cap, add " +
      "service types, improve the profile — or move the unused budget to GAds.",
  );
}

export function checkAnswerRate(ar: AnswerRate): CheckResult {
  const name = "Answer rate";
  if (ar.rate === null) {
    return check("PERF-01", "PERF", name, Status.NA, W_HIGH, "high", "No calls in the window");
  }
  const ev: Evidence[] = [
    { name: "Calls", id: null, detail: `${ar.connected} connected / ${ar.calls} calls` },
  ];
  const roundedRate = Math.round(ar.rate);
  const val = `${roundedRate}% answered (${ar.connected} of ${ar.calls} calls)`;
  if (roundedRate >= LSA_ANSWER_RATE_GOOD) {
    return check("PERF-01", "PERF", name, Status.GOOD, W_HIGH, "high", val, ev);
  }
  return check(
    "PERF-01", "PERF", name, Status.OKAY, W_HIGH, "high", val, ev,
    `Answer rate is below ${Math.round(LSA_ANSWER_RATE_GOOD)}% — reach out to the account ` +
      "manager to address this with the client. Missed calls are charged leads lost and drag " +
      "down the LSA ranking.",
  );
}

export function checkLeadQuality(leads: LeadRow[], cost: number, currency: string): CheckResult {
  const name = "Lead quality";
  const cur = currency ? ` ${currency}` : "";
  const total = leads.length;
  const charged = leads.filter((l) => l.charged).length;
  const costPerLead = cpl(cost, charged);
  if (total === 0) {
    return check(
      "PERF-02", "PERF", name, Status.OKAY, W_MEDIUM, "medium",
      "No leads in the window", undefined,
      "No leads recently — check budget, service area, and that the profile is live and ranking.",
    );
  }
  const chargeRate = (charged / total) * 100;
  const roundedChargeRate = Math.round(chargeRate);
  const cplStr = costPerLead !== null ? ` · CPL ${fmt0(costPerLead)}${cur}` : "";
  const val = `${roundedChargeRate}% billable (${charged} charged of ${total} leads)${cplStr}`;
  const ev: Evidence[] = [
    { name: "Leads (window)", id: null, detail: `${charged} charged / ${total} total` },
  ];
  if (roundedChargeRate >= LSA_LEAD_QUALITY_GOOD) {
    return check("PERF-02", "PERF", name, Status.GOOD, W_MEDIUM, "medium", val, ev);
  }
  return check(
    "PERF-02", "PERF", name, Status.OKAY, W_MEDIUM, "medium", val, ev,
    `Lead quality is below ${Math.round(LSA_LEAD_QUALITY_GOOD)}% billable — review our ` +
      "service selection; too many leads are being disputed/credited.",
  );
}

// ----------------------------- scoring / assembly -----------------------------

function weightedAvg(checks: CheckResult[]): number {
  let num = 0;
  let den = 0;
  for (const c of checks) {
    if (c.score === null || c.status === Status.NA) continue;
    num += c.weight * c.score;
    den += c.weight;
  }
  return den ? round1(num / den) : 0.0;
}

export function buildLsaCategories(checks: CheckResult[]): CategoryResult[] {
  const byCat = new Map<string, CheckResult[]>();
  for (const c of checks) {
    const list = byCat.get(c.category) ?? [];
    list.push(c);
    byCat.set(c.category, list);
  }
  const totalW = checks.reduce((s, c) => s + c.weight, 0) || 1.0;
  const cats: CategoryResult[] = [];
  for (const [code, items] of byCat) {
    const scored = items.filter((c) => c.status !== Status.NA && c.score !== null);
    cats.push({
      code,
      name: CATEGORY_NAMES[code] ?? code,
      weight: Math.round((items.reduce((s, c) => s + c.weight, 0) / totalW) * 10000) / 10000,
      score: scored.length ? weightedAvg(items) : 0.0,
      checks: items,
    });
  }
  // Manual-only (all-NA) categories sort to the end; otherwise worst score first.
  cats.sort((a, b) => {
    const aNa = a.checks.every((c) => c.status === Status.NA) ? 1 : 0;
    const bNa = b.checks.every((c) => c.status === Status.NA) ? 1 : 0;
    return aNa - bNa || a.score - b.score;
  });
  return cats;
}

export function lsaGates(checks: CheckResult[]): [GateTriggered[], number | null] {
  const failing = checks.filter(
    (c) => c.impact === "critical" && (c.status === Status.BAD || c.status === Status.CRITICAL),
  );
  if (!failing.length) return [[], null];
  const cap = Math.max(CAP_BASE - CAP_STEP * (failing.length - 1), CAP_FLOOR);
  const gates: GateTriggered[] = failing.map((c) => ({
    id: c.id,
    source: c.id,
    cap,
    reason: c.value,
  }));
  return [gates, cap];
}

/**
 * Bucket failing checks by their fixed placement (not by status):
 * VER-01 / POL-01 -> Critical/Fix ASAP; BUD-02 / PERF-01 / PERF-02 -> Easy
 * wins. A check only appears when it has a recommendation (i.e. something to
 * act on). Exception: an OKAY-status check is a monitor-note (verification
 * pending / status not reported / eligibility under review), so it files under
 * Longer term — an FYI must not read as "Fix now".
 */
export function lsaNextSteps(checks: CheckResult[]): NextSteps {
  const crit: NextStep[] = [];
  const easy: NextStep[] = [];
  const longTerm: NextStep[] = [];
  for (const c of checks) {
    if (!c.recommendation) continue;
    const step: NextStep = { title: c.name, detail: c.value, source: c.id, points: [c.recommendation] };
    if (CRITICAL_STEP_CHECKS.has(c.id)) {
      (c.status === Status.OKAY ? longTerm : crit).push(step);
    } else if (EASY_STEP_CHECKS.has(c.id)) {
      easy.push(step);
    }
  }
  return { critical: crit, easy_wins: easy, long_term: longTerm };
}

/**
 * True when the account's Local Services campaigns exist but none is ENABLED
 * (fully paused/removed) — nothing scannable, so the report should read
 * "Inactive" rather than a real score. Requires at least one row: an errored
 * campaign-settings pull returns [] with a warning, which must not masquerade
 * as an intentionally paused account.
 */
export function lsaScopeInactive(campaigns: Pick<LsaCampaignRow, "status">[]): boolean {
  return campaigns.length > 0 && !campaigns.some((c) => c.status === "ENABLED");
}

// ----------------------------- engine -----------------------------

export async function runLsaHygiene(
  customerId: string,
  lookbackDays?: number | null,
): Promise<AuditReport> {
  const cid = customerId.replace(/-/g, "").trim();
  const lookback = lookbackDays || LSA_LOOKBACK_DAYS;

  const mcc = await mccEnabledAccounts(); // creds/Ads errors propagate to the route
  const acct = mcc.get(cid);
  const accountName = acct?.name ?? cid;
  const currency = acct?.currency ?? null;
  const now = new Date().toISOString();

  const ineligible = (note: string): AuditReport => ({
    customer_id: cid,
    account_name: accountName,
    generated_at: now,
    lookback_days: lookback,
    raw_score: 0.0,
    final_score: 0.0,
    band: "N/A",
    band_color: "gray",
    gates_triggered: [],
    next_steps: {
      critical: [],
      easy_wins: [],
      long_term: [{ title: "Not enrolled", detail: note, source: "LSA", points: [] }],
    },
    categories: [],
  });

  const enrolled = await enrolledAccounts("lsa", mcc);
  if (!enrolled.some((a) => a.cid === cid)) {
    return ineligible(
      "This LSA account isn't enrolled. Add it to the ClickUp Client List (an LSA subtask " +
        "with this account's Google CID) to audit it.",
    );
  }
  if (!(await lsaCampaignIds(cid)).length) {
    return ineligible("No Local Services campaigns found in this account.");
  }

  const end = plainToday();
  const start = addDays(end, -lookback);
  const data = await fetchLsaHygieneData(cid, isoDate(start), isoDate(end));
  const cost30d = round2(data.campaigns.reduce((s, c) => s + c.cost, 0));

  const { budgets: sheetBudgets } = await getSheetBudgets();
  const { budget: monthlyBudget } = resolveLsaBudget(sheetBudgets, cid);

  const ar = answerRate(data.conversations, LSA_ANSWERED_CALL_MIN_SECONDS);

  const checks: CheckResult[] = [
    checkVerification(data.artifacts),
    checkPolicy(data.campaigns),
    checkMonthlySpend(cost30d, monthlyBudget, currency ?? ""),
    checkAnswerRate(ar),
    checkLeadQuality(data.leads, cost30d, currency ?? ""),
  ];

  const raw = weightedAvg(checks);
  const [gates, cap] = lsaGates(checks);
  const final = cap !== null ? round1(Math.min(raw, cap)) : round1(raw);
  let [bandName, bandColor] = bandFor(final);

  // Fully-paused account: campaigns exist but none is ENABLED, so the
  // spend/answer-rate/lead checks have nothing to measure and the score is a
  // meaningless low number. Mirror the GAds engine (Task #3623): report
  // "Inactive" with an explanation instead of an alarming 0/Critical. The
  // persisted band also makes the stale sweep skip the account
  // (staleAudits.isInactiveScore).
  let scopeNote: string | null = null;
  if (lsaScopeInactive(data.campaigns)) {
    bandName = "Inactive";
    bandColor = "slate";
    scopeNote =
      "No active Local Services campaigns in scope — all campaigns are paused or removed. Nothing to audit until a campaign is re-enabled.";
  }

  const report: AuditReport = {
    customer_id: cid,
    account_name: accountName,
    generated_at: now,
    lookback_days: lookback,
    raw_score: raw,
    final_score: final,
    band: bandName,
    band_color: bandColor,
    scope_note: scopeNote,
    gates_triggered: gates,
    next_steps: lsaNextSteps(checks),
    categories: buildLsaCategories(checks),
  };
  await putLsaAuditScoreWithHistory(cid, {
    final_score: final,
    band: bandName,
    scope_note: scopeNote,
    generated_at: now,
    next_steps: compactNextSteps(report.next_steps),
  });
  return report;
}

// --- 1-hour per-account cache (same discipline as the GAds audit) ---
const cache = new Map<string, { at: number; report: AuditReport }>();
const locks = new KeyedLocks(); // single-flight the Ads pull per (cid, lookback)

/** Return [report, fromCache]. TTL from AUDIT_CACHE_TTL_SECONDS. */
export async function runLsaHygieneCached(
  customerId: string,
  lookbackDays?: number | null,
  force = false,
): Promise<[AuditReport, boolean]> {
  const lookback = lookbackDays || LSA_LOOKBACK_DAYS;
  const key = `${customerId.replace(/-/g, "").trim()}:${lookback}`;
  const ttlMs = AUDIT_CACHE_TTL_SECONDS * 1000;

  const hit = (): AuditReport | null => {
    const cached = cache.get(key);
    return cached && Date.now() - cached.at < ttlMs ? cached.report : null;
  };

  if (!force) {
    const report = hit();
    if (report !== null) return [report, true];
  }
  return locks.withLock(key, async () => {
    if (!force) {
      const report = hit();
      if (report !== null) return [report, true] as [AuditReport, boolean];
    }
    const report = await runLsaHygiene(customerId, lookback);
    // Evict expired entries so the map stays bounded across (cid, lookback) keys.
    for (const [k, v] of cache) if (Date.now() - v.at >= ttlMs) cache.delete(k);
    cache.set(key, { at: Date.now(), report });
    return [report, false] as [AuditReport, boolean];
  });
}

/** Test hook: reset the per-process report cache. */
export function __testResetLsaHygieneCache(): void {
  cache.clear();
}
