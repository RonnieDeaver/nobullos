/* test-registration
{
  "name": "Docs Share dialog — roster loading + grant/revoke wiring (jsdom)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4053 UI contract: the Share dialog must populate its teammate picker from GET /api/docs/team-roster ({ users } wrapper) and issue PUT/DELETE against /api/docs/documents/:id/permissions. A response-shape mismatch here silently empties the picker and makes sharing nonfunctional for owners (the exact bug the completion review caught) while all route-level tests stay green. DB-free, network-free jsdom mount of the REAL DocShareDialog.",
  "extraNodeArgs": [
    "--import",
    "./tests/doc-share-dialog-setup.mjs"
  ],
  "extraEnv": {
    "NODE_ENV": "test",
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * DocShareDialog (client/src/components/docs/DocShareDialog.tsx) — jsdom
 * mount of the real component against a stubbed fetch:
 *
 *   1. The teammate picker is populated from GET /api/docs/team-roster's
 *      `{ users }` payload — candidates exclude the owner and anyone who
 *      already has a grant.
 *   2. Existing grants render with their role badges.
 *   3. Picking a teammate and submitting issues
 *      PUT /api/docs/documents/:id/permissions with { userId, role }.
 *   4. The revoke button issues DELETE .../permissions/:userId.
 *
 * Harness per memory notes (mount-large-client-component-jsdom,
 * radix-portal-jsdom-tests): jsdom globals installed before dynamic client
 * imports, Radix Dialog shimmed via the shared loader, Radix Select swapped
 * for an interactive shim so a click on an option fires onValueChange.
 */
import { strict as assert } from "node:assert";

import { JSDOM } from "jsdom";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — .mjs helper without type declarations
import { createFetchStub } from "./helpers/createFetchStub.mjs";

// ── jsdom bootstrap (must precede the dynamic client imports) ──
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  pretendToBeVisual: true,
  url: "http://localhost/docs",
});
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
(globalThis as any).navigator = dom.window.navigator;
(globalThis as any).location = dom.window.location;
(globalThis as any).history = dom.window.history;
(globalThis as any).localStorage = dom.window.localStorage;
(globalThis as any).dispatchEvent = dom.window.dispatchEvent.bind(dom.window);
(globalThis as any).addEventListener = dom.window.addEventListener.bind(dom.window);
(globalThis as any).removeEventListener = dom.window.removeEventListener.bind(dom.window);
(globalThis as any).HTMLElement = dom.window.HTMLElement;
(globalThis as any).HTMLInputElement = dom.window.HTMLInputElement;
(globalThis as any).HTMLButtonElement = dom.window.HTMLButtonElement;
(globalThis as any).Element = dom.window.Element;
(globalThis as any).Node = dom.window.Node;
(globalThis as any).MouseEvent = dom.window.MouseEvent;
(globalThis as any).Event = dom.window.Event;
(globalThis as any).CustomEvent = dom.window.CustomEvent;
(globalThis as any).getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
(globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) =>
  setTimeout(() => cb(0), 0) as unknown as number;
(globalThis as any).cancelAnimationFrame = (id: number) => clearTimeout(id);
if (!(globalThis as any).IS_REACT_ACT_ENVIRONMENT) {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
}

// ── Fixtures ──

const DOC_ID = "doc-share-1";
const OWNER_ID = "u-owner";

const ROSTER = {
  users: [
    { id: OWNER_ID, firstName: "Olive", lastName: "Owner", email: "olive@x.test", role: "account_manager" },
    { id: "u-granted", firstName: "Greta", lastName: "Granted", email: "greta@x.test", role: "account_manager" },
    { id: "u-fresh", firstName: "Frank", lastName: "Fresh", email: "frank@x.test", role: "account_manager" },
    { id: "u-other", firstName: "Nora", lastName: "New", email: "nora@x.test", role: "team_lead" },
  ],
};

const EXISTING_PERMISSIONS = {
  permissions: [
    { id: "p1", documentId: DOC_ID, userId: "u-granted", role: "viewer", grantedBy: OWNER_ID },
  ],
};

let failures = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err: any) {
    failures += 1;
    console.error(`  FAIL ${name}:`, err?.message ?? err);
  }
}

const $t = (id: string): HTMLElement | null =>
  document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

