# NoBull OS Service Desk Runbook

**Task #3056 — Foundation.** This runbook covers the Service Desk integration with ClickUp: ClickUp structure setup, config tables, department/request-type management, ticket read model, and the guided admin setup checklist.

ClickUp is the system of record. NoBull OS provides a simplified interface over the underlying ClickUp tasks, statuses, assignees, comments, and custom fields. NoBull OS does not duplicate ClickUp features; it exposes only the service-desk functions employees need.

---

## Architecture

```
ClickUp Space: "NoBull OS Service Desk"
└── Folder: "Internal Requests"
    └── List: "All Service Requests"          ← single list for ALL departments
        ├── Custom fields: Client, Department, Owner Dept, Request Type, Requester,
        │   Requested Date, Committed Date, Waiting Who/What/When
        └── 15 statuses (see list below)
```

**Single-List principle:** Department is a custom field — not a separate List. This means "change fulfilling department" is a field update, never a List move. This is required because ClickUp's API does not support moving tasks between Lists.

**NoBull-side tables** (all prefixed `sd_`):
| Table | Purpose |
| --- | --- |
| `sd_departments` | 10 seeded departments; manage active/inactive + sort order |
| `sd_department_members` | NoBull user ↔ department mapping; `clickup_user_id` for eligibility |
| `sd_request_types` | Request types per department (null = global) |
| `sd_list_mapping` | Singleton config: bound List ID + custom field UUIDs + dropdown option maps + form URLs |
| `sd_ticket_mapping` | Per-ClickUp-task NoBull state: client_id, requester, owner, department, read_at |

