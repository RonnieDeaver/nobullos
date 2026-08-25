/* test-registration
{
  "name": "Ads OS ClickUp Practice Area contract — strict canonical metadata, ordered multi-value projection, shared parent-to-CID mapping, idempotent replacement, and outage-safe cache behavior",
  "regression": true,
  "smoke": true,
  "smokeReason": "Pins the canonical ClickUp Practice Area vendor boundary used by Ads OS. Fetch and write boundaries are fully stubbed: no DB, no vendor traffic, no timers.",
  "tier": "medium"
}
test-registration */
/**
 * ClickUp Practice Area contract.
 *
 * This suite intentionally exercises the public directory/writeback seams
 * instead of exporting parser internals. All ClickUp reads and writes are
 * stubbed, including timeout/rate-limit/auth failures.
 */

import { strict as assert } from "node:assert";

process.env.CLICKUP_API_TOKEN = "pk_fake_practice_area_contract";

const {
  CLICKUP_CLIENT_CID_FIELD_ID,
  CLICKUP_PRACTICE_AREA_FIELD_ID,
} = await import("../server/services/adsOs/config");
const {
  __setDirectoryAlertHooksForTest,
  __testResetDirectoryCache,
  __test_drainDirectoryAlertWork,
  __setPracticeAreaWriteRequestForTest,
  bundleIsLive,
  getClientDirectory,
  practiceAreasForCid,
  replacePracticeAreasForCid,
} = await import("../server/services/adsOs/clickUpDirectory");
const {
  __resetClickUpCompanyTokenForTest,
  __setClickUpCompanyTokenStoreForTest,
} = await import("../server/services/clickUpCompanyToken");

__setDirectoryAlertHooksForTest({
  onSuccess: async () => {},
  onFailure: async () => {},
});
__setClickUpCompanyTokenStoreForTest({
  get: async () => undefined,
  set: async () => {},
  del: async () => {},
  recordAudit: async () => {},
});

const OPTION_IDS = {
  immigration: "pa-immigration",
  family: "pa-family",
  criminal: "pa-criminal",
} as const;

const OPTIONS = [
  { id: OPTION_IDS.criminal, label: "Criminal Defense", orderindex: 2 },
  { id: OPTION_IDS.immigration, label: "Immigration", orderindex: 0 },
  { id: OPTION_IDS.family, label: "Family", orderindex: 1 },
];

type FieldMode =
  | "valid"
  | "missing"
  | "ambiguous"
  | "wrong-id"
  | "wrong-type"
  | "whitespace-name"
  | "nonnumeric-order"
  | "empty-options"
  | "malformed-options";
type TaskMode =
  | "valid"
  | "object-selection"
  | "unknown-selection"
  | "duplicate-selection"
  | "malformed-selection"
  | "ambiguous-cid";

let fieldMode: FieldMode = "valid";
let taskMode: TaskMode = "valid";
let readOutage = false;
let realFetchCalls = 0;
let realWriteMode: "none" | "rate-limit" = "none";
let realWriteCalls = 0;

