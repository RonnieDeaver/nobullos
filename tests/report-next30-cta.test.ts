/* test-registration
{
  "name": "Next 30 Days climax + closing CTA (Task #4282) + finalized-report edit contract (Task #4801)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4282 (Backlog #29 + §8.7-11): the Next 30 Days slide is the deck's climax and now carries people-identity (account manager name+email for the closing CTA, per-action owner initials) on ANONYMOUS share/demo payloads. This suite defends invariants no other suite covers: (1) privacy-mode payloads serve accountManager=null and strip owner initials from both action columns — a drift leaks staff identity on anonymized decks; (2) the public sales sanitizer STILL strips signedByRep into totalSignedCases (previously pinned by no test at all); (3) the new nextActions write path caps/strips junk owner/due values and refuses to store a truthy-junk expansion flag — the hardcoded expansion pitch must never resurrect on every report; (4) the #4227 finalize guard still 422s when action columns carry owner/due but EMPTY action text; (5) the slide renders verdict/chips/CTA and degrades gracefully (no AM → generic line, no flag → no expansion band); (6) Task #4801's editable-after-finalize contract: an already-FINAL report accepts a nextActions section PUT and a final→final status PATCH with NO finalize gate, and the share payload serves the added action immediately — if a status gate ever lands on the section PUT path, the Report Form's post-finalize edit flow silently breaks. DB-backed route suite + pure SSR, no OpenAI (mock throws), well under the file cap.",
  "extraEnv": {
    "NODE_ENV": "test",
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #4282 — Next 30 Days climax + closing CTA.
 *
 *   1. PUT /api/reports/:id/sections/nextActions — focused sanitize for the
 *      NEW fields (persistence-write-boundaries): owner/due trimmed +
 *      hard-capped, non-strings dropped, empties deleted;
 *      showExpansionQuestion stores true ONLY for boolean true (junk truthy
 *      values store false). Legacy fields keep their log-only lane.
 *   2. GET /api/share/:token — serves accountManager {name,email} resolved
 *      from clients.ownerId; owner/due/showExpansionQuestion pass through;
 *      sales signedByRep is STILL summed into totalSignedCases and deleted.
 *   3. Privacy mode (?private=true) — accountManager null, owner initials
 *      stripped from BOTH columns, due hints retained.
 *   4. Ownerless client — accountManager null (CTA degrades, no 500).
 *   5. GET /api/demo-report — same resolver serves the demo client's owner.
 *   6. Finalize guard regression (#4227): a column whose items carry
 *      owner/due but EMPTY action text is still an EMPTY column → 422
 *      report_quality_confirm_required (owner/due must never count as a
 *      real action).
 *   6bis. Task #4801 — editable-after-finalize contract: with the report
 *      already FINAL, a nextActions PUT (operator adds an action after the
 *      review call) returns 200 with the status untouched, the share payload
 *      serves the new action immediately (no re-finalize), and a
 *      final→final status PATCH skips every finalize gate (they are
 *      draft→final transition-only, mirroring the Report Form fix).
 *   7. SSR (renderToStaticMarkup, ceo-pulse-slide-polish recipe): verdict
 *      line (slideVerdicts.next30Days), owner chips + due hints, expansion
 *      band ONLY when flagged, CTA with mailto button vs generic fallback.
 *
 * Harness mirrors tests/report-slide-verdicts.test.ts: express app +
 * registerReportRoutes, Clerk-era per-request auth seam, OpenAI singleton
 * mocked to THROW (this suite's paths must never bill), runInIsolatedSchema
 * with pinGetDbForCrossAsync.
 */

import assert from "node:assert/strict";
import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { getGlobalDispatcher } from "undici";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { registerReportRoutes } from "../server/routes/reports";
import { openai } from "../server/routes/middleware";
import {
  __test_markUserReconciled,
  __test_resetReconciledUsers,
} from "../server/middlewares/requireAuth";
import {
  NEXT_ACTION_OWNER_MAX_CHARS,
  NEXT_ACTION_DUE_MAX_CHARS,
} from "../shared/models/reports";
import { Next30DaysSlide } from "../client/src/pages/publicReport/Next30DaysSlide";
import { runInIsolatedSchema, sql } from "./db-sandbox";

