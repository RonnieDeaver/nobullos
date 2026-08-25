/* test-registration
{
  "name": "Client profile Text/Call quick actions (Task #4305)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Pins the only client-profile → Conversation Hub deep-link contract (phone/contactName/clientId/intent params), the multi-number picker resolution order + dedupe, and the no-phone disabled state. Pure helpers plus two tiny component mounts in jsdom: no DB, no network, deterministic and seconds-fast.",
  "scanPaths": [
    "client/src/pages/ClientDetail.tsx",
    "client/src/components/CommandPanel.tsx",
    "client/src/components/ClientMessaging.tsx"
  ],
  "extraNodeArgs": [
    "--import",
    "./tests/client-comms-quick-actions-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #4305 — Text and call clients from their profile page.
 *
 * What this pins (and why at this layer):
 *
 *  1. `buildContactHubUrl` — the ONE shared builder for Conversation Hub
 *     deep links (`/comms?view=clients&phone=…&contactName=…&clientId=…&intent=…`).
 *     ConversationHub.tsx consumes exactly these params; a drift here breaks
 *     every profile → hub affordance at once.
 *  2. `collectClientPhoneOptions` — number resolution for the header quick
 *     actions: client primary contact phone first, then contact-record
 *     phones (primary contacts first), blanks dropped, duplicates collapsed
 *     by last-10-digit key (mirrors the hub's own thread-match rule).
 *  3. `<ClientCommsQuickActions>` — header Text/Call buttons: direct open
 *     with a single known number, dropdown picker with several, disabled +
 *     hint with none (no dead-end clicks). Mounted directly (light mount)
 *     instead of the 2000+-line ClientDetail page.
 *  4. `<PhoneHubIconActions>` — the message/call icon pair rendered beside a
 *     specific phone (Command Panel client info + contact rows).
 *  5. Host wiring — source-level asserts (paths declared in scanPaths) that
 *     BOTH profile locations actually render the shared components and that
 *     no surface keeps a private copy of the URL builder, so there is one
 *     comms flow, not two.
 *
 * The heavy alternatives (full ClientDetail/CommandPanel mounts) add nothing
 * to this contract: the quick-action behavior is fully contained in the
 * shared components, and their presence in the hosts is a static fact.
 */

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
  pretendToBeVisual: true,
  url: "http://localhost/",
});
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
(globalThis as any).navigator = dom.window.navigator;
(globalThis as any).HTMLElement = dom.window.HTMLElement;
(globalThis as any).Element = dom.window.Element;
(globalThis as any).Node = dom.window.Node;
(globalThis as any).Event = dom.window.Event;
(globalThis as any).MouseEvent = dom.window.MouseEvent;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// Capture Conversation Hub opens (the components call `window.open`).
type OpenCall = { url: string; target: string | undefined };
const opened: OpenCall[] = [];
(dom.window as any).open = (url: string, target?: string) => {
  opened.push({ url, target });
  return null;
};

import * as fs from "node:fs";
import * as path from "node:path";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import {
  buildContactHubUrl,
  collectClientPhoneOptions,
  phoneDedupeKey,
} from "../client/src/lib/contactHubUrl";
import {
  ClientCommsQuickActions,
  PhoneHubIconActions,
} from "../client/src/components/ClientCommsQuickActions";

let passed = 0;
let failed = 0;

