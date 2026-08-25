# Twilio Voicemail

Operator runbook for inbound voicemail. Shipped under **Task #852**. Migration: `0055_add_twilio_voicemail_fields.sql`.

## Overview

When an inbound call exhausts its routing chain (no users available or all attempts declined), the routing-callback returns voicemail TwiML instead of the IVR. The caller records a message; we transcribe it, render it in the Conversation Hub, and track listened-state.

## Architecture

**TwiML returned by the routing callback when the chain is exhausted:**

- `<Say>` of `system_settings.twilio_voicemail_greeting`.
- `<Record maxLength=180 finishOnKey=# transcribe=true playBeep=true trim=trim-silence>`.

**Webhooks:**

- `/api/twilio/webhooks/voicemail-recording-status` — writes `voicemail_recording_sid`, `voicemail_recording_url`, `voicemail_recording_duration` onto `twilio_calls`.
- `/api/twilio/webhooks/voicemail-transcription` — writes `voicemail_transcription_text`, `voicemail_transcription_status` onto `twilio_calls`.

**Audio proxy:** `GET /api/twilio/calls/:id/voicemail-recording` — same SSRF-guarded Twilio basic-auth proxy used by the regular call-recording stream.

**Listened-state:** `POST /api/twilio/calls/:id/voicemail/listened` stamps `voicemail_listened_at`. Triggered by pressing play or the explicit "Mark as listened" button.

## UI surfaces

- The Conversation Hub renders inbound-with-voicemail calls as a distinct burgundy "Voicemail" card with audio player + transcript.
- Inbox badge: burgundy "VM N" badge for unheard voicemails per thread.
- Inbox filter: **Voicemails** chip surfaces threads with `unheardVoicemailCount > 0`.

## Settings, env vars, and kill switches

| Name | Type | Default | Purpose |
|---|---|---|---|
| `twilio_voicemail_greeting` | `system_settings` | (admin-configured) | `<Say>` text played before `<Record>`. |

No kill switch — voicemail is intrinsic to the routing fallback.

## Verification

- Call an inbound DID and let it ring through to the end of the routing chain. Confirm the voicemail greeting plays and the `<Record>` beep is audible.
- After leaving a message, check the corresponding `twilio_calls` row has `voicemail_recording_sid`, `voicemail_recording_url`, `voicemail_recording_duration` populated within ~30 s; `voicemail_transcription_text` populated within ~2 min.
- Open the Conversation Hub — the burgundy "Voicemail" card should render with audio + transcript; the inbox should show a "VM 1" badge and the Voicemails filter chip should surface the thread.

## Keywords / grep anchors

`twilio_voicemail_greeting`, `voicemail_recording_sid`, `voicemail_recording_url`, `voicemail_transcription_text`, `voicemail_listened_at`, `/api/twilio/webhooks/voicemail-recording-status`, `/api/twilio/webhooks/voicemail-transcription`, `/api/twilio/calls/:id/voicemail-recording`, `/api/twilio/calls/:id/voicemail/listened`, `0055_add_twilio_voicemail_fields.sql`.

## Related runbooks

- [TWILIO.md](./TWILIO.md) — base Twilio configuration and call-recording compliance.
- [TWILIO_RECORDING_ARCHIVE.md](./TWILIO_RECORDING_ARCHIVE.md) — covers the parallel pipeline for regular (non-voicemail) call recordings.

## All-time failure audit (Task #1618)

- [`audits/twilio-failure-audit.md`](./audits/twilio-failure-audit.md) §5 — voicemail surface is empty in prod today (no rows with `voicemail_recording_url` populated yet).
- Future failures: `tsx scripts/remediate-twilio-failures.ts --voicemail` re-pulls `client.recordings(sid).transcriptions.list()` for rows in `voicemail_transcription_status='failed'` whose `voicemail_recording_url` is still present, and persists the text if Twilio now has a finished transcription. Dry-run by default.