// Clerk-era auth seam is honored only under NODE_ENV=test; self-establish so
// a bare `npx tsx tests/report-next30-cta.test.ts` repro authenticates too.
process.env.NODE_ENV = process.env.NODE_ENV || "test";

// Harness-agnostic JSX-runtime shim (ceo-pulse-slide-polish recipe): batched
// workers compile component .tsx with the CLASSIC transform, so bind React
// globally BEFORE the first render.
(globalThis as { React?: typeof React }).React = React;

const TAG = `task-4282-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const OWNER_ID = `${TAG}-owner`;
const CLIENT_ID = `${TAG}-client`;
const REPORT_ID = `${TAG}-report`; // main flow: PUT → share/demo payloads
const FINALIZE_REPORT_ID = `${TAG}-finalize`; // guard regression lane
const NO_OWNER_CLIENT_ID = `${TAG}-no-owner-client`;
const NO_OWNER_REPORT_ID = `${TAG}-no-owner-report`;
const SHARE_TOKEN = `${TAG}-share-token`;
const NO_OWNER_SHARE_TOKEN = `${TAG}-no-owner-token`;

const AM_EMAIL = `${TAG}-am@example.com`;
const NEXT30_VERDICT = "Two moves this month: answer faster, confirm every consult.";

// ---------------------------------------------------------------- OpenAI
// Every path this suite exercises must be AI-free — mock the singleton to
// throw so an accidental call fails the suite loudly instead of billing.
type CreateFn = typeof openai.chat.completions.create;
const ORIGINAL_CREATE: CreateFn = openai.chat.completions.create.bind(
  openai.chat.completions,
);
function mockOpenAiThrows(): void {
  (openai.chat.completions as any).create = async () => {
    throw new Error("task-4282: unexpected OpenAI call");
  };
}
function restoreOpenAi(): void {
  (openai.chat.completions as any).create = ORIGINAL_CREATE;
}

// ---------------------------------------------------------------- harness
function buildApp(authed: boolean): express.Express {
  const app = express();
  app.use(express.json({ limit: "20mb" }));
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as any).__test_clerkUserId = authed ? OWNER_ID : null;
    next();
  });
  registerReportRoutes(app);
  return app;
}

async function listen(app: express.Express): Promise<{ server: Server; baseUrl: string }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function readNextActionsRow(isoDb: any, reportId: string): Promise<any> {
  const rows: any = await isoDb.execute(sql`
    SELECT data FROM report_sections
    WHERE report_id = ${reportId} AND section_key = 'nextActions' LIMIT 1
  `);
  const list = Array.isArray(rows) ? rows : rows?.rows;
  return list?.[0]?.data ?? null;
}

// ------------------------------------------------------------------- seed
async function seed(isoDb: any): Promise<void> {
  await isoDb.execute(sql`
    INSERT INTO users (id, role, email, first_name, last_name)
    VALUES (${OWNER_ID}, 'ceo', ${AM_EMAIL}, 'Ava', 'Manager')
    ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
  `);
  // is_demo=true → the demo endpoint's newest-demo-report fallback serves
  // REPORT_ID (2026-03 > FINALIZE's 2026-02), exercising the demo-side AM.
  await isoDb.execute(sql`
    INSERT INTO clients (id, firm_name, products, owner_id, is_demo)
    VALUES (${CLIENT_ID}, ${"Climax Law (test)"}, ARRAY['gbp']::text[], ${OWNER_ID}, true)
    ON CONFLICT (id) DO NOTHING
  `);
  await isoDb.execute(sql`
    INSERT INTO clients (id, firm_name, products, is_demo)
    VALUES (${NO_OWNER_CLIENT_ID}, ${"Ownerless Law (test)"}, ARRAY['gbp']::text[], false)
    ON CONFLICT (id) DO NOTHING
  `);
  // Reviewed command panels → the unrelated monthly-review finalize gate
  // stays out of the finalize-guard lane.
  await isoDb.execute(sql`
    INSERT INTO command_panels (client_id, last_reviewed_at)
    VALUES (${CLIENT_ID}, now()), (${NO_OWNER_CLIENT_ID}, now())
  `);

  await isoDb.execute(sql`
    INSERT INTO reports (id, client_id, report_month, status, share_token)
    VALUES (${REPORT_ID}, ${CLIENT_ID}, '2026-03', 'draft', ${SHARE_TOKEN})
  `);
  await isoDb.execute(sql`
    INSERT INTO reports (id, client_id, report_month, status)
    VALUES (${FINALIZE_REPORT_ID}, ${CLIENT_ID}, '2026-02', 'draft')
  `);
  await isoDb.execute(sql`
    INSERT INTO reports (id, client_id, report_month, status, share_token)
    VALUES (${NO_OWNER_REPORT_ID}, ${NO_OWNER_CLIENT_ID}, '2026-03', 'draft', ${NO_OWNER_SHARE_TOKEN})
  `);

  // Main report: minimal nextActions (the PUT tests write the real payload),
  // sales with signedByRep (the sanitizer-regression fixture), stored
  // next30Days verdict for the slideVerdicts payload assert.
  await isoDb.execute(sql`
    INSERT INTO report_sections (id, report_id, section_key, data)
    VALUES (${`${REPORT_ID}-actions`}, ${REPORT_ID}, 'nextActions',
            ${JSON.stringify({ ours: [], theirs: [] })}::jsonb)
  `);
  await isoDb.execute(sql`
    INSERT INTO report_sections (id, report_id, section_key, data)
    VALUES (${`${REPORT_ID}-sales`}, ${REPORT_ID}, 'sales',
            ${JSON.stringify({
              totalCases: 3,
              commonIssues: "",
              signedByRep: { "Jane Doe": 2, "Bob Rep": 1 },
            })}::jsonb)
  `);
  await isoDb.execute(sql`
    INSERT INTO report_sections (id, report_id, section_key, data)
    VALUES (${`${REPORT_ID}-verdicts`}, ${REPORT_ID}, 'slideVerdicts',
            ${JSON.stringify({ verdicts: { next30Days: NEXT30_VERDICT } })}::jsonb)
  `);

  // Finalize-guard lane: items carry owner/due but EMPTY action text — the
  // #4227 predicate must still see two empty columns.
  await isoDb.execute(sql`
    INSERT INTO report_sections (id, report_id, section_key, data)
    VALUES (${`${FINALIZE_REPORT_ID}-actions`}, ${FINALIZE_REPORT_ID}, 'nextActions',
            ${JSON.stringify({
              ours: [{ action: "", why: "", owner: "ZZ", due: "soon" }],
              theirs: [{ action: "   ", why: "", owner: "YY" }],
            })}::jsonb)
  `);

  // Ownerless lane: real actions so the slide/payload is otherwise healthy.
  await isoDb.execute(sql`
    INSERT INTO report_sections (id, report_id, section_key, data)
    VALUES (${`${NO_OWNER_REPORT_ID}-actions`}, ${NO_OWNER_REPORT_ID}, 'nextActions',
            ${JSON.stringify({
              ours: [{ action: "Launch answer-speed sprint", why: "cuts missed calls" }],
              theirs: [{ action: "Send signed-case list", why: "accuracy" }],
            })}::jsonb)
  `);
}

// ------------------------------------------------- 1. nextActions PUT path
async function sectionPutTests(isoDb: any, baseUrl: string): Promise<void> {
  const put = (body: unknown) =>
    fetch(`${baseUrl}/api/reports/${REPORT_ID}/sections/nextActions`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  // Junk save: over-long owner/due capped+trimmed, non-string owner/due
  // dropped, truthy-junk expansion flag stored as FALSE.
  const junk = await put({
    data: {
      ours: [
        {
          action: "Ship the intake sprint",
          why: "speed",
          owner: "  jdlongownerinitials  ",
          due: `   ${"x".repeat(60)}   `,
        },
        { action: "Second action", why: "", owner: 42, due: null },
      ],
      theirs: [{ action: "Send list", why: "acc", owner: " KL ", due: " Feb 20 " }],
      notes: "",
      showNotes: false,
      showExpansionQuestion: "yes",
    },
  });
  assert.equal(junk.status, 200, `junk PUT: expected 200, got ${junk.status}`);
  const junkRow = await readNextActionsRow(isoDb, REPORT_ID);
  assert.ok(junkRow, "nextActions row persisted");
  assert.equal(
    junkRow.ours[0].owner,
    "jdlongownerinitials".slice(0, NEXT_ACTION_OWNER_MAX_CHARS),
    "over-long owner trimmed then hard-capped",
  );
  assert.equal(junkRow.ours[0].owner.length, NEXT_ACTION_OWNER_MAX_CHARS, "owner cap enforced");
  assert.equal(junkRow.ours[0].due, "x".repeat(NEXT_ACTION_DUE_MAX_CHARS), "due hard-capped");
  assert.ok(!("owner" in junkRow.ours[1]), "non-string owner dropped");
  assert.ok(!("due" in junkRow.ours[1]), "non-string due dropped");
  assert.equal(junkRow.theirs[0].owner, "KL", "owner trimmed");
  assert.equal(junkRow.theirs[0].due, "Feb 20", "due trimmed");
  assert.equal(
    junkRow.showExpansionQuestion,
    false,
    'junk truthy flag ("yes") stores FALSE — the expansion band cannot resurrect via junk',
  );
  assert.equal(junkRow.ours[0].action, "Ship the intake sprint", "legacy fields untouched");

  // Real save: the payload the share/demo asserts read back.
  const good = await put({
    data: {
      ours: [
        { action: "Launch the answer-speed sprint", why: "cuts missed calls", owner: "JD", due: "by Feb 14" },
        { action: "Publish the review push", why: "velocity" },
      ],
      theirs: [{ action: "Send signed-case list by the 5th", why: "accuracy", owner: "KL", due: "Feb 20" }],
      notes: "",
      showNotes: false,
      showExpansionQuestion: true,
    },
  });
  assert.equal(good.status, 200, `good PUT: expected 200, got ${good.status}`);
  const goodRow = await readNextActionsRow(isoDb, REPORT_ID);
  assert.equal(goodRow.showExpansionQuestion, true, "boolean true stores true");
  assert.equal(goodRow.ours[0].owner, "JD", "owner stored");
  assert.ok(!("owner" in goodRow.ours[1]), "absent owner stays absent (sparse shape)");

  console.log("route: nextActions PUT sanitize PASSED");
}

// --------------------------------------------- 2-4. share payload + privacy
async function sharePayloadTests(baseUrl: string): Promise<void> {
  const share = await fetch(`${baseUrl}/api/share/${SHARE_TOKEN}`);
  assert.equal(share.status, 200, `share: expected 200, got ${share.status}`);
  const body: any = await share.json();

  assert.equal(body.client?.firmName, "Climax Law (test)", "normal share serves the firm name");
  assert.deepEqual(
    body.accountManager,
    { name: "Ava Manager", email: AM_EMAIL },
    "share payload carries the account manager (client owner) for the CTA",
  );
  assert.equal(body.slideVerdicts?.next30Days, NEXT30_VERDICT, "next30Days verdict served");

  const actions = (body.sections ?? []).find((s: any) => s?.sectionKey === "nextActions")?.data;
  assert.ok(actions, "nextActions section served");
  assert.equal(actions.showExpansionQuestion, true, "expansion flag served");
  assert.equal(actions.ours[0].owner, "JD", "owner initials served on public payload");
  assert.equal(actions.ours[0].due, "by Feb 14", "due hint served");
  assert.equal(actions.theirs[0].owner, "KL", "their-column owner served");

  const sales = (body.sections ?? []).find((s: any) => s?.sectionKey === "sales")?.data;
  assert.ok(sales, "sales section served");
  assert.ok(!("signedByRep" in sales), "signedByRep is STILL stripped from the public payload");
  assert.equal(sales.totalSignedCases, 3, "signedByRep summed into totalSignedCases");

  // Privacy mode: identity comes off — AM null, owner initials stripped from
  // both columns, non-identity fields (due) retained.
  const priv = await fetch(`${baseUrl}/api/share/${SHARE_TOKEN}?private=true`);
  assert.equal(priv.status, 200, `private share: expected 200, got ${priv.status}`);
  const privBody: any = await priv.json();
  assert.equal(privBody.client?.firmName, "Confidential Client", "privacy mode hides the firm");
  assert.equal(privBody.accountManager, null, "privacy mode serves accountManager NULL");
  const privActions = (privBody.sections ?? []).find((s: any) => s?.sectionKey === "nextActions")?.data;
  assert.ok(privActions, "nextActions still served in privacy mode");
  assert.ok(
    privActions.ours.every((a: any) => !("owner" in a)) &&
      privActions.theirs.every((a: any) => !("owner" in a)),
    "privacy mode strips owner initials from BOTH columns",
  );
  assert.equal(privActions.ours[0].due, "by Feb 14", "due hints survive privacy mode");
  const privSales = (privBody.sections ?? []).find((s: any) => s?.sectionKey === "sales")?.data;
  assert.ok(!("signedByRep" in privSales), "signedByRep stripped in privacy mode too");

  // Ownerless client: accountManager null, payload otherwise healthy.
  const noOwner = await fetch(`${baseUrl}/api/share/${NO_OWNER_SHARE_TOKEN}`);
  assert.equal(noOwner.status, 200, `ownerless share: expected 200, got ${noOwner.status}`);
  const noOwnerBody: any = await noOwner.json();
  assert.equal(noOwnerBody.accountManager, null, "no client owner → accountManager NULL (CTA degrades)");

  console.log("route: share payload + privacy degradation PASSED");
}

// ----------------------------------------------------------- 5. demo route
async function demoPayloadTests(baseUrl: string): Promise<void> {
  const demo = await fetch(`${baseUrl}/api/demo-report`);
  assert.equal(demo.status, 200, `demo: expected 200, got ${demo.status}`);
  const body: any = await demo.json();
  assert.equal(body.report?.id, REPORT_ID, "fixture sanity: demo serves the newest demo report");
  assert.deepEqual(
    body.accountManager,
    { name: "Ava Manager", email: AM_EMAIL },
    "demo payload carries the demo client's owner as account manager",
  );
  const actions = (body.sections ?? []).find((s: any) => s?.sectionKey === "nextActions")?.data;
  assert.equal(actions?.ours?.[0]?.owner, "JD", "demo passthrough keeps owner initials");
  console.log("route: demo payload PASSED");
}

// ------------------------------------------- 6. finalize guard regression
async function finalizeGuardTest(baseUrl: string): Promise<void> {
  const res = await fetch(`${baseUrl}/api/reports/${FINALIZE_REPORT_ID}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "final" }),
  });
  const body: any = await res.json().catch(() => ({}));
  assert.equal(res.status, 422, `finalize: expected 422, got ${res.status} ${JSON.stringify(body)}`);
  assert.equal(body.error, "report_quality_confirm_required", "names the #4227 gate");
  const empty = body.emptyNextActionsColumns ?? body.details?.emptyNextActionsColumns;
  assert.ok(
    Array.isArray(empty) && empty.length === 2,
    `owner/due-only items still count as EMPTY columns, got ${JSON.stringify(body)}`,
  );
  console.log("route: finalize guard ignores owner/due-only items PASSED");
}

