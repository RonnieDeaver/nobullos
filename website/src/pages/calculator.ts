// /calculator/ — a quick, browser-only Revenue Engine Efficiency score.
// Math lives in calc-client/math.ts; this page intentionally collects one
// reporting period only and hands just that concise score into booking.

import { PageDef, assetV, titleBand } from "../html";

/** Input row helper — label + optional help line + one control. */
function field(opts: {
  name: string;
  label: string;
  help?: string;
  placeholder?: string;
  inputmode?: "decimal" | "numeric";
}): string {
  const help = opts.help ? `\n        <span class="calc-help">${opts.help}</span>` : "";
  return `      <label class="calc-field">
        <span class="calc-label"><span>${opts.label}</span></span>${help}
        <input type="text" name="${opts.name}" inputmode="${opts.inputmode ?? "decimal"}" autocomplete="off"${opts.placeholder ? ` placeholder="${opts.placeholder}"` : ""}>
      </label>`;
}

export const calculatorPage: PageDef = {
  path: "calculator/",
  title: "REE Calculator - Score Your Revenue Engine | NoBull Marketing",
  desc:
    "Calculate your law firm's Revenue Engine Efficiency (REE): the revenue your engine produces for every $1 invested in client acquisition. Free, browser-only, and no email required.",
  priority: "0.8",
  bodyEnd: (r) => `\n<script src="${r}assets/js/calc.js${assetV()}" defer></script>`,
  render: (r) => `
${titleBand(
  "Score Your Revenue Engine.",
  "Enter one reporting period of real numbers. See the revenue your engine produces for every $1 invested, plus what a 10% improvement in each direct lever is worth. Free, no email required.",
  { eyebrow: "REVENUE ENGINE EFFICIENCY" },
)}

<section class="calc-sec">
  <div class="container">
    <div class="calc-form-wrap">
      <form id="calc-form" class="calc-form-card" novalidate>
        <fieldset class="calc-group">
          <legend>Your reporting period</legend>
          <div class="calc-periods" role="radiogroup" aria-label="Reporting period">
            <label><input type="radio" name="periodMonths" value="3" checked><span>3 months</span></label>
            <label><input type="radio" name="periodMonths" value="6"><span>6 months</span></label>
            <label><input type="radio" name="periodMonths" value="12"><span>12 months</span></label>
          </div>
        </fieldset>

        <fieldset class="calc-group">
          <legend>Your inputs</legend>
${field({ name: "totalInvestment", label: "Total investment ($)", placeholder: "e.g. 20,000", help: "Include ad spend, agency fees, and intake/sales staff costs for this selected period." })}
          <div class="calc-three">
${field({ name: "leads", label: "Leads", inputmode: "numeric", placeholder: "e.g. 100" })}
${field({ name: "consults", label: "Consults", inputmode: "numeric", placeholder: "e.g. 40" })}
${field({ name: "cases", label: "Cases", inputmode: "numeric", placeholder: "e.g. 10" })}
          </div>
        </fieldset>

        <fieldset class="calc-group">
          <legend>Revenue basis</legend>
          <div class="calc-basis-opt">
            <label class="calc-radio">
              <input type="radio" name="revenueBasis" value="estimated" checked>
              <span class="calc-radio-name">Estimate from average case value</span>
              <span class="calc-basis-tag">Estimated basis</span>
            </label>
            <label class="calc-field">
              <span class="calc-label"><span>Estimated case value ($)</span></span>
              <span class="calc-help">Cases \u00d7 this value gives an estimated total revenue for the selected period.</span>
              <input type="text" name="estimatedCaseValue" inputmode="decimal" autocomplete="off" placeholder="e.g. 11,600">
            </label>
          </div>
          <div class="calc-basis-opt">
            <label class="calc-radio">
              <input type="radio" name="revenueBasis" value="generated">
              <span class="calc-radio-name">Use revenue generated</span>
              <span class="calc-basis-tag">Actual basis</span>
            </label>
            <label class="calc-field">
              <span class="calc-label"><span>Revenue generated ($)</span></span>
              <span class="calc-help">Enter the revenue you can attribute to this selected period.</span>
              <input type="text" name="revenueGenerated" inputmode="decimal" autocomplete="off" placeholder="e.g. 116,000" disabled>
            </label>
          </div>
        </fieldset>

        <div id="calc-errors" class="calc-errors" role="alert" hidden></div>

        <div class="calc-submit">
          <button class="btn calc-submit-btn" type="submit">Calculate my REE</button>
          <p class="calc-privacy">Runs entirely in your browser \u2014 nothing you enter is stored or sent.</p>
        </div>
      </form>
    </div>

    <div id="calc-results" class="calc-results" aria-live="polite" data-booking-base="${r}" hidden></div>
    <noscript>
      <div class="calc-noscript">
        <p>The calculator needs JavaScript to run \u2014 all of the math happens right in your browser. If it can't load, <a href="${r}#booking">book a high impact revenue session</a> and we'll run the numbers with you.</p>
      </div>
    </noscript>
  </div>
</section>`,
};
