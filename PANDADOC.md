# PandaDoc

## Overview
PandaDoc is NoBull OS's contract source. The integration lists documents, fetches per-document details, and extracts text content (fields, tokens, pricing tables) so contract data can flow into the client intelligence system.

## Architecture

### File
`server/services/pandadocIntegration.ts` — REST client against `https://api.pandadoc.com/public/v1`.

### Endpoints used
- `GET /documents` — list.
- `GET /documents/:id/details` — full structured detail (fallback for text extraction).
- `GET /documents/:id/content` — primary text extraction path; falls back to `/details` if it returns empty.

### Rate-limit handling
- Up to **5 retries** on 429 with backoff (Task #1572), specifically to avoid stack exhaustion under sustained throttling.

## Settings, env vars, and kill switches

| Name | Type | Default | Purpose |
|---|---|---|---|
| `pandadoc_api_key` | `system_settings` (secret) | — | API key. |

No env var override and no `system_settings` kill switch — clearing the API key disables the integration.

## Operational workflows

### Credential rotation
1. Generate a new key in PandaDoc.
2. Update `system_settings.pandadoc_api_key`.
3. Smoke-test by listing one document via the admin "Test PandaDoc" surface.

### Pause / disable
- Clear `pandadoc_api_key`. All PandaDoc calls return early.

### Recovery from common failures
- **401** → key invalid; rotate.
- **429** → retried; persistent 429 means PandaDoc has rate-limited the tenant. Reduce sync frequency or contact PandaDoc.
- **Empty text extraction** → confirm `/content` returned something; the integration auto-falls-back to `/details`, but a misconfigured template can still return empty text.

## Alerts and observability
- No dedicated alerter.
- Failures surface as missing/stale contract data on the client surfaces.

## Verification
- `GET /documents` from the admin tool returns a list.
- Pick one document, run text extraction, confirm non-empty text.

## Related runbooks
- Back to [RUNBOOKS.md](./RUNBOOKS.md) Runbook Index.

## Related Task # history
- Task #1572 — bounded 429 retries to prevent stack exhaustion.