// ------------------------------------------------------------- 7. SSR view
// react-dom/server escapes ' " & < > — compare against the escaped form.
const ssrEscape = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/'/g, "&#x27;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

function renderSlide(overrides: {
  actionsData?: any;
  accountManager?: { name: string; email: string | null } | null;
  slideVerdicts?: Record<string, string> | null;
}): string {
  const view: any = {
    actionsSection: overrides.actionsData !== undefined
      ? { sectionKey: "nextActions", data: overrides.actionsData }
      : undefined,
    data: {
      report: { id: "r", reportMonth: "2026-03", status: "final" },
      client: { firmName: "Climax Law (test)", contactName: null, products: ["gbp"] },
      sections: [],
      accountManager: overrides.accountManager ?? null,
      slideVerdicts: overrides.slideVerdicts ?? null,
    },
    monthLabel: "March 2026",
    slideNumbers: { next30: 9 },
    t: {},
  };
  return renderToStaticMarkup(React.createElement(Next30DaysSlide, { view }));
}

function ssrTests(): void {
  const full = renderSlide({
    actionsData: {
      ours: [{ action: "Launch the answer-speed sprint", why: "cuts missed calls", owner: "JD", due: "by Feb 14" }],
      theirs: [{ action: "Send signed-case list", why: "accuracy", owner: "KL", due: "Feb 20" }],
      showExpansionQuestion: true,
    },
    accountManager: { name: "Ava Manager", email: AM_EMAIL },
    slideVerdicts: { next30Days: NEXT30_VERDICT },
  });

  assert.ok(full.includes('data-testid="text-verdict-next30Days"'), "verdict line renders");
  assert.ok(full.includes(ssrEscape(NEXT30_VERDICT)), "verdict copy renders");
  assert.ok(full.includes('data-testid="our-action-owner-0"') && full.includes(">JD<"), "our-column owner chip renders");
  assert.ok(full.includes("Due: by Feb 14"), "our-column due hint renders");
  assert.ok(full.includes('data-testid="your-action-owner-0"') && full.includes(">KL<"), "their-column owner chip renders");
  assert.ok(full.includes('data-testid="expansion-question-band"'), "expansion band renders when flagged");
  assert.ok(full.includes("Talk to Ava Manager."), "CTA names the account manager");
  assert.ok(
    full.includes(`mailto:${AM_EMAIL}?subject=Re%3A%20March%202026`),
    "CTA mailto button targets the AM with the month subject",
  );
  assert.ok(full.includes("Email Ava"), "button uses the AM first name");
  assert.ok(!full.includes(ssrEscape("Questions? Let's align on priorities and timelines.")), "generic line absent when AM present");

  const bare = renderSlide({
    actionsData: { ours: [], theirs: [] },
    accountManager: null,
    slideVerdicts: null,
  });
  assert.ok(!bare.includes("text-verdict-next30Days"), "no verdict → no verdict line");
  assert.ok(!bare.includes('data-testid="expansion-question-band"'), "no flag → NO expansion band");
  assert.ok(
    !bare.includes("The Question We"),
    "expansion copy fully absent without the flag",
  );
  assert.ok(!bare.includes('data-testid="button-email-am"'), "no AM → no mailto button");
  assert.ok(
    bare.includes(ssrEscape("Questions? Let's align on priorities and timelines.")),
    "no AM → generic closing line",
  );
  assert.ok(bare.includes("No actions defined"), "empty columns keep their empty state");

  // AM without email: name renders, button doesn't.
  const noEmail = renderSlide({
    actionsData: { ours: [], theirs: [] },
    accountManager: { name: "Ava Manager", email: null },
  });
  assert.ok(noEmail.includes("Talk to Ava Manager."), "AM name renders without email");
  assert.ok(!noEmail.includes('data-testid="button-email-am"'), "no email → no mailto button");

  // Legacy rows (no owner/due keys) render without chips.
  const legacy = renderSlide({
    actionsData: { ours: [{ action: "Do a thing", why: "reason" }], theirs: [] },
    accountManager: null,
  });
  assert.ok(!legacy.includes("our-action-owner-0"), "legacy items render chipless");
  assert.ok(legacy.includes("Do a thing"), "legacy action renders");

  console.log("ssr: slide render contract PASSED");
}

