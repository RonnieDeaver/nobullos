import { INDUSTRIES, PageDef, bookingBand, dimsAttr, esc, titleBand, uploadImg } from "../html";
import { TEAM_ROSTER } from "../team";

// FAQ 1 carries the category positioning from the book's final editorial
// review (Task #4120): responsibility past the lead + acquisition-through-
// signed-and-paid-client scope — never an "only company in the world"
// claim (docs/website-claim-ledger.md #32). FAQ 2 stays revenue-measured
// and estimate-honest: no promise of precise attribution everywhere.
const FAQ = [
  {
    q: "How is NoBull Marketing different from other digital marketing agencies?",
    a: "Most legal marketing agencies stop taking responsibility when the lead arrives. We don\u2019t. We follow every opportunity from acquisition through signed-and-paid client \u2014 Marketing, Intake, and Sales as one measured system. We wrote the book on it, and we\u2019re honest about what\u2019s working \u2014 Noble and No B.S. aren\u2019t just the name.",
  },
  {
    q: "How do you make sure your services are effective and provide a good return on investment (ROI)?",
    a: "We measure what you measure: revenue. Lead tracking and dashboard reporting connect your Marketing, Intake, and Sales systems to the cases and dollars they produce, so you\u2019ll know where every lead \u2014 and every dollar we can attribute \u2014 came from. Where attribution has gaps, we say so rather than guess.",
  },
  {
    q: "What is the process for getting started with NoBull Marketing?",
    a: "Book a high impact revenue session through our website. It covers your goals, your current funnel \u2014 marketing, intake, and sales \u2014 and whether the engine fits your firm.",
  },
];

export function aboutPage(): PageDef {
  return {
    path: "about/",
    title: "About NoBull Marketing \u2014 Noble. No B.S.",
    desc:
      "The name NoBull comes from \u201cNoble\u201d and \u201cNo B.S.\u201d \u2014 an honest, fluff-free revenue partner for law firms. Meet the team behind The Law Firm Revenue Engine\u2122.",
    active: "about",
    render: (r) => `
${titleBand("About NoBull Marketing", "Noble in our dealings. No B.S. in our services. Your bottom line is our bottom line.", { eyebrow: "Who We Are" })}

<section class="pride">
  <div class="container pride-cols">
    <div>
      <p class="nb-eyebrow"><span class="nb-rule" aria-hidden="true"></span>Noble &amp; No B.S.</p>
      <h2>We Take Pride In Our Work</h2>
      <p>The name NoBull Marketing was inspired by combining the concepts of \u201cNoble\u201d and \u201cNo B.S.\u201d We are proud to be a marketing agency that is honorable in our business dealings and fluff-free in our services. Your bottom line is our bottom line \u2013 you can trust that we\u2019ll grow your law firm\u2019s revenue.</p>
      <div class="nb-faq">
${FAQ.map(
  (f) => `        <details class="nb-faq-item">
          <summary>${f.q}</summary>
          <p>${f.a}</p>
        </details>`,
).join("\n")}
      </div>
    </div>
    <div class="pride-img">
      ${uploadImg(r, "2023/12/about-our-work-min.png.webp", ` loading="lazy" alt="The NoBull Marketing team planning at a whiteboard"`)}
    </div>
  </div>
</section>

<section class="industries" id="practice-areas-served" aria-labelledby="practice-areas-served-heading">
  <div class="container">
    <span class="nb-label">Built For B2C Law Firms</span>
    <h2 id="practice-areas-served-heading">Practice Areas Served</h2>
    <p>Our Marketing, Intake, and Sales services are built for B2C law firms across a wide range of practices. We connect the systems that bring in qualified opportunities, move them to consultations, and help turn those consultations into signed cases.</p>
    <ul class="practice-list" aria-label="Practice areas served">
${INDUSTRIES.map((practice) => `      <li>${esc(practice)}</li>`).join("\n")}
    </ul>
  </div>
</section>

<section class="team">
  <div class="container">
    <p class="nb-eyebrow nb-eyebrow-center"><span class="nb-rule" aria-hidden="true"></span>The People<span class="nb-rule" aria-hidden="true"></span></p>
    <h2 class="nb-display">Our Dedicated Team</h2>
    <p class="section-sub">At NoBull Marketing, we harness the power of collaboration.</p>
    <div class="team-grid" aria-label="NoBull Marketing team">
${TEAM_ROSTER.map(
  (t) => `      <article class="team-card">
        <img loading="lazy" src="${r}nobull-redesign/team/${t.img}" alt="${esc(t.name)}"${dimsAttr(`nobull-redesign/team/${t.img}`)}>
        <div class="team-card-body">
          <h3>${esc(t.name)}</h3>
          <p class="team-role">${esc(t.role)}</p>${t.bio ? `
          <details class="team-bio">
            <summary>Read ${esc(t.name.split(" ")[0])}\u2019s biography</summary>
            <p>${esc(t.bio)}</p>
          </details>` : ""}
        </div>
      </article>`,
).join("\n")}
    </div>
  </div>
</section>

${bookingBand(r, { chevron: false })}`,
  };
}
