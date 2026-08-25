// Million Dollar Gap duel — one-time scroll reveal (Task #3904; payoff
// reworked for the $1,000,000 model, Task #3936; band compressed into two
// desktop columns — chart | receipt — with a centered fuel/engine closer,
// Task #3991; chart + receipt columns load TOGETHER, Task #4030; the
// WHERE IT LEAKS / HOW IT'S TUNED trade strip was FOLDED into the chart's
// shortfall captions by Task #4166, so its trigger is gone).
//
// The generator ships the section in its COMPLETE final state: bars at full
// width, numbers printed, shortfall ghosts/captions, payoff receipt and the
// closer all visible. With JS disabled nothing here runs, and
// under prefers-reduced-motion the matchMedia block never activates — both
// get the finished static band (the site's established reduced-motion
// pattern, same as the cinematic's static mode).
//
// When motion is allowed, gsap.matchMedia zeroes the pieces and two
// once-only ScrollTriggers replay the build. On the shared duel timeline
// the two COLUMNS LOAD TOGETHER (Task #4030 — the receipt no longer waits
// for the bars to finish): bars grow stage by stage while their numbers
// count up and the leaky-vs-tuned shortfall ghosts fade in behind them
// (the captions now carry the leak names — Task #4166), and in parallel
// the payoff receipt (the right column since Task #3991 —
// [data-gap-payoff] is a SIBLING of the chart inside .nb-gap-cols, so it's
// queried from the section, not the duel) steps in line by line — the 6×
// multiple, the $200,000-vs-$1,200,000 duel, and the extra-$1,000,000
// figure counting up as its line lands. The fuel/engine closer reveals on
// its own trigger lower in the band, so scroll position keeps the order
// chart+receipt → closer. No pinning, no scrub; triggers fire once and
// self-destruct. refreshPriority -1 keeps these triggers refreshing AFTER
// the cinematic's pinned trigger (default priority 0, created later and
// higher in the page), per ScrollTrigger's refresh-order guidance for pages
// with a pinned scene.
//
// data-gap-anim ("pending" → "done", absent in static mode) mirrors the
// cinematic's data-mode stamp so headless QA can assert the active mode.

import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

gsap.registerPlugin(ScrollTrigger);

export function initGapDuel(): void {
  const duel = document.querySelector<HTMLElement>("[data-gap-duel]");
  if (!duel) return;
  const section = duel.closest<HTMLElement>(".nb-gap") ?? duel;
  const close = section.querySelector<HTMLElement>("[data-gap-close]");

  const mm = gsap.matchMedia();
  mm.add("(prefers-reduced-motion: no-preference)", () => {
    const fills = gsap.utils.toArray<HTMLElement>("[data-gap-fill]", duel);
    const ghosts = gsap.utils.toArray<HTMLElement>(
      "[data-gap-ghost],[data-gap-leak]",
      duel,
    );
    const nums = gsap.utils.toArray<HTMLElement>("[data-gap-count]", duel);
    // Receipt lives beside the chart in .nb-gap-cols (Task #3991), so it's
    // a sibling of [data-gap-duel] — query the section.
    const payoff = section.querySelector<HTMLElement>("[data-gap-payoff]");
    const payoffParts = payoff
      ? (Array.from(payoff.children) as HTMLElement[])
      : [];
    const money = payoff?.querySelector<HTMLElement>("[data-gap-money]");
    // Shipped final money string ("$1,000,000") — restored on revert, and
    // stamped back onComplete so rounding can never leave a stray digit.
    const moneyFinal = money?.textContent ?? "";
    const rows = gsap.utils.toArray<HTMLElement>(".nb-gap-row", duel);
    const closeParts = close
      ? (Array.from(close.children) as HTMLElement[])
      : [];

    duel.dataset.gapAnim = "pending";

    // Hide the shipped final state; everything below restores it on revert.
    gsap.set(fills, { scaleX: 0 });
    gsap.set(ghosts, { autoAlpha: 0 });
    if (payoffParts.length) gsap.set(payoffParts, { autoAlpha: 0, y: 18 });
    if (closeParts.length) gsap.set(closeParts, { autoAlpha: 0, y: 14 });
    for (const el of nums) el.textContent = "0";
    if (money) money.textContent = "$0";

    const duelTl = gsap.timeline({
      defaults: { ease: "power3.out" },
      scrollTrigger: {
        trigger: duel,
        start: "top 78%",
        once: true,
        refreshPriority: -1,
      },
      onComplete: () => {
        duel.dataset.gapAnim = "done";
      },
    });

    rows.forEach((row, index) => {
      const at = index * 0.22;
      duelTl.to(
        row.querySelectorAll<HTMLElement>("[data-gap-fill]"),
        { scaleX: 1, duration: 0.85 },
        at,
      );
      row.querySelectorAll<HTMLElement>("[data-gap-count]").forEach((el) => {
        const target = Number(el.dataset.gapCount ?? "0");
        const proxy = { value: 0 };
        duelTl.to(
          proxy,
          {
            value: target,
            duration: 0.85,
            ease: "power1.out",
            onUpdate: () => {
              el.textContent = String(Math.round(proxy.value));
            },
          },
          at,
        );
      });
      const leakDetails = row.querySelectorAll<HTMLElement>(
        "[data-gap-ghost],[data-gap-leak]",
      );
      if (leakDetails.length) {
        duelTl.to(
          leakDetails,
          { autoAlpha: 1, duration: 0.45 },
          at + 0.55,
        );
      }
    });
    if (payoffParts.length) {
      // The payoff totals the duel like a receipt: 6× first, then the
      // revenue comparison, then the extra $1,000,000 counting up as its
      // line steps in — the multiple and the money land as one moment.
      // Placed at 0 on the shared timeline (Task #4030): the receipt's
      // stagger starts WITH the bar build instead of after it, so the two
      // columns load together. (On the ≤850px stack the receipt sits below
      // the chart — the once-only early play just leaves the shipped final
      // state for phones to scroll onto, by design.)
      duelTl.to(
        payoffParts,
        { autoAlpha: 1, y: 0, duration: 0.6, stagger: 0.14 },
        0,
      );
      if (money) {
        const target = Number(money.dataset.gapMoney ?? "0");
        const index = payoffParts.findIndex((part) => part.contains(money));
        const proxy = { value: 0 };
        duelTl.to(
          proxy,
          {
            value: target,
            duration: 0.9,
            ease: "power1.out",
            onUpdate: () => {
              money.textContent = `$${Math.round(proxy.value).toLocaleString("en-US")}`;
            },
            onComplete: () => {
              money.textContent = moneyFinal;
            },
          },
          // Start the count-up when the gap line itself fades in (its
          // slot in the stagger above).
          `<+=${Math.max(index, 0) * 0.14}`,
        );
      }
    }

    if (closeParts.length) {
      // Closer beat (Task #3991): the gold rule drops in, then the kicker.
      // Its own trigger (below the chart columns) keeps the reveal
      // on-screen instead of firing off-fold with the duel.
      gsap.timeline({
        defaults: { ease: "power3.out" },
        scrollTrigger: {
          trigger: close,
          start: "top 88%",
          once: true,
          refreshPriority: -1,
        },
      }).to(closeParts, { autoAlpha: 1, y: 0, duration: 0.65, stagger: 0.16 });
    }

    return () => {
      // matchMedia revert restores every gsap-touched inline style; the
      // count-ups wrote textContent directly, so put the shipped final
      // numbers back by hand if the preference flips mid-visit.
      for (const el of nums) {
        el.textContent = el.dataset.gapCount ?? el.textContent;
      }
      if (money) money.textContent = moneyFinal;
      delete duel.dataset.gapAnim;
    };
  });
}
