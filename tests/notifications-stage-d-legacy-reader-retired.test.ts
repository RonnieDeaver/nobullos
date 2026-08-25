/* test-registration
{
  "name": "Notifications Stage D legacy reader retired (Task #1714)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "scanPaths": [
    "client/src"
  ],
  "tier": "small"
}
test-registration */
// Task #1714 — Notifications Stage D: Retire legacy reader UI.
//
// With every writer migrated to `notifyUser()` (Stages B+C), the
// legacy `notifications` table no longer receives new rows, so the
// three legacy reader surfaces (Dashboard notifications card, admin
// MatchSettings "recent threshold changes" banner, legacy
// `/notifications` page) were removed in favor of the per-user bell
// + new inbox.
//
// This static regression test asserts:
//   1. No file under `client/src` references `/api/legacy-notifications`
//      (the renamed legacy reader URL from Task #1707).
//   2. The `/notifications` route in `client/src/App.tsx` is wired to
//      the new inbox page (`client/src/pages/Notifications.tsx`), and
//      that page hits the NEW `/api/notifications` endpoint — not the
//      legacy URL.
//   3. The Dashboard stat-card surface links to `/notifications` and
//      reads the unread count from `/api/notifications/unread-count`.
//   4. MatchSettings no longer renders the legacy "recent threshold
//      changes by other admins" banner.
//
// Stage E will remove the `/api/legacy-notifications` server routes
// themselves; Stage F removes the legacy storage helpers.

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: string): void {
  const sym = ok ? "✓" : "✗";
  if (ok) {
    passed++;
    console.log(`  ${sym} ${name}${detail ? ` (${detail})` : ""}`);
  } else {
    failed++;
    console.error(`  ${sym} ${name}${detail ? ` (${detail})` : ""}`);
  }
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|js|jsx)$/.test(entry)) out.push(full);
  }
  return out;
}

const repoRoot = process.cwd();
const clientSrc = path.join(repoRoot, "client/src");

// Match only quoted/templated references in non-comment lines — the
// Done-looks-like check in the task spec is
// `rg '"/api/legacy-notifications"' client/src`. Comments that
// mention the URL in markdown-style backticks for historical
// context are fine.
const LEGACY_QUOTED_RE = /["'`]\/api\/legacy-notifications/;
const offenders: string[] = [];
for (const file of walk(clientSrc)) {
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
      continue;
    }
    if (LEGACY_QUOTED_RE.test(line)) {
      offenders.push(path.relative(repoRoot, file));
      break;
    }
  }
}
check(
  "no client/src file calls /api/legacy-notifications (quoted refs)",
  offenders.length === 0,
  offenders.length ? `offenders: ${offenders.join(", ")}` : "clean",
);

const appTsx = readFileSync(path.join(clientSrc, "App.tsx"), "utf8");
check(
  "App.tsx routes /notifications to the Notifications page",
  /path=\"\/notifications\"\s+component=\{Notifications\}/.test(appTsx),
  "Route path=\"/notifications\" component={Notifications}",
);
check(
  "App.tsx lazy-loads Notifications from @/pages/Notifications",
  // App.tsx migrated bare `lazy()` to `lazyWithRetry()` (a chunk-load
  // retry wrapper). The assertion's real point is that the page is
  // still code-split-loaded from @/pages/Notifications, so accept
  // either lazy loader form.
  /const Notifications = lazy(?:WithRetry)?\(\(\) => import\(\"@\/pages\/Notifications\"\)\)/.test(
    appTsx,
  ),
  "lazyWithRetry(() => import('@/pages/Notifications'))",
);

const notificationsPage = readFileSync(
  path.join(clientSrc, "pages/Notifications.tsx"),
  "utf8",
);
check(
  "Notifications page reads from /api/notifications (new endpoint)",
  notificationsPage.includes("/api/notifications?"),
  "must call /api/notifications?... not legacy URL",
);
check(
  "Notifications page does not call the legacy reader",
  !notificationsPage.includes("/api/legacy-notifications"),
  "no /api/legacy-notifications references",
);
check(
  "Notifications page renders with data-testid=\"page-notifications\"",
  notificationsPage.includes("data-testid=\"page-notifications\""),
  "anchor for routing/e2e assertions",
);

const dashboard = readFileSync(
  path.join(clientSrc, "pages/Dashboard.tsx"),
  "utf8",
);
check(
  "Dashboard reads unread count from /api/notifications/unread-count",
  dashboard.includes("/api/notifications/unread-count"),
  "new endpoint backs the stat card",
);
check(
  "Dashboard stat card links to /notifications",
  /href=\"\/notifications\"[\s\S]*?data-testid=\"link-stat-notifications\"/.test(
    dashboard,
  ) ||
    /data-testid=\"link-stat-notifications\"[\s\S]*?href=\"\/notifications\"/.test(
      dashboard,
    ),
  "stat card wrapped in <Link href=\"/notifications\">",
);
check(
  "Dashboard no longer declares a Notification type for the legacy reader",
  !/^type Notification = \{/m.test(dashboard),
  "legacy `Notification` shape removed",
);

const matchSettings = readFileSync(
  path.join(clientSrc, "pages/admin/MatchSettings.tsx"),
  "utf8",
);
check(
  "MatchSettings no longer renders the legacy recent-changes banner",
  !matchSettings.includes("banner-recent-changes") &&
    !matchSettings.includes("recentChangeNotifications"),
  "banner JSX + derived state removed",
);
check(
  "MatchSettings no longer uses the legacy mark-read mutation",
  !matchSettings.includes("markReadMutation"),
  "useMutation against /api/legacy-notifications/:id/read removed",
);
check(
  "MatchSettings no longer references highlightedRowKeys / parseChangeNotificationMessage",
  !matchSettings.includes("highlightedRowKeys") &&
    !matchSettings.includes("parseChangeNotificationMessage"),
  "row-highlight visuals + parser tied to legacy data removed",
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
