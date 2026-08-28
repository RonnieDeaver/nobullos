# Do Not Break — Redesign Preservation Requirements

**Purpose:** Everything in this document must survive the redesign unchanged. Breaking any item here risks SEO equity loss, broken lead-capture, broken integrations, or operator workflow disruption.

---

## 1. URL Structure (SEO Equity — Critical)

Every protected canonical or compatibility URL listed below must retain its stated behavior after DNS cutover:

| URL | Must resolve to |
|---|---|
| `/` | Homepage |
| `/about/` | About page |
| `/#proof` | Homepage Results section (sitewide Results navigation target) |
| `/resources/` | Resource index |
| `/resource/<slug>/` | Individual article (all 15 canonical slugs; see `docs/CURRENT_SITE_AUDIT.md §7`) |
| `/resource/episode-13/` | Legacy compatibility alias: one 301 to the canonical Brita Long Episode 13 route |
| `/#booking` | Homepage Calendly scheduler |
| `/#contact` | Homepage protected contact form |
| `/book-free-demo/` | 301 compatibility redirect to `/#booking` |
| `/contact/` | 301 compatibility redirect to `/#contact` |
| `/privacy-policy/` | Legal page |
| `/unsubscribe/` | Email unsubscribe |
| `/sitemap.xml` | Dynamic XML sitemap |
| `/robots.txt` | Dynamic robots.txt |
| `/404` | Custom 404 (any unmatched path) |

**Rules:**
- Do not rename, merge, or delete any of the remaining live routes above. Results, booking, and contact are deliberately in-page homepage destinations.
- `/services/` is deliberately retired and is not one of the protected live routes. Do not regenerate it,
  add it to sitemap data, link to it, or redirect it. It must continue to return the branded 404 from
  both the marketing host and `/website-preview/services/`.
- Do not change the trailing-slash convention (all directory-style paths use trailing slash; server already redirects without-slash → with-slash).
- Do not add `noindex` to any currently-indexed page.
- All 15 canonical article slugs are permanent. If new articles are added, new slugs must be added to `website/content/articles/index.json` — existing slugs must not be changed.
- `/resource/episode-13/` is not a canonical article and must not enter the sitemap. Preserve it as one
  301 to `/resource/episode-13-interview-with-brita-long-founder-of-the-happier-attorney-llc/`;
  the target must return 200.

---

## 2. Redirects (SEO Equity)

| From | To | Type | Rule |
|---|---|---|---|
| `www.nobullmarketing.com/*` | `nobullmarketing.com/*` | 301 | Implemented in `marketingSite.ts`; must not be removed |
| `/about` (no slash) | `/about/` | 301 | Express `redirect: true` on static serve; applies to all directory paths |
| `/resource/episode-13/` | `/resource/episode-13-interview-with-brita-long-founder-of-the-happier-attorney-llc/` | 301 | Legacy WordPress alias; preserve exactly one hop and omit from sitemap |
| `/book-free-demo/` | `/?<safe-query>#booking` | 301 | Compatibility only; query precedes the fragment; omit from sitemap |
| `/contact/` | `/?<safe-query>#contact` | 301 | Compatibility only; query precedes the fragment; omit from sitemap |

Do not add any new permanent redirects that change existing canonical URLs without also adding a 301 from the old URL.

---

## 3. Canonical Tags

Every page must continue to emit:
```html
<link rel="canonical" href="https://nobullmarketing.com/<path>">
```
The canonical must always resolve to the apex domain (`nobullmarketing.com`), never to `www.`, `/website-preview/`, or a Replit `.dev` domain. This is already implemented in `website/src/html.ts` — do not remove it.

---

## 4. Robots and Sitemap

- `robots.txt` must remain `User-agent: * / Allow: /` with a Sitemap reference.
- `sitemap.xml` must be regenerated whenever pages are added or removed.
- `/website-preview/*` must remain `noindex` (enforced by `setMarketingHeaders` in `marketingSite.ts`). Do not propagate the noindex to the production marketing host.
- `404.html` and `sitemap-pages.json` must remain blocked from direct URL access (`INTERNAL_BUNDLE_FILES` set in `marketingSite.ts`).

---

## 5. Open Graph and Social Meta

Every page must continue to emit the full OG block (`og:title`, `og:description`, `og:url`, `og:type`, `og:image`, `og:site_name`) and `twitter:card`. The `og:url` must use the canonical apex URL, not a Replit dev domain.

The OS app's og:image/twitter:image tags are static in `client/index.html` (NoBull-branded, Task #4618/#4641 — the old `vite-plugin-meta-images.ts` rewrite plugin was removed). Never add a `client/public/opengraph.*` file expecting it to be picked up automatically; verify meta tags from served HTML, not the source file.

