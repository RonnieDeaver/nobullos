# OpenAI

## Overview
OpenAI powers every AI-driven path in NoBull OS: market and seasonal-demand analysis on reports, agent matching and memory, account daily-judgment, communication analysis and summarization, ATS candidate assessment and interview analysis, audio transcription for calls and ATS video, and on-demand image generation. The integration is a soft dependency — most services degrade to a safe default if the API key is missing rather than crashing the pipeline.

## Architecture

### Where the client lives
- The SDK (`openai`) is instantiated per-service with:
  ```ts
  new OpenAI({
    apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
    baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
  });
  ```
  A shared instance is also exported from `server/routes/middleware.ts`.
- Credentials are provided by the Replit-managed `javascript_openai_ai_integrations` blueprint; do not roll a manual API client.

### Files that call OpenAI
| File | Purpose |
| --- | --- |
| `server/services/operationalClassifier.ts` | Operational-vs-client-related classifier for Slack/Front/Zoom traffic. |
| `server/services/callAnalysis.ts` | Whisper-style transcription + structured call analysis. Failure classification lives here — see [CALL_ANALYSIS.md](./CALL_ANALYSIS.md). |
| `server/services/callArchivePipeline.ts` | Transcribes archived Twilio/Zoom recordings. |
| `server/services/dailyJudgment.ts` | Daily AI account-health judgment. |
| `server/services/agentMatchingEngine.ts` | Semantic evaluation for the per-client matching agents. |
| `server/services/communicationAnalysis.ts` | Extracts intent and signals from raw communication rows. |
| `server/services/communicationEnrichment.ts` | Enriches threads with participants/context. |
| `server/services/conversationSummaryService.ts` | Thread summarization across email + SMS. |
| `server/services/atsIntelligence.ts` | Role-aware candidate assessment + question generation. |
| `server/services/atsInterviewAnalysis.ts` | Interview transcript scoring. |
| `server/routes/reports.ts` | Seasonal-demand and market-trend analysis for report sections. |

### Models in use
- `gpt-4o` — complex reasoning, ATS scoring, market analysis.
- `gpt-4o-mini` — default for classification, summarization, matching.
- `gpt-4o-mini-transcribe` — call/voicemail/ATS transcription.
- `gpt-image-1` — image generation.

## Settings, env vars, and kill switches

| Name | Type | Default | Purpose | Notes |
|---|---|---|---|---|
| `AI_INTEGRATIONS_OPENAI_API_KEY` | env (secret) | — | API key for every OpenAI call. | Replit-managed integration. If unset, AI services log a warning and return safe defaults. |
| `AI_INTEGRATIONS_OPENAI_BASE_URL` | env | OpenAI default | Optional base-URL override. | Only set when routing through a Replit-managed proxy. |

No dedicated `system_settings` kill switch for OpenAI itself. AI-driven *features* gate themselves via service-specific flags (see CALL_ANALYSIS / ZOOM / FRONT runbooks).

## Operational workflows

### Credential rotation
1. Update the Replit-managed integration secret (`AI_INTEGRATIONS_OPENAI_API_KEY`).
2. No process restart is required — each service reads the env var on next call.
3. Smoke-test by running a small AI-driven action (e.g. trigger one daily judgment, run one call-analysis job).

### Pause / disable
- There is no master kill switch. To stop AI consumption broadly: unset the API key (services will fall back to safe defaults) **or** pause the affected queues via [WORKERS_QUEUES_RUNBOOK.md](./WORKERS_QUEUES_RUNBOOK.md).
- For surgical pauses, use the per-feature flag (e.g. operational classifier confidence threshold, agent matching kill switches, daily judgment scheduler).

### Quota exhaustion
- 429s are retried with exponential backoff + jitter (`AI_RETRY_COUNT` is 2–3 in most services).
- Persistent 429s should: (a) pause the heaviest consumer queue (typically `call_analysis` or `front_webhook_apply`) via queue drain control; (b) wait for the quota window to reset; (c) resume.
- Track per-feature spend by inspecting `work_queue` throughput for AI-bearing queues. There is no first-party OpenAI cost dashboard wired into the app today.

### Recovery from common failures
- **Missing key** → services log a warning and return a neutral classification. No data corruption, but downstream features (matching, judgment, summaries) silently stop improving.
- **401 / invalid key** → rotate per "Credential rotation" above.
- **429 rate limit** → retried with backoff. Repeated 429s surface as queue backlog; see queue drain runbook.
- **5xx upstream** → retried, then the work-queue job is marked failed and retried by the scheduler.

## Alerts and observability
- AI-driven queues (`call_analysis`, `front_webhook_apply`, `zoom_meeting_apply`, etc.) surface via the standard backlog-alert pipeline — see [WORKERS_QUEUES_RUNBOOK.md](./WORKERS_QUEUES_RUNBOOK.md).
- Call-analysis failures (including OpenAI-side classification) are tracked in `call_analysis_jobs` — see [CALL_ANALYSIS.md](./CALL_ANALYSIS.md).
- Confidence thresholds (e.g. `OPERATIONAL_CONFIDENCE_THRESHOLD = 0.70`) cause low-confidence answers to be ignored or routed to human review rather than auto-applied.

## Verification
- Smoke test: trigger `dailyJudgment.runDailyJudgmentForClient(...)` for a small client and confirm a judgment row lands.
- Run one record through `operationalClassifier.classify(...)` and confirm `isOperational` is populated.
- Check `call_analysis_jobs` for recent `succeeded` rows in the last hour as a live-traffic health probe.

## Related runbooks
- [CALL_ANALYSIS.md](./CALL_ANALYSIS.md) — transcription-side OpenAI usage and typed failure classification.
- [TRANSCRIPTION_PROVIDERS.md](./TRANSCRIPTION_PROVIDERS.md) — Rev.ai / Rev.com fallbacks for transcription.
- [WORKERS_QUEUES_RUNBOOK.md](./WORKERS_QUEUES_RUNBOOK.md) — how to drain AI-bearing queues during quota incidents.
- Back to [RUNBOOKS.md](./RUNBOOKS.md) Runbook Index.

## Related Task # history
- AI agent memory + matching engine and ATS scoring features evolved across multiple tasks; consult `server/services/agentMatchingEngine.ts` and `server/services/ats*.ts` headers for Task # citations.
