# Metrics

> improve-website journey artifact — created 2026-08-09 (Phase 1 CRO diagnosis, Task #4123;
> extend-only file governed by the section headings the phases name). Tracker:
> [IMPROVE-WEBSITE-PLAN.md](IMPROVE-WEBSITE-PLAN.md) · Findings: [WEBSITE.md](WEBSITE.md) ·
> Backlog: [EXPERIMENTS.md](EXPERIMENTS.md).
>
> **Nothing on this site is field-measured yet**: there is no analytics (finding F-01) and the
> apex domain still serves the old WordPress site (F-02), so every number below is either a lab
> measurement (methodology at the bottom) or explicitly `unmeasured`.

## Funnel

ONE action per page in **bold**; the macro-conversion is a completed Calendly booking.

```
Traffic (unmeasured — no analytics; apex cutover pending, F-02)
  │  assumed: GBP/organic, referrals, book readers, direct
  ▼
/ home ──────────────── **Book a High Impact Revenue Session** → #booking · transitional: See the System → #system,
  │                       book band → /free-chapters/
  ├─ /services/ ───────── **Book a Strategy Call** (persuasion: what we install)
  ├─ /testimonials/ ───── **Book a Strategy Call** (persuasion: proof)
  ├─ /about/ ──────────── **Book a Strategy Call** (persuasion: who we are)
  ├─ /resources/ + /resource/<slug>/ ── awareness → sidebar **Book a Strategy Call** (soft)
  └─ /free-chapters/ ──── transitional asset: read → **Book a Strategy Call**
                           (tertiary Amazon/Audible exits off-site — locked hierarchy)
  ▼
/#booking ───────────── **Complete the Calendly booking** (alternative: homepage #contact message)
  ▼
OFFLINE (invisible to the site): call held → fit verdict → proposal → signed client
```

