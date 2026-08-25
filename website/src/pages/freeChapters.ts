// /free-chapters/ — the on-site excerpt reader (Task #3920).
//
// Owner-approved promotion: "Get the first 2 chapters free", served as a real
// on-site reader — Introduction + Chapters 1-2 verbatim, readable immediately,
// deliberately NO email gate (owner declined lead capture). Content comes from
// website/content/book-excerpt.json, imported from the manuscript DOCX by
// scripts/extract-book-excerpt.ts — never hand-edit the chapter text here.
//
// Two layers, kept apart on purpose: the reading layer is warm paper +
// Crimson Pro long-form serif (the site's editorial voice at book scale); the
// conversion layer speaks the homepage book band's dark language and runs the
// owner's book funnel (Task #4262, owner doc §3): the endcap after the last
// chapter leads with the leak-diagnosis session ask — "You've seen how the
// Revenue Engine works. Now see where yours is leaking." → Book a High Impact
// Revenue Session — and demotes the full-book push to a labeled secondary
// block (Amazon/Audible coming-soon state via src/bookLinks.ts until canonical
// product destinations exist); the floating bottom bar now uses the
// sitewide "Book a High Impact Revenue Session" prompt (→ homepage #booking),
// with quiet full-book links only on roomier screens. body.fc-body reserves
// bottom padding so the bar never covers the text being read. Styles: the
// fc-* block in assets/css/site.css.

import { PageDef, dimsAttr, esc, titleBand } from "../html";
import { BOOK_STORES, BOOK_STORE_STATUS } from "../bookLinks";

export interface BookExcerptChapter {
  id: string;
  kicker: string;
  title: string;
  nav: string;
  bodyHtml: string;
}

export interface BookExcerpt {
  bookTitle: string;
  author: string;
  chapters: BookExcerptChapter[];
  whatsNext: { n: number; title: string }[];
}

const ARROW = `<span aria-hidden="true">→</span>`;

export function freeChaptersPage(x: BookExcerpt): PageDef {
  return {
    path: "free-chapters/",
    title: "Read the First 2 Chapters Free - The Law Firm Revenue Engine - NoBull Marketing",
    desc: "Read the Introduction and first two chapters of The Law Firm Revenue Engine by Ronnie Deaver, free — no email required. How Marketing, Intake, and Sales become one machine that turns leads into signed cases.",
    priority: "0.8",
    bodyClass: "fc-body",
    render: (r) => `
${titleBand(
  "Read the First Two Chapters — Free",
  `The complete methodology behind everything NoBull installs, by founder ${esc(x.author)}. Read the Introduction and the first two chapters right here — no email required.`,
  { eyebrow: "THE LAW FIRM REVENUE ENGINE" },
)}

<section class="fc-wrap">
  <div class="container">
    <nav class="fc-toc" aria-label="Excerpt contents">
      <span class="fc-toc-label">In this excerpt</span>
${x.chapters.map((c) => `      <a href="#${c.id}">${esc(c.nav)}</a>`).join("\n")}
    </nav>

    <article class="fc-reader">
${x.chapters
  .map(
    (c) => `      <section class="fc-chapter" id="${c.id}">
        <header class="fc-chapter-head">
          <p class="fc-kicker">${esc(c.kicker)}</p>
          <h2>${esc(c.title)}</h2>
        </header>
${c.bodyHtml.replace(/__R__/g, r)}
      </section>`,
  )
  .join("\n")}
    </article>

    <aside class="fc-endcap" aria-label="Apply the book to your firm, or get the full book">
      <div class="fc-endcap-cover">
        <picture><source type="image/webp" srcset="${r}nobull-redesign/brand/law-firm-revenue-engine-cover.webp"><img src="${r}nobull-redesign/brand/front-cover.jpg" alt="The Law Firm Revenue Engine — book cover" loading="lazy"${dimsAttr("nobull-redesign/brand/front-cover.jpg")}></picture>
      </div>
      <div>
        <p class="fc-endcap-kicker">End of the free excerpt</p>
        <h2>You've seen how the Revenue Engine works.<br>Now see where yours is <em>leaking</em>.</h2>
        <div class="fc-endcap-actions fc-endcap-ask">
          <a class="btn" href="${r}#booking">Book a High Impact Revenue Session</a>
          <a class="fc-calc-link" href="${r}calculator/">Calculate your Revenue Engine ${ARROW}</a>
        </div>
        <div class="fc-endcap-book">
          <p class="fc-endcap-book-label">Full book availability</p>
          <p class="fc-endcap-body">Three more chapters cover how the engine goes into your firm, how you scale it once it's running — and how to know whether you're ready.</p>
          <ul class="fc-next-list">
${x.whatsNext
  .map(
    (n) => `            <li><span class="fc-next-n">Chapter ${n.n}</span>${esc(n.title)}</li>`,
  )
  .join("\n")}
          </ul>
          <div class="fc-endcap-stores" aria-label="Book store availability">
${BOOK_STORES.map(
  ({ name, badge }) => `            <div class="fc-store-status" role="group" aria-label="${name} — ${BOOK_STORE_STATUS}">
              <img src="${r}nobull-redesign/book/${badge}" alt="" aria-hidden="true" loading="lazy"${dimsAttr(`nobull-redesign/book/${badge}`)}>
              <span>${BOOK_STORE_STATUS}</span>
            </div>`,
).join("\n")}
          </div>
        </div>
      </div>
    </aside>
  </div>
</section>

<div class="fc-bar" role="complementary" aria-label="Book a High Impact Revenue Session or check full book availability">
  <div class="container fc-bar-inner">
    <p class="fc-bar-note">You're reading the free excerpt.</p>
    <div class="fc-bar-actions">
      <span class="fc-bar-buy"><span class="fc-buy-label">Full book availability</span>
${BOOK_STORES.map(
  ({ name }) => `        <span class="fc-store-inline"><strong>${name}</strong> ${BOOK_STORE_STATUS}</span>`,
).join("\n")}
      </span>
      <a class="fc-bar-cta" href="${r}#booking">Book a High Impact Revenue Session ${ARROW}</a>
    </div>
  </div>
</div>`,
  };
}
