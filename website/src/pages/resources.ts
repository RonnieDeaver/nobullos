import { ArticleCard, PageDef, articleCard, bookingBand, titleBand } from "../html";

const TABS = ["All", "Articles", "Videos", "Webinars", "Podcasts"];

export function resourcesPage(articles: ArticleCard[]): PageDef {
  return {
    path: "resources/",
    title: "Law Firm Revenue Library | NoBull Marketing",
    desc:
      "Articles, videos, webinars, and podcasts on law firm marketing, intake, and sales \u2014 the thinking behind The Law Firm Revenue Engine\u2122.",
    active: "resources",
    render: (r) => `
${titleBand("Resources", "Articles, videos, webinars, and podcasts on marketing, intake, and sales \u2014 the thinking behind the Revenue Engine.", { eyebrow: "The Library" })}

<section class="res-section">
  <div class="container">
    <h2>Latest Articles &amp; Webinars</h2>
    <div class="res-tabs" role="tablist" aria-label="Filter resources by category">
${TABS.map((t, i) => `      <button type="button" data-cat="${t}"${i === 0 ? ' class="on"' : ""}>${t}</button>`).join("\n")}
    </div>
    <div class="news-grid">
${articles.map((a) => articleCard(r, a)).join("\n")}
    </div>
  </div>
</section>

<section class="res-calc">
  <div class="container">
    <p class="nb-eyebrow nb-eyebrow-center"><span class="nb-rule" aria-hidden="true"></span>Start With Your Score<span class="nb-rule" aria-hidden="true"></span></p>
    <h2 class="serif-soft">How Hard Does Your $1 Work?</h2>
    <p class="section-sub">The REE calculator turns your 3-, 6-, or 12-month totals into your score and the dollar value of a 10% improvement in each available direct lever. Free, no email required.</p>
    <a class="nb-text-btn" href="${r}calculator/">CALCULATE YOUR REE <span aria-hidden="true">→</span></a>
  </div>
</section>

${bookingBand(r, { chevron: false })}`,
  };
}