async function run(): Promise<void> {
  console.log("Docs Share dialog — roster loading + grant/revoke wiring");

  const React = (await import("react")).default as any;
  const { createRoot } = (await import("react-dom/client")) as any;
  const { act } = (await import("react")) as any;
  const { QueryClient, QueryClientProvider } = (await import("@tanstack/react-query")) as any;
  const { DocShareDialog } = (await import("@/components/docs/DocShareDialog")) as any;

  const flush = async (times = 10) => {
    for (let i = 0; i < times; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
    }
  };

  const click = async (el: HTMLElement) => {
    await act(async () => {
      el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await flush(5);
  };

  // Record write calls so the wiring contract is assertable.
  const putCalls: any[] = [];
  const deleteCalls: string[] = [];

  globalThis.fetch = createFetchStub({
    Headers: dom.window.Headers,
    routes: [
      { path: "/api/docs/team-roster", json: ROSTER },
      {
        method: "PUT",
        path: `/api/docs/documents/${DOC_ID}/permissions`,
        respond: ({ init }: any) => {
          const body = JSON.parse(init?.body ?? "{}");
          putCalls.push(body);
          return {
            status: 200,
            json: { permission: { id: "p-new", documentId: DOC_ID, ...body, grantedBy: OWNER_ID } },
          };
        },
      },
      {
        method: "DELETE",
        path: new RegExp(`/api/docs/documents/${DOC_ID}/permissions/[^/?]+$`),
        respond: ({ url }: any) => {
          deleteCalls.push(String(url).split("/").pop() as string);
          return { status: 200, json: { ok: true } };
        },
      },
      { path: `/api/docs/documents/${DOC_ID}/permissions`, json: EXISTING_PERMISSIONS },
    ],
    defaultJson: {},
  }) as any;

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(DocShareDialog, {
          open: true,
          onClose: () => {},
          documentId: DOC_ID,
          documentName: "Hiring plan",
          ownerId: OWNER_ID,
        }),
      ),
    );
  });
  await flush();

  await check("dialog mounts with the existing grant listed", () => {
    assert.ok($t("dialog-share-document"), "dialog container renders");
    const row = $t("share-row-u-granted");
    assert.ok(row, "existing grant row renders");
    assert.match(row!.textContent ?? "", /Greta Granted/, "grantee display name");
    assert.match(row!.textContent ?? "", /Viewer/, "role badge");
  });

  await check("teammate picker is populated from the roster payload (owner + granted excluded)", () => {
    const options = Array.from(
      document.querySelectorAll("[data-select-item-value]"),
    ) as HTMLElement[];
    const userOptionIds = options
      .map((o) => o.getAttribute("data-select-item-value"))
      .filter((v) => v?.startsWith("u-"));
    assert.deepEqual(
      userOptionIds.sort(),
      ["u-fresh", "u-other"],
      `picker candidates: got ${JSON.stringify(userOptionIds)} — an empty list here is the { users } response-shape bug`,
    );
  });

  await check("picking a teammate and submitting issues PUT { userId, role }", async () => {
    const option = document.querySelector('[data-select-item-value="u-fresh"]') as HTMLElement;
    assert.ok(option, "candidate option present");
    await click(option);
    const submit = $t("btn-add-share");
    assert.ok(submit, "submit button present");
    assert.equal(submit!.hasAttribute("disabled"), false, "submit enabled once a teammate is picked");
    await click(submit!);
    assert.equal(putCalls.length, 1, "exactly one PUT issued");
    assert.deepEqual(putCalls[0], { userId: "u-fresh", role: "viewer" }, "PUT body");
  });

  await check("revoke button issues DELETE for the grantee", async () => {
    const revoke = $t("btn-revoke-u-granted");
    assert.ok(revoke, "revoke button present");
    await click(revoke!);
    assert.deepEqual(deleteCalls, ["u-granted"], "DELETE issued for the granted user");
  });

  await act(async () => {
    root.unmount();
  });

  console.log(`\nTest run: ${4 - failures} passed, ${failures} failed`);
  // jsdom (pretendToBeVisual) keeps rAF/timer handles alive; nothing external
  // to drain, so exit explicitly to avoid a 180s harness hang.
  process.exit(failures > 0 ? 1 : 0);
}

// void: top-level runner; failures set the exit code inside run().
void run().catch((err) => {
  console.error("Test run crashed:", err);
  process.exit(1);
});
