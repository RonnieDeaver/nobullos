/* test-registration
{
  "name": "Ads OS CriteriaEditor — dynamic ClickUp practice areas, multi-select/outage behavior, dual schedule pickers, and failed-load protection",
  "regression": true,
  "smoke": true,
  "smokeReason": "CriteriaEditor is opened from every Ads OS account surface. This fast, DB-free jsdom mount pins the server-driven ClickUp checkbox vocabulary, isolated unavailable state, and the two independent schedule keys without vendor or network access.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/criteria-editor-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #3675 — CriteriaEditor render + dual-schedule regression test.
 *
 * The per-client criteria modal is opened from 9 places (GAds/LSA dashboards,
 * client profile, every Ads OS tool) and carries TWO independent schedule
 * day-pickers (Google Ads `schedule_days` + LSA `lsa_schedule_days`,
 * Task #3673). Until now it had no automated render test — a field wired to
 * the wrong key, a picker that won't open, or an undefined form field crashing
 * the modal would only be caught by a human clicking "Edit criteria".
 *
 * This test mounts the REAL CriteriaEditor in jsdom with fetch stubbed for the
 * criteria GET/PUT and pins:
 *   1. The modal renders past the loading state with the loaded criteria.
 *   2. BOTH schedule pickers render, each showing the "Every day (no schedule
 *      set)" placeholder when its array is empty.
 *   3. Each picker opens independently and toggling a day in one does NOT
 *      leak into the other (the wrong-key wiring class of bug).
 *   4. Save issues a PUT whose body carries `schedule_days` and
 *      `lsa_schedule_days` SEPARATELY with exactly the toggled values, plus
 *      the untouched text fields round-tripped from the GET.
 *   5. Day order is normalized Mon→Sun regardless of click order.
 *   6. A failed GET blocks the form (load-error panel, no Save) so a blank
 *      form can never overwrite real saved criteria.
 *
 * jsdom globals are installed by tests/client/criteria-editor-setup.mjs
 * (--import) so react-dom's module-eval environment probes see a document.
 */

import { strict as assert } from "node:assert";
import { createFetchStub } from "../helpers/createFetchStub.mjs";

const dom = (globalThis as any).window;

// ---------------------------------------------------------------------------
// Fetch stub — in-memory criteria "server" recording every PUT body.
// ---------------------------------------------------------------------------

const CID = "1234567890";
const SERVER_OPTIONS = ["Estate Planning", "Immigration", "Criminal Appeals"];
const SERVER_CRITERIA = {
  business_name: "Acme Law",
  website: "https://acmelaw.example",
  practice_areas: ["Immigration"],
  service_area: "Austin, TX",
  services_offered: "Immigration law",
  services_not_offered: "",
  competitors: "",
  extra_protected_terms: "",
  notes: "",
  schedule_days: [] as string[],
  lsa_schedule_days: [] as string[],
};

const putBodies: any[] = [];
let getCount = 0;
let failGet = false;
let syncAvailable = true;
let syncReason: string | null = null;

(globalThis as any).fetch = createFetchStub({
  Headers: dom.Headers,
  routes: [
    {
      method: "GET",
      path: `/api/ads-os/clients/${CID}/criteria`,
      respond: () => {
        getCount++;
        if (failGet) return { status: 500, json: { detail: "boom from server" } };
        return {
          status: 200,
          json: {
            criteria: SERVER_CRITERIA,
            derived: { business_name: "Acme Law (detected)", service_area: "Austin (detected)" },
             practice_area_options: SERVER_OPTIONS,
             practice_area_sync_available: syncAvailable,
             practice_area_sync_reason: syncReason,
          },
        };
      },
    },
    {
      method: "PUT",
      path: `/api/ads-os/clients/${CID}/criteria`,
      respond: ({ init }: any) => {
        putBodies.push(JSON.parse(init.body));
        return { status: 200, json: { ok: true, updated_at: "2026-08-03T00:00:00Z" } };
      },
    },
  ],
  defaultJson: {},
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { CriteriaEditor } = await import(
  "../../client/src/pages/adsOs/components/CriteriaEditor"
);

let passed = 0;
function ok(cond: boolean, label: string): void {
  assert.equal(cond, true, label);
  passed++;
  console.log(`  ✓ ${label}`);
}

function $(testId: string): HTMLElement | null {
  return (globalThis as any).document.querySelector(
    `[data-testid="${testId}"]`,
  ) as HTMLElement | null;
}

async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
  }
}

