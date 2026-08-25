# ClickUp In-App Module Runbook

> Task #2927 — Full ClickUp integration: per-user OAuth, task management,
> time tracking, goals, Docs.
> Task #2976 — Hierarchy management: create/rename/delete Spaces, Folders,
> Lists; List info editor; Space ClickApps panel.
> Task #2981 — Docs completeness: workspace Doc search, create Doc/page,
> page-tree navigation, fidelity warnings.
> API ref: developer.clickup.com/docs/

## Overview

The ClickUp module lets every NoBull OS user do day-to-day ClickUp work —
browsing the workspace hierarchy, creating/editing tasks, logging time,
reviewing goals and Docs — without leaving the platform. Each user connects
their own ClickUp account via OAuth.

The existing Google Ads hygiene-alert push (`CLICKUP_API_TOKEN` / `CLICKUP_LIST_ID`
shared-token path) is preserved unchanged in `server/services/clickUpClient.ts`.

## Code layout (post monolith split)

`client/src/pages/admin/ClickUpModule.tsx` is a thin composition root — page
state + tab layout only, size-capped by `scripts/lint-monolith-aggregator-size.ts`.
All feature code lives in per-feature modules under
`client/src/pages/adminClickUp/` (types, lib, customFields, comments,
timeTracking, attachments, pickers, hierarchyDialogs, connection, taskDetail,
taskList, goals, docs, views, search, spaceTags, hierarchySidebar, chat,
peopleSharing). New ClickUp feature code belongs in those modules (or a new
sibling module), never in the aggregator.

---

## Auth model

| Scope | Mechanism |
|-------|-----------|
| Shared / COMPANY (Ads OS Client List directory, Ads OS ticket pushes, hygiene alerts) | Runtime-rotatable accessor `server/services/clickUpCompanyToken.ts`: DB override (`system_settings.clickup_company_auth_token`, set via Integrations Hub → ClickUp) → `CLICKUP_API_TOKEN` env var as bootstrap/fallback. See "Ads OS company token" below. |
| Per-user (new) | OAuth authorization-code grant; tokens in `clickup_user_tokens` |

Token storage: `clickup_user_tokens` table, `access_token_encrypted` column
(AES-256-GCM via `server/utils/tokenCrypto.ts`).

ClickUp access tokens **do not currently expire** (no refresh token exists).
If ClickUp introduces expiry, the integration service is structured to add a
refresh path without breaking existing callers.

---

## Environment variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `CLICKUP_CLIENT_ID` | Yes (OAuth) | ClickUp app client ID |
| `CLICKUP_CLIENT_SECRET` | Yes (OAuth) | ClickUp app client secret |
| `CLICKUP_REDIRECT_URI` | **Recommended in production** | Explicit redirect URI — overrides auto-derived value. Set to `https://reports.nobullmarketing.com/api/integrations/clickup/callback` in the production deployment to guarantee it matches the registered ClickUp app URL byte-for-byte. |
| `CLICKUP_API_TOKEN` | Optional | Company token BOOTSTRAP/FALLBACK (hygiene alerts + Ads OS directory/tickets). A DB override set in Integrations Hub → ClickUp takes precedence — rotate there, no republish (deployments freeze env secrets at publish time). |
| `CLICKUP_LIST_ID` | Optional | List ID for hygiene-alert push |

Set secrets via the Replit Secrets panel.

---

## Creating the ClickUp OAuth app (one-time admin setup)

`CLICKUP_CLIENT_ID` and `CLICKUP_CLIENT_SECRET` come from a ClickUp OAuth app that a **workspace owner or admin** must create once:

1. In ClickUp, click the **Workspace avatar** (upper-left corner) → **Settings** → in the sidebar select **ClickUp API** → switch to the **"ClickUp API Settings"** tab → click **Create an App** (upper-right). (The "API tokens" tab on the same page is the personal token — not this.)
2. Give it a name (e.g. "NoBull OS").
3. **Add the redirect URL shown in the Integrations Hub ClickUp card** as a registered redirect URL in the ClickUp app. The URL must match **byte-for-byte** (scheme, host, path — no trailing slash differences). ClickUp returns `OAUTH_017` ("Unable to authorize your teams") if there is any mismatch.
   - Production: typically `https://reports.nobullmarketing.com/api/integrations/clickup/callback` — verify against the displayed value in the Hub card.
   - Dev workspace: your Replit dev workspace URL + `/api/integrations/clickup/callback`
4. Copy the **Client ID** and **Client Secret** that ClickUp displays.
5. Add them as `CLICKUP_CLIENT_ID` and `CLICKUP_CLIENT_SECRET` in **Replit Secrets** (both dev workspace and the production deployment).
6. **Production only:** add `CLICKUP_REDIRECT_URI=https://reports.nobullmarketing.com/api/integrations/clickup/callback` in the production deployment's Secrets. This pins the redirect URI to the canonical custom domain so it can never drift if `REPLIT_DOMAINS` ordering changes.

> **Diagnosing `OAUTH_017` / "Unable to authorize your teams":** Go to the **Integrations Hub → ClickUp card** and look at the "Redirect URI for ClickUp OAuth app" row. Copy the displayed URI and compare it character-by-character to the redirect URLs registered in your ClickUp OAuth app (Workspace Settings → ClickUp API → your app → redirect URLs). Even a trailing slash or scheme difference triggers `OAUTH_017`.

Without `CLICKUP_CLIENT_ID` and `CLICKUP_CLIENT_SECRET`, the "Connect ClickUp" button on the Profile page returns a 503 and nobody can connect. The Integrations Hub ClickUp card shows a setup notice when they are absent.

### Per-user connection (each team member)

Once the OAuth app credentials are in place, every team member connects their own account:
- Go to **Profile page → ClickUp section → Connect**.
- The Service Desk runs on the **acting admin's own connected account** (`getCeoToken` reads the current user's token). If you are the admin running Service Desk setup, you must connect your own account first.

---

## OAuth flow

```
User clicks "Connect ClickUp"
  → GET /api/integrations/clickup/authorize
  ← { url: "https://app.clickup.com/api?client_id=…&state=…" }
  → Browser redirect to ClickUp
  → User grants access
  → ClickUp redirects to GET /api/integrations/clickup/callback?code=…&state=…
  → Backend exchanges code for access_token
  → Stores encrypted token in clickup_user_tokens
  → Redirect to /admin/integrations?clickup=connected
```

State is HMAC-signed (SHA-256, keyed on CLICKUP_CLIENT_SECRET) and has a 10-minute TTL.

---

## Rate limits

Ref: developer.clickup.com/docs/rate-limits

- Business plan: 100 requests / minute per token.
- `X-RateLimit-Reset` is **epoch seconds** (not delta).
- Proactive gate: when `remaining < 20%` of `limit`, delay next request by
  `timeToReset / remaining` (capped at 10 s).
- Reactive: 429 → wait until `X-RateLimit-Reset`, then retry.

---

## Webhook verification

- HMAC-SHA256 over raw body with the per-webhook `secret` (returned at creation, stored encrypted).
- Signature arrives in `X-Signature` header.
- Webhook ID arrives in `X-Webhook-Id` header (used to look up the correct secret).
- Receiver: `POST /api/webhooks/clickup` (unauthenticated, HMAC-gated).

---

## Tags

Tags are Space-scoped objects (name + foreground/background color). Removing a tag
from a task does **not** delete it from the Space.

### Space tag CRUD

| Method | Path | Action |
|--------|------|--------|
| `GET` | `/api/clickup/spaces/:spaceId/tags` | List all tags in the Space |
| `POST` | `/api/clickup/spaces/:spaceId/tags` | Create a tag (`name`, `tag_fg`, `tag_bg`) |
| `PUT` | `/api/clickup/spaces/:spaceId/tags/:tagName` | Rename or recolor a tag |
| `DELETE` | `/api/clickup/spaces/:spaceId/tags/:tagName` | Delete tag (removes from all tasks) |

### Task tag add/remove

| Method | Path | Action |
|--------|------|--------|
| `POST` | `/api/clickup/tasks/:taskId/tags/:tagName` | Add tag to task + update mirror |
| `DELETE` | `/api/clickup/tasks/:taskId/tags/:tagName` | Remove tag from task + update mirror |

### UI

- **Tags tab** (main content area, enabled when a Space is selected): lists all Space tags
  with color swatches. Create, rename, recolor, delete (with a confirmation noting it removes
  the tag everywhere).
