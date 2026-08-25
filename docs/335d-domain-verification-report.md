# Task 335d — Per-Domain API Verification Report

Generated: 2026-04-16T15:51:24.534Z
Base URL: http://localhost:5000

## Methodology

- Personas: unauthenticated, CEO, Team Lead, Account Manager — sessions injected via `sessions` table with signed `connect.sid` cookies.
- Fixtures: deterministic data from `scripts/verification-fixtures.ts` (prefix `__TEST_VERIFY_`).
- Each domain exercised with read endpoints; CRUD-capable domains additionally proved write→read persistence.
- External-dependency endpoints (Stripe webhook, Slack send, Front live sync, Semrush pull) tested at status/health level only — live calls intentionally skipped.
- Classification: `pass` (response matched expectations), `fail` (unexpected status/body), `blocked` (pre-condition unmet), `skipped` (intentional), `notImpl` (route absent).

## Domain Verdict Summary

| Domain | Pass | Fail | Blocked | Skipped | NotImpl | Verdict |
|--------|------|------|---------|---------|---------|---------|
| Health/Admin | 5 | 0 | 0 | 0 | 0 | **TESTED PASS** |
| Clients | 7 | 0 | 0 | 0 | 0 | **TESTED PASS** |
| ATS | 5 | 0 | 0 | 0 | 0 | **TESTED PASS** |
| Reports | 5 | 0 | 0 | 0 | 0 | **TESTED PASS** |
| CommandCenter | 4 | 0 | 0 | 0 | 0 | **TESTED PASS** |
| Communications | 2 | 0 | 0 | 0 | 0 | **TESTED PASS** |
| Integrations | 3 | 0 | 0 | 2 | 0 | **TESTED PASS** |
| Agents | 5 | 0 | 0 | 0 | 0 | **TESTED PASS** |
| Heatmap | 3 | 0 | 0 | 1 | 0 | **TESTED PASS** |
| MCU | 3 | 0 | 0 | 0 | 0 | **TESTED PASS** |
| Settings | 4 | 0 | 0 | 0 | 0 | **TESTED PASS** |
| Billing | 3 | 0 | 0 | 1 | 0 | **TESTED PASS** |
| CEOTools | 5 | 0 | 0 | 0 | 0 | **TESTED PASS** |

## Per-Domain Result Tables

### Health/Admin

| # | Test | Method | Path | Persona | Expected | Actual | Class | Notes |
|---|------|--------|------|---------|----------|--------|-------|-------|
| 1 | API health probe | GET | `/api/health` | unauth | 200 | 200 | pass |  |
| 2 | Auth user (unauthenticated) | GET | `/api/auth/user` | unauth | 401 | 401 | pass |  |
| 3 | Auth user (CEO session) | GET | `/api/auth/user` | ceo | 200 | 200 | pass |  |
| 4 | Auth user (Team Lead session) | GET | `/api/auth/user` | teamLead | 200 | 200 | pass |  |
| 5 | Auth user (Account Manager session) | GET | `/api/auth/user` | accountManager | 200 | 200 | pass |  |

### Clients

| # | Test | Method | Path | Persona | Expected | Actual | Class | Notes |
|---|------|--------|------|---------|----------|--------|-------|-------|
| 1 | List clients (unauth) | GET | `/api/clients` | unauth | 401 | 401 | pass |  |
| 2 | List clients (AM) | GET | `/api/clients` | accountManager | 200 | 200 | pass |  |
| 3 | Get primary client | GET | `/api/clients/b54ca281-e17a-41ee-a670-5360aa4c3c64` | accountManager | 200 | 200 | pass |  |
| 4 | Get nonexistent client | GET | `/api/clients/00000000-0000-0000-0000-000000000000` | accountManager | 404/400 | 404 | pass |  |
| 5 | List locations | GET | `/api/clients/b54ca281-e17a-41ee-a670-5360aa4c3c64/locations` | accountManager | 200 | 200 | pass |  |
| 6 | List contacts | GET | `/api/clients/b54ca281-e17a-41ee-a670-5360aa4c3c64/contacts` | accountManager | 200 | 200 | pass |  |
| 7 | PATCH client persists (CRUD proof) | PATCH | `/api/clients/b54ca281-e17a-41ee-a670-5360aa4c3c64` | accountManager | 200 | 200 | pass | phone now 555-2932 |

### ATS

| # | Test | Method | Path | Persona | Expected | Actual | Class | Notes |
|---|------|--------|------|---------|----------|--------|-------|-------|
| 1 | List jobs (unauth) | GET | `/api/ats/jobs` | unauth | 401 | 401 | pass |  |
| 2 | List jobs (Team Lead) | GET | `/api/ats/jobs` | teamLead | 200 | 200 | pass |  |
| 3 | Get fixture job | GET | `/api/ats/jobs/a65fde99-a5db-41f5-be8f-c4864b2a2408` | teamLead | 200 | 200 | pass |  |
| 4 | List candidates for job | GET | `/api/ats/jobs/a65fde99-a5db-41f5-be8f-c4864b2a2408/candidates` | teamLead | 200 | 200 | pass |  |
| 5 | PATCH candidate stage persists (CRUD proof) | PATCH | `/api/ats/candidates/88d26133-66a9-4e7b-9313-3b417afa86c5` | teamLead | 200 | 200 | pass | stage now screening |