async function clickById(testId: string): Promise<void> {
  const el = $(testId);
  assert(el !== null, `expected [data-testid="${testId}"] to exist before click`);
  await act(async () => {
    el!.dispatchEvent(new dom.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush(4);
}

async function changeById(testId: string, value: string): Promise<void> {
  const el = $(testId) as HTMLInputElement | HTMLTextAreaElement | null;
  assert(el !== null, `expected [data-testid="${testId}"] to exist before change`);
  const prototype =
    el instanceof dom.HTMLTextAreaElement
      ? dom.HTMLTextAreaElement.prototype
      : dom.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  assert(setter, `native value setter exists for ${testId}`);
  await act(async () => {
    setter!.call(el, value);
    el.dispatchEvent(new dom.Event("input", { bubbles: true }));
  });
  await flush(4);
}

let onSavedCalls = 0;
let root: ReturnType<typeof createRoot> | null = null;

async function mount(): Promise<void> {
  const container = (globalThis as any).document.getElementById("root")!;
  await act(async () => {
    root = createRoot(container);
    root.render(
      React.createElement(CriteriaEditor as any, {
        account: { customer_id: CID, descriptive_name: "Acme Law" },
        onClose: () => {},
        onSaved: () => {
          onSavedCalls++;
        },
      }),
    );
  });
  await flush();
}

async function unmount(): Promise<void> {
  await act(async () => {
    root?.unmount();
    root = null;
  });
}

// ---------------------------------------------------------------------------
// 1–2. Mounts past loading; both pickers render with the empty placeholder.
// ---------------------------------------------------------------------------

await mount();

ok($("modal-criteria") !== null, "modal renders");
ok(getCount === 1, "exactly one criteria GET issued on open");
ok($("button-criteria-save") !== null, "form (Save button) rendered — load completed");
ok(
  ($("input-business_name") as HTMLInputElement)?.value === "Acme Law",
  "business_name input carries the loaded value",
);

const gadsTrigger = $("button-schedule-days");
const lsaTrigger = $("button-lsa-schedule-days");
ok(gadsTrigger !== null, "Google Ads schedule picker renders");
ok(lsaTrigger !== null, "LSA schedule picker renders");
ok(
  gadsTrigger!.textContent!.includes("Every day (no schedule set)"),
  "GAds picker shows the 'Every day (no schedule set)' placeholder when empty",
);
ok(
  lsaTrigger!.textContent!.includes("Every day (no schedule set)"),
  "LSA picker shows the 'Every day (no schedule set)' placeholder when empty",
);

// ---------------------------------------------------------------------------
// 3. Server-driven practice-area options support zero/many and ClickUp order.
// ---------------------------------------------------------------------------

await clickById("button-practice-areas");
ok(
  $("checkbox-practice-estate-planning") !== null &&
    $("checkbox-practice-criminal-appeals") !== null,
  "practice-area menu renders the dynamic server-provided vocabulary",
);
ok(
  $("checkbox-practice-family") === null,
  "legacy hard-coded practice-area vocabulary is absent",
);
await clickById("checkbox-practice-immigration");
ok(
  $("button-practice-areas")!.textContent!.includes("Select practice areas"),
  "the multi-select supports zero selected practice areas",
);
await clickById("checkbox-practice-criminal-appeals");
await clickById("checkbox-practice-estate-planning");
ok(
  $("button-practice-areas")!.textContent!.includes(
    "Estate Planning, Criminal Appeals",
  ),
  "multiple selections display in ClickUp option order despite reverse click order",
);

// ---------------------------------------------------------------------------
// 4. Toggle days independently in each picker.
// ---------------------------------------------------------------------------

// Open the GAds picker; its day checkboxes appear, LSA's do not.
await clickById("button-schedule-days");
ok($("checkbox-day-Tue") !== null, "GAds picker opens (day checkboxes render)");
ok($("checkbox-lsa-day-Tue") === null, "LSA picker stays closed while GAds is open");

// Toggle Wed then Tue in the GAds picker (out of order — order test below).
await clickById("checkbox-day-Wed");
await clickById("checkbox-day-Tue");
ok(
  ($("checkbox-day-Tue") as HTMLInputElement).checked &&
    ($("checkbox-day-Wed") as HTMLInputElement).checked,
  "GAds picker: Tue + Wed toggled on",
);
ok(
  $("button-schedule-days")!.textContent!.includes("Tue, Wed"),
  "GAds trigger shows Mon→Sun-normalized selection 'Tue, Wed' despite reverse click order",
);

// Open the LSA picker and toggle a DIFFERENT day.
await clickById("button-lsa-schedule-days");
ok($("checkbox-lsa-day-Fri") !== null, "LSA picker opens (day checkboxes render)");
await clickById("checkbox-lsa-day-Fri");
ok(
  ($("checkbox-lsa-day-Fri") as HTMLInputElement).checked,
  "LSA picker: Fri toggled on",
);
ok(
  $("button-lsa-schedule-days")!.textContent!.includes("Fri") &&
    !$("button-lsa-schedule-days")!.textContent!.includes("Tue"),
  "LSA trigger shows only its own selection (no leak from the GAds picker)",
);
ok(
  $("button-schedule-days")!.textContent!.includes("Tue, Wed") &&
    !$("button-schedule-days")!.textContent!.includes("Fri"),
  "GAds trigger unchanged by the LSA toggle (no leak the other way)",
);

// ---------------------------------------------------------------------------
// 5–6. Save carries canonical practice areas and both schedules separately.
// ---------------------------------------------------------------------------

await clickById("button-criteria-save");
ok(putBodies.length === 1, "Save issues exactly one PUT");
ok(onSavedCalls === 1, "onSaved fires after a successful PUT");

const body = putBodies[0];
ok(
  JSON.stringify(body.schedule_days) === JSON.stringify(["Tue", "Wed"]),
  "PUT body schedule_days === ['Tue','Wed'] (Mon→Sun order kept)",
);
ok(
  JSON.stringify(body.lsa_schedule_days) === JSON.stringify(["Fri"]),
  "PUT body lsa_schedule_days === ['Fri'] — carried separately from schedule_days",
);
ok(
  body.business_name === "Acme Law" && body.service_area === "Austin, TX",
  "untouched text fields round-trip from the GET into the PUT body",
);
ok(
  JSON.stringify(body.practice_areas) ===
    JSON.stringify(["Estate Planning", "Criminal Appeals"]),
  "PUT body carries the dynamic multi-selection in ClickUp option order",
);
ok(
  JSON.stringify(body.practice_area_sync_base) === JSON.stringify(["Immigration"]),
  "PUT carries the originally loaded selection for stale-ClickUp conflict protection",
);

await unmount();

// ---------------------------------------------------------------------------
// 7. Failed load blocks the form — no Save button, error panel with Retry.
// ---------------------------------------------------------------------------

failGet = true;
await mount();
ok(
  $("text-criteria-load-error") !== null,
  "failed GET renders the load-error panel",
);
ok(
  $("text-criteria-load-error")!.textContent!.includes("boom from server"),
  "load-error panel surfaces the server detail message",
);
ok(
  $("button-criteria-save") === null,
  "no Save button on a failed load — blank form can never overwrite real criteria",
);
await unmount();

// ---------------------------------------------------------------------------
// 8. Pre-load ClickUp outage disables only practice areas; unrelated save works.
// ---------------------------------------------------------------------------

failGet = false;
syncAvailable = false;
syncReason = "No directory fetch has completed yet.";
await mount();
const unavailableTrigger = $("button-practice-areas") as HTMLButtonElement;
ok(unavailableTrigger.disabled, "practice-area trigger is disabled while ClickUp sync is unavailable");
ok(
  unavailableTrigger.textContent!.includes("Immigration"),
  "the loaded practice-area value stays visible in the disabled control",
);
ok(
  $("text-practice-area-unavailable")!.textContent!.includes(
    "Other criteria can still be edited and saved",
  ),
  "unavailable state explains that unrelated criteria remain editable",
);
await changeById("input-notes", "Unrelated edit during ClickUp outage");
await clickById("button-criteria-save");
ok(putBodies.length === 2, "unrelated criteria can still be saved during a pre-load outage");
ok(
  putBodies[1].notes === "Unrelated edit during ClickUp outage" &&
    JSON.stringify(putBodies[1].practice_areas) === JSON.stringify(["Immigration"]) &&
    JSON.stringify(putBodies[1].practice_area_sync_base) === JSON.stringify(["Immigration"]),
  "outage save preserves the disabled practice-area value while carrying the unrelated edit",
);
await unmount();

console.log(`\ncriteria-editor: ${passed} assertion(s) passed.`);
process.exit(0);
