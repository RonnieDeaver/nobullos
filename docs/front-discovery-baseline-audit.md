# Front Discovery and Baseline Audit

**Date:** 2026-04-14
**Task:** #287 (285A)
**Scope:** Read-only audit — no code changes made

---

## 1. Front Ingestion Paths

There are three distinct ingestion paths for Front data. All three share the same matching pipeline but differ in how conversations enter the system.

### 1A. Webhook Ingestion (Real-time)

| Item | Detail |
|------|--------|
| **Entry point** | `server/services/frontWebhookIngestion.ts:116` — `handleFrontWebhook()` |
| **Route** | `POST /api/integrations/front/webhook` (via `server/routes/integrations.ts:~299`) |
| **Trigger** | Front sends webhook events in real-time for every message/conversation event |
| **Gate flags** | `FRONT_EVENT_INGEST_ENABLED` (default: true), `FRONT_PIPELINE_FETCH_SPLIT_ENABLED` (default: true) |
| **Flow** | 1. `handleFrontWebhook()` → `ingestEvent()` (dedupe via composite key: `front:webhook:{convId}:{msgId}:{eventType}`) → 2. Enqueues `front_webhook_normalize` job (if `FRONT_PIPELINE_PROCESS_SPLIT_ENABLED`, else inline) → 3. `normalizeFrontWebhookEvent()` (L179) extracts participants, subject, body → 4. Enqueues `front_webhook_apply` job → 5. `applyFrontWebhookResult()` (L346) creates `raw_communication_records` entry |
| **Work queues** | `front_webhook_normalize` (workload: ingestion, priority: 50), `front_webhook_apply` (workload: ingestion, priority: 50) |

### 1B. Reconciliation (Polling/Catch-up)

| Item | Detail |
|------|--------|
| **Entry point** | `server/services/frontWebhookIngestion.ts:430` — `runFrontReconciliation()` |
| **Trigger** | Enqueued via work queue as `front_reconciliation` job (registered in `workQueueHandlers.ts:42`). No periodic `setInterval` timer found — must be triggered manually or by an external scheduler. |
| **Gate flags** | `FRONT_RECONCILIATION_ENABLED` (default: true), `FRONT_PIPELINE_FETCH_SPLIT_ENABLED` (default: true) |
| **Flow** | 1. Reads `front_reconciliation_cursor` from system settings → 2. Calls Front API `GET /conversations?limit={batchSize}&q[after]={cursorSeconds}` → 3. Pages through up to `MAX_PAGES` (hardcoded **5**) pages → 4. For each conversation: `ingestEvent()` with dedupe → enqueue `front_webhook_normalize` or inline normalize → 5. Advances cursor to max timestamp seen |
| **Cursor semantics** | See Section 2 below |

### 1C. Legacy Sync / Ingest Conversation (On-demand)

| Item | Detail |
|------|--------|
| **Entry point** | `server/services/frontIntegration.ts:374` — `ingestConversation()` |
| **Trigger** | Called from `applyMatchedConversation()` (L1936), manual match flow (L2041), retroactive reprocess (L1188-1189) — whenever a matched conversation needs its full data stored |
| **Flow** | 1. Hydrates conversation snapshot via `hydrateConversationSnapshot()` (calls Front API `GET /conversations/{id}` + `GET /conversations/{id}/messages`) → 2. Creates `raw_communication_records` entry with full message data → 3. Uses cutover guard to decide between pipeline and legacy path |
| **Gate flags** | `FRONT_PIPELINE_HYDRATE_ENABLED` (default: true), `FRONT_PIPELINE_APPLY_ENABLED` (default: true) |

There is **no standalone "full historical sync"** function that pages through all historical conversations. The legacy sync path is conversation-by-conversation and only fires when a match triggers ingestion.

---

## 2. Reconciliation Cursor Semantics

**Verdict: Forward-only. Cannot reach older history.**

### Proof