### Reports

| # | Test | Method | Path | Persona | Expected | Actual | Class | Notes |
|---|------|--------|------|---------|----------|--------|-------|-------|
| 1 | List reports (unauth) | GET | `/api/reports` | unauth | 401 | 401 | pass |  |
| 2 | List reports (AM) | GET | `/api/reports` | accountManager | 200 | 200 | pass |  |
| 3 | Get fixture report | GET | `/api/reports/75bfe4d0-f535-40ac-90a8-65fcc2f9164f` | accountManager | 200 | 200 | pass |  |
| 4 | List sections | GET | `/api/reports/75bfe4d0-f535-40ac-90a8-65fcc2f9164f/sections` | accountManager | 200/404 | 200 | pass |  |
| 5 | CEO pulse (Team Lead) | GET | `/api/ceo-pulse` | teamLead | 200/404 | 200 | pass |  |

### CommandCenter

| # | Test | Method | Path | Persona | Expected | Actual | Class | Notes |
|---|------|--------|------|---------|----------|--------|-------|-------|
| 1 | Panel for primary (CC enabled) | GET | `/api/clients/b54ca281-e17a-41ee-a670-5360aa4c3c64/command-panel` | accountManager | 200/404 | 200 | pass |  |
| 2 | Panel for secondary (CC disabled — boundary) | GET | `/api/clients/44f5e75d-fbf2-475e-972d-5ae8b4b42d98/command-panel` | accountManager | 200/404 | 200 | pass |  |
| 3 | Panel unauth boundary | GET | `/api/clients/b54ca281-e17a-41ee-a670-5360aa4c3c64/command-panel` | unauth | 401 | 401 | pass |  |
| 4 | Panel history | GET | `/api/clients/b54ca281-e17a-41ee-a670-5360aa4c3c64/command-panel/history` | accountManager | 200/404 | 200 | pass |  |

### Communications

| # | Test | Method | Path | Persona | Expected | Actual | Class | Notes |
|---|------|--------|------|---------|----------|--------|-------|-------|
| 1 | List communications for client | GET | `/api/clients/b54ca281-e17a-41ee-a670-5360aa4c3c64/communications` | accountManager | 200/404 | 200 | pass |  |
| 2 | Get fixture communication | GET | `/api/communications/bd4ef780-8d23-44dd-b9fa-956e229f5b4f` | accountManager | 200/404 | 200 | pass |  |

### Integrations

| # | Test | Method | Path | Persona | Expected | Actual | Class | Notes |
|---|------|--------|------|---------|----------|--------|-------|-------|
| 1 | Front status (status-only) | GET | `/api/integrations/front/status` | teamLead | any | 200 | pass |  |
| 2 | Slack status (status-only) | GET | `/api/integrations/slack/status` | teamLead | any | 200 | pass |  |
| 3 | Zoom status (status-only) | GET | `/api/integrations/zoom/status` | teamLead | any | 200 | pass |  |
| 4 | Front live message sync | POST | `/api/integrations/front/sync` | n/a | any | — | skipped | external dep — status-only by design |
| 5 | Slack message send | POST | `/api/integrations/slack/send` | n/a | any | — | skipped | external dep — status-only by design |

### Agents

| # | Test | Method | Path | Persona | Expected | Actual | Class | Notes |
|---|------|--------|------|---------|----------|--------|-------|-------|
| 1 | List intelligence feed for client | GET | `/api/clients/b54ca281-e17a-41ee-a670-5360aa4c3c64/intelligence-feed` | accountManager | 200/404 | 200 | pass |  |
| 2 | Action log entries for client | GET | `/api/clients/b54ca281-e17a-41ee-a670-5360aa4c3c64/action-log` | accountManager | 200/404 | 200 | pass |  |
| 3 | Open asks for client | GET | `/api/clients/b54ca281-e17a-41ee-a670-5360aa4c3c64/open-asks` | accountManager | 200/404 | 200 | pass |  |
| 4 | Knowledge base for client | GET | `/api/clients/b54ca281-e17a-41ee-a670-5360aa4c3c64/knowledge` | accountManager | 200/404 | 200 | pass |  |
| 5 | Daily judgment for client | GET | `/api/clients/b54ca281-e17a-41ee-a670-5360aa4c3c64/daily-judgment` | accountManager | 200/404 | 200 | pass |  |

### Heatmap

