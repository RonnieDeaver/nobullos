# NoBull Marketing x The Law Firm Revenue Engine
## Replit Design Prompt Sequence

Use these prompts in order. Do not combine them into one request. Prompts 1-3 are foundation tasks in Build/Agent. Prompts 4-12 are design tasks in Replit Design. Prompts 13-15 are implementation and quality-control tasks in Build/Agent.

## Canonical asset paths

Before Prompt 1, upload the NoBull brand ZIP, the exact book-cover PNG, and the homepage concept/mockup PNG to the Replit project.

```text
public/assets/brand/nobull-logo-full-color.svg
  <- Brand Files/NoBull Logo Package/Primary Logo/RGB (Web)/NoBull.Primary.Logo.RGB.svg

public/assets/brand/nobull-logo-reverse.svg
  <- Brand Files/NoBull Logo Package/Primary Logo/White/NoBull.Primary.Logo.White.svg

public/assets/brand/nobull-icon-crimson.svg
  <- Brand Files/NoBull Logo Package/Icon/Crimson/RGB (Web)/NoBull.Crimson.Icon.RGB.svg

public/assets/brand/nobull-icon-reverse.svg
  <- Brand Files/NoBull Logo Package/Icon/White/NoBull.Crimson.Icon.White.svg

public/assets/book/law-firm-revenue-engine-cover.png
  <- exact supplied book-cover PNG

public/assets/references/homepage-direction.png
  <- supplied long homepage mockup PNG

docs/brand/no-bull-brand-guidelines.pdf
  <- Brand Files/no.bull.brand.guidelines.pdf
```

The supplied ZIP does not contain Sweet Sans Pro font binaries. Search the existing project for licensed WOFF/WOFF2 files. Do not download an unofficial copy or use a lookalike while labeling it Sweet Sans Pro. Until licensed files are provided, use Arial as the declared fallback.

---

# Phase I: Foundation

## Prompt 1 - Ingest and protect the exact assets

```text
Use the installed Impeccable skill, but do not redesign or alter the UI yet.

Locate the uploaded NoBull brand ZIP, exact book-cover PNG, and homepage concept PNG. Extract the ZIP into a non-public source directory and create the canonical asset files below:

- public/assets/brand/nobull-logo-full-color.svg
- public/assets/brand/nobull-logo-reverse.svg
- public/assets/brand/nobull-icon-crimson.svg
- public/assets/brand/nobull-icon-reverse.svg
- public/assets/book/law-firm-revenue-engine-cover.png
- public/assets/references/homepage-direction.png
- docs/brand/no-bull-brand-guidelines.pdf

Use these exact source files from the ZIP:

- Brand Files/NoBull Logo Package/Primary Logo/RGB (Web)/NoBull.Primary.Logo.RGB.svg
- Brand Files/NoBull Logo Package/Primary Logo/White/NoBull.Primary.Logo.White.svg
- Brand Files/NoBull Logo Package/Icon/Crimson/RGB (Web)/NoBull.Crimson.Icon.RGB.svg
- Brand Files/NoBull Logo Package/Icon/White/NoBull.Crimson.Icon.White.svg
- Brand Files/no.bull.brand.guidelines.pdf

Do not redraw, trace, rasterize, recolor, distort, crop, rearrange, or replace any logo asset. Do not regenerate or edit the book-cover image.

Create docs/ASSET_MANIFEST.md with:

1. Original source path
2. Canonical project path
3. File type and dimensions
4. Allowed light/dark-background use
5. Explicit prohibited uses
6. Whether the asset is approved for immediate use

Inventory the other images in the ZIP, but do not use the headshot, office image, or social graphics without later approval.

Search the project for licensed Sweet Sans Pro WOFF or WOFF2 files. If none exist, record this in docs/MISSING_ASSETS.md and use Arial only as a temporary fallback. Do not source a commercial font from an unofficial website.

Stop after reporting which exact assets were copied and which assets or fonts are still missing.
```

## Prompt 2 - Audit the current site and create a content truth source

