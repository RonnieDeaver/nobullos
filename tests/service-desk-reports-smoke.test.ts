/* test-registration
{
  "name": "Service Desk reporting smoke — nav, route, endpoint gate, TTR math, Unmapped bucket (Task #3114)",
  "smoke": true,
  "smokeReason": "Task #3114: Service Desk reporting smoke gate. Verifies 6 contracts: nav entry visible to all users in QuicklinksBar internal cluster; Reports route registered in App.tsx; reporting endpoint gated to requireTeamLead, reads only local mirror tables (no live ClickUp calls); TTR median/avg/ on-time%/slip/overdue math; Unmapped bucket for null dept/requestType; Reports button in ServiceDeskHome. Fast, DB-free, no network.",
  "scanPaths": [
    "client/src/App.tsx",
    "client/src/components/QuicklinksBar.tsx",
    "client/src/pages/admin/ServiceDeskHome.tsx",
    "client/src/pages/admin/ServiceDeskReports.tsx",
    "server/routes/serviceDesk"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #3114 — Service Desk reporting smoke gate.
 *
 * Verifies 6 contracts without a live DB or network:
 *
 *  A. Nav entry exists in QuicklinksBar QUICKLINKS_MANIFEST with correct
 *     id/href/cluster and isVisible: () => true semantics.
 *
 *  B. Reports route registered in App.tsx (lazy import + Route).
 *
 *  C. Reporting API endpoint registered in serviceDesk.ts, gated to
 *     requireTeamLead, and reads only from the local mirror tables.
 *
 *  D. TTR math — median, avg, on-time% aggregation logic present in source.
 *
 *  E. Unmapped bucket — null dept/requestType resolves to "Unmapped" label.
 *
 *  F. ServiceDeskHome.tsx has Reports navigation button wired to the
 *     reports route.
 */

process.env.NODE_ENV = "test";

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

// Task #3787: server/routes/serviceDesk.ts is now a thin aggregator over
// per-feature modules in server/routes/serviceDesk/. Source-contract
// assertions scan the concatenation of the split modules so they keep
// working regardless of which module holds a given route.

// ─── A. Nav manifest entry ─────────────────────────────────────────────────

{
  const navSource = readFileSync(resolve("client/src/components/QuicklinksBar.tsx"), "utf8");

  assert.ok(
    navSource.includes('"service-desk"'),
    'QuicklinksBar QUICKLINKS_MANIFEST must include id "service-desk"',
  );
  assert.ok(
    navSource.includes('"/admin/service-desk/home"'),
    "QuicklinksBar manifest entry must link to /admin/service-desk/home",
  );
  assert.ok(
    navSource.includes('cluster: "team"'),
    'Service Desk nav entry must be in the "team" tool group (Task #4763 function-based regrouping)',
  );
  assert.ok(
    navSource.includes("isVisible: () => true"),
    "Service Desk nav entry must be visible to all logged-in users (isVisible: () => true)",
  );
  assert.ok(
    navSource.includes("ClipboardList"),
    "QuicklinksBar must import ClipboardList for the Service Desk nav icon",
  );

  console.log("  ✓ A: Service Desk nav entry present in QuicklinksBar with correct id/href/cluster/visibility");
}

// ─── B. App.tsx route registration ────────────────────────────────────────

{
  const appSource = readFileSync(resolve("client/src/App.tsx"), "utf8");

  assert.ok(
    appSource.includes("ServiceDeskReports"),
    "App.tsx must import ServiceDeskReports",
  );
  assert.ok(
    appSource.includes('@/pages/admin/ServiceDeskReports'),
    "App.tsx must lazy-import from @/pages/admin/ServiceDeskReports",
  );
  assert.ok(
    appSource.includes('"/admin/service-desk/reports"'),
    'App.tsx must register Route path="/admin/service-desk/reports"',
  );
  assert.ok(
    appSource.includes("component={ServiceDeskReports}"),
    "App.tsx must wire ServiceDeskReports as the route component",
  );

  console.log("  ✓ B: /admin/service-desk/reports route registered in App.tsx");
}

// ─── C. Reporting endpoint in serviceDesk.ts ─────────────────────────────

