# Paid Search role sync — decision brief

**Status:** proposed design; no product, data, credential, or live ClickUp
change is approved by this brief.

**Decision:** Keep the ClickUp Client List authoritative. Add a small,
Ads-OS-specific, company-token write-through boundary for Paid Search role
fields. Do not make the generic per-user ClickUp mirror a second authority and
do not create a NoBull-to-ClickUp bidirectional sync.

## 1. Current state and the safe-edit gap

### What currently happens

1. Ads OS uses the rotatable **company** ClickUp token and reads Client List
   `901417549202`. It pages `GET /list/{listId}/task` with subtasks and closed
   tasks included.
2. A 10-minute, single-flight directory cache builds a live-parent client
   record: normalized client name → display name, **Doer**, **Checker**, and
   Client Log URL. A failed refresh backs off for 60 seconds and keeps serving
   the previous directory, while `clickup_live` becomes false. The stale
   threshold is 20 minutes.
3. The record is overlaid onto GAds, LSA, combined, AM, and client-profile
   views. It is also used for ClickUp alert-ticket context.
4. The generic ClickUp module is different: each NoBull user connects their
   own OAuth token; its local tables are a write-through workspace mirror.
   Generic task/custom-field routes are merely authenticated, not scoped to
   the Ads OS Client List or its role fields. Its webhook worker needs a
   per-user token, so it cannot reliably reconcile a company-token Client List
   update.

### Current source facts to preserve

| Concern | Current behavior that must remain unchanged |
| --- | --- |
| Enrollment and offboarding | Live Client List parents determine membership. An excluded/offboarded parent disappears from client blocks, but its known CIDs remain remembered so label fallback cannot resurrect it. |
| Duplicate behavior | Duplicate product/CID rows use existing deterministic rules; duplicate normalized parent names retain the first parent record for role display. This is **not** an edit-safe identity. |
| Status and budget | Client List status and budget remain source-of-truth, including blank/zero budget clears and existing status ranking. Role work must not rebuild or overwrite these fields. |
| Outages | Existing stale-serving, liveness banner, auth-dead alerting, and label fallback continue. A role edit must never report success from a stale read. |
| Google Ads | Ads OS remains read-only for Google Ads. This design writes only a ClickUp task custom field. |

### Why an edit is unsafe today

* The directory exposes display names only. It drops the parent ClickUp task
  ID, raw People IDs, task revision/timestamp, and duplicate-parent provenance.
* The parser renders only the first People value as username/email. It neither
  proves that a role field is single-person nor maps it to a NoBull user.
* The generic `setCustomFieldValue` helper has no Client List, field, target
  member, actor-role, conflict, or audit guard.
* Per-user OAuth identity records are useful evidence but are not a canonical
  Paid Search roster; a disconnected personal token must not erase a valid
  work identity.
* The existing generic webhook/reconciliation path is tied to an OAuth user and
  cannot apply company-token Client List events safely.

## 2. Business and access contract

### Proposed Paid Search meanings

| Slot | Meaning | ClickUp field today | Cardinality | Viewer/editor |
| --- | --- | --- | --- | --- |
| Doer | Primary person accountable for day-to-day Paid Search execution for the client. | `CLICKUP_DOER_FIELD_ID` (`21335dc5-98ba-470c-b8a9-944e3cfed343`) | **One person** | account_manager+ / CEO only |
| Checker | Independent person accountable for review/quality assurance of the Doer’s Paid Search work. | `CLICKUP_CHECKER_FIELD_ID` (`0bfb4a38-47e4-4343-bb83-051a9fd40122`) | **One person** | account_manager+ / CEO only |

The ClickUp API supports a People (`users`) field with multiple values, but the
existing reader renders only its first value. The proposed product contract is
therefore deliberately single-person per Doer and Checker. The first release
must refuse to edit a Client List row whose field metadata or current value is
not exactly this shape; it must not silently discard extra assignees.

### Account Manager is not a third assignment role

The screenshot label “Account Manager” does not establish another Client List
assignment field. In the current app, `account_manager` is a NoBull
authorization role, not a client assignment slot. For this feature:

* do not map “Account Manager” to an inferred assignment role;
* do not add an inferred third field;
* use “Doer” in the product until an owner approves a different label; and
* keep the supported assignment contract limited to Doer and Checker.

### Required owner approvals before implementation

1. Confirm the Doer/Checker meanings above and that both Client List People
   fields are intended to be one person, not a team.
2. Decide whether the screenshot’s “Account Manager” is merely a renamed Doer
   label or refers to a new, distinct field. If distinct, approve its ClickUp
   field and business semantics before any UI or schema work.
