import { PageDef, assetV, dimsAttr } from "../html";

const LOGO = "nobull-redesign/brand/nobull-logo-full-color.svg";

function requiredDims(publicPath: string): string {
  const attrs = dimsAttr(publicPath);
  if (!attrs) throw new Error(`Required book access asset is missing: ${publicPath}`);
  return attrs;
}

export const bookAccessPage: PageDef = {
  path: "book/access/",
  title: "Access The Law Firm Revenue Engine | NoBull Marketing",
  desc: "Securely access your purchased digital edition.",
  priority: "0.1",
  bodyClass: "bf-body",
  chrome: false,
  headExtra: (r) => `
<meta name="robots" content="noindex,nofollow">
<link rel="preconnect" href="https://use.typekit.net" crossorigin>
<link rel="stylesheet" href="https://use.typekit.net/hve0rhv.css">
<link rel="stylesheet" href="${r}assets/css/book.css${assetV()}">`,
  bodyEnd: (r) => `<script src="${r}assets/js/book-checkout.js${assetV()}" defer></script>`,
  render: (r) => `
<a class="nb-skip-link bf-skip" href="#main">Skip to downloads</a>
<div class="bf-page bf-success-page" data-book-access>
  <header class="bf-header" data-site-header-contract="focused-funnel">
    <div class="bf-wrap bf-header-inner">
      <a class="bf-logo-link" href="${r || "./"}" aria-label="NoBull Marketing home">
        <img class="bf-logo" src="${r}${LOGO}" alt="NoBull Marketing — The Law Firm Experts"${requiredDims(LOGO)}>
      </a>
      <p class="bf-header-trust">Private book access</p>
    </div>
  </header>
  <main id="main" class="bf-success" tabindex="-1">
    <section class="bf-success-card">
      <p class="bf-purchase-kicker">The Law Firm Revenue Engine</p>
      <h1>Your book library.</h1>
      <p class="bf-success-lede" data-access-status role="status" aria-live="polite">Checking your secure access…</p>
      <div class="bf-download-list" data-access-assets aria-label="Available downloads"></div>
      <a class="bf-checkout-link bf-order-status-link" data-order-status-link href="${r}book/order-status/" hidden>View order status</a>
      <form class="bf-recovery-form" data-delivery-resend-form>
        <h2>Send a new access link</h2>
        <p>Use the email from checkout if your link expired, you changed devices, or you no longer have the original message.</p>
        <label for="access-email">Purchase email</label>
        <div>
          <input id="access-email" name="email" type="email" autocomplete="email" required>
          <button type="submit">Send access link</button>
        </div>
        <p data-resend-status role="status" aria-live="polite"></p>
      </form>
      <aside class="bf-access-help" aria-labelledby="access-help-title">
        <h2 id="access-help-title">Still need help?</h2>
        <p>If a refund, revocation, or unavailable file may apply, a new link will not override it. <a href="${r}contact/">Contact NoBull support</a> and include only your purchase email and order number—never send card details or an access link.</p>
      </aside>
    </section>
  </main>
</div>`,
};