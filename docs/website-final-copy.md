# Website Final Copy — decided version (2026-08-06)

One decided version per page/section. Implementation applies THIS copy;
numbers marked `[proof.ts:EXPORT]` render from `website/src/proof.ts`.
Rules: `website-messaging-architecture.md`. Sources: `website-claim-ledger.md`.

---

## Homepage `/`

**Title:** `NoBull Marketing — Law Firm Revenue, Engineered` (Task #4120 revenue-first sweep; was `…Law Firm Growth, Engineered`. The on-page hero eyebrow now matches: the owner ADOPTED `LAW FIRM REVENUE, ENGINEERED.` in the changelog flag resolution — Task #4124, 2026-08-09; doc reconciled Task #4195)
**Meta:** `More leads aren't enough. NoBull Marketing installs The Law Firm Revenue Engine™ — more revenue from the same leads, measured from first click to signed case.` (Task #4120; Task #4122 reconciled this record to the rendered meta — the shipped wording keeps the description ≤160 chars and leaves the Marketing/Intake/Sales one-system claim to the hero lede, its owning surface)

Section order (Task #3895 storytelling arc — Hook → Problem → Belief
shift → Mechanism → Proof → Plan → Who → Ask; the arc's **Score** beat
left with the REE strip, REMOVED by Task #4987; Task #4261
owner doc §2 leads with outcomes; Task #4816 — 2026-08-14 owner-endorsed
feedback — pulls the cinematic ~two screens earlier: the engine reveal
IS the differentiator, so the page no longer teaches the REE scorecard
or shows tuned results before the visitor reaches it. #4816 deliberately
supersedes the #4259 REE-before-cinematic arrangement, the #4259 gap
bridge paragraph, and the #4259 ribbon placement; Task #4837 — 2026-08-17 owner decision,
"I would remove the cinematic entirely" — retires the pinned cinematic
AND the §2c ribbon in favor of the §4 normal-scrolling engine story):
hero → credibility
rail (§6 — press logos + the four outcome aggregates merged into ONE
compact band, Task #4816; outcome-first order since Task #4261) →
Million Dollar Gap (closes on the handoff DIAGNOSIS line since Task
#4923 — owner brief 2026-08-18 §3: the #4816 kicker retired with the
DELETED #4837 handoff transition band, the #4259 bridge body was
already retired, and the band's warm tail now flows straight into the
§4 overview; the OPEN THE HOOD cue + light→dark seam had retired with
the cinematic) → product section
(§4, Task #4992 single-funnel redesign, owner brief 2026-08-18 — ONE
continuous top-down funnel object replaces the #4837/#4923/#4924
engine story wholesale: eyebrow + H2 open directly on the funnel —
three stacked touching angle-edged stages, CaseGen/MARKETING →
CaseIntake/INTAKE → CaseConvert/SALES, narrowing into the gold
SIGNED CASES plaque — then the section's single session CTA; the
charcoal overview, the three component sections with their receipts,
the sticky index rail, and the customization band are ALL RETIRED,
the receipt figures remain only in the `/data-notes/` provenance table
after the standalone services-page retirement) → proof
(Presti flagship case study + two support cards + post-proof session
CTA + two-sentence measurement disclosure, Task #4925 — the #4261
case-study slider retired; the REE strip that followed the proof band —
#4120 the single sitewide REE introduction, compressed #4816, cut to
its terminal four beats by #4925 — was REMOVED wholesale by Task #4987,
owner decision: zero REE mentions on the homepage, so the score is
introduced sitewide only on /calculator/ now) →
endless video testimonials/quotes (5 + 11, Task #3997 — #4925's
static 3 + 3 curated set reversed by Task #4980: the marquee rows
drift again for motion-allowed visitors, the served grids stay the
complete no-JS/reduced-motion fallback) →
team (FULL 18-person roster band, Task #4979 owner directive — led by
Ronnie → Oliver → Brett → Jeff → Janno → Cam, the rest in prior
relative order; the #4903 endless wall RESURRECTED for motion-allowed
visitors, the served 18-card grid = the complete no-JS/reduced-motion
fallback; NO in-band CTA and no About roster link — supersedes the
#4926 five-person compression) →
fit (nb-fit, Task #4926, brief §12 — the fit / not-a-fit verdict cards
re-homed out of the closing band, both lists rewritten to the brief) →
FAQ (nb-faq-sec, Task #4926, brief §13 — cut to six buying questions) →
book (#book — the intact lower-commitment handoff now sits after FAQ and
before the final conversion close) →
conversion close (bull + `Ready to Build Your Revenue Engine?` display
heading + review-close lede + supporting line, followed immediately by
the booking-first `#booking` / `#contact` grid; the standalone close CTA
and booking/message chooser are retired) →
 footer (Contact link; a filled `Book a High Impact Revenue Session →`
 primary sits beside the outlined `Read the Book →` secondary. The five
 direct booking placements are header, hero, product funnel, after proof,
 and footer; the header's desktop/mobile twin makes six `#booking`
 anchors. The footer's `OUR SERVICES` column keeps
`The Revenue Engine™` as the overall product-section entry with href
`#system`, while `CaseGen™`, `CaseIntake™`, and `CaseConvert™` use
hrefs `#casegen`, `#caseintake`, and `#caseconvert` to name their
 individual Marketing, Intake, and Sales stages. The session action no
 longer appears as a low-emphasis link in the `COMPANY` column).

### 1. Hero (locked)
- Eyebrow: `LAW FIRM REVENUE, ENGINEERED.` (owner adopted the revenue-first rewording — Task #4124, 2026-08-09; reconciled here Task #4195. The "locked" GROWTH wording is history only — do not revert.)
- H1 (unchanged): `More Leads Aren't Enough. We Turn Them Into Signed Cases.`
- Lede (Task #4923, owner brief 2026-08-18 §1 — build-and-manage framing, revenue measured at every stage; deviation: house-style spaced em dash replaces the brief's closed `case—and`): `Most agencies stop at the lead. NoBull builds and manages the Marketing, Intake, and Sales systems that move qualified prospects from first click to signed case — and measures the revenue produced at every stage.` (retired #4120 lede — was `Most agencies stop at the lead. NoBull installs The Law Firm Revenue Engine™ — Marketing, Intake, and Sales working as one system, measured from first click to signed case.` — the ™ engine naming stays with the meta description — since Task #4992 the §4 funnel eyebrow renders THE LAW FIRM REVENUE ENGINE unmarked.)
- Primary CTA: `Book a High Impact Revenue Session →` (Task #4261, owner doc §4 — ONE primary CTA language everywhere: header/menu, hero, post-proof, team ask, and closing all carry the full session phrase; source/DOM is title case and `.nb-btn`/`.btn` chrome renders it uppercase — never hyphenate "High Impact". Was `BOOK YOUR SESSION →`, the Task #4124 sitewide short label reconciled Task #4195; before that `BOOK A STRATEGY CALL →`.) · Secondary: `Read the Book →` (→ `/free-chapters/`; Task #5017, owner request 2026-08-18 — the hero pair feeds the book funnel (cover → free chapters → session, owner doc §3) and the hero no longer links `#system` (header Solutions + footer OUR SERVICES Revenue Engine link keep it reachable). Source/DOM is title case; the `.nb-btn-outline` chrome uppercases. Label history: was `SEE THE THREE CORE COMPONENTS →` (#4923, named the then-#system destination) and `SEE THE SYSTEM →` before that. Rendered as a clearly clickable OUTLINED button since Task #4816, owner feedback: the quiet text link read as decoration; the filled session CTA stays visually dominant)
- Session-explainer note (`.nb-hero-note`, one quiet line under the CTA pair saying what the session is): `A free working session to build the plan for making your revenue goals a reality.` (the approved live use of ledger #36's verified plan-shaped-to-revenue-goals promise; "free" also rides that row. It adds no duration, guaranteed outcome, pricing recommendation, or handed-over-artifact promise.) RETIRED hero note: `A free working session to identify what is limiting signed cases and what should be fixed first.` (the former constraint-first framing, Task #5063, 2026-08-19).
- Trust line: REMOVED (Task #4816 — the credibility rail directly below the hero now carries the $150M+ and 350+ figures ONCE; ledger #17/#13 wording rules live on there. Retired rendered copy for the record: `✓ $150M+ in new client revenue — across 350+ law firms we've worked with` — Task #4165, owner confirmed the $150M+ aggregate in session 2026-08-09; combined [proof.ts:REVENUE_GENERATED] with the [proof.ts:CLIENTS] figure in its mandated cumulative framing — never phrase the firm count as active clients. It had replaced `✓ 350+ law firms grown`, which had replaced the vague "Trusted by law firms across the U.S.")
- Hero book cover (Task #4262, owner doc §3 — book-funnel entry): the cover art on the hero's dark side is a subtle LINK → `/free-chapters/` (aria-label "Read the first two chapters of The Law Firm Revenue Engine — free" — the content promise points at the real on-site excerpt, satisfying the ledger's book-content-CTA rule). The machinery art/shadow/reflection stay decorative (aria-hidden per layer); the affordance is hover/focus rim light + a gold keyboard-focus outline only — geometry untouched, and the hero's PRIMARY action remains the session CTA on the copy side.
- Connection line (Task #4262, owner doc §3 — the doc's first approved option): `The book explains the system. NoBull installs it.` — quiet serif-italic caption on the dark floor beneath the cover (`.nb-book-caption`), deliberately a caption and never a competing headline; it names the book's role at the funnel's entry.


### 2. The Million Dollar Gap (duel chart Task #3904; $1,000,000 model rework Task #3936; de-dupe + redesign Task #3949; two-column compress + gain-framed payoff Task #3991; leak→fix strip restyled scannable Task #4031, then FOLDED into the chart captions Task #4166; narrative bridge — priced H2, system-tagged rows, handoffs closer — Task #4259; §3 simplification Task #4923 — priced lede, stage-only rows, diagnosis-line closer, standalone handoff band deleted)
- Eyebrow: `THE MILLION DOLLAR GAP`
- H2: `Same 500 Leads. $1,000,000 Apart.` (Task #4259 owner direction — the H2 now PRICES the gap, both figures GAP_MODEL-templated so the generate-time arithmetic check guards them; was `Same Leads. Very Different Firm.`, replaced Task #4259)
- Support (Task #4923, owner brief 2026-08-18 §3 — the tighter setup prices the gap in one breath; keeps the visible "Picture two firms" hypothetical cue that carries the model label in rendered copy, claim-ledger row 19 — the brief's setup dropped the cue, deliberately restored, and the brief's "$1 million" renders `$1,000,000` (house style, matches the H2/receipt); prior forms retired — the #4259 lede was `Picture two firms: one turns 500 qualified leads into 20 signed cases; the other turns the same 500 into 120. The difference isn't lead volume. It's what happens between the lead and the signed case.`; the pre-#4259 one-sentence form was `Picture two firms generating the same 500 qualified leads — one leaky, one tuned.`, replaced Task #4259): `Picture two firms with the same 500 qualified leads. One signs 20 cases. The other signs 120. At a $10,000 average case value, that is a $1,000,000 difference without generating one additional lead.` [proof.ts:GAP_MODEL — owner-provided figures 2026-08-06 (Task #3936; supersedes the deck-S6 ×5 scaling); the old number-narrating paragraph was compressed in Task #3949, and Task #4259 deliberately superseded the #3949 numbers-land-once rule for the HEADLINE figures only — the H2 prices the leads + the gap and the lede (since #4923) walks leads→cases→case value→gap for both firms, while the consults pair and the revenue duel still land only in the chart/receipt and the receipt still PROVES the $1,000,000 the H2 poses; the visually-hidden `.nb-vh` summary — still fully GAP_MODEL-templated — names the STAGES only since #4923 (Marketing / Intake / Sales — brief §3 keeps product names out of the problem illustration; the #4259 stage→system attributions left with the visible row tags, themselves now stage-only `MARKETING` / `INTAKE` / `SALES`) and speaks the complete model (100→20 vs 300→120 consults/cases, 6× the clients, $200,000 vs $1,200,000, an extra $1,000,000 from the same lead flow — tail reframed gain-side in Task #3991, in lockstep with the receipt caps) to screen readers while the chart + receipt stay aria-hidden; distinct from the Presti client result the 500-lead figure coincidentally echoes; Task #4166 appended one closing sentence to the `.nb-vh` summary — `The leaks: missed calls and slow follow-up before the consult, a weak consult offer and too much friction after it.` — the four leak names' accessible home after the trade-strip fold]
- Duel chart + payoff receipt (the numbers' ONE visible home since Task #3949; paired side by side in the two-column `.nb-gap-cols` since Task #3991 — chart left, receipt right, stacked ≤850px — with `aria-hidden` on the wrapper; the visually-hidden summary after the support line is their accessible copy): `THE LEAKY FIRM` (crimson bars, leftward) vs `THE TUNED FIRM` (gold bars, rightward) over `SAME 500 LEADS IN`; stages `QUALIFIED LEADS 500|500 → CONSULTS BOOKED 100|300 → CASES SIGNED 20|120` (stage labels ride centered above each bar pair since Task #3991 — the 170px center spine column is gone so bars stay legible at half width; the Task #4259 system tags above each stage label — `CASEGEN™ · MARKETING` / `CASEINTAKE™ · INTAKE` / `CASECONVERT™ · SALES` — RETIRED to stage-only labels by Task #4923 (`MARKETING` / `INTAKE` / `SALES`; since Task #4992 no homepage surface pairs a product name with its department), while the revenue line's attribution stays the receipt itself); per-stage shortfall captions compare the two firms with each other (ghosts span leaky tip → tuned same-stage tip, never framed against 100% conversion) and since Task #4166 carry the leak names the retired trade strip used to own: `200 fewer consults booked — missed calls, slow follow-up` / `100 fewer cases signed — weak consult offer, too much friction`; payoff receipt `6×` + `THE CLIENTS`, then `$200,000 vs $1,200,000` + `AT A $10,000 AVERAGE CASE VALUE`, then `AN EXTRA` + `$1,000,000` + `FROM THE SAME LEAD FLOW` (Task #3991 reframe — the money moment reads top-to-bottom as the tuned firm's upside and the figure lands gold-ink, retiring the crimson `OPENED ENTIRELY AFTER THE LEAD` loss cap; Task #3949 de-dupe still holds: the clients cap doesn't restate the `SAME 500 LEADS IN` head tag, and no cap restates the eyebrow — each fact lands once)
- Trade rows — FOLDED (Task #4166; the #4031 `WHERE IT LEAKS` → `HOW IT'S TUNED` ledger strip no longer renders): the four leak names now ride the duel chart's own shortfall captions (two per caption, above) and the `.nb-vh` summary's closing sentence; the fix answers left visible copy entirely — the §4 product section names every fix lane (respond/recover = CaseIntake™, offer/structure = CaseConvert™ — capability stacks since Task #4295, carried through the #4837 component sections into the #4992 funnel's capability lines), so the strip restated what §4 delivers moments later. Retired pair copy for the record: `Missed calls → Every call answered` · `Slow follow-up → Follow-up in minutes` · `Weak consult offer → Consults built to close` · `Too much friction → Signing made effortless`. Do not rebuild the strip.
- Microcopy under rows: REMOVED (Task #3936) — the `Illustrative model — the same math we diagnose on a strategy call.` caption no longer renders
- Closer — the handoff DIAGNOSIS line (Task #4923, owner brief 2026-08-18 §3: the band now ENDS on the diagnosis — the sentence that opened the deleted §4(a) standalone handoff band — upright serif caps with only `HANDOFFS` in oxblood, keeping the #3991 treatment: centered, full band width, last copy in the band under a lone gold rule): `THE MILLION-DOLLAR OPPORTUNITY DIES IN THE HANDOFFS BETWEEN MARKETING, INTAKE, AND SALES.` — the band closes by diagnosing WHERE the opportunity dies and flows straight into the §4 #system overview (no transition band between them since #4923). Closer history: the #4816 kicker `The Million-Dollar Gap lives in the handoffs.` (`handoffs` in the tuned firm's gold-ink) retired with the handoff band; Task #4816 had retired the #4259 bridge BODY per the 2026-08-14 owner-endorsed feedback (the engine story sat directly below and demonstrated the three-system chain itself, so the paragraph pre-narrated it). Retired bridge body for the record (rendered #4259–#4816): `Marketing creates qualified opportunity. Intake turns that opportunity into booked consultations. Sales turns consultations into signed clients. Together, those three systems form the Law Firm Revenue Engine™.` — its three-function chain survives in the §4 funnel's stage progression (the hero lede names the three systems; since Task #4992 the ™ engine naming lives with the meta description — the funnel eyebrow renders unmarked). (Kicker history: the retired #3949 kicker was `Both firms had the fuel. Only one had the engine.` — it had replaced `Your next $1,000,000 isn't in more leads — it's in the leads you already have.`, which read as "firms don't need more leads" and undermined the lead-gen offer; that line had itself replaced `Guessing creates activity. Diagnosis creates growth.` in Task #3936.)
- Tail hand-off — RETIRED (2026-08-17, Task #4837; its §4(a) successor DELETED 2026-08-18, Task #4923): the `OPEN THE HOOD ↓` cue and the light→dark seam went with the cinematic they dropped into; the #4837 handoff transition band that then carried the cue (`SEE THE THREE CORE COMPONENTS ↓`) was deleted by #4923 — the band now ends on the diagnosis-line closer and flows DIRECTLY into the §4 #system overview (the cue's label lived on as the hero secondary CTA until the Task #5017 book relabel, §1). Hand-off history for the record: re-homed to this band by Task #3998 from the removed §3 differentiator band (owner of it since Task #3908), moved to the REE strip's tail by Task #4120, to the tuned proof ribbon's tail by Task #4259, home again by Task #4816, retired by Task #4837.

### 3. Differentiator — REMOVED (2026-08-07, Task #3998)
Band deleted from the homepage (owner screenshot, 2026-08-07): the `WHY
NOBULL` eyebrow, `We Optimize for Cases, Not Clicks.` H2, the single
tuned-on-the-signed-case point, the aria-hidden CLICKS→CALLS→LEADS→
CONSULTS BOOKED→`Signed cases` metric ladder, and the invite line `The
engine that does the tuning is just below.` no longer appear anywhere —
the ladder pre-stated the exact stage flow the era's §4 cinematic walked
moments later (itself retired by Task #4837), and the §2 closer is the
stronger springboard into the engine (the handoffs kicker from Task
#4259 until Task #4923; the handoff-diagnosis line since). The page
now flows gap → §4 product section directly (Task #4923 deleted the
#4837 handoff transition band; #4816 had the gap flow into the
cinematic directly, and #4120/#4259 had routed REE strip and ribbon
between them). The
`OPEN THE HOOD ↓` cue + light→dark seam retired with the cinematic
opener they answered (Task #4837 — hand-off history in §2's tail
bullet); the §4 handoff transition's `SEE THE THREE CORE COMPONENTS ↓`
cue was the springboard until Task #4923 deleted that band too — the
§2 diagnosis-line closer is the springboard now. Band
history: rebuilt as the belief-shift bridge by Task #3908 (which had
rehomed its other claims — the hero owns the agency contrast + one-system
claim, the ROI FAQ owns click-to-close tracking; those are unaffected);
the owner saw that version and wanted the beat gone, so the band was
removed, not re-slimmed. No claim-ledger row pointed at this band's copy;
the optimize-for-signed-cases principle stays in
`website-messaging-architecture.md` with no owning homepage section.


### 4. Product section (#system) — the single-funnel Revenue Engine (Task #4992, 2026-08-18; Task #5065 scroll focus, 2026-08-19; owner brief `attached_assets/Pasted-Here-is-the-complete-version-I-would-hand-to-the-design_1787066887433.txt` is canonical — "ONE continuous visual object — a vertical funnel" — followed verbatim for copy, structure, geometry, and the remove list). Replaces the #4837/#4923/#4924 engine story WHOLESALE: the charcoal overview, the three component sections (four-question layout, SVG diagrams, builds/changes lists, receipts), the desktop sticky 01/02/03 index rail, the band-level attribution line, and the dark customization band are ALL RETIRED — every retired rendered line is recorded verbatim in the changelog (2026-08-18, Task #4992 entry; after the standalone services-page retirement, the receipt figures remain only as sourced rows in `/data-notes/`, ledger #9/#11/#12). The section names no scores (the brief's "Remove: REE" — and since Task #4987 the homepage carries NO REE surface at all: the §2b strip was removed wholesale, /calculator/ owns the score sitewide) and carries no book CTA (the ledger's book-CTA rule).
- Shape: the gap band above is untouched and still ends on its
  diagnosis closer; ~80–96px of air, then the section opens DIRECTLY
  with the eyebrow — no intro paragraph, no transition copy. ONE
  continuous funnel object: three stacked, TOUCHING, angle-edged
  stages — CaseGen/MARKETING (full width) → CaseIntake/INTAKE (~84%)
  → CaseConvert/SALES (~68%) — terminating in the smaller gold-faced
  plaque (~44%) that reads as the RESULT, not a fourth stage. One
  continuous gold rim wraps the whole object (nested clip-path
  trapezoids — the visible sliver between the outer gold shape and
  the inset stage stack IS the border); stage grounds run warm-ivory
  → deep-burgundy → dark-navy → gold, all from existing nb-* tokens;
  faint engineering-grid pattern behind the object; subtle bevels +
  soft downward lighting on each surface. Mobile (≤850px) keeps the
  top-down funnel with gentler narrowing (100/94/88/70) and shallower
  angles; capability lines may wrap to two centered lines; the
  complete message renders with no hover/tap-gated content. The
  section keeps `id="system"` — the header "Solutions" link on every
  subpage and the footer's overall Revenue Engine link keep resolving.
  The three stages expose `#casegen`, `#caseintake`, and `#caseconvert`
  for the footer's individual component links; each fragment names the
  corresponding Marketing, Intake, or Sales stage (the hero secondary
  left for the book funnel, Task #5017 — was `SEE THE THREE CORE
  COMPONENTS →`).
- Eyebrow: `OUR PRODUCT LINES` (Task #5065 — explicit section identity;
  the existing Revenue Engine naming remains in the meta description and
  headline, while this label makes the three offerings immediately
  scannable)
- H2: `One Revenue Engine. Three Core Components.` (the
  `aria-labelledby` target)
- Stages (each: a large lightly-transparent numeral behind the copy
  and an engraved architectural emblem on the funnel surface — search
  pin / conversation-calendar / agreement seal — both aria-hidden;
  then dept label → product name → outcome headline → ONE compact
  capability line, all brief-verbatim; NO body paragraphs,
  per-product CTAs, input/output labels, between-stage copy, or
  arrows anywhere in the section):
  - 01 `MARKETING` · `CASEGEN™` · `Create More of the Right
    Opportunities.` · caps `Local Authority Optimization™ · Paid
    Search Control System™ · Review Velocity System™` (the three ™
    system names render on CaseGen only)
  - 02 `INTAKE` · `CASEINTAKE™` · `Stop Qualified Leads From
    Disappearing.` · caps `Answer faster · Guide consistently ·
    Follow up · Remove friction`
  - 03 `SALES` · `CASECONVERT™` · `Turn More Booked Consultations
    Into Signed Cases.` · caps `Script the conversation · Strengthen
    the offer · Coach the execution`
- Terminus: the `SIGNED CASES` plaque — the engine's output, gold
  face under the same continuous rim, narrower than every stage; no
  number, no product name, no caps line (the result, not a
  component).
- Section ask (~64–72px below the plaque; the section's ONLY CTA —
  the order block's FIVE-slot booking budget counts it): H3 `Build a
  Revenue Engine That Produces More Signed Cases.` (rendered with a
  non-breaking "Signed Cases" glue so the payoff never orphans) +
  `Book Your High Impact Revenue Session →` → `/#booking`
  (brief-verbatim BOOK YOUR HIGH IMPACT REVENUE SESSION — the
  deliberate YOUR-variant of the sitewide `Book a High Impact Revenue
  Session →` label, this button only; `.nb-btn` chrome renders it
  uppercase; never hyphenate "High Impact").
- Motion (`home-client/engineStory.ts` — module + `initEngineStory`
  export names kept): the served markup IS the complete fully-lit final
  state. Under `prefers-reduced-motion: no-preference`, the stage nearest
  the viewport reading zone is the one warm focal surface; the other two
  recede with a restrained readable veil. Focus advances Marketing →
  Intake → Sales while scrolling down and reverses predictably while
  scrolling up; outside the active funnel range every stage returns to
  its fully readable served state. No pinning, scroll-jacking, snapping,
  scrubbed timeline, traveling leads, loops, or particles. Reduced-motion
  and JS-off visitors see the identical finished state. QA stamp
  `data-fn-focus` identifies the active stage only while the focus range
  is active.
- Contrast: AA on every surface — gold INK on the light stage, light
  inks on burgundy/navy, near-black label on the gold plaque; bright
  gold stays decorative on light grounds (rim, numerals, emblems).

### 4. Product section (#system) — the single-funnel Revenue Engine (Task #4992, 2026-08-18; Task #5065 scroll focus, 2026-08-19; owner brief `attached_assets/Pasted-Here-is-the-complete-version-I-would-hand-to-the-design_1787066887433.txt` is canonical — "ONE continuous visual object — a vertical funnel" — followed verbatim for copy, structure, geometry, and the remove list). Replaces the #4837/#4923/#4924 engine story WHOLESALE: the charcoal overview, the three component sections (four-question layout, SVG diagrams, builds/changes lists, receipts), the desktop sticky 01/02/03 index rail, the band-level attribution line, and the dark customization band are ALL RETIRED — every retired rendered line is recorded verbatim in the changelog (2026-08-18, Task #4992 entry; after the standalone services-page retirement, the receipt figures remain only as sourced rows in `/data-notes/`, ledger #9/#11/#12). The section names no scores (the brief's "Remove: REE" — and since Task #4987 the homepage carries NO REE surface at all: the §2b strip was removed wholesale, /calculator/ owns the score sitewide) and carries no book CTA (the ledger's book-CTA rule).
- Shape: the gap band above is untouched and still ends on its
  diagnosis closer; ~80–96px of air, then the section opens DIRECTLY
  with the eyebrow — no intro paragraph, no transition copy. ONE
  continuous funnel object: three stacked, TOUCHING, angle-edged
  stages — CaseGen/MARKETING (full width) → CaseIntake/INTAKE (~84%)
  → CaseConvert/SALES (~68%) — terminating in the smaller gold-faced
  plaque (~44%) that reads as the RESULT, not a fourth stage. One
  continuous gold rim wraps the whole object (nested clip-path
  trapezoids — the visible sliver between the outer gold shape and
  the inset stage stack IS the border); stage grounds run warm-ivory
  → deep-burgundy → dark-navy → gold, all from existing nb-* tokens;
  faint engineering-grid pattern behind the object; subtle bevels +
  soft downward lighting on each surface. Mobile (≤850px) keeps the
  top-down funnel with gentler narrowing (100/94/88/70) and shallower
  angles; capability lines may wrap to two centered lines; the
  complete message renders with no hover/tap-gated content. The
  section keeps `id="system"` — the header "Solutions" link on every
  subpage and the footer's overall Revenue Engine link keep resolving.
  The three stages expose `#casegen`, `#caseintake`, and `#caseconvert`
  for the footer's individual component links; each fragment names the
  corresponding Marketing, Intake, or Sales stage (the hero secondary
  left for the book funnel, Task #5017 — was `SEE THE THREE CORE
  COMPONENTS →`).
- Eyebrow: `OUR PRODUCT LINES` (Task #5065 — explicit section identity;
  the existing Revenue Engine naming remains in the meta description and
  headline, while this label makes the three offerings immediately
  scannable)
- H2: `One Revenue Engine. Three Core Components.` (the
  `aria-labelledby` target)
- Stages (each: a large lightly-transparent numeral behind the copy
  and an engraved architectural emblem on the funnel surface — search
  pin / conversation-calendar / agreement seal — both aria-hidden;
  then dept label → product name → outcome headline → ONE compact
  capability line, all brief-verbatim; NO body paragraphs,
  per-product CTAs, input/output labels, between-stage copy, or
  arrows anywhere in the section):
  - 01 `MARKETING` · `CASEGEN™` · `Create More of the Right
    Opportunities.` · caps `Local Authority Optimization™ · Paid
    Search Control System™ · Review Velocity System™` (the three ™
    system names render on CaseGen only)
  - 02 `INTAKE` · `CASEINTAKE™` · `Stop Qualified Leads From
    Disappearing.` · caps `Answer faster · Guide consistently ·
    Follow up · Remove friction`
  - 03 `SALES` · `CASECONVERT™` · `Turn More Booked Consultations
    Into Signed Cases.` · caps `Script the conversation · Strengthen
    the offer · Coach the execution`
- Terminus: the `SIGNED CASES` plaque — the engine's output, gold
  face under the same continuous rim, narrower than every stage; no
  number, no product name, no caps line (the result, not a
  component).
- Section ask (~64–72px below the plaque; the section's ONLY CTA —
  the order block's FIVE-slot booking budget counts it): H3 `Build a
  Revenue Engine That Produces More Signed Cases.` (rendered with a
  non-breaking "Signed Cases" glue so the payoff never orphans) +
  `Book Your High Impact Revenue Session →` → `/#booking`
  (brief-verbatim BOOK YOUR HIGH IMPACT REVENUE SESSION — the
  deliberate YOUR-variant of the sitewide `Book a High Impact Revenue
  Session →` label, this button only; `.nb-btn` chrome renders it
  uppercase; never hyphenate "High Impact").
- Motion (`home-client/engineStory.ts` — module + `initEngineStory`
  export names kept): the served markup IS the complete fully-lit final
  state. Under `prefers-reduced-motion: no-preference`, the stage nearest
  the viewport reading zone is the one warm focal surface; the other two
  recede with a restrained readable veil. Focus advances Marketing →
  Intake → Sales while scrolling down and reverses predictably while
  scrolling up; outside the active funnel range every stage returns to
  its fully readable served state. No pinning, scroll-jacking, snapping,
  scrubbed timeline, traveling leads, loops, or particles. Reduced-motion
  and JS-off visitors see the identical finished state. QA stamp
  `data-fn-focus` identifies the active stage only while the focus range
  is active.
- Contrast: AA on every surface — gold INK on the light stage, light
  inks on burgundy/navy, near-black label on the gold plaque; bright
  gold stays decorative on light grounds (rim, numerals, emblems).

### 4. Product section (#system) — the single-funnel Revenue Engine (Task #4992, 2026-08-18; Task #5065 scroll focus, 2026-08-19; owner brief `attached_assets/Pasted-Here-is-the-complete-version-I-would-hand-to-the-design_1787066887433.txt` is canonical — "ONE continuous visual object — a vertical funnel" — followed verbatim for copy, structure, geometry, and the remove list). Replaces the #4837/#4923/#4924 engine story WHOLESALE: the charcoal overview, the three component sections (four-question layout, SVG diagrams, builds/changes lists, receipts), the desktop sticky 01/02/03 index rail, the band-level attribution line, and the dark customization band are ALL RETIRED — every retired rendered line is recorded verbatim in the changelog (2026-08-18, Task #4992 entry; after the standalone services-page retirement, the receipt figures remain only as sourced rows in `/data-notes/`, ledger #9/#11/#12). The section names no scores (the brief's "Remove: REE" — and since Task #4987 the homepage carries NO REE surface at all: the §2b strip was removed wholesale, /calculator/ owns the score sitewide) and carries no book CTA (the ledger's book-CTA rule).
- Shape: the gap band above is untouched and still ends on its
  diagnosis closer; ~80–96px of air, then the section opens DIRECTLY
  with the eyebrow — no intro paragraph, no transition copy. ONE
  continuous funnel object: three stacked, TOUCHING, angle-edged
  stages — CaseGen/MARKETING (full width) → CaseIntake/INTAKE (~84%)
  → CaseConvert/SALES (~68%) — terminating in the smaller gold-faced
  plaque (~44%) that reads as the RESULT, not a fourth stage. One
  continuous gold rim wraps the whole object (nested clip-path
  trapezoids — the visible sliver between the outer gold shape and
  the inset stage stack IS the border); stage grounds run warm-ivory
  → deep-burgundy → dark-navy → gold, all from existing nb-* tokens;
  faint engineering-grid pattern behind the object; subtle bevels +
  soft downward lighting on each surface. Mobile (≤850px) keeps the
  top-down funnel with gentler narrowing (100/94/88/70) and shallower
  angles; capability lines may wrap to two centered lines; the
  complete message renders with no hover/tap-gated content. The
  section keeps `id="system"` — the header "Solutions" link on every
  subpage and the footer's overall Revenue Engine link keep resolving.
  The three stages expose `#casegen`, `#caseintake`, and `#caseconvert`
  for the footer's individual component links; each fragment names the
  corresponding Marketing, Intake, or Sales stage (the hero secondary
  left for the book funnel, Task #5017 — was `SEE THE THREE CORE
  COMPONENTS →`).
- Eyebrow: `OUR PRODUCT LINES` (Task #5065 — explicit section identity;
  the existing Revenue Engine naming remains in the meta description and
  headline, while this label makes the three offerings immediately
  scannable)
- H2: `One Revenue Engine. Three Core Components.` (the
  `aria-labelledby` target)
- Stages (each: a large lightly-transparent numeral behind the copy
  and an engraved architectural emblem on the funnel surface — search
  pin / conversation-calendar / agreement seal — both aria-hidden;
  then dept label → product name → outcome headline → ONE compact
  capability line, all brief-verbatim; NO body paragraphs,
  per-product CTAs, input/output labels, between-stage copy, or
  arrows anywhere in the section):
  - 01 `MARKETING` · `CASEGEN™` · `Create More of the Right
    Opportunities.` · caps `Local Authority Optimization™ · Paid
    Search Control System™ · Review Velocity System™` (the three ™
    system names render on CaseGen only)
  - 02 `INTAKE` · `CASEINTAKE™` · `Stop Qualified Leads From
    Disappearing.` · caps `Answer faster · Guide consistently ·
    Follow up · Remove friction`
  - 03 `SALES` · `CASECONVERT™` · `Turn More Booked Consultations
    Into Signed Cases.` · caps `Script the conversation · Strengthen
    the offer · Coach the execution`
- Terminus: the `SIGNED CASES` plaque — the engine's output, gold
  face under the same continuous rim, narrower than every stage; no
  number, no product name, no caps line (the result, not a
  component).
- Section ask (~64–72px below the plaque; the section's ONLY CTA —
  the order block's FIVE-slot booking budget counts it): H3 `Build a
  Revenue Engine That Produces More Signed Cases.` (rendered with a
  non-breaking "Signed Cases" glue so the payoff never orphans) +
  `Book Your High Impact Revenue Session →` → `/#booking`
  (brief-verbatim BOOK YOUR HIGH IMPACT REVENUE SESSION — the
  deliberate YOUR-variant of the sitewide `Book a High Impact Revenue
  Session →` label, this button only; `.nb-btn` chrome renders it
  uppercase; never hyphenate "High Impact").
- Motion (`home-client/engineStory.ts` — module + `initEngineStory`
  export names kept): the served markup IS the complete fully-lit final
  state. Under `prefers-reduced-motion: no-preference`, the stage nearest
  the viewport reading zone is the one warm focal surface; the other two
  recede with a restrained readable veil. Focus advances Marketing →
  Intake → Sales while scrolling down and reverses predictably while
  scrolling up; outside the active funnel range every stage returns to
  its fully readable served state. No pinning, scroll-jacking, snapping,
  scrubbed timeline, traveling leads, loops, or particles. Reduced-motion
  and JS-off visitors see the identical finished state. QA stamp
  `data-fn-focus` identifies the active stage only while the focus range
  is active.
- Contrast: AA on every surface — gold INK on the light stage, light
  inks on burgundy/navy, near-black label on the gold plaque; bright
  gold stays decorative on light grounds (rim, numerals, emblems).

### 4. Product section (#system) — the single-funnel Revenue Engine (Task #4992, 2026-08-18; Task #5065 scroll focus, 2026-08-19; owner brief `attached_assets/Pasted-Here-is-the-complete-version-I-would-hand-to-the-design_1787066887433.txt` is canonical — "ONE continuous visual object — a vertical funnel" — followed verbatim for copy, structure, geometry, and the remove list). Replaces the #4837/#4923/#4924 engine story WHOLESALE: the charcoal overview, the three component sections (four-question layout, SVG diagrams, builds/changes lists, receipts), the desktop sticky 01/02/03 index rail, the band-level attribution line, and the dark customization band are ALL RETIRED — every retired rendered line is recorded verbatim in the changelog (2026-08-18, Task #4992 entry; after the standalone services-page retirement, the receipt figures remain only as sourced rows in `/data-notes/`, ledger #9/#11/#12). The section names no scores (the brief's "Remove: REE" — and since Task #4987 the homepage carries NO REE surface at all: the §2b strip was removed wholesale, /calculator/ owns the score sitewide) and carries no book CTA (the ledger's book-CTA rule).
- Shape: the gap band above is untouched and still ends on its
  diagnosis closer; ~80–96px of air, then the section opens DIRECTLY
  with the eyebrow — no intro paragraph, no transition copy. ONE
  continuous funnel object: three stacked, TOUCHING, angle-edged
  stages — CaseGen/MARKETING (full width) → CaseIntake/INTAKE (~84%)
  → CaseConvert/SALES (~68%) — terminating in the smaller gold-faced
  plaque (~44%) that reads as the RESULT, not a fourth stage. One
  continuous gold rim wraps the whole object (nested clip-path
  trapezoids — the visible sliver between the outer gold shape and
  the inset stage stack IS the border); stage grounds run warm-ivory
  → deep-burgundy → dark-navy → gold, all from existing nb-* tokens;
  faint engineering-grid pattern behind the object; subtle bevels +
  soft downward lighting on each surface. Mobile (≤850px) keeps the
  top-down funnel with gentler narrowing (100/94/88/70) and shallower
  angles; capability lines may wrap to two centered lines; the
  complete message renders with no hover/tap-gated content. The
  section keeps `id="system"` — the header "Solutions" link on every
  subpage and the footer's overall Revenue Engine link keep resolving.
  The three stages expose `#casegen`, `#caseintake`, and `#caseconvert`
  for the footer's individual component links; each fragment names the
  corresponding Marketing, Intake, or Sales stage (the hero secondary
  left for the book funnel, Task #5017 — was `SEE THE THREE CORE
  COMPONENTS →`).
- Eyebrow: `OUR PRODUCT LINES` (Task #5065 — explicit section identity;
  the existing Revenue Engine naming remains in the meta description and
  headline, while this label makes the three offerings immediately
  scannable)
- H2: `One Revenue Engine. Three Core Components.` (the
  `aria-labelledby` target)
- Stages (each: a large lightly-transparent numeral behind the copy
  and an engraved architectural emblem on the funnel surface — search
  pin / conversation-calendar / agreement seal — both aria-hidden;
  then dept label → product name → outcome headline → ONE compact
  capability line, all brief-verbatim; NO body paragraphs,
  per-product CTAs, input/output labels, between-stage copy, or
  arrows anywhere in the section):
  - 01 `MARKETING` · `CASEGEN™` · `Create More of the Right
    Opportunities.` · caps `Local Authority Optimization™ · Paid
    Search Control System™ · Review Velocity System™` (the three ™
    system names render on CaseGen only)
  - 02 `INTAKE` · `CASEINTAKE™` · `Stop Qualified Leads From
    Disappearing.` · caps `Answer faster · Guide consistently ·
    Follow up · Remove friction`
  - 03 `SALES` · `CASECONVERT™` · `Turn More Booked Consultations
    Into Signed Cases.` · caps `Script the conversation · Strengthen
    the offer · Coach the execution`
- Terminus: the `SIGNED CASES` plaque — the engine's output, gold
  face under the same continuous rim, narrower than every stage; no
  number, no product name, no caps line (the result, not a
  component).
- Section ask (~64–72px below the plaque; the section's ONLY CTA —
  the order block's FIVE-slot booking budget counts it): H3 `Build a
  Revenue Engine That Produces More Signed Cases.` (rendered with a
  non-breaking "Signed Cases" glue so the payoff never orphans) +
  `Book Your High Impact Revenue Session →` → `/#booking`
  (brief-verbatim BOOK YOUR HIGH IMPACT REVENUE SESSION — the
  deliberate YOUR-variant of the sitewide `Book a High Impact Revenue
  Session →` label, this button only; `.nb-btn` chrome renders it
  uppercase; never hyphenate "High Impact").
- Motion (`home-client/engineStory.ts` — module + `initEngineStory`
  export names kept): the served markup IS the complete fully-lit final
  state. Under `prefers-reduced-motion: no-preference`, the stage nearest
  the viewport reading zone is the one warm focal surface; the other two
  recede with a restrained readable veil. Focus advances Marketing →
  Intake → Sales while scrolling down and reverses predictably while
  scrolling up; outside the active funnel range every stage returns to
  its fully readable served state. No pinning, scroll-jacking, snapping,
  scrubbed timeline, traveling leads, loops, or particles. Reduced-motion
  and JS-off visitors see the identical finished state. QA stamp
  `data-fn-focus` identifies the active stage only while the focus range
  is active.
- Contrast: AA on every surface — gold INK on the light stage, light
  inks on burgundy/navy, near-black label on the gold plaque; bright
  gold stays decorative on light grounds (rim, numerals, emblems).

### 6. Credibility rail (ONE compact band since Task #4816 — the press logos and the four aggregates merged; the metrics had sat in their own band directly after the press strip since Task #4261 moved them up from after the cinematic, owner doc §2, and before that after the cinematic since Task #3999 merged the former systems band into §4)
Updated 2026-08-14 (Task #4816, owner-endorsed feedback): the standalone
press strip and metrics band fused into one ~180–220px credibility rail —
`AS SEEN ON` logos row over the four count-up aggregates — so the hero's
claim gets third-party + outcome backing in a single glance and the gap
band arrives sooner. Copy unchanged in the merge: same logos row (§5),
same four aggregates, money first (Task #4261) — the rail still opens
the proof story before The Gap prices it. Figures still count
up once when the band scrolls into view (home-client/statsBand.ts; the
`$`/`M` prefix and suffix render as static aria-hidden spans around the
counted digits so `$150M+` animates digits-only) and render statically
for no-JS / reduced-motion visitors.
- `$150M+` / `In New Client Revenue` [proof.ts:REVENUE_GENERATED] — ledger #17; NEW band surface Task #4261 (the rail is the figure's ONLY homepage surface since Task #4816 retired the hero trust line's combined $150M+/350+ form; always "new client revenue" — client firms' revenue, never NoBull's own)
- `350+` / `Law Firms Worked With` [proof.ts:CLIENTS] — ledger #13; renamed Task #4261 from `Law Firms Grown`: "worked with" is the ledger's own mandated cumulative framing, and the claim ledger documents no defensible "grown" standard (owner doc §2 flagged the wording)
- `10+` / `Years of Results` — ledger #15
- `1,000,000+` / `Leads Generated` [proof.ts:LEADS_GENERATED] — owner-confirmed 2026-08-06, ledger #16; always "Generated", never "Reviewed"
- Rotated out of the band (Task #4261): `30,000+` / `Five-Star Reviews Generated` [proof.ts:REVIEWS_GENERATED] — ledger #35, owner-confirmed; the owner doc names reviews the sanctioned ALTERNATE for the fourth slot, so it can swap back for `Leads Generated` anytime without a new claim. No other surface currently renders it.
- Previously rotated out: `100,000s of Leads Reviewed Every Year` (a "reviewed" figure must not sit beside the 1M+ "generated" total — ledger #14, WITHHELD) and `1–3 Days From Launch to First Lead` (FIRST_LEAD_RECORDS remains canonical proof source data; the Presti record also appears in the homepage flagship and booking proof band).

### 7. Proof in context — result-first flagship + compact receipts (Task #5134; distilled from #5068)
- Eyebrow: `PROOF, NOT PROMISES` (kept). REMOVED: the former `SEE MORE CASE STUDIES →` control and every `VIEW CASE STUDY →` control, because the standalone route is not a case-study library; the homepage now presents the verified result-first summaries in place. NO slider controls — the #4261 prev/next arrows, dash-dots, `1 / 4` counter, and home-client/proofSlider.ts are DELETED; the band is fully static and identical for no-JS / reduced-motion visitors.
- H2: `What the Complete Engine Did for These Firms` (the plural heading accurately introduces the Presti flagship and the two supporting firm results below it; the former singular framing no longer described the complete proof band. Before that, `Different Firms. Engines Tuned for Revenue.` sold breadth across four cards.)
- Support line — CUT (Task #4925): `Every number is one real firm's result, never an average.` (#4166) no longer renders — the band-foot disclosure's first sentence carries the not-an-average fact once.
- FLAGSHIP (`.nb-flag`, near-black ink panel spanning the band, system tag `THE COMPLETE ENGINE · FLAGSHIP CASE STUDY`): identity leads — `The Presti Law Firm, PLLC` + `IMMIGRATION LAW FIRM — DALLAS, TX` — directly into [proof.ts:PRESTI.headline] `500+ Leads a Month. 60+ Cases Signed in a Single Month.` The evidence field is intentionally asymmetric: supporting `3,600+ / LEADS` and `400+ / FIVE-STAR REVIEWS GENERATED` results sit on the left at desktop widths, while `292 / CASES SIGNED / IN 6 MONTHS` is substantially larger on the right. At tablet and phone widths the 292-case outcome moves first, then the supporting results stack without a cramped three-column row. The owner-confirmed `IN 6 MONTHS` label belongs only to the 292 signed-case result; the separately verified 400+ review statement comes from the S8 quote and carries no six-month claim. The quote is a sentence-boundary verbatim excerpt — `"[NoBull] has totally automated the intake & sales process for the attorneys. It’s very click-and-easy now."` — footed `— Michael Presti, The Presti Law Firm, PLLC`.
- REMOVED from the homepage flagship: the former context paragraph, trio-install description, standalone time-elapsed beat, first-lead beat, Marketing/Intake/Sales path, the REMOVED `200 / 5-STAR REVIEWS` marker, and the REMOVED `4.8 ★ / GOOGLE RATING` marker. Canonical proof.ts keeps the 200-review, 4.8-rating, and 470-listing-count records for approved use on other surfaces. **The brief's draft flagship figures (≈200→500 leads/mo, ≈200→600+ reviews, 15–20→~3× cases, ~nine months, "sales process unchanged") remain NOT in the verified corpus and are NOT published** (changelog 2026-08-18).
- SUPPORTS (`.nb-supports`, two compact light result tiles; each keeps its own system/firm context, one headline, and exactly two supporting figures; no card merges figures across firms):
  - Burns Smith Law P.C. [proof.ts:BURNS_SMITH], tag `CASEGEN™ RESULT · MARKETING`: label, headline `3.5× Lead Increase in 5 Months.`, `1,779 / LEADS — FIRST FIVE MONTHS`, and `50 / FIVE-STAR REVIEWS`. The prior month-one→month-five narrative, monthly ramp, Day 0 / Day 17 / Day 19 timeline, and Zachary H. Smith quote no longer render in this homepage band.
  - Expansion Play [proof.ts:EXPANSION], tag `THE COMPLETE ENGINE · ALL THREE SYSTEMS` (firm stays UNNAMED per ledger #7): label, headline `8-Figure Results in 6 Months.`, `$1.5M / FIRST 100-CASE MONTH · COLLECTED REVENUE / April 2026`, and `3 / LOCATIONS ADDED`. The launchpad paragraph, `2,400+` leads, and `228` five-star reviews no longer render in this homepage band.
- Historical note: Task #4925 replaced the slider with a six-part Presti flagship plus two supports; Task #5068 then expanded all three into complete inline stories. Task #5134 deliberately reverses that density while preserving the shared verified register and all other proof surfaces.
- Retired with the slider (Task #4925, for the record): the #4261 slide plan and both rate cards. CaseIntake card — dropped label `ONE FIRM'S INTAKE, REBUILT`, dropped headline `Same Lead Flow. Nearly Twice the Consultations.`, its how-line and `38.3% → 75%` sweep. CaseConvert card — dropped label `ONE FIRM'S CLOSE RATE, REBUILT`, dropped headline `From Booked Consultations to Signed Cases.`, its how-line and `15% → 40%` sweep. Both product links removed as well — `HOW CASEINTAKE™ WORKS →` and the likewise-removed `HOW CASECONVERT™ WORKS →`. The rate pairs' ONLY homepage surfaces are the §4 engine-story component sections (ledger #11/#12).
- Post-proof foot: primary CTA `Book a High Impact Revenue Session →` → homepage `#booking` (kept, #4261 — lands while the receipts are on screen), then `.nb-measure`: H3 `HOW RESULTS ARE MEASURED` over the brief's two-sentence disclosure VERBATIM (Task #4925; replaced the #4261 five-point paragraph): `Every result shown is one firm's tracked outcome over the stated period, not an average or a guarantee. See Data Notes & Definitions for the measurement basis.` (link on `Data Notes & Definitions` → /data-notes/). Restates zero figures; revenue-basis labeling lives on the cards themselves (`COLLECTED REVENUE`, ledger #7); the retired paragraph's component-vs-complete-engine sentence survives via the cards' system tags.


### 8. Video testimonials + quotes — ENDLESS ROWS (Task #3997; #4925's static curated set REVERSED by Task #4980, changelog 2026-08-18); H2 `Hear It From The Firms We Grow.`
- Eyebrow REMOVED (Task #4166); H2 unchanged — the band still opens on it.
- Video row: all FIVE named client videos as plain outbound Vimeo anchors (no embeds — the original three are domain-locked and render "Sorry" iframes off-domain): Shields & Boris · Covington & Associates · Integrity Law · Presti Law · Burns Smith Law. The last two were identified via their public Vimeo titles (truth-source §5); Task #4925 had REMOVED their cards to keep the video firms distinct from the proof band's case studies directly above, and Task #4980 restored them on the owner's call — the repeat is accepted (changelog 2026-08-18). Committed homepage posters carry the same paused-player treatment on all five; cards are firm-named only (no speaker names are on file).
- Quote rows: ELEVEN five-star quotes in two counter-scrolling rows. Row A: Alistair Schneider, Alec Chapa, Lani Akiona, Susannah Bruck, Jake Cutler, Stacy Grow. Row B: Tessa Thrift, Jayanta Acharyya, Atara Twersky, Sam Varnerin, Attorney Angelik Edmonds. Google reviews foot `— Name, Google Review`; the three role-footed written reviews (Tessa/Lani/Stacy) keep their on-file roles instead — never "Google Review". Every text is anonymized + excerpted per the truth-source §4 register (the audit source; no new metric claims — Sam Varnerin's excerpt deliberately omits the review's specific-result sentences).
- Client testimonial: Tom Boris [proof.ts:BORIS] appears above the video/review grids with both S10 statements — turnkey/automated and the Google-reviews close-deals statement — footed to The Elder Law Offices of Shields and Boris. This is a static, non-marquee client testimony; all five videos and eleven review cards remain served in full.
- Motion contract: the served markup is the complete static grid and IS the no-JS / prefers-reduced-motion presentation; home-client/testimonialsMarquee.ts stamps `data-testi-mode="marquee"` for motion-allowed visitors and loops the three rows as seamless time-based tweens (videos drift faster; quote row B reverses; hover/focus-within pauses; loop clones aria-hidden + tabindex-excluded; soft edge fades). Zero ScrollTriggers — and since Task #4837 nothing anywhere on the page pins.


### 9. Book (#book) — copy intact; now hands off from FAQ into the final conversion close
- Position: the band now renders directly after FAQ and before the final conversion section. It remains the lower-commitment path for visitors not ready to book a session, with its cover, copy, and free-chapters action unchanged.
- Eyebrow: `NOT READY FOR A REVENUE SESSION? START WITH THE BOOK.` (brief §14 verbatim; was `WE WROTE THE BOOK ON IT` — RETIRED, Task #4926)
- H2: `The Law Firm <em>Revenue Engine</em>`
- Support (Task #3908 trim — the Marketing/Intake/Sales trio stays in the book's actual subtitle, not this paraphrase; Task #4120 revenue-first: `turning them into signed cases` → `turning them into revenue`, matching the review's recommended subtitle direction without touching the locked title; Task #4166 dropped the `The book behind the headline:` throat-clearing — the eyebrow/H2 pair already frame it): `Why more leads aren't enough — and the complete methodology for turning them into revenue. By NoBull founder Ronnie Deaver.`
- Primary CTA (Task #3920): `GET THE FIRST 2 CHAPTERS FREE →` → `/free-chapters/` — the label's content promise is backed by the real on-site excerpt it links to (no email gate), satisfying the ledger's book-content-CTA rule by pointing at the content itself.
- Store availability below the CTA: non-interactive matched-pair Amazon and Audible notices, each labeled `COMING SOON!`. No outbound store URL is exposed while canonical product destinations are unavailable; `website/src/bookLinks.ts` single-sources the store names and availability message.
- Former tertiary link `GET THE BOOK ON AMAZON →` REMOVED (duplicated the Amazon badge directly above it; owner-reported).
- Cinematic growth-stage secondary CTA — REMOVED (Task #4261, owner doc §4): the engine close (the §4 recap since Task #4837, the customization band since #4924, the funnel's section ask since #4992) carries only the primary session CTA; Amazon remains in this band's store badges only (tertiary). Retired label for the record: `Get the Book on Amazon →` (its rule — labels must not promise content while pointing at a store search URL — lives on with the store badges; panel owned by Task #3910).
- Hierarchy confirmed per owner doc §3/§9 (Task #4262): free chapters remain primary; the non-interactive Amazon/Audible coming-soon notices are tertiary and confined to this band on the homepage; the hero cover (§1) still feeds the same `/free-chapters/` funnel entry.

### 10. Implementation — REMOVED (2026-08-06)
Section deleted from the homepage (operator judged it added no value): the
`IMPLEMENTATION` eyebrow, `Installed in Stages.` H2, the no-rip-and-replace
install lede, standalone timeline cards, and `One firm's real install
timeline…` microcopy remain retired as a separate band. Task #5068 restores
the same client-specific `DAY 0` Onboarding Call / `DAY 17` Launch Day /
`DAY 19` First Consult Booked facts only inside the Burns Smith proof card,
narrowly attributed from [proof.ts:BURNS_SMITH.timeline, deck S56]; the
testimonials case study and book-a-call proof band continue to render them.
- The deck's generic onboarding path (S55 Day 0 / Days 3–5 / ~2 weeks) is
  still NOT published anywhere — withheld as a universal process promise
  (claim ledger row 23) — now with no homepage install section at all.

### 11. Growth control — REMOVED (2026-08-06)
Section deleted from the homepage (operator judged it added no value): the
`GROWTH CONTROL` eyebrow, `Growth You Can Throttle.` H2, throttle lede, and
the deck-S35 line `Build the system once. Use it to enter market after
market.` no longer appear anywhere. (The implementation section was removed
later the same day — see §10.)
The `growth you control` bullet in the qualification cards survived this
removal but was itself rewritten on 2026-08-08 (Task #4035,
scale-up-only owner directive — see §12c).

### 12. Team — eyebrow `NOBLE. NO B.S.`, H2 `One Team Responsible From First Click to Signed Case.` (full 18-person roster Task #4979; collapsed grid Task #5011 — the #4979 endless wall RETIRED; compressed Task #4926, owner brief §10; was `The People Behind The Engine.` — RETIRED)
- Task #4979 owner directive (supersedes the #4926 §10 five-person compression): the band carries the FULL 18-person roster again, led by the six named people in exactly this order — Ronnie Deaver (Founder) · Oliver Goessler (Head of Operations) · Brett Barney (Head of Accounts) · Jeff Mangle (Head of Sales) · Janno Perez (Head of Paid Search) · Cam Duhart (Sr. Intake Engineer) — then everyone else in the roster's prior relative order: Jake Davis (Sr. Marketing Engineer) · Cat McManus (Executive Assistant) · Jason Robbins (Marketing Engineer) · Priyanka Lakha (Onboarding Engineer) · Juan Antoniazzi · Santiago Sanchez · Kaylie Dietrichsen · Devin Petersen (all Paid Search Expert) · Jordan Scrimgeour (Google Business Profile Expert) · Liri Abdullahu (Intake Expert) · Cleo Ortega · Lotis Florida (both Virtual Assistant). Names/roles/photos verbatim from the pre-#4926 roster — zero copy edits to any member.
- Presentation (Task #5011, superseding the #4979 wall): the endless vertical wall is RETIRED — owner verdict: it didn't look good — `home-client/teamWall.ts` is deleted with its `data-team-mode` CSS family, and the band never scrolls or drifts for any visitor. The served static grid (6 → 2 → 1 columns) IS the complete presentation; for JS-enabled visitors `home-client/teamReveal.ts` collapses it to the first two rows per breakpoint (12 / 4 / 2 cards at the 6 / 2 / 1-column splits) behind the `Meet the Full Team` toggle — native button, aria-expanded + aria-controls announced state, aria-hidden chevron; collapsed cards are display:none (out of the tab order and accessibility tree); the expand rise + chevron flip animate only under prefers-reduced-motion: no-preference. No-JS visitors always see all 18 cards.
- REMOVED (Task #4979): the About text link below the grid — label was `MEET THE COMPLETE NOBULL TEAM →` — because the complete roster now renders in-band and /about/ carries only three bios, so the label over-promised. (Header nav + footer keep the page's About routes.)
- NO in-band booking CTA. The active booking placements are header, hero, product funnel, after proof, and footer; the former final-close button is retired. The #4261 `.nb-team-ask` button stays REMOVED.
- STILL RETIRED (unchanged by the wall's own retirement): the #4261 7-default + 11-behind-disclosure split (the `<details>` disclosure stays deleted — the #5011 collapsed grid opens from the ONE 18-card grid via a runtime button, not a details element).


### 12b. Session offer — REMOVED (2026-08-18, Task #5016; was NEW Task #4926, owner brief §11)
Band deleted from the homepage (owner screenshot request): the page's
one working-together beat between the team roster and the fit band is
gone, and team now flows straight into the §12c fit question. Nothing
replaces it — no copy moved, and the five-placement booking-CTA budget is
untouched (the band never had a CTA). The ledger #36/#37 session facts
it carried stay owner-confirmed and LIVE elsewhere: the hero
session-explainer note (§1) and the final conversion close's free +
you-leave-knowing supporting line. Retired copy
for the record:
- Eyebrow `HOW WORKING TOGETHER STARTS`; H2 `Find the Constraint Costing Your Firm Signed Cases.` (rendered with a `Signed&nbsp;Cases` glue pair).
- Lede (ledger #36's four owner-confirmed facts, nothing else): `During a free High Impact Revenue Session, our Head of Sales reviews your firm's real numbers — leads, consultations, signed cases, and the rates between them — and builds a plan shaped to your revenue goals.` (rendered with a `revenue&nbsp;goals` glue pair).
- `YOU LEAVE KNOWING` card — four bullets, brief-verbatim (row #37 session activities in the estimate-honest register): `Which part of the engine is limiting revenue` · `The estimated value of that constraint` · `What should be addressed first` · `Whether NoBull is the right partner to build it`.
- The Task #4926 WITHHELD record (session length, who should attend, what to bring, what happens after the session, and the review list's "average case value" item — not on file, ledger §5 / #36 limits) is unchanged history: those facts stay off the site everywhere.

### 12c. Fit (nb-fit — Task #4926, owner brief §12) — H2 `Is Your Firm a Fit?` (verdict cards re-homed from the closing band, both lists rewritten)
- Fit list: `You want more signed cases, not merely more marketing activity` · `You'll let NoBull measure Marketing, Intake, Sales, and revenue` · `Someone at the firm can approve and support implementation changes` · `You want the entire system working toward the same outcome`.
- Not-fit list: `You only need a logo, a website refresh, or a one-off campaign` · `You can't provide the access needed to measure results` · `You want more leads but won't improve Intake or Sales` · `Nobody at the firm can own implementation decisions`.
- The rewrite resolves the brief-flagged contradiction: the old fit list required existing lead flow while the FAQ said none was needed — lead generation is no longer a fit condition; willingness to improve Intake and Sales alongside is. Brief §12's minimum-investment criterion is WITHHELD (no threshold on file). The retired #3916/#4035 lists are quoted in the changelog.
- Presentation: the same gold-vs-crimson `.nb-qual-*` verdict pair the closing band carried (shared classes — gold-ink vs crimson heads, matched ✓/✕ on a shared glyph column, stacking at ≤1000px), now under this band's own H2 on the egg background.


### 13. FAQ — SIX buying questions (nb-faq-sec, Task #4926, owner brief §13; renders between the §12c fit band and the book handoff)
Eyebrow `BEFORE YOU BOOK`, H2 `Six Questions, Answered Straight.` The
#3908/#4120/#4261 ten-question set is cut to the six questions a buyer
actually asks before booking; answers keep the claim-safe register
(product-specific typical implementation windows with an explicit
non-guarantee and client-pace caveat — ledger #43, while ledger #23's generic
onboarding path stays withheld; no figures — ledger #29 pricing stays banned;
software-conditional, estimate-honest tracking — ledger #42 and #37;
component-by-component is ledger #24's publishable rule). Retired Q&As are
quoted in the changelog.
- FAQ 1 `Do we need all three components at once?` (NEW) → `No. We install the engine in a fixed order: Marketing, then Intake, then Sales. A stage that is already well established can move through its work faster, but it does not change the sequence. Engagements are incremental: we normally cover one stage at a time, with no more than two active at once. All three feed the same click-to-close measurement, so each stage you add joins numbers that are already running.`
- FAQ 2 `Will we need to replace our current team or software?` (question reworded — was `Do we need to replace our CRM, intake staff, or sales team?`) → `Not by default. The engine installs around the people and tools you already have: CaseIntake™ builds answering, follow-up, and booking systems around your intake team, and CaseConvert™ scripts, records, and coaches the consultation your attorneys already run. We generally build around your existing software rather than prescribing change. If a tool is materially inadequate or obstructs the system, we will recommend replacing it.` (ledger #24's preserve-by-default, replace-when-necessary position; "the consultation your attorneys already run" keeps the house singular-institution form)
- FAQ 3 `What does NoBull handle, and what does our firm handle?` (ledger #41 — the firm supplies three empowered operating owners; NoBull carries the hands-on implementation) → `Your firm needs three owners: a decision-maker empowered to make and enforce the changes the engine needs, an Intake owner, and a Sales owner. NoBull does the hands-on implementation: we get campaigns live, configure and improve your CRM software, coordinate supporting vendors such as call-answering services, and measure results from first click to signed case. You keep practicing law; running the engine is our job. But the work cannot succeed if necessary decisions cannot be made and enforced.`
- FAQ 4 `How long does implementation take?` (replaces the narrow prior 30-to-90-day question and its generic no-schedule answer; exact retired wording is preserved in the changelog) → `CaseGen™ is typically fully launched within 21 days and profitable within 60 days. CaseIntake™ is typically launched within 90 days and in fine-tuning within 180 days. CaseConvert™ is typically launched within 30 days and seeing profitable ROI within 90 days. These are typical expectations, not guarantees. Client implementation pace is the number-one timing factor, and NoBull will go as fast as your firm allows.` (owner-confirmed typical product windows and governing caveat — ledger #43; the generic Day 0 / Days 3–5 / Day 14 path remains withheld under ledger #23)
- FAQ 5 `How do you track leads, consultations, signed cases, and revenue?` (question reworded; prior wording is preserved in the changelog) → `We use WhatConverts for complete lead tracking and lead scoring. Visibility into Intake and Sales outcomes depends on your firm's software and how consistently it is used. We go as deep as the available data allows to report outcomes and improve your marketing campaigns. Where your data can't support a precise revenue number, we say so and give you the best honest estimate instead of a guess.` (owner-confirmed WhatConverts and software-use boundary — ledger #42; estimate-honest arm per ledger #37's load-bearing wording)
- FAQ 6 `What does working with NoBull cost?` (NEW — answers the cost question with ZERO figures; ledger #29 commitment pricing stays banned) → `It depends on which components your firm needs — the engine is scoped component by component, not sold as a one-size package, and we don't publish a flat rate. The free High Impact Revenue Session is where the number gets real: it puts an estimated value on the constraint we'd be fixing, so you can weigh the investment with your own numbers in front of you.`
- Final narrative order: FAQ → book handoff → §14 conversion close. The book keeps its cover, free-chapters action, and store destinations intact before the final ask.
- Conversion hub: homepage `#booking` owns the only branded Calendly handoff and external scheduler action; homepage `#contact` owns the only `data-nb-inquiry="contact"` form. The independent `/unsubscribe/` utility continues through the shared inquiry handler without contact fields or reCAPTCHA.
### Footer (both home.ts + html.ts)
- Book secondary (Task #5017, owner request): both footers carry the outlined `Read the Book →` button (→ `/free-chapters/`) in the logo column — dark-scheme outline variant (warm-white hairline/label, gold-pale arrow). On the homepage it is the footer's ONLY styled action (the booking budget keeps that footer session-free); the subpage footer pairs it with the COMPANY column's session text link. The RESOURCES `The Book` → #book text link stays as-is.
- OUR SERVICES → `The Revenue Engine™` (#system) · `CaseGen™` (#casegen) · `CaseIntake™` (#caseintake) · `CaseConvert™` (#caseconvert). These homepage/component deep links remain independent of top navigation.
- COMPANY → About NoBull / Results / Contact, with Contact targeting homepage `#contact` from every depth. Shared subpage footers also carry `Book a High Impact Revenue Session` targeting homepage `#booking`.
- RESOURCES → The Book (#book) · Revenue Calculator (`/calculator/`; the homepage label since Task #4987, which renamed it away from the REE-named form — subpage footers still carry `REE Calculator`) · Articles · Webinars

---

## /about/

**Title:** `About NoBull Marketing — Noble. No B.S.`
**Meta:** `The name NoBull comes from "Noble" and "No B.S." — an honest, fluff-free revenue partner for law firms. Meet the team behind The Law Firm Revenue Engine™.` (Task #4120: "growth partner" → "revenue partner")
- H1 band: `About NoBull Marketing` / sub `Noble in our dealings. No B.S. in our services. Your bottom line is our bottom line.` / eyebrow `Who We Are`
- Pride section: keep origin copy (trim; Task #4120 swaps its "we'll grow your law firm" clause to "grow your law firm's revenue"), replace FAQ (FAQ 1–2 rewritten Task #4120):
  - FAQ 1 → the category positioning (final review; ledger #32): `Most legal marketing agencies stop taking responsibility when the lead arrives. We don't. We follow every opportunity from acquisition through signed-and-paid client — Marketing, Intake, and Sales as one measured system. We wrote the book on it, and we're honest about what's working — Noble and No B.S. aren't just the name.`
  - FAQ 2 → revenue-measured + attribution-gap honesty: `We measure what you measure: revenue. Lead tracking and dashboard reporting connect your Marketing, Intake, and Sales systems to the cases and dollars they produce, so you'll know where every lead — and every dollar we can attribute — came from. Where attribution has gaps, we say so rather than guess.`
  - FAQ 3 → `Book a high impact revenue session through our website. It covers your goals, your current funnel — marketing, intake, and sales — and whether the engine fits your firm.` (topics only; no mapping/approach/pricing promises; opening ask renamed Task #4124, reconciled Task #4195)
- Composition: company story and FAQ → Practice Areas Served → Our Dedicated Team → booking band. The About page has no First Lead Records proof strip or Recent News/resource-card section.
- Practice-area section: stable destination `#practice-areas-served`; label `Built For B2C Law Firms`; H2 exactly `Practice Areas Served`; intro `Our Marketing, Intake, and Sales services are built for B2C law firms across a wide range of practices. We connect the systems that bring in qualified opportunities, move them to consultations, and help turn those consultations into signed cases.` List all 14 entries from the shared canonical practice-area source in this order: Bankruptcy Law; Criminal Law; Environment Law; Family Law; Health Law; Immigration Law; Real Estate Law; International Law; Entertainment Law; Personal Injury Law; Estate Planning / Elder Law; Intellectual Property Law; Labor (Employment) Law; Tax Law. The list is complete in place with no dependency on `/services/`; the former industries-page CTA is retired.
- Team: render the complete canonical 18-person roster in homepage order, with the same photo/name/role contract on both pages: Ronnie Deaver / Founder; Oliver Goessler / Head of Operations; Brett Barney / Head of Accounts; Jeff Mangle / Head of Sales; Janno Perez / Head of Paid Search; Cam Duhart / Sr. Intake Engineer; Jake Davis / Sr. Marketing Engineer; Cat McManus / Executive Assistant; Jason Robbins / Marketing Engineer; Priyanka Lakha / Onboarding Engineer; Juan Antoniazzi, Santiago Sanchez, Kaylie Dietrichsen, and Devin Petersen / Paid Search Expert; Jordan Scrimgeour / Google Business Profile Expert; Liri Abdullahu / Intake Expert; Cleo Ortega and Lotis Florida / Virtual Assistant. The only biographies are the three existing Ronnie, Oliver, and Jake biographies; each remains available through a native disclosure labeled with that member's first name. Do not invent biographies for the other 15 members.
- Ronnie bio (fixed, unverified numbers removed; Task #4120: "engineering growth" → "engineering revenue"): `Ronnie Deaver founded NoBull Marketing after more than a decade engineering revenue for law firms. He's the author of The Law Firm Revenue Engine and a speaker at industry events including the American Bar Association and the National Association of Divorce Professionals.`
- Jake/Oliver biographies stay as the existing trimmed copy; their roles remain Sr. Marketing Engineer / Head of Operations.
- Header destination: every generated header carries `Practice Areas Served`
  as a direct depth-correct link to this page's `#practice-areas-served`
  section. It is not a dropdown.


## /services/ — RETIRED

- Owner decision, 2026-08-19: the standalone page does not exist. It has no generator registration, committed page, sitemap entry, canonical URL, internal link, or redirect. Both the marketing-host `/services/` URL and `/website-preview/services/` return the branded 404.
- The former page title, meta, WHAT WE DO hero, ONE ENGINE, THREE SYSTEMS intro, Foundation/Accelerator/Multiplier rows, proof chips, First Lead Records strip, CaseIntake/CaseConvert cards, and page CTAs are retired together. None of that page-exclusive copy or presentation is moved elsewhere.
- Practice-area scope lives only in the About-page `#practice-areas-served` section. The homepage Revenue Engine funnel and footer stage deep links remain the product explanation.
- Existing proof data keeps its independently legitimate source and data-notes records, plus selected Presti records on the homepage. See claim-ledger rows #8–#12.


## Results destination (homepage `#proof`)

Results is a homepage destination, not a standalone route. Header and footer
links on the homepage target `#proof`; every shared-chrome page and article
targets the same anchor through its relative path back to the homepage, and
the 404 uses `{{BASE}}#proof`. The complete current proof contract is owned by
homepage §§7–8 above. There is no generated `/testimonials/` page, sitemap
entry, redirect, or case-study-library shell.

## Homepage conversion hub (`/#booking` + `/#contact`)

- The homepage ends FAQ → book → one final conversion section. Its title block carries the crimson bull, H2 `Ready to Build Your Revenue Engine?`, lede `You're already paying to create opportunity. The question is how much of it becomes revenue.`, and supporting line `Sound like a fit? The session is free — you leave knowing how to start with Marketing, then build through Intake to Sales.`
- The former standalone close CTA and booking/message chooser are retired. Desktop presents booking first and contact second in one two-column composition; at ≤850px they stack in that same booking-first DOM and keyboard order.
- `#booking`: `Book a High Impact Revenue Session`; a compact NoBull booking handoff with `View Available Times →`, two session facts, an explicit new-tab Calendly destination note, and a no-JavaScript assurance. The former embedded Calendly widget/script, loading copy, and `Open Calendly directly →` recovery link are retired.
- `#contact`: `Prefer to Send a Message?`; the only contact-kind inquiry form, with visible Name/Email/Phone/Message labels, honeypot, Google reCAPTCHA checkbox mount, `Send Message →`, and live status.
- `/book-free-demo/` and `/contact/` are compatibility-only 301s to these anchors. They have no generated page, canonical, sitemap row, or standalone copy.

## /free-chapters/ (excerpt reader, Task #3920)

**Title:** `Read the First 2 Chapters Free - The Law Firm Revenue Engine - NoBull Marketing`
**Meta:** `Read the Introduction and first two chapters of The Law Firm Revenue Engine by Ronnie Deaver, free — no email required. How Marketing, Intake, and Sales become one machine that turns leads into signed cases.`
- H1 band: `Read the First Two Chapters — Free` / eyebrow `THE LAW FIRM REVENUE ENGINE` / sub `The complete methodology behind everything NoBull installs, by founder Ronnie Deaver. Read the Introduction and the first two chapters right here — no email required.`
- Contents chips: `In this excerpt` → Introduction · Chapter 1 · The Million Dollar Gap · Chapter 2 · Inside the Revenue Engine.
- Chapter text: VERBATIM from the owner-supplied manuscript (`website/content/book-excerpt.json`, imported by `scripts/extract-book-excerpt.ts` — never hand-edit the JSON; the book's names-changed privacy note rides inline in the first Introduction paragraph). Only exclusion: the manuscript's final back-matter CTA line (printed `/talk` URL that doesn't exist on this site) — see claim ledger §5.
- Endcap (dark band; reframed Task #4262, owner doc §3 — the leak-diagnosis session ask now LEADS and full-book availability is demoted to a labeled secondary block): kicker `END OF THE FREE EXCERPT` / H2 `You've seen how the Revenue Engine works. Now see where yours is <em>leaking</em>.` (doc §3 verbatim; was `You've seen inside the engine. The full book <em>installs</em> it.` — replaced Task #4262, no longer renders) / leading actions row (`.fc-endcap-ask`): `Book a High Impact Revenue Session` (`.btn`, the hard ask; renamed Task #4124, reconciled Task #4195) + `Calculate your Revenue Engine →` (Task #4121, `.fc-calc-link` — gold text link → `/calculator/`, the finished-Chapter-2 next step mirroring the book revision's end-of-Chapter-2 calculator CTA; the excerpt's Ch2 never names REE, so the link sells scoring without claiming the chapter introduced it) / demoted full-book block below a gold hairline (`.fc-endcap-book`): label `FULL BOOK AVAILABILITY` + support `Three more chapters cover how the engine goes into your firm, how you scale it once it's running — and how to know whether you're ready.` (the `keep control of growth` clause was rewritten 2026-08-08, Task #4035 — scale-up-only owner directive; the chapter TITLES stay verbatim from the ToC, including Ch4 `The Growth Control System` — that's book content) / Chapters 3–5 titles from the manuscript ToC / non-interactive Amazon and Audible notices, each labeled `COMING SOON!`.
- Floating bar (refined Task #5080 — the persistent session ask follows the sitewide primary label; fixed while reading, `body.fc-body` reserves padding so it never covers text): note `You're reading the free excerpt.` (hidden on smaller screens) · quiet `FULL BOOK AVAILABILITY` with `AMAZON COMING SOON!` and `AUDIBLE COMING SOON!` non-link notices on roomier screens · primary `Book a High Impact Revenue Session →` → homepage `#booking`. The calculator stays available only in the endcap action row; it is deliberately absent from the bar so the soft calculator rung cannot compete with the persistent hard ask. At phone widths (≤640px), the availability notices hide and the ≥48px booking control receives the full usable width; the bar retains its safe-area inset and does not wrap or overflow.


## /calculator/ (REE calculator; simplified period contract live 2026-08-19 — ledger #39)

**Title:** `REE Calculator - Score Your Revenue Engine | NoBull Marketing`
**Meta:** `Calculate your law firm's Revenue Engine Efficiency (REE): the revenue your engine produces for every $1 invested in client acquisition. Free, browser-only, and no email required.`
- H1 band: `Score Your Revenue Engine.` / eyebrow `REVENUE ENGINE EFFICIENCY` / sub `Enter one reporting period of real numbers. See the revenue your engine produces for every $1 invested, plus what a 10% improvement in each direct lever is worth. Free, no email required.`
- Form fieldsets: `Your reporting period` (exact choices `3 months` / `6 months` / `12 months`) · `Your inputs` (`Total investment ($)`, `Leads`, `Consults`, `Cases`) · `Revenue basis` (`Estimate from average case value` with `Estimated case value ($)` vs `Use revenue generated` with `Revenue generated ($)`). Exactly one revenue-basis input is enabled. Submit `Calculate my REE` + privacy line `Runs entirely in your browser — nothing you enter is stored or sent.`
- Validation: short field-specific recovery copy in one alert; invalid controls receive `aria-invalid`; focus moves to the first invalid field. Cross-field rules require Leads ≥ Consults ≥ Cases without duplicate error noise.
- Results (client-rendered): `Actual revenue` or `Estimated revenue` chip + `Your REE`; selected-period echo; score plate (`X×` / `$X.XX per $1`); the approved headline shape (`Your Revenue Engine currently produces [an estimated] $X.XX in top-line revenue for every $1 invested in client acquisition.`); direct metric tiles for revenue, total investment, CPL, Cost per Case when available, Lead-to-Consult, Consult-to-Case when available, Lead-to-Case, and Revenue per Case when available.
- Improvement values: H3 `The value of a 10% improvement` + intro `Additional revenue from improving one direct lever by 10%, with the other inputs unchanged.` Four possible rows in stable funnel order: `More leads`, `Lead-to-Consult rate`, `Consult-to-Case rate`, `Revenue per Case`. Only available rows render; rates stop at 100%; no winner or recommendation is named.
- Handoff: H3 `Want to pressure-test this result?` / `Bring your score to a High Impact Revenue Session and we’ll validate the inputs and identify the clearest next step.` / `Book a High Impact Revenue Session` → homepage `?ree_period=…&ree_usd=…&ree_basis=…#booking`; note `Your period, REE, and revenue basis ride along. You can edit the booking message before sending it.` The query always precedes the fragment.
- Invalid edits after a successful calculation keep the prior result visible but dimmed; fixing the field recomputes immediately. No-JS fallback explains that the math runs in the browser and links the session.
- RETIRED 2026-08-19: the date-range and maturity experience, booked-versus-held inputs, separate show-rate scenario, optional practice area/market/targets, measurement-guide rail, five-lever ordering, highest-dollar callout, print/report action, expanded result handoff, and illustrative $5.80 walk-through. They remain history only and must not reappear in generated calculator or Data Notes output.

## /resources/

**Title:** `Law Firm Revenue Library | NoBull Marketing` (Task #4120: was `Growth Library`)
**Meta:** `Articles, videos, webinars, and podcasts on law firm marketing, intake, and sales — the thinking behind The Law Firm Revenue Engine™.`
- H1 `Resources` / sub `Articles, videos, webinars, and podcasts on marketing, intake, and sales — the thinking behind the Revenue Engine.` / eyebrow `The Library`
- Soft-CTA band before the homepage-booking CTA (Task #4121, `.res-calc`): eyebrow `Start With Your Score` / H2 `How Hard Does Your $1 Work?` / sub `The REE calculator turns your 3-, 6-, or 12-month totals into your score and the dollar value of a 10% improvement in each available direct lever. Free, no email required.` / CTA `CALCULATE YOUR REE →` → `/calculator/` (text link, not a button; the following hard ask returns to homepage `#booking` without embedding another scheduler).

## /resource/<slug>/ (15 articles)

- Sidebar soft card above the hard ask (Task #4121, `.side-calc`): h3 `Score Your Revenue Engine` / body `Choose a 3-, 6-, or 12-month reporting period. See your REE and the dollar value of a 10% improvement in each available direct lever. Free, no email required.` / link `Calculate your REE →` → `/calculator/` (the article template's soft CTA).
- Sidebar CTA → `Book a High Impact Revenue Session` (renamed Task #4124, reconciled Task #4195 — still the page's one hard ask).
- Each article gets a real ≤160-char metaDesc + index excerpt (written per article from its content; see changelog for full list).
- `.co` → `.com` links; "free demo" phrases → strategy-call phrasing; legacy naming corrected in-body where it appears; educational content otherwise preserved.

## /privacy-policy/ · /unsubscribe/ · 404

- Privacy: `nobullmarketing.co` → `https://nobullmarketing.com`; effective date/© checked; substantive wording untouched (anything questionable flagged in changelog).
- Unsubscribe button: `Unsubscribe Me`; success copy kept.
- 404: unchanged.

## bookingBand (shared subpage CTA)

- Eyebrow: `THE NEXT STEP`
- Default heading: `Book a High Impact Revenue Session` (renamed Task #4124, reconciled Task #4195)
- Sub: `Pick a time that works for your firm — one conversation about your marketing, intake, and sales.`
- Button: `Book a High Impact Revenue Session` → depth-correct homepage `#booking`; no Calendly widget or script is emitted on subpages.

### 5. Systems in numbers — MERGED INTO §4 (2026-08-07, Task #3999)
Band deleted from the homepage (operator direction): its middle re-walked
the same fuel → injector → spark → flywheel story the cinematic tells
moments earlier, while holding the best material. Everything it owned moved
into the cinematic's stage panels (see §4 — the cinematic itself was
retired by Task #4837; the engine story keeps none of the instrument
dress): the component art +
station halos, the role tags (unified — `THE FUEL INJECTOR` → `THE
INJECTOR`, `THE SPARK PLUG` → `THE SPARK`), the one-line system functions,
the proof.ts readouts with their `LIVE CLIENT RESULT` tags (readouts +
tags retired AGAIN — and for good — by the Task #4259 same-day owner
follow-up, which pulled the proof out of the stages; the §2c ribbon is
the homepage receipt surface now), the flywheel
terminus (`THE FLYWHEEL` / `REVENUE GROWTH` / `Where fuel becomes signed
cases.` / `THREE SYSTEMS · ONE OUTPUT`), and the microcopy — condensed to
the stamp tail `— one real firm, never an average`, itself tightened to
`— one real firm` by Task #4039 and retired with the stamp (#4259
follow-up)
(the old standalone line `Live client results — each metric is one real
firm, never an average.` retired with the band; per-firm phrasing must
never move onto §6's all-time aggregates). Retired outright: the eyebrow
`YOU'VE SEEN THE ENGINE RUN`, the H2 `Now Read the Gauges.`, and the
engine-flow reveal module (`home-client/engineFlow.ts`). Earlier band
history (Task #3908 receipts reframe; Task #3913 engine-flow rebuild; the
2026-08-06 rotations, including the retired EVERY LEAK HAS A SYSTEM…
eyebrow, `Three Systems. One Measured Path to Signed Cases.` H2, and
"…without another dollar of ad spend") stays in the changelog. The page
flowed cinematic → §6 credibility metrics directly until Task #4261
moved the metrics up; #4816 had the cinematic flow into the §2c tuned
proof ribbon; since Task #4837 both are retired — §4's closing element (the #4837
recap, the #4924 customization band, since Task #4992 the funnel
section's warm-ground CTA block) hands to the egg proof band's own
top seam.


### 2b. REE strip (#ree) — REMOVED (2026-08-18, Task #4987; was NEW Task #4120, book final editorial review; SCOREBOARD rework Task #4166; connective tissue — connection line, levers, clarifier — Task #4259; COMPRESSED + moved below the proof band Task #4816; cut to the terminal four beats Task #4925, owner brief §8)
REMOVED wholesale by Task #4987 (owner decision: zero REE mentions on
the homepage). Everything below is the record of the strip as it last
rendered (the #4925 four-beat form) — none of it renders anymore: the
homepage carries no REE surface of any kind, the homepage footer's
calculator link is relabeled `Revenue Calculator` (subpage footers
still carry `REE Calculator`), and REE is introduced sitewide only on
/calculator/, its sanctioned working surface (ledger #38/#39). The egg
proof band now hands off directly to the warm testimonials band — a
natural tone step; the strip's bottom hairline retired with it. Full
record: the 2026-08-18 changelog entry.

The single sitewide introduction of REE — since Task #4816 (2026-08-14
owner-endorsed feedback, deliberately superseding the #4259
REE-before-cinematic arrangement) it sits AFTER the proof band's case
studies:
the score is scaffolding, not the story, so it now scores the tuned
results the visitor has just seen instead of pre-teaching the engine.
Warm band between the egg proof band and the testimonials. Task #4166
cut the explainer copy (the lede and the ad-spend-ratio comparison —
owner decision 2026-08-09, rationale recorded verbatim in the changelog
entry) and rebuilt the band as the page's
scoreboard moment with the formula PLATE as the crafted visual
centerpiece. Task #4259 (owner narrative bridge) wrapped connective
tissue around the unchanged scoreboard; Task #4816 compressed that
tissue; Task #4925 (owner brief §8) cut the strip to its terminal four
beats — eyebrow + H2 → plate → single-row WHAT MOVES THE SCORE levers →
calculator CTA — retiring the #4259/#4816 connection sentence and the
ledger-#38 example line outright, with the #4166 deletions still
deleted (no explainer lede, no metric comparisons) and the #4259
diagnostic-role clarifier re-homed to /calculator/.
Once-on-entry reveal was via home-client/reeReveal.ts (module deleted
with the band, Task #4987) under the gap band's
motion contract (nothing on the page pins since Task #4837 — the module
simply bound below the engine story);
no-JS / reduced-motion shipped the finished static band.
- Eyebrow: `REVENUE ENGINE EFFICIENCY`
- H2 (serif): `Revenue Is the Goal. REE Is the Score.`
- Connection line — RETIRED (Task #4925, owner brief §8; was Task
  #4259, ONE sentence since Task #4816): `Revenue Engine Efficiency
  shows how efficiently the entire system turns growth investment into
  attributable top-line revenue.` no longer renders — the H2 names the
  score's role and the plate defines it; nothing else previews it. Do
  not reintroduce (the gap-deixis sentence `The Million-Dollar Gap
  shows what is being lost.` had already retired with the #4816 move).
- Lede: REMOVED (Task #4166) — `One number tells you how expensive your
  revenue is to produce:` no longer renders; the plate speaks for
  itself. Do not reintroduce. (The Task #4259 connection line above has
  a different job — naming the score's role, not teaching the read.)
- Formula plate (`.nb-ree-plate`, aria-hidden — now the band's crafted
  centerpiece: an engraved brass-plaque object with a double gold-ink
  hairline, faint warm-metal gradient, `THE SCORE` tab riding the top
  border, and four schematic corner ticks in the hero's
  engineering-drawing motif; ALL plate chrome is gold-INK — bright gold
  stays exclusive to dark bands; the #4120 gold hairline fraction bar
  is unchanged inside it): `REE =` `ATTRIBUTABLE TOP-LINE REVENUE` over
  `GROWTH INVESTMENT` — with a `.nb-vh` screen-reader sentence carrying
  the same content (gap-band SR-parity pattern): `Revenue Engine
  Efficiency, or REE, is your attributable top-line revenue divided by
  your growth investment.` (byte-stable since #4120 ships; this doc
  previously paraphrased it — corrected to the shipped sentence,
  Task #4166)
- Example — RETIRED SITEWIDE (Task #4925, owner brief §8; ledger #38 →
  WITHHELD): the fused `ILLUSTRATIVE MODEL` line `$1 of growth
  investment in, $8 of attributable revenue out — an 8× REE.` (two
  sentences #4120, fused #4166, muted tail qualifier #4816) no longer
  renders anywhere — the homepage strip was its only surface, and its
  /data-notes/ provenance row left with it. The figure stays registered
  for reuse WITH the visible illustrative label (and still never
  conflated with the REAL 8× lead-growth figure, ledger #10).
- Levers (Task #4259 — the four levers behind the score, surfaced on
  the strip itself; the flywheel terminus's closing line owned the
  four-lever summary until #4259 retired it — see §4 growth; ONE
  horizontal four-up row since Task #4816 — pairs ≤850px, single-file
  ≤520px): head
  `WHAT MOVES THE SCORE` over a tick list — `Cost and
  quality of qualified leads` / `Lead-to-consultation rate` /
  `Consultation-to-case rate` / `Average revenue per signed case`
  (this list has been the four-lever summary's only homepage home
  since Task #4295 retired the per-stage lever tails; the #4837 engine
  story kept lever talk out of §4 and the #4992 funnel still does).
- Diagnostic-role clarifier — RE-HOMED to /calculator/ (Task #4816):
  the paragraph `REE is not the goal and it is not a fourth system. It
  is the diagnostic score that shows where the engine is limiting
  revenue. We do not optimize the ratio at the expense of producing
  more total revenue.` (Task #4259, owner-approved verbatim) now
  renders under `What REE is not.` in the calculator's measurement
  guide rail, not on the homepage strip.
- Ad-spend-ratio distinction: DELETED SITEWIDE (Task #4166 — owner
  decision 2026-08-09; lawyers don't think in ad-spend ratios). The
  former `…hands you a ratio. REE shows you where the ratio comes
  from…` paragraph and its cost-per-lead / lead-to-case / case-value
  triad no longer render, and the metric's four-letter acronym may not
  reappear in rendered copy or in this doc / messaging-architecture
  (lint-website-banned-phrases enforces the bounded ban; the
  copy-changelog keeps the verbatim history and owner quote). The
  #system region carries no lever lines — Task #4295 dropped the #4120
  per-stage lever tails, the Task #4837 engine story kept them out, and
  the #4992 funnel's capability lines stay lever-free; the strip's own
  WHAT MOVES THE SCORE list carries the four-lever summary — it names the levers plainly and compares nothing.
- CTA (Task #4121, the CTA ladder's soft rung): `CALCULATE YOUR REE →`
  → `/calculator/` (`.nb-text-btn.nb-ree-cta`, after the lever row
  since Task #4816 and the band's closing element since Task #4925 —
  the strip stays the score's single sitewide INTRODUCTION; the
  calculator is its sanctioned WORKING surface, same definition
  wording; ledger #38/#39).
- Tail: no hand-off — the strip ends on the calculator CTA (Task
  #4925; it ended on the muted example line #4816→#4925; the `OPEN THE
  HOOD ↓` cue + seam the strip carried #4120–#4259 went back to the gap
  band's tail #4816→#4837, then retired outright with the cinematic —
  Task #4837, see §2). Still NOT
  carried over from the removed differentiator band: the invite line
  `The engine that does the tuning is just below.`
- The strip is the score's only homepage DEFINITION — and, since Task
  #4924, the score's only homepage surface of any kind. Between Task
  #4259 (which retired the flywheel terminus's closing `together they
  set your REE` line) and Task #4295 no other homepage surface named
  the score at all; from Task #4295 the #system region named it by
  NAME ONLY (the §4 engine-story recap's score line since Task #4837,
  ledger #38) until Task #4924 replaced the recap with the
  customization band and retired the name-only line `Revenue is the
  outcome. REE is the scorecard.` with it — neither the customization band
  nor the #4992 funnel section that replaced the whole engine story
  mentions the score. (The §13 closing band's Task #4121
  secondary line links the
  calculator by product name — `Calculate your Revenue Engine` —
  without re-defining the score.)


### 2c. Tuned proof ribbon — RETIRED (2026-08-17, Task #4837)
The compact warm receipt rail (Task #4259 owner narrative bridge;
re-homed directly after the cinematic + compacted Task #4816) retired
with the cinematic it re-entered from. Its three live-client readouts
moved into the §4 engine story — each component section now carries its
own `ONE FIRM’S RESULT` figure (`2×` lead growth [proof.ts:FOUNDATION_2X,
ledger #9] / `38.3%` → `75%` lead-to-consult [proof.ts:LEAD_TO_CONSULT,
ledger #11] / `15%` → `40%` consult-to-case [proof.ts:CONSULT_TO_CASE,
ledger #12]), and the band-level attribution line `Each number
represents one real firm’s result, never an average.` renders once
beneath the three component sections. The ribbon's H2 `What happens
when each stage is tuned` no longer renders anywhere. The figures still
render on the homepage exactly once each (the #4259 rule survives the
move); the proof band's flagship + support cards keep their own
per-card attributions (Task #4925 — was the case-study slider).
Task #4992 then retired the component sections themselves: the three
figures and the attribution line left the homepage entirely — the
single-funnel product section carries no receipts, and after the standalone
services-page retirement `/data-notes/` is each figure's only site surface
(ledger #9/#11/#12), and the
never-an-average framing survives in the homepage proof disclosure.
## /data-notes/ (versioned definitions/provenance appendix — ledger #40)

**Title:** `Data Notes & Definitions (v1.1) | NoBull Marketing`
**Meta:** `The definitions, formulas, and provenance behind the numbers NoBull Marketing publishes — including the REE calculator's math — versioned so you can hold us to them. No practice-area benchmarks are published as of v1.1.`
- H1 band: `Data Notes & Definitions` / eyebrow `APPENDIX` / sub `The definitions, formulas, and provenance behind every number this site publishes — versioned, so you can hold us to them.`
- Meta line: `Version 1.1 · Published August 19, 2026 · Companion to the REE calculator`.
- Sections: `What this page is` (bold: `As of v1.1, NoBull publishes no practice-area benchmarks, medians, or top-quartile comparisons.`) · `Definitions & formulas` (period-based REE, Total investment, Actual revenue basis, Estimated revenue basis, CPL, Lead-to-Consult, Consult-to-Case, Lead-to-Case, Cost per Case, Revenue per Case — formulas match `calc-client/math.ts`) · `How the 10% improvement values work` (four direct scenarios, one input changed at a time, stable funnel order, 100% caps and unavailable-state explanation) · `Results disclaimer`: `No result shown on this site is guaranteed for any individual firm.` `Outcomes vary based on the firm, its market, practice area, and other relevant circumstances.` · `The numbers this site publishes` (the existing provenance table from proof.ts: owner-confirmed aggregates vs single-firm tracked results vs illustrative models) · `Version history`.
- v1.0 remains in the version history as the appendix's first release; its calculator methodology is superseded rather than presented as live. The page remains deliberately absent from the main nav.
