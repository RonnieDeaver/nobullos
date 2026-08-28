# Website Copy Audit — pre-overhaul findings (2026-08-06)

Route-by-route audit of the marketing site (`website/`) before the
Revenue Engine copy overhaul. Per-route: purpose, current H1/CTA, and
what is vague, unsupported, outdated, or missing. Companion docs:
`website-messaging-architecture.md`, `website-claim-ledger.md`,
`website-final-copy.md`, `website-copy-changelog.md`.

**Archive boundary (reconciled 2026-08-20):** This file preserves the
2026-08-06 baseline. Words such as "current" and the inventory immediately
below describe that historical snapshot, not the live generator contract.
Current truth lives in `website-final-copy.md`: About owns the complete
20-person team and `Practice Areas Served` list; the header links there
directly; `/services/` and `/testimonials/` are retired routes that return the
branded 404; the homepage/footer own the surviving product and proof anchors.

## Historical route inventory (2026-08-06; not current)

`/` · `/about/` · `/services/` · `/testimonials/` · `/resources/` ·
`/book-free-demo/` · `/privacy-policy/` · `/unsubscribe/` · 404 ·
15 articles under `/resource/<slug>/`. Shared chrome: header + footer
(`website/src/html.ts`) and a self-chromed homepage duplicate
(`website/src/pages/home.ts` — must be fixed in BOTH places).

## / (homepage — `website/src/pages/home.ts`)

- Purpose: tell the whole argument. Currently: hero → press → cinematic
  (#system) → metrics → proof → testimonials → book → team → closing →
  contact/FAQ.
- Hero: H1 locked & correct. Eyebrow missing the comma ("LAW FIRM GROWTH
  ENGINEERED." → "LAW FIRM GROWTH, ENGINEERED."). Lede is generic agency
  copy ("helps law firms scale with proven systems… that consistently
  deliver results") — says nothing the argument needs (leads→cases).
- Missing narrative sections entirely: the problem (Million Dollar Gap),
  implementation, growth control, differentiator, qualification. The
  page jumps from credibility straight into the system with no
  problem-frame, and from proof straight to the book.
- Metrics band: "650,000+ Leads Generated" and "$150M+ In New Client
  Revenue" are unverified (ledger #16–17); "300+ Law Firms Grown"
  contradicts the deck's 350+ (ledger #13).
  - Update 2026-08-06 (Task #3907): the leads total is resolved — the
    owner directly confirmed **1,000,000+ leads generated** (ledger #16,
    now LIVE on the band) plus a new **30,000+ five-star reviews
    generated** aggregate (#35). $150M+ (#17) remains withheld.
- Proof panel: correct (proof.ts), but quote is truncated inline rather
  than imported; body copy above it is thin ("We build systems that
  deliver measurable, predictable growth.").
- FAQ: "we WILL make you money, or we work for free until we do" —
  banned guarantee (ledger #30).
- Book section: correct title, generic support copy; "READ THE FIRST 2
  CHAPTERS FREE" is an Amazon search link (ledger §5).
- Footer (self-chromed duplicate): legacy solutions list — Case
  Generation / Perfect Intake / Sales Conversion / Revenue Engineering.
- Cinematic kicker reads "THE REVENUE ENGINE SYSTEM" (near-legacy name);
  stage copy itself is on-message but CaseGen details use short subsystem
  names and the CaseConvert line doesn't use the standardized phrasing.
- Closing: fine emotionally but vague ("Let's Build Your System." /
  "Get a custom growth plan"); no qualification before it.

## /about/ (`about.ts`)

- Purpose: company story + Noble/No B.S. origin + team. Origin story IS
  present and good (kept).
- FAQ 1 repeats the banned "work for free until we do" guarantee.
- FAQ 3 says "book a free demo" twice.
- Ronnie bio: "generated over 650,000 leads and $150 million" —
  unverified (ledger #16–17); bio ends mid-sentence ("…National
  Association of Divorce Professionals" — no period, truncated).
- Team block lists 3 people with roles that contradict the homepage
  team grid (Jake "Senior Digital Marketing Coordinator" vs "Sr.
  Marketing Engineer"; Oliver "Head Google Ads PPC Specialist" vs "Head
  of Operations"). Homepage grid is current org — reconcile.
- Legacy heading "Industries Served" was serviceable but has been rewritten
  to the sitewide `Practice Areas Served` naming; First Lead Records strip is
  deck-correct (keep).
- calendlyBand default heading "Book a Free Demo" + eyebrow "Get
  Started" (banned) flow through here.

## /services/ (`services.ts`) — RETIRED

- Historical finding: this page should have presented the three products as one engine.
  It was a "Google playbook" page (Google My Business / Google Ads /
  Monthly Webinars) — pre-Engine architecture, no CaseGen/CaseIntake/
  CaseConvert naming anywhere.
- Intro: "Over 500,000 Google Leads generated" (unverified, conflicts
  with 650K) + "Guaranteed Profitable in 3 months or less, or it's
  free!" (banned guarantee).
- The standalone page and its row copy retired on 2026-08-19. The proof
  exports remain only for their independently legitimate live surfaces.
- The three "Book a Free Demo" buttons retired with the page (the label was
  already banned).
- The retired services-page "Beyond Lead Generation" section and its
  CaseIntake/CaseConvert before/after cards were removed without relocation.
- The services title/meta and their 500K claim surface retired with the page.

## /testimonials/ (`testimonials.ts`)

- Purpose: structured case studies + client voice. Structure is already
  strong: video wall, three case-study cards (Presti / Burns Smith /
  Expansion — all proof.ts), quote wall with deck quotes.
- Case-study cards lack the brief's constraint→mechanism framing in
  their body copy (results are there; the "what was broken / what we
  installed" line is missing).
- Title "Client Testimonials - NoBull Marketing" fine but generic; H1
  band is "Testimonials" while nav calls it "Results".
- calendlyBand legacy default flows through.

## /book-free-demo/ (`demo.ts`)

- Purpose per brief: strategy-call page that reduces next-step
  uncertainty, same URL. Currently titled/H1'd/meta'd "Book a Free
  Demo" with "Revenue Engineering System" in meta + sub, eyebrow "Get
  Started" (banned).
- Proof band above Calendly is deck-correct (keep pattern).
- Nothing tells the visitor what happens on/after the call (S55
  onboarding path is available and verified) — the main uncertainty
  reducer is missing.
- Contact form: fine; button "Send Message" acceptable.

## /resources/ (`resources.ts`)

- Purpose: library index. Fine structurally (tabs + grid). Title/meta
  serviceable; calendlyBand default flows through. Article cards show
  junk excerpts (see articles).

## /resource/<slug>/ — 15 articles (`article.ts` + content JSONs)

- Sidebar CTA: "Book a Free Demo" (banned).
- ALL 15 index excerpts and ALL 15 metaDesc fields are junk ("Jan 4,
  2024 | Articles" / "| Podcasts" etc.) — meta descriptions literally
  duplicate the date row.
- `.co` links: episode-15 (lilaw.co is legit external — verify) and the
  webinar article + episode-15 contain `nobullmarketing.co` links.
- "cracking-the-code…" article body contains a "free demo" CTA phrase.
- Naming: articles predate the Engine; body copy uses generic
  "marketing" framing — acceptable educational content per brief; only
  corrected naming / CTAs / links / metas needed, no gutting.
- Podcast episodes are interview writeups — keep, fix metas.

## /privacy-policy/ (`legal.ts` + `content/privacy.json`)

- Body links to `https://nobullmarketing.co` (wrong TLD).
- Check effective date/© year during edit; substantive terms left
  untouched (flag-only policy).

## /unsubscribe/ (`legal.ts`)

- Button label "Submit" (banned). Otherwise fine.

## 404 (`legal.ts`)

- Fine ("Back to Homepage" descriptive CTA). No changes needed beyond
  keeping title/meta unique (already unique).

## Historical shared-chrome findings (`html.ts`)

- Footer SOLUTIONS list is the old architecture: Case Generation /
  Perfect Intake / Sales Conversion / Revenue Engineering (as products).
- calendlyBand: default heading "Book a Free Demo", eyebrow "Get
  Started", generic sub ("Schedule a time to meet with our team…").
- Header: CTA label already "BOOK A STRATEGY CALL" ✓; nav "Solutions" →
  `#system` ✓.
- Old-edition book constants (AMAZON_BOOK_URL/AUDIBLE_BOOK_URL with
  "Revenue-Engineering-Law-Firms-Skyrocket") remain — unused by current
  pages? (homepage uses its own search links; no page imports them —
  verify at implementation; destinations owned by Task #3855.)
- OG image is the old brand banner (`NoBull-Marketing-The-Law-Firm-
  Experts-bg.png`) — acceptable; not a copy item.

## Historical cross-site findings

- CTA labels inconsistent: "BOOK A STRATEGY CALL" (header) vs "Book a
  Free Demo" (services/article/calendly band/demo H1).
- No page ever states the three-line product ladder; the words
  CaseGen/CaseIntake/CaseConvert appear ONLY inside the homepage
  cinematic.
- Titles/metas: unique but several carry unverified claims or legacy
  names; articles' metas are junk.
- One H1 per page: holds everywhere today (titleBand/h1 structure);
  preserve through rewrite.