```text
Do not redesign or change code yet.

Audit the existing Replit app and the live site at https://nobullmarketing.com/. Create:

- docs/CURRENT_SITE_AUDIT.md
- docs/CONTENT_TRUTH_SOURCE.md
- docs/DO_NOT_BREAK.md

CURRENT_SITE_AUDIT.md must map:

- Every current route and page type
- Header and footer navigation
- Current services and product names
- Existing calls to action
- Forms, booking links, phone links, and email links
- Blog/resource structure
- Testimonials and case studies
- Client names and logo assets
- Analytics, pixels, tag-manager code, and conversion tracking
- SEO titles, descriptions, canonical tags, schema, redirects, and indexation rules
- Any CMS, API, webhook, or third-party integration

CONTENT_TRUTH_SOURCE.md must list every metric, rating, testimonial, client logo, case-study result, award, trademark symbol, and factual claim that may appear in the redesign. Mark each item VERIFIED or UNVERIFIED and cite its exact source in the current app, live site, or supplied files.

Rules:

- Never invent a law-firm logo, testimonial, result, metric, rating, client count, revenue figure, signed-case count, or trademark symbol.
- Unverified items may use neutral layout placeholders during design, but may not appear as factual claims in the final site.
- Preserve exact client and product naming.

DO_NOT_BREAK.md must identify all functionality and SEO equity that the redesign must preserve.

Stop after producing the three documents. Do not begin visual design.
```

## Prompt 3 - Lock the brand bridge in PRODUCT.md and DESIGN.md

```text
Run the installed Impeccable initialization workflow. If slash commands are available, run /impeccable init; otherwise perform the equivalent workflow manually.

This is a controlled brand-extension project, not an open-ended rebrand and not a random visual-direction exercise. Do not let a generated Impeccable seed replace the approved direction below.

Write or update PRODUCT.md and DESIGN.md using this binding brief:

PRODUCT

- Company: NoBull Marketing
- Audience: growth-minded law-firm owners, managing partners, and operators who want predictable signed-case growth
- Primary conversion: Book a Strategy Call
- Core promise: NoBull connects marketing, intake, and sales into a complete revenue system for law firms
- Parent brand: NoBull Marketing
- Flagship intellectual property: The Law Firm Revenue Engine
- Voice: direct, intelligent, commercially serious, approachable, no fluff, no exaggerated luxury language

BRAND HIERARCHY

- The site must feel 70-75% established NoBull and 25-30% Revenue Engine.
- NoBull remains visually dominant across the header, hero, proof, services, resources, closing CTA, and footer.
- The Revenue Engine adds one concentrated cinematic layer, primarily in the hero media area and one deliberate dark system band.
- The book page may use a stronger Revenue Engine ratio, but its header and footer must still clearly belong to NoBull.

EXACT PARENT PALETTE

- Crimson: #8A292F
- Earth: #524B3A
- Goldenrod: #D5AC5C
- Liberty Blue: #485696
- Eggshell: #EEE8DC

Goldenrod is an accent, not a dominant page color. Black and metallic gold are not the global company identity.

TYPE

- Primary/editorial: Crimson Pro, Baskerville, serif
- Secondary/UI/body: Sweet Sans Pro, Arial, sans-serif
- Do not silently substitute a similar font and label it Sweet Sans Pro.

EXACT ASSET RULES

- Use public/assets/brand/nobull-logo-full-color.svg on light backgrounds.
- Use public/assets/brand/nobull-logo-reverse.svg on dark or Crimson backgrounds.
- Use the approved icon files only when an icon is appropriate.
- Use public/assets/book/law-firm-revenue-engine-cover.png exactly as supplied.
- Never redraw, recolor, retype, crop, distort, rearrange, or regenerate the logo or book cover.
- A 3D book presentation must use the exact cover as the front face. Build perspective, spine, pages, and shadow around the image; do not regenerate the cover inside an AI image.

VISUAL SYSTEM

NoBull layer:
- Eggshell and warm-white backgrounds
- Crimson Pro editorial headlines
- Sweet Sans Pro supporting text and UI
- Crimson calls to action
- Earth body copy
- Liberty Blue supporting panels and headings
- Goldenrod used sparingly for labels, rules, small icons, and emphasis
- Pinstripe textures, one-pixel outlines, restrained geometry, data visualization, and clean vector illustration

Revenue Engine layer:
- Charcoal or near-black background sampled from the supplied cover
- White type and controlled metallic-gold accents
- Machinery, engineered components, subtle sparks, dimensional metal, schematic lines, and precise lighting
- No currency-tear motif outside the actual book cover
- No machinery behind every section
- No generic gold bull

GLOBAL COMPOSITION RULES

- Header and footer must unmistakably remain NoBull.
- Hero stays light; the machinery is contained on the right and fades into the light background.
- One dark system band is the visual centerpiece.
- Return to Eggshell immediately after the dark band.
- Use minimal corner radius, no pill-shaped design language, and no cards nested inside cards.
- Use hierarchy, typography, dividers, and whitespace before using a card.
- Do not use purple gradients, glassmorphism, floating glow blobs, generic SaaS icon tiles, or three interchangeable feature cards.
- Premium must come from composition, typography, material realism, and restraint - not from making the whole site black and gold.

CONTENT INTEGRITY

- Use docs/CONTENT_TRUTH_SOURCE.md as the only source for metrics, ratings, clients, testimonials, case studies, and trademark symbols.
- Use neutral placeholders when data is unverified.

Write these requirements as testable rules in DESIGN.md. Do not generate a design yet. Stop with a short summary of the locked design contract.
```