Department membership is the eligibility boundary for NoBull role assignment;
it is **not** by itself proof that a person is eligible for ClickUp projection.
Projection additionally requires one verified ClickUp member identity in the
destination workspace and an approved exact task/list/People-field contract.
Missing projection identity blocks only the outbound command—it never clears or
invalidates the NoBull assignment. See
[CLICKUP.md § Rollout preflight](./CLICKUP.md#rollout-preflight-department-identity-and-field-contract)
for identity-gap classes and safe repair.

---

## Setup Checklist

### Pre-step — Connect your own ClickUp account

Service Desk setup actions (including "Create ClickUp Structure") run on the **signed-in admin's own** ClickUp OAuth token, not a shared company token. Before running any setup step, go to your **Profile page** and connect your ClickUp account. If you see "ClickUp not connected" when clicking "Create ClickUp Structure", that means your personal account is not connected — the error links you to the Profile page.

The Integrations Hub ClickUp card and the Setup tab both show a pre-flight notice when you are not connected.

> **Note on OAuth app credentials:** Before anyone can connect, a workspace owner/admin must create the ClickUp OAuth app (ClickUp Workspace Settings → ClickUp API → "ClickUp API Settings" tab → Create an App) and add `CLICKUP_CLIENT_ID` and `CLICKUP_CLIENT_SECRET` to Replit Secrets. See [CLICKUP.md](./CLICKUP.md) for the full setup procedure.

### Step 1 — Create ClickUp Structure (automated)

Go to `/admin/service-desk` → Setup tab → enter your ClickUp Workspace ID → click "Create ClickUp Structure". This creates the Space, Folder, and List idempotently. The List ID is stored in `sd_list_mapping`.

### Step 2 — Add 15 Statuses (manual — no API)

In ClickUp, open the List → Settings → Statuses. Add each of the following:

1. Submitted
2. Scheduled
3. In Progress
4. Needs Information
5. Waiting on Account Manager
6. Waiting on Client
7. Waiting on Approval
8. Blocked
9. Quality Review
10. Delivered
11. Closed
12. Reopened
13. Out of Scope
14. Canceled
15. Duplicate

### Step 3 — Add 10 Custom Fields (manual — no API)

In ClickUp, open the List → Custom Fields. Add:

| Field Name | Type |
| --- | --- |
| Client | Dropdown or text |
| Department | Dropdown (one option per department) |
| Owner Department | Dropdown (department responsible for fulfillment) |
| Request Type | Dropdown (per-department options) |
| Requester | Text / email |
| Requested Completion Date | Date |
| Committed Completion Date | Date |
| Waiting On | Text (who the ticket is waiting on) |
| Action Needed | Text (what information/action is needed) |
| Response Needed By | Date (target response date) |

For the **Department** and **Request Type** dropdowns, note each option's UUID from the ClickUp API or UI. These go in `sd_list_mapping.department_option_ids` and `.request_type_option_ids` (jsonb maps: `{ "option-uuid": "department-id-or-rt-label", … }`).

For the **Client** field, use the **Field Mapping → Client Option Map** tab in NoBull after Step 4. Press "Sync client options" to auto-match by firm name and resolve any gaps manually. The map is stored in `sd_list_mapping.client_option_ids` (jsonb: `{ "clickup-option-uuid": "nobull-clients-id-uuid", … }`). A text-field Client is still supported as a fallback when no option map is configured.

### Step 4 — Bind Field UUIDs in NoBull

Go to `/admin/service-desk` → Field Mapping tab. Paste each custom field's UUID from ClickUp. Save.

To find a field UUID: ClickUp → List → Custom Fields → click a field → copy the ID (displayed in field settings or retrievable via `GET /v2/list/{listId}/field`).

### Step 5 — Create the ClickUp Form (manual — no API)

In ClickUp, open the List → Views → Add view → Form.

#### Required visible fields

| Field | Type | Notes |
| --- | --- | --- |
| Name | Text (built-in) | Task title — "Brief description of the request" |
| Description | Text (built-in) | Detail of what is needed and by when |
| Priority | Priority (built-in) | Urgent / High / Normal / Low |
| Department | Dropdown (custom) | Which team fulfills this request |
| Request Type | Dropdown (custom) | Category within the department |
| Requested Completion Date | Date (custom) | When the requester would like it done |

#### Hidden/prefilled fields (configure as hidden in the form)

| Field | Type | Prefill URL param | Notes |
| --- | --- | --- | --- |
| Requester | Email (custom) | `email` | NoBull injects the logged-in user's email automatically |
| Client | Text (custom) | `Client` | NoBull injects the client's firm name when opening from a client profile |

#### ClickUp Form prefill — how it works

ClickUp Forms accept URL query parameters that prefill hidden fields. The parameter name is the **field label** (URL-encoded). NoBull appends the following params to the embed URL when rendering the form:

| Query param | Value | Example |
| --- | --- | --- |
| `email` | Logged-in user's email address | `email=user%40example.com` |
| `name` | Logged-in user's full name | `name=Jane+Smith` |
| `Client` | Client's firm name (when opened from a client profile) | `Client=ACME+Corp` |

**Empirical prefill findings (verified 2026-07-17):**
- Hidden fields must be explicitly marked "Hidden" in the ClickUp Form editor, not just set as pre-filled, or ClickUp will render them as visible inputs.
- The URL param key must exactly match the field label (case-sensitive, space-for-space). A "Client" field needs `?Client=` not `?client=`.
- ClickUp ignores unknown query parameters silently — typos in param names fail silently.
- The `email` key works for ClickUp's native Email-type field AND for custom email-type fields named "Email". For a custom field named "Requester", use `?Requester=` with the email address as the value.
- Test prefill by opening the embed URL directly in a browser with the query params appended before publishing.

#### Form URLs

After creating the form, copy **two** URLs:
1. **Form URL** — the public ClickUp form link (e.g. `https://forms.clickup.com/…`). Paste into `/admin/service-desk` → Field Mapping → **Master Form URL**.
2. **Embed URL** — the embeddable version (e.g. `https://forms.clickup.com/…/f/…/embed`). Paste into `/admin/service-desk` → Field Mapping → **Master Form Embed URL**.

The NoBull service desk submission page (`/service-desk/create`) embeds the form in an iframe using the Embed URL with prefill params appended.

### Step 6 — Mark Setup Complete

In `/admin/service-desk` → Field Mapping → update `setupStep` to `complete`. The Setup tab's verify checklist confirms each step.

---

## Required Statuses Detail

| Status | When used |
| --- | --- |
| Submitted | Created and assigned; not yet reviewed |
| Scheduled | Owner reviewed; committed date set |
| In Progress | Owner actively working |
| Needs Information | Requester must supply info; still assigned to owner |
| Waiting on Account Manager | Owner needs AM to get info/approval/client decision |
| Waiting on Client | AM waiting for the client |
| Waiting on Approval | Work blocked pending an authorized approval |
| Blocked | Technical/vendor/access/operational blocker; must document what, who, next action |
| Quality Review | Work completed; under internal review |
| Delivered | Deliverable provided; awaiting requester confirmation |
| Closed | Requester confirmed complete, or auto-closed after review period |
| Reopened | Requester believes definition of done not satisfied; must explain what is incomplete |
| Out of Scope | Outside department responsibilities or contracted services |
| Canceled | Requester or authorized manager canceled |
| Duplicate | Duplicates another ticket; must link to original before closing |

---

## Requested Date vs. Committed Date

| Field | Set by | Meaning |
| --- | --- | --- |
| Requested Completion Date | Requester at submission | What the requester would like |
| Committed Completion Date | Fulfillment owner | What fulfillment has agreed to |

Changing the committed date to a later date requires a reason. A notification is sent to the requester when the committed date changes.

---

## Departments (seeded)

| # | Department |
| --- | --- |
| 1 | Google Ads |
| 2 | LSA |
| 3 | GBP |
| 4 | GHL & Automations |
| 5 | Web & Landing Pages |
| 6 | Reporting & Data |
| 7 | Intake |
| 8 | Account Management |
| 9 | Operations |
| 10 | Finance |

Departments are managed in `/admin/service-desk` → Departments tab. There are two removal levels:

1. **Deactivate (hide)** — the Active toggle flips `active = false`. The department disappears from submission filters and pickers, but every row (members, assignments, request types, ticket tags) stays in place. Fully reversible by toggling back.
2. **Permanent delete (guarded cascade)** — the trash button, shown only on inactive rows (deactivate-then-delete is the two-step safety; the API returns 409 for active departments). CEO-only. A confirmation dialog previews the exact impact (`GET /api/service-desk/departments/:id/delete-impact`), then `DELETE /api/service-desk/departments/:id` removes, in one transaction: the department, its member rows, its per-client role assignments, its department-scoped request types with their questions and checklist steps, and every ClickUp role-projection destination, target, and command for that department UUID. It also clears (not deletes) references elsewhere: tickets tagged with the department keep all history and stay searchable but lose the tag (`sd_ticket_mapping.department_id → NULL`), and checklist-step assignee-department overrides on surviving request types are NULLed so those steps fall back to the ticket's own department for role resolution. Global (department-less) request types, historical ticket events, and other departments' projection configuration are untouched. The deletion is audited in `admin_setting_audit` (`sd_department_hard_delete`) with the actor and cascade counts.

**ClickUp side is manual:** ClickUp's public API is read-only for dropdown options, so deleting a department here cannot remove its option from the ClickUp Department dropdown — remove the option in ClickUp's UI yourself. The delete removes the option's entry from `sd_list_mapping.department_option_ids`. “Import from ClickUp” is reconciliation-only: it may bind an option to a department that already exists in NoBull, but reports an unknown or stale-mapped remote option for review and never creates a department. A leftover ClickUp option therefore cannot resurrect a retired department.

### Retirement procedure

For a named retirement, resolve the exact display label to **one and only one**
department UUID before taking action; do not guess from a similar label. Open the
impact preview for that UUID, review the full counts (including projection
commands/targets/destinations), deactivate the department if it is still active,
then permanently delete it from that same preview. Record the returned audit ID
and re-open the preview: a successful repeat-safe retirement returns `404`
because the UUID no longer exists. Finally run the Department import once; any
leftover ClickUp option must appear as `unknown`, not as a newly created
department.

---

## Assignee Eligibility Rules

### Current role capability contract

Runtime assignment responsibilities are capability-based:

- Every active department supports **Doer**.
- **Checker** is available only for department UUIDs explicitly approved in
  `shared/departmentRoleCapabilities.ts` (currently Paid Search and GBP / Local
  SEO). Display names do not grant capability; a new or renamed department is
  Doer-only until its stable UUID is approved in that contract.
- The live assignment and role-projection APIs accept only `doer` and
  capability-approved `checker`. Retired role fields may remain in old rows or
  immutable audit history, but they are not effective assignments and cannot
  stage new projection commands.

A user is eligible for assignment to a department if ALL are true:
1. They are in `sd_department_members` for the selected department (`active = true`).
2. They have a ClickUp account connected via `clickup_user_tokens` (`status = 'connected'`), or a `clickup_user_id` is manually set on the `sd_department_members` row.

The API endpoint `GET /api/service-desk/eligibility/:departmentId` returns eligible users for use in the submission form's owner picker.

---

## Admin API Reference

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/api/service-desk/config` | authenticated | Get list mapping config |
| PUT | `/api/service-desk/config` | CEO | Upsert list mapping config |
| POST | `/api/service-desk/setup/create-structure` | CEO | Idempotent Space/Folder/List setup |
| GET | `/api/service-desk/setup/verify` | CEO | Verify setup checklist |
| GET | `/api/service-desk/departments` | authenticated | List departments |
| POST | `/api/service-desk/departments` | CEO | Create department |
| PUT | `/api/service-desk/departments/:id` | CEO | Update department |
| DELETE | `/api/service-desk/departments/:id` | CEO | Permanently delete department (inactive-only; guarded cascade, Task #4892) |
| GET | `/api/service-desk/departments/:id/delete-impact` | CEO | Preview permanent-delete cascade counts |
| GET | `/api/service-desk/departments/:id/members` | authenticated | List members |
| POST | `/api/service-desk/departments/:id/members` | CEO | Add member |
| PUT | `/api/service-desk/departments/:id/members/:memberId` | CEO | Update member |
| DELETE | `/api/service-desk/departments/:id/members/:memberId` | CEO | Remove member |
| GET | `/api/service-desk/request-types` | authenticated | List request types |
| POST | `/api/service-desk/request-types` | CEO | Create request type |
| PUT | `/api/service-desk/request-types/:id` | CEO | Update request type |
| DELETE | `/api/service-desk/request-types/:id` | CEO | Deactivate request type |
| GET | `/api/service-desk/eligibility/:departmentId` | authenticated | Eligible assignees for a department |
| GET | `/api/service-desk/tickets` | authenticated | Ticket read model (full list) |
| GET | `/api/service-desk/tickets/needs-mapping` | CEO | Tickets with incomplete NoBull mapping (no resolved requester or client) |
| GET | `/api/service-desk/tickets/:taskId` | authenticated | Single ticket |
| POST | `/api/service-desk/tickets/:taskId/mapping` | authenticated | Upsert NoBull ticket mapping |

---

## Ticket Read Model

`GET /api/service-desk/tickets` returns tasks from the mirrored `clickup_tasks` table where `list_id` = configured list, joined with `sd_ticket_mapping` for NoBull-side state. Custom field values are extracted from the `custom_fields` JSONB column using the stored field UUIDs.

The mirror is populated by the existing ClickUp webhook + sync workers (`clickup.ts` / `clickUpWorkerHandlers.ts`). Service Desk does not add new sync workers — it reads from the existing mirror.

### Native submission form

`POST /api/service-desk/tickets/submit` accepts multipart form data (via multer) and creates a ClickUp task directly from the NoBull UI. It:
- Requires the submitter to have ClickUp connected (`requiresClickUpConnection: true` if not).
- Sets the department, request type, and standard fields as ClickUp custom fields.
- Applies template checklist steps immediately on creation.
- Uploads attached files (images, PDFs, ≤10 MB each) to the ClickUp task.
- Inserts a local optimistic mirror in `clickup_tasks` + a `sd_ticket_mapping` row with `created_via_nobull = true` and `template_checklist_applied = true`.

The native form is at `/service-desk/submit` (public authenticated) and replaces the embedded ClickUp iframe form.

### Per-request-type templates

Each `sd_request_types` row can have:
- **`sd_request_type_questions`** — intake questions shown on the native form (label, fieldType, required, options, sortOrder). Types: `text`, `textarea`, `select`, `checkbox`.
- **`sd_request_type_checklist_steps`** — checklist items auto-applied to the ClickUp ticket (name, sortOrder).

Templates are managed in the ServiceDesk settings admin panel → Request Types → **Template** button (opens the `TemplateEditorDialog`).

API:
- `GET /api/service-desk/request-types/:id/questions`
- `POST /api/service-desk/request-types/:id/questions`
- `PUT /api/service-desk/questions/:id`
- `DELETE /api/service-desk/questions/:id`
- `GET /api/service-desk/request-types/:id/checklist-steps`
- `POST /api/service-desk/request-types/:id/checklist-steps`
- `PUT /api/service-desk/checklist-steps/:id`
- `DELETE /api/service-desk/checklist-steps/:id`

### Template enforcement in the webhook handler

After every `clickup_task_apply` upsert, `tryCompleteSdTicketMapping` now also:
1. **Checklist steps** — if `template_checklist_applied = false` and the ticket's request type has steps configured, creates a ClickUp checklist with all steps via `cu.createChecklist` + `cu.createChecklistItem`, then sets `template_checklist_applied = true`. If no steps are configured it marks the flag `true` immediately so the check is not repeated.
2. **Needs-info comment** — if `created_via_nobull = false` and `needs_info_notified = false` and the request type has required questions, posts a `[NoBull]` comment listing the required fields, then sets `needs_info_notified = true`.

Both paths are wrapped in a try/catch so a ClickUp API error does not fail the overall mapping upsert. Uses the first connected ClickUp user token found in `clickup_user_tokens`.

`sd_ticket_mapping` new columns: `template_checklist_applied` (bool, default false), `created_via_nobull` (bool, default false), `needs_info_notified` (bool, default false).

### Automatic post-webhook ticket mapping

After every `clickup_task_apply` job, the worker checks whether the task belongs to the bound service-desk list. If it does, it reads the task's custom fields and tries to:
1. Resolve the **Requester** email → NoBull `users.email` → set `sd_ticket_mapping.requester_user_id`.
2. Resolve the **Department** dropdown option UUID → `sd_list_mapping.department_option_ids` map → set `sd_ticket_mapping.department_id`.

This is idempotent: `ON CONFLICT DO UPDATE` only fills `NULL` columns — it never overwrites values set by manual admin edits. If the requester email has no matching NoBull user, the ticket appears in the `needs-mapping` surface.

### Needs-mapping surface

`GET /api/service-desk/tickets/needs-mapping` (CEO only) returns tickets where:
- `requester_user_id` is not set in `sd_ticket_mapping`, **or**
- No NoBull client record matches the Client custom field value (case-insensitive firm name lookup).

These are surfaced to admins for manual mapping via `POST /api/service-desk/tickets/:taskId/mapping`.

---

## Ticket Communication Policy

All follow-up communication on an existing request must stay on the same ticket. Employees must NOT create a new ticket to:
- Ask for clarification
- Request missing information
- Provide a status update
- Correct delivered work
- Revise a deadline

Instead: add a comment, mention the required person, change the status.

**A new ticket is appropriate when:**
- The request involves a different department and a separate deliverable
- The new work was not part of the original definition of done
- A completed request reveals a separate issue requiring new work

---

## Ticket Workflow (Task #3058)

### Status Map (15 statuses)

All status values are lowercase strings matching exactly what ClickUp stores.

| Status | Allowed next statuses |
| --- | --- |
| `submitted` | scheduled, canceled, duplicate |
| `scheduled` | in progress, needs information, canceled, duplicate, out of scope |
| `in progress` | needs information, waiting on account manager, waiting on client, waiting on approval, blocked, quality review, canceled |
| `needs information` | scheduled, in progress, canceled |
| `waiting on account manager` | scheduled, in progress, canceled |
| `waiting on client` | waiting on account manager, canceled |
| `waiting on approval` | scheduled, in progress, canceled |
| `blocked` | scheduled, in progress, canceled |
| `quality review` | delivered, in progress, canceled |
| `delivered` | closed (confirm-complete action), reopened (reopen action) |
| `closed` | reopened |
| `reopened` | scheduled, in progress |
| `out of scope` | *(terminal)* |
| `canceled` | *(terminal)* |
| `duplicate` | *(terminal)* |

### Transition Guards

| Condition | Guard |
| --- | --- |
| Entering `waiting on account manager`, `waiting on client`, `waiting on approval`, or `blocked` | `waitingWho`, `waitingWhat`, `waitingWhen` required in body — written to ClickUp custom fields |
| Marking as `duplicate` | `linkedTaskId` (original ticket) required — task link posted in ClickUp before status change |
| Moving committed date to a **later** date | `reason` text required — posted as system comment in ClickUp |
| Reopening (from `delivered` or `closed`) | `explanation` text required — posted as system comment |

### Write-through Sequence

All workflow actions use the **acting user's** ClickUp OAuth token (never the CEO token). The sequence for each action is:

1. Read current state from mirror (`clickup_tasks`)
2. Validate the guard (transition allowed, required fields present)
3. Write to ClickUp (status update, custom field sets, task links, system comment)
4. Update NoBull mirror optimistically (`clickup_tasks.status`, custom fields)
5. Insert event row in `sd_ticket_events` for audit trail
6. Return the re-resolved ticket

### Workflow API Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/service-desk/tickets/:taskId` | Load ticket (from mirror) |
| `GET` | `/api/service-desk/tickets/:taskId/allowed-transitions` | Returns `{ currentStatus, allowed: string[] }` |
| `GET` | `/api/service-desk/tickets/:taskId/events` | NoBull event log |
| `POST` | `/api/service-desk/tickets/:taskId/transition` | Status transition (guarded) |
| `POST` | `/api/service-desk/tickets/:taskId/reassign` | Single-owner reassignment |
| `POST` | `/api/service-desk/tickets/:taskId/change-department` | Department change (field + optional new owner) |
| `POST` | `/api/service-desk/tickets/:taskId/committed-date` | Set/change committed date |
| `POST` | `/api/service-desk/tickets/:taskId/confirm-complete` | Requester confirms delivery → `closed` |
| `POST` | `/api/service-desk/tickets/:taskId/reopen` | Requester reopens from `delivered` or `closed` |
| `POST` | `/api/service-desk/tickets/:taskId/mark-duplicate` | Mark as duplicate + link original ticket |

### Ticket Detail Page

Route: `/admin/service-desk/tickets/:taskId` (lazy-loaded `ServiceDeskTicketDetail`).

Panels:
- **Details**: client, request type, requester, assignees, requested date, committed date (with inline "change" trigger), waiting-on metadata when in a waiting/blocked status.
- **Actions**: context-sensitive — confirm complete (delivered only), reopen (delivered/closed), reassign, change department, mark duplicate, per-allowed-status transition buttons.
- **History**: chronological `sd_ticket_events` log with event label, reason/explanation excerpt, timestamp.

All action dialogs enforce the same guards as the server (required fields, reason for late dates, explanation for reopen).

### Event Log (`sd_ticket_events`)

NoBull-side audit log: one row per workflow action. Consumed by the views/notifications task (downstream). Not a ClickUp replacement — ClickUp system comments are the authoritative history; this table is for NoBull-side querying.

| `event_type` | Meaning |
| --- | --- |
| `status_transition` | Any `transition` action; `data.fromStatus`, `data.toStatus` |
| `reassignment` | `reassign` action; `data.fromOwnerUserId`, `data.toOwnerUserId` |
| `department_change` | `change-department` action; `data.newDepartmentId` |
| `committed_date_change` | `committed-date` action; `data.previousMs`, `data.newMs`, `data.isMovingLater` |
| `confirm_complete` | `confirm-complete` action |
| `reopen` | `reopen` action; `data.explanation` |
| `mark_duplicate` | `mark-duplicate` action; `data.linkedTaskId` |

---

## Home Page Views (`/admin/service-desk/home`)

`ServiceDeskHome.tsx` — nine view tabs with per-view badge counts:

| Tab key | Description |
| --- | --- |
| `my_submitted` | Tickets I submitted (as requester), non-terminal |
| `assigned_to_me` | Tickets I own, non-terminal |
| `waiting_on_me` | Ball is in my court: owner for AM/approval/blocked statuses; requester for "waiting on client" |
| `my_department` | Open tickets in any dept I belong to (via `sdDepartmentMembers`) |
| `due_today` | committedDate falls on today (UTC), non-terminal |
| `overdue` | committedDate < today (UTC), non-terminal — sorted oldest first |
| `recently_updated` | 50 most-recently-updated open tickets by `dateUpdated` |
| `delivered_for_review` | Status = "delivered" AND I am the requester — my pending sign-offs |
| `closed` | Terminal tickets (closed / canceled / duplicate / out of scope) |

Badge counts are served by `GET /api/service-desk/views/counts` (authenticated, no CEO gate). The main list query is `GET /api/service-desk/tickets?view=<key>`. Both apply the same `applyViewFilter` + `getUserDeptIds` helpers.

Additional filters: free-text search (name / client / type), status dropdown (statuses present in the current view), sort dropdown (newest / oldest / recently updated / committed date soonest or latest), and department dropdown are applied client-side within the returned view slice. Each row shows the status badge, ticket name, committed date, assignee(s), and links to the detail page. The page is reachable at both `/admin/service-desk/home` and `/admin/service-desk/tickets` (Task #3080).

### Additional API Endpoints (Task #3059)

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/service-desk/views/counts` | Badge counts for all 9 views (user-scoped) |
| `GET` | `/api/service-desk/tickets?view=<key>` | View-filtered ticket list |
| `GET` | `/api/service-desk/tickets?clientId=<id>` | Client-profile ticket section |

---

## Notifications (Task #3059)

`notifyUser` (category `service_desk`) is called **fire-and-forget** (`.catch(() => {})`) after each write completes. Events fired:

| Trigger | Recipient(s) | dedupeKey pattern |
| --- | --- | --- |
| Status → `delivered` | Requester | `sd_delivered_{taskId}` |
| Status → `waiting on client` | Requester | `sd_waiting_client_{taskId}_{ts}` |
| Reassign | New owner + requester (if different) | `sd_assigned_{taskId}_{userId}` / `sd_reassigned_requester_{taskId}_{ts}` |
| Committed-date change | Owner + requester (if not the actor) | `sd_committed_date_{taskId}_{newMs}` |
| Reopen | Current owner (if not the actor) | `sd_reopen_{taskId}_{ts}` |
| Any status transition (Task #3080) | Owner (if not the actor) | `sd_status_owner_{taskId}_{toStatus}_{ts}` |
| Confirm complete (Task #3080) | Owner (if not the actor) | `sd_confirmed_{taskId}` |
| Mark duplicate (Task #3080) | Owner (if not the actor) | `sd_status_owner_{taskId}_duplicate_{ts}` |
| Overdue sweep (scheduler) | Owner + requester, once per UTC day | `sd_overdue_{taskId}_{date}_{role}` |
| Auto-close (scheduler) | Requester | `sd_autoclose_{taskId}` |

---

## Scheduler — Overdue Sweep + Delivered Auto-close (Task #3059)

`server/services/sdScheduler.ts` — deployment-gated, advisory-lock singleton, 6-hour cadence.

Kill switch: `sd_scheduler_enabled` (default **OFF**). Stagger offset: `825_000 ms`.

Enqueues two jobs per tick:

| Job type | Handler | What it does |
| --- | --- | --- |
| `sd_overdue_sweep` | `handleSdOverdueSweep` | Walks open tickets, finds ones whose committedDate custom-field value is < today UTC, fires one `notifyUser` per UTC day (day-scoped dedupeKey) to owner + requester |
| `sd_delivered_autoclose` | `handleSdDeliveredAutoclose` | Finds tickets in `delivered` status whose `dateUpdated` is older than `sd_delivered_review_period_days` (default 3), closes them in ClickUp + mirror, inserts a `status_transition` event, notifies requester |

Setting `sd_delivered_review_period_days` (integer, stored in `system_settings`) controls the auto-close window; defaults to 3 days if the setting is absent.

Both handlers skip gracefully when the service desk list binding is not configured (`sdListMapping` empty).

---

## Kill Switches & Settings

| Key | Type | Default | Purpose |
| --- | --- | --- | --- |
| `sd_scheduler_enabled` | kill switch | **OFF** | Gates the overdue-sweep + auto-close scheduler |
| `sd_delivered_review_period_days` | system_setting | `3` | Days a ticket stays in "delivered" before auto-close |

---

## Future Tasks

| Task | Scope |
| --- | --- |
| Task #3057 | ✅ Service Desk submission form: `/service-desk/create` page with embedded ClickUp form, prefill (requester email + client name via URL params), guardrails chrome, post-webhook mapping, needs-mapping admin surface |
| Task #3058 | ✅ Ticket workflow: detail page, 15-status lifecycle with guarded transitions, committed-date slip reason, reassignment with history, waiting-on metadata, delivered→confirm→close loop, reopen with explanation, duplicate linking, write-through to ClickUp |
| Task #3059 | ✅ Home page views (9 tabs), badge counts, view-filtered list endpoint, clientId param, notification fan-out on 5 workflow events, overdue-sweep + delivered-auto-close scheduler |
| Task #3080 | ✅ Ticket list polish: `/admin/service-desk/tickets` route alias, status filter + date sort dropdowns, assignee column, owner notifications on status transitions / confirm-complete / mark-duplicate |
