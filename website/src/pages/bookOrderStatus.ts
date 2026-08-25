import { PageDef, assetV, dimsAttr } from "../html";

const LOGO = "nobull-redesign/brand/nobull-logo-full-color.svg";

function requiredDims(publicPath: string): string {
  const attrs = dimsAttr(publicPath);
  if (!attrs) throw new Error(`Required book order-status asset is missing: ${publicPath}`);
  return attrs;
}

export const bookOrderStatusPage: PageDef = {
  path: "book/order-status/",
  title: "Book Order Status | NoBull Marketing",
  desc: "Privately review the current status of your Law Firm Revenue Engine order.",
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
<a class="nb-skip-link bf-skip" href="#main">Skip to order status</a>
<div class="bf-page bf-success-page" data-book-order-status>
  <header class="bf-header" data-site-header-contract="focused-funnel">
    <div class="bf-wrap bf-header-inner">
      <a class="bf-logo-link" href="${r || "./"}" aria-label="NoBull Marketing home">
        <img class="bf-logo" src="${r}${LOGO}" alt="NoBull Marketing — The Law Firm Experts"${requiredDims(LOGO)}>
      </a>
      <a class="bf-header-access" href="${r}book/access/">Access My Book</a>
    </div>
  </header>
  <main id="main" class="bf-success" tabindex="-1">
    <section class="bf-success-card">
      <p class="bf-purchase-kicker">The Law Firm Revenue Engine</p>
      <h1>Order status.</h1>
      <p class="bf-success-lede" data-order-status-message role="status" aria-live="polite">Checking your secure order session…</p>

      <section class="bf-order-summary" data-order-summary-panel hidden aria-labelledby="book-order-summary-title">
        <h2 id="book-order-summary-title">Purchase summary</h2>
        <dl>
          <div><dt>Order</dt><dd data-order-number>—</dd></div>
          <div><dt>Edition</dt><dd data-order-package>—</dd></div>
          <div><dt>Placed</dt><dd data-order-date>—</dd></div>
          <div><dt>Total</dt><dd data-order-total>—</dd></div>
          <div><dt>Order state</dt><dd data-order-state>—</dd></div>
        </dl>
        <h2>Fulfillment</h2>
        <dl>
          <div><dt>Digital book</dt><dd data-order-digital>—</dd></div>
          <div data-order-audio-row hidden><dt>Audiobook</dt><dd data-order-audio>—</dd></div>
          <div data-order-physical-row hidden><dt>Printed edition</dt><dd data-order-physical>—</dd></div>
        </dl>
        <p class="bf-order-privacy">For your privacy, this page never displays an email, address, card information, carrier, or private application answers.</p>
        <a class="bf-checkout-primary bf-access-primary" href="${r}book/access/">Go to My Downloads <span aria-hidden="true">→</span></a>
      </section>

      <form class="bf-recovery-form" data-delivery-resend-form hidden>
        <h2>Open a fresh secure session</h2>
        <p>Order details are available only after you open a current access link.</p>
        <label for="order-access-email">Purchase email</label>
        <div>
          <input id="order-access-email" name="email" type="email" autocomplete="email" required>
          <button type="submit">Send access link</button>
        </div>
        <p data-resend-status role="status" aria-live="polite"></p>
      </form>
      <aside class="bf-access-help" aria-labelledby="order-help-title">
        <h2 id="order-help-title">Questions about this order?</h2>
        <p><a href="${r}contact/">Contact NoBull support</a> with your purchase email and order number. Never send card details or an access link.</p>
      </aside>
    </section>
  </main>
</div>`,
};