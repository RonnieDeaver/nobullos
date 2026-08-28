# Homepage Content Reconciliation

**Scope:** public homepage content and destinations as of 2026-08-25. This is
the decision packet for the homepage-consolidation content slice; it records
implemented approvals and makes unresolved facts explicit rather than inferring
them from legacy assets or URLs.

## Approved public contract

| Surface | Approved result | Canonical evidence | Integrity coverage |
|---|---|---|---|
| Narrative and conversion | Existing hero → gap → single top-down Revenue Engine funnel → proof → testimonials → full team → fit/FAQ → book → booking/contact order remains. The final booking panel is heading plus one `View Available Times →` external Calendly action. | `docs/website-final-copy.md`; `docs/website-copy-changelog.md` (2026-08-25) | `website-engine-story-semantic-content.test.ts`; `marketing-site-mobile-baseline.test.ts` |
| Team | The complete 20-person shared roster remains in homepage order; no roster reduction or invented biographies. | `website/src/team.ts`; `CONTENT_TRUTH_SOURCE.md` §3 | `website-team-reveal-contract.test.ts` |
| Proof | Homepage figures and client proof remain sourced through the shared proof module and its claim ledger. No REE strip, retired engine-story, cinematic, installation, or throttle pattern returns. | `website/src/proof.ts`; `website-claim-ledger.md`; `website-final-copy.md` | `website-engine-story-semantic-content.test.ts` |
| Video testimonials | Five confirmed Vimeo poster links remain: Shields & Boris, Covington & Associates, Integrity Law, Presti Law, and Burns Smith Law. | `CONTENT_TRUTH_SOURCE.md` §5 | `website-engine-story-semantic-content.test.ts`; `website-testimonials-marquee.test.ts` |
| Written reviews | Eleven existing, source-backed written quotes remain in static markup; marquee behavior is progressive enhancement only. The existing anonymization/excerpt policy remains in force while confirmation of the Google-review register is outstanding. | `CONTENT_TRUTH_SOURCE.md` §4 and §6 | `website-engine-story-semantic-content.test.ts`; `website-testimonials-marquee.test.ts` |
| Press assets | Five protected press-logo assets retain their visual order, but no individual identity, caption, or permission claim is published. | `CONTENT_TRUTH_SOURCE.md` §7; `DO_NOT_BREAK.md` §10 | `website-engine-story-semantic-content.test.ts` |
| Book | `/free-chapters/` remains the live book CTA. Amazon and Audible are non-interactive `Coming Soon!` availability notices until canonical current-edition URLs are client-confirmed. | `website/src/bookLinks.ts`; `CONTENT_TRUTH_SOURCE.md` §8; `website-claim-ledger.md` §5 | `website-engine-story-semantic-content.test.ts`; `marketing-site-mobile-baseline.test.ts` |

## Withheld pending client confirmation

| Item | Safe current behavior | Needed before publishing it |
|---|---|---|
| Amazon and Audible product destinations | Store name, badge, and `Coming Soon!` notice only; no legacy listing, broad search, buy, or listen URL. | Canonical current-edition URL for each retailer. |
| Press-logo identities and use permissions | Opaque images with empty alt text; no named organization claim. | Organization names, permission/publication evidence, and any replacement brand assets. |
| Google-review currentness and use approval | Existing anonymized/excerpted review register is retained without new claims or fresh review-count assertions. | Confirmation that the cited reviews remain public and permitted for this use. |

## Compression and measurement

No owner-approved page-height cut list exists. The only recorded compression
decision is the 2026-08-25 simplification of the final booking panel; no
mandatory conversion destination, contact form, roster member, proof item, or
funnel stage was removed.

Regression verification uses the existing desktop `1280 × 900` and mobile
`390 × 844` browser compositions. The mobile baseline also enforces the
`850px` responsive breakpoint and the compact booking/book treatments. A new
height target requires an owner-approved measurement brief before further
content removal or spacing compression is proposed.