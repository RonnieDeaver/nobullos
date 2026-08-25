/* test-registration
{
  "name": "BillingSection unlink-Stripe ConfirmActionDialog — trigger opens only, cancel fires nothing, confirm PATCHes /api/clients/:id/stripe-link (Task #4754)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4754: Task #4621 swapped BillingSection's unlink-Stripe window.confirm() for the trigger-wrapped shared ConfirmActionDialog, and no test clicked the converted button — a per-surface wiring mistake (unlink firing on trigger/cancel, or confirm never firing the mutation) would ship unnoticed. This mounts the REAL BillingSection in jsdom with a fully stubbed fetch and pins: trigger click fires no PATCH, cancel fires no PATCH, confirm fires exactly one PATCH /api/clients/:id/stripe-link with stripeCustomerId:null (the old confirm() endpoint). Fast, DB-free, deterministic.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/confirm-dialog-billing-unlink-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json",
    "NODE_ENV": "test"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #4754 — the trigger-wrapped ConfirmActionDialog conversion (Task #4621)
 * on BillingSection's "Unlink" Stripe-customer button actually gates the
 * mutation:
 *
 *   (A) the unlink trigger button renders on a linked billing card and
 *       clicking it fires NO write (the old window.confirm() path PATCHed
 *       straight from this click);
 *   (B) clicking the dialog's Cancel button fires NO write;
 *   (C) clicking the dialog's confirm button fires exactly ONE
 *       PATCH /api/clients/:id/stripe-link with { stripeCustomerId: null } —
 *       the same endpoint+body the old confirm() path used.
 *
 * The Radix AlertDialog is shimmed (portal never mounts in this raw jsdom
 * harness — see the setup file); the ConfirmActionDialog wiring, the trigger
 * button, and the unlinkMutation are the real code.
 */

import { JSDOM } from "jsdom";
import { createFetchStub } from "../helpers/createFetchStub.mjs";

const dom = new JSDOM(
  "<!doctype html><html><body><div id='root'></div></body></html>",
  { pretendToBeVisual: true, url: "http://localhost/" },
);
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
(globalThis as any).navigator = dom.window.navigator;
(globalThis as any).HTMLElement = dom.window.HTMLElement;
(globalThis as any).HTMLDivElement = dom.window.HTMLDivElement;
(globalThis as any).HTMLInputElement = dom.window.HTMLInputElement;
(globalThis as any).HTMLButtonElement = dom.window.HTMLButtonElement;
(globalThis as any).HTMLAnchorElement = dom.window.HTMLAnchorElement;
(globalThis as any).SVGElement = dom.window.SVGElement;
(globalThis as any).Element = dom.window.Element;
(globalThis as any).Node = dom.window.Node;
(globalThis as any).DocumentFragment = dom.window.DocumentFragment;
(globalThis as any).ShadowRoot = dom.window.ShadowRoot;
(globalThis as any).Event = dom.window.Event;
(globalThis as any).MouseEvent = dom.window.MouseEvent;
(globalThis as any).KeyboardEvent = dom.window.KeyboardEvent;
(globalThis as any).PointerEvent =
  (dom.window as any).PointerEvent ?? (dom.window as any).MouseEvent;
(globalThis as any).getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
(globalThis as any).location = dom.window.location;
(globalThis as any).localStorage = dom.window.localStorage;
(globalThis as any).requestAnimationFrame = (cb: any) => setTimeout(cb, 0);
(globalThis as any).cancelAnimationFrame = (id: any) => clearTimeout(id);
(dom.window as any).matchMedia =
  (dom.window as any).matchMedia ||
  ((q: string) => ({
    matches: false, media: q, onchange: null,
    addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {},
    dispatchEvent() { return false; },
  }));
(globalThis as any).matchMedia = (dom.window as any).matchMedia;
class ResizeObserverStub {
  observe() {} unobserve() {} disconnect() {}
}
(globalThis as any).ResizeObserver = ResizeObserverStub;
(dom.window as any).ResizeObserver = ResizeObserverStub;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