1. **Cursor storage** (`frontWebhookIngestion.ts:445-446`): The cursor is stored as `front_reconciliation_cursor` — a Unix timestamp (seconds). On each run, it reads the last cursor value.

2. **Query construction** (`frontWebhookIngestion.ts:456-460`):
   ```
   const afterSeconds = lastCursor ? Math.floor(lastCursor) : 0;
   let path: string | null = `/conversations?limit=${batchSize}`;
   if (afterSeconds > 0) {
     path += `&q[after]=${afterSeconds}`;
   }
   ```
   Key detail: `q[after]` is only appended when `afterSeconds > 0`. When the cursor is unset (first run), the request is simply `/conversations?limit=50` with **no time filter**. The Front API's default ordering for this endpoint determines which conversations are returned — this is API-dependent behavior (likely most recent first, based on Front API documentation conventions), **not proven from code alone**.

3. **Cursor advancement** (`frontWebhookIngestion.ts:504-505, 569-574`): `maxTimestamp` tracks the highest timestamp seen in the current batch. After processing, if `maxTimestamp > lastCursor`, it saves the new higher value. The cursor **only advances forward, never backward**.

4. **Page cap** (`frontWebhookIngestion.ts:449, 464`): `MAX_PAGES = 5` — hardcoded. With `FRONT_RECONCILIATION_BATCH_SIZE = 50` (configurable via env), maximum conversations per reconciliation run = **250** (5 × 50).

5. **Break conditions**: The loop breaks if:
   - `pageCount >= MAX_PAGES` (5 pages reached)
   - `conversations.length < batchSize` (last page)
   - API error
   - `path` is null (no next page)

### Bootstrap Behavior (Unset Cursor)

When the cursor has never been set:
- The first reconciliation call goes to `/conversations?limit=50` with **no `q[after]` filter**
- The Front API returns conversations in its default order (likely most recent activity first — **this is an external API behavior assumption, not proven from code**)
- After processing up to 250 conversations (5 pages), the cursor advances to the highest timestamp seen
- **Critical risk:** If the API returns recent conversations first, the cursor immediately jumps to a recent timestamp. All older conversations are permanently stranded — subsequent runs use `q[after]={recent_timestamp}` and only look forward from there.

### Implications for Historical Backfill

- **Forward-only after first run:** Once the cursor is set, reconciliation can never reach conversations older than the cursor timestamp.
- **Bootstrap gap:** If the API returns most-recent-first on the unfiltered first call, the cursor leaps to recent timestamps on the very first run, stranding all older history.
- **Ongoing gap with active cursor:** If the cursor was set months ago and thousands of conversations occurred since, reconciliation walks forward 250 per run but can never go backward.
- **No cursor reset mechanism:** There is no code path to reset the cursor to an earlier timestamp — only manual database intervention (`UPDATE system_settings SET value = '0' WHERE key = 'front_reconciliation_cursor'`).
- **Confidence note:** The exact bootstrap behavior depends on the Front API's default sort order for `GET /conversations` without a `q[after]` parameter. The code does not control this ordering.

---

## 3. Active Page/Fetch Caps

| Location | Cap | Value | Configurable? |
|----------|-----|-------|---------------|
| `frontWebhookIngestion.ts:449` | Reconciliation max pages | **5** | No (hardcoded) |
| `perfConfig.ts:66` | Reconciliation batch size | **50** | Yes (`FRONT_RECONCILIATION_BATCH_SIZE`) |
| `frontIntegration.ts:1397` | Rematch/reprocess chunk size | **100** | No (hardcoded) |
| `frontIntegration.ts:1606` | Rematch max items | **50,000** default | Yes (API param, capped at 100,000 in route) |
| `frontIntegration.ts:148` | API rate-limit retries | **5** | No (hardcoded) |
| `frontIntegration.ts:19` | API fetch timeout | **30s** | No (hardcoded) |
| `frontIntegration.ts:18` | API fetch retries | **3** | No (hardcoded) |
| `workQueueHandlers.ts:10` | Work queue chunk size | **500** | No (hardcoded) |
| `workQueueHandlers.ts:11` | Backfill batch size | **20** | No (hardcoded) |
| `agentMatchingEngine.ts:65` | Retroactive reprocess max | **50** | Yes (param) |