---

# Phase II: Homepage Design

## Prompt 4 - Create the first faithful homepage frame

```text
Switch to Replit Design.

Read PRODUCT.md, DESIGN.md, docs/ASSET_MANIFEST.md, docs/CONTENT_TRUTH_SOURCE.md, and docs/DO_NOT_BREAK.md before generating anything. Attach public/assets/references/homepage-direction.png as the composition reference and public/assets/book/law-firm-revenue-engine-cover.png as the exact cover asset.

Create one long-scroll desktop homepage design frame. Do not generate multiple unrelated aesthetic directions. This is a faithful execution of the approved brand bridge.

Use the supplied homepage mockup only for section order, proportions, and overall concept. Correct its known violations:

- Replace its recreated header and footer wordmarks with the exact supplied NoBull SVGs.
- Remove the generic three-dimensional gold bull from the closing CTA.
- Do not copy provisional statistics, law-firm marks, ratings, case-study results, or trademark symbols unless they are VERIFIED in docs/CONTENT_TRUTH_SOURCE.md.
- Use the actual brand typography rather than the mockup's approximate type.
- Use the exact book cover, never recreated text or machinery.

Required page sequence:

1. Light NoBull header
2. Light NoBull-led hero with the exact book on the right
3. One concentrated dark Revenue Engine system band
4. Light metrics and proof
5. Light services and case-study content
6. Verified client proof
7. Light closing CTA
8. Crimson NoBull footer

Target approximately 72% NoBull visual surface and 28% Revenue Engine visual surface. The dark visual language must feel powerful because it is contained, not because it takes over the entire page.

Use verified current-site copy where appropriate. For unverified numbers or logos, use visibly neutral placeholders such as “Verified metric pending” rather than fabricated content.

Do not build code yet. Generate the design frame and stop.
```

## Prompt 5 - Refine only the header and hero

