// Part 7 — team band collapsed-grid disclosure (Task #5011). The #4979
// endless vertical wall (teamWall.ts — counter-drifting looping columns
// in a masked window, itself the resurrected #4903 module) is RETIRED
// on the owner's verdict: it didn't look good. No wall mode exists for
// any visitor anymore — the team band never scrolls or drifts.
//
// The served band is the complete static presentation — ONE 20-card
// grid, the full roster in the owner's directive order (Ronnie → Oliver
// → Brett → Jeff → Janno → Cam, then the rest in prior relative order)
// — and that markup IS the no-JS experience (site animation contract:
// the served markup is the fallback). For JS-enabled visitors this
// module stamps data-team-collapsed="1" on the section — home.css keys
// EVERY card-hiding rule off that attribute, a JS-set state marker,
// never viewport width alone — so the grid opens on its first two rows
// per breakpoint (12 / 6 / 4 / 2 cards at the grid's own 6 / 3 / 2 / 1-column
// splits; the boundaries live beside the column rules they mirror) and
// appends the Meet the Full Team disclosure button below the grid.
//
// The button is a TOGGLE (APG disclosure pattern): a native <button>
// with a constant label, aria-expanded announcing state, aria-controls
// naming the grid, and an aria-hidden chevron that flips when open.
// Expanding swaps the attribute for data-team-expanded="1", whose only
// styling is the chevron flip plus a one-shot reduced-motion-gated CSS
// rise on the newly revealed cards — no GSAP, no ScrollTrigger, no
// IntersectionObserver, no loops, nothing scroll-linked. Collapsed
// cards are display:none, so they are unreachable by tab order and
// invisible to screen readers while hidden (the roster cards carry no
// focusables either way).
//
// The collapse applies to reduced-motion visitors too — it is layout,
// not motion (their expand simply doesn't animate). Visitors without
// JS never get the attribute or the button: they see all 20 cards.

/** Visible label — the one string this treatment adds (recorded in
    docs/website-copy-changelog.md, Task #5011); home.css uppercases it
    like every site label. */
const LABEL = "Meet the Full Team";
/** Fallback id so aria-controls can always name the grid. */
const GRID_ID = "nb-team-roster";

export function initTeamReveal(): void {
  const section = document.querySelector<HTMLElement>(".nb-team");
  if (!section) return;
  const grid = section.querySelector<HTMLElement>(".nb-team-grid");
  if (!grid) return;
  // Document order = the owner directive's roster order; the collapsed
  // rows are always the roster's first cards, never a reordering.
  if (grid.querySelectorAll(".nb-team-card").length === 0) return;

  if (!grid.id) grid.id = GRID_ID;

  const button = document.createElement("button");
  button.type = "button";
  button.className = "nb-team-reveal";
  button.setAttribute("aria-controls", grid.id);

  const label = document.createElement("span");
  label.textContent = LABEL;
  const chevron = document.createElement("span");
  chevron.className = "nb-team-reveal-chevron";
  chevron.setAttribute("aria-hidden", "true");
  chevron.textContent = "\u25BE";
  button.append(label, chevron);

  const collapse = (): void => {
    section.setAttribute("data-team-collapsed", "1");
    section.removeAttribute("data-team-expanded");
    button.setAttribute("aria-expanded", "false");
  };
  const expand = (): void => {
    section.removeAttribute("data-team-collapsed");
    section.setAttribute("data-team-expanded", "1");
    button.setAttribute("aria-expanded", "true");
  };

  button.addEventListener("click", () => {
    if (button.getAttribute("aria-expanded") === "true") collapse();
    else expand();
  });

  // Collapse BEFORE the button enters the DOM so no visitor ever sees a
  // toggle beside an already-complete grid.
  collapse();
  grid.insertAdjacentElement("afterend", button);
}