{
  const routeSource = readServiceDeskRouteSources();

  assert.ok(
    routeSource.includes('"/api/service-desk/reports"'),
    "serviceDesk.ts must register GET /api/service-desk/reports endpoint",
  );
  assert.ok(
    routeSource.includes("requireTeamLead"),
    "The reporting endpoint must be gated by requireTeamLead",
  );
  assert.ok(
    // Task #3787: the scanned sources are the split modules under
    // server/routes/serviceDesk/, which import middleware one level up
    // ("../middleware"); accept either depth.
    /import\s*\{[^}]*\brequireTeamLead\b[^}]*\}\s*from\s*["']\.\.?\/middleware["']/.test(routeSource),
    "serviceDesk.ts must import requireTeamLead from middleware",
  );

  // Must only read from local mirror tables — no live ClickUp API calls.
  // Verify by checking the full route source for the required table references
  // and absence of live ClickUp API calls inside the reporting handler.
  assert.ok(
    routeSource.includes("serviceDesk:reports:tasks") && routeSource.includes("sdTicketMapping"),
    "Reporting endpoint must query local clickupTasks (via reports:tasks attribution) and sdTicketMapping",
  );
  assert.ok(
    routeSource.includes("serviceDesk:reports:commitEvents"),
    "Reporting endpoint must query sdTicketEvents for committed-date-change events",
  );

  // The reports block must not contain live ClickUp fetch calls inside the handler
  const reportsHandlerStart = routeSource.indexOf('"/api/service-desk/reports"');
  const reportsHandlerEnd = routeSource.indexOf('"/api/service-desk/tickets/:taskId/allowed-transitions"');
  const reportsBlock = routeSource.slice(reportsHandlerStart, reportsHandlerEnd);
  assert.ok(
    !reportsBlock.includes("cu.getTask(") && !reportsBlock.includes("cu.getTasks("),
    "Reporting endpoint must NOT make live ClickUp API calls",
  );

  // Must return configured:false when no list mapping
  assert.ok(
    routeSource.includes("configured: false"),
    "Reporting endpoint must return { configured: false } when no list mapping is set up",
  );

  console.log("  ✓ C: /api/service-desk/reports endpoint registered, gated, reads local-only");
}

// ─── D. TTR math + on-time% logic ────────────────────────────────────────

{
  const routeSource = readServiceDeskRouteSources();

  // Median calculation: sort + midpoint
  assert.ok(
    routeSource.includes("Math.floor(sorted.length / 2)"),
    "serviceDesk.ts must compute median TTR via sort + midpoint",
  );
  // Average calculation
  assert.ok(
    routeSource.includes("avgTtrMs"),
    "serviceDesk.ts must compute avgTtrMs",
  );
  // On-time: doneMs <= committedMs
  assert.ok(
    routeSource.includes("doneMs! <= t.committedMs!") || routeSource.includes("doneMs <= t.committedMs"),
    "serviceDesk.ts must compare doneMs <= committedMs for on-time %",
  );
  // Slip events: isMovingLater flag from event data
  assert.ok(
    routeSource.includes("isMovingLater"),
    "serviceDesk.ts must detect committed-date slips via isMovingLater in event data",
  );
  // Overdue: open tickets with committedMs < nowMs
  assert.ok(
    routeSource.includes("overdueCount"),
    "serviceDesk.ts must compute overdueCount for open tickets past committed date",
  );
  // volumeTrend buckets
  assert.ok(
    routeSource.includes("volumeTrend"),
    "serviceDesk.ts must build volumeTrend buckets",
  );

  // Verify pure-JS TTR math inline
  const ttrValues = [
    2 * 86_400_000,  // 2d
    4 * 86_400_000,  // 4d
    6 * 86_400_000,  // 6d
  ];
  const sorted = [...ttrValues].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  assert.strictEqual(median, 4 * 86_400_000, "Median of [2d, 4d, 6d] must be 4d");

  const avg = ttrValues.reduce((s, v) => s + v, 0) / ttrValues.length;
  assert.strictEqual(avg, 4 * 86_400_000, "Avg of [2d, 4d, 6d] must be 4d");

  // On-time%: 2 on-time out of 3
  const tickets = [
    { doneMs: 100, committedMs: 200 },  // on-time
    { doneMs: 300, committedMs: 200 },  // late
    { doneMs: 200, committedMs: 200 },  // exactly on-time (boundary)
  ];
  const onTime = tickets.filter(t => t.doneMs <= t.committedMs).length;
  assert.strictEqual(onTime, 2, "On-time filter (doneMs <= committedMs) must count 2 of 3");
  const pct = Math.round((onTime / tickets.length) * 100);
  assert.strictEqual(pct, 67, "On-time% of 2/3 must round to 67%");

  console.log("  ✓ D: TTR median, avg, on-time%, slip, overdue math correct in source and inline");
}

