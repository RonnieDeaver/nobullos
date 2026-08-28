# Current Site Audit — nobullmarketing.com

**Audit date:** 2026-08-03  
**Live site CMS:** WordPress 7.0.2 with Divi theme + NBM v.1.0.1696187356  
**Replit-built replacement:** Static HTML generator at `website/generate.ts` → `website/public/`  
**Current implementation note (reconciled 2026-08-20):** The dated WordPress
observations below remain an audit snapshot, not current Replit requirements.
The Replit build is the canonical replacement bundle. Its current navigation
uses `Practice Areas Served` → `/about/#practice-areas-served`; About renders
the full 20-person roster and 14-item practice-area list; `/services/` is
retired with no page, sitemap entry, link, or redirect and returns the branded
404 on both host paths. The homepage/footer retain the Revenue Engine and
component destinations independently. The homepage is also the sole
booking/contact destination: `/#booking` contains the only Calendly widget and
`/#contact` contains the only contact form. `/book-free-demo/` and `/contact/`
are permanent compatibility redirects only.

---

## 1. Routes and Page Types

### Live WordPress site (nobullmarketing.com)
| URL | Page type | Notes |
|---|---|---|
| `/` | Marketing homepage | Hero, "As Seen On", systems, steps, video testimonials, Google reviews, book, payoff, closing CTA |
| `/about/` | About / team | Brand origin, FAQ accordion, team grid, industries, Calendly band, recent news |
| `/#proof` | Results (homepage anchor) | Inline case studies, testimonial videos, and written reviews; no standalone Results page |
| `/resources/` | Blog/resource index | Tab-filtered grid (All / Articles / Videos / Webinars / Podcasts), Calendly band |
| `/resource/<slug>/` | Individual article | Article prose + sidebar, 15 canonical live slugs (see §7) |
| `/book-free-demo/` | Lead capture | Calendly inline embed + contact form |
| `/privacy-policy/` | Legal | Privacy policy + Terms of Use |
| `/unsubscribe/` | Legal / opt-out | Email unsubscribe form |
| `404` | Error | Custom 404 page; server injects `{{BASE}}` placeholder at serve-time |

### Replit static build (`website/public`)
The build produces `<path>/index.html` files with **pure relative links**, so the same bundle works at the domain root and at `/website-preview/`. Results is generated only as the homepage `#proof` section; shared chrome reaches it at the correct relative depth, and `/testimonials/` is not generated or listed in the sitemap.

Current top-level generated pages are `/`, `/about/`, `/resources/`,
`/free-chapters/`, `/calculator/`, `/data-notes/`, `/privacy-policy/`, and
`/unsubscribe/`, plus the 15 `/resource/<slug>/` pages. Practice-area scope
lives only on About. `/book-free-demo/` and `/contact/` have no generated
page or sitemap row; the server permanently redirects them to `/#booking` and
`/#contact`, respectively, with safe query parameters before the fragment.

Additional server-side routes (not in HTML bundle):
| URL | Served by | Notes |
|---|---|---|
| `/sitemap.xml` | `marketingSite.ts` — dynamic | Generated from `sitemap-pages.json`; URL set to `https://nobullmarketing.com/` |
| `/robots.txt` | `marketingSite.ts` — dynamic | `User-agent: * Allow: / Sitemap: …/sitemap.xml` |
| `/website-preview/…` | `marketingSite.ts` | Serves same bundle pre-DNS; `noindex: true` injected in headers |

---

## 2. Header Navigation

### Current Replit navigation

| Item | Destination | Type |
|---|---|---|
| Logo (NoBull Marketing — The Law Firm Experts) | `/` | Image link |
| Practice Areas Served | `/about/#practice-areas-served` | Standard link to the complete 14-item About section |
| Results | `/#proof` | Homepage anchor (relative-root anchor from subpages/articles) |
| About | `/about/` | Standard link |
| Resources | `/resources/` | Standard link |
| Book a High Impact Revenue Session | `/#booking` | Primary CTA |
| Read the Book | `/free-chapters/` | Secondary CTA; desktop slot or collapsed menu |
| Mobile nav toggle | — | Hamburger button (`aria-expanded`) |

