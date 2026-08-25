import { PageDef, assetV, dimsAttr } from "../html";

const LOGO = "nobull-redesign/brand/nobull-logo-full-color.svg";

function requiredDims(publicPath: string): string {
  const attrs = dimsAttr(publicPath);
  if (!attrs) throw new Error(`Required book application asset is missing: ${publicPath}`);
  return attrs;
}

export const bookApplyPage: PageDef = {
  path: "book/apply/",
  title: "Book-Buyer Bonus Application | NoBull Marketing",
  desc:
    "See whether your firm is eligible to schedule a High-Impact Revenue Session and complimentary Intake Audit.",
  priority: "0.1",
  bodyClass: "bf-body",
  chrome: false,
  headExtra: (r) => `
<link rel="preconnect" href="https://use.typekit.net" crossorigin>
<link rel="stylesheet" href="https://use.typekit.net/hve0rhv.css">
<link rel="stylesheet" href="${r}assets/css/book.css${assetV()}">`,
  bodyEnd: (r) => `<script src="${r}assets/js/book-checkout.js${assetV()}" defer></script>`,
  render: (r) => `
<a class="nb-skip-link bf-skip" href="#main">Skip to application</a>
<div class="bf-page bf-journey-page" data-book-apply data-access-url="${r}book/access/" data-thanks-url="${r}book/thanks/">
  <header class="bf-header" data-site-header-contract="focused-funnel">
    <div class="bf-wrap bf-header-inner">
      <a class="bf-logo-link" href="${r || "./"}" aria-label="NoBull Marketing home">
        <img class="bf-logo" src="${r}${LOGO}" alt="NoBull Marketing — The Law Firm Experts"${requiredDims(LOGO)}>
      </a>
      <a class="bf-header-access" data-access-book href="${r}book/access/">Access My Book</a>
    </div>
  </header>
  <main id="main" class="bf-journey" tabindex="-1">
    <header class="bf-journey-heading">
      <p class="bf-purchase-kicker">Book-buyer bonus</p>
      <h1>See if your firm qualifies.</h1>
      <p>Five short questions help us choose the right next step. Your answers do not affect your purchase or book access.</p>
    </header>

    <p class="bf-journey-live" data-journey-status role="status" aria-live="polite">Confirming your purchase…</p>

    <section class="bf-journey-panel" data-apply-recovery hidden>
      <p class="bf-checkout-eyebrow">Secure reference needed</p>
      <h2>Open this page from your buyer-bonus link.</h2>
      <p>Your book is still yours. Use the access email sent after purchase, or request a fresh link.</p>
      <a class="bf-checkout-primary" href="${r}book/access/">Go to book access</a>
    </section>

    <form class="bf-journey-form" data-application-form hidden novalidate>
      <div class="bf-field">
        <label for="buyer-role">Your role at the firm</label>
        <select id="buyer-role" name="role" required>
          <option value="">Choose one</option>
          <option value="owner">Owner</option>
          <option value="managing_partner">Managing partner</option>
          <option value="decision_maker">Decision-making leader</option>
          <option value="other">Another role</option>
        </select>
      </div>
      <div class="bf-field">
        <label for="buyer-practice">Primary practice area</label>
        <input id="buyer-practice" name="practiceArea" type="text" maxlength="120" autocomplete="organization-title" required>
      </div>
      <div class="bf-field">
        <label for="buyer-inquiries">Approximate monthly qualified inquiries</label>
        <select id="buyer-inquiries" name="monthlyQualifiedInquiries" required>
          <option value="">Choose a range</option>
          <option value="under_10">Fewer than 10</option>
          <option value="10_24">10–24</option>
          <option value="25_49">25–49</option>
          <option value="50_99">50–99</option>
          <option value="100_plus">100 or more</option>
          <option value="unsure">Not sure</option>
        </select>
      </div>
      <div class="bf-field">
        <label for="buyer-revenue">Approximate annual firm revenue</label>
        <select id="buyer-revenue" name="annualFirmRevenue" required>
          <option value="">Choose a range</option>
          <option value="under_1m">Under $1 million</option>
          <option value="1m_3m">$1 million–$2.99 million</option>
          <option value="3m_10m">$3 million–$9.99 million</option>
          <option value="10m_plus">$10 million or more</option>
          <option value="prefer_not_to_say">Prefer not to say</option>
        </select>
      </div>
      <div class="bf-field">
        <label for="buyer-timing">When are you considering improvements?</label>
        <select id="buyer-timing" name="improvementTiming" required>
          <option value="">Choose one</option>
          <option value="0_30_days">Within 30 days</option>
          <option value="31_90_days">Within 31–90 days</option>
          <option value="91_plus_days">More than 90 days from now</option>
          <option value="exploring">I’m still exploring</option>
        </select>
      </div>
      <p class="bf-form-privacy">Do not include confidential client information or recordings. We use these answers only to route this buyer-bonus request.</p>
      <button class="bf-checkout-primary" type="submit" data-application-submit>Show My Next Step <span aria-hidden="true">→</span></button>
      <p class="bf-field-error" data-application-error role="alert"></p>
    </form>

    <section class="bf-journey-panel" data-outcome-manual hidden tabindex="-1">
      <p class="bf-checkout-eyebrow">Application received</p>
      <h2>We’ll review the fit personally.</h2>
      <p>Your answers do not map cleanly to an approved automatic decision, so a team member will review them. We will not invent a qualification result.</p>
    </section>

    <section class="bf-journey-panel" data-outcome-processing hidden tabindex="-1">
      <p class="bf-checkout-eyebrow">Application saved</p>
      <h2>We’re finalizing your next step.</h2>
      <p>Your answers are safely stored. If this takes more than a moment, retry the final routing step without filling out the form again.</p>
      <button class="bf-checkout-secondary" type="button" data-resume-application>Try Again</button>
    </section>

    <section class="bf-journey-panel" data-outcome-alternate hidden tabindex="-1">
      <p class="bf-checkout-eyebrow">A better next step for now</p>
      <h2>Keep building from the book.</h2>
      <p>The High-Impact Revenue Session is not the right route at this stage. Your purchase and book access remain unchanged.</p>
    </section>

    <section class="bf-journey-panel bf-calendar-panel" data-outcome-qualified hidden tabindex="-1">
      <p class="bf-checkout-eyebrow">Qualified to schedule</p>
      <h2>Choose a High-Impact Revenue Session.</h2>
      <p>The GHL calendar is loaded only when you ask to view it. Availability and appointment operations remain with GHL.</p>
      <button class="bf-checkout-primary" type="button" data-load-calendar>Show Appointment Calendar</button>
      <div class="bf-calendar-shell" data-calendar-shell hidden></div>
      <div class="bf-calendar-fallback" data-calendar-fallback hidden>
        <p>The calendar is taking longer than expected. Your application and book access are safe.</p>
        <a class="bf-checkout-link" data-calendar-open target="_blank" rel="noopener">Open the calendar in a new tab</a>
      </div>
      <a class="bf-checkout-link bf-booking-status-link" data-booking-status hidden>Already booked? View appointment status</a>
    </section>

    <div class="bf-journey-access">
      <a class="bf-checkout-link" data-access-book-alt href="${r}book/access/">No thanks — take me to my book</a>
    </div>
  </main>
</div>`,
};