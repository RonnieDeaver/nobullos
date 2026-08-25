# Transcription Providers (Rev.ai + Rev.com)

## Overview
NoBull OS has three transcription paths:
1. **OpenAI** (`gpt-4o-mini-transcribe`) — default for call recordings and voicemail. See [OPENAI.md](./OPENAI.md) and [CALL_ANALYSIS.md](./CALL_ANALYSIS.md).
2. **Rev.ai** — async speech-to-text for ATS candidate video submissions.
3. **Rev.com** — optional fallback for call transcription when an operator supplies a Rev-produced transcript.

This runbook covers (2) and (3). OpenAI transcription is documented separately.

## Architecture

### Rev.ai — ATS video transcription
- **File:** `server/services/atsTranscription.ts`.
- **Endpoint:** `https://api.rev.ai/speechtotext/v1`.
- **Flow:**
  1. Download candidate video from object storage.
  2. Extract audio via `ffmpeg`.
  3. Submit job to Rev.ai; receive job ID.
  4. Poll job status until `transcribed` (or `failed`).
  5. Fetch transcript JSON; store with the candidate.

### Rev.com — optional call transcript injection
- **Used by:** `server/services/callAnalysis.ts` and `server/routes/ceoTools.ts`.
- **Flow:** If a call has a `rev_transcript_url` (often a Drive link) or `rev_transcript_json` provided out-of-band, the analysis pipeline parses that JSON directly and **skips** OpenAI transcription. The result of analysis is otherwise identical.

## Settings, env vars, and kill switches

| Name | Type | Default | Purpose | Notes |
|---|---|---|---|---|
| `REV_AI_API_TOKEN` | env (secret) | — | Rev.ai REST credential. | Required for ATS transcription. |
| `rev_transcript_url` / `rev_transcript_json` | per-row fields on the call | — | Operator-supplied Rev.com transcript. | When present, OpenAI transcription is skipped. |

No `system_settings` kill switch. Disabling Rev.ai means unsetting the env var (ATS transcription will then fall back to no transcript).

## Operational workflows

### Credential rotation
1. Generate a new Rev.ai token.
2. Update `REV_AI_API_TOKEN`.
3. Submit one ATS test video; confirm a transcript lands.

### Pause / disable
- **Rev.ai:** unset `REV_AI_API_TOKEN`. ATS submissions will queue but never transcribe; downstream ATS scoring degrades.
- **Rev.com:** stop providing `rev_transcript_url` / `rev_transcript_json` on call rows; OpenAI transcription resumes.

### Recovery from common failures
- **Rev.ai 401** → token invalid; rotate.
- **Rev.ai job stuck in `in_progress` too long** → re-submit; ffmpeg may have produced an unreadable file.
- **Rev.com JSON parse error** → confirm the URL is publicly readable (or that the Service Account can reach the Drive link) and that the JSON matches Rev's schema.

## Alerts and observability
- ATS transcription failures show up on the ATS admin surface for the affected submission.
- Call analysis failure classification (including transcription-source failures) lives in [CALL_ANALYSIS.md](./CALL_ANALYSIS.md).

## Verification
- Submit one short test video to ATS; expect `transcribed` status within a few minutes.
- For Rev.com fallback, attach a known-good Rev JSON to a call row and confirm `call_analysis_jobs` succeeds without invoking OpenAI transcription.

## Related runbooks
- [CALL_ANALYSIS.md](./CALL_ANALYSIS.md)
- [OPENAI.md](./OPENAI.md)
- Back to [RUNBOOKS.md](./RUNBOOKS.md) Runbook Index.

## Related Task # history
- See `server/services/atsTranscription.ts` and `server/services/callAnalysis.ts` headers for change history.