The 2026-08-03 WordPress dropdown and its old label are historical only. The
current Replit header has no practice-area dropdown.

**Logo assets used:**
- Header: `assets/uploads/2023/12/NoBull-Marketing-The-Law-Firm-Experts-Logo.svg` (width=150, height=46)
- Footer: `assets/uploads/2023/12/NoBull-Marketing-The-Law-Firm-Experts-Logo-2.svg` (width=170, height=52)
- WordPress live: `wp-content/uploads/2023/12/NoBull-Marketing-The-Law-Firm-Experts-Logo.svg`

---

## 3. Footer Navigation

| Section | Contents |
|---|---|
| Brand | Footer logo variant, Facebook, LinkedIn, and outlined Read the Book link |
| Our Services | The Revenue Engine™ → `/#system`; CaseGen™ → `/#casegen`; CaseIntake™ → `/#caseintake`; CaseConvert™ → `/#caseconvert` |
| Company | About NoBull, Results, Contact, and Book a High Impact Revenue Session (the homepage intentionally omits the session text link) |
| Resources | The Book, Revenue/REE Calculator, Articles, Webinars |
| Legal bar | © 2026 NoBull Marketing, All rights reserved · Terms of Use/Privacy Policy → `/privacy-policy/` |

**Social links:**
- Facebook: `https://www.facebook.com/BSfreeMarketing`
- LinkedIn: `https://www.linkedin.com/company/nobull-marketing1/`

---

## 4. Product Names and Retired Services-Page Snapshot

The following names describe the audited 2026-08-03 WordPress/pre-overhaul
state and are not current Replit architecture. The standalone services page
and its Google-playbook presentation are retired. Current product explanation
lives in the homepage Revenue Engine funnel.

**Historical core system branding:**
- **Revenue Engineering System for Law Firms** (formerly: Elite Business Development System)
  - System #1: **Marketing Mastery**
  - System #2: **Perfect Intake**
  - System #3: **Sales Blueprint**

**Historical three-service presentation:**
1. **Google My Business** — local lead generation / GMB optimization
2. **Google Ads** — paid search / PPC
3. **Monthly Webinars** — lead generation + review generation + social content

**Book:**
- Title: *Revenue Engineering for Law Firms* (Skyrocket…)
- Author: Ronnie Deaver
- Amazon: `https://www.amazon.com/Revenue-Engineering-Law-Firms-Skyrocket-ebook/dp/B0DPXYCGKK`
- Audible: `https://www.amazon.com/Revenue-Engineering-Law-Firms-Skyrocket/dp/B0DRWC53C9/`

---

## 5. Calls to Action

| CTA label | Destination | Frequency |
|---|---|---|
| Book a High Impact Revenue Session | `/#booking` | Sitewide primary CTA |
| Read the Book | `/free-chapters/` | Persistent secondary CTA |
| Practice Areas Served | `/about/#practice-areas-served` | Header link at every page depth |
| Contact | `/#contact` | Footer/company destination |
| Buy on Amazon | AMAZON_BOOK_URL | Homepage book band |
| Listen on Audible | AUDIBLE_BOOK_URL | Homepage book band |

---

## 6. Forms, Booking Links, Phone, Email

### Calendly booking
- **URL:** `https://calendly.com/jmangle-nobullmarketing/high-impact-revenue-session-other`
- **Appears on:** homepage `#booking` only (inline embed, height 760px); subpage booking bands link back to it
- **Script:** `https://assets.calendly.com/assets/external/widget.js` (loaded async)
- **Recovery:** the adjacent `Open Calendly directly →` link remains usable if the embed is blocked on a preview host

### Contact form (homepage `#contact`)
| Field | Type | Required | Notes |
|---|---|---|---|
| Full Name | text | ✅ | autocomplete=name, maxlength=200 |
| Email Address | email | ✅ | autocomplete=email, maxlength=320 |
| Phone | tel | ✅ | autocomplete=tel, maxlength=40 |
| Message | textarea | ✅ | maxlength=5000 |
| website (honeypot) | text | — | aria-hidden, tabindex=-1 |

Form attribute: `data-nb-inquiry="contact"` — handled by the shared inquiry client.