**Effective reconciliation throughput per run:** 5 pages × 50 conversations = **250 conversations max**.

---

## 4. Deterministic Matcher Data Sources

The deterministic matcher `matchConversationToClient()` (`frontIntegration.ts:844-980`) builds indexes via `buildMatchIndexes()` (L763-836) that check:

### Index Build Sources (buildMatchIndexes)

| Source | Data | Index Used |
|--------|------|------------|
| `client.contactEmail` (primary profile) | Email → `contactIndex` (source: `primary_contact`), domain → `domainIndex` | ✅ Already uses primary |
| `storage.getClientContacts(client.id)` | All `contact.emails[]` → `contactIndex` (source: `client_contacts`), domains → `domainIndex` | ✅ Already uses `client_contacts` |
| `contact.phones[]` | Phone (≥7 digits, normalized) → `contactIndex` with key `phone:{digits}` (source: `client_contacts_phone`) | ✅ Already uses phones |

### Match Cascade (matchConversationToClient)

1. **Exact email match** (L870-885): Unique email in `contactIndex` → confidence 1.0, `deterministic_unique_exact`. Shared email (multi-client) → skip.
2. **Exact phone match** (L897-913): Unique phone in `contactIndex` → confidence 1.0, `deterministic_unique_exact`. Shared phone → skip.
3. **Domain match** (L918-935): Unique domain in `domainIndex` → confidence 0.85, `domain`. Shared domain → skip.
4. **Heuristic fallback** (L937-973): Firm name keywords in subject/participant names → score 0.5-0.6, `heuristic`. Only accepted if ≥ 0.7 confidence (currently unreachable since max heuristic score is 0.6).

### Filters Applied

- Company emails excluded via `isCompanyEmail()`
- Public email domains excluded via `isPublicEmailDomain()`
- Company domains excluded via `isCompanyDomain()`
- Archived clients skipped
- **Cache TTL**: Index cached with `INDEX_CACHE_TTL_MS` (requires checking, likely short)

**Verdict:** The deterministic matcher **already uses `client_contacts` table emails, phones, and domains** in addition to primary client profile data. Domain matching is included at 0.85 confidence.

---

## 5. Agent Matcher Data Sources (evaluateCommunication)

The agent matcher (`agentMatchingEngine.ts:924-1085`) operates on `ClientAgentMemory` records. It checks:

### Structured Match (evaluateStructuredMatch, L697-817)

| Memory Type | What It Matches Against | Weight Multiplier |
|-------------|------------------------|-------------------|
| `email` | Participant emails | 1.0 |
| `domain` | Participant email domains | 0.8 |
| `phone` | Phone numbers in text content | 1.0 |
| `slack_channel` | `commData.channelId` | 1.0 |
| `slack_name` | `commData.channelName` (substring) | 0.7 |
| `keyword` | Word-boundary match in subject+content | 0.6 |
| `alias` | Word-boundary match in subject+content | 0.5 |
| `phrase` | Substring match in subject+content | 0.3 |
| `co_occurrence` | Signal cluster overlap (≥50%, ≥2 matches) | 0.8 |

### Semantic Match (semanticEvaluate, L830-922)

- Uses OpenAI `gpt-4o-mini` when structured score < confidence threshold
- Blends structured and semantic scores with configurable weight
- Capped at 0.75 if structured score < 0.05

### Claim Decision (L993-1016)

- **Confidence threshold**: Default 0.95 (env: `AGENT_CONFIDENCE_THRESHOLD`)
- **Ambiguity gap**: Default 0.15 (env: `AGENT_AMBIGUITY_GAP`)
- At lowered thresholds, requires `hasExactIdentifier` (email/domain/phone signal ≥ 0.3 weight) for claim
- Shadow metrics tracked at 0.85 threshold