// ---------------------------------------------------------------------------
// Fixtures + fetch stub with a write recorder
// ---------------------------------------------------------------------------

const CLIENT_ID = "client-4754-billing";

const BILLING_RESPONSE = {
  configured: true,
  linked: true,
  billing: {
    stripeCustomerId: "cus_4754",
    customerName: "Acme Law Firm",
    customerEmail: "billing@acme.example",
    lifetimeValue: 250000,
    currency: "usd",
    activeSubscription: null,
    paymentStatus: {
      lastPaymentStatus: null,
      lastPaymentDate: null,
      lastPaymentAmount: null,
      hasFailedPayments: false,
      subscriptionStatus: null,
      cardBrand: null,
      cardLast4: null,
      cardExpMonth: null,
      cardExpYear: null,
      isCardExpiring: false,
    },
  },
};

// Every non-GET request lands here — the surface must fire NO write except
// the single confirmed PATCH.
const writeCalls: Array<{ method: string; url: string; body: string | null }> = [];

globalThis.fetch = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    {
      test: (_url: string, method: string) => method !== "GET",
      respond: ({ url, method, init, jsonResponse }: any) => {
        writeCalls.push({ method, url, body: init?.body ?? null });
        return jsonResponse(200, { ok: true });
      },
    },
    { path: `/api/clients/${CLIENT_ID}/billing`, json: BILLING_RESPONSE },
  ],
  defaultJson: {},
}) as any;

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

const React = (await import("react")).default ?? (await import("react"));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const BillingSection = (await import("../../client/src/components/BillingSection")).default as any;

function $(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
}

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush(4);
}

async function main(): Promise<void> {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  const root = createRoot(document.getElementById("root")!);
  await act(async () => {
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: qc },
        React.createElement(BillingSection, { clientId: CLIENT_ID }),
      ),
    );
  });
  await flush(12);

  assert($("card-billing"), "the linked billing card must render from the stubbed billing payload");

  // ── A. trigger renders; clicking it fires no write ────────────────────────
  const trigger = $("button-unlink-stripe");
  assert(trigger, "A: unlink-Stripe trigger button renders on the linked card");
  await click(trigger!);
  assert(
    writeCalls.length === 0,
    `A: clicking the trigger must fire NO write (old confirm() path PATCHed here) — got ${JSON.stringify(writeCalls)}`,
  );
  console.log("  ✓ A: trigger click opens the dialog without firing a write");

  // ── B. cancel fires nothing ────────────────────────────────────────────────
  const cancel = $("dialog-confirm-unlink-stripe-cancel");
  assert(cancel, "B: dialog cancel button is queryable");
  await click(cancel!);
  assert(
    writeCalls.length === 0,
    `B: Cancel must fire NO write — got ${JSON.stringify(writeCalls)}`,
  );
  console.log("  ✓ B: cancel fires nothing");

  // ── C. confirm fires exactly one PATCH to the old confirm() endpoint ──────
  const confirm = $("dialog-confirm-unlink-stripe-confirm");
  assert(confirm, "C: dialog confirm button is queryable");
  await click(confirm!);
  assert(
    writeCalls.length === 1,
    `C: confirm must fire exactly ONE write — got ${JSON.stringify(writeCalls)}`,
  );
  const call = writeCalls[0];
  assert(call.method === "PATCH", `C: the write must be a PATCH — got ${call.method}`);
  assert(
    call.url.endsWith(`/api/clients/${CLIENT_ID}/stripe-link`),
    `C: PATCH must hit /api/clients/${CLIENT_ID}/stripe-link (the pre-#4621 confirm() endpoint) — got ${call.url}`,
  );
  assert(
    JSON.parse(call.body || "{}").stripeCustomerId === null,
    `C: PATCH body must carry stripeCustomerId: null — got ${call.body}`,
  );
  console.log(`  ✓ C: confirm fires exactly one PATCH /api/clients/${CLIENT_ID}/stripe-link`);

  await act(async () => {
    root.unmount();
  });
  qc.clear();

  console.log("\nconfirm-dialog-billing-unlink: ALL TESTS PASSED");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