### Conversion integration readiness (read-only check, 2026-08-20)

- **BLOCKED — Turnstile:** neither `TURNSTILE_SITE_KEY` nor
  `TURNSTILE_SECRET_KEY` is configured in the shared or production secret
  inventory. Release remains blocked until both are present together. The
  public key may be returned only by the bounded inquiry-config endpoint; the
  secret key stays server-only. The Cloudflare widget must permit
  `nobullmarketing.com`, `www.nobullmarketing.com`, the active production
  deployment hostname, and every preview hostname used for acceptance testing.
- **READY — Slack:** a read-only production check authenticated the existing
  bot, resolved the exact active `sales-calls` channel, and confirmed bot
  membership. No message was posted. Inquiry delivery remains one attempt with
  no fallback or replay; `website_inquiries` plus the in-app admin notification
  are the durable recovery path when Slack fails.
- `MARKETING_SITE_HOSTS` is not explicitly configured, so the server uses its
  built-in apex/`www` marketing-host defaults. Any additional marketing host
  must be added to this setting and to the Turnstile widget allow-list before
  release.

### Unsubscribe form (`/unsubscribe/`)
| Field | Type | Required |
|---|---|---|
| Email Address | email | ✅ |
| website (honeypot) | text | — |

### Phone links
**None found** in any page source. No `tel:` links in the Replit build.

### Email links
**None found** in any page source. Contact goes entirely through Calendly + contact form.

---

## 7. Blog and Resource Structure

**Resource index:** `/resources/` — filterable grid
**Article URL pattern:** `/resource/<slug>/`

**Filter tabs:** All · Articles · Videos · Webinars · Podcasts

**15 canonical current articles (from `website/content/articles/index.json`):**

| # | Slug | Title | Category |
|---|---|---|---|
| 1 | boost-your-sales-6-effective-tips-for-lawyers | Boost Your Sales: 6 Effective Tips for Lawyers | Articles |
| 2 | cracking-the-code-to-5-star-google-reviews | Cracking the Code to 5-Star Google Reviews | Articles |
| 3 | why-local-seo-is-a-game-changer-for-your-law-firm | Why Local SEO is a Game Changer for Your Law Firm | Articles |
| 4 | closing-30-percent-attorney-leads | Closing 30 percent attorney leads | Videos |
| 5 | nobull-marketing-founder-ceo-…-120-5-star-google-reviews | Ronnie Deaver Breaks Down How Attorneys Can Generate 120+ 5-Star Google Reviews | Webinars |
| 6 | episode-21-evolving-family-law-… | Episode #21 – Evolving Family Law To Meet Unique LGBTQ+ & Non Traditional Family Needs | Podcasts |
| 7 | episode-20-positive-divorce-through-mediation-… | Episode #20 – Positive Divorce Through Mediation | Podcasts |
| 8 | episode-19-interview-with-hayley-lisa-… | Episode #19 – Interview With Hayley Lisa | Podcasts |
| 9 | episode-18-interview-with-rebecca-stahl-… | Episode #18 – Interview With Rebecca Stahl | Podcasts |
| 10 | episode-17-interview-with-nick-himonidis-… | Episode #17 – Interview With Nick Himonidis | Podcasts |
| 11 | episode-16-gullu-singh-… | Episode #16 – Gullu Singh | Podcasts |
| 12 | episode-15-lila-m-seif-… | Episode #15 – Lila M. Seif | Podcasts |
| 13 | episode-14-sara-scott-… | Episode #14 – Sara Scott | Podcasts |
| 14 | episode-13-interview-with-brita-long-… | Episode #13 – Interview With Brita Long | Podcasts |
| 15 | episode-12-interview-with-ed-kless-… | Episode #12 – Interview With Ed Kless | Podcasts |

`/resource/episode-13/` is a separate WordPress compatibility alias, not an
article or sitemap entry. At cutover it must make one 301 hop to the canonical
Brita Long Episode 13 route above, whose response must be 200.

**Article body format:** HTML stored in JSON files under `website/content/articles/<slug>.json` (fields: `slug`, `title`, `date`, `cat`, `thumb`, `metaDesc`, `bodyHtml`). Body HTML uses `__UPLOADS__/` prefix replaced at render time.