3. Approve **CEO-only** edits for the first release. This matches current Ads
   OS mutation policy. Lowering the edit gate to team lead or account manager is
   an authorization change and needs its own owner approval.
4. Approve the explicit Paid Search eligibility roster and the owner for
   resolving unmatched, departed, or guest ClickUp users.
5. Approve whether a company-token list webhook and its continuously available
   reconciliation backstop are wanted. They are not needed for safe v1 writes
   and introduce always-on integration load.

## 3. Authority-model decision

| Model | Advantages | Unacceptable or material cost | Result |
| --- | --- | --- | --- |
| **A. ClickUp-authoritative write-through** | Matches the Client List’s existing authority; preserves all enrollment/status/budget/offboarding rules; one authoritative current value; smallest extension; direct read-after-write makes timeout ambiguity recoverable. | ClickUp outage blocks edits; external edits can race a write; a separate identity roster and audit command record are needed. | **ADOPT NOW** |
| **B. NoBull-authoritative bidirectional sync** | Could offer faster local reads and a richer local assignment model. | Creates two editable authorities, conflict resolution, replay ordering, deletion/offboarding ambiguity, migration/backfill, and always-on reconciliation. It risks decoupling assignments from the Client List that currently defines enrollment. | **NOT JUSTIFIED** |
| **C. Reuse the generic ClickUp mirror as the Ads read/write model** | Reuses a task table, low-level field setter, and webhook infrastructure. | Uses the wrong credential scope and workspace access model; generic writes are insufficiently authorized; webhook jobs lack a company-token identity; mirror freshness is periodic and can race an optimistic update. | **NOT JUSTIFIED** |

The proposed implementation may reuse proven *primitives*—the company-token
accessor, ClickUp client HTTP adapter, People `{ add, rem }` payload convention,
workspace-member lookup, and existing audit infrastructure—but not the generic
mirror as an authority.

## 4. Target data and identity contract

### Stable identifiers

Never address a role edit by normalized client name or CID. The editor's read
model must carry:

```ts
type PaidSearchRoleSnapshot = {
  clientTaskId: string;                 // ClickUp parent task ID
  clientDisplayName: string;
  clientKey: string;                    // display-only routing key, not a write key
  clickupWorkspaceId: string;
  revision: {
    dateUpdated: string | null;         // ClickUp task timestamp if supplied
    doerUserIds: string[];
    checkerUserIds: string[];
  };
  roles: {
    doer: PaidSearchPerson | null;
    checker: PaidSearchPerson | null;
  };
  editability:
    | "ready"
    | "directory_stale"
    | "duplicate_parent"
    | "field_invalid"
    | "identity_unmapped"
    | "clickup_unavailable";
};

type PaidSearchPerson = {
  nobullUserId: string;
  clickupUserId: string;                // numeric ClickUp ID retained as a string
  displayName: string;
};
```

The directory can continue to serve its compact existing shape to old
consumers. A dedicated edit read model must retain the canonical parent ID,
all raw People IDs, and enough parent provenance to reject duplicate normalized
names rather than choosing a row silently.

The write target must also be proven from a **successful fresh Client List
enumeration**: the ID is a live, non-excluded parent returned for the configured
Client List, not merely a task that exists in the same workspace or happens to
carry fields with the same UUIDs. The implementation must define and test its
ClickUp Tasks-in-Multiple-Lists/home-list handling. A supplied task ID that
cannot be traced back to that fresh configured-list enumeration is never
editable.

### Identity and eligible-user roster

Create a narrow, explicit Paid Search identity mapping in a future task:

* `nobull_user_id` + `clickup_user_id` + canonical workspace ID is the stable
  key; email and username are display and matching aids only.
* A CEO-owned roster marks mappings active/inactive and records
  `last_verified_at`. It must be independently auditable.
* The initial candidate can come from the existing `clickup_user_tokens`
  identity field, but the target becomes eligible only after the company token
  verifies that its ClickUp ID is a current workspace member.
* A current personal OAuth connection is not required after verification; an
  operator must be able to keep a valid employee mapped even if they revoke
  their personal integration.
* An unmatched ClickUp People ID stays visible as “unmapped ClickUp user” and
  makes the row non-editable. Never guess from a duplicate email or username.

The existing Service Desk department membership mapping is evidence for
ClickUp-ID storage and member verification, but must not be adopted as the
Paid Search roster: department eligibility and Paid Search eligibility have
different meanings.

### Field definition and value shape

