# Content Truth Source — nobullmarketing.com

**Purpose:** Every factual claim, metric, testimonial, client name, award, and trademark that may appear in the redesigned site is listed here with its verification status. Nothing from this list may appear as a stated fact in the final site unless it is marked **VERIFIED** with a source.

**Rules:**
- VERIFIED = confirmed present on live site AND in Replit source, or confirmed by an authoritative external source.
- UNVERIFIED = present in one source only, or no source can be cited.
- OUTDATED = present in source but known to be stale.
- NEEDS CLIENT CONFIRMATION = plausible but cannot be independently confirmed; must be approved by operator before publishing.
- Neutral layout placeholders (e.g. "[Client result]", "[Testimonial]") may be used during design. They must not appear as factual claims in the finished site.

---

## 1. Agency Metrics and Performance Claims

| Claim | Status | Source |
|---|---|---|
| "Over 500,000 Google Leads generated for lawyers" | OUTDATED | Historical retired-services-page subheading/meta. The standalone page was removed 2026-08-19; the owner-confirmed 1,000,000+ total below supersedes this wording. Never republish it. |
| "over 650,000 leads" (Ronnie bio) | OUTDATED | Removed from the live bio during the 2026-08 overhaul; superseded 2026-08-06 by the owner-confirmed 1,000,000+ total (row below). Never republish the 650K or 500K variants. |
| "1,000,000+ leads generated" (all-time, across client firms) | VERIFIED | Owner confirmed directly in session, 2026-08-06 (operator-provided; no deck slide). Renders via `website/src/proof.ts` LEADS_GENERATED on the home credibility band; registered in `docs/website-claim-ledger.md` #16. Must always read "generated", never "reviewed". |
| "30,000+ five-star reviews generated" (all-time, across client firms) | VERIFIED | Owner confirmed directly in session, 2026-08-06 (operator-provided; no deck slide). Renders via `website/src/proof.ts` REVIEWS_GENERATED on the home credibility band; ledger #35. |
| "$150 million in new client revenue" | NEEDS CLIENT CONFIRMATION | `website/src/pages/about.ts` Ronnie bio. Not independently verifiable. |
| "The Revenue Engineering System was built and tested on over 300 law firms over 5 years" | NEEDS CLIENT CONFIRMATION | `website/src/pages/home.ts` payoff section. |
| "campaigns starting as low as $6,000 per month (including ad spend!)" | NEEDS CLIENT CONFIRMATION | Legacy claim — no longer present anywhere in `website/src/` (the redesigned closing band carries no pricing; verified 2026-08-07). Pricing claims require operator confirmation before each publish — pricing may change. |
| "over a decade of experience in marketing for lawyers" (Ronnie) | NEEDS CLIENT CONFIRMATION | `website/src/pages/about.ts`. Accurate as of writing if Ronnie started ca. 2014 or earlier. |
| "11+ years of experience" (Jake Davis) | NEEDS CLIENT CONFIRMATION | `website/src/pages/about.ts`. |
| "We harness the power of collaboration" | VERIFIED | Present in both `website/src/` and on live nobullmarketing.com. Tagline/copy, not a factual metric. |

---

## 2. Guarantees and Promises

| Claim | Status | Notes |
|---|---|---|
| "Guaranteed Profitable in 3 months or less, or it's free!" | NEEDS CLIENT CONFIRMATION / NOT PUBLISHED | Historical former-services-page claim. The page and source are retired; do not restore this guarantee or treat it as current without operator confirmation of terms and legal approval. |
| "In 3 Months — We'll Pay For Ourselves." | NEEDS CLIENT CONFIRMATION | `website/src/pages/home.ts`. Implied guarantee. |
| "In 12 Months — We'll Change Your Life." | UNVERIFIED | `website/src/pages/home.ts`. Aspirational claim with no evidence base. |
| "or we work for free until we do" | NEEDS CLIENT CONFIRMATION | `website/src/pages/about.ts` FAQ. Must match actual terms of service. |
| "We know what works…and are extremely confident we can make your vision a reality" | VERIFIED | Present in both sources; confidence statement, not a guarantee. |

---

## 3. Team Members

The shared `TEAM_ROSTER` is the canonical source for homepage and About-page
order, photos, names, and roles. These 20 records are verified against the
owner-approved homepage roster; neither page maintains a second copy.

