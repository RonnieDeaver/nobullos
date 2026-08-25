import { ArticleCard, PageDef, esc, titleBand, upgradeBodyImages } from "../html";

export interface ArticleFull extends ArticleCard {
  bodyHtml: string;
  metaDesc: string;
}

function normalizeImportedPodcastBody(base: string, bodyHtml: string): string {
  return bodyHtml
    .replace(
      /<h2>\s*(<a href="\/resource\/episode-[^"]+\/">[\s\S]*?<\/a>)\s*<\/h2>/gi,
      "<h3>\n$1\n</h3>",
    )
    .replace(
      /<h4>\s*Recent Episodes\s*<\/h4>/gi,
      "<h2>Recent Episodes</h2>",
    )
    .replace(
      /href="\/resource\/(episode-[^"]+\/)"/gi,
      `href="${base}resource/$1"`,
    )
    .replace(
      /<a href="\/resource\/category\/podcasts\/">([\s\S]*?)<\/a>/gi,
      "$1",
    );
}

/**
 * Historical article imports may still name the retired conversion pages.
 * Keep their editorial copy intact while making every live generated link and
 * displayed destination resolve to the homepage conversion hub.
 */
function normalizeRetiredConversionLinks(base: string, bodyHtml: string): string {
  return bodyHtml
    .replaceAll("https://nobullmarketing.com/book-free-demo/", `${base}#booking`)
    .replaceAll("nobullmarketing.com/book-free-demo", "nobullmarketing.com/#booking")
    .replaceAll("https://nobullmarketing.com/contact/", `${base}#contact`)
    .replaceAll("nobullmarketing.com/contact", "nobullmarketing.com/#contact");
}

export function articlePage(a: ArticleFull, all: ArticleCard[]): PageDef {
  const recent = all.filter((x) => x.slug !== a.slug).slice(0, 3);
  return {
    path: `resource/${a.slug}/`,
    title: `${a.title} - NoBull Marketing`,
    desc: a.metaDesc,
    priority: "0.5",
    render: (r) => {
      const importedBody =
        a.cat === "Podcasts"
          ? normalizeImportedPodcastBody(r, a.bodyHtml)
          : a.bodyHtml;
      const body = upgradeBodyImages(
        r,
        normalizeRetiredConversionLinks(r, importedBody).replace(
          /__UPLOADS__\//g,
          `${r}assets/uploads/`,
        ),
      );
      return `
${titleBand(esc(a.title), undefined, { align: "left", eyebrow: `${esc(a.date)} &nbsp;\u00b7&nbsp; ${esc(a.cat)}` })}

<section class="article-wrap">
  <div class="container article-cols">
    <article class="prose">
${body}
    </article>
    <aside class="sidebar">
      <h3>Recent Resources</h3>
${recent
  .map(
    (x) => `      <div class="side-item">
        <a href="${r}resource/${x.slug}/">${esc(x.title)}</a>
        <p class="news-meta">${esc(x.date)} | ${esc(x.cat)}</p>
      </div>`,
  )
  .join("\n")}
      <div class="side-calc">
        <h3>Score Your Revenue Engine</h3>
        <p>Choose a 3-, 6-, or 12-month reporting period. See your REE and the dollar value of a 10% improvement in each available direct lever. Free, no email required.</p>
        <a class="side-calc-link" href="${r}calculator/">Calculate your REE <span aria-hidden="true">→</span></a>
      </div>
      <p style="margin-top:26px"><a class="btn btn-sm" href="${r}#booking">Book a High Impact Revenue Session</a></p>
    </aside>
  </div>
</section>`;
    },
  };
}
