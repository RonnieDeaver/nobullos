# Call Analysis — Failure Classification

Operator runbook for the `call_analysis_jobs` failure-classification system. Shipped under **Task #1049**; one-off backfill in **Task #1058**.

## Overview

Every failed `call_analysis_jobs` row gets a typed `failure_reason` so dashboards can group the failure mix instead of regexing free-text `error_message`.

## Failure reasons

`classifyFailure()` in `server/services/callAnalysis.ts` writes one of:

- `ffmpeg_timeout`
- `ffmpeg_invalid_audio`
- `whisper_timeout`
- `download_failed`
- `cpu_starved`
- `file_too_large`
- `unknown`

## Backfill — `scripts/backfill-call-analysis-failure-reasons.ts`

Rows that failed before Task #1049 deployed have NULL `failure_reason`. The one-off backfill re-runs `classifyFailure({ message: errorMessage })` against those rows and writes the reason.

- Default mode is **dry-run**; pass `--apply` to write.
- Idempotent — the WHERE clause filters `failure_reason IS NULL`, so re-runs only touch still-unclassified rows.

## Verification

```sql
-- Confirm no failed rows are left unclassified after a backfill --apply run:
SELECT count(*) FROM call_analysis_jobs
WHERE status = 'failed' AND failure_reason IS NULL;
-- expected: 0 once backfill has been applied
```

## Keywords / grep anchors

`call_analysis_jobs`, `failure_reason`, `classifyFailure`, `ffmpeg_timeout`, `ffmpeg_invalid_audio`, `whisper_timeout`, `download_failed`, `cpu_starved`, `file_too_large`, `backfill-call-analysis-failure-reasons`.

## Related Task # history

- **Task #1049** — call analysis slow lane + dynamic ffmpeg timeouts; introduced `failure_reason`.
- **Task #1058** — backfill failure reasons for the existing failed call-analysis jobs.

## Related runbooks

- [TWILIO_RECORDING_ARCHIVE.md](./TWILIO_RECORDING_ARCHIVE.md) — pipeline that feeds `call_analysis_jobs`.

## All-time failure audit (Task #1618)

- [`audits/twilio-failure-audit.md`](./audits/twilio-failure-audit.md) — all-time inventory of failed `call_analysis_jobs` with cluster analysis. As of 2026-05-19, 1,645 of 1,824 failed rows still have `failure_reason IS NULL` because the Task #1058 backfill has never been run against prod. The audit also proposes patterns for the 5 NULL-bucket leftovers (`Authentication timed out`, `timeout exceeded when trying to connect`, `Connection terminated due to connection timeout`, `Control plane request failed`, `ffmpeg exited with code 183 / 69`) that the current `classifyFailure` does not match.
- Idempotent re-queue (safely retryable reasons + audio still present): `tsx scripts/remediate-twilio-failures.ts --call-analysis` (dry-run by default; add `--apply` to write).