Before any edit, fetch the current parent task and validate that Doer and
Checker are applicable `users` fields whose IDs exactly equal the two existing
Ads OS configuration values. The implementation must read the current field
definition/value rather than trusting a cached client card.

The current in-repository ClickUp People-field convention is:

```json
{ "add": [12345], "rem": [67890] }
```

where values are ClickUp member IDs. For an approved single-person replacement,
remove the exact verified current ID and add the selected verified target ID.
For a clear, remove the current verified ID. Do not use an email as the field
value and do not use a broad field delete that could remove an unexpected
multi-person value.

## 5. User-facing edit and API contract

### Read and edit sequence

1. An account_manager+ user can view the compact assignment and its freshness
   state. The view may use the directory’s ordinary 10-minute cache but must
   label stale/unavailable information exactly as it does today.
2. A CEO opening **Edit roles** receives a direct, company-token parent-task
   read. It must finish within the existing ClickUp list deadline or fail
   closed. Target freshness is a successful direct read no older than
   **60 seconds** at submit.
3. The editor offers only the verified, active Paid Search roster. It shows
   missing/unmapped current people but cannot overwrite them until a CEO
   resolves the mapping.
4. The mutation accepts an immutable snapshot and an idempotency key:

```http
PATCH /api/ads-os/paid-search-roles/{clientTaskId}
Idempotency-Key: <UUID>

{
  "expected": {
    "dateUpdated": "…",
    "doerUserIds": ["…"],
    "checkerUserIds": ["…"]
  },
  "changes": {
    "doerClickupUserId": "…" | null,
    "checkerClickupUserId": "…" | null
  }
}
```

5. The server persists the command, validates CEO authorization, fresh
   configured-Client-List parent membership, live company-token configuration,
   exact configured field IDs/types, roster eligibility, and the 60-second
   snapshot age. It acquires an expiring, cross-instance command lease for the
   parent task in a short database operation; no database connection or
   transaction is held across a ClickUp call.
6. Under that lease, it performs one direct pre-read and compares the complete
   original snapshot. A changed timestamp or People-ID set returns `409
   stale_assignment` with the fresh snapshot; it never applies a stale edit.
7. It writes only fields that changed, serially. Each successful field write is
   read back and advances the command's working snapshot. Before the next field,
   another direct read must match that advanced snapshot; any other change
   returns an explicit partial/conflict result. This prevents a two-field
   command from rejecting its own first write while still detecting an
   intervening external edit.
8. After the final direct verification, it records the result and attempts one
   proof-mode in-process directory refresh. A refresh failure does not erase a
   verified ClickUp write: the response carries the verified roles plus
   `directory_refresh_pending: true` and the ClickUp health reason. The client
   updates its query cache from the direct verified state, shows the pending
   refresh state, then invalidates the display query for later convergence.

### Command serialization and idempotency

The command ledger has a unique key over `(actor_id, route_key,
idempotency_key)`, stores a hash of the immutable request, and retains the last
terminal response. The same key with the same hash returns or waits for that
command's result; the same key with a different hash is rejected. A second key
for the same parent waits for the bounded task lease and then revalidates the
fresh snapshot, or returns an explicit busy/conflict response.

The lease is durable, owner-tagged, renewable between steps, and carries a
monotonically increasing generation/fencing value recorded on the command.
Acquiring, renewing, and checking it uses short database operations only. Its
expiry must exceed the maximum bounded ClickUp request deadline plus a
documented clock-skew/scheduling margin. The owner renews and verifies its
generation immediately before every external read/write and stops before
issuing a call if ownership changed.

A takeover cannot begin merely because the lease timestamp passed. It waits
until the prior command's maximum in-flight vendor-call window plus margin has
elapsed, then direct-reads ClickUp and resolves the prior command as
verified/partial/ambiguous before admitting another mutation for that parent.
The fencing value prevents a resumed stale process from advancing local command
state or issuing another call, but it cannot fence a POST already accepted by
ClickUp. The protocol minimizes the overlap window; it does not claim
vendor-side serialization that ClickUp cannot enforce. ClickUp's later verified
state remains the conflict winner.

The command record and current verified working snapshot let a recovering
request tell which fields completed without replaying an ambiguous vendor
write.

### Error behavior

