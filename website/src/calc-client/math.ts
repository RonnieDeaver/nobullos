// REE calculator math — the period-scoped model behind /calculator/.
//
// The contract deliberately uses only figures entered for one selected
// reporting period. It never annualizes, extrapolates, grades a funnel,
// accepts targets, or chooses a "best" improvement.
//
// This module is pure TypeScript with no DOM access. The calculator bundle
// imports it directly, and the focused math suite locks its formulas and
// formatting.

export interface CalcIssue {
  field: string;
  message: string;
}

/** Loose money/count parsing for form values: "$25,000" → 25000. */
export function parseNumericInput(raw: string): number | null {
  const cleaned = raw.replace(/[$,\s]/g, "");
  if (cleaned === "") return null;
  if (!/^\d*\.?\d+$/.test(cleaned)) return NaN;
  return Number(cleaned);
}

/** min(rate × 1.1, 1): the +10% relative lift honoring the 100% ceiling. */
function lifted(rate: number): { next: number; capped: boolean } {
  const raw = rate * 1.1;
  return raw > 1 ? { next: 1, capped: true } : { next: raw, capped: false };
}

export const REPORTING_PERIODS = [3, 6, 12] as const;
export type ReportingPeriodMonths = (typeof REPORTING_PERIODS)[number];
export type RevenueBasis = "generated" | "estimated";

interface CalcInputBase {
  /** The period scopes every entered total; it never changes the arithmetic. */
  periodMonths: ReportingPeriodMonths;
  /** Total growth investment during the selected period. */
  totalInvestment: number;
  /** Whole-funnel counts for the same selected period. */
  leads: number;
  consults: number;
  cases: number;
}

/** Exactly one revenue basis is present in a valid calculation. */
export type CalcInputs = CalcInputBase &
  (
    | {
        revenueBasis: "generated";
        revenueGenerated: number;
        estimatedCaseValue: null;
      }
    | {
        revenueBasis: "estimated";
        revenueGenerated: null;
        estimatedCaseValue: number;
      }
  );

/** Nullable form-shaped input accepted by field-level validation. */
export interface CalcInputDraft {
  periodMonths: number | null;
  totalInvestment: number | null;
  leads: number | null;
  consults: number | null;
  cases: number | null;
  revenueBasis: RevenueBasis;
  revenueGenerated: number | null;
  estimatedCaseValue: number | null;
}

export const SCENARIO_IDS = [
  "leads",
  "leadToConsult",
  "consultToCase",
  "revenuePerCase",
] as const;
export type ScenarioId = (typeof SCENARIO_IDS)[number];

export const SCENARIO_LABELS: Record<ScenarioId, string> = {
  leads: "More leads",
  leadToConsult: "Lead-to-Consult rate",
  consultToCase: "Consult-to-Case rate",
  revenuePerCase: "Revenue per Case",
};

export interface ScenarioResult {
  id: ScenarioId;
  label: string;
  available: boolean;
  unavailableReason: string | null;
  /** Additional revenue during the selected period. */
  additionalRevenue: number;
  /** True when a rate could not receive the full 10% relative lift. */
  cappedAt100: boolean;
}

export interface CalcMetrics {
  revenue: number;
  costPerLead: number;
  costPerCase: number | null;
  leadToConsult: number;
  consultToCase: number | null;
  leadToCase: number;
  revenuePerCase: number | null;
}

export interface CalcResults {
  periodMonths: ReportingPeriodMonths;
  periodLabel: string;
  revenueBasis: RevenueBasis;
  confidence: "actual" | "estimated";
  ree: number;
  metrics: CalcMetrics;
  /** Stable funnel order. Scenarios are intentionally not ranked. */
  scenarios: ScenarioResult[];
}

function isAllowedPeriod(value: number | null): value is ReportingPeriodMonths {
  return value !== null && REPORTING_PERIODS.some((period) => period === value);
}

function isFiniteNonnegative(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value >= 0;
}

/**
 * Concise field-level validation for one period's totals. Cross-field errors
 * are added only after the individual fields are valid, avoiding duplicate
 * noise for a single bad entry.
 */
export function validateCalcInputs(i: CalcInputDraft): CalcIssue[] {
  const issues: CalcIssue[] = [];

  if (!isAllowedPeriod(i.periodMonths)) {
    issues.push({ field: "periodMonths", message: "Choose a 3-, 6-, or 12-month period." });
  }
  if (!isFiniteNonnegative(i.totalInvestment) || i.totalInvestment <= 0) {
    issues.push({ field: "totalInvestment", message: "Total investment must be above $0." });
  }
  if (
    i.leads === null ||
    !Number.isFinite(i.leads) ||
    !Number.isInteger(i.leads) ||
    i.leads < 1
  ) {
    issues.push({ field: "leads", message: "Leads must be a whole number of at least 1." });
  }
  if (
    i.consults === null ||
    !Number.isFinite(i.consults) ||
    !Number.isInteger(i.consults) ||
    i.consults < 0
  ) {
    issues.push({ field: "consults", message: "Consults must be a whole number (0 is allowed)." });
  }
  if (
    i.cases === null ||
    !Number.isFinite(i.cases) ||
    !Number.isInteger(i.cases) ||
    i.cases < 0
  ) {
    issues.push({ field: "cases", message: "Cases must be a whole number (0 is allowed)." });
  }

  if (i.revenueBasis === "generated") {
    if (!isFiniteNonnegative(i.revenueGenerated)) {
      issues.push({ field: "revenueGenerated", message: "Revenue generated must be $0 or more." });
    }
    if (i.estimatedCaseValue !== null) {
      issues.push({ field: "estimatedCaseValue", message: "Use only one revenue basis." });
    }
  } else {
    if (!isFiniteNonnegative(i.estimatedCaseValue)) {
      issues.push({ field: "estimatedCaseValue", message: "Estimated case value must be $0 or more." });
    }
    if (i.revenueGenerated !== null) {
      issues.push({ field: "revenueGenerated", message: "Use only one revenue basis." });
    }
  }

  const flagged = new Set(issues.map((issue) => issue.field));
  if (!flagged.has("leads") && !flagged.has("consults") && i.consults! > i.leads!) {
    issues.push({ field: "consults", message: "Consults can't exceed leads." });
  }
  if (!flagged.has("consults") && !flagged.has("cases") && i.cases! > i.consults!) {
    issues.push({ field: "cases", message: "Cases can't exceed consults." });
  }

  return issues;
}