```text
Select the approved homepage frame and refine only the header and hero. Do not change any section below the hero.

HEADER

- Eggshell or a very close warm white background
- Exact full-color NoBull logo from public/assets/brand/nobull-logo-full-color.svg
- Preserve generous clear space around the logo
- Clean, understated navigation based on the verified sitemap
- Primary CTA: Crimson background, white text, compact rectangular shape, not a pill
- Goldenrod may appear only as a small accent
- Do not introduce black or metallic gold as the header's dominant language

HERO

Use a balanced two-column composition with the NoBull message dominant on the left and the Revenue Engine property presented on the right.

Exact hierarchy:

LAW FIRM GROWTH ENGINEERED.

More Leads Aren't Enough.
We Turn Them Into Signed Cases.

- Set the headline in Crimson Pro with strong editorial authority.
- Use Liberty Blue or Earth for “More Leads Aren't Enough.”
- Use Crimson for “We Turn Them Into Signed Cases.”
- Use Goldenrod only for the eyebrow, a short rule, or a tiny directional accent.
- Set supporting copy in Sweet Sans Pro or the declared Arial fallback, colored Earth.
- Primary CTA: Book a Strategy Call
- Secondary CTA: See the System

BOOK AND MACHINERY

- Use public/assets/book/law-firm-revenue-engine-cover.png as the exact front face.
- Present it as a realistic book using perspective, a restrained spine/page treatment, and shadow around the exact image.
- Never regenerate, retype, crop, or stylize the cover.
- Behind the book, create one contained dark mechanical panel with dimensional lighting.
- Fade the machinery softly into the Eggshell hero so it never crosses behind the headline or turns the full hero black.
- Do not repeat the torn-money motif outside the cover.

TRUST PROOF

Use only verified trust proof. If a rating, review count, or client count is not verified, use a simple non-numeric statement such as “Built exclusively for law-firm growth” or omit the proof row.

The emotional result must be: NoBull Marketing created a powerful flagship system. It must not look like NoBull has become a black-and-gold machinery company.
```

## Prompt 6 - Refine only the Revenue Engine system band

```text
Select the homepage frame and refine only the Revenue Engine section immediately below the hero. Leave the header, hero, and all later light sections unchanged.

Create one full-width, deliberate charcoal-to-near-black band. This is the only section where the book's cinematic visual language fully takes over.

Use a single horizontal engineered flow on desktop, not four disconnected cards:

1. CASEGEN
   Fuel the engine with qualified demand.
   - Local Authority
   - Paid Search Control
   - Review Velocity

2. CASEINTAKE
   Capture opportunities before they leak.
   - Speed to Lead
   - Perfect Intake
   - Missed Call Recovery

3. CASECONVERT
   Turn consultations into signed cases.
   - Sales Blueprint
   - Consultation Training
   - Objection Mastery

4. SIGNED CASES
   Predictable revenue and scalable growth.
   - Use only verified outcome language
   - Do not add unverified numbers

VISUAL METAPHOR

- CaseGen: a premium crimson fuel tank or fuel-system component; if a bull emblem is used, place the exact approved icon on it rather than generating a new bull.
- CaseIntake: a machined injector or intake component.
- CaseConvert: a spark plug or controlled ignition moment.
- Signed Cases: an output gear, flywheel, or drive component.
- Show directional energy and arrows from left to right.
- Use warm metallic gold for restrained highlights, white for primary type, and very small Crimson or Liberty Blue details as a bridge to NoBull.
- Use schematic lines, pinstripes, precise measurement marks, and subtle metal texture.
- Do not place each stage in a rounded card.
- Do not use currency tears, money strips, generic gold bulls, excessive sparks, or machinery as a wallpaper.
- Keep sparks localized to CaseConvert.

The section should feel engineered, authoritative, and physically dimensional while remaining legible and concise.
```

## Prompt 7 - Refine metrics and verified proof

```text
Select the homepage frame and refine only the light proof area immediately after the dark Revenue Engine band.

Return decisively to the NoBull visual system:

- Eggshell background
- Crimson numerals
- Earth body copy
- Liberty Blue or Earth headings
- Goldenrod used only as a small line or icon accent
- Thin one-pixel dividers and restrained pinstripe details

Use docs/CONTENT_TRUTH_SOURCE.md as the only source of facts.

METRICS

- Show no more than four high-value verified metrics.
- Do not use vanity metrics merely because the mockup contains them.
- Use simple brand-colored line icons, not generic rounded icon tiles.
- If fewer than four metrics are verified, design the section around the verified number available rather than fabricating the rest.

CLIENT PROOF

- Use exact client logos only when the logo file is present and approved.
- Never invent a law-firm logo or retype a firm name to look like a logo.
- If approved logo files are unavailable, use a clean text-only client-name rail or omit the rail.
- A Liberty Blue proof band is permitted, but it must remain clearly within the NoBull palette rather than becoming another black-and-gold section.

Keep this area clean, analytical, and credible. Do not add machinery here.
```