| Name | Role | Photo | Status |
|---|---|---|---|
| Ronnie Deaver | Founder | `ronnie2.jpg` | VERIFIED |
| Oliver Goessler | Head of Operations | `oliver.webp` | VERIFIED |
| Brett Barney | Head of Accounts | `brett2.jpg` | VERIFIED |
| Jeff Mangle | Head of Sales | `jeff.jpg` | VERIFIED |
| Janno Perez | Head of Paid Search | `janno2.jpg` | VERIFIED |
| Cam Duhart | Sr. Intake Engineer | `cam-2026.jpg` | VERIFIED |
| Jake Davis | Sr. Marketing Engineer | `jake2.jpg` | VERIFIED |
| Jason Robbins | Marketing Engineer | `jason.jpg` | VERIFIED |
| Priyanka Lakha | Onboarding Engineer | `priyanka-2026.jpg` | VERIFIED |
| Cat McManus | Executive Assistant | `cat2.jpg` | VERIFIED |
| Juan Antoniazzi | Senior Paid Search Expert | `juan.jpg` | VERIFIED |
| Santiago Sanchez | Senior Paid Search Expert | `santiago.jpg` | VERIFIED |
| Devin Petersen | Senior Paid Search Expert | `devin-2026.jpg` | VERIFIED |
| Kreston Nathras | Senior Paid Search Expert | `kreston.jpg` | VERIFIED |
| Kaylie Dietrichsen | Paid Search Expert | `kaylie.jpg` | VERIFIED |
| Inno Mdletshe | Paid Search Expert | `inno.jpg` | VERIFIED |
| Jordan Scrimgeour | Google Business Profile Expert | `jordan.jpg` | VERIFIED |
| Liri Abdullahu | Intake Engineer | `liri-abdullahu-2026.jpg` | VERIFIED |
| Cleo Ortega | Virtual Assistant | `cleo.jpg` | VERIFIED |
| Lotis Florida | Virtual Assistant | `lotis.jpg` | VERIFIED |

**Source:** `website/src/team.ts`; photos are under
`website/public/nobull-redesign/team/`.

