// Single source for the current edition's store availability.
//
// Canonical Amazon and Audible product pages are not ready, so marketing
// surfaces must render these as non-interactive availability notices. Add
// destinations only when the client has confirmed the canonical product URLs.
export const BOOK_STORE_STATUS = "Coming Soon!";

export const BOOK_STORES = [
  { name: "Amazon", badge: "amazon.png" },
  { name: "Audible", badge: "audible.png" },
] as const;
