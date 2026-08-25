# Twilio Recording Archive Pipeline

Operator runbook for the auto-archive of Twilio call recordings to object storage, OpenAI transcription, and in-app client-file delivery.

Migration: `0041_add_call_archive_pipeline.sql`.

## Overview

Every Twilio recording is auto-archived to private object storage, transcribed via OpenAI (`gpt-4o-mini-transcribe`, always-on), and — for matched calls — delivered into the client's **in-app files** (`Call Recordings` / `Call Transcripts` folders, linked on the call row via `client_file_recording_id` / `client_file_transcript_id`). The legacy Google Drive mirror and its `client_file_delivery_mode` lever were retired with the Drive integration (Task #4084). After a 7-day safety window the recording is deleted from Twilio; object storage stays the source of truth.

## Architecture

**Twilio purge:** After 7 days, the recording is deleted from Twilio. The audio proxy `GET /api/twilio/calls/:id/recording` prefers object storage.

**State machine:** `pending → queued → processing → done|failed|skipped` with bounded backoff (`1m / 5m / 15m / 30m / 1h / 2h`, max 6 attempts) and `FOR UPDATE SKIP LOCKED` claim.

**Scheduler:** Boots ~135 s after server start (offset by `WORKER_STAGGER_OFFSETS.call_analysis`).

## Settings, env vars, and kill switches

| Name | Type | Default | Purpose |
|---|---|---|---|

**In-app sink details (Task #4025/#4084):** matched calls only (unmatched calls have no client folder; their recordings stay in object storage and the admin review queue). Per-sink idempotency lives on the call row: `client_file_recording_saved_at` / `client_file_transcript_saved_at` gate re-writes, and `storeClientFile` additionally reuses same-name files inside the client's `Call Recordings` / `Call Transcripts` folders, so retries never duplicate. In-app failures classify as `archive_failure_reason = 'client_files_failed'`.

## Verification

- After a test call ends, the `call_analysis_jobs` row should walk `pending → queued → processing → done` within a few minutes.
- The recording should appear in private object storage; the audio proxy `GET /api/twilio/calls/:id/recording` should stream it.
- For a matched call, the recording + transcript should appear in the client's `Call Recordings` / `Call Transcripts` Drive subfolders. For an unmatched call (with the root folder configured) the same pair should appear under the unmatched root.
- Seven days after the call, Twilio's hosted recording is gone but the audio proxy still streams from object storage.

## Keywords / grep anchors

`call_analysis_jobs`, `unmatched_call_recordings_root_folder_id`, `unmatched_call_recordings_subfolder_id`, `unmatched_call_transcripts_subfolder_id`, `WORKER_STAGGER_OFFSETS.call_analysis`, `gpt-4o-mini-transcribe`, `0041_add_call_archive_pipeline.sql`, `Call Recordings`, `Call Transcripts`.

## Related runbooks

- [TWILIO.md](./TWILIO.md) — base Twilio configuration and call-recording compliance.
- [CALL_ANALYSIS.md](./CALL_ANALYSIS.md) — failure classification for transcription/analysis jobs in this pipeline.

## All-time failure audit (Task #1618)

- [`audits/twilio-failure-audit.md`](./audits/twilio-failure-audit.md) §4 — every `archive_status='failed'` row enumerated. Today all 5 prod failures share the same `archive_last_error` ("recording metadata not yet present"); the archive pipeline is doing exactly what it was designed to — the upstream call leg simply never produced a recording (byproduct of the historic E.164 send-time failures in §2/C-2). No archive-pipeline bug.
- Idempotent recovery: `tsx scripts/remediate-twilio-failures.ts --archive` — resets `processing` rows past the 30-min lock TTL, re-queues `failed` rows with transient-looking errors and attempts < MAX_ATTEMPTS, and (with Twilio creds present) marks rows `skipped` when Twilio also has no recording for the call SID. Dry-run by default.