function assert(cond: unknown, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

function section(title: string): void {
  console.log(`\n— ${title} —`);
}

function $(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
}

function hubParams(url: string): URLSearchParams {
  return new URLSearchParams(url.split("?")[1] ?? "");
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

function makeRoot(): Root {
  const container = document.getElementById("root")!;
  container.innerHTML = "";
  return createRoot(container);
}

async function unmount(root: Root): Promise<void> {
  await act(async () => {
    root.unmount();
  });
}

async function main(): Promise<void> {
  // ── 1. buildContactHubUrl ────────────────────────────────────────────────
  section("buildContactHubUrl — hub deep-link contract");
  {
    const url = buildContactHubUrl({
      phone: "+1 (555) 222-3333",
      contactName: "Jane Roe",
      clientId: "client-1",
      intent: "message",
    });
    assert(url.startsWith("/comms?view=clients"), "links point at the /comms clients view (Task #4373 convergence)");
    const p = hubParams(url);
    assert(p.get("phone") === "+1 (555) 222-3333", "phone passed through as stored (hub normalizes itself)");
    assert(p.get("contactName") === "Jane Roe", "contactName param present");
    assert(p.get("clientId") === "client-1", "clientId param present");
    assert(p.get("intent") === "message", "intent param present");

    const sparse = hubParams(buildContactHubUrl({ phone: "", clientId: "c9", intent: "call" }));
    assert(!sparse.has("phone"), "empty values are omitted, not sent as blanks");
    assert(sparse.get("intent") === "call", "call intent preserved");
  }

  // ── 2. collectClientPhoneOptions ─────────────────────────────────────────
  section("collectClientPhoneOptions — number resolution");
  {
    assert(phoneDedupeKey("+1 (555) 123-4567") === phoneDedupeKey("5551234567"),
      "dedupe key ignores formatting and country code (last 10 digits)");

    const opts = collectClientPhoneOptions({
      contactName: "Jane Roe",
      contactPhone: "+1 (555) 123-4567",
      contacts: [
        { name: "Billing Desk", phones: ["5551234567", "555-777-8888"], isPrimary: false },
        { name: "Ops Desk", phones: ["555-999-0000", "", "  "], isPrimary: true },
      ],
    });
    assert(opts.length === 3, `duplicate + blank phones collapsed (got ${opts.length}, want 3)`);
    assert(opts[0].phone === "+1 (555) 123-4567" && opts[0].contactName === "Jane Roe",
      "client primary contact phone is first and keeps the client contact name");
    assert(opts[1].phone === "555-999-0000" && opts[1].contactName === "Ops Desk",
      "primary contact-record phones come before non-primary ones");
    assert(opts[2].phone === "555-777-8888" && opts[2].contactName === "Billing Desk",
      "remaining contact phones follow in stored order");
    assert(opts[0].label === "Jane Roe — +1 (555) 123-4567", "picker label is name — number");

    assert(collectClientPhoneOptions({}).length === 0, "no inputs → no options");
    assert(
      collectClientPhoneOptions({ contactPhone: null, contacts: [{ name: "X", phones: ["", "  "] }] }).length === 0,
      "blank-only phones → no options",
    );
    const fallbackName = collectClientPhoneOptions({ contactPhone: "555-000-1111" })[0];
    assert(fallbackName.contactName === "Primary contact",
      'client phone without a contact name labels as "Primary contact"');
  }

  // ── 3. Header quick actions — single number ──────────────────────────────
  section("ClientCommsQuickActions — single known number opens the hub directly");
  {
    const root = makeRoot();
    await act(async () => {
      root.render(
        React.createElement(ClientCommsQuickActions, {
          clientId: "client-1",
          contactName: "Jane Roe",
          contactPhone: "+1 (555) 123-4567",
          contacts: [],
        }),
      );
    });

    const textBtn = $("button-quick-text");
    const callBtn = $("button-quick-call");
    assert(!!textBtn && !!callBtn, "Text and Call buttons render");
    assert(!(textBtn as HTMLButtonElement).disabled && !(callBtn as HTMLButtonElement).disabled,
      "both buttons enabled when a number is known");

    opened.length = 0;
    await click(textBtn!);
    assert(opened.length === 1, "Text click opens exactly one hub link");
    let p = hubParams(opened[0]?.url ?? "");
    assert(opened[0]?.url.startsWith("/comms?view=clients"), "Text opens the comms clients view");
    assert(p.get("intent") === "message", "Text uses intent=message");
    assert(p.get("phone") === "+1 (555) 123-4567", "Text targets the resolved number");
    assert(p.get("clientId") === "client-1", "Text carries the clientId");
    assert(p.get("contactName") === "Jane Roe", "Text carries the contact name");
    assert(opened[0]?.target === "_blank", "opens in a new tab like the contact-row buttons");

    await click(callBtn!);
    assert(opened.length === 2, "Call click opens exactly one hub link");
    p = hubParams(opened[1]?.url ?? "");
    assert(p.get("intent") === "call", "Call uses intent=call");
    assert(p.get("phone") === "+1 (555) 123-4567", "Call targets the resolved number");

    await unmount(root);
  }

  // ── 4. Header quick actions — no phone on file ───────────────────────────
  section("ClientCommsQuickActions — no phone → disabled with hint, no dead ends");
  {
    const root = makeRoot();
    await act(async () => {
      root.render(
        React.createElement(ClientCommsQuickActions, {
          clientId: "client-1",
          contactName: "Jane Roe",
          contactPhone: null,
          contacts: [{ name: "Ops Desk", phones: [], isPrimary: true }],
        }),
      );
    });

    const textBtn = $("button-quick-text") as HTMLButtonElement | null;
    const callBtn = $("button-quick-call") as HTMLButtonElement | null;
    assert(!!textBtn && !!callBtn, "buttons still render (discoverable, not hidden)");
    assert(!!textBtn?.disabled && !!callBtn?.disabled, "both buttons disabled without a number");
    const hint = $("button-quick-text-no-phone");
    assert(!!hint && (hint.getAttribute("title") || "").includes("No phone number on file"),
      "hint explains why the action is unavailable");

    opened.length = 0;
    await click(textBtn!);
    await click(callBtn!);
    assert(opened.length === 0, "clicking disabled actions never opens the hub");

    await unmount(root);
  }

  // ── 5. Header quick actions — multiple numbers → picker ──────────────────
  section("ClientCommsQuickActions — multiple numbers offer a picker");
  {
    const root = makeRoot();
    await act(async () => {
      root.render(
        React.createElement(ClientCommsQuickActions, {
          clientId: "client-1",
          contactName: "Jane Roe",
          contactPhone: "+1 (555) 123-4567",
          contacts: [
            { name: "Billing Desk", phones: ["5551234567", "555-777-8888"], isPrimary: false },
            { name: "Ops Desk", phones: ["555-999-0000"], isPrimary: true },
          ],
        }),
      );
    });

    // Dropdown shim renders content inline, so items are queryable directly.
    assert(!!$("menuitem-quick-message-0") && !!$("menuitem-quick-message-1") && !!$("menuitem-quick-message-2"),
      "Text picker lists all three distinct numbers");
    assert(!$("menuitem-quick-message-3"), "Text picker holds exactly three entries (dup collapsed)");
    assert(!!$("menuitem-quick-call-0") && !!$("menuitem-quick-call-2"), "Call picker lists the same numbers");
    assert(($("menuitem-quick-message-0")?.textContent || "").includes("Jane Roe"),
      "first picker entry is the client primary contact phone");

    opened.length = 0;
    await click($("menuitem-quick-message-1")!);
    let p = hubParams(opened[0]?.url ?? "");
    assert(opened.length === 1 && p.get("phone") === "555-999-0000" && p.get("intent") === "message",
      "picking the second number texts that number");
    assert(p.get("contactName") === "Ops Desk", "picked entry carries its own contact name");

    await click($("menuitem-quick-call-2")!);
    p = hubParams(opened[1]?.url ?? "");
    assert(opened.length === 2 && p.get("phone") === "555-777-8888" && p.get("intent") === "call",
      "picking the third number calls that number");

    await unmount(root);
  }

  // ── 6. PhoneHubIconActions — the per-phone icon pair ─────────────────────
  section("PhoneHubIconActions — Command Panel / contact-row icon pair");
  {
    const root = makeRoot();
    await act(async () => {
      root.render(
        React.createElement(PhoneHubIconActions, {
          phone: "555-123-9999",
          contactName: "Solo Contact",
          clientId: "client-9",
          messageTestId: "button-client-info-message",
          callTestId: "button-client-info-call",
        }),
      );
    });

    const msgBtn = $("button-client-info-message");
    const callBtn = $("button-client-info-call");
    assert(!!msgBtn && !!callBtn, "message and call icon buttons render with host testids");
    assert(msgBtn?.getAttribute("title") === "Message in Conversation Hub"
      && callBtn?.getAttribute("title") === "Call in Conversation Hub",
      "titles match the established contact-row affordances");

    opened.length = 0;
    await click(msgBtn!);
    let p = hubParams(opened[0]?.url ?? "");
    assert(p.get("intent") === "message" && p.get("phone") === "555-123-9999"
      && p.get("clientId") === "client-9" && p.get("contactName") === "Solo Contact",
      "message icon deep-links the hub with the exact phone + client");

    await click(callBtn!);
    p = hubParams(opened[1]?.url ?? "");
    assert(p.get("intent") === "call" && p.get("phone") === "555-123-9999",
      "call icon uses intent=call for the same number");

    await unmount(root);
  }

  // ── 7. Host wiring — both locations render the shared components ─────────
  section("Host wiring — one comms flow, not two (paths declared in scanPaths)");
  {
    const read = (rel: string) => fs.readFileSync(path.resolve(process.cwd(), rel), "utf8");
    const clientDetail = read("client/src/pages/ClientDetail.tsx");
    const commandPanel = read("client/src/components/CommandPanel.tsx");
    const clientMessaging = read("client/src/components/ClientMessaging.tsx");

    assert(clientDetail.includes("<ClientCommsQuickActions"),
      "ClientDetail header renders the quick actions");
    assert(clientDetail.includes("contacts={clientSummary?.contacts}"),
      "header quick actions receive contact-record phones for fallback/picker");
    assert(clientDetail.includes("<PhoneHubIconActions"),
      "ClientDetail contact rows render the shared icon pair");
    assert(commandPanel.includes("<PhoneHubIconActions"),
      "Command Panel client-info phone renders the shared icon pair");
    assert(commandPanel.includes('messageTestId="button-client-info-message"'),
      "Command Panel phone actions keep their stable testids");

    for (const [name, src] of [
      ["ClientDetail", clientDetail],
      ["CommandPanel", commandPanel],
      ["ClientMessaging", clientMessaging],
    ] as const) {
      assert(!/function\s+build(Contact)?HubUrl\s*\(/.test(src),
        `${name} keeps no private copy of the hub URL builder`);
    }
    assert(clientMessaging.includes('from "@/lib/contactHubUrl"'),
      "ClientMessaging consumes the shared helper");
  }

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    console.error("client-profile-comms-quick-actions: FAILED");
    process.exit(1);
  }
  console.log("client-profile-comms-quick-actions: PASSED");
  process.exit(0);
}

main().catch((err) => {
  console.error("client-profile-comms-quick-actions: FAILED");
  console.error(err);
  process.exit(1);
});