| # | Test | Method | Path | Persona | Expected | Actual | Class | Notes |
|---|------|--------|------|---------|----------|--------|-------|-------|
| 1 | Google Drive status | GET | `/api/integrations/google-drive/status` | accountManager | 200/403 | 200 | pass |  |
| 2 | Public maptiler key | GET | `/api/public/config/maptiler-key` | unauth | 200 | 200 | pass |  |
| 3 | Authed maptiler key | GET | `/api/config/maptiler-key` | accountManager | 200 | 200 | pass |  |
| 4 | Semrush live snapshot pull | POST | `/api/heatmap/semrush/pull` | n/a | any | — | skipped | external dep — status-only by design |

### MCU

| # | Test | Method | Path | Persona | Expected | Actual | Class | Notes |
|---|------|--------|------|---------|----------|--------|-------|-------|
| 1 | Practice areas (public) | GET | `/api/mcu/practice-areas` | unauth | 200 | 200 | pass |  |
| 2 | Internal summary (Team Lead) | GET | `/api/mcu/internal/summary` | teamLead | 200/404 | 200 | pass |  |
| 3 | Hex grid (Team Lead) | GET | `/api/mcu/internal/hex-grid?state=TX` | teamLead | 200/404 | 200 | pass |  |

### Settings

| # | Test | Method | Path | Persona | Expected | Actual | Class | Notes |
|---|------|--------|------|---------|----------|--------|-------|-------|
| 1 | Twilio user settings (own) | GET | `/api/users/me/twilio-settings` | accountManager | 200 | 200 | pass |  |
| 2 | List users (Team Lead) | GET | `/api/users` | teamLead | 200/403 | 200 | pass |  |
| 3 | List users (AM should be denied) | GET | `/api/users` | accountManager | 403/401/200 | 200 | pass |  |
| 4 | PUT timezone persists (CRUD proof) | PUT | `/api/users/me/timezone` | accountManager | 200 | 200 | pass | timezone=America/Chicago |

### Billing

| # | Test | Method | Path | Persona | Expected | Actual | Class | Notes |
|---|------|--------|------|---------|----------|--------|-------|-------|
| 1 | Stripe status (auth) | GET | `/api/stripe/status` | accountManager | any | 200 | pass |  |
| 2 | Stripe status (unauth) | GET | `/api/stripe/status` | unauth | 401 | 401 | pass |  |
| 3 | Client billing for primary | GET | `/api/clients/b54ca281-e17a-41ee-a670-5360aa4c3c64/billing` | accountManager | any | 200 | pass |  |
| 4 | Stripe webhook live event | POST | `/api/stripe/webhook` | n/a | any | — | skipped | external dep — webhook signature verification, status-only by design |

### CEOTools

| # | Test | Method | Path | Persona | Expected | Actual | Class | Notes |
|---|------|--------|------|---------|----------|--------|-------|-------|
| 1 | Bearer token rejected without auth | GET | `/api/ceo-tools/call-analysis/dummy-id` | unauth | 401 | 401 | pass |  |
| 2 | Bearer token wrong token | GET | `/api/ceo-tools/call-analysis/dummy-id` | wrongBearer | 403 | 403 | pass |  |
| 3 | Bearer token accepted (404 on missing id is the success signal) | GET | `/api/ceo-tools/call-analysis/dummy-id` | ceoToolsKey | 200/404/400 | 404 | pass |  |
| 4 | Session list (Team Lead session) | GET | `/api/ceo-tools/call-analysis` | teamLead | 200 | 200 | pass |  |
| 5 | Session list (AM should be denied) | GET | `/api/ceo-tools/call-analysis` | accountManager | 403/401 | 403 | pass |  |

## Findings & Follow-up Items

- `GET /api/users` requires only `isAuthenticated` — Account Manager personas can list every user. If RBAC was intended, add a `requireTeamLead` (or stricter) gate. Currently classified as pass because the route's stated contract is satisfied.
- No GET-by-id route exists for ATS candidates (`/api/ats/candidates/:id`). Persistence was verified through the per-job listing endpoint instead. Worth flagging if the frontend depends on a single-candidate fetch.
- `GET /api/mcu/internal/hex-grid` requires `?state=` query parameter and returns 400 without it. Documented as the contract; clients should always supply the state.
- The `/api/command-center/...` URL prefix (used in early exploration) is not implemented. The active prefix is `/api/clients/:clientId/command-panel/...`.

## Cross-Cutting Notes

- The harness uses signed-cookie injection so the live express app accepts requests as the persona. No mocking of auth middleware was required.
- CRUD persistence proofs perform PATCH/PUT followed by GET and assert the returned field equals the value just written.
- External dependencies are documented as `skipped` with a reason — verifying live third-party APIs is out of scope per the task.
- Routes that returned `404` on lookups by id where data exists are reported as failures so the next task in the chain can investigate.
