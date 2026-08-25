// Lightweight /book/ client enhancement.
//
// The page remains complete without JavaScript. This module only preserves
// inbound attribution on the local purchase-options handoff, keeps the
// Digital Edition display aligned with the server's public catalog, and
// reveals the small-screen purchase bar once the hero has left the viewport.
// Complete Collection stays absent until a buyer-facing checkout can honor it.

import { captureAttribution } from "../client-shared/attribution";

captureAttribution();

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
document.documentElement.dataset.bookMotion = reduceMotion ? "reduce" : "allow";

const currentParams = new URLSearchParams(window.location.search);
document.querySelectorAll<HTMLAnchorElement>("[data-book-purchase]").forEach((link) => {
  const target = new URL(link.href, window.location.href);
  currentParams.forEach((value, key) => {
    if (!target.searchParams.has(key)) target.searchParams.append(key, value);
  });
  link.href = target.toString();
});

type PublicBookPackage = {
  code: string;
  name: string;
  amountCents: number;
  currency: string;
  shippingCents: number;
};

function formatUsd(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

function isPublicPackage(value: unknown): value is PublicBookPackage {
  if (!value || typeof value !== "object") return false;
  const pkg = value as Record<string, unknown>;
  return (
    typeof pkg.code === "string" &&
    typeof pkg.name === "string" &&
    typeof pkg.amountCents === "number" &&
    Number.isInteger(pkg.amountCents) &&
    pkg.amountCents >= 0 &&
    pkg.currency === "USD" &&
    typeof pkg.shippingCents === "number" &&
    Number.isInteger(pkg.shippingCents) &&
    pkg.shippingCents >= 0
  );
}

function setDigitalCatalogDetails(pkg: PublicBookPackage): void {
  document.querySelectorAll<HTMLElement>("[data-book-digital-price]").forEach((element) => {
    element.textContent = formatUsd(pkg.amountCents);
  });
  document.querySelectorAll<HTMLElement>("[data-book-digital-name]").forEach((element) => {
    element.textContent = pkg.name;
  });
}

async function loadCatalog(): Promise<void> {
  const catalog = document.querySelector<HTMLElement>("[data-book-catalog]");
  if (!catalog) return;

  try {
    const response = await fetch("/api/book/checkout/catalog", {
      headers: { Accept: "application/json" },
      credentials: "same-origin",
    });
    if (!response.ok) return;
    const payload = (await response.json()) as { packages?: unknown };
    if (!Array.isArray(payload.packages)) return;
    const packages = payload.packages.filter(isPublicPackage);
    const digital = packages.find((pkg) => pkg.code === "digital");
    if (digital) setDigitalCatalogDetails(digital);
    // Catalog selectability alone does not prove the current buyer-facing
    // handoff can display, sell, and fulfill a physical package. Fail closed:
    // do not expose any additional package until that checkout exists.
  } catch {
    // A catalog outage must not fabricate an offer. The no-JS Digital Edition
    // card stays available and the checkout validates the authoritative package.
  } finally {
    catalog.dataset.ready = "true";
  }
}

void loadCatalog();

const hero = document.querySelector<HTMLElement>("[data-book-hero]");
const sticky = document.querySelector<HTMLElement>("[data-book-sticky]");

if (hero && sticky && "IntersectionObserver" in window) {
  const setStickyVisibility = (visible: boolean): void => {
    sticky.dataset.state = visible ? "visible" : "hidden";
    sticky.setAttribute("aria-hidden", visible ? "false" : "true");
    sticky.inert = !visible;
  };

  const observer = new IntersectionObserver(
    ([entry]) => {
      const visible = !entry.isIntersecting && entry.boundingClientRect.bottom < 0;
      setStickyVisibility(visible);
    },
    { threshold: 0 },
  );
  observer.observe(hero);
}