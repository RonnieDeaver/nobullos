// REE calculator → homepage booking handoff contract.
//
// Only the concise score context crosses the URL boundary. The calculator
// remains browser-only; nothing is submitted until the visitor sends the
// editable booking form.

export interface ReeHandoffData {
  periodMonths: 3 | 6 | 12;
  /** REE as dollars per $1, e.g. 5.8 → "$5.80 per $1". */
  reePerDollar: number;
  revenueBasis: "actual" | "estimated";
}

const PARAM = {
  period: "ree_period",
  ree: "ree_usd",
  basis: "ree_basis",
} as const;

export function buildReeHandoffQuery(data: ReeHandoffData): string {
  const params = new URLSearchParams();
  params.set(PARAM.period, String(data.periodMonths));
  params.set(PARAM.ree, data.reePerDollar.toFixed(2));
  params.set(PARAM.basis, data.revenueBasis);
  return params.toString();
}

export function parseReeHandoffParams(search: string): ReeHandoffData | null {
  const params = new URLSearchParams(search);
  const periodRaw = params.get(PARAM.period);
  const reeRaw = params.get(PARAM.ree);
  const basis = params.get(PARAM.basis);
  if (periodRaw === null || reeRaw === null) return null;
  const period = Number(periodRaw);
  const ree = Number(reeRaw);

  if (period !== 3 && period !== 6 && period !== 12) return null;
  if (!Number.isFinite(ree) || ree < 0 || ree > 10000) return null;
  if (basis !== "actual" && basis !== "estimated") return null;

  return {
    periodMonths: period,
    reePerDollar: ree,
    revenueBasis: basis,
  };
}

/** The homepage contact form's pre-filled message. Plain text textarea value. */
export function composeReeInquiryMessage(data: ReeHandoffData): string {
  const score = `$${data.reePerDollar.toFixed(2)}`;
  return (
    `From the REE calculator: for my ${data.periodMonths}-month reporting period, ` +
    `my Revenue Engine shows ${score} in revenue per $1 of total investment ` +
    `(${data.revenueBasis} revenue basis). ` +
    `I'd like to validate these numbers and identify the clearest next step.`
  );
}

/** Applies calculator context to an empty canonical contact message only.
 * The homepage bundle calls this after a ?ree_*#booking handoff. Visitor text
 * always wins, even though booking (not the form) is the visible destination. */
export function initReeHandoffPrefill(): void {
  const data = parseReeHandoffParams(window.location.search);
  if (!data) return;
  const textarea = document.querySelector<HTMLTextAreaElement>(
    'form[data-nb-inquiry="contact"] textarea[name="message"]',
  );
  if (!textarea || textarea.value.trim() !== "") return;
  textarea.value = composeReeInquiryMessage(data);
}