// --------------------------------- 6bis. Task #4801 — edit AFTER finalize
// The Report Form now saves already-final reports directly (its confirm flow
// is draft→final transition-only). That UX is safe only while the server
// keeps these contracts, so pin them where they live:
//   (a) section PUTs carry NO status gate — adding a Next 30 Days action to
//       a FINAL report persists with the status untouched;
//   (b) the live share payload serves the new action immediately — there is
//       no re-finalize step anywhere in the flow;
//   (c) the finalize gates fire on draft→final ONLY — the exact PATCH that
//       422'd FINALIZE_REPORT_ID as a draft returns 200 once it is final.
async function finalizedEditTests(isoDb: any, baseUrl: string): Promise<void> {
  const readStatus = async (reportId: string): Promise<string | undefined> => {
    const res: any = await isoDb.execute(sql`
      SELECT status FROM reports WHERE id = ${reportId}
    `);
    const rows = Array.isArray(res) ? res : res?.rows;
    return rows?.[0]?.status;
  };

  // (a) Append a third "ours" action — the operator's "add a 30-day action
  // after the review call" flow — on the already-FINAL main report.
  assert.equal(await readStatus(REPORT_ID), "final", "fixture sanity: report is already final");
  const put = await fetch(`${baseUrl}/api/reports/${REPORT_ID}/sections/nextActions`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      data: {
        ours: [
          { action: "Launch the answer-speed sprint", why: "cuts missed calls", owner: "JD", due: "by Feb 14" },
          { action: "Publish the review push", why: "velocity" },
          { action: "Post-finalize: pilot LSA callback window", why: "came out of the review call", owner: "JD", due: "by Feb 28" },
        ],
        theirs: [{ action: "Send signed-case list by the 5th", why: "accuracy", owner: "KL", due: "Feb 20" }],
        notes: "",
        showNotes: false,
        showExpansionQuestion: true,
      },
    }),
  });
  assert.equal(put.status, 200, `PUT on a FINAL report: expected 200 (no status gate), got ${put.status}`);
  const row = await readNextActionsRow(isoDb, REPORT_ID);
  assert.equal(row?.ours?.length, 3, "the added action persisted alongside the existing two");
  assert.equal(row.ours[2].action, "Post-finalize: pilot LSA callback window", "new action stored verbatim");
  assert.equal(
    await readStatus(REPORT_ID),
    "final",
    "the section PUT left status FINAL (no silent demote, no re-finalize required)",
  );

  // (b) The client's live share link serves the new action IMMEDIATELY.
  const share = await fetch(`${baseUrl}/api/share/${SHARE_TOKEN}`);
  assert.equal(share.status, 200, `share after post-finalize PUT: expected 200, got ${share.status}`);
  const shareBody: any = await share.json();
  const actions = (shareBody.sections ?? []).find((s: any) => s?.sectionKey === "nextActions")?.data;
  assert.equal(actions?.ours?.length, 3, "share payload serves all three actions");
  assert.equal(
    actions?.ours?.[2]?.action,
    "Post-finalize: pilot LSA callback window",
    "the action added AFTER finalize is live on the share payload",
  );

  // (c) Final→final PATCH skips the finalize gates entirely. Sharp probe:
  // this report just 422'd the SAME request as a draft (owner/due-only junk
  // columns flunk the #4227 gate). Flip it final via SQL — the identical
  // PATCH must now 200 because every gate is draft→final transition-only.
  await isoDb.execute(sql`
    UPDATE reports SET status = 'final' WHERE id = ${FINALIZE_REPORT_ID}
  `);
  const repatch = await fetch(`${baseUrl}/api/reports/${FINALIZE_REPORT_ID}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "final" }),
  });
  const repatchBody: any = await repatch.json().catch(() => ({}));
  assert.equal(
    repatch.status,
    200,
    `final→final PATCH must skip the transition-only finalize gates, got ${repatch.status} ${JSON.stringify(repatchBody)}`,
  );
  assert.equal(await readStatus(FINALIZE_REPORT_ID), "final", "final→final PATCH keeps status final");

  console.log("route: finalized-report edit contract (PUT + share + final→final PATCH) PASSED");
}

// -------------------------------------------------------------------- run
async function run(): Promise<void> {
  mockOpenAiThrows();
  try {
    ssrTests();

    await runInIsolatedSchema(
      async ({ db: isoDb }) => {
        await seed(isoDb);
        __test_markUserReconciled(OWNER_ID, {
          id: OWNER_ID,
          email: AM_EMAIL,
          firstName: "Ava",
          lastName: "Manager",
          role: "ceo",
        });
        const authedApp = buildApp(true);
        const authed = await listen(authedApp);
        try {
          await sectionPutTests(isoDb, authed.baseUrl);
          // /api/share 403s non-finalized reports; flip via SQL — the
          // finalize ROUTE lane is exercised by finalizeGuardTest's 422.
          await isoDb.execute(sql`
            UPDATE reports SET status = 'final'
            WHERE id IN (${REPORT_ID}, ${NO_OWNER_REPORT_ID})
          `);
          await sharePayloadTests(authed.baseUrl);
          await demoPayloadTests(authed.baseUrl);
          await finalizeGuardTest(authed.baseUrl);
          await finalizedEditTests(isoDb, authed.baseUrl);
        } finally {
          __test_resetReconciledUsers();
          await closeServer(authed.server);
        }
      },
      {
        tables: [
          "users",
          "clients",
          "command_panels",
          "client_locations",
          "client_data_access",
          "reports",
          "report_sections",
          "report_section_history",
          "user_notifications",
          "system_settings",
          "ceo_pulses",
        ],
        pinGetDbForCrossAsync: true,
      },
    );

    console.log("report-next30-cta: PASSED");
  } finally {
    restoreOpenAi();
    await getGlobalDispatcher().close().catch(() => undefined);
  }
}

run()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((err) => {
    console.error("report-next30-cta: FAILED", err);
    process.exitCode = 1;
  });
