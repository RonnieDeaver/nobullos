# TwelveLabs

## Overview
TwelveLabs powers advanced video understanding — indexing, semantic search, scene detection, and frame extraction — for video assets in NoBull OS. It is used for deeper analysis beyond what OpenAI transcription provides.

## Architecture

### Files
| File | Purpose |
| --- | --- |
| `server/services/videoAnalysis.ts` | TwelveLabs client + index/search/analyze helpers, webhook verification + idempotent completion apply, bounded fallback polling. |
| `server/routes/videoAnalysis.ts` | HTTP surfaces: upload, poll, analyze, search, extract frames, and the `POST /api/integrations/twelvelabs/webhook` receiver. |

### Models
- **Marengo** — embeddings / search.
- **Pegasus** — generative summarization / Q&A over video.

### Flow
1. Upload video bytes to TwelveLabs for indexing.
2. Wait for completion (Task #3972): with `TWELVELABS_WEBHOOK_SECRET` set, the dashboard-registered webhook delivers `index.task.ready` / `index.task.failed` and polling shrinks to a coarse fallback (60 s × 60 attempts); without it, the primary 10 s × 360 loop runs alone. Both paths share the same 1 h cap and a single idempotent terminal writer.
3. Run analysis (full summary, search across timestamps, scene detection).
4. For frame extraction at specific timestamps, the route uses `ffmpeg` locally on the cached video.

## Settings, env vars, and kill switches

| Name | Type | Default | Purpose |
|---|---|---|---|
| `TWELVELABS_API_KEY` | env (secret) | — | TwelveLabs REST credential. |
| `TWELVELABS_WEBHOOK_SECRET` | env (secret) | — | Signing secret from the TwelveLabs dashboard webhook page (Task #3972). Present → webhook completion + coarse fallback polling; absent → primary polling only and the receiver fails closed (503). Optional enablement, NOT a deploy prerequisite. |

No `system_settings` kill switch. Clearing the env vars disables the integration / webhook mode respectively.

## Operational workflows

### Webhook completion (Task #3972)
- Route: `POST /api/integrations/twelvelabs/webhook` — no session auth; listed in `WEBHOOK_PATHS` (`server/routes/limiterMounts.ts`) so it gets `webhookLimiter`.
- Registration is **account-wide on the TwelveLabs dashboard** (Playground → Webhooks): point it at `https://<prod domain>/api/integrations/twelvelabs/webhook`, copy the issued secret into `TWELVELABS_WEBHOOK_SECRET`, restart. The current v1.3 API has **no per-task `callback_url`** — correlation uses the in-memory taskId → job mapping written at submission.
- Verification: `TL-Signature: t=<unix seconds>,v1=<hex>` where `v1` = HMAC-SHA256(secret, `{t}.{rawBody}`) over the exact raw bytes; constant-time compare, then an inclusive 5-minute replay window on the HMAC-bound timestamp (Zoom / audit A-004 pattern). Bad signature/timestamp → 401; unconfigured → 503 (fail closed, every environment).
- Idempotent: repeated deliveries and the webhook-vs-poll race resolve to a single terminal write; unknown task ids are acknowledged no-ops (per-instance in-memory mapping — after a restart the vendor-side task finishes but no local job exists, which matches today's poll-based semantics).
- `ready` events perform one `tasks.retrieve` (payload omits the video id, and this re-confirms terminal state from the API). If the retrieve fails or disagrees, the job is left non-terminal for the fallback poller.
- Missed callbacks: the bounded fallback poller (60 s × 60, same 1 h cap) recovers them and exits early once a webhook lands the terminal state. Log lines carry `completed via webhook|poll` for attribution.

### Credential rotation
1. Generate new TwelveLabs API key.
2. Update `TWELVELABS_API_KEY`.
3. Smoke-test with one short upload.

### Pause / disable
- Unset `TWELVELABS_API_KEY`. Upload and analyze routes will return clear "not configured" errors.

### Recovery from common failures
- **Indexing stuck** → re-submit; very large or malformed files can fail silently. Confirm the source video plays before retry.
- **401** → rotate key.
- **`ffmpeg not found` on frame extraction** → confirm `ffmpeg` is installed in the runtime image.

## Alerts and observability
- No dedicated alerter. Failures surface on the video-analysis UI.

## Verification
- Upload a short test clip; expect `ready` within minutes and a non-empty summary on `analyze`.
- With webhook mode on, the completion log line should read `completed via webhook`; `via poll` means the callback was missed (check dashboard endpoint status) and the fallback covered it.
- Hermetic test suite: `npm test -- --file=tests/twelvelabs-webhook.test.ts`.

## Related runbooks
- Back to [RUNBOOKS.md](./RUNBOOKS.md) Runbook Index.

## Related Task # history
- See `server/services/videoAnalysis.ts` header for change history.
