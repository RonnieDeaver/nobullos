// Client bundle for the marketing-site SUBPAGES — every page rendered with
// the shared chrome in website/src/html.ts (about/, resources/,
// resource/<slug>/, calculator/, privacy-policy/, privacy/, terms/, shipping-returns/,
// unsubscribe/, and the 404 page). Bundled by website/generate.ts (esbuild,
// iife, minified) into website/public/assets/js/site.js.
//
// site.js used to be a hand-authored file duplicating the homepage bundle's
// mobile-nav and inquiry-form logic under a diverging contract; PR5 retired
// it. Nav + inquiry now compile from the SAME shared modules home.js uses
// (website/src/client-shared/), so lead-capture behavior cannot drift between
// the two page classes again. The resources category tabs below are the
// remaining subpage-only behavior carried over from the old file.

import { captureAttribution } from "../client-shared/attribution";
import { initInquiryForms } from "../client-shared/inquiry";
import { initMobileNav } from "../client-shared/nav";
import { initReeHandoffPrefill } from "../client-shared/reeHandoff";

/* ----- resources category tabs ----- */

function initResourceTabs(): void {
  const tabs = document.querySelectorAll<HTMLButtonElement>(".res-tabs button");
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((other) => other.classList.remove("on"));
      tab.classList.add("on");
      const cat = tab.getAttribute("data-cat");
      document.querySelectorAll<HTMLElement>(".news-card").forEach((card) => {
        card.classList.toggle(
          "hidden",
          cat !== "All" && card.getAttribute("data-cat") !== cat,
        );
      });
    });
  });
}

function init(): void {
  // Persist immutable first touch and refresh latest touch only when this
  // navigation has a real campaign or external-referrer signal.
  captureAttribution();
  initMobileNav();
  initInquiryForms();
  initResourceTabs();
  initReeHandoffPrefill();
}

// The script tag is emitted with `defer`, so the DOM is parsed by the time
// this runs; the readyState guard keeps direct/async loads correct too.
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