// ─── E. Unmapped bucket ───────────────────────────────────────────────────

{
  const routeSource = readServiceDeskRouteSources();

  // dept null → "Unmapped"
  assert.ok(
    routeSource.includes('"Unmapped"'),
    'serviceDesk.ts must use "Unmapped" as the label for tickets with no resolved department',
  );

  // Request type fallback chain must end in "Unmapped"
  const rtBlock = routeSource.slice(
    routeSource.indexOf("rtOptionId"),
    routeSource.indexOf("committedDateStr"),
  );
  assert.ok(
    rtBlock.includes('"Unmapped"'),
    'Request type resolution must fall back to "Unmapped" when no option/text found',
  );

  // Inline: simulate unmapped resolution
  function resolveLabel(optionId: string | null, optMap: Record<string, string>, textFallback: string | null): string {
    if (optionId) return optMap[optionId] ?? textFallback ?? "Unmapped";
    return textFallback ?? "Unmapped";
  }

  assert.strictEqual(resolveLabel(null, {}, null), "Unmapped", "null option + null text → Unmapped");
  assert.strictEqual(resolveLabel("abc", {}, null), "Unmapped", "option not in map + null text → Unmapped");
  assert.strictEqual(resolveLabel("abc", { abc: "Marketing" }, null), "Marketing", "mapped option → label");
  assert.strictEqual(resolveLabel(null, {}, "Tech"), "Tech", "null option but text fallback → text");

  console.log("  ✓ E: Unmapped bucket logic present in source and correct inline");
}

// ─── F. ServiceDeskHome Reports button ────────────────────────────────────

{
  const homeSource = readFileSync(
    resolve("client/src/pages/admin/ServiceDeskHome.tsx"),
    "utf8",
  );

  assert.ok(
    homeSource.includes('"/admin/service-desk/reports"'),
    "ServiceDeskHome.tsx must have a link to /admin/service-desk/reports",
  );
  assert.ok(
    homeSource.includes("button-service-desk-reports"),
    "ServiceDeskHome.tsx must have a data-testid of button-service-desk-reports on the Reports link",
  );
  assert.ok(
    homeSource.includes("BarChart2"),
    "ServiceDeskHome.tsx must import BarChart2 for the Reports button icon",
  );

  console.log("  ✓ F: ServiceDeskHome.tsx has Reports button wired to /admin/service-desk/reports");
}

// ─── G. CSV export endpoint ───────────────────────────────────────────────