function scenario(
  id: ScenarioId,
  additionalRevenue: number | null,
  unavailableReason: string | null,
  cappedAt100 = false,
): ScenarioResult {
  return {
    id,
    label: SCENARIO_LABELS[id],
    available: additionalRevenue !== null,
    unavailableReason,
    additionalRevenue: additionalRevenue ?? 0,
    cappedAt100,
  };
}

export function computeCalc(inputs: CalcInputs): CalcResults {
  const { periodMonths, totalInvestment, leads, consults, cases } = inputs;
  const revenue =
    inputs.revenueBasis === "generated"
      ? inputs.revenueGenerated
      : cases * inputs.estimatedCaseValue;
  const revenuePerCase =
    inputs.revenueBasis === "estimated"
      ? inputs.estimatedCaseValue
      : cases > 0
        ? revenue / cases
        : null;
  const leadToConsult = consults / leads;
  const consultToCase = consults > 0 ? cases / consults : null;
  const leadToCase = cases / leads;

  const metrics: CalcMetrics = {
    revenue,
    costPerLead: totalInvestment / leads,
    costPerCase: cases > 0 ? totalInvestment / cases : null,
    leadToConsult,
    consultToCase,
    leadToCase,
    revenuePerCase,
  };

  const scenarios: ScenarioResult[] = [];
  const needsRevenuePerCase = "Revenue per case is unavailable with no cases.";

  scenarios.push(
    scenario(
      "leads",
      revenuePerCase === null ? null : 0.1 * leads * leadToCase * revenuePerCase,
      revenuePerCase === null ? needsRevenuePerCase : null,
    ),
  );

  if (consultToCase === null) {
    scenarios.push(
      scenario(
        "leadToConsult",
        null,
        "No consults were entered, so this scenario can't be priced.",
      ),
    );
  } else if (revenuePerCase === null) {
    scenarios.push(scenario("leadToConsult", null, needsRevenuePerCase));
  } else {
    const lift = lifted(leadToConsult);
    scenarios.push(
      scenario(
        "leadToConsult",
        (lift.next - leadToConsult) * leads * consultToCase * revenuePerCase,
        null,
        lift.capped,
      ),
    );
  }

  if (consultToCase === null) {
    scenarios.push(
      scenario(
        "consultToCase",
        null,
        "No consults were entered, so this scenario can't be priced.",
      ),
    );
  } else if (revenuePerCase === null) {
    scenarios.push(scenario("consultToCase", null, needsRevenuePerCase));
  } else {
    const lift = lifted(consultToCase);
    scenarios.push(
      scenario(
        "consultToCase",
        (lift.next - consultToCase) * consults * revenuePerCase,
        null,
        lift.capped,
      ),
    );
  }

  scenarios.push(
    scenario(
      "revenuePerCase",
      revenuePerCase === null ? null : cases * revenuePerCase * 0.1,
      revenuePerCase === null ? needsRevenuePerCase : null,
    ),
  );

  return {
    periodMonths,
    periodLabel: `${periodMonths}-month totals`,
    revenueBasis: inputs.revenueBasis,
    confidence: inputs.revenueBasis === "generated" ? "actual" : "estimated",
    ree: revenue / totalInvestment,
    metrics,
    scenarios,
  };
}

// ---- formatting helpers (shared by the client UI) ----

export function fmtUSD0(n: number): string {
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

export function fmtUSD2(n: number): string {
  return `$${n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** "40%", "33.3%" — one decimal, trailing .0 stripped. */
export function fmtPct(rate: number): string {
  const pct = rate * 100;
  const s = pct.toFixed(1).replace(/\.0$/, "");
  return `${s}%`;
}

/** REE as a multiple: "5.8×", "8×". */
export function fmtX(n: number): string {
  return `${n.toFixed(1).replace(/\.0$/, "")}\u00d7`;
}

/**
 * The approved headline shape. The word "estimated" drops only when the
 * visitor selected the actual-revenue basis.
 */
export function headlineSentence(r: {
  ree: number;
  confidence: "actual" | "estimated";
}): string {
  const amount = fmtUSD2(r.ree);
  return r.confidence === "actual"
    ? `Your Revenue Engine currently produces ${amount} in top-line revenue for every $1 invested in client acquisition.`
    : `Your Revenue Engine currently produces an estimated ${amount} in top-line revenue for every $1 invested in client acquisition.`;
}