## Prompt 8 - Refine services and case studies

```text
Select the homepage frame and refine only the services and case-study area. Keep all other sections unchanged.

Use the verified service architecture from docs/CURRENT_SITE_AUDIT.md and docs/CONTENT_TRUTH_SOURCE.md. Do not create a new offer or rename an existing service.

SERVICES

- Keep the section fully within the traditional NoBull language.
- Use Eggshell, Earth, Crimson, Liberty Blue, and restrained Goldenrod.
- Use Crimson Pro for authoritative headings and Sweet Sans Pro or Arial for supporting text.
- Avoid a row of interchangeable equal cards.
- Prefer an editorial system: one dominant service statement, numbered service rows, alternating split layouts, or a structured progression.
- Use concise outcome-led copy and clear links to the verified service pages.
- Do not use machinery or book-cover devices for every service.

CASE STUDY

- Feature one verified client result as the primary proof story.
- Use only the exact metrics, quotation, client name, and time period in docs/CONTENT_TRUTH_SOURCE.md.
- If a supporting image is not supplied, use a refined data visualization, timeline, or geometric brand composition rather than an unrelated stock skyline.
- Use a Crimson CTA to view the full case study.
- Do not create fake dashboard data or a fictional managing-partner quote.

The section should feel established, human, and commercially credible rather than cinematic.
```

## Prompt 9 - Refine the closing CTA and footer

```text
Select the homepage frame and refine only the closing CTA and footer.

CLOSING CTA

Use a light Eggshell section that reconnects NoBull to the Revenue Engine without repeating the dark system band.

Copy hierarchy:

READY TO BUILD YOUR REVENUE ENGINE?
Let's Build Your System.
Get a custom growth plan for your firm.

- Use Crimson Pro for the main line.
- Use a Crimson Book a Strategy Call button with white text.
- Use a short Goldenrod rule or small engineered accent.
- Use the exact approved Crimson NoBull icon if an icon is needed.
- Remove the generic three-dimensional gold bull from the concept mockup.
- A very subtle mechanical outline or schematic line may appear in the background, but no heavy machinery image is allowed.

FOOTER

- Use Crimson as the primary footer background.
- Use public/assets/brand/nobull-logo-reverse.svg exactly as supplied.
- Use the verified navigation, contact information, legal links, and social links.
- Use Earth or a very dark neutral only for a narrow lower copyright strip.
- Do not use a black-and-gold footer.
- Do not create a new logo lockup.
- Keep any pinstripe texture extremely subtle.

The final viewport must unmistakably return the visitor to the original NoBull brand.
```

## Prompt 10 - Create intentional tablet and mobile frames

```text
Using the approved desktop homepage as the source of truth, create one tablet frame and one mobile frame. Do not reinterpret the visual direction.

MOBILE HEADER

- Use the exact full-color logo.
- Use an accessible menu control and keep the Book a Strategy Call action easy to find.
- Preserve clear spacing and do not shrink the desktop header mechanically.

MOBILE HERO

- Keep headline, supporting copy, and CTAs first.
- Place the exact book immediately after the primary message.
- Keep the contained machinery behind or beside the book only.
- Never place machinery behind body copy.
- Keep the book cover legible and undistorted.

MOBILE REVENUE ENGINE BAND

- Convert the horizontal flow into a clear vertical engineered sequence.
- Preserve the order CaseGen -> CaseIntake -> CaseConvert -> Signed Cases.
- Use a continuous line, arrows, or energy path to maintain the system metaphor.
- Do not turn the four stages into generic card tiles.

LIGHT SECTIONS

- Stack metrics and content intentionally.
- Preserve one-pixel dividers, comfortable reading measure, and clear type hierarchy.
- Keep body text readable without excessive center alignment.

QUALITY

- No horizontal overflow
- No clipped logo, book, or machinery
- No text below a comfortable functional size
- Clear focus states and touch targets
- Buttons must not become full-width by default unless it improves the mobile hierarchy

Create the two responsive frames and stop for review.
```