- **Tag picker** (task detail dialog, Details tab): shows the task's current tags as removable
  chips. "Add tag" expands a dropdown of Space tags not yet on the task.

---

## Database mirror tables

All tables live in `shared/models/clickup.ts`:

| Table | Purpose |
|-------|---------|
| `clickup_user_tokens` | Per-user OAuth tokens (encrypted) |
| `clickup_workspaces` | Workspace mirror |
| `clickup_spaces` | Space mirror |
| `clickup_folders` | Folder mirror |
| `clickup_lists` | List mirror |
| `clickup_custom_fields` | Custom field definitions |
| `clickup_tasks` | Task mirror (write-through; `tags` jsonb updated on add/remove) |
| `clickup_checklists` | Checklist mirror |
| `clickup_comments` | Comment mirror |
| `clickup_time_entries` | Time entry mirror |
| `clickup_goals` | Goal mirror |
| `clickup_docs` | Doc mirror |
| `clickup_webhooks` | Registered webhook records |

---

## Work queue jobs

| Queue | Handler | Purpose |
|-------|---------|---------|
| `clickup_hierarchy_backfill` | `handleClickUpHierarchyBackfill` | Full workspace sync (spaces → folders → lists → tasks) |
| `clickup_task_apply` | `handleClickUpTaskApply` | Per-task reconciliation (triggered by webhook) |
| `clickup_subtree_refresh` | `handleClickUpSubtreeRefresh` | Targeted sub-tree mirror refresh after template-based creation |

Trigger backfill: `POST /api/clickup/workspaces/:workspaceId/sync` (admin).

The `clickup_subtree_refresh` job is enqueued automatically after every
create-from-template route completes.  It refreshes only the affected
sub-tree (space / folder / list level) so template-created objects appear
in the mirror quickly without waiting for the next full backfill cycle.
This is especially important for large templates created with
`return_immediately=true` where ClickUp continues materialising objects
in the background after the API call returns.

---

## Admin routes

| Method | Path | Access |
|--------|------|---------|
| `GET` | `/api/integrations/clickup/authorize` | Authenticated user |
| `GET` | `/api/integrations/clickup/callback` | Public (OAuth callback) |
| `POST` | `/api/integrations/clickup/disconnect` | Authenticated user |
| `GET` | `/api/integrations/clickup/status` | Authenticated user |
| `POST` | `/api/clickup/workspaces/:id/sync` | Admin |
| `GET/POST/DELETE` | `/api/clickup/workspaces/:id/webhooks` | Admin |
| `GET` | `/api/integrations/clickup/company-token/status` | account_manager+ |
| `POST` | `/api/integrations/clickup/company-token/test` | team_lead+ |
| `POST` | `/api/integrations/clickup/company-token` | team_lead+ |
| `DELETE` | `/api/integrations/clickup/company-token` | team_lead+ |

---

## Ads OS company token — runtime rotation + auth-dead alerting (Task #3662)

**Why:** deployments freeze env secrets at publish time. Twice, rotating the
ClickUp personal token after a publish left production running a stale
`CLICKUP_API_TOKEN` snapshot — the Ads OS Client List directory went
auth-dead (`HTTP 401: Oauth token not found`) and the Main Dashboard quietly
degraded to raw Google Ads account names. The company token is therefore
**runtime-rotatable** and the directory **alerts when it goes auth-dead**.

**Accessor** (`server/services/clickUpCompanyToken.ts`): resolves DB override
(`system_settings.clickup_company_auth_token`) → `CLICKUP_API_TOKEN` env →
none, with a ~30s in-process cache (`CLICKUP_COMPANY_TOKEN_CACHE_TTL_MS`) and
single-flight. ALL company-token consumers route through it — Ads OS
directory (`adsOs/clickUpDirectory.ts`), Ads OS ticket pushes
(`adsOs/clickUpTasks.ts`), hygiene surface (`clickUpClient.ts`). No direct
env reads remain at leaf fetches. The setting key is deny-listed from the
Redis settings cache (token-bearing `_auth_token` suffix + explicit
`SETTINGS_CACHE_DENYLIST` entry) and the value is never logged, audited, or
returned by any API.

**Rotation flow (no republish):** Integrations Hub → ClickUp card → "Ads OS
company token": paste token → **Test connection** (live-probes the Client
List with the pasted token; reports client count or the exact ClickUp error;
never mutates directory state) → **Save & activate** (writes the override,
then force-refreshes the directory and reports the outcome). All instances
converge within ~1 min (TTL cache) — a failing directory retries within 60s
(failure backoff) and picks up the new token. **Clear override** reverts to
the env token.

**Auth-dead alerting** (`adsOs/clickUpDirectoryAlert.ts`, pattern:
`semrushDisconnectAlert.ts`): every completed directory fetch reports its
outcome. HTTP 401 alerts after a 5-min grace (anchored at the streak's first
401); other failures after 3 consecutive attempts. Slack + in-app via
notification `integration.clickup.ads_os_directory_down` (dedupe `global`),
at most once per outage streak, re-armed by the next healthy fetch
(`markRecovered`). Kill switch: `kill_switch_clickup_directory_alert`
(set `"false"` to disable). Distinct from `integration.clickup.auth_dead`
(per-user OAuth breaker).

**Prod verification without a session:** `GET
/api/ads-os/cron/clickup-health?probe=1` with `X-Cron-Key: $CRON_SECRET` —
returns `{ health, probe: { ok, clients } }` from a live forced fetch.

### Ads OS Practice Area directory authority and write direction

For the ClickUp-backed Ads OS directory and its server writeback seam, the
canonical Client List (`901417549202`) is authoritative. Its unique
`Practice Area` field is pinned as UUID
`237317f2-e612-4983-baf7-97166de73a77`, type `labels`. The list field's
`type_config.options` owns the complete ordered label set; each live parent
task's value owns that client's selected option IDs. Parent selections are
projected to every associated Google Ads and LSA CID.

**Foundation-stage boundary:** the existing Ads OS criteria
`practice_areas` field is a separate, unsynchronized legacy
campaign-analysis input. Its criteria API/editor persistence and its
keyword/pyramid consumers are intentionally unchanged in this stage and must
not be treated as ClickUp selection state. Replacing that second dictionary
and routing those consumers through this contract belongs to the planned
practice-area synchronization stage.

**Read freshness/outage:** metadata and tasks refresh together through the same
company token, 10-minute cache, keyed single-flight, force-refresh, 60-second
failure backoff, current-health liveness, and stale-serving path as the existing
Ads OS directory. Missing/ambiguous field metadata, wrong field type/UUID,
malformed options, or unknown task values rejects the entire candidate refresh;
the last good bundle remains available and `clickup_live` reports the failure.

**Write direction:** the Ads OS server operation replaces one live parent's
complete selection from canonical labels. Every operation first forces a
successful task+field-metadata refresh while holding the directory lock; stale
display data cannot authorize a write. It then validates the fresh parent
mapping and option IDs, sends option IDs as `[{ id }]`, and sends `[]` to clear.
Same-set retries are no-ops, transient 5xx responses get one bounded retry, and
timeout/rate-limit/auth failures never patch the cache. After ClickUp confirms
success, every CID under the parent is patched in memory; the next normal refresh
remains authoritative. The operation resolves the company token at call time,
never adds a credential path, and never logs a token or returns one to the
browser.

---

## Epic 8 — Template support