| Condition | Response and recovery |
| --- | --- |
| Missing company token, failed pre-read, 401, or stale directory **before a write begins** | No write; explicit `503`/`502`/`504` response with the existing ClickUp health reason. Current display remains marked stale; user retries only after a fresh read. |
| Field no longer applies/type changed, task is not a proven live parent in the configured Client List, duplicate parent, multi-person value, unmapped person, or inactive/non-member target | `422` with a safe reason. No automatic coercion. CEO corrects Client List/config/roster first. |
| External edit since snapshot | `409` with server-fetched values and a new revision. Operator chooses again; no automatic merge. |
| One of two field writes fails | `207`-style per-field outcome (or an equivalent explicit `partial` response) with a fresh verified snapshot. Keep the successful ClickUp write; do **not** compensate automatically. Retry only the failed field from that fresh state. |
| Timeout, 429, 5xx, or connection loss after a write is sent | Treat the write as potentially applied. Read the same parent task with the company token. If the desired field is present, record `verified_target_state` (not proof that this actor caused it); if not or the read also fails, record `ambiguous`. Never blindly replay the People-field POST. A fresh explicit retry starts from the observed snapshot. |
| Directory refresh fails after direct write verification | Return verified remote success with `directory_refresh_pending` and the health reason. Do not convert it to write failure or invite replay; normal directory reads converge later. |

ClickUp is the conflict winner: the latest verified ClickUp parent-task state is
what NoBull displays. The precondition closes the common stale-editor case but
cannot create a vendor-side compare-and-swap; a human/external ClickUp update
that lands after the pre-read is surfaced by read-after-write/reconciliation,
not overwritten by a background retry.

The existing generic ClickUp fetch helper recursively retries 429 responses for
all HTTP methods. The role-write adapter must **not** reuse that behavior
unchanged for People-field POSTs. Only reads receive bounded, deadline-aware
retry/backoff. A write is issued at most once per command step; every transport
ambiguity enters the read-back flow above.

## 6. Freshness, reconciliation, and rate limits

### Freshness targets

* **Display:** preserve the current directory TTL (10 minutes), stale threshold
  (20 minutes), stale serve, liveness banner, and current cache backoff.
* **Editor:** direct parent-task read at open and submit; a successful read must
  be no older than 60 seconds when accepted.
* **After a NoBull write:** direct read-after-write is the success authority;
  an in-process proof-mode directory refresh is then attempted. If it fails,
  return `directory_refresh_pending` without replaying the write.
* **External ClickUp edits:** ordinary Ads OS reads converge on the existing
  directory cadence. The initial release must state “may take up to the next
  directory refresh after an Ads OS read,” not promise a real-time push.

### Reconciliation decision

**ADOPT NOW:** direct write/read-after-write plus forced directory refresh. It
is sufficient to prevent a NoBull edit from showing a false success and needs
no new scheduler, webhook secret, or background queue.

**DEFER UNTIL a measurable trigger:** a list-scoped company-token webhook,
deduped targeted refresh worker, and bounded periodic fallback only when the
owner approves always-on integration load **and** measured external edits need
sub-10-minute visibility or manual refreshes exceed the agreed operating
threshold. Webhook processing must be durable, signature-verified, list scoped,
deduped, restart-safe, and paired with a reconciliation read because ClickUp
webhooks are token-owned and can stop when their creator loses access.

### Rate-limit and retry policy

ClickUp publishes per-token limits of 100 requests/minute for Free Forever,
Unlimited, and Business plans; 1,000 for Business Plus; and 10,000 for
Enterprise. A 429 includes `X-RateLimit-Limit`, `-Remaining`, and `-Reset`.
Design v1 for the 100-RPM floor:

* one opening read, one submit pre-read, one write plus one verification read
  per changed field, and one coalesced directory refresh;
* serialize writes per parent task with the durable cross-instance command
  lease; never hold a database transaction/session across the vendor call;
* use the reset header plus bounded exponential backoff for retryable reads,
  but never hide a 429 behind stale “saved” UI;
* issue each People-field write at most once and resolve 429/timeout/5xx
  ambiguity by read-back, not by recursively retrying the write;
* do not bulk-edit in v1; a future bulk action needs a separately approved
  per-token throttle, durable command ledger, and resumable outcomes;
* keep external calls outside database transactions and use the existing
  external-call observability boundary.

## 7. Audit evidence, outages, and rollback

Every attempted mutation needs a durable, append-only audit/command record:

* request/idempotency key; immutable request hash; command lease owner/expiry;
  NoBull actor ID and role; parent task ID; workspace; field IDs; old/new
  ClickUp user IDs; expected, working, and observed revision; timestamps; and
  outcome (`verified_success`, `verified_target_state`, `conflict`, `partial`,
  `ambiguous`, or `failed`);
* sanitized ClickUp HTTP/error class and correlation/request ID when supplied;
  never a token, raw authorization header, or unbounded vendor response;