- **Blocked arteries:** unmeasurable until F-01/F-02 close. Heuristic candidates: mobile home
  bandwidth cost (F-03) and the all-or-nothing jump from "interested" to "book a call" with no
  intermediate commitment (F-04; soft-CTA ladder in-flight, #4121).
- **Missing links:** measurement itself (F-01); email nurture (F-04); price anchor (F-05);
  per-case-study depth (F-08); phone channel (F-09).

## Stage & One Metric That Matters

Instruments below assume E-01 (analytics + Calendly events) ships; all rows today: `unmeasured`.

| Stage | One metric that matters | Instrument (post-E-01) | Today |
|---|---|---|---|
| Site (north star) | Booked High Impact Revenue Sessions / week | Calendly `event_scheduled` webhook or embed event | unmeasured |
| Home | CTA click-through to `#booking` | anchor-click event on the homepage CTA instances | unmeasured |
| Persuasion pages | assisted CTR to homepage `#booking` | same event, per-page source | unmeasured |
| /free-chapters/ | excerpt→booking CTR (secondary: read depth) | floating-bar/endcap click events + scroll depth | unmeasured |
| Homepage `#booking` | booking-section visit → completion rate | Calendly event ÷ section-view sessions | unmeasured |
| Offline guardrail | call show-rate; call → proposal rate | CRM (out of site scope) | unmeasured |

## Baselines & Targets

Lab baselines 2026-08-09 (methodology below; localhost — optimistic floor). Targets are the
skill's Phase 6 thresholds; "miss response" = what we do when the field number misses after
cutover + E-01/E-06.

### Core Web Vitals & load (lab)

Desktop 1440×900, unthrottled, cold cache:

| Page | TTFB | FCP | LCP (element) | CLS @load | TBT | KB @load / req | KB after full scroll |
|---|---|---|---|---|---|---|---|
| / | 86 ms | 597 ms | 597 ms (`.nb-machinery-img` hero div) | 0.009 | 3674 ms | 5868 / 41 | 21 935 (144 frames) |
| /about/ | 9 ms | 188 ms | 239 ms (img about-our-work) | 0.023 | 0 | 299 / 17 | 403 |
| /services/ | 7 ms | 141 ms | 141 ms (H1) | 0.052 | 6 ms | 285 / 15 | 307 |
| /testimonials/ | 6 ms | 115 ms | 162 ms (img Shields-and-Boris) | 0.010 | 0 | 552 / 15 | 566 |
| /resources/ | 6 ms | 179 ms | 202 ms (card jpg) | 0.003 | 0 | 368 / 24 | 411 |
| /book-free-demo/ | 6 ms | 98 ms | 98 ms (H1) | 0.021 | 0 | 222 / 13 | 222 (Calendly did not init headlessly — F-15) |
| /free-chapters/ | 10 ms | 165 ms | 165 ms (H1) | 0.000 | 29 ms | 207 / 11 | 2284 (cover PNG lazy) |

Mobile 390×844, Fast-3G-ish (1.6 Mbps down / 150 ms RTT), 4× CPU, cold cache:

| Page | FCP | LCP | CLS @load* | TBT | Load event | KB @load / req |
|---|---|---|---|---|---|---|
| / (2026-08-09 pre-E-03) | 1613 ms | 1962 ms | see note | 2123 ms | **34 945 ms** | **6958 / 168** (frames eager — F-03, superseded) |
| / (2026-08-09 post-E-03) | 1672 ms | 1969 ms | see note | 1714 ms | **4290 ms** | **741 / 25** (zero frame requests before `#system` approach) |
| /book-free-demo/ | 666 ms | 666 ms | 0.050 total | 91 ms | 2146 ms | 223 / 13 |

E-03 re-measure (Task #4126, same date/methodology): frame fetching now arms via
IntersectionObserver 2 viewport heights ahead of `#system`; @load the page makes 0 frame
requests. Scrolling to `#system` starts the identical progressive loader (verified: loader
UI counts up, `data-mode="cinematic"`, frames stream in) — experience unchanged once there.

*Home scroll-pass shift sum = 1.63 on both profiles — a **whole-journey lab sum** across the
pinned cinematic, not windowed CWV CLS (load-time CLS is 0.009). Field/windowed CLS: unmeasured
(E-06). Do not read 1.63 against the 0.1 threshold.

| CWV metric | Baseline | Target | Miss response |
|---|---|---|---|
| LCP | lab: 0.10–0.60 s desktop, 1.96 s mobile home | field p75 < 2.5 s | Preload/format work on the LCP image (E-02); re-check frame deferral (E-03) |
| INP | no field data; lab TBT 3.7 s desktop home (F-07) | field p75 < 200 ms | Break up frame decode work; re-profile scroll choreography |
| CLS | lab @load 0.000–0.06; windowed unknown (F-16) | field p75 < 0.1 | Audit shift sources with the field attribution data |
| TTFB | lab 6–86 ms (localhost) | field p75 < 800 ms | CDN/cache headers on the deployment |
| Page weight (mobile home, @load) | 0.72 MB / 25 req (was 6.96 MB / 168 req before E-03 frame deferral, shipped 2026-08-09 Task #4126) | < 1.5 MB / < 60 req before `#system` approach — **met in lab** | E-02 formats for the remaining weight |
| Fonts | 332 KB / 7 files — Typekit 5 (~234 KB, Sweet Sans + Crimson cuts) + Google 2 (~97 KB duplicate Crimson Pro; F-14 corrected 2026-08-09) | < 200 KB | Drop the duplicate foundry (E-18), then Phase 4 subset/weights (E-04) |

### Static weight facts (repo, 2026-08-09)

- Revenue-engine frames: desktop 18 MB / 144 files (~125 KB avg); mobile 6.2 MB / 144 files.
- Desktop hero art re-encoded to visually lossless WebP (Task #4127, closes F-06):
  `machinery-hero.webp` 279 KB (desktop LCP element, preloaded; was the 1.9 MB PNG) +
  `law-firm-revenue-engine-cover.webp` 126 KB (preloaded; was the 1.6 MB PNG) — preloads/CSS/
  `<picture>` sources updated so no viewport downloads the PNGs (they stay committed as the
  derivation sources and the cover's non-WebP `<img>` fallback). Desktop hero preload weight
  3.5 MB → 405 KB (~88% smaller; PSNR ≈ 40–42 dB vs source). `/free-chapters/` cover now WebP
  too (page image weight −1.5 MB). Mobile hero WebP 144 KB (unchanged, good).
- `home.css` 86.5 KB · `home.js` 137.7 KB (55 KB transfer, deferred) · `site.css` 39 KB · `site.js` 3.6 KB.
- HTML: home 67 KB · free-chapters 110 KB · booking 8.7 KB.

### Typography baselines (desktop lab, computed styles)

Skill floors: body ≥16 px (18 px reading-heavy), measure 45–75 ch, line-height 1.5–1.7 body.

| Surface (element) | Family | Size | Line-height | Weight | Measure | Verdict |
|---|---|---|---|---|---|---|
| Home H1 | sweet-sans-pro | 54 px | 0.98 | 800 | 22 ch | display OK |
| Subpage H1 | Crimson Pro | 70.4 px | 0.98 | 400 | ~34 ch | OK |
| Home H2 (gap band) | Crimson Pro | 42 px | normal | 400 | 60 ch | OK |
| Home body (REE strip p) | sweet-sans-pro | **14.5 px** | 1.65 | 400 | **93 ch** | fails size + measure |
| About/services body p | sweet-sans-pro | **15 px** | 1.7 | 600 | **88–149 ch** | fails size + measure (600 = Regular, see key) |
| Testimonials card body | sweet-sans-pro | **14 px** | 1.65 | 600 | 70 ch | fails size |
| Free-chapters reader p | sweet-sans-pro | **15 px** | 1.7 | 600 | **~92 ch** | reading page: fails 18 px target + measure |
| Eyebrows | sweet-sans-pro | 11.5 px | — | 700 | caps, tracked +1.84 px | OK as labels |
| Smallest text found | gauge stamps (home) | **8.64 px** | — | — | "Live client result — one real firm" | F-11; testimonials chart labels 9 px |

**Weight-column reading key (corrected 2026-08-09):** the Typekit kit's weight map is
non-standard — **600 = Regular, 700 = Medium, 800 = Bold, 400 = Extra Light** (documented in the
`site.css` header). "600" in this table is Regular-weight body by design, not semibold; the
earlier "semibold body" verdict is withdrawn. The size and measure failures stand unchanged.

Phase 4 skip-heuristic verdict: **fails** (body under 16 px and measures over 75 ch on key
surfaces, including the reading page) — Phase 4 must run. (Ran 2026-08-09; fix spec in
DESIGN.md §Typography.)

## Methodology (lab, 2026-08-09)

Headless Chromium 125 (puppeteer 24.43.1) against the dev server
(`127.0.0.1:5000/website-preview/`), cold cache per page (`setCacheEnabled(false)`), CDP
byte/request accounting, buffered PerformanceObservers (paint/LCP/layout-shift/longtask), full
instant-jump scroll pass, then settle. Desktop 1440×900 unthrottled; mobile 390×844 +
`Network.emulateNetworkConditions` (1.6 Mbps / 150 ms RTT / 750 kbps up) + 4× CPU. Script:
`.local/scratch/t4123/measure.mjs` (scratch, not committed). Caveats: localhost (no TLS/CDN/real
RTT) → timings are an optimistic floor; TBT ≠ INP; scroll-pass CLS sums are not windowed CWV;
Calendly/Vimeo embeds are domain-locked and inert in this environment (project memory +
observed). Follow-up probes same date (Phases 2–8): per-page screenshots incl. grayscale
conversions, nav/aria/link DOM probes, and a font-host capture that corrected F-14
(`evidence2.mjs`, `probe-fonts.mjs`, `probes2.json` — same scratch dir).