Added in the template support task on top of the Epic 7 (Task #2976) hierarchy management.

Creating or editing template definitions is **out of scope** — the ClickUp public API does
not expose template creation or editing.  Users manage templates in the ClickUp app directly.
Only browsing and instantiating templates is supported here.

### Template API routes

| Method | Path | Body / Response |
|--------|------|-----------------|
| `GET` | `/api/clickup/workspaces/:workspaceId/task-templates` | `{ templates: CUTemplate[] }` |
| `GET` | `/api/clickup/workspaces/:workspaceId/list-templates` | `{ templates: CUTemplate[] }` |
| `GET` | `/api/clickup/workspaces/:workspaceId/folder-templates` | `{ templates: CUTemplate[] }` |
| `POST` | `/api/clickup/lists/:listId/tasks-from-template` | `{ templateId, name?, workspaceId }` → `{ task, materializing: false }` |
| `POST` | `/api/clickup/folders/:folderId/lists-from-template` | `{ templateId, name?, workspaceId, spaceId?, returnImmediately? }` → `{ list?, materializing }` |
| `POST` | `/api/clickup/spaces/:spaceId/lists-from-template` | `{ templateId, name?, workspaceId, returnImmediately? }` → `{ list?, materializing }` |
| `POST` | `/api/clickup/spaces/:spaceId/folders-from-template` | `{ templateId, name?, workspaceId, returnImmediately? }` → `{ folder?, materializing }` |

All template routes require a valid per-user ClickUp token (`requireClickUpToken`).

**`return_immediately`** (List and Folder create-from-template only):
- `true` (default): ClickUp returns before all nested assets are materialised.
  The backend enqueues `clickup_subtree_refresh` so the mirror catches up automatically.
  The UI shows an amber "still being created" state after the call returns.
- `false`: synchronous creation (may time out for large templates).

**CUTemplate shape**: `{ id: string; name: string; content?: string }`.

Templates appear in the picker only if they have been added to the workspace library
in ClickUp.  Personal/private templates not in the library are not returned by the API.

### UI flow

- **Task from template**: "From template" button appears next to "Add task" in the task panel.
  Opens `TemplatePickerDialog` (task-templates for this workspace). Name override is optional.
  Task creation is synchronous; the task list refreshes immediately on success.

- **List from template (in Space)**: "New List from Template" dropdown item in each Space's
  `⋯` menu (sidebar). Opens `TemplatePickerDialog` (list-templates).

- **List from template (in Folder)**: "New List from Template" dropdown item in each Folder's
  `⋯` menu (sidebar). Opens `TemplatePickerDialog` (list-templates).

- **Folder from template**: "New Folder from Template" dropdown item in each Space's `⋯` menu.
  Opens `TemplatePickerDialog` (folder-templates).

All List and Folder template dialogs use `return_immediately: true`.  If the response
`materializing` flag is `true`, a toast says "still being created in ClickUp — hierarchy
will refresh shortly" and an amber indicator shows in the dialog while it is open.

## Epic 5 — Move task + Tasks in Multiple Lists (TIML)

Added in Task #2974 on top of the Epic 4 (Task #2973) REST client.

### New API routes

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/clickup/tasks/:taskId/move` | Move task to a new home list (`{ listId }`) — uses ClickUp `POST /list/{listId}/task/{taskId}`; mirrors `listId` in `clickupTasks` |
| `POST` | `/api/clickup/tasks/:taskId/lists/:listId` | Add task to an additional list (TIML) — returns 422 `{ timl_disabled: true }` if the ClickApp is off |
| `DELETE` | `/api/clickup/tasks/:taskId/lists/:listId` | Remove task from an additional list — returns 422 `{ timl_disabled: true }` or `{ home_list: true }` on constraint violations |

The `GET /api/clickup/lists/:listId/tasks` route now forwards `include_timl=true`
from the client to ClickUp so `additional_lists` is populated on each task.
`GET /api/clickup/tasks/:taskId/full` passes `include_timl=true` to the
single-task fetch so the task detail view sees the full list membership.

### Client functions (`clickUpClient.ts`)

| Function | ClickUp endpoint | Notes |
|----------|-----------------|-------|
| `moveTask(token, taskId, listId)` | `POST /list/{listId}/task/{taskId}` | Without TIML ClickApp moves home list; with TIML also moves home only |
| `addTaskToList(token, taskId, listId)` | `POST /list/{listId}/task/{taskId}` | TIML add; same URL as move, distinct intent |
| `removeTaskFromList(token, taskId, listId)` | `DELETE /list/{listId}/task/{taskId}` | TIML remove |
| `isTiMlDisabledError(err)` | — | Classifies 400/403 "tasks in multiple lists" / "timl" / "clickapp" errors |

### UI (TaskDetailDialog)

- **Move button** in dialog header (and in the Lists tab home-list row) opens a
  `ListPicker` hierarchy browser to select the destination list.
- **Lists tab** shows the current home list with a Move shortcut and an
  "Additional Lists" section with remove buttons per TIML membership. An
  "Add to another list" button opens the TIML `ListPicker`.
- **ListPicker** component browses the ClickUp workspace hierarchy
  (spaces → folders → lists) with expand/collapse and calls back with the
  selected `listId`. Excludes the current home list via `excludeListId`.
- Move uses the `/move` route (optimistic `listId` mirror + webhook reconcile).
- TIML disabled → toast explaining the ClickApp requirement; home-list remove
  attempt → toast directing the user to Move first.

---

## Epic 4 — Subtasks, dependencies, task links, merge, and watchers

Added in Task #2973 on top of the Epic 3 (Task #2927) REST client.

### New API routes

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/clickup/workspaces/:workspaceId/search?query=` | Search tasks in workspace (≤25 results) |
| `GET` | `/api/clickup/tasks/:taskId/full` | Fetch task + subtasks + dependencies + linked_tasks + watchers in one call |
| `POST` | `/api/clickup/tasks/:taskId/dependencies` | Add a dependency (`depends_on` or `dependency_of`) |
| `DELETE` | `/api/clickup/tasks/:taskId/dependencies` | Remove a dependency (`depends_on` or `dependency_of`) |
| `POST` | `/api/clickup/tasks/:taskId/links/:linksTo` | Create a task link |
| `DELETE` | `/api/clickup/tasks/:taskId/links/:linksTo` | Remove a task link |
| `POST` | `/api/clickup/tasks/:taskId/merge` | Merge duplicate tasks (`{ task_ids: [...] }`) into this task |
| `POST` | `/api/clickup/tasks/:taskId/watchers` | Add watcher(s) (`{ add: [userId, ...] }`) |
| `DELETE` | `/api/clickup/tasks/:taskId/watchers/:userId` | Remove a single watcher |

### ClickUp API mapping

- **Subtasks**: `GET /task/{taskId}?include_subtasks=true` — nested `subtasks[]` array on the response.
- **Dependencies**: `POST/DELETE /task/{taskId}/dependency` — body `{ depends_on }` (waiting-on, type `"1"`) or `{ dependency_of }` (blocking, type `"2"`).
- **Task links**: `POST/DELETE /task/{taskId}/link/{linksTo}`.
- **Merge**: `POST /task/{taskId}/merge` — body `{ task_ids: [...] }`. The source task is closed; its data is merged into the target.
- **Watchers**: updated via task PATCH `{ watchers: { add: [...], rem: [...] } }`. Watcher list comes from the task's `watchers[]` field.

### UI — TaskDetailDialog new tabs

The task detail dialog gains five tabs alongside the existing Details / Comments / Time tabs:

| Tab | What it shows |
|-----|---------------|
| **Subtasks** | List with status badge; inline "Add subtask" (POST to same list, `parent` field set) |
| **Dependencies** | Two sections — "Waiting on" (amber) and "Blocking" (blue); TaskPicker for each; remove button (×) per entry |
| **Links** | Linked task IDs; TaskPicker to add; remove button (×) per entry |
| **Watchers** | Avatar + username list; remove button (×) per entry; add by ClickUp user ID |
| **Merge** | Button in dialog header opens a separate MergeDialog with TaskPicker + two-step confirm |

The dialog fetches the full task via `/api/clickup/tasks/:taskId/full` (SWR 15 s) on open. The summary-row task from the list panel is used immediately while the full fetch completes.

The `MergeDialog` is a separate `<Dialog>` rendered as a sibling to prevent nesting, with a two-step confirm (select → review → confirm merge).

The `TaskPicker` component does a debounced workspace search (`query.length > 1`) and shows up to 8 inline results.

---

## Search & Filtering

### Workspace-wide task search

`GET /api/clickup/workspaces/:workspaceId/search` — calls ClickUp
`GetFilteredTeamTasks` (GET /team/{id}/task) under the acting user's token.

Key query parameters:

| Param | Type | Description |
|-------|------|-------------|
| `q` | string | Free-text search (task name + description) |
| `page` | integer | 0-indexed page (100 tasks per page) |
| `statuses` | comma-separated | Status names to include |
| `assignees` | comma-separated | ClickUp user IDs |
| `tags` | comma-separated | Tag names |
| `priorities` | comma-separated | 1=urgent, 2=high, 3=normal, 4=low |
| `space_ids` | comma-separated | Scope to these spaces |
| `folder_ids` | comma-separated | Scope to these folders |
| `list_ids` | comma-separated | Scope to these lists |
| `due_date_gt` / `due_date_lt` | epoch-ms | Due date range |
| `start_date_gt` / `start_date_lt` | epoch-ms | Start date range |
| `include_closed` | "true" | Include closed/done tasks |
| `custom_fields` | JSON | `CUCustomFieldFilter[]` — field_id + operator + value |

Custom field operators: `=`, `!=`, `<`, `>`, `<=`, `>=`, `contains`,
`not contains`, `starts with`, `ends with`, `is null`, `is not null`, `RANGE`.
Range format: `{ field_id, operator: "RANGE", value: { lower, upper } }`.

Rate-limit pacing (proactive + reactive 429) is handled inside the client.
**Clients must debounce at ≥ 400 ms** before sending a search request.

### Facets endpoint (mirror-backed, no API budget)

`GET /api/clickup/workspaces/:workspaceId/facets` returns
`{ statuses, members, tags }` for populating filter dropdowns instantly from
the local mirror tables (`clickup_spaces.statuses`, `clickup_workspaces.members`,
`clickup_tasks.tags`).

### Saved filter presets

Per-user filter presets are stored in NoBull's `clickup_filter_presets` table
(not ClickUp's saved-views feature — that is a separate Epic task).

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/clickup/filter-presets?workspace_id=…` | List presets for user |
| `POST` | `/api/clickup/filter-presets` | Save a preset `{ name, workspaceId, filters }` |
| `DELETE` | `/api/clickup/filter-presets/:id` | Delete a preset (owner only) |

The `filters` JSONB field stores the full `SearchFilters` shape from the UI:
query, statuses, assignees, tags, priorities, date ranges, space/list scope,
include_closed, and custom-field filter rules.

---

## Attachments

All attachment I/O is proxied server-side — ClickUp credentials never reach the browser.

### Routes

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/clickup/tasks/:taskId/attachments` | List via v3 `GetParentEntityAttachments` |
| `POST` | `/api/clickup/tasks/:taskId/attachments` | Upload to task via v3 `PostEntityAttachment` (multipart, max 25 MB) |
| `GET` | `/api/clickup/attachments/proxy?url=<encoded>` | Proxy-stream any ClickUp attachment URL (SSRF-guarded; allowed hosts: `*.clickup.com`) |
| `POST` | `/api/clickup/entity/:entityId/attachments` | Upload to a file-type custom field entity via v3 (custom-fields epic reuse point) |
| `DELETE` | `/api/clickup/tasks/:taskId/attachments/:id` | Delete via v2 (plan-dependent; surfaces error if unavailable) |

Add `?download=1&filename=<name>` to the proxy URL to force a browser download.

### Gallery UI

The task-detail dialog → **Files** tab shows:
- 3-column thumbnail grid (image types show a proxy-fetched thumbnail; other types show a file-type icon with extension badge).
- Hover overlay: filename, download link, delete button.
- Click an image thumbnail → full-screen preview modal with download link.
- "Upload file" button opens a file picker; client enforces 25 MB cap with a descriptive error.

### Custom field file uploads

`POST /api/clickup/entity/:entityId/attachments` uses v3 `PostEntityAttachment`.
After uploading, the caller must call `POST /api/clickup/tasks/:taskId/fields/:fieldId`
with `{ value: <attachment_id> }` to associate the file with the custom field.
This endpoint is intentionally separate so the custom-fields epic task can drive the
full association flow without duplicating the upload relay.

---

## Saved views

Views are read live from the ClickUp API (no local mirror — they are small and
change frequently). All 12 view routes require a valid per-user ClickUp token
(`requireClickUpToken`). No DB migration is needed.

### View API routes

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/clickup/workspaces/:workspaceId/views` | GetTeamViews — workspace ("Everything") level |
| `POST` | `/api/clickup/workspaces/:workspaceId/views` | CreateTeamView |
| `GET` | `/api/clickup/spaces/:spaceId/views` | GetSpaceViews |
| `POST` | `/api/clickup/spaces/:spaceId/views` | CreateSpaceView |
| `GET` | `/api/clickup/folders/:folderId/views` | GetFolderViews |
| `POST` | `/api/clickup/folders/:folderId/views` | CreateFolderView |
| `GET` | `/api/clickup/lists/:listId/views` | GetListViews — returns `{ views, required_views }` |
| `POST` | `/api/clickup/lists/:listId/views` | CreateListView |
| `GET` | `/api/clickup/views/:viewId` | GetView |
| `PUT` | `/api/clickup/views/:viewId` | UpdateView (name, grouping, sorting, filters, columns) |
| `DELETE` | `/api/clickup/views/:viewId` | DeleteView |
| `GET` | `/api/clickup/views/:viewId/tasks` | GetViewTasks — `?page=N` (0-indexed, 100 tasks/page, `last_page` flag) |

### Location priority

The Views tab scopes to the most specific location selected in the sidebar:
list → folder → space → workspace. Changing the selection resets the active view.

### Supported view types (native renderers)

| Type | Renderer |
|------|----------|
| `list` | Scrollable task list with status / priority / due date |
| `board` | Kanban columns grouped by `task.status.status` |
| `table` | `<thead>/<tbody>` with name / status / priority / assignee / due columns |
| `calendar` | Monthly grid; tasks placed by `due_date` epoch-ms; month navigation |

### Unsupported types (deep-link)

`timeline`, `workload`, `gantt`, `map`, `activity`, `chat` — the UI shows an
"Open in ClickUp" button using the view's `url` field. If `url` is absent,
a plain message is shown instead.

### List views — required_views

`GetListViews` returns both `views` (user-created) and `required_views`
(system-managed). Both arrays are concatenated and shown in the view picker.

### View management

- **Create**: "New view" button → dialog selects name + type (list / board /
  calendar / table). Calls the appropriate `POST .../views` for the current location.
- **Rename**: pencil icon on each view chip → dialog pre-filled with current name.
  Calls `PUT /api/clickup/views/:viewId` with `{ name }`.
- **Delete**: trash icon → `window.confirm` guard → `DELETE /api/clickup/views/:viewId`.
  Deselects the view if it was active.

### Filter presets vs. saved views

`clickup_filter_presets` (NoBull DB) stores search panel filter presets and is
**unrelated** to ClickUp saved views. Views carry ClickUp's own grouping /
sorting / filter / column configuration.

---

## Custom field editing

### Routes

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/clickup/tasks/:taskId/fields/:fieldId` | Set a custom field value |
| `DELETE` | `/api/clickup/tasks/:taskId/fields/:fieldId` | Remove (clear) a custom field value — `DELETE /api/v2/task/{id}/field/{fieldId}` |
| `GET` | `/api/clickup/workspaces/:workspaceId/custom-item-types` | List custom task types (`GET /api/v2/team/{id}/custom_item`) |
| `GET` | `/api/clickup/folders/:folderId/custom-fields` | List accessible fields for a folder |
| `GET` | `/api/clickup/spaces/:spaceId/custom-fields` | List accessible fields for a space |
| `GET` | `/api/clickup/workspaces/:workspaceId/custom-fields` | List accessible fields for a workspace |

### Applied-objects gating

ClickUp fields carry an `applied_objects` array.  Each entry has
`{ object_type: 19, object_id: "<custom_item_id>" }`.

- Empty array → field applies to all task types.
- Non-empty → field is shown only when the task's `custom_item_id` matches one of the listed `object_id`s.
- Non-empty + task has no `custom_item_id` → field is hidden (type-scoped, task is untyped).

The **Fields** tab filters the task's `custom_fields` array using this logic
before rendering any editors.

### Field-type support matrix

| Field type | Editor UI | Set value shape | Clear (DELETE) |
|------------|-----------|-----------------|---------------|
| `text` | Text input | `string` | ✓ |
| `short_text` | Text input | `string` | ✓ |
| `email` | Email input | `string` | ✓ |
| `phone` | Tel input | `string` | ✓ |
| `url` | URL input | `string` | ✓ |
| `number` | Number input | `number` | ✓ |
| `currency` | Number input + currency symbol | `number` | ✓ |
| `rating` | Star buttons (1–N, from `type_config.count`) | `number` | ✓ |
| `emoji` | Star buttons (1–N, from `type_config.count`) | `number` | ✓ |
| `checkbox` | Checkbox toggle | `boolean` | — (toggle OFF instead) |
| `date` | Date picker | epoch-ms `number` | ✓ |
| `dropdown` | Select with color-coded options | option id `string` | via "Clear" option |
| `labels` | Multi-select pill toggles (from `type_config.options`) | `[{ id }]` array | by deselecting all |
| `users` | User chips + remove per chip + add-by-user-ID input | `[{ id }]` array | ✓ |
| `relationship` | Linked-task chips + remove per chip + add-by-task-ID input | `[taskId]` array | ✓ |
| `file` | Upload button → task attachment → set attachment ID | attachment id `string` | ✓ |
| `formula` | Read-only (computed — lock icon) | — | — |
| `rollup` | Read-only (computed — lock icon) | — | — |
| `auto_progress` | Read-only (computed — lock icon) | — | — |
| `manual_progress` | Read-only (computed — lock icon) | — | — |
| Unknown type | Read-only display with type label | — | — |

**File upload flow (file-type fields):**
1. User picks a file → `POST /api/clickup/tasks/:taskId/attachments` (multipart, key `file`).
2. Response contains `attachment.id`.
3. Auto-calls `POST /api/clickup/tasks/:taskId/fields/:fieldId` with `{ value: attachmentId }`.

**Optimistic refresh:** every save/clear calls `invalidateFull()` which refetches
the `/api/clickup/tasks/:taskId/full` query so field values update without a page reload.

---

## Epic 9/16 — Time tracking completeness

Added in Task #2978. Extends the time tracking layer with workspace reports,
entry history, tag management, per-user estimates, and time-in-status insights.

API refs consulted 2026-07-16:
- `GetTimeEntriesWithinADateRange` (date range, location filter, tags)
- `GetSingularTimeEntry`, `GetTimeEntryHistory`
- `GetAllTagsForTimeEntries`, `AddTagsFromTimeEntries`, `RemoveTagsFromTimeEntries`,
  `ChangeTagNamesFromTimeEntries`
- `UpdateTimeEstimatesByUser`
- `GetTaskTimeInStatus`, `GetBulkTasksTimeInStatus`
- developer.clickup.com/docs/apis-available-by-plan (plan-gate matrix)

### Plan-gate matrix

| Feature | Minimum plan |
|---------|-------------|
| Unlimited time-entry tags | Business Plus+ |
| Time entries not tied to a task | Business Plus+ |
| Viewing another user's time (`assignee` param) | Business Plus+ |
| Per-user time estimates | Business plan+ |
| Time in status | All plans |

Plan-limited requests return **HTTP 402** with `{ plan_limited: true, message: "…" }`.
The UI renders a `PlanLimitedNotice` amber banner — never a raw error.

### New API routes

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/clickup/workspaces/:id/time-entries` *(extended)* | Date range `start_date`/`end_date` (epoch-ms), `assignee`, one location filter (`space_id`\|`folder_id`\|`list_id`\|`task_id`), `tags` (CSV), `include_location_names` |
| `GET` | `/api/clickup/workspaces/:id/time-entries/:entryId/history` | Change history for a single entry |
| `GET` | `/api/clickup/workspaces/:id/time-entry-tags` | All tag names used in workspace |
| `POST` | `/api/clickup/workspaces/:id/time-entries/:entryId/tags` | Add tags `{ tags: [{name}] }` (plan-gated) |
| `DELETE` | `/api/clickup/workspaces/:id/time-entries/:entryId/tags` | Remove tags `{ tags: [{name}] }` |
| `PUT` | `/api/clickup/workspaces/:id/time-entry-tags/rename` | Rename tag workspace-wide `{ name, new_name }` |
| `PUT` | `/api/clickup/tasks/:taskId/time-estimates/user/:userId` | Set per-user estimate `{ estimates: [{duration}] }` (Business+; 402 on lower plan) |
| `GET` | `/api/clickup/tasks/:taskId/time-in-status` | How long task has spent in each status |
| `GET` | `/api/clickup/workspaces/:id/tasks/time-in-status?task_ids=` | Bulk time-in-status (comma-separated IDs) |

### Location filter rule (API constraint)

`GetTimeEntriesWithinADateRange` accepts **exactly ONE** location filter per
request. Priority order applied by NoBull server: `task_id` > `list_id` >
`folder_id` > `space_id`. Passing multiple results in ClickUp returning data
for only the most specific scope — the route enforces this by dropping lower-
priority filters when a higher one is present.

### New client functions in `clickUpClient.ts`

- `isPlanLimitError(errorText)` — detects 403/plan-gate errors; used by routes to emit HTTP 402
- `getSingleTimeEntry(token, workspaceId, timerId)` — single entry fetch
- `getTimeEntryHistory(token, workspaceId, timerId)` — change history array
- `getTimeEntryTags(token, workspaceId)` — all workspace tag names
- `addTagsToTimeEntry(token, workspaceId, timerId, tags[])` — POST with `tags[]`
- `removeTagsFromTimeEntry(token, workspaceId, timerId, tags[])` — DELETE with body
- `renameTimeEntryTag(token, workspaceId, name, newName)` — PUT rename
- `getTimeEntriesRange(token, workspaceId, opts)` — full-filter version of getTimeEntries
- `updateTimeEstimateForUser(token, taskId, userId, estimates[])` — Business+
- `getTaskTimeInStatus(token, taskId)` — single task
- `getBulkTasksTimeInStatus(token, workspaceId, taskIds[])` — up to ClickUp's max

### UI additions

**Global running-timer widget** (`RunningTimerWidget`):
- Rendered in the module header beside the action buttons whenever a workspace is selected.
- Polls `GET /api/clickup/workspaces/:id/timer/current` every 10 s.
- Live HH:MM:SS counter ticks every second using `setInterval`.
- Shows task name (truncated) + elapsed; Stop button stops the timer immediately.
- Hidden when no timer is running.

**Time Reports tab** (`TimeReportsPanel`):
- New "Time Reports" tab in the main workspace content area.
- Filters: date range (default: last 30 days), tags, space/folder/list/task ID (one location).
- Tag chip picker populated from workspace tag list.
- Entries table: date, person, task, description, tags, duration (running entries shown in green).
- Summary cards: total time + top-5 by person.
- Edit dialog: change description and duration (minutes) for any entry.
- History popout: inline history panel per entry (triggered by clock icon).
- New entry dialog: start datetime + duration + optional task ID (plan notice when omitted).
- Delete per entry (trash icon).

**Task insights tab** (`Insights` in `TaskDetailDialog`):
- New "Insights" tab alongside the existing Time tab in the task detail dialog.
- **Time in status**: table of every status the task has passed through — status label (color dot), time spent, since-date. Current status highlighted in blue.
- **Per-user estimate form** (`TaskUserEstimateForm`): set a time estimate for a specific ClickUp user ID + duration in minutes. Surfaces `PlanLimitedNotice` on Business+ requirement.

---

## Docs (v3) — search, create, page-tree navigation, editing

Added in Task #2981 (Epic 12/16) on top of the read-only Docs surface from Task #2927.

### API mapping

| NoBull API endpoint | ClickUp v3 method | Notes |
|---------------------|-------------------|-------|
| `GET /api/clickup/workspaces/:id/docs?query=<q>` | `SearchDocsPublic` | `query` is optional; omit for full listing |
| `POST /api/clickup/workspaces/:id/docs` | `CreateDocPublic` | `{ name, parent: {id, type}, create_page }` |
| `GET /api/clickup/workspaces/:id/docs/:docId` | `GetDocPublic` | Single doc metadata |
| `GET /api/clickup/workspaces/:id/docs/:docId/page-listing` | `GetDocPageListingPublic` | Flat list with `parent_page_id` for tree reconstruction |
| `POST /api/clickup/workspaces/:id/docs/:docId/pages` | `CreatePagePublic` | `{ name, content, content_format, parent_page_id? }` |
| `GET /api/clickup/workspaces/:id/docs/:docId/pages/:pageId` | `GetPagePublic` | Page content + metadata |
| `PUT /api/clickup/workspaces/:id/docs/:docId/pages/:pageId` | `EditPagePublic` | Body `{ content, content_format: "text/md" }` |

### `parent.type` values for CreateDocPublic

| type | Location |
|------|----------|
| 7 | Workspace (default when creating from the Docs tab) |
| 4 | Space |
| 6 | Folder |
| 5 | List |

### Page tree

`GetDocPageListingPublic` returns a flat array of `{ id, name, parent_page_id, orderindex }` entries.
The UI builds a nested tree via `buildPageTree()`, sorting siblings by `orderindex`. Top-level pages have
`parent_page_id` absent or null.

### Fidelity warnings

Ref: `developer.clickup.com/docs/docsimportexportlimitations`

The markdown ↔ ClickUp round-trip loses: toggle lists, checklists, banners, text alignment,
inline highlights, embedded views, most embed types.

**Two-level warning system:**
1. **Persistent notice** (yellow/amber, always shown in the editor): informs users of the general
   limitation.
2. **Pre-save block** (red, only on pages with detected rich content): appears when the user first
   clicks Save if `hasUnsupportedContent()` returns true. The user must click "Save anyway" to confirm.

`hasUnsupportedContent(content, contentFormat)` returns true if:
- `content_format` is not `"text/md"`, `"markdown"`, or `"md"` (indicates native ClickUp format), OR
- The content string contains checklist patterns (`- [ ]`), ClickUp fenced blocks (`:::`), or
  known embed markers.

### UI flow

**Doc list view:**
- Search box (debounced 400 ms) → filters results via `SearchDocsPublic`.
- "New Doc" button → `CreateDocDialog` (name only; creates at workspace level with `create_page: true`).
- Clicking a doc → doc view.

**Doc view:**
- Back to docs list button.
- Page tree sidebar (left): expand/collapse nodes, click to select, "Add page" (top-level),
  "+ sub-page" hover button on each node.
- Page content panel (right): read-only view or edit textarea.
- "Refresh" link forces `GetDocPageListingPublic` re-fetch.

**Creating pages:**
- `CreatePageDialog` accepts a name; sends `{ content: "", content_format: "text/md" }`.
- After creation, the new page is immediately selected and the tree is refreshed.
- Sub-pages expand the parent node automatically.

## Chat (v3 — experimental ClickUp API)

> Task #2983 — ClickUp Chat: channels, DMs, messages, thread replies, emoji reactions, post subtypes.
> API refs: developer.clickup.com/reference/getchatchannels et al. (all v3).
> **This surface uses ClickUp's experimental Chat API and may change without notice.**

### Kill switch

| Setting key | Default | Effect |
|-------------|---------|--------|
| `clickup_chat_enabled` | enabled (absent or non-"false") | Set to `"false"` in system_settings to return 503 on all Chat routes. |

### Chat API routes

All Chat routes require authentication (`isAuthenticated`) and check `clickup_chat_enabled`.

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/clickup/workspaces/:wId/chat/subtypes` | List workspace post subtypes (announcement, idea, update, etc.) |
| `GET` | `/api/clickup/workspaces/:wId/chat/channels` | List all channels + DMs in the workspace |
| `POST` | `/api/clickup/workspaces/:wId/chat/channels` | Create a workspace-level channel (idempotent: returns existing if name matches) |
| `POST` | `/api/clickup/workspaces/:wId/chat/channels/location` | Create a Space/Folder/List-bound channel |
| `POST` | `/api/clickup/workspaces/:wId/chat/channels/dm` | Open a DM with up to 15 users (idempotent) |
| `GET` | `/api/clickup/workspaces/:wId/chat/channels/:channelId` | Get channel detail |
| `PATCH` | `/api/clickup/workspaces/:wId/chat/channels/:channelId` | Update channel name/description/privacy |
| `DELETE` | `/api/clickup/workspaces/:wId/chat/channels/:channelId` | Delete channel (permanent) |
| `GET` | `/api/clickup/workspaces/:wId/chat/channels/:channelId/members` | List channel members |
| `GET` | `/api/clickup/workspaces/:wId/chat/channels/:channelId/messages` | List messages (cursor pagination, limit param) |
| `POST` | `/api/clickup/workspaces/:wId/chat/channels/:channelId/messages` | Post a message or "post" (with subtype_id) |
| `PATCH` | `/api/clickup/workspaces/:wId/chat/channels/:channelId/messages/:msgId` | Edit message content |
| `DELETE` | `/api/clickup/workspaces/:wId/chat/channels/:channelId/messages/:msgId` | Delete message |
| `GET` | `/api/clickup/workspaces/:wId/chat/channels/:channelId/messages/:msgId/replies` | List thread replies |
| `POST` | `/api/clickup/workspaces/:wId/chat/channels/:channelId/messages/:msgId/replies` | Post a thread reply |
| `POST` | `/api/clickup/workspaces/:wId/chat/channels/:channelId/messages/:msgId/reactions` | Add emoji reaction |
| `DELETE` | `/api/clickup/workspaces/:wId/chat/channels/:channelId/messages/:msgId/reactions` | Remove emoji reaction |

Emoji names must be lowercase (e.g. `thumbsup`, `heart`, `tada`). Reaction delete sends the emoji name in the request body (not a reaction ID), matching the ClickUp v3 API contract.

### Chat UI — `ChatPanel` component

The "Chat" tab in `ClickUpModule.tsx` renders `<ChatPanel workspaceId={…} />`:

- **Amber experimental banner** at the top of the panel.
- **Channel sidebar** (left 180 px): workspace channels (# icon) and DMs (users icon), separated. "+" opens `CreateChatChannelDialog`; message-circle icon opens `CreateDMDialog`.
- **Message pane** (right): channel header with refresh + delete buttons; message list with avatar initials, username, timestamp, and post-subtype badge; hover action bar (react, thread, edit, delete).
- **Reactions**: rendered inline as pill buttons (`:emoji: N`); clicking a reacted emoji removes it; `SmilePlus` icon opens an inline common-emoji picker (8 emojis: thumbsup, heart, tada, eyes, fire, laughing, white_check_mark, raised_hands).
- **Thread pane**: replaces the message pane when a message is clicked; shows parent message highlighted, reply list, and a reply composer; "Back" chevron returns to the channel.
- **Composer**: toggle between "Message" and "Post" types; Post mode shows a subtype dropdown populated from `/chat/subtypes`; Enter sends, Shift+Enter adds newline.
- **Create dialogs**: `CreateChatChannelDialog` (name, optional description, private toggle) and `CreateDMDialog` (space/comma-separated user IDs).

### ClickUp notes (experimental API)

- ClickUp marks these v3 Chat endpoints as experimental; behavior and schema may change.
- Channel creation is idempotent: ClickUp returns the existing channel if name or member set matches.
- Chat data is **not mirrored** to a local DB table — all reads go live to ClickUp.
- Post subtypes are workspace-unique; fetch via `GET /api/clickup/workspaces/:wId/chat/subtypes`.
- `cuPatch` is a new generic PATCH helper in `server/services/clickUpClient.ts` (alongside `cuGet`, `cuPost`, `cuDelete`).

---

## Goals & Targets full CRUD (Task #2980)

Added on top of the Task #2927 read surface.

### Goal API routes

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/clickup/workspaces/:workspaceId/goals` | List all goals in the workspace |
| `POST` | `/api/clickup/workspaces/:workspaceId/goals` | Create a goal (name, due_date epoch-ms, description, multiple_owners, owners array of numeric IDs, color hex) |
| `GET` | `/api/clickup/goals/:goalId` | Get a single goal including its key_results array |
| `PUT` | `/api/clickup/goals/:goalId` | Update goal (name, description, color, due_date, add_owners/rem_owners numeric ID arrays, is_archived) |
| `DELETE` | `/api/clickup/goals/:goalId` | Delete goal + remove from mirror |

### Key Result (Target) API routes

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/clickup/goals/:goalId/key-results` | Create a key result (name, type, owners, steps_start/end, unit, task_ids, list_ids) |
| `PUT` | `/api/clickup/goals/:goalId/key-results/:krId` | Update progress (steps_current, note) or rename |
| `DELETE` | `/api/clickup/goals/:goalId/key-results/:krId` | Delete a key result |

### Key result types

| Type | ClickUp value | Notes |
|------|--------------|-------|
| `number` | 1 | Progress from steps_start to steps_end |
| `currency` | 2 | Number with currency unit |
| `boolean` | 3 | True/false (steps 0 or 1) |
| `percentage` | 4 | 0–100 range |
| `automatic` | — | Task-based or list-based progress |

### Mirroring

- `clickup_goals` table mirrored in full.
- KR updates trigger a goal-object refresh from the ClickUp API to keep progress % and `key_results` array synced.
- `DELETE /api/clickup/goals/:id` removes the goal from the mirror immediately.

### Rich-text composer

The `RichCommentComposer` component provides a toolbar (B / I / code) and a textarea accepting lightweight markup:
- `**text**` → bold
- `*text*` → italic
- `` `text` `` → inline code
- `[text](url)` → link

`parseCommentMarkup()` converts input text to `CommentBlock[]` before POST.
`renderCommentBlocks()` renders the blocks array into styled React nodes.

### Pagination

Comments are returned newest→oldest. The UI shows the first 25 on load and offers
a "Load older" button that passes the oldest visible comment's `date` (epoch ms) and
`id` as the `start` / `start_id` query params — matching ClickUp's native pagination.

### Threaded replies

Each `CommentRow` can expand in-line to show replies fetched from
`GET /api/clickup/comments/:commentId/replies`. A compact `RichCommentComposer` is
inlined below the comment for adding replies without leaving the view.

### Resolve / unresolve

The resolve button (✓) calls `PUT /api/clickup/comments/:commentId` with
`{ resolved: true|false }`. Resolved comments are styled with a green tint and a
"Resolved" badge. No page reload — the local `allComments` state is patched in-place.

### List Comments panel

The "List Comments" main-tab (disabled when no list is selected) renders
`ListCommentsPanel`, which fetches and paginates `GET /api/clickup/lists/:listId/comments`.
Full resolve / delete / threaded-reply functionality is available, identical to task comments.

---

## Epic 14 — Members, roles, groups, sharing & workspace info

### API surface (all reviewed 2026-07-16)

| Purpose | Method | ClickUp endpoint |
|---|---|---|
| Explicit task members | GET | `/api/v2/task/{task_id}/member` |
| Explicit list members | GET | `/api/v2/list/{list_id}/member` |
| Custom roles | GET | `/api/v2/team/{team_id}/customroles` |
| Shared hierarchy | GET | `/api/v2/team/{team_id}/shared` |
| List user groups | GET | `/api/v2/group?team_id={id}` |
| Create user group | POST | `/api/v2/group` |
| Update user group | PUT | `/api/v2/group/{group_id}` |
| Delete user group | DELETE | `/api/v2/group/{group_id}` |
| Update ACL/privacy | POST | `/api/v2/team/{team_id}/acl` |
| Workspace seats | GET | `/api/v2/team/{team_id}/seats` |
| Workspace plan | GET | `/api/v2/team/{team_id}/plan` |

### Inherited-access caveat

`GetTaskMembers` / `GetListMembers` return **only members with explicit access** — members
who inherited access through team membership or space/folder/list position are excluded.
The UI surfaces this caveat on every Access panel via the `inheritedNote` field returned
by the route. This is a documented ClickUp API limitation, not a bug.

### Plan mirror

`GET /api/clickup/workspaces/:workspaceId/plan` calls ClickUp and writes the plan name
back to `clickup_workspaces.plan` so that plan-gating notices (e.g. "Guests seat count
requires Business Plus") can be evaluated without an additional API round-trip. The column
was added by migration `0109_add_clickup_workspace_plan.sql`.

### Privacy / ACL — cost warning

`POST /api/clickup/workspaces/:workspaceId/acl` calls `PublicPatchAcl`. Sharing an item
(making it non-private) can incur per-guest charges on some ClickUp plans. The `SharingDialog`
UI requires a checkbox acknowledgement ("I understand sharing may incur charges") before
the Apply button is enabled. Never remove or bypass this gate.

### User Group CRUD

Groups are workspace-scoped. The API uses `team_id` (workspace ID) for scoping but
`group_id` for per-group operations. Create → `POST /api/clickup/workspaces/:id/groups`;
rename/member changes → `PUT /api/clickup/groups/:groupId`; delete → `DELETE /api/clickup/groups/:groupId`.
The delete flow requires an inline "Sure? Yes/No" confirmation in the UI.

### UI tabs

Three new tabs are added to the ClickUp module main content area:

| Tab | Enabled when | Component |
|---|---|---|
| **Access** | list selected | `AccessPanel` (list explicit members + Privacy button) |
| **People** | always | `PeoplePanel` (plan banner + seats + custom roles + group CRUD) |
| **Shared** | always | `SharedPanel` (tasks / lists / folders shared with the connected user) |

---

## Diagnostics

- Auth breaker: in-memory per token (last 8 chars), 10-min TTL, auto-cleared on next successful request.
- Probe: `GET /api/integrations/clickup/status` (per-user, reads from DB + calls ClickUp `/user`).
- Backfill status: check `work_queue` table for `clickup_hierarchy_backfill` rows.
- Time tracking plan-limit: watch for HTTP 402 from any time-tracking route — indicates workspace plan needs upgrading. No kill switch; the notice is always surfaced.

## Kill switches / feature flags

---

## Company-token outbound role projection (Task #5156)

### What this is

NoBull can optionally project active service-desk role assignments into ClickUp
People custom fields. Every department supports **Doer**; **Checker** is
projectable only for stable department UUIDs approved in
`shared/departmentRoleCapabilities.ts`. Display names never confer capability,
so new or renamed departments default to Doer-only. When a NoBull operator
saves an assignment, the system stages a durable command that a background
worker applies to a ClickUp **task's** People custom field. The NoBull
assignment always succeeds regardless of ClickUp state.

**Both destination kinds ultimately write a task People field** — the difference is only how the exact task is resolved:

- `direct_task` (company-scope): one shared ClickUp task carries the People field for the whole company. The exact task is `destination.targetId`; its owning list is `destination.listId`.
- `client_list_parent` (per-client): each client maps to its own task via a client-target mapping. The exact task is the client target's `targetId`; the owning list is still `destination.listId`.

In **both** cases the worker performs a live GET of the exact task immediately before any write to prove the task belongs to the expected owning `listId`, then sets/clears the People custom field on that task. There is no "list field" write — `client_list_parent` names how the per-client task is looked up, not a different write target.

### Architecture

| Layer | Component |
|---|---|
| Command staging | The desired command revision and its immediate per-command `work_queue` wake are inserted inside the existing assignment DB transaction (no network). `stageProjectionCommandsInTx` in `server/services/clickUpRoleProjection.ts`. |
| Durable worker | `clickup_role_projection` queue, `handleClickUpRoleProjectionJob` handler. FOR UPDATE SKIP LOCKED lease, bounded 5-attempt back-off (30s→2m→10m→30m→60m). |
| Immediate attempt | Small writes make a bounded post-commit attempt; `kickClickUpRoleProjectionSafe` is a best-effort coalesced accelerator and never the durable delivery path. |
| Durable command wakes (delivery driver) | Initial staging and operator re-sync insert immediate wakes in the SAME command-state tx. Retryable/ambiguous/drift finalization inserts a delayed wake in the SAME finalize tx (one dedupe key per command revision/attempt; enqueued only when command state changed). These — not the accelerator kick or boot catch-up — provide restart-safe first delivery, repair, and retries. |
| Continuation | On the 50-command drain cap the handler enqueues a durable immediate continuation (job-id-derived dedupe key) so the remainder drains crash-safely. |
| Boot catch-up (defense in depth) | `scheduleClickUpRoleProjectionBootCatchup` re-enqueues old, un-leased, due commands if queue state was administratively lost or damaged. Safety net, not the normal delivery path. |
| Kill switch | `clickup_role_projection` — set to `"false"` to pause all projection draining. |

### Status machine

`pending → synced | ambiguous | failed | blocked | disabled | drift`

- **synced**: ClickUp field matches desired value.
- **pending**: command staged, worker has not yet applied it.
- **ambiguous**: write call succeeded but read-back couldn't confirm (retry).
- **failed**: non-retryable error or attempt limit exhausted (dead-letter).
- **blocked**: client target mapping missing (no task/list configured for this client).
- **disabled**: destination not enabled or production gates not cleared.
- **drift**: re-read found a different value than what was set (re-project queued).

### Environment variable

`CLICKUP_ROLE_PROJECTION_ENVIRONMENT`

| Value | Behaviour |
|---|---|
| absent (default) | `unconfigured` — projection disabled, NoBull-only mode. |
| `sandbox` | Writes allowed to sandbox lists. Fails closed against canonical production list `901417549202`. |
| `production` | Requires `enabled=true` plus BOTH sandbox-exit and owner approvals recorded on each destination (see Production approval gates). |

### Sandbox setup

1. In ClickUp, create a **test list** whose ID is NOT `901417549202`.
2. Copy distinct client-target task IDs from the sandbox list (one per NoBull client to test).
3. Set `CLICKUP_ROLE_PROJECTION_ENVIRONMENT=sandbox`.
4. Use `PUT /api/service-desk/role-projections/destinations` (CEO) to configure each active department+responsibility+environment combination with `listId` set to the sandbox list ID. `responsibility` is `doer` or, only for a checker-capable department, `checker`.
5. Use `PUT /api/service-desk/role-projections/targets` (CEO) to map each client to its sandbox task ID.
6. Verify with `GET /api/service-desk/role-projections/status` (team-lead).

### Production approval gates

Production projection requires all three conditions on every destination row:
1. `enabled = true` — CEO flips via the destinations API.
2. Sandbox-exit approval recorded (`sandboxExitApprovedAt` / `sandboxExitApprovedBy`) — owner records successful sandbox-exit evidence.
3. Owner approval recorded (`ownerApprovedAt` / `ownerApprovedBy`) — owner approves production activation.

**Approvals are recorded via ACTIONS, never raw timestamps.** The destinations API accepts `sandboxExitApproval` and `ownerApproval`, each `"approve"` or `"revoke"`:

- `"approve"` stamps `*_ApprovedAt = now()` and `*_ApprovedBy =` the authenticated CEO's id. The client **cannot** supply an arbitrary timestamp or actor — the request body is strict and any such field is rejected; approvals are always attributed to the acting session.
- `"revoke"` clears both the timestamp and the actor for that approval.
- omitting the field preserves the existing persisted value.

The service loads the existing row and applies these actions atomically, then validates the **resulting** row: attempting to `enabled=true` in `production` without BOTH approvals present in the resolved state is rejected with HTTP 400. Revoking either approval on an enabled production destination therefore cannot leave it enabled — the same request must also set `enabled=false`, or it is rejected. The worker independently re-checks both approvals in its execution gate and sets status `disabled` for any destination missing them. Do NOT claim sandbox-exit evidence that has not been observed.

### NoBull conflict winner

NoBull assignment is always the authoritative source. If ClickUp state drifts (someone edited the field directly in ClickUp), the projection worker re-projects on the next cycle and the drift is resolved in NoBull's favour.

### Kill switch

```sql
UPDATE system_settings SET value = 'false' WHERE key = 'clickup_role_projection';
```

Pauses all projection draining. Commands remain in `pending` and drain when the kill switch is cleared.

### Config route workflow

CEO uses the projection configuration routes to set up destinations and targets. These are operator-only API calls (no UI config editor in Phase 1 — the admin console is the persistent status and repair surface):

| Method | Path | Access | Purpose |
|---|---|---|---|
| `GET` | `/api/service-desk/role-projections/configuration` | CEO | List all destinations and targets |
| `PUT` | `/api/service-desk/role-projections/destinations` | CEO | Upsert a destination (dept+resp+env). Optional `sandboxExitApproval`/`ownerApproval` = `"approve"`/`"revoke"` record approvals (see Production approval gates). Strict body — unknown fields (e.g. raw approval timestamps) are rejected. |
| `PUT` | `/api/service-desk/role-projections/targets` | CEO | Upsert a client→target mapping |
| `GET` | `/api/service-desk/role-projections/status` | team-lead | Query command statuses (supports clientId/departmentId/responsibility/problemOnly/limit filters) |
| `POST` | `/api/service-desk/role-projections/resync` | team-lead | Reset a command to pending and kick worker |

### Rollout preflight: department, identity, and field contract

Before enabling any destination, record one row per active department and each
responsibility supported by its capability contract (Doer for all departments;
Checker only for explicitly approved department UUIDs):

1. Confirm whether the department is `company` or `per_client`, its supported
   responsibilities, active member roster, default holders, client overrides,
   and any genuinely unassigned slots.
   A role without an approved external destination must be deliberately marked
   **NoBull-only**; absence of configuration is not evidence that projection was
   verified. Retired responsibility values in historical rows are not active
   slots and must not receive a destination.
2. Resolve the NoBull holder to exactly one active `sd_department_members` row
   with a verified `clickup_user_id`. Distinguish:
   - missing NoBull↔ClickUp identity,
   - inactive/departed member,
   - duplicate or conflicting identity,
   - ClickUp member absent from the destination workspace, and
   - roster verification that is stale or could not run.
   **Never guess identity from an email address, display name, or username.**
3. From a fresh ClickUp read of the exact destination task, verify the owning
   list, exact People field ID, field type, and current member IDs. Do not infer a
   field from its label. A multi-person write must preserve unrelated IDs: remove
   only the exact prior projected ID and add only the verified desired ID.
4. For `client_list_parent`, verify every pilot client has one stable target task
   mapping. Missing or duplicate targets are configuration blockers, not empty
   assignments.
5. Record the pilot cohort, sandbox task/list IDs, disabled automations and
   notifications, approver, and observation window before enabling writes.

### Status-to-action operating guide

NoBull remains authoritative in every state. Never undo a NoBull assignment to
make an external status look healthy.

| Status / evidence | Meaning | Operator action |
|---|---|---|
| `pending` | Durable desired revision exists but is not yet verified remotely. | Inspect command revision, attempts/max attempts, `nextAttemptAt`, lease, matching `work_queue` wake, destination, desired ClickUp person, and current remote People IDs. Re-sync is unavailable; do not create a duplicate write. |
| `ambiguous` | A write may have succeeded, but read-back was unavailable. | Re-sync is unavailable. Let the scheduled retry read first; do not manually repeat the ClickUp mutation. Escalate only after the retry budget is exhausted. |
| `blocked` + `missing_identity` | NoBull holder has no verified ClickUp member ID. | Repair membership identity and re-sync. Never interpret it as a request to clear the People field. |
| `blocked` + target/field error | Client target, owning list, or People field contract is missing/mismatched. | Repair configuration, prove it with a fresh task read, then re-sync. |
| Retryable 429 / 5xx / timeout | ClickUp rate limit or outage. | Preserve NoBull truth; observe `nextAttemptAt` and token floor, and allow backoff. Pause the lane if continued retries would worsen the incident. |
| 401 / 403 | Company token, workspace access, or scope is invalid. | Pause projection, restore and probe the company connection, then resume. Do not re-sync commands while authorization is still broken. |
| `drift` | Fresh read-back differs from the desired NoBull value. | Confirm destination/identity is still correct; let the queued NoBull-wins repair run. Treat repeated drift as evidence for the deferred reconciliation decision. |
| `failed` / terminal | Non-retryable failure or retry budget exhausted. | Classify and document the error first; repair the dependency, then use Re-sync. Re-sync is not a substitute for diagnosis. |
| `disabled` | Destination or required approvals are off. | This is a safe paused state. NoBull assignments remain valid; enable only after the destination contract and approvals are re-verified. |
| `nobull_only` | The role intentionally has no ClickUp destination. | No action. It must remain visible in rollout inventory rather than being silently omitted. |

The Role Assignments console exposes error code, desired ClickUp person,
attempt/max-attempt count, next retry, and the Re-sync action only for terminal
`failed` or `blocked` rows with no lease. The server computes a bounded
`resyncEligible` flag and enforces the same policy: `pending`,
`drift`, `ambiguous`, and leased commands cannot have their status, counters, or
lease reset.
Check the exact command/status row again after repair; a successful HTTP response
from Re-sync is only an enqueue acknowledgement, not remote convergence.

### Safe disable and forward recovery

1. Set `clickup_role_projection` to `"false"` using the normal kill-switch
   control. Do not delete commands, destinations, targets, or NoBull assignments.
2. Confirm no new command leases appear and pending/ambiguous counts remain
   stable. In-flight work may finish at the current boundary.
3. Repair the credential, member identity, exact field, list ownership, or client
   target. Probe authorization and perform a read-only task/field check first.
4. Clear the kill switch. Existing due commands resume from durable wakes.
5. Use Re-sync only for terminal `failed` or `blocked` commands after confirming
   no lease remains. `pending`, `drift`, `ambiguous`, and nonterminal failures
   must resume through their durable worker path. Confirm `synced`, a fresh
   `verifiedAt`, and exact remote read-back before closing the incident.

Safe rollback disables the affected destination (and, for Paid Search, its
separate projection-write gate) before changing any read mode. Disabling
projection never changes Service Desk authority or Ads OS enrollment, status,
budget, grouping, or offboarding behavior.

### Current verification evidence

The operational inventory covers every active department, scope, eligible
roster, identity gap, default, client override, and supported responsibility.
It records each supported role as either an approved destination or explicitly
NoBull-only. Do not create inventory slots or destinations for retired
responsibilities.

Verification compares effective Doer and capability-approved Checker
assignments with their approved remote fields, requires zero unexplained problem
commands, and retains exact task/list/People-field/member IDs plus command and
approval audit evidence. Existing sandbox, outage, rate-limit, ambiguity,
dead-letter, kill-switch, and Re-sync evidence remains historical evidence and
must not be rewritten during contract cleanup.

The current dated evidence record is
[`audits/universal-role-rollout-verification-2026-08-21.md`](./audits/universal-role-rollout-verification-2026-08-21.md).
Production promotion must also explicitly close or accept the known
[`EXTERNAL_CALL_AUDIT.md`](./EXTERNAL_CALL_AUDIT.md) gap: projection calls are
redacted, but are not yet included in the external-call audit wrapper.