function response(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function practiceField(overrides: Record<string, unknown> = {}): any {
  return {
    id: CLICKUP_PRACTICE_AREA_FIELD_ID,
    name: "Practice Area",
    type: "labels",
    type_config: { options: OPTIONS },
    ...overrides,
  };
}

function fieldsPayload(): unknown {
  switch (fieldMode) {
    case "missing":
      return { fields: [] };
    case "ambiguous":
      return {
        fields: [
          practiceField(),
          practiceField({ id: "duplicate-practice-area-field" }),
        ],
      };
    case "wrong-type":
      return { fields: [practiceField({ type: "drop_down" })] };
    case "wrong-id":
      return { fields: [practiceField({ id: "drifted-practice-area-field" })] };
    case "whitespace-name":
      return { fields: [practiceField({ name: " Practice Area " })] };
    case "nonnumeric-order":
      return {
        fields: [
          practiceField({
            type_config: {
              options: [
                ...OPTIONS.slice(0, 2),
                { ...OPTIONS[2], orderindex: "" },
              ],
            },
          }),
        ],
      };
    case "empty-options":
      return {
        fields: [practiceField({ type_config: { options: [] } })],
      };
    case "malformed-options":
      return {
        fields: [
          practiceField({
            type_config: {
              options: [
                ...OPTIONS,
                {
                  id: "pa-duplicate-label",
                  label: "Family",
                  orderindex: 3,
                },
              ],
            },
          }),
        ],
      };
    default:
      return { fields: [practiceField()] };
  }
}

function tasksPayload(): unknown {
  const selection =
    taskMode === "unknown-selection"
      ? ["unknown-option-id"]
      : taskMode === "object-selection"
        ? [{ id: OPTION_IDS.criminal }, { id: OPTION_IDS.family }]
        : taskMode === "duplicate-selection"
          ? [OPTION_IDS.family, OPTION_IDS.family]
      : taskMode === "malformed-selection"
        ? "not-an-array"
        : [OPTION_IDS.criminal, OPTION_IDS.family];
  const tasks = [
      {
        id: "parent-alpha",
        name: "Alpha Law",
        parent: null,
        status: { status: "active" },
        custom_fields: [
          {
            ...practiceField(),
            value: selection,
          },
        ],
      },
      {
        id: "parent-beta",
        name: "Beta Law",
        parent: null,
        status: { status: "active" },
        custom_fields: [],
      },
      {
        id: "alpha-gads",
        name: "Google Ads",
        parent: "parent-alpha",
        status: { status: "active" },
        custom_fields: [
          {
            id: CLICKUP_CLIENT_CID_FIELD_ID,
            value: "111-222-3333",
          },
        ],
      },
      {
        id: "alpha-lsa",
        name: "LSA - Austin",
        parent: "parent-alpha",
        status: { status: "active" },
        custom_fields: [
          {
            id: CLICKUP_CLIENT_CID_FIELD_ID,
            value: "444-555-6666",
          },
        ],
      },
      {
        id: "beta-gads",
        name: "Google Ads",
        parent: "parent-beta",
        status: { status: "active" },
        custom_fields: [
          {
            id: CLICKUP_CLIENT_CID_FIELD_ID,
            value: "777-888-9999",
          },
        ],
      },
    ];
  if (taskMode === "ambiguous-cid") {
    tasks.push({
      id: "beta-lsa-duplicate-cid",
      name: "LSA - Dallas",
      parent: "parent-beta",
      status: { status: "active" },
      custom_fields: [
        {
          id: CLICKUP_CLIENT_CID_FIELD_ID,
          value: "111-222-3333",
        },
      ],
    });
  }
  return {
    last_page: true,
    tasks,
  };
}

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: RequestInit) => {
  const pathname = new URL(String(input)).pathname;
  if (!pathname.startsWith("/api/v2/")) {
    realFetchCalls++;
    throw new Error(`unexpected non-ClickUp fetch: ${String(input)}`);
  }
  if (init?.method === "POST") {
    realWriteCalls++;
    if (realWriteMode === "rate-limit") {
      return response({ err: "slow down" }, 429, {
        "X-RateLimit-Reset": String(Math.floor(Date.now() / 1000)),
      });
    }
    throw new Error(`unexpected unstubbed ClickUp write: ${pathname}`);
  }
  if (readOutage) return response({ err: "stubbed outage" }, 503);
  if (/\/list\/[^/]+\/field$/.test(pathname)) return response(fieldsPayload());
  if (/\/list\/[^/]+\/task$/.test(pathname)) return response(tasksPayload());
  throw new Error(`unexpected ClickUp read: ${pathname}`);
}) as typeof fetch;

let writeCalls: Array<{
  method: string;
  path: string;
  body: unknown;
}> = [];

function installWriteResponses(
  outcomes: Array<
    | { ok: boolean; status: number; text: string }
    | Error
  >,
): void {
  let cursor = 0;
  __setPracticeAreaWriteRequestForTest(async (args) => {
    writeCalls.push({ method: args.method, path: args.path, body: args.body });
    const outcome = outcomes[Math.min(cursor++, outcomes.length - 1)];
    if (outcome instanceof Error) throw outcome;
    return outcome;
  });
}

async function rejectMessage(
  promise: Promise<unknown>,
  pattern: RegExp,
): Promise<void> {
  await assert.rejects(promise, pattern);
}