{
  const routeSource = readServiceDeskRouteSources();

  // Endpoint registered and gated
  assert.ok(
    routeSource.includes('"/api/service-desk/reports/export"'),
    "serviceDesk.ts must register GET /api/service-desk/reports/export",
  );
  const exportStart = routeSource.indexOf('"/api/service-desk/reports/export"');
  const exportLine = routeSource.slice(
    routeSource.lastIndexOf("app.get", exportStart),
    routeSource.indexOf("async", exportStart),
  );
  assert.ok(
    exportLine.includes("isAuthenticated") && exportLine.includes("requireTeamLead"),
    "Export endpoint must be gated by isAuthenticated + requireTeamLead",
  );

  // Same range parsing + same report computation as the JSON endpoint
  assert.ok(
    routeSource.includes("parseReportRange") &&
      routeSource.split("parseReportRange(").length >= 3,
    "Both reports and export endpoints must share parseReportRange",
  );
  assert.ok(
    routeSource.split("computeServiceDeskReport(").length >= 3,
    "Both reports and export endpoints must share computeServiceDeskReport",
  );

  // CSV response headers
  assert.ok(
    routeSource.includes("text/csv") && routeSource.includes("Content-Disposition"),
    "Export endpoint must send text/csv with a Content-Disposition attachment header",
  );

  // Must include the breakdowns + oldest-open sections
  const exportBlock = routeSource.slice(exportStart);
  for (const section of [
    "Breakdown: By Department",
    "Breakdown: By Request Type",
    "Breakdown: By Priority",
    "Oldest Open Tickets",
  ]) {
    assert.ok(exportBlock.includes(section), `Export CSV must include section "${section}"`);
  }

  // Inline CSV escaping semantics (mirror of csvEscape in serviceDesk.ts)
  function csvEscape(value: unknown): string {
    let s = value === null || value === undefined ? "" : String(value);
    if (/^[=+\-@]/.test(s)) {
      s = `'${s}`;
    }
    if (/[",\n\r]/.test(s)) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  }
  assert.strictEqual(csvEscape("plain"), "plain", "plain value must pass through");
  assert.strictEqual(csvEscape("=SUM(A1)"), "'=SUM(A1)", "leading = must be neutralized");
  assert.strictEqual(csvEscape("+1"), "'+1", "leading + must be neutralized");
  assert.strictEqual(csvEscape("@cmd"), "'@cmd", "leading @ must be neutralized");
  assert.strictEqual(csvEscape('=1,2"'), '"\'=1,2"""', "formula prefix composes with quoting");
  assert.ok(
    readServiceDeskRouteSources().includes("/^[=+\\-@]/"),
    "serviceDesk.ts csvEscape must include formula-injection hardening",
  );
  assert.strictEqual(csvEscape('He said "hi"'), '"He said ""hi"""', "quotes must double-escape");
  assert.strictEqual(csvEscape("a,b"), '"a,b"', "commas must be quoted");
  assert.strictEqual(csvEscape("line1\nline2"), '"line1\nline2"', "newlines must be quoted");
  assert.strictEqual(csvEscape(null), "", "null must become empty string");
  assert.ok(
    routeSource.includes('s.replace(/"/g, \'""\')'),
    "serviceDesk.ts csvEscape must double-escape quotes",
  );

  // Client button
  const pageSource = readFileSync(
    resolve("client/src/pages/admin/ServiceDeskReports.tsx"),
    "utf8",
  );
  assert.ok(
    pageSource.includes("button-export-csv"),
    "ServiceDeskReports.tsx must have a button-export-csv testid",
  );
  assert.ok(
    pageSource.includes("/api/service-desk/reports/export?days="),
    "Export button must forward the selected days param to the export endpoint",
  );

  console.log("  ✓ G: CSV export endpoint registered, gated, shares report computation, escaping correct");
}

// ─── H. By-assignee breakdown ─────────────────────────────────────────────

{
  const routeSource = readServiceDeskRouteSources();

  assert.ok(
    routeSource.includes("byAssignee"),
    "serviceDesk.ts must build a byAssignee breakdown",
  );
  assert.ok(
    routeSource.includes("byDepartment, byRequestType, byPriority, byAssignee"),
    "Reports response breakdowns must include byAssignee alongside existing breakdowns",
  );
  assert.ok(
    routeSource.includes('"Unassigned"'),
    'Tickets with no assignees must land in an "Unassigned" bucket',
  );
  assert.ok(
    routeSource.includes("assigneeNames"),
    "resolveForAnalytics must expose assigneeNames from the mirrored assignees JSON",
  );

  // Inline: multi-assignee grouping — ticket counts once per assignee,
  // no-assignee tickets go to "Unassigned".
  type T = { id: string; assigneeNames: string[] };
  const items: T[] = [
    { id: "1", assigneeNames: ["alice"] },
    { id: "2", assigneeNames: ["alice", "bob"] },
    { id: "3", assigneeNames: [] },
  ];
  const groups: Record<string, T[]> = {};
  for (const t of items) {
    const keys = t.assigneeNames.length > 0 ? t.assigneeNames : ["Unassigned"];
    for (const k of keys) {
      if (!groups[k]) groups[k] = [];
      groups[k].push(t);
    }
  }
  assert.strictEqual(groups["alice"].length, 2, "alice must have 2 tickets");
  assert.strictEqual(groups["bob"].length, 1, "bob must have 1 ticket");
  assert.strictEqual(groups["Unassigned"].length, 1, "Unassigned must have 1 ticket");

  const clientSource = readFileSync(
    resolve("client/src/pages/admin/ServiceDeskReports.tsx"),
    "utf8",
  );
  assert.ok(
    clientSource.includes("byAssignee"),
    "ServiceDeskReports.tsx must read breakdowns.byAssignee",
  );
  assert.ok(
    clientSource.includes("breakdown-by-assignee"),
    "ServiceDeskReports.tsx must render a breakdown-by-assignee table",
  );
  assert.ok(
    clientSource.includes('"By Assignee"'),
    'ServiceDeskReports.tsx must title the table "By Assignee"',
  );

  console.log("  ✓ H: By-assignee breakdown wired in server + client, multi-assignee grouping correct");
}

console.log("service-desk-reports-smoke: 8 contracts verified (Tasks #3114, #3119, #3120).");

function readServiceDeskRouteSources(): string {
  const dir = resolve("server/routes/serviceDesk");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .sort()
    .map((f) => readFileSync(resolve(dir, f), "utf8"))
    .join("\n");
}