---

# Phase III: Full Site System

## Prompt 11 - Create the commercial page templates

```text
Use the approved homepage and DESIGN.md as the binding system. Create separate desktop design frames for:

1. Solutions overview
2. Individual service-detail template
3. Results/case-study index
4. Individual case-study template

Rules:

- Reuse the approved exact header and footer.
- Keep these pages approximately 80% traditional NoBull and 20% Revenue Engine at most.
- Use the dark Revenue Engine treatment only when explaining the connected marketing-intake-sales system.
- Do not use machinery as a default page hero.
- Use verified page names, routes, offers, testimonials, and results from the audit.
- Use editorial hierarchy and structured content rather than grids of repeated rounded cards.
- Each page must have one clear primary conversion path to Book a Strategy Call.
- The service-detail template must work for every verified service without requiring a new visual identity for each one.
- The case-study template must prioritize evidence, methodology, timeline, and verified outcomes.

Generate the four frames and stop before building.
```

## Prompt 12 - Create the brand, editorial, book, and contact templates

```text
Use the approved homepage and DESIGN.md as the binding system. Create separate desktop design frames for:

1. About page
2. Resources/blog index
3. Article/resource detail template
4. The Law Firm Revenue Engine book landing page
5. Book a Strategy Call/contact page

Rules by page:

ABOUT
- Warm, human, credible, and predominantly Eggshell.
- Use approved real photography only.
- No machinery except a very small system reference if relevant.

RESOURCES AND ARTICLE
- Editorial NoBull design led by Crimson Pro.
- Strong reading measure, clear categories, and restrained dividers.
- No cinematic machinery backgrounds.

BOOK LANDING PAGE
- This is the one page allowed a more balanced NoBull/Revenue Engine split, approximately 50/50.
- Keep the exact NoBull header and Crimson footer.
- Use the exact book cover prominently.
- Use cinematic machinery in contained sections, not behind every block.
- Do not copy the torn-money motif outside the cover.
- Clearly connect the book to NoBull's services and strategy call.

CONTACT / STRATEGY CALL
- Light, direct, high-trust, and low-friction.
- Preserve the verified booking or form flow.
- No dark luxury treatment around the form.

Generate the five frames and stop before building.
```

## Prompt 13 - Extract and formalize the approved design system

```text
Create or update the Replit design system from the approved homepage and page-template frames. Treat the approved frames, PRODUCT.md, and DESIGN.md as the authority.

Formalize:

- Exact color tokens and semantic roles
- Light NoBull surface system
- Revenue Engine dark-surface system
- Typography families, weights, scale, line heights, and fallbacks
- Spacing scale and content widths
- Grid and responsive breakpoints
- Border, divider, pinstripe, outline, and texture rules
- Minimal radius and elevation rules
- Button, link, form, and focus states
- Header and footer specifications
- Hero variants
- Revenue Engine stage component
- Metrics and data-visualization patterns
- Service layout patterns
- Case-study layout patterns
- Testimonial and client-proof patterns
- Closing CTA pattern
- Image and photography rules
- Exact logo and book-cover usage
- Content-integrity rules

Document the 70-75% NoBull / 25-30% Revenue Engine rule as a global composition constraint, including the book-page exception.

Do not introduce new brand colors merely because they appear in a generated frame. Any supporting charcoal, steel, or metallic values must be sampled from the approved book direction, documented as secondary Revenue Engine neutrals, and forbidden from replacing the parent palette.

Update DESIGN.md so a future Agent can implement the system without seeing the original prompts. Stop after showing the final token and component summary.
```

---

# Phase IV: Build and Quality Control

## Prompt 14 - Apply the approved homepage to the existing app

```text
Switch to Build. Create a git checkpoint before changing the interface.

Apply the approved homepage design to the existing app. Do not create a parallel replacement app and do not rewrite the project stack unless technically necessary and explicitly reported.

Before coding, read:

- PRODUCT.md
- DESIGN.md
- docs/ASSET_MANIFEST.md
- docs/CONTENT_TRUTH_SOURCE.md
- docs/DO_NOT_BREAK.md
- docs/CURRENT_SITE_AUDIT.md

Implementation rules:

- Preserve all verified routes, links, forms, booking flows, analytics, pixels, schema, metadata, redirects, and integrations.
- Use the exact SVG logo files directly from the canonical paths.
- Use the exact book cover as an image. Build the three-dimensional book effect with CSS or layout geometry around the image; never regenerate the cover.
- Implement design tokens as CSS variables or the project's existing token system.
- Build reusable components rather than hard-coding one-off sections.
- Use only verified content. Omit unverified claims rather than publishing placeholders.
- Preserve semantic headings, keyboard access, visible focus states, and responsive behavior.
- Optimize images without altering the visible logo or cover.
- Do not change interior pages yet, except for shared header/footer components required by the homepage.

After implementation, compare the built homepage against the approved desktop, tablet, and mobile frames. Stop and report any visual or technical deviations before proceeding to the remaining pages.
```

## Prompt 15 - Build the remaining templates and run the final audit

```text
Using the approved Replit design system and the implemented homepage components, apply the approved templates to the remaining verified routes.

Preserve page content, URLs, SEO metadata, structured data, forms, resource archives, and integrations. Do not force every page into a cinematic Revenue Engine treatment.

After implementation, use the installed Impeccable skill to run:

1. A visual critique
2. An accessibility and responsive audit
3. A polish pass
4. The deterministic detector against the frontend source directory

Also perform a manual brand-fidelity audit at wide desktop, standard desktop, tablet, and mobile widths.

Verify:

- Every displayed logo references an exact approved file
- Full-color logo appears only on appropriate light backgrounds
- Reverse logo appears on Crimson or dark backgrounds
- No generic gold bull exists anywhere
- The exact book cover remains unchanged and legible
- No generated or retyped cover text exists
- The site remains approximately 70-75% NoBull and 25-30% Revenue Engine outside the book page
- The hero remains light
- The dark Revenue Engine band remains the single major cinematic centerpiece
- The footer remains Crimson and clearly NoBull
- No unverified metric, rating, testimonial, law-firm logo, case-study result, award, or trademark symbol appears
- Sweet Sans Pro is used only when licensed webfont files are actually present
- No nested cards, pill saturation, generic icon tiles, purple gradients, glassmorphism, or decorative glow clutter
- No horizontal overflow, clipped content, inaccessible contrast, missing focus state, or broken mobile navigation
- Existing tracking, forms, SEO, and redirects still function

Fix all actionable findings, rerun the detector, and produce docs/FINAL_DESIGN_QA.md documenting what was checked, what was fixed, and any remaining exceptions.
```

---

# Brand-drift correction prompt

Use this immediately when a generated frame becomes too black-and-gold, replaces the logo, or starts looking like a generic luxury/AI site.

```text
Stop and correct brand drift without changing the approved information architecture.

The current frame is over-weighting The Law Firm Revenue Engine and under-weighting NoBull Marketing. Rebalance it to the binding 70-75% NoBull / 25-30% Revenue Engine ratio in DESIGN.md.

Corrections:

- Restore Eggshell/warm-white as the dominant page surface.
- Restore Crimson, Earth, Liberty Blue, and restrained Goldenrod as the dominant company palette.
- Use black, charcoal, metal, and gold only in the contained hero media area and the one Revenue Engine system band.
- Replace every recreated or generated logo with the exact canonical NoBull SVG.
- Remove every generic gold bull.
- Restore Crimson Pro and Sweet Sans Pro/Arial typography.
- Remove machinery from ordinary proof, service, resource, and footer sections.
- Remove torn-currency motifs outside the exact book cover.
- Replace generic rounded cards, pills, glows, and icon tiles with typography, dividers, outlines, and editorial composition.
- Remove any unverified metric, logo, testimonial, result, rating, or trademark symbol.

Do not invent a new direction. Correct the selected frame to match the approved NoBull brand extension.
```