**Ronnie Deaver bio claims:**
- "over a decade of experience" — NEEDS CLIENT CONFIRMATION (see §1)
- "generated over 650,000 leads" — OUTDATED; removed in the 2026-08 overhaul and superseded by the owner-confirmed "1,000,000+ leads generated" (§1, ledger #16)
- "$150 million in new client revenue" — NEEDS CLIENT CONFIRMATION
- "respected speaker at… American Bar Association and the National Association of Divorce Professionals" — NEEDS CLIENT CONFIRMATION

**Jake Davis bio claims:**
- "11+ years of experience managing full-circle marketing campaigns" — NEEDS CLIENT CONFIRMATION

**Oliver Max Goessler bio claims:**
- "trilingual… native English and native German… Spanish… lived in Mexico" — NEEDS CLIENT CONFIRMATION

The three biographies above are the only approved biography copy on the About
page. No biography or personal claim is on file for the other 17 members.

---

## 4. Written Testimonials

> **Rendered-site anonymization (2026-08-06, operator request):** written client reviews on the rendered site must not be tied to an individual. Every rendered review quote in the homepage testimonial band — the three role-footed reviews below plus the remaining Google-review register at the end of this section — uses bracketed editorial substitutions — "[NoBull]", "[The team is]", "[they were]"… — in place of "Ronnie" and the he/his pronouns that referred to him. Reviewer attribution names are unchanged; no claims were added or removed. Long originals are excerpted at sentence boundaries (any deviation beyond that is documented per review in the register). The verbatim texts on file here remain the truth source: a rendered quote differing from its original only by those bracketed substitutions (and the dropped he/his phrasing they replace) plus documented excerpting is policy, **not** content drift — do not flag it in audits. First-party founder content (About bio, homepage team grid, book authorship, resource articles) still names Ronnie Deaver by design. Change log: `docs/website-copy-changelog.md` § "Review anonymization", § "2026-08-07 — Task #3997", and § "2026-08-18 — Task #4925" (static three-quote set).

⚠️ **THREE QUOTE DISCREPANCIES** exist between the Replit build and the live WordPress site. The correct approved version must be confirmed before redesign uses either. Both versions are shown below.

### TESSA THRIFT — Attorney — ★★★★★

**Replit version (`website/src/pages/home.ts`; rendered anonymized and footed "Attorney", never "Google Review"):**
> "Ronnie with NoBull Marketing is amazing! He is very knowledgeable and has literally brought my firm up from nothing to fully booked! I know nothing about marketing or computers and Ronnie was able to work with me at my level. Highly recommend!"

**Live WordPress version (audited 2026-08-03):**
> "Ronnie Deaver is so wonderful to work with, always quick to respond, and can fix anything I send him in a matter of minutes. This is an area that can be overwhelming at times but Ronnie will go above and beyond to explain things in a way I can understand. Thank you Ronnie."

**Status: NEEDS CLIENT CONFIRMATION** — which version is current and approved?

---

### LANI AKIONA — Family Law Attorney — ★★★★★

**Replit version (also rendered anonymized on the homepage since 2026-08-07 — #3997 quote rows → #4925 static three-quote set — footed "Family Law Attorney"):**
> "Ronnie is a pleasure to work with. He's incredibly responsive, and his approach to marketing is straightforward and effective. Since working with NoBull Marketing, the number of quality leads coming into my firm has grown month after month."

**Live WordPress version:**
> "I spoke with Ronnie about SEO for Google My Business for my family law firm. Ronnie demystified the process. I'm excited to work with Ronnie on an SEO campaign. If you want to know how to grow your law firm business, I strongly encourage you to work with Ronnie."

**Status: NEEDS CLIENT CONFIRMATION**

---

### STACY GROW — Law Firm Marketing Director — ★★★★★

**Replit version (also rendered anonymized on the homepage since 2026-08-07 — #3997 quote rows → #4925 static three-quote set — footed "Law Firm Marketing Director"):**
> "NoBull Marketing gets results. Ronnie and his team are transparent, data-driven, and genuinely invested in our success. Every dollar we spend is accounted for, and the return has far exceeded our expectations."

**Live WordPress version:**
> "I knew from day 1 Ronnie would be the right fit for boosting our law firm's SEO. We went from 10 new clients finding us online from Jan – Aug to 11 new leads from Google alone in Oct, with Google becoming our 2nd highest source of new leads that month. Highly recommend!"

**Status: NEEDS CLIENT CONFIRMATION** — the WordPress version contains a specific result claim ("10 new clients… 11 new leads from Google alone"); the Replit version does not. If the specific numbers are used, they must be confirmed accurate.

---

### Homepage "What Clients Are Saying" quote rows — Google-review register (Review-1…11)

The homepage band renders **eleven** quotes in two endless rows (`QUOTE_ROW_A`/`QUOTE_ROW_B` in `website/src/pages/home.ts`, Task #3997 — live 2026-08-07 → 2026-08-18, when Task #4925 (owner brief §9) replaced the marquees with a static three-quote grid, then RESTORED in full later that day by Task #4980 on the owner's reversal): the per-review `RENDERED (row A/B)` markers below are CURRENT surfaces again. The three §4 written reviews above render as their Replit versions footed by role, never "Google Review" (Lani Akiona / Tessa Thrift / Stacy Grow); the eight Google-review excerpts foot `— Name, Google Review`. All renders follow the anonymization note at the top of this section. The verbatim texts below were transcribed on 2026-08-07 from the committed screenshots (`website/public/assets/uploads/2023/12/Review-N.png` — [¶] marks a paragraph break in the original) and are the audit source for every "Google Review" card. Screenshot meta (review counts, "N months/years ago") is relative to the capture date, not today.

**REVIEW-1 — ALISTAIR SCHNEIDER ("2 reviews" · "2 months ago") — ★★★★★ — RENDERED (row A):**
> "Ronnie is one of the best marketing specialists and leader I have encountered. [¶] His work and services have impacted many companies I worked with. His teachings and advice are profound and he understands the truths of marketing that very few understand. If you want a company looking to deliver results with you. This is the person and company you want to contact."

Rendered excerpt (first sentence + final two sentences) is unchanged from the 2026-08-06 anonymization pass, which inherited it from the legacy Replit build. Beyond the bracket policy it carries two legacy smoothings, on file here so audits don't flag them as new drift: "leader" → "leaders", and the "…with you. This is…" sentence break joined as "…with you — this is…". Any further smoothing needs operator sign-off.

**REVIEW-2 — ATARA TWERSKY (displayed "atara twersky" · "2 reviews" · "7 months ago") — ★★★★★ — RENDERED (row B):**
> "Ronnie, CEO of NoBull Marketing is the real deal. He knows what he is talking about and is super helpful!! I have interviewed many marketing companies and few of them really understand how to grow your business via social media but Ronnie does and he will honestly detail the best plan for you. If his services do not match your needs he will tell you that as well. Ronnie is a rare find who is running his business with skill and integrity! Highly recommend!!!"

Rendered excerpt is unchanged from the 2026-08-06 pass (legacy Replit build). Beyond the bracket policy it carries these legacy smoothings, on file for audit: "via social media" and "and he will honestly detail the best plan for you" dropped mid-sentence (rendered as "…grow your business — but [NoBull] does."), "a rare find who is running" → "a rare find, running", "integrity!" → "integrity.", "recommend!!!" → "recommend!". Attribution title-cases the display name ("Atara Twersky"). Any further smoothing needs operator sign-off.

**REVIEW-3 — RON BARANSKI ("18 reviews" · "8 months ago") — ★★★★★ — NOT RENDERED:**
> "Ronnie was great to discuss options and give great advice whether I used him or not. Great personality and helpful to a solo. I will update if I choose to take the next step. [¶] Update: I spent about a week vetting Ronnie and spoke to two current clients who both wholeheartedly recommended him saying he does what he promises. I did go a little different direction, but would have no reservations hiring NoBull Marketing."

Excluded from the band: the reviewer "did go a little different direction" — a vetting prospect's endorsement, not a client voice, and the band's H2 promises the firms we grow.

**REVIEW-4 — ALEC CHAPA ("4 reviews" · "a year ago") — ★★★★★ — RENDERED (row A):**
> "I'll describe Ronnie the way I'll describe him to my friends and colleagues: Ronnie is the real deal!! Let me tell you, I'll worked with a lot of folks in a lot of spaces as a consultant and Ronnie is by far one that stands out from the crowd. He's highly competent, clearly experienced, down to earth (so easy to work with), and not afraid to offer his friendly candor. That combination is hard to come by, and it's something much needed with any partner, especially something as crucial as marketing. True to the name, Ronnie offers "no bull" marketing! Highly recommend!"

("I'll worked" sic.) Rendered excerpt opens at the clause after the colon ("…is the real deal!!"), drops the "Let me tell you…" sentence and the "True to the name…" sentence (nested quotation marks); the rest is bracket-substituted verbatim.

**REVIEW-5 — ATTORNEY ANGELIK EDMONDS (display name as shown · "2 reviews" · "a year ago") — ★★★★★ — RENDERED (row B):**
> "I highly recommend NoBull Marketing for all law firm owners seeking to get honest marketing insight to increase their firm revenues. I was most impressed with Ronnie's candor and integrity. Although he could have encouraged me to sign up for a marketing plan, he instead offered thoughtful, tailor-made advice for my firm goals that could be instituted without cost. If you are considering whether or not you should make the call, do it. You will not regret it!"

Rendered excerpt drops the "Although…" sentence at its boundaries; attribution keeps the full display name "Attorney Angelik Edmonds".

**REVIEW-6 — OLUCHI IGBOKWE ("4 reviews" · "2 years ago") — ★★★★★ — NOT RENDERED:**
> "Ronnie was an absolute joy to work with. Empathetic, considerate, deliberate and result oriented. He knew exactly what he was doing and what direction he wanted to take the projects. He gave me the space I needed to work creatively and he did NOT micro manage me at all. He set realistic timelines for the deliverables and was generally very understanding. [¶] He maintains a very healthy balance between managing client expectation and leading his team. I would recommend working with Ronnie any day, any time! I know I'd love to work with him again!"

Excluded from the band: a collaborator/contractor's voice (creative space, "did NOT micro manage me", deliverable timelines) — not a law-firm client outcome.

**REVIEW-7 — JAKE CUTLER ("2 reviews" · "2 years ago") — ★★★★★ — RENDERED (row A):**
> "Ronnie was kind enough to offer to provide feedback and advice for my webpage. He is very knowledgeable. The insights he provided made sense and were actionable. I believe these insight will help us to build a more powerful message and drive more conversions. I plan to work with him again when we can get more changes in place, to better polish our page to drive better engagement. Would highly recommend."

("these insight" sic.) Rendered excerpt drops the "I believe these insight…" sentence at its boundaries; the rest is bracket-substituted verbatim.

**REVIEW-8 — JAYANTA ACHARYYA ("1 review" · "2 years ago") — ★★★★★ — RENDERED (row B):**
> "At point in time I was struggling to survive in my business. Just then I fortunately came in touch with Ronnie. And he revived my position in a few months! Everything started looking so easy! Ronnie has the uncanny ability to spot the problems and come up with permanent solutions. And he is never impatient with so many questions I ask him. Thank you, Ronnie, for everything you have done for me!"

("At point in time" sic.) Rendered excerpt opens mid-sentence at "I was struggling…" (dropping the garbled lead-in phrase) and ends after the "permanent solutions." sentence.

**REVIEW-9 — QUANTA STUDY (business account · "1 review" · "2 years ago") — ★★★★★ — NOT RENDERED:**
> "I received a free 5-minute consultation from Ronnie focused on how I can improve the landing page of my new website. In that short amount of time, he got right to the point with actionable changes and handled my follow-up questions with great care. I'd definitely be willing to book a paid call with him!"

Excluded from the band: a free-consultation reviewer under a business-name account — "willing to book a paid call" is not a client-firm outcome.

**REVIEW-10 — SUSANNAH BRUCK ("5 reviews · 2 photos" · "2 years ago") — ★★★★★ — RENDERED (row A):**
> "Ronnie is extremely knowledgeable and gives great advice. He really thinks about your individual needs and applies everything he knows to help you get results! I really appreciate his honesty and willingness to go over topics in-depth. It makes a huge difference!"

Rendered excerpt drops the second sentence at its boundaries; the rest is bracket-substituted verbatim.

**REVIEW-11 — SAM VARNERIN ("1 review" · "2 years ago") — ★★★★★ — RENDERED (row B):**
> "I'm impressed with Ronnie and his ability to learn on the spot. [¶] I asked Ronnie for advice years ago for my personal practice and was floored with the value he produced for me within months of implementing marketing necessities I've put off for months. Sure, I knew the value of those things but I had neither the expertise nor time to dive into and make these things blow up my practice. Within four months my website made the first page of Google and I was getting 100-500+ people a week looking at my website and several asking to work with me. Now I'm considered an authority in my work and it's mostly because Ronnie helped make me findable with the message I had to share. Thank you, NoBull Marketing and the work you do!"

Rendered excerpt deliberately EXCLUDES the specific-result sentences ("first page of Google", "100-500+ people a week…") — publishing them would introduce new unverified result claims (claim-ledger scope). It keeps "I asked [NoBull] for advice years ago…was floored with the value [they] produced for me." (ends mid-sentence, dropping the "within months of implementing…" qualifier), the "Now I'm considered an authority…" sentence, and the closing thanks.

**Status: NEEDS CLIENT CONFIRMATION** — same caveat as §6: the operator should confirm the underlying Google reviews are still live. The render/exclude decisions above are editorial and reversible.

---

## 5. Video Testimonial Clients

| Client name | Vimeo ID | Thumbnail asset | Status |
|---|---|---|---|
| Shields & Boris | 898391761 | `2023/12/Shields-and-Boris.png` | VERIFIED (named in source + thumbnail) |
| Covington | 701775821 | `2023/12/Covington.png` | VERIFIED (named in source + thumbnail) |
| Integrity | 898392089 | `2023/12/Integrity.png` | VERIFIED (named in source + thumbnail) |
| Presti Law | 1106263914 | `nobull-redesign/testimonials/presti-law.png` (homepage) | VERIFIED — public Vimeo title "Presti Law - Immigration Testimonial" (oEmbed, fetched 2026-08-07); homepage card added Task #3997, removed Task #4925, RESTORED Task #4980 (owner reversal — five-video endless row); firm matches the Presti case study |
| Burns Smith Law | 1106262623 | `nobull-redesign/testimonials/burns-smith.png` (homepage) | VERIFIED — public Vimeo title "Burns Smith Testimonial" (oEmbed, fetched 2026-08-07); homepage card added Task #3997, removed Task #4925, RESTORED Task #4980 (owner reversal — five-video endless row); firm matches the Burns Smith case study |

Homepage band thumbnails live in `website/public/nobull-redesign/testimonials/` (the first three are dark-still copies of the uploads above; all five render on the homepage — Task #4925 had cut the band to the first three to keep the video firms distinct from the proof band's case-study firms, and Task #4980 restored the Presti/Burns cards on the owner's reversal of that call). The Presti/Burns posters were captured 2026-08-07 from each video's own public Vimeo poster frame and finished with the same paused-player treatment (slight darken + white play chip); the Burns Smith poster carries the video's own baked-in "Coming up" title overlay — the same frame Vimeo shows publicly. Speaker names within the two new videos remain unconfirmed by the operator (firm naming is from the Vimeo titles).

---

## 6. Google Review Images

11 review screenshots at `assets/uploads/2023/12/Review-1.png` through `Review-11.png`. Full verbatim transcriptions of all 11 (reviewer display names, star ratings, text, and visible meta) were made from these files on 2026-08-07 (Task #3997) and live in the §4 Google-review register above — review text is no longer image-only. Eight of the 11 rendered (anonymized + excerpted per §4) in the #3997 homepage quote rows until Task #4925 (2026-08-18) replaced the rows with the static three-quote set of §4 written reviews — none of the 11 render anywhere now; all transcriptions stay on file as the audit source (Review-3, Review-6, and Review-9 were never rendered — reasons in the register).

**Status: NEEDS CLIENT CONFIRMATION** — operator must confirm:
1. All 11 reviews are still live and publicly visible on Google
2. The review count displayed is still accurate
3. Use of review screenshots complies with Google's Terms of Service and any applicable FTC guidelines

---

## 7. "As Seen On" Logos

Five protected media/organization-logo assets render in the homepage credibility
rail. The asset order must remain intact, but no individual organization name,
caption, or permission claim is published: the images are deliberately emitted
with empty alt text and `aria-hidden="true"` until the client confirms each
identity and its publication permission.

**Status: UNVERIFIED / OPAQUE** — do not infer identities from filenames,
asset appearance, or historical copies. Operator must provide:
- The name of each organization
- Permission or publication evidence for each "As Seen On" use
- Updated logo files if any have rebranded

---

## 8. Book

| Claim | Status | Source |
|---|---|---|
| Book title: *Revenue Engineering for Law Firms* | VERIFIED | Current site/book source |
| Author: Ronnie Deaver | VERIFIED | Current site/book source |
| Current-edition Amazon destination | NEEDS CLIENT CONFIRMATION / NOT PUBLISHED | A historical listing exists, but no client-confirmed current-edition product page is on file. Homepage and excerpt render Amazon `Coming Soon!` as a non-link. |
| Current-edition Audible destination | NEEDS CLIENT CONFIRMATION / NOT PUBLISHED | A historical listing exists, but no client-confirmed current-edition product page is on file. Homepage and excerpt render Audible `Coming Soon!` as a non-link. |
| Book cover image (`2025/01/Engineering-Book-cover.png`) | VERIFIED | Asset exists in `website/public/assets/uploads/2025/01/` |
| Exact cover PNG (`public/assets/book/law-firm-revenue-engine-cover.png`) | VERIFIED | SHA256 `fc0dd6…` per `docs/ASSET_MANIFEST.md` |

---

## 9. Brand Name and Trademark

| Claim | Status | Source |
|---|---|---|
| "NoBull Marketing was inspired by combining the concepts of 'Noble' and 'No B.S.'" | VERIFIED | `website/src/pages/about.ts` + live site |
| "NoBull Marketing™" or ® symbols | UNVERIFIED | No trademark symbols appear in any source. Do not add ™ or ® without operator confirmation of registration status. |
| "The Law Firm Experts" (logo tagline) | VERIFIED | Present in logo SVG alt text and live site |

---

## 10. Pricing

| Claim | Status | Notes |
|---|---|---|
| "campaigns starting as low as $6,000 per month (including ad spend!)" | NEEDS CLIENT CONFIRMATION | Pricing is time-sensitive; must be reconfirmed before every publish. |

---

## 11. Copyright and Date

| Item | Status | Notes |
|---|---|---|
| "© 2024 NoBull Marketing, All Rights Reserved" | OUTDATED | Footer says 2024; current year is 2026. Should be updated to either the current year or a year range. |

---

## 12. Practice Areas Served

The following 14 practice areas come from the current nobullmarketing.com
navigation and render in full on the About page. They are marketing claims
about the agency's scope — not verified client counts per area. The canonical
implementation list is `INDUSTRIES` in `website/src/html.ts`; the public
heading is exactly `Practice Areas Served`.

The header links directly to `/about/#practice-areas-served` at every
generated page depth. There is no live dropdown and no standalone
practice-area or services route. The same About page also renders the exact
20-person `TEAM_ROSTER` recorded in §3.

**Status: VERIFIED** (consistent across both sources)

1. Bankruptcy Law
2. Criminal Law
3. Environment Law
4. Family Law
5. Health Law
6. Immigration Law
7. Real Estate Law
8. International Law
9. Entertainment Law
10. Personal Injury Law
11. Estate Planning / Elder Law
12. Intellectual Property Law
13. Labor (Employment) Law
14. Tax Law

---

## 13. Awards

**None found** in any source file. If awards are added to the redesign, the operator must supply the awarding body, year, and award name before they are shown as factual claims.

---

## 14. Resource/Article Titles

The 15 canonical article titles in `website/content/articles/index.json` are
**VERIFIED** as content that exists — the JSON files are present. The legacy
`/resource/episode-13/` URL is only a cutover 301 alias to the canonical Brita
Long Episode 13 article; it is not a 16th title and must not enter the sitemap.
The specific claims within article bodies (e.g., "120+ 5-Star Google Reviews",
"Closing 30 percent attorney leads") remain the operator's responsibility to
confirm as accurate.

---

## 15. Placeholder Rules for Design

During visual design work, the following neutral placeholders must be used for any item marked UNVERIFIED or NEEDS CLIENT CONFIRMATION:

| Real element | Placeholder during design |
|---|---|
| Specific metric (650K leads, $150M revenue, etc.) | `[X leads generated]` / `[$ revenue generated]` |
| Unconfirmed guarantee | `[Performance guarantee]` |
| Unconfirmed testimonial quote | `[Client testimonial — to be confirmed]` |
| "As Seen On" logo (unidentified) | `[Media logo]` |
| Unnamed video client | `[Client name]` |
| Review count | `[N] Five-Star Reviews` |
| Pricing | `[Starting at $X/month]` |
| Award | `[Award name, Year]` |

These placeholders must not appear in any version of the site that is live or submitted for client approval as final.

---

## 16. Deck-Sourced Case Studies & System Results (Revenue Engine Sales Deck — July 13, 2026)

The client-supplied sales deck (`attached_assets/Revenue_Engine_Sales_Deck___July_13,_2026_(2)_1785952349453.pptx`) is treated as an authoritative, client-approved source — operator-provided material; precedent: the homepage proof panel shipped from it. Every figure below was read directly from the named slide (image-only slides verified visually). These figures supply proof surfaces across the site (homepage proof panel, testimonial/video material, about First Lead Records strip, and booking proof band) from the shared module `website/src/proof.ts` — the single source of truth. Individual surfaces may publish a verified subset: the homepage intentionally pairs the S34 3,600+ lead result and 292 signed-case result with the S8 400+ new-five-star-review statement, plus two Burns Smith figures and two Expansion figures, rather than publishing the complete registered stories. The owner-confirmed six-month timeframe is visibly attached only to the 292 signed-case outcome; it does not describe the separate S8 review statement. The canonical S34 200-review result and 4.8★ / 470-review listing record remain available for approved uses outside this flagship. Edit numbers in proof.ts only, with matching client sign-off. (Two proof.ts exports are deliberately NOT in this deck-sourced table: the owner-confirmed 2026-08-06 aggregates LEADS_GENERATED and REVIEWS_GENERATED, tracked in §1.)

| Claim | Deck slide | Status |
|---|---|---|
| Presti Law Firm (immigration, Dallas TX): 3,600+ leads generated; 292 cases signed; 200 five-star reviews generated; GBP 4.8★ (470 Google reviews) | 34 ("The Multiplier in Action") | VERIFIED (deck) |
| Michael Presti quote — "500 plus leads per month, 60 plus cases in a single month, and 400 plus new five-star reviews… I've never seen this kind of lead flow before." | 8 | VERIFIED (deck) |
| Burns Smith Law P.C. (family law): 3.5× lead increase in 5 months; 1,779 leads; 50 five-star reviews; monthly leads 150/250/350/450/513; Day 0 onboarding call → Day 17 launch → Day 19 first consult booked | 56 | VERIFIED (deck) |
| Zachary H. Smith quote — "We've added a new receptionist because the calls have uptick tremendously…" | 9 | VERIFIED (deck) |
| Tom Boris quotes — "…once you get everything set up, it's turnkey, it's automated." / "99% of the people I talk to compliment us on our Google reviews… that helps me close the deal…" | 10 | VERIFIED (deck) |
| Expansion play: 8-figure results in 6 months — 2,400+ leads, 228 five-star reviews, 3 locations added, first 100-case month worth $1.5M (April 2026) | 36 (framing: 35) | VERIFIED (deck) |
| First Lead Records: Presti Law (Immigration) +1 day; Burns Smith Law (Family Law) +2 days; White & Jocham (Estate Planning) +3 days; Hair Shunnarah (Insurance Defense) +1 day | 57 | VERIFIED (deck) |
| More than 2× lead growth in 90 days — live client data, ongoing Local Authority (Google Business Profile) Optimization | 19 ("The Foundation in Action") | VERIFIED (deck) |
| 8× lead growth in five months — real client account, controlled Paid Search (3,464 total leads shown) | 26–27 ("The Accelerator in Action" / "Live Case Study: 8x Leads in 5 Mo") | VERIFIED (deck) |
| Lead-to-consult rate 38.3% → 75% (+96% improvement), same lead flow, nearly twice the consultations | 44 ("CaseIntake in Action") | VERIFIED (deck) |
| Consult-to-case rate 15% → 40% (2.67× the close rate); consultations 90+ minutes → 30 or less | 51 ("CaseConvert in Action") | VERIFIED (deck) |

---


## 17. High Impact Revenue Session (Booking Offer)

Facts about the High Impact Revenue Session itself, usable in booking CTAs and reassurance copy. Name adopted sitewide 2026-08-09 (Task #4124 owner sign-off).

| Claim | Status | Source |
|---|---|---|
| The High Impact Revenue Session is free | VERIFIED | Owner confirmed directly in session, 2026-08-07 (operator-provided). Renders in the home closing-band sub-line. |
| The session is taken by NoBull's Head of Sales | VERIFIED | Owner confirmed directly in session, 2026-08-07. Home closing-band sub-line ("with our Head of Sales"). |
| The session reviews the firm's real numbers — leads, consults, signed cases, lead→consult and consult→case rates | VERIFIED | Owner confirmed directly in session, 2026-08-07. The closing sub-line renders the shortened list (leads, consults, signed cases). |
| The session produces a plan tailored to the firm's revenue goals | VERIFIED | Owner confirmed "growth goals" 2026-08-07; rewording to "revenue goals" approved Task #4124, 2026-08-09. The former homepage hero note was retired by Task #5269; the verified fact remains available to booking surfaces. |
| Session duration | NEEDS CLIENT CONFIRMATION | Not provided as of 2026-08-07 — no duration claim may be published until the operator supplies one. |

---


## 18. Owner Messaging Directives

Standing directives from the owner that govern site FRAMING (not claims or figures — those stay governed by the sections above and the claim ledger).

| Directive | Status | Source |
|---|---|---|
| **Scale-up only (website growth messaging).** The website must NEVER make the point that growth can be throttled up **or down** ("rev it up, or ease it back", "slow it down", growth as a two-way dial you own). That growth-control concept is reserved for the book (ch. 4). The website makes the opposite point: the installed engine removes the ceiling — you can scale up as much as you want. | VERIFIED | Owner directive, 2026-08-07 (operator-provided). Enforced sitewide 2026-08-08 (Task #4035): cinematic stage 04, closing-band fit list, /free-chapters/ endcap support line; governance in messaging-architecture §3 + §6 #8, claim ledger #25 (WITHHELD, book-only); regression-guarded by tests/lint-website-banned-phrases.test.ts. The published book excerpt itself is untouched — the book keeps the concept. |

---

## 19. Revenue Engine Operating Responsibilities

The approved homepage responsibility message distinguishes the firm's three operating owners from NoBull's implementation work. It must retain the decision-authority and enforcement condition without implying that the firm runs the Revenue Engine.

| Approved wording | Status | Source |
|---|---|---|
| `Your firm needs three owners: a decision-maker empowered to make and enforce the changes the engine needs, an Intake owner, and a Sales owner. NoBull does the hands-on implementation: we get campaigns live, configure and improve your CRM software, coordinate supporting vendors such as call-answering services, and measure results from first click to signed case. You keep practicing law; running the engine is our job. But the work cannot succeed if necessary decisions cannot be made and enforced.` | VERIFIED | Owner-provided delivery and responsibility requirements, 2026-08-19. Published in homepage FAQ 3; registered in claim ledger #41. |

---

## 20. Lead Tracking and Reporting

The approved homepage tracking answer distinguishes complete lead tracking and
scoring from downstream outcome visibility. It must never imply that Intake or
Sales attribution is complete when a firm's software or use of that software
cannot support it.

| Approved wording | Status | Source |
|---|---|---|
| `We use WhatConverts for complete lead tracking and lead scoring. Visibility into Intake and Sales outcomes depends on your firm's software and how consistently it is used. We go as deep as the available data allows to report outcomes and improve your marketing campaigns. Where your data can't support a precise revenue number, we say so and give you the best honest estimate instead of a guess.` | VERIFIED | Owner confirmed directly, 2026-08-19 (operator-provided). Published in homepage FAQ 5; registered in claim ledger #42. |

---

## 21. Revenue Engine Implementation Timelines

These owner-confirmed windows are typical product expectations, not contractual
guarantees. Client implementation pace is the primary timing variable, and
NoBull will move as quickly as the client enables. They do not authorize the
separately withheld generic Day 0 / Days 3–5 / Day 14 onboarding path.

| Claim | Status | Source |
|---|---|---|
| CaseGen™ is typically fully launched within 21 days and profitable within 60 days | VERIFIED | Owner confirmed directly, 2026-08-20 (operator-provided). Published in homepage FAQ 4; registered in claim ledger #43. |
| CaseIntake™ is typically launched within 90 days and in fine-tuning within 180 days | VERIFIED | Owner confirmed directly, 2026-08-20 (operator-provided). Published in homepage FAQ 4; registered in claim ledger #43. |
| CaseConvert™ is typically launched within 30 days and seeing profitable ROI within 90 days | VERIFIED | Owner confirmed directly, 2026-08-20 (operator-provided). Published in homepage FAQ 4; registered in claim ledger #43. |
| Client implementation pace is the number-one timing factor, and NoBull will go as fast as the client allows | VERIFIED | Owner confirmed directly, 2026-08-20 (operator-provided). Published in homepage FAQ 4 as the caveat governing all six milestones; registered in claim ledger #43. |