try {
  console.log("phase 1: strict field metadata");
  for (const [mode, pattern] of [
    ["missing", /missing the exact "Practice Area"/i],
    ["ambiguous", /has 2 exact "Practice Area"/i],
    ["wrong-id", /field ID drifted/i],
    ["wrong-type", /expected "labels"/i],
    ["whitespace-name", /missing the exact "Practice Area"/i],
    ["nonnumeric-order", /option 3 is malformed/i],
    ["empty-options", /has no canonical options/i],
    ["malformed-options", /duplicate ID, label, or order index/i],
  ] as const) {
    __testResetDirectoryCache();
    fieldMode = mode;
    await rejectMessage(
      getClientDirectory({ force: true, throwOnError: true }),
      pattern,
    );
    assert.equal(bundleIsLive(), false, `${mode} metadata is fail-closed`);
  }

  console.log("phase 2: ordered option and parent-to-CID projection");
  __testResetDirectoryCache();
  fieldMode = "valid";
  taskMode = "valid";
  const initial = await getClientDirectory({
    force: true,
    throwOnError: true,
  });
  assert.deepEqual(
    initial.practiceAreaOptions.map(({ id, label, orderindex }) => ({
      id,
      label,
      orderindex,
    })),
    [
      { id: OPTION_IDS.immigration, label: "Immigration", orderindex: 0 },
      { id: OPTION_IDS.family, label: "Family", orderindex: 1 },
      {
        id: OPTION_IDS.criminal,
        label: "Criminal Defense",
        orderindex: 2,
      },
    ],
  );
  assert.deepEqual(initial.clients["alpha law"].practice_areas, [
    "Family",
    "Criminal Defense",
  ]);
  assert.deepEqual(initial.cidPracticeAreas["1112223333"], [
    "Family",
    "Criminal Defense",
  ]);
  assert.deepEqual(initial.cidPracticeAreas["4445556666"], [
    "Family",
    "Criminal Defense",
  ]);
  assert.deepEqual(initial.cidPracticeAreas["7778889999"], []);
  assert.deepEqual(await practiceAreasForCid("444-555-6666"), [
    "Family",
    "Criminal Defense",
  ]);
  taskMode = "object-selection";
  const objectSelection = await getClientDirectory({
    force: true,
    throwOnError: true,
  });
  assert.deepEqual(objectSelection.cidPracticeAreas["1112223333"], [
    "Family",
    "Criminal Defense",
  ]);
  taskMode = "valid";

  console.log("phase 3: idempotent full replacement and cache patch");
  installWriteResponses([{ ok: true, status: 200, text: "{}" }]);
  const unchanged = await replacePracticeAreasForCid("111-222-3333", [
    "Criminal Defense",
    "Family",
    "Criminal Defense",
  ]);
  assert.equal(unchanged.changed, false);
  assert.deepEqual(
    unchanged.labels,
    ["Family", "Criminal Defense"],
    "duplicate submitted labels are deduped into canonical ClickUp order",
  );
  assert.equal(writeCalls.length, 0, "same canonical set does not write");

  writeCalls = [];
  installWriteResponses([
    { ok: false, status: 503, text: '{"err":"temporary"}' },
    { ok: true, status: 200, text: "{}" },
  ]);
  const changed = await replacePracticeAreasForCid("4445556666", ["Family"]);
  assert.equal(changed.changed, true);
  assert.equal(changed.parentTaskId, "parent-alpha");
  assert.equal(writeCalls.length, 2, "one safe retry on transient 5xx");
  assert.equal(writeCalls[0].method, "POST");
  assert.match(
    writeCalls[0].path,
    /\/task\/parent-alpha\/field\/237317f2-e612-4983-baf7-97166de73a77$/,
  );
  assert.deepEqual(writeCalls[0].body, {
    value: [{ id: OPTION_IDS.family }],
  });
  const afterChange = await getClientDirectory();
  assert.deepEqual(afterChange.cidPracticeAreas["1112223333"], ["Family"]);
  assert.deepEqual(afterChange.cidPracticeAreas["4445556666"], ["Family"]);
  assert.deepEqual(afterChange.clients["alpha law"].practice_areas, ["Family"]);

  writeCalls = [];
  installWriteResponses([{ ok: true, status: 200, text: "{}" }]);
  const emptied = await replacePracticeAreasForCid("1112223333", []);
  assert.equal(emptied.changed, true);
  assert.deepEqual(writeCalls[0].body, { value: [] });
  const afterEmpty = await getClientDirectory();
  assert.deepEqual(afterEmpty.cidPracticeAreas["1112223333"], []);
  assert.deepEqual(afterEmpty.cidPracticeAreas["4445556666"], []);

  console.log("phase 4: validation and failed writes preserve last good data");
  await rejectMessage(
    replacePracticeAreasForCid("1112223333", ["Unknown Area"]),
    /Unknown canonical Practice Area label/i,
  );
  await rejectMessage(
    replacePracticeAreasForCid("0000000000", ["Family"]),
    /not mapped to a live parent client/i,
  );

  taskMode = "ambiguous-cid";
  writeCalls = [];
  installWriteResponses([{ ok: true, status: 200, text: "{}" }]);
  await rejectMessage(
    replacePracticeAreasForCid("1112223333", ["Family"]),
    /maps to multiple live ClickUp parents/i,
  );
  assert.equal(
    writeCalls.length,
    0,
    "fresh ambiguous mapping blocks egress instead of using stale parent ownership",
  );
  taskMode = "valid";

  readOutage = true;
  writeCalls = [];
  installWriteResponses([{ ok: true, status: 200, text: "{}" }]);
  await rejectMessage(
    replacePracticeAreasForCid("1112223333", ["Family"]),
    /HTTP 503/i,
  );
  assert.equal(
    writeCalls.length,
    0,
    "failed forced refresh cannot authorize a write from the stale display bundle",
  );
  readOutage = false;

  for (const [outcomes, pattern] of [
    [
      [{ ok: false, status: 401, text: '{"err":"unauthorized"}' }],
      /authorization failed \(HTTP 401\)/i,
    ],
    [[new DOMException("timed out", "TimeoutError")], /failed twice/i],
  ] as const) {
    writeCalls = [];
    installWriteResponses([...outcomes]);
    await rejectMessage(
      replacePracticeAreasForCid("1112223333", ["Family"]),
      pattern,
    );
    const preserved = await getClientDirectory();
    assert.deepEqual(
      preserved.cidPracticeAreas["1112223333"],
      ["Family", "Criminal Defense"],
      "failed write leaves cache untouched",
    );
  }

  __setPracticeAreaWriteRequestForTest(null);
  realWriteMode = "rate-limit";
  realWriteCalls = 0;
  await rejectMessage(
    replacePracticeAreasForCid("1112223333", ["Family"]),
    /rate limited \(HTTP 429\)/i,
  );
  assert.equal(realWriteCalls, 2, "shared ClickUp client bounds 429 retry to one");
  assert.deepEqual(
    (await getClientDirectory()).cidPracticeAreas["1112223333"],
    ["Family", "Criminal Defense"],
  );
  realWriteMode = "none";

  console.log("phase 5: malformed selection/outage preserve stale bundle and recover");
  taskMode = "unknown-selection";
  await rejectMessage(
    getClientDirectory({ force: true, throwOnError: true }),
    /unknown Practice Area option ID/i,
  );
  assert.equal(bundleIsLive(), false);
  assert.deepEqual(
    (await getClientDirectory()).cidPracticeAreas["1112223333"],
    ["Family", "Criminal Defense"],
  );

  taskMode = "malformed-selection";
  await rejectMessage(
    getClientDirectory({ force: true, throwOnError: true }),
    /malformed Practice Area selection/i,
  );
  assert.deepEqual(
    (await getClientDirectory()).cidPracticeAreas["1112223333"],
    ["Family", "Criminal Defense"],
  );

  taskMode = "duplicate-selection";
  await rejectMessage(
    getClientDirectory({ force: true, throwOnError: true }),
    /duplicate Practice Area option ID/i,
  );

  taskMode = "valid";
  readOutage = true;
  const stale = await getClientDirectory({ force: true });
  assert.deepEqual(stale.cidPracticeAreas["1112223333"], [
    "Family",
    "Criminal Defense",
  ]);
  assert.equal(bundleIsLive(), false);

  readOutage = false;
  const recovered = await getClientDirectory({
    force: true,
    throwOnError: true,
  });
  assert.equal(bundleIsLive(), true);
  assert.deepEqual(recovered.cidPracticeAreas["1112223333"], [
    "Family",
    "Criminal Defense",
  ]);
  assert.equal(realFetchCalls, 0, "no real network path was used");

  console.log("ads-os-clickup-practice-area-contract: all assertions passed");
} finally {
  await __test_drainDirectoryAlertWork();
  __setDirectoryAlertHooksForTest(null);
  __setPracticeAreaWriteRequestForTest(null);
  __testResetDirectoryCache();
  __setClickUpCompanyTokenStoreForTest(null);
  __resetClickUpCompanyTokenForTest();
  globalThis.fetch = realFetch;
}