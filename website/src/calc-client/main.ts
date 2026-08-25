// Client bundle for /calculator/. The form computes entirely in the browser:
// no entered value is persisted or sent until the visitor chooses to submit
// the separate booking form.

import { captureAttribution } from "../client-shared/attribution";
import { initInquiryForms } from "../client-shared/inquiry";
import { buildReeHandoffQuery } from "../client-shared/reeHandoff";
import {
  computeCalc,
  fmtPct,
  fmtUSD0,
  fmtUSD2,
  fmtX,
  headlineSentence,
  parseNumericInput,
  validateCalcInputs,
  type CalcInputDraft,
  type CalcInputs,
  type CalcResults,
} from "./math";

function esc(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function readForm(form: HTMLFormElement): CalcInputDraft {
  const value = (name: string): string =>
    (form.elements.namedItem(name) as HTMLInputElement | null)?.value?.trim() ?? "";
  const number = (name: string): number | null => parseNumericInput(value(name));
  const basis =
    form.querySelector<HTMLInputElement>('input[name="revenueBasis"]:checked')?.value === "generated"
      ? "generated"
      : "estimated";

  return {
    periodMonths: number("periodMonths"),
    totalInvestment: number("totalInvestment"),
    leads: number("leads"),
    consults: number("consults"),
    cases: number("cases"),
    revenueBasis: basis,
    revenueGenerated: basis === "generated" ? number("revenueGenerated") : null,
    estimatedCaseValue: basis === "estimated" ? number("estimatedCaseValue") : null,
  };
}

function metricTile(label: string, value: string): string {
  return (
    `<div class="calc-metric">` +
    `<span class="calc-metric-label">${esc(label)}</span>` +
    `<span class="calc-metric-value">${esc(value)}</span>` +
    `</div>`
  );
}

function renderResults(
  container: HTMLElement,
  inputs: CalcInputs,
  result: CalcResults,
): void {
  const metrics = result.metrics;
  const bookingBase = container.getAttribute("data-booking-base") ?? "../";
  const actual = result.revenueBasis === "generated";
  const revenueLabel = actual ? "Actual revenue" : "Estimated revenue";
  const chip = actual
    ? '<span class="calc-chip calc-chip-actual">Actual revenue</span>'
    : '<span class="calc-chip">Estimated revenue</span>';

  const tiles: string[] = [
    metricTile(`${revenueLabel} — ${result.periodLabel}`, fmtUSD0(metrics.revenue)),
    metricTile("Total investment", fmtUSD0(inputs.totalInvestment)),
    metricTile("Cost per Lead", fmtUSD0(metrics.costPerLead)),
  ];
  if (metrics.costPerCase !== null) {
    tiles.push(metricTile("Cost per Case", fmtUSD0(metrics.costPerCase)));
  }
  tiles.push(metricTile("Lead-to-Consult", fmtPct(metrics.leadToConsult)));
  if (metrics.consultToCase !== null) {
    tiles.push(metricTile("Consult-to-Case", fmtPct(metrics.consultToCase)));
  }
  tiles.push(metricTile("Lead-to-Case", fmtPct(metrics.leadToCase)));
  if (metrics.revenuePerCase !== null) {
    tiles.push(metricTile("Revenue per Case", fmtUSD0(metrics.revenuePerCase)));
  }

  const availableScenarios = result.scenarios.filter((scenario) => scenario.available);
  const scenarioRows = availableScenarios
    .map(
      (scenario) =>
        `<div class="calc-improvement">` +
        `<span class="calc-improvement-name">${esc(scenario.label)}</span>` +
        `<span class="calc-improvement-value">+${esc(fmtUSD0(scenario.additionalRevenue))}</span>` +
        (scenario.cappedAt100
          ? `<span class="calc-improvement-note">Limited by the 100% conversion ceiling.</span>`
          : "") +
        `</div>`,
    )
    .join("");
  const improvementBody =
    scenarioRows ||
    `<p class="calc-improvements-empty">Add at least one case to price the direct improvements.</p>`;

  const query = buildReeHandoffQuery({
    periodMonths: result.periodMonths,
    reePerDollar: result.ree,
    revenueBasis: result.confidence,
  });

  container.innerHTML =
    `<div class="calc-result-head">${chip}<h2 class="serif-soft">Your REE</h2>` +
    `<p class="calc-period-echo">${esc(result.periodLabel)}</p></div>` +
    `<p class="calc-score">${esc(fmtX(result.ree))}` +
    `<span class="calc-score-sub">${esc(fmtUSD2(result.ree))} per $1</span></p>` +
    `<p class="calc-headline">${esc(headlineSentence(result))}</p>` +
    `<div class="calc-metrics">${tiles.join("")}</div>` +
    `<section class="calc-improvements" aria-labelledby="calc-improvements-title">` +
    `<h3 id="calc-improvements-title">The value of a 10% improvement</h3>` +
    `<p class="calc-improvements-intro">Additional revenue from improving one direct lever by 10%, with the other inputs unchanged.</p>` +
    improvementBody +
    `</section>` +
    `<div class="calc-handoff">` +
    `<h3 class="serif-soft">Want to pressure-test this result?</h3>` +
    `<p>Bring your score to a High Impact Revenue Session and we’ll validate the inputs and identify the clearest next step.</p>` +
    `<div class="calc-handoff-actions">` +
    `<a class="btn" href="${esc(bookingBase)}?${esc(query)}#booking">Book a High Impact Revenue Session</a>` +
    `</div>` +
    `<p class="calc-handoff-note">Your period, REE, and revenue basis ride along. You can edit the booking message before sending it.</p>` +
    `</div>`;

  container.hidden = false;
  container.classList.remove("calc-stale");
}

function initCalculator(): void {
  const form = document.querySelector<HTMLFormElement>("#calc-form");
  const results = document.querySelector<HTMLElement>("#calc-results");
  const errorBox = document.querySelector<HTMLElement>("#calc-errors");
  if (!form || !results || !errorBox) return;

  let hasComputed = false;

  const syncBasis = (): void => {
    const basis =
      form.querySelector<HTMLInputElement>('input[name="revenueBasis"]:checked')?.value ??
      "estimated";
    const generated = form.querySelector<HTMLInputElement>('input[name="revenueGenerated"]');
    const estimated = form.querySelector<HTMLInputElement>('input[name="estimatedCaseValue"]');
    if (generated) generated.disabled = basis !== "generated";
    if (estimated) estimated.disabled = basis !== "estimated";
    generated?.closest(".calc-basis-opt")?.classList.toggle("on", basis === "generated");
    estimated?.closest(".calc-basis-opt")?.classList.toggle("on", basis === "estimated");
  };
  form.querySelectorAll<HTMLInputElement>('input[name="revenueBasis"]').forEach((radio) => {
    radio.addEventListener("change", syncBasis);
  });
  syncBasis();

  const clearFieldErrors = (): void => {
    form.querySelectorAll("[aria-invalid]").forEach((element) => {
      element.removeAttribute("aria-invalid");
    });
  };

  const run = (showErrors: boolean): void => {
    const draft = readForm(form);
    const issues = validateCalcInputs(draft);

    if (issues.length > 0) {
      if (showErrors) {
        clearFieldErrors();
        errorBox.innerHTML =
          `<p class="calc-errors-title">Fix these to calculate your REE</p>` +
          `<ul>${issues.map((issue) => `<li>${esc(issue.message)}</li>`).join("")}</ul>`;
        errorBox.hidden = false;
        for (const issue of issues) {
          form.querySelectorAll<HTMLElement>(`[name="${issue.field}"]`).forEach((element) => {
            element.setAttribute("aria-invalid", "true");
          });
        }
        const firstInvalid = form.querySelector<HTMLElement>('[aria-invalid="true"]');
        firstInvalid?.focus();
        errorBox.scrollIntoView({ block: "nearest", behavior: "smooth" });
      } else if (hasComputed) {
        results.classList.add("calc-stale");
      }
      return;
    }

    clearFieldErrors();
    errorBox.hidden = true;
    errorBox.innerHTML = "";

    const inputs = draft as CalcInputs;
    renderResults(results, inputs, computeCalc(inputs));
    if (!hasComputed) {
      hasComputed = true;
      results.tabIndex = -1;
      results.focus({ preventScroll: true });
      results.scrollIntoView({ block: "start", behavior: "smooth" });
    }
  };

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    run(true);
  });
  form.addEventListener("input", () => {
    if (hasComputed) run(false);
  });
}

function init(): void {
  captureAttribution();
  // site.js owns the shared subpage chrome, including mobile navigation.
  // calculator pages load that bundle before this calculator-only bundle.
  initInquiryForms();
  initCalculator();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}