### Learning on Claim (L1052-1081)

When `evaluateCommunication()` auto-claims, it **does learn**: creates/updates `co_occurrence` memory entries based on the signal cluster. This is passive co-occurrence tracking, not full `learnFromManualMatch`.

---

## 6. Batch Rematch Path (rematchAll)

**Location:** `frontIntegration.ts:1600-1770`

### Selection

- Iterates all `front_sync_emails` with match statuses in `frontSyncMatchStatuses` (includes unmatched, auto_matched, manually_matched, etc.)
- Ordered by cursor (`createdAt`, `id`) — walks chronologically
- Chunk size: 100 per DB query

### Match Application

- **Matches apply immediately** during iteration (L1706-1721) — `applyMatchedConversation()` is called inline
- If deterministic match found, agent matcher is skipped (L1670-1694)
- If agent matcher finds a better score than deterministic, agent result wins (L1680)

### Cursor / Checkpointing

- Resume support via `front_rematch_all_cursor` system setting (L1586)
- Cursor saved after each chunk (L1748-1754), not per-item
- On natural completion, cursor is cleared (L1763)
- Yields 200ms between chunks (`REPROCESS_YIELD_MS`)

### Learning During Rematch

- **`learnFromManualMatch` is NOT called** during rematch — the rematch flow only calls `matchConversationToClient()` + `evaluateCommunication()`
- However, `evaluateCommunication()` itself **does create `co_occurrence` memories** when it auto-claims (L1052-1081), and it also **writes `agent_match_decisions`** (L1034-1050)
- So rematch **does produce learning side-effects** through the agent engine's auto-claim co-occurrence tracking

### Work Queue Path (handleFrontRematchAll)

In `workQueueHandlers.ts:93-172`, the queue-based version uses a producer/consumer pattern:
1. Producer enumerates sync email IDs in chunks of 500
2. Dispatches batches of 20 IDs as `front_rematch_all` repair jobs
3. Consumer calls `rematchSyncEmailBatch()` for each batch

### Dry Run

- Supported (`dryRun: true`) — skips `applyMatchedConversation()` and cursor persistence

---

## 7. Role of `learnFromManualMatch`

**Location:** `agentMatchingEngine.ts:410-621`

### When It Fires

1. **Manual Front email assignment** (`frontIntegration.ts:2057-2070`): Called async (`setImmediate`-style IIFE) after `assignConversationToClient()` stores the manual match
2. **Zoom manual match** (`routes/integrations.ts:422`): Called directly in the route handler
3. **Slack manual match** (`routes/integrations.ts:469`): Called directly in the route handler
4. **Correction flow** (`agentMatchingEngine.ts:657`): Called via `learnFromCorrection()` for the correct client

### What It Seeds

From the communication data, it creates agent memories:
- **Participant emails** → `email` memories (weight 0.9), plus **domains** (weight 0.7)
- **Participant names** → `keyword` memories (weight 0.4)
- **Slack channel/name** → `slack_channel` (0.95) / `slack_name` (0.8)
- **Subject phrases** → `phrase` memories (weight 0.3)
- **Emails found in content body** → `email` memories (weight 0.7)
- **Phones found in content body** → `phone` memories (weight 0.6)
- **Repeated content keywords** → `keyword` memories (weight 0.25)
- **Firm name aliases** → `alias` memories (0.4-0.65)
- **Informal references** → `alias` memories (0.4)
- **Signal cluster co-occurrence** → `co_occurrence` memories (0.3, promoted at ≥3 occurrences)

### Whether Rematch Calls It

**No.** `rematchAll()` does NOT call `learnFromManualMatch()`. Only `evaluateCommunication()` is called, which has its own lighter co-occurrence tracking.

### Post-Learning Retroactive Reprocess

After `learnFromManualMatch()` completes (L607-618), if anything was learned, it fires `retroactiveReprocess()` via `setImmediate` — scanning up to 50 unmatched items for the client with the new memory.