---

## 6. Lead Capture (Revenue-Critical)

These are the primary conversion points. A broken booking widget or form means no leads.

### Calendly external handoff
- Must appear exactly once at homepage `#booking` as the `View Available Times →` action.
- URL must remain: `https://calendly.com/jmangle-nobullmarketing/high-impact-revenue-session-other`.
- The action opens in a new tab with `target="_blank"` and `rel="noopener"`.
- Do not restore the Calendly inline widget, its external script, its fixed-height shell, or recovery-copy variants without a new owner decision.

### Contact form (homepage `#contact`)
- Fields: Full Name, Email, Phone, Message (all required), honeypot (`name="website"`, `tabindex="-1"`, `aria-hidden="true"`) — do not remove the honeypot.
- `data-nb-inquiry="contact"` must be preserved on the homepage form; `home.js` and `site.js` compile the same shared inquiry handler. The unsubscribe utility keeps its separate `data-nb-inquiry="unsubscribe"` contract.
- Contact submissions require Google reCAPTCHA. `RECAPTCHA_SITE_KEY` is the public browser key returned by the bounded `/api/website/inquiry/config` response; `RECAPTCHA_SECRET_KEY` is deployment-secret-only and must never be emitted or logged.
- Register every served contact-form hostname in reCAPTCHA, including `nobullmarketing.com` and any preview hostname used for acceptance testing. A successful token whose Google-verified hostname is outside the deployment's configured marketing/Replit host set fails closed; never derive that trust boundary from request headers.
- Missing, expired/replayed, rejected, misconfigured, or timed-out reCAPTCHA checks must create no inquiry. The visitor must receive recovery copy that asks them to complete or refresh the security check.
- Keep the honeypot check before reCAPTCHA verification. A tripped honeypot silently succeeds without verification, storage, lead promotion, in-app notification, or Slack delivery.
- After a valid contact is stored, one best-effort Slack attempt targets only the exact `sales-calls` channel. The existing Slack bot must be invited to that channel; there is no fallback channel and no retry after an uncertain post failure.
- Slack delivery is notification-only. If it fails, the stored `website_inquiries` row and existing in-app admin notification are the recovery path; do not delete or roll back the inquiry.
- Form must not be replaced with a third-party embed unless the server-side handler is updated to match.

### Unsubscribe form (`/unsubscribe/`)
- Must remain functional through the shared inquiry handler with only its honeypot + email field. Legal / CAN-SPAM compliance. It remains independent of reCAPTCHA and contact-form fields.

---

## 7. Testimonial Videos (Social Proof)

Five committed poster cards remain on the homepage testimonial band and link
to Vimeo in a new tab. All five cards, poster assets, and destinations must
remain intact:

| Vimeo ID | Page(s) | Embed type |
|---|---|---|
| 898391761 | `/` | Poster card → outbound Vimeo link |
| 701775821 | `/` | Poster card → outbound Vimeo link |
| 898392089 | `/` | Poster card → outbound Vimeo link |
| 1106263914 | `/` | Poster card → outbound Vimeo link |
| 1106262623 | `/` | Poster card → outbound Vimeo link |

CSP must allow `player.vimeo.com` frames (already configured in `marketingSite.ts`).

---

## 8. Book Availability

Amazon and Audible are intentionally non-interactive `Coming Soon!` notices
on the homepage and free-chapters reader. Do not restore historical listing,
search, buy, or listen URLs until the client confirms canonical current-edition
destinations. The on-site `/free-chapters/` action remains the live book CTA.

---

## 9. Social Links

Both social links in the footer must remain correct:
- Facebook: `https://www.facebook.com/BSfreeMarketing`
- LinkedIn: `https://www.linkedin.com/company/nobull-marketing1/`

---

## 10. Content and Copy Rules

- **Service names must not change:** "Google My Business", "Google Ads", "Monthly Webinars"
- **System names must not change:** "Revenue Engineering System for Law Firms", "Marketing Mastery", "Perfect Intake", "Sales Blueprint"
- **Team names and roles must not change** without operator confirmation (see `docs/CONTENT_TRUTH_SOURCE.md`)
- **All claims marked NEEDS CLIENT CONFIRMATION** must not be altered, promoted, or removed without operator sign-off
- **"As Seen On" logos** must not be reordered, substituted, or removed — identities are unconfirmed and logos are treated as opaque assets until operator confirms them
- **The `Practice Areas Served` header link must remain** and must resolve to
  `/about/#practice-areas-served` at every generated page depth. The retired dropdown label and
  dropdown behavior must not be restored.