**Sidebar:** Each article page shows 3 recent resources + "Book a Free Demo" CTA.

---

## 8. Testimonials and Case Studies

### Video testimonials (Vimeo)
| Client | Vimeo ID | Thumbnail source |
|---|---|---|
| Shields & Boris | 898391761 | `2023/12/Shields-and-Boris.png` |
| Covington | 701775821 | `2023/12/Covington.png` |
| Integrity | 898392089 | `2023/12/Integrity.png` |
| (unnamed) | 1106263914 | None (direct embed) |
| (unnamed) | 1106262623 | None (direct embed) |

### Written testimonials (homepage testimonial band)
| Name | Role | Stars | Source |
|---|---|---|---|
| TESSA THRIFT | Attorney | ★★★★★ | `home.ts` + live-site source |
| LANI AKIONA | Family Law Attorney | ★★★★★ | `home.ts` + live-site source |
| STACY GROW | Law Firm Marketing Director | ★★★★★ | `home.ts` + live-site source |

The role-footed quotes and the remaining Google reviews are served from the homepage testimonial band. `docs/CONTENT_TRUTH_SOURCE.md` remains the source record for the approved text and attribution policy.

### Google review images (homepage)
11 review screenshots: `2023/12/Review-1.png` through `2023/12/Review-11.png`. No reviewer names captured in source. Alt text: "Five-star Google review from a NoBull Marketing client (N of 11)".

### Case studies
No dedicated case-study pages. Results appear inline in the homepage `#proof` section, with client voice directly below it (see `docs/CONTENT_TRUTH_SOURCE.md`).

---

## 9. Client Names and Logo Files

### "As Seen On" logos (homepage)
5 logos at `assets/uploads/2023/12/01.png` through `05.png`. **No identifying alt text or names in source.** Client identities unverifiable from filenames alone. Marked UNVERIFIED in `CONTENT_TRUTH_SOURCE.md`.

### Named video testimonial clients
- Shields & Boris (law firm)
- Covington (law firm)
- Integrity (law firm)
- Two additional clients — names not captured in source code

### No client logo grid exists in the Replit build. The WordPress site may have additional client logos not replicated in the static generator.

---

## 10. Analytics, Pixels, Tag Manager, Conversion Tracking

### Live WordPress site
- **GTM/GA IDs:** No standard GTM-XXXXXXX, G-XXXXXXXXXX, UA-XXXXXXXX, or AW-XXXXXXXXX strings found in initial HTML response. May be loaded by the Divi theme or a WP plugin after initial render, or loaded by NBM-specific code (`NBM v.1.0.1696187356`).
- **Facebook Pixel:** Not detected in initial HTML. `article:publisher` OG tag links to `https://www.facebook.com/BSfreeMarketing/` (publisher attribution only — not a pixel).
- **Status: NEEDS CLIENT CONFIRMATION** — operator must provide all active tracking IDs (GA4, GTM, Meta Pixel, Google Ads conversion, etc.) for parity in the redesign.

### Replit static build (`website/`)
- **No analytics script found** in `website/src/html.ts` or any page source.
- **No GTM, GA, or pixel code** in any generated HTML.
- **Gap:** Analytics/conversion tracking is entirely absent from the Replit-built site and must be added before DNS cutover.

---

## 11. SEO: Titles, Descriptions, Canonical Tags, Schema, Redirects, Indexation

### Page-level SEO (Replit build, from page sources)

| Page | `<title>` | Meta description |
|---|---|---|
| `/` | Homepage - NoBull Marketing | NoBull Marketing is a done-for-you revenue engineering agency for top law firms: more leads, more consults, more cases — more money. |
| `/about/` | About NoBull Marketing \| Meet The Team | The name NoBull Marketing combines "Noble" and "No B.S." — an honorable, fluff-free legal marketing agency. Meet the team that grows law firms. |
| `/services/` (retired historical row) | Former title: Law Firm Marketing Services - NoBull Marketing | No current metadata: the page is absent and returns the branded 404. The former Google-playbook description and 500,000-lead claim are obsolete. |
| `/resources/` | Resources - NoBull Marketing | Law firm growth resources from NoBull Marketing: articles, videos, webinars, and podcasts on legal marketing, intake, and sales. |
| `/resource/<slug>/` | `<article title> - NoBull Marketing` | Per-article `metaDesc` from JSON |
| `/book-free-demo/` | Book a Free Demo - NoBull Marketing | Schedule a free demo with NoBull Marketing to see how the Revenue Engineering System can grow your law firm — or send the team a question. |
| `/privacy-policy/` | Terms of Use & Privacy Policy - NoBull Marketing | — |