---

## 8. Contamination / Trusted Seeding System (Task #286 Dependency)

### Current State

**`decontaminateAgentMemory()`** (`agentMatchingEngine.ts:1329-1370`):
- Scans all client agent memories
- Deletes entries where identifiers are company emails, company domains, or company-related names
- Has `dryRun` support
- Registered as `agent_decontamination` work queue job

**`seedAllAgentMemories()`** (`agentMatchingEngine.ts:398`):
- Seeds all active clients via `seedAgentMemoryForClient()`
- Called after decontamination in the `agent_decontamination` handler (L196)

**`seedAgentMemoryForClient()`** (`agentMatchingEngine.ts:255-396`):
- Seeds from: primary contact email/phone, firm name + aliases, client code, contact name, `client_contacts` table (emails + phones), Slack channel mappings, and previously matched communications

### Decontamination + Reseed Flow (workQueueHandlers.ts:175-198)

The `agent_decontamination` handler runs:
1. `decontaminateAgentMemory(true)` — dry run scan
2. `cleanupPoisonedMemory(true)` — operational filter dry run
3. If deletions needed: run both in live mode
4. `seedAllAgentMemories()` — full reseed

### Task #286 Verdict

**No dedicated "trusted seeding/rebuild" system from Task #286 is present in the codebase.** There are no references to `rebuildTrusted`, `trustedSeed`, or Task #286 in the code. The existing `decontaminateAgentMemory()` + `seedAllAgentMemories()` pipeline provides similar functionality but is:
- Not framed as a "trusted" vs "learned" distinction
- Seeds everything (including learned-from-match data) rather than isolating trusted sources
- Does not have a "rebuild only from verified sources" mode

**Dependency verdict:** Task #286's trusted seeding system is **not yet available**. The existing decontaminate-and-reseed pipeline can serve as a foundation but would need to be extended to distinguish trusted sources from learned data for a safe rematch.

---

## 9. Background Jobs That Could Conflict with Historical Backfill

### Periodic Jobs (started by `initAutoSync()` at L2111)

| Job | Interval | Queue Name | Conflict Risk |
|-----|----------|------------|---------------|
| Periodic spam cleanup | 15 min (`FRONT_SPAM_CLEANUP_INTERVAL_MS`) | `bulk_classify` | **Medium** — classifies unmatched emails, could dismiss items a backfill is trying to match |
| Periodic client matching | 10 min (`FRONT_CLIENT_MATCHING_INTERVAL_MS`) | `retroactive_reprocess` | **High** — runs `retroactiveReprocess()` for all clients, which evaluates and claims unmatched items. Would race with backfill matching. |

### On-Demand Jobs

| Job | Queue Name | Conflict Risk |
|-----|------------|---------------|
| Rematch all | `front_rematch_all` | **Critical** — only one allowed at a time (route checks `rematchJobs` map). A backfill that triggers rematch would conflict. |
| Reprocess dismissed | `front_sync_reprocess` | **High** — reprocesses dismissed items, would race with backfill. |
| Front reconciliation | `front_reconciliation` | **Medium** — if triggered concurrently, could advance the cursor past items the backfill cares about. |
| Agent decontamination | `agent_decontamination` | **High** — deletes and reseeds all agent memory mid-backfill, invalidating matching state. |
| Bulk classify | `bulk_classify` | **Medium** — could dismiss emails being processed by backfill. |

### Workload Concurrency Controls

- `workloadManager` provides slot-based concurrency via `withClassSlot()` / `awaitClassSlot()`
- `frontRematchAll` has its own workload class slot
- The repair dispatcher uses priority ordering and deduplication

### Recommendation for Backfill Safety

Before running a large historical backfill:
1. Pause periodic spam cleanup and client matching intervals
2. Ensure no `front_rematch_all` job is running
3. Avoid triggering `agent_decontamination` during the backfill
4. Consider pausing reconciliation to prevent cursor advancement conflicts

