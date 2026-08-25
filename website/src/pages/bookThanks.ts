import { PageDef, assetV, dimsAttr } from "../html";

const LOGO = "nobull-redesign/brand/nobull-logo-full-color.svg";

function requiredDims(publicPath: string): string {
  const attrs = dimsAttr(publicPath);
  if (!attrs) throw new Error(`Required book thanks asset is missing: ${publicPath}`);
  return attrs;
}

export const bookThanksPage: PageDef = {
  path: "book/thanks/",
  title: "Your High-Impact Revenue Session | NoBull Marketing",
  desc: "View verified appointment details and continue to your purchased book.",
  priority: "0.1",
  bodyClass: "bf-body",
  chrome: false,
  headExtra: (r) => `
<link rel="preconnect" href="https://use.typekit.net" crossorigin>
<link rel="stylesheet" href="https://use.typekit.net/hve0rhv.css">
<link rel="stylesheet" href="${r}assets/css/book.css${assetV()}">`,
  bodyEnd: (r) => `<script src="${r}assets/js/book-checkout.js${assetV()}" defer></script>`,
  render: (r) => `
<a class="nb-skip-link bf-skip" href="#main">Skip to appointment details</a>
<div class="bf-page bf-success-page" data-book-thanks data-access-url="${r}book/access/">
  <header class="bf-header" data-site-header-contract="focused-funnel">
    <div class="bf-wrap bf-header-inner">
      <a class="bf-logo-link" href="${r || "./"}" aria-label="NoBull Marketing home">
        <img class="bf-logo" src="${r}${LOGO}" alt="NoBull Marketing — The Law Firm Experts"${requiredDims(LOGO)}>
      </a>
      <a class="bf-header-access" data-access-book href="${r}book/access/">Access My Book</a>
    </div>
  </header>
  <main id="main" class="bf-success" tabindex="-1">
    <section class="bf-success-card bf-thanks-card">
      <p class="bf-purchase-kicker">High-Impact Revenue Session</p>
      <h1 data-thanks-heading>Checking your appointment.</h1>
      <p class="bf-success-lede" data-thanks-status role="status" aria-live="polite">Loading verified appointment details…</p>

      <section class="bf-appointment-details" data-appointment-details hidden aria-labelledby="appointment-details-title">
        <h2 id="appointment-details-title">Your session details</h2>
        <dl>
          <div><dt>Date and time</dt><dd data-appointment-time>—</dd></div>
          <div><dt>Timezone</dt><dd data-appointment-timezone>—</dd></div>
          <div data-appointment-type-row hidden><dt>Session</dt><dd data-appointment-type>—</dd></div>
          <div data-appointment-host-row hidden><dt>Host</dt><dd data-appointment-host>—</dd></div>
        </dl>
        <div class="bf-checkout-actions">
          <a class="bf-checkout-primary" data-meeting-link target="_blank" rel="noopener" hidden>Join Meeting</a>
          <button class="bf-checkout-secondary" type="button" data-add-calendar hidden>Add to Calendar</button>
          <a class="bf-checkout-link" href="${r}#contact">Need to reschedule or cancel?</a>
        </div>
      </section>

      <section class="bf-journey-panel" data-appointment-pending hidden>
        <h2>Your booking is still syncing.</h2>
        <p>GHL remains the appointment owner. We’ll show details here only after the trusted appointment mirror confirms them.</p>
        <button class="bf-checkout-secondary" type="button" data-refresh-appointment>Check Again</button>
      </section>

      <section class="bf-session-agenda">
        <p class="bf-checkout-eyebrow">Make the conversation useful</p>
        <h2>We’ll focus on three things.</h2>
        <ol>
          <li>Your firm’s revenue goal.</li>
          <li>Your current Marketing → Intake → Sales path.</li>
          <li>The most consequential constraints and practical next step.</li>
        </ol>
        <p>This is a working sales conversation. If we believe NoBull can help, we will explain how. There is no obligation to hire.</p>
      </section>

      <a class="bf-checkout-primary bf-access-primary" data-access-book-alt href="${r}book/access/">Continue to My Book <span aria-hidden="true">→</span></a>
    </section>
  </main>
</div>`,
};