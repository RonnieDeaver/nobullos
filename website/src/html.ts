// Shared layout + partial helpers for the NoBull Marketing static site
// generator. Every page is emitted as `<path>/index.html` with PURE RELATIVE
// links so the same bundle works served at the domain root
// (nobullmarketing.com/) AND under the /website-preview/ prefix on the OS
// hosts. Never emit a root-absolute ("/about/") internal link here.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { imageDims } from "./imageSize";

export interface PageDef {
  /** Directory-style path relative to site root: "" | "about/" | "resource/<slug>/" */
  path: string;
  /** <title> text */
  title: string;
  /** meta description */
  desc: string;
  bodyClass?: string;
  /** Nav item to highlight */
  active?: "about" | "resources" | "demo";
  /** Renders the page's main content. `r` is the relative prefix to site root. */
  render: (r: string) => string;
  /** sitemap priority (default 0.7) */
  priority?: string;
  /**
   * Override the computed relative prefix. Used by the 404 page, which is
   * emitted with a literal `{{BASE}}` placeholder that the server replaces
   * with the correct base href ("/" or "/website-preview/") at serve time,
   * because a 404 can be rendered at any URL depth.
   */
  rOverride?: string;
  /**
   * false → the page renders its OWN header/footer/main inside render() and
   * skips the shared chrome AND site.css/site.js/vimeo overlay entirely
   * (used by the redesigned homepage, which is fully self-styled).
   */
  chrome?: boolean;
  /** Extra tags appended to <head> (page-specific fonts/CSS/preloads). */
  headExtra?: (r: string) => string;
  /** Extra tags appended just before </body> (page-specific JS). */
  bodyEnd?: (r: string) => string;
  /**
   * Absolute https URL for this page's og:image/twitter:image. Unset pages
   * fall back to the sitewide DEFAULT_OG_IMAGE — set this whenever a page
   * has its own representative image (e.g. an article's full-resolution
   * photo) instead of the generic sitewide default.
   */
  image?: string;
  /**
   * Overrides the path used to build `<link rel="canonical">` and the
   * WebPage/og:url JSON-LD `url` (relative to SITE_ORIGIN, e.g. "privacy/").
   * Used by legacy URLs that must keep resolving with their own content but
   * should point search engines at the current canonical URL instead of
   * themselves (duplicate-content dedup without moving or redirecting the
   * page).
   */
  canonicalPath?: string;
  /**
   * ISO date (YYYY-MM-DD) for this page's sitemap `<lastmod>` — set this
   * for pages with a real authored date (e.g. an article's publish date).
   * Pages that don't set one get a git-history-derived date computed in
   * website/generate.ts (last commit that touched the page's known source
   * files) instead of a fabricated "now" — regenerating the bundle on a
   * later day must never change an unmodified page's lastmod.
   */
  lastmod?: string;
  /**
   * Extra JSON-LD objects appended after the sitewide Organization/WebPage/
   * BreadcrumbList blocks every page already gets from layout() — e.g.
   * Article schema on resource pages. `r` is the same relative-root prefix
   * passed to render().
   */
  jsonLd?: (r: string) => Record<string, unknown>[];
}

export const SITE_ORIGIN = "https://nobullmarketing.com";
export const CALENDLY_URL =
  "https://calendly.com/jmangle-nobullmarketing/high-impact-revenue-session-other";
export const AMAZON_BOOK_URL =
  "https://www.amazon.com/Revenue-Engineering-Law-Firms-Skyrocket-ebook/dp/B0DPXYCGKK?ref_=ast_author_dp";
export const AUDIBLE_BOOK_URL =
  "https://www.amazon.com/Revenue-Engineering-Law-Firms-Skyrocket/dp/B0DRWC53C9/ref=tmm_aud_swatch_0?_encoding=UTF8";
export const FACEBOOK_URL = "https://www.facebook.com/BSfreeMarketing";
export const LINKEDIN_URL = "https://www.linkedin.com/company/nobull-marketing1/";

/** Absolute-URL upload path (SITE_ORIGIN + /assets/uploads/…) for contexts
    that require an absolute URL (meta tags, JSON-LD) rather than the
    relative-to-page-root form `up()` produces for in-page links. */
export function absoluteUpload(rest: string): string {
  return `${SITE_ORIGIN}/assets/uploads/${rest}`;
}

/**
 * Sitewide default og:image/twitter:image — a ~1200x630 crop of the
 * approved homepage hero art (scripts/generate-marketing-hero-variants.ts),
 * replacing the old WordPress background image every page used to share.
 * Pages with their own representative image (e.g. articles) set
 * `PageDef.image` instead.
 */
export const DEFAULT_OG_IMAGE = `${SITE_ORIGIN}/nobull-redesign/brand/og-social-default.jpg`;

/** Relative prefix from a page path back to the site root. */
// Content-hash cache-buster appended to css/js URLs. Static serving caches
// non-HTML assets for a day, so without this a design tweak would serve
// stale styles until the cache expires. Set by generate.ts before rendering.
let ASSET_VERSION = "";
export function setAssetVersion(v: string): void {
  ASSET_VERSION = v;
}
function assetSuffix(): string {
  return ASSET_VERSION ? `?v=${ASSET_VERSION}` : "";
}
/** Public cache-buster suffix for page-specific assets (home.css/home.js). */
export function assetV(): string {
  return assetSuffix();
}

export function relPrefix(path: string): string {
  const depth = path.split("/").filter(Boolean).length;
  return "../".repeat(depth);
}

export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const PUBLIC_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "public",
);

/**
 * ` width="…" height="…"` attribute pair for an image in the bundle, read
 * from the file itself at generate time. Lazy-loaded images need intrinsic
 * dimensions so the browser reserves their box before they load (no CLS).
 * Empty string when the file is missing/unparsable — never guesses.
 */
export function dimsAttr(publicRelPath: string): string {
  const d = imageDims(path.join(PUBLIC_DIR, publicRelPath));
  return d ? ` width="${d.width}" height="${d.height}"` : "";
}

/** Path to a wp-content upload mirrored under assets/uploads/. */
export function up(r: string, rest: string): string {
  return `${r}assets/uploads/${rest}`;
}

/**
 * Mobile WebP derivatives of the heaviest subpage uploads (Task #3800,
 * extending the homepage-only Task #3795 pattern). Keys are upload paths as
 * used with `up()`; values name the derivative emitted next to the source by
 * scripts/generate-marketing-hero-variants.ts (which imports this manifest —
 * single source of truth). Derivatives are DERIVED from the same approved
 * art, never redrawn; desktop keeps the original file untouched.
 */
export const UPLOAD_MOBILE_VARIANTS: {
  source: string;
  out: string;
  /** Resize target; omitted = keep source resolution, re-encode only. */
  width?: number;
  quality: number;
}[] = [
  // About "our work" photo: 714px source, phone column renders well below.
  {
    source: "2023/12/about-our-work-min.png.webp",
    out: "2023/12/about-our-work-min-mobile.webp",
    width: 560,
    quality: 75,
  },
  // Article inline feature photos: 747px JPEGs inside the prose column,
  // which is narrower than 560 CSS px on phones.
  { source: "2024/01/feat-img-boost-sales.jpg", out: "2024/01/feat-img-boost-sales-mobile.webp", width: 560, quality: 75 },
  {
    source: "2024/01/feat-img-5-star-google-reviews.jpg",
    out: "2024/01/feat-img-5-star-google-reviews-mobile.webp",
    width: 560,
    quality: 75,
  },
  { source: "2024/01/feat-img-local-seo.jpg", out: "2024/01/feat-img-local-seo-mobile.webp", width: 560, quality: 75 },
];

/**
 * All-widths WebP re-encodes of uploads (Task #3833). Unlike
 * UPLOAD_MOBILE_VARIANTS these are not <picture> mobile swaps: the derivative
 * REPLACES the source path in content (e.g. the article thumb in
 * website/content/articles/index.json) so every viewport gets the smaller
 * file. Regenerated by scripts/generate-marketing-hero-variants.ts; derived
 * from the same approved art, never redrawn.
 */
export const UPLOAD_ALLWIDTH_VARIANTS: {
  source: string;
  out: string;
  /** Resize target; omitted = keep source resolution, re-encode only. */
  width?: number;
  quality: number;
}[] = [
  // Resources/About news-grid thumbnail: 400x250 PNG (~30KB) vs ~13KB WebP
  // of the same art; served at 400x250 to ALL widths.
  {
    source: "2024/01/Brita-Long-Podcast-Art-400x250.png",
    out: "2024/01/Brita-Long-Podcast-Art-400x250.png.webp",
    quality: 80,
  },
];
export const INDUSTRIES = [
  "Bankruptcy Law",
  "Criminal Law",
  "Environment Law",
  "Family Law",
  "Health Law",
  "Immigration Law",
  "Real Estate Law",
  "International Law",
  "Entertainment Law",
  "Personal Injury Law",
  "Estate Planning / Elder Law",
  "Intellectual Property Law",
  "Labor (Employment) Law",
  "Tax Law",
];

// Shared subpage chrome — same nb-* design language as the redesigned
// homepage (website/src/pages/home.ts). Homepage-only anchors (#system,
// #proof, #book) and the component-stage footer anchors (#casegen,
// #caseintake, #caseconvert) are linked THROUGH the homepage so they resolve
// from any depth.
export function skipLink(): string {
  return '<a class="nb-skip-link" href="#main">Skip to main content</a>';
}

export function header(r: string, active?: PageDef["active"]): string {
  const a = (k: string) => (active === k ? ' class="is-active"' : "");
  return `
<header class="nb-header">
  <div class="nb-wrap nb-nav">
    <a href="${r || "./"}" aria-label="NoBull Marketing home">
      <img class="nb-logo" src="${r}nobull-redesign/brand/nobull-logo-full-color.svg" alt="NoBull Marketing — The Law Firm Experts" width="156" height="37">
    </a>
    <nav id="nb-menu" class="nb-links" aria-label="Main navigation">
      <a href="${r}about/#practice-areas-served">Practice Areas Served</a>
      <a href="${r}#proof">Results</a>
      <a href="${r}about/"${a("about")}>About</a>
      <a href="${r}resources/"${a("resources")}>Resources</a>
      <a class="nb-btn nb-menu-cta" href="${r}#booking">Book a High Impact Revenue Session <span aria-hidden="true">→</span></a>
      <a class="nb-btn-outline nb-menu-book" href="${r}free-chapters/">Read the Book <span aria-hidden="true">→</span></a>
    </nav>
    <!-- Book secondary (Task #5017): outlined "Read the Book" beside the
         session ask — desktop slot width-gated in site.css, the hamburger
         menu twin carries it at collapsed widths. Mirrors home.ts. -->
    <a class="nb-btn-outline nb-nav-book" href="${r}free-chapters/">Read the Book <span aria-hidden="true">→</span></a>
    <a class="nb-btn nb-nav-cta" href="${r}#booking">Book a High Impact Revenue Session <span aria-hidden="true">→</span></a>
    <button class="nb-nav-toggle" type="button" aria-label="Open menu" aria-expanded="false" aria-controls="nb-menu">
      <span aria-hidden="true"></span><span aria-hidden="true"></span><span aria-hidden="true"></span>
    </button>
  </div>
</header>`;
}

export function footer(r: string): string {
  return `
<footer class="nb-footer">
  <div class="nb-wrap">
    <div class="nb-footer-grid">
      <div>
        <img class="nb-logo" src="${r}nobull-redesign/brand/nobull-logo-reverse.svg" alt="NoBull Marketing" width="156" height="37">
        <!-- Footer conversion pair: the filled session action is primary and
             the outlined book action is secondary. Mirrors home.ts. -->
        <div class="nb-footer-actions">
          <a class="nb-btn nb-footer-session" href="${r}#booking">Book a High Impact Revenue Session <span aria-hidden="true">→</span></a>
          <a class="nb-btn-outline nb-footer-book" href="${r}free-chapters/">Read the Book <span aria-hidden="true">→</span></a>
        </div>
        <div class="nb-footer-social">
          <a href="${FACEBOOK_URL}" target="_blank" rel="noopener" aria-label="NoBull Marketing on Facebook"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M13.5 21v-8h2.7l.4-3.1h-3.1V7.9c0-.9.25-1.5 1.55-1.5h1.65V3.6c-.3-.04-1.3-.12-2.45-.12-2.4 0-4.05 1.46-4.05 4.15v2.27H7.5V13h2.7v8h3.3z"/></svg></a>
          <a href="${LINKEDIN_URL}" target="_blank" rel="noopener" aria-label="NoBull Marketing on LinkedIn"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6.94 8.6H3.6V20.4h3.34V8.6zM5.27 7.17a1.94 1.94 0 100-3.87 1.94 1.94 0 000 3.87zM20.4 13.92c0-3.1-1.65-4.54-3.85-4.54-1.78 0-2.57.98-3.02 1.66V8.6h-3.35c.05.94 0 11.8 0 11.8h3.35v-6.59c0-.35.02-.7.13-.96.28-.7.92-1.43 2-1.43 1.4 0 1.97 1.07 1.97 2.64v6.34h3.37v-6.48z"/></svg></a>
        </div>
      </div>
      <div>
        <h4>OUR SERVICES</h4>
        <a href="${r}#system">The Revenue Engine\u2122</a>
        <a href="${r}#casegen">CaseGen\u2122</a>
        <a href="${r}#caseintake">CaseIntake\u2122</a>
        <a href="${r}#caseconvert">CaseConvert\u2122</a>
      </div>
      <div>
        <h4>COMPANY</h4>
        <a href="${r}about/">About NoBull</a>
        <a href="${r}#proof">Results</a>
        <a href="${r}#contact">Contact</a>
      </div>
      <div>
        <h4>RESOURCES</h4>
        <a href="${r}#book">The Book</a>
        <a href="${r}calculator/">REE Calculator</a>
        <a href="${r}resources/">Articles</a>
        <a href="${r}resources/">Webinars</a>
      </div>
    </div>
    <div class="nb-footer-bottom">© 2026 NoBull Marketing. All rights reserved. · <a href="${r}privacy/">Privacy</a> · <a href="${r}terms/">Terms</a> · <a href="${r}shipping-returns/">Shipping &amp; Returns</a></div>
  </div>
</footer>`;
}

/** Editorial subpage hero — eyebrow + gold rule + Crimson Pro display h1
    (the homepage's section-opener language; replaced the crimson band). */
export function titleBand(
  h1: string,
  sub?: string,
  opts?: { align?: "left" | "center"; eyebrow?: string },
): string {
  const left = opts?.align === "left";
  const eyebrow = opts?.eyebrow ?? "NoBull Marketing";
  return `
<section class="page-hero${left ? " band-left" : ""}">
  <div class="container">
    <p class="nb-eyebrow${left ? "" : " nb-eyebrow-center"}"><span class="nb-rule" aria-hidden="true"></span>${eyebrow}${left ? "" : `<span class="nb-rule" aria-hidden="true"></span>`}</p>
    <h1>${h1}</h1>${sub ? `\n    <p class="band-sub">${sub}</p>` : ""}
  </div>
</section>`;
}

/** Subpage call-to-action that returns to the homepage's canonical scheduler. */
export function bookingBand(
  r: string,
  opts?: { chevron?: boolean; heading?: string },
): string {
  const heading = opts?.heading ?? "Book a High Impact Revenue Session";
  return `
<section class="demo-band">
  <div class="container">
    <p class="nb-eyebrow nb-eyebrow-center"><span class="nb-rule" aria-hidden="true"></span>The Next Step<span class="nb-rule" aria-hidden="true"></span></p>
    <h2 class="serif-soft">${heading}</h2>
    <p class="section-sub">Pick a time that works for your firm \u2014 one conversation about your marketing, intake, and sales.</p>
    <a class="btn" href="${r}#booking">Book a High Impact Revenue Session</a>
  </div>
</section>${opts?.chevron === false ? "" : `\n<div class="chev" aria-hidden="true"></div>`}`;
}

export interface ArticleCard {
  slug: string;
  title: string;
  date: string;
  cat: string;
  thumb: string;
  excerpt: string;
}

export function articleCard(r: string, a: ArticleCard): string {
  const thumb = a.thumb.replace("__UPLOADS__/", `${r}assets/uploads/`);
  return `
      <article class="news-card" data-cat="${esc(a.cat)}">
        <a class="news-thumb" href="${r}resource/${a.slug}/"><img loading="lazy" src="${thumb}" alt="${esc(a.title)}" width="400" height="250"></a>
        <div class="news-body">
          <h3><a href="${r}resource/${a.slug}/">${esc(a.title)}</a></h3>
          <p class="news-meta">${esc(a.date)} | ${esc(a.cat)}</p>
          <p class="news-excerpt">${esc(a.excerpt)}</p>
        </div>
      </article>`;
}

/** Reusable "Recent News" grid section. */
export function recentNews(r: string, articles: ArticleCard[], count: number): string {
  return `
<section class="section news-section">
  <div class="container text-center">
    <p class="nb-eyebrow nb-eyebrow-center"><span class="nb-rule" aria-hidden="true"></span>From The Library<span class="nb-rule" aria-hidden="true"></span></p>
    <h2 class="serif-soft">Recent News</h2>
    <p class="section-sub">Revenue playbooks, intake tactics, and marketing insights for law firms.</p>
    <div class="news-grid">
${articles.slice(0, count).map((a) => articleCard(r, a)).join("\n")}
    </div>
  </div>
</section>`;
}

// ---------------------------------------------------------------------------
// JSON-LD structured data (docs/DO_NOT_BREAK.md §13 — WebPage + Organization
// + BreadcrumbList gap vs the old WordPress site). Organization + WebPage
// are emitted sitewide by layout(); BreadcrumbList is derived generically
// from the page's own path; Article schema is supplied per-page via
// PageDef.jsonLd (see website/src/pages/article.ts).
// ---------------------------------------------------------------------------

const ORGANIZATION_JSON_LD: Record<string, unknown> = {
  "@context": "https://schema.org",
  "@type": "Organization",
  name: "NoBull Marketing",
  url: `${SITE_ORIGIN}/`,
  logo: `${SITE_ORIGIN}/nobull-redesign/brand/nobull-logo-full-color.svg`,
  sameAs: [FACEBOOK_URL, LINKEDIN_URL],
};

function webPageJsonLd(p: PageDef, canonical: string): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: p.title,
    description: p.desc,
    url: canonical,
    isPartOf: { "@type": "WebSite", name: "NoBull Marketing", url: `${SITE_ORIGIN}/` },
  };
}

/** Readable label overrides for path segments whose directory name doesn't
    match the page a visitor actually lands on (e.g. articles live under the
    singular "resource/" directory but the real listing page is "resources/"),
    or that need better casing than a hyphen-to-title-case pass gives. */
const BREADCRUMB_SEGMENT_LABELS: Record<string, string> = {
  resource: "Resources",
  book: "The Book",
  "free-chapters": "Free Chapters",
  "data-notes": "Data Notes",
  "shipping-returns": "Shipping & Returns",
  "privacy-policy": "Privacy Policy",
  "order-status": "Order Status",
};

function segmentLabel(seg: string): string {
  return (
    BREADCRUMB_SEGMENT_LABELS[seg] ??
    seg.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

/** Strips a trailing " - NoBull Marketing" / " | NoBull Marketing" /
    " — NoBull Marketing" site-name suffix for a clean breadcrumb label;
    titles without that suffix pattern are used as-is. */
function breadcrumbPageName(title: string): string {
  return title.replace(/\s*[-|\u2014]\s*NoBull Marketing\s*$/, "").trim();
}

/**
 * BreadcrumbList JSON-LD derived from the page's own URL path — every
 * non-homepage page gets one. The special-cased "resource" segment points
 * at the real "resources/" listing page (there is no bare "resource/" page)
 * while the accumulated path used for later segments still follows the
 * real URL structure.
 */
function breadcrumbJsonLd(p: PageDef): Record<string, unknown> | null {
  const segments = p.path.split("/").filter(Boolean);
  if (segments.length === 0) return null; // homepage is the root — no breadcrumb
  const items: { name: string; url: string }[] = [{ name: "Home", url: `${SITE_ORIGIN}/` }];
  let acc = "";
  segments.forEach((seg, i) => {
    const isLast = i === segments.length - 1;
    acc = acc ? `${acc}/${seg}` : seg;
    if (seg === "resource" && !isLast) {
      items.push({ name: "Resources", url: `${SITE_ORIGIN}/resources/` });
      return;
    }
    items.push({
      name: isLast ? breadcrumbPageName(p.title) : segmentLabel(seg),
      url: `${SITE_ORIGIN}/${acc}/`,
    });
  });
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: item.name,
      item: item.url,
    })),
  };
}

/** Serializes a JSON-LD object into a <script> tag, escaping "<" so an
    unexpected "</script>" inside string content can't prematurely close
    the tag. */
function jsonLdScript(obj: Record<string, unknown>): string {
  return `<script type="application/ld+json">${JSON.stringify(obj).replace(/</g, "\\u003c")}</script>`;
}

export function layout(p: PageDef): string {
  const r = p.rOverride ?? relPrefix(p.path);
  const canonicalPath = p.canonicalPath ?? p.path;
  const canonical = `${SITE_ORIGIN}/${canonicalPath}`;
  const ogImage = p.image ?? DEFAULT_OG_IMAGE;
  const jsonLdBlocks: Record<string, unknown>[] = [ORGANIZATION_JSON_LD, webPageJsonLd(p, canonical)];
  const breadcrumb = breadcrumbJsonLd(p);
  if (breadcrumb) jsonLdBlocks.push(breadcrumb);
  if (p.jsonLd) jsonLdBlocks.push(...p.jsonLd(r));
  const jsonLdTags = jsonLdBlocks.map(jsonLdScript).join("\n");
  const bare = p.chrome === false;
  const body = bare
    ? `${p.render(r)}`
    : `${skipLink()}
${header(r, p.active)}
<main id="main" tabindex="-1">
${p.render(r)}
</main>
${footer(r)}
<script src="${r}assets/js/site.js${assetSuffix()}" defer></script>`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(p.title)}</title>
<meta name="description" content="${esc(p.desc)}">
<link rel="canonical" href="${canonical}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="NoBull Marketing">
<meta property="og:title" content="${esc(p.title)}">
<meta property="og:description" content="${esc(p.desc)}">
<meta property="og:url" content="${canonical}">
<meta property="og:image" content="${ogImage}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${ogImage}">
<link rel="icon" href="${up(r, "2023/12/NoBull-Marketing-The-Law-Firm-Experts-Favicon.png")}" sizes="32x32">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Crimson+Pro:ital,wght@0,400;0,500;0,600;0,700;1,400;1,600&display=swap" rel="stylesheet">${bare ? "" : `
<link rel="preconnect" href="https://use.typekit.net" crossorigin>
<link rel="stylesheet" href="https://use.typekit.net/hve0rhv.css">
<link rel="stylesheet" href="${r}assets/css/site.css${assetSuffix()}">`}${p.headExtra ? p.headExtra(r) : ""}
${jsonLdTags}
</head>
<body${p.bodyClass ? ` class="${p.bodyClass}"` : ""}>
${body}${p.bodyEnd ? p.bodyEnd(r) : ""}
</body>
</html>`;
}

/**
 * `<img>` for an upload, wrapped in a `<picture>` with the mobile WebP
 * derivative when one is registered in UPLOAD_MOBILE_VARIANTS. `attrs` is
 * raw attribute text (` loading="lazy" alt="…"`); intrinsic width/height
 * come from the source file so the box is reserved at every width.
 */
export function uploadImg(r: string, rest: string, attrs: string): string {
  const img = `<img src="${up(r, rest)}"${attrs}${dimsAttr(`assets/uploads/${rest}`)}>`;
  const mobile = MOBILE_VARIANT_BY_SOURCE.get(rest);
  if (!mobile) return img;
  return `<picture><source media="${MOBILE_IMG_MEDIA}" type="image/webp" srcset="${up(r, mobile)}">${img}</picture>`;
}

/** Same breakpoint the homepage hero uses for its mobile art swap. */
export const MOBILE_IMG_MEDIA = "(max-width: 850px)";

/**
 * Wraps `<img>` tags inside pre-rendered article HTML (already rewritten
 * from __UPLOADS__/ to real paths) in `<picture>` mobile-variant swaps for
 * any upload registered in UPLOAD_MOBILE_VARIANTS. Tags keep their original
 * attributes; unmatched images pass through untouched.
 */
export function upgradeBodyImages(r: string, body: string): string {
  const prefix = `${r}assets/uploads/`;
  return body.replace(/<img\b[^>]*>/g, (tag) => {
    const src = tag.match(/\bsrc="([^"]+)"/);
    if (!src || !src[1].startsWith(prefix)) return tag;
    const mobile = MOBILE_VARIANT_BY_SOURCE.get(src[1].slice(prefix.length));
    if (!mobile) return tag;
    return `<picture><source media="${MOBILE_IMG_MEDIA}" type="image/webp" srcset="${up(r, mobile)}">${tag}</picture>`;
  });
}

const MOBILE_VARIANT_BY_SOURCE = new Map(UPLOAD_MOBILE_VARIANTS.map((v) => [v.source, v.out]));