- **The About roster and practice-area list are complete contracts:** 20 people from the shared
  homepage/About `TEAM_ROSTER` and 14 entries from the shared `INDUSTRIES` source, in canonical
  order. The Paid Search run is Juan and Santiago (`Senior Paid Search Expert`), Devin and Kreston
  (`Senior Paid Search Expert`), Kaylie and Inno (`Paid Search Expert`). About exposes biographies only for Ronnie, Oliver, and
  Jake. The homepage reveal must keep the first two rows visible (12 / 6 / 4 / 2 cards at the
  6 / 3 / 2 / 1-column breakpoints) and must not change roster order.
- **The footer product group is independent of the retired route:** `The Revenue Engine™` resolves to
  homepage `#system`; `CaseGen™`, `CaseIntake™`, and `CaseConvert™` resolve to `#casegen`,
  `#caseintake`, and `#caseconvert`. Do not repoint these links while editing top navigation.
- **Copyright year** in footer should be updated to current year (2026) or a range, but must not be removed

---

## 11. Infrastructure and Routing (Do Not Remove)

| Component | Location | Why it must stay |
|---|---|---|
| `isMarketingHost()` check | `server/website/marketingSite.ts` | Prevents OS SPA from serving marketing routes on the wrong host |
| `www → apex 301` redirect | `marketingSite.ts` | Prevents duplicate-content indexation of www |
| `/website-preview/` route | `marketingSite.ts` | Pre-DNS design review path; used for QA before every publish |
| Marketing-specific CSP headers | `marketingSite.ts` | Calendly and Vimeo embeds break under the OS app's strict helmet CSP |
| `{{BASE}}` placeholder in `404.html` | `website/public/404.html` | Server replaces it at runtime for both `/` and `/website-preview/` base paths |
| Content-hash `?v=<hash>` on CSS/JS | `website/src/html.ts` `assetSuffix()` | Cache busting — removing it causes stale CSS to serve to returning visitors |
| `INTERNAL_BUNDLE_FILES` block | `marketingSite.ts` | Prevents `404.html` and `sitemap-pages.json` from being directly browsable |

---

## 12. Two-Host Architecture

The app serves **two entirely different audiences from a single deployment:**

1. `nobullmarketing.com` / `www.nobullmarketing.com` → marketing website (static bundle from `website/public/`)
2. Everything else (`reports.nobullmarketing.com`, `*.replit.dev`) → NoBull OS SPA

This separation is controlled by `requestHostname()` + `isMarketingHost()` in `marketingSite.ts`, which is registered **before** helmet and all SPA static middleware in `server/index.ts`.

**Do not:**
- Move or re-order the `marketingSite` registration in `server/index.ts`
- Add catch-all SPA middleware that runs before `marketingSite`
- Modify `MARKETING_SITE_HOSTS` env var without understanding both audiences

**reports.nobullmarketing.com** is the OAuth callback host for Zoom and Front integrations (see `fix-zoom-oauth-redirect.md`, `fix-front-oauth-redirect.md`). This must never serve the marketing website.

---

## 13. Pre-DNS Checklist (Before DNS Cutover to Replit)

These items must be in place before DNS is pointed or SEO/lead equity is at risk:

- [ ] Analytics (GA4, GTM, Meta Pixel — operator to provide IDs; currently absent from Replit build)
- [x] JSON-LD schema (`WebPage` + `Organization` + `BreadcrumbList` — present on WordPress, absent from Replit build) — sitewide `Organization`+`WebPage` in every page's `<head>`, `BreadcrumbList` on every non-homepage page, plus `Article` schema on all 15 resource/article pages (website/src/html.ts, website/src/pages/article.ts)
- [ ] All 15 canonical article slugs resolving in Replit build
- [ ] Legacy `/resource/episode-13/` returning one 301 to the canonical Brita Long route, whose response is 200
- [ ] Contact form POST handler verified to be working in production
- [ ] The single external Calendly action opens the canonical destination with `noopener`
- [ ] `sitemap.xml` returning all page URLs with correct `https://nobullmarketing.com/` origin
- [ ] `robots.txt` returning correct content
- [ ] `www → apex 301` verified
- [ ] All five Vimeo poster links open their canonical destinations
- [ ] All five opaque "As Seen On" assets display without inferred identity text
- [ ] Static written-review grid displays without a carousel dependency
- [ ] Mobile nav working on iOS and Android
- [ ] Amazon and Audible render as non-interactive `Coming Soon!` notices
- [ ] Copyright year updated (currently says 2024)