* a linkable UI history entry showing who changed what and what ClickUp
  ultimately verified.

On an outage, viewing retains existing stale behavior but edits fail closed.
No local pending value becomes authoritative. On recovery, the next direct
read/normal directory refresh re-establishes ClickUp truth and resolves any
ambiguous command visibly.

Rollback is a feature kill switch or route/UI withdrawal that stops new writes;
it does **not** reverse prior ClickUp changes. Restoring an earlier assignment
is a fresh, audited, CEO-authorized ClickUp write with a fresh snapshot.

## 8. Dependency-ordered implementation backlog

| Order | Future task | Scope and acceptance evidence | Depends on |
| --- | --- | --- | --- |
| 1 | Owner contract and Client List field audit | Obtain the five approvals in §2; inspect actual Client List metadata without changing it; record the approved field IDs, single-person status, canonical workspace, “Account Manager” mapping, and paid-search roster owner. | None |
| 2 | Paid Search identity and edit-read foundation | Add the explicit NoBull↔ClickUp identity/eligibility mapping, company-token workspace-member verifier, parent task/provenance/raw-People edit read model, duplicate/multi-person safe failures, and durable audit-command schema. Stubbed tests cover unmapped, departed, duplicate, and field-type cases. | 1 |
| 3 | Authorized ClickUp-authoritative role write service | Add a CEO-only, validated, rate-limited mutation service/API; fresh configured-Client-List parent proof; generation-fenced durable task lease with bounded takeover; fingerprinted idempotency ledger; one-time serial per-field writes; advancing working revisions; read-after-write; partial/ambiguous outcomes; audit events; and non-fatal proof-mode directory refresh. Contract tests cover two-field success, concurrent duplicate keys across instances, takeover during an in-flight call, resumed stale owners, non-Client-List rejection, timeout/429/5xx after a sent write, external edits between fields, and partial failure without vendor egress. | 2 |
| 4 | Paid Search role editor | Add account_manager+ read-only presentation and CEO-only edit controls, explicit stale/outage/partial/conflict states, and optimistic cache update from only a verified server response. UI/accessibility tests cover each role and failure state. | 3 |
| 5 | Freshness reconciliation decision | Measure external-edit latency and manual refresh demand. If the trigger and owner approval in §6 are met, add a list-scoped, signed company-token webhook plus deduped targeted reconciliation and bounded fallback. Otherwise document the on-demand 10-minute model as the supported behavior. | 3 |
| 6 | Rollout and verification | Feature-flag rollout to a small CEO cohort; compare ClickUp task field values, directory cards, and audit records; exercise safe disable/rollback; publish an operator runbook and verify neither enrollment/status/budget/offboarding nor Google Ads mutation guard changed. | 4, and 5 only if approved |

## 9. Research evidence

### Repository sources

* `server/services/adsOs/clickUpDirectory.ts` — directory inputs, two current
  field IDs, parent parsing, cache/liveness/stale semantics, and display-only
  People extraction.
* `server/services/adsOs/config.ts` — Client List and existing Doer/Checker
  configuration; no third assignment field.
* `server/services/clickUpClient.ts` and `server/routes/clickup.ts` — generic
  field setter and per-user routes/webhook path.
* `shared/models/clickup.ts` and `shared/models/serviceDesk.ts` — per-user
  OAuth identity/mirror and the separate Service Desk identity pattern.
* `server/routes/serviceDesk/helpers.ts` — current company-token
  workspace-member verification pattern.
* `server/routes/adsOs.ts`, `server/routes/middleware.ts`, and `ADS_OS.md` —
  current account_manager+ view/CEO mutation policy and Google Ads read-only
  guard.
* Related task records consulted: `.local/tasks/client-role-assignments.md`,
  `.local/tasks/role-assignments-console.md`,
  `.local/tasks/ads-os-view-access.md`, and
  `.local/tasks/ads-os-six-post-snapshot-updates.md`.

### Current external ClickUp references

* [Set Custom Field Value](https://developer.clickup.com/reference/setcustomfieldvalue) —
  requires the task ID and applicable field UUID; a non-applicable field returns
  400.
* [Custom Fields](https://developer.clickup.com/docs/customfields) — People is
  the `users` custom-field type.
* [Rate Limits](https://developer.clickup.com/docs/rate-limits) — current
  per-token limits, 429 behavior, and rate-limit headers.
* [Webhooks](https://developer.clickup.com/docs/webhooks) — task update events,
  webhook ownership, list scoping, and shared-secret signing.