---

## 10. Baseline Metrics Snapshot

**Queried:** 2026-04-14, production database read replica

### Total Front Emails by Month

| Month | Count |
|-------|-------|
| 2026-03 | 1,516 |
| 2026-04 | 16,294 |
| **Total** | **17,810** |

**Historical gap analysis:** Data only exists from March 2026 onward. There is no email data prior to March 2026, confirming a significant historical gap. All history before the Front integration activation is missing.

### Match Status Breakdown

| Status | Count | Percentage |
|--------|-------|------------|
| `dismissed_operational` | 13,577 | 76.23% |
| `unmatched` | 3,374 | 18.94% |
| `auto_matched` | 854 | 4.80% |
| `blocked` | 5 | 0.03% |

**Notable:** Zero `manually_matched` or `dismissed_spam` entries exist. All matching has been automated.

### Match Rate for Non-Spam, Non-Operational Emails

| Metric | Value |
|--------|-------|
| Matched (auto + manual) | 854 |
| Non-spam, non-operational total | 4,233 |
| **Match rate** | **20.17%** |

### Unmatched Count

**3,374 emails** currently unmatched (18.94% of total).

### Clients with Zero Matched Communications

14 active clients have zero matched Front emails:

| Client |
|--------|
| Abogado Guerrero (Ivan Guerrero) |
| Adolphe Law Group |
| Doug Gaston |
| Example & Associates Law Firm |
| McGuinness Law |
| Meriwether & Tharp LLC |
| Paul Dombeck Law |
| Shields & Boris Law |
| Sintsirmas Law |
| Speedwell Law PLLC |
| The Estate Lawyer (Keith Morris) |
| The Hunter Law Firm, PLLC |
| Wagner Family Law |
| Wanta Thome |

### Cursor Positions

| Cursor Key | Value | Last Updated |
|------------|-------|--------------|
| `front_rematch_all_cursor` | `createdAt: 2026-03-31T23:12:29Z` | 2026-04-14 21:54 UTC |
| `front_reconciliation_cursor` | _(not set)_ | — |
| `front_reprocess_cursor_dismissed_operational` | _(not set)_ | — |

**Note:** The reconciliation cursor being unset means if reconciliation runs, the first request would be `/conversations?limit=50` with no `q[after]` parameter (see Section 2). The Front API's default ordering determines which conversations appear first. After the first run, the cursor jumps to the highest timestamp seen, potentially stranding older conversations permanently. Max 250 conversations per run.

---

## Summary of Key Findings

1. **Three ingestion paths exist:** webhook (real-time), reconciliation (forward-only polling), and on-demand conversation ingest. There is no historical backfill path.

2. **Reconciliation is forward-only** and capped at 250 conversations per run (5 pages × 50). It cannot reach older history — `q[after]` only looks forward from the cursor timestamp.

3. **The deterministic matcher already uses `client_contacts`** — emails, phones, and domains from both primary profiles and the contacts table are indexed.

4. **Rematch applies matches immediately** (not batched at end), and does produce learning side-effects via `evaluateCommunication()`'s co-occurrence tracking — but does NOT call `learnFromManualMatch()`.

5. **`learnFromManualMatch`** fires only on manual user assignments (Front, Slack, Zoom) and corrections. It seeds extensive memories and triggers a retroactive reprocess of up to 50 unmatched items.

6. **Task #286's trusted seeding system does not exist yet.** The existing `decontaminateAgentMemory()` + `seedAllAgentMemories()` provides a foundation but lacks trusted-vs-learned source distinction.

7. **Multiple background jobs could conflict** with a historical backfill — especially periodic client matching (every 10 min) and agent decontamination. These should be paused during any large-scale operation.

8. **Production baseline captured** (2026-04-14): 17,810 total emails (March–April 2026 only), 20.17% match rate for non-operational emails, 3,374 unmatched, 14 clients with zero matched comms. No data exists prior to March 2026.
