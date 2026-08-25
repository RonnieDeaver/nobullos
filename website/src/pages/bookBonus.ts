import { PageDef, assetV, dimsAttr } from "../html";

const LOGO = "nobull-redesign/brand/nobull-logo-full-color.svg";

function requiredDims(publicPath: string): string {
  const attrs = dimsAttr(publicPath);
  if (!attrs) throw new Error(`Required book bonus asset is missing: ${publicPath}`);
  return attrs;
}

export const bookBonusPage: PageDef = {
  path: "book/bonus/",
  title: "Your Book Is Ready | NoBull Marketing",
  desc: "Access your purchased copy of The Law Firm Revenue Engine.",
  priority: "0.1",
  bodyClass: "bf-body",
  chrome: false,
  headExtra: (r) => `
<link rel="preconnect" href="https://use.typekit.net" crossorigin>
<link rel="stylesheet" href="https://use.typekit.net/hve0rhv.css">
<link rel="stylesheet" href="${r}assets/css/book.css${assetV()}">`,
  bodyEnd: (r) => `<script src="${r}assets/js/book-checkout.js${assetV()}" defer></script>`,
  render: (r) => `
<a class="nb-skip-link bf-skip" href="#main">Skip to book access</a>
<div class="bf-page bf-success-page" data-book-bonus>
  <header class="bf-header" data-site-header-contract="focused-funnel">
    <div class="bf-wrap bf-header-inner">
      <a class="bf-logo-link" href="${r || "./"}" aria-label="NoBull Marketing home">
        <img class="bf-logo" src="${r}${LOGO}" alt="NoBull Marketing — The Law Firm Experts"${requiredDims(LOGO)}>
      </a>
      <p class="bf-header-trust">Verified purchase <span aria-hidden="true">·</span> Secure access</p>
    </div>
  </header>
  <main id="main" class="bf-success" tabindex="-1">
    <section class="bf-success-card">
      <p class="bf-purchase-kicker">Order complete</p>
      <h1>Your book is ready.</h1>
      <p class="bf-success-lede" data-bonus-status role="status" aria-live="polite">Verifying your purchase and preparing secure access…</p>
      <a class="bf-checkout-primary bf-access-primary" data-access-book href="${r}book/access/" hidden>Access My Book <span aria-hidden="true">→</span></a>
      <div class="bf-bonus-bridge">
        <p class="bf-checkout-eyebrow">A book-buyer bonus from NoBull</p>
        <h2>Turn the book into a revenue plan for your firm.</h2>
        <p>Book a High-Impact Revenue Session with NoBull’s growth team. Qualified firms that attend and provide the requested intake data will also receive a complimentary 60-minute Intake Audit with our Senior Intake Specialist — a former Director of Operations at an eight-figure law firm.</p>
        <ul class="bf-bonus-list">
          <li>Clarify the firm’s revenue goal.</li>
          <li>Map the current Marketing → Intake → Sales path.</li>
          <li>Identify the most consequential constraints.</li>
          <li>Determine whether NoBull is a fit to help.</li>
        </ul>
        <p>This is a working sales conversation. If we believe NoBull can help, we will explain how. There is no obligation to hire.</p>
        <a class="bf-checkout-primary bf-bonus-apply" data-apply-book-bonus href="${r}book/apply/" hidden>See If My Firm Qualifies <span aria-hidden="true">→</span></a>
        <a class="bf-checkout-link" data-access-book-alt href="${r}book/access/" hidden>No thanks — take me to my book</a>
      </div>
      <form class="bf-recovery-form" data-delivery-resend-form>
        <h2>Need a fresh access email?</h2>
        <label for="bonus-email">Purchase email</label>
        <div>
          <input id="bonus-email" name="email" type="email" autocomplete="email" required>
          <button type="submit">Send access link</button>
        </div>
        <p data-resend-status role="status" aria-live="polite"></p>
      </form>
    </section>
  </main>
</div>`,
};