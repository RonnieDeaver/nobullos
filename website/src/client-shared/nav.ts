// Shared small-screen disclosure nav (hamburger) for the nb-* header chrome.
//
// Compiled into BOTH marketing client bundles — assets/js/home.js (homepage,
// via website/src/home-client/main.ts) and assets/js/site.js (shared-chrome
// subpages, via website/src/site-client/main.ts). PR5 replaced the two
// previously mirrored copies (a typed one in home-client/main.ts, a
// hand-authored one in the old public/assets/js/site.js) with this single
// source, so the two page classes cannot drift.
//
// Behavior: the button toggles an open class + aria-expanded, and the menu
// closes again on navigation (every entry is a link, including in-page
// anchors) and on Escape. Desktop is untouched: the toggle only renders at
// small widths (≤850px in both home.css and site.css).

export function initMobileNav(): void {
  const header = document.querySelector<HTMLElement>(".nb-header");
  const toggle = header?.querySelector<HTMLButtonElement>(".nb-nav-toggle");
  const menu = header?.querySelector<HTMLElement>("#nb-menu");
  if (!header || !toggle || !menu) return;

  const setOpen = (open: boolean): void => {
    header.classList.toggle("nb-menu-open", open);
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
  };

  toggle.addEventListener("click", () => {
    setOpen(!header.classList.contains("nb-menu-open"));
  });

  menu.addEventListener("click", (event) => {
    if ((event.target as HTMLElement | null)?.closest("a")) setOpen(false);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && header.classList.contains("nb-menu-open")) {
      setOpen(false);
      toggle.focus();
    }
  });
}