**Canonical tags:** Every page emits `<link rel="canonical" href="https://nobullmarketing.com/<path>">` — hardcoded to the apex domain.

**OG tags:** Every page emits `og:title`, `og:description`, `og:url`, `og:type=website`, `og:image` (default: `assets/uploads/2024/01/default-featured-img-400x250.jpg`), `og:site_name: NoBull Marketing`.

**Schema / JSON-LD:** The live WordPress site outputs `WebPage + BreadcrumbList + Organization` schema. The Replit build currently has **no JSON-LD schema**. Gap to fill before DNS cutover.

**Robots:** Live WP: `index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1`. Replit: dynamic `robots.txt` via `marketingSite.ts` → `User-agent: * Allow: / Sitemap: …/sitemap.xml`. Preview path: `noindex` header injected.

**Sitemap:** Generated dynamically from `website/public/sitemap-pages.json` at `/sitemap.xml` with correct `https://nobullmarketing.com/` origin.

**Redirects:**
- `www.nobullmarketing.com` → `nobullmarketing.com` (301, implemented in `marketingSite.ts`)
- `/about` → `/about/` trailing slash (Express `redirect: true` static option)
- `INTERNAL_BUNDLE_FILES` (`/404.html`, `/sitemap-pages.json`) → marketing 404

---

## 12. CMS, API, Integrations

### Live WordPress site
- **CMS:** WordPress 7.0.2 + Divi page builder + NBM custom theme
- **Hosting:** Separate WP host (not Replit) until DNS cutover

### Replit site integrations
| Service | How used | Notes |
|---|---|---|
| **Calendly** | Inline embed widget (`data-url=…`) | Script: `https://assets.calendly.com/assets/external/widget.js`; CSP explicitly allows `calendly.com` frames |
| **Vimeo** | Thumbnail lightbox + direct `<iframe>` embeds | CSP allows `player.vimeo.com` frames; 5 videos total |
| **Amazon** | External links to book page (Paperback + Audible) | Two separate product URLs |
| **Spotify** | Article body embeds | CSP allows `open.spotify.com`; only in article body HTML |
| **Google Fonts** | Not in Replit build | Present on WordPress; absent from `website/src/html.ts` |
| **Facebook** | Social footer link only | No pixel |
| **LinkedIn** | Social footer link only | No tracking |
| **Contact form API** | `data-inquiry="contact"` → presumably a server route | Route not visible in `website/src/html.ts`; handled by `assets/js/site.js` |
| **Unsubscribe API** | Form in `/unsubscribe/` | Handled by `assets/js/site.js` |

### API routes used by the marketing site (server-side)
- Inquiry/contact form POST endpoint (exact route in `server/` — not audited here; see `assets/js/site.js`)
- Unsubscribe endpoint (same)
- No CRM, webhook, or calendar API integration detected in current Replit build.

---

## 13. Infrastructure Notes

- **Two-host architecture:** `nobullmarketing.com` + `www.nobullmarketing.com` → marketing bundle. All other hosts (*.replit.dev, reports.nobullmarketing.com) → NoBull OS SPA. Controlled by `MARKETING_SITE_HOSTS` env var in `marketingSite.ts`.
- **CSP:** Marketing pages use a relaxed CSP distinct from the OS app's helmet CSP. Registered before helmet in `server/index.ts`.
- **Cache headers:** Non-HTML assets have a 1-day cache; content-hash `?v=<hash>` is appended to CSS/JS URLs at build time.
- **404 handling:** `website/public/404.html` contains `{{BASE}}` placeholder; `marketingSite.ts` replaces it with the correct base href (`/` or `/website-preview/`) at serve time.
