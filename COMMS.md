# NoBull Comms — Operator Runbook

Operator reference for the full NoBull Comms subsystem: Slack-class real-time messaging with channels, DMs, threads, reactions, presence, voice/video calls (LiveKit), custom emoji, scheduled messages, incoming webhooks, slash commands, modifier-aware search, and member notifications.

Authoritative route inventory (all 50+ endpoints with HTTP method + path) lives in the header comment of `server/routes/comms.ts`. The parity gap tracker is `COMMS_PARITY.md`.

## Call lifecycle

- `POST /api/comms/channels/:id/calls` creates a `comms_calls` row (`status='active'`)
  with a unique `livekit_room_name` (`comms-<channelId>-<timestamp>`) and broadcasts a
  `comms:call status=started` SSE event.
- `POST /api/comms/calls/token` mints a room-scoped LiveKit JWT (channel members only,
  active calls only).
- `PATCH /api/comms/calls/:id` with `action: "end"` ends the call manually
  ("End for everyone"): sets `status='ended'`, `ended_at`, `duration_seconds`, posts a
  "Call ended" system summary message, and broadcasts `comms:call status=ended`.

## LiveKit room webhook — `POST /api/comms/webhook/livekit`

**Why it exists (Task #3132):** if every participant leaves without pressing
"End for everyone" (tab close, network drop), no client ever sends the manual end,
and the `comms_calls` row would stay `active` forever — the channel header would
permanently show "Join call". LiveKit fires a `room_finished` webhook when a room
empties; this endpoint closes the loop server-side.

### Behavior

1. Requires `LIVEKIT_API_KEY` + `LIVEKIT_API_SECRET` (503 if unset).
2. Verifies the request via the SDK's `WebhookReceiver` — LiveKit sends a signed JWT
   in the `Authorization` header embedding a sha256 hash of the raw body. Unverifiable
   requests get **401** (fail closed). There is no session auth on this route; the
   signature is the auth.
3. `room_finished` events: looks up the call by room name
   (`getCallByRoomName`); if it is still `active`, ends it via the same `endCall` +
   summary-message + `comms:call status=ended` SSE path as a manual end
   (`initiatedBy: "livekit_webhook"`). Already-ended or unknown rooms are an
   idempotent 200 no-op.
4. All other event types (`room_started`, `participant_joined`, …) are acknowledged
   with 200 and ignored.

### Implementation notes

- LiveKit posts with `Content-Type: application/webhook+json`, which the global
  `express.json` parser skips — the route mounts its own
  `express.raw({ type: "application/webhook+json" })` so the verifier gets the raw
  body string.
- The route is in `WEBHOOK_PATHS` (`server/routes/limiterMounts.ts`), so it uses the
  `webhook` rate-limit bucket and is exempt from the interactive `api` bucket.
- Shared finalization lives in `finalizeEndedCall()` in `server/routes/comms.ts` —
  manual end and the webhook cannot drift.

### LiveKit Cloud configuration

In LiveKit Cloud: **Settings → Webhooks → Create new webhook**, URL
`https://<deployed-host>/api/comms/webhook/livekit`, signing key = the same API key
the app uses (`LIVEKIT_API_KEY`). Use "Send a test event" to verify — a
`room_finished` test event for an unknown room should return 200.

### Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Channel header stuck on "Join call" after everyone left | Webhook not configured in LiveKit Cloud, or 401s (signing key ≠ `LIVEKIT_API_KEY`). Check logs for `[Comms] LiveKit webhook`. |
| Webhook returns 503 | `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` not set in that environment. |
| Webhook returns 401 | Signature verification failed — wrong signing key selected in LiveKit Cloud, or body was re-encoded by a proxy. |

## Call Recording

### Overview

Every call auto-records via LiveKit egress (MP4) if the transit S3 bucket is configured and the kill switch is ON. The recording flows through two stages:

1. **Transit stage** — LiveKit writes the MP4 to a caller-owned S3-compatible bucket as the room runs.
2. **Mirror stage** — after the room ends (`egress_ended` webhook), the server streams the MP4 from S3 into Replit private object storage under `comms_calls/{callId}/recording.mp4`.

Playback: `GET /api/comms/calls/:id/recording` — authenticated, channel-member gated; streams the MP4 directly to the browser.

### Kill switch

`livekit_recording_enabled` in `system_settings` (default **ON** when the row is absent). Off-tokens: `false`, `0`, `off`, `no`. Toggle via the CEO admin panel (`/admin/system-settings`).

### Transit S3 bucket env vars

| Env var | Required | Default | Notes |
| --- | --- | --- | --- |
| `LIVEKIT_RECORDING_S3_BUCKET` | **yes** | — | Bucket that receives the raw MP4 from LiveKit egress. |
| `LIVEKIT_RECORDING_S3_ACCESS_KEY` | **yes** | — | IAM access key ID with `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject` on the bucket. |
| `LIVEKIT_RECORDING_S3_SECRET_KEY` | **yes** | — | Paired IAM secret access key. |
| `LIVEKIT_RECORDING_S3_REGION` | no | `us-east-1` | AWS region of the bucket. |
| `LIVEKIT_RECORDING_S3_ENDPOINT` | no | — | S3-compatible endpoint (e.g. Cloudflare R2, MinIO). Omit for AWS. |

If any required var is missing, recording is skipped for that call (`recording_status = 'not_configured'`). The call proceeds normally.

### Recording status values (`comms_calls.recording_status`)

| Value | Meaning |
| --- | --- |
| `pending` | Room created with auto-egress; waiting for first participant to join. |
| `recording` | `egress_started` received; LiveKit is actively recording. |
| `completing` | `egress_ended` received; mirror in progress. |
| `completed` | MP4 mirrored to Replit private storage; playback available. |
| `failed` | Mirror or setup failed. Error is in `recording_error`. A system message is posted in the channel. |
| `not_configured` | Transit S3 bucket env vars not set; no recording attempted. |
| `disabled` | Kill switch tripped; no recording attempted. |

### Failure visibility

Recording failures are **loud**, not silent:
- A system message (⚠️) is posted to the channel with the error snippet.
- `recording_status` and `recording_error` columns are set on the call row.
- Operators can check `[Comms] Recording` lines in server logs.

### LiveKit Cloud configuration (recording)

In LiveKit Cloud > Settings > Webhooks, ensure the webhook URL includes the deployed host and is configured to send **egress** events in addition to room events.

### Troubleshooting (recording)

| Symptom | Likely cause |
| --- | --- |
| `recording_status = 'not_configured'` | Missing `LIVEKIT_RECORDING_S3_BUCKET` / `_ACCESS_KEY` / `_SECRET_KEY` env vars. |
| `recording_status = 'disabled'` | Kill switch `livekit_recording_enabled` is `false`/`0`/`off`/`no` in `system_settings`. |
| `recording_status = 'pending'` long after call ended | `egress_started` / `egress_ended` webhooks not reaching the server. Check LiveKit Cloud webhook config for egress event types. |
| `recording_status = 'failed'` with S3 error | IAM credentials wrong or bucket policy missing `s3:GetObject`. Check `recording_error` column and `[Comms] Recording mirror FAILED` logs. |
| `GET /api/comms/calls/:id/recording` returns 404 | Call recording not yet completed (status ≠ `completed`), or private object was deleted. |

---

## User Status Model

### Status values

`comms_user_statuses` holds one row per user (upserted). The `manualStatus` column is the operator-set value; `deriveEffectiveStatus()` applies presence to produce the final displayed status:

| Effective status | Condition |
| --- | --- |
| `online` | `manualStatus` is `"online"` AND heartbeat TTL not expired |
| `away` | `manualStatus` is `"online"` but heartbeat TTL expired |
| `dnd` | `manualStatus` is `"dnd"` (Do Not Disturb) AND `dndExpiresAt` is in the future (or null = permanent) |
| `offline` | `manualStatus` is `"offline"` or `"away"`, or no status row exists |

### Routes

| Route | Purpose |
| --- | --- |
| `GET /api/comms/status/me` | Own effective status + custom status; auto-expires DND / custom on read |
| `PUT /api/comms/status/me` | Set manual status (`online`/`away`/`dnd`/`offline`); optional `dndExpiresAt` for timed DND |
| `PUT /api/comms/status/custom` | Set custom status (emoji + text + optional `expiresAt`); saves to `recentCustomStatuses` (last 5) |
| `DELETE /api/comms/status/custom` | Clear custom status |
| `GET /api/comms/status/bulk?userIds=a,b,c` | Bulk effective-status lookup for the mention/DM picker |

### Broadcasts

Every status change emits a `comms:user_status` SSE event with `{ userId, effectiveStatus, manualStatus, customEmoji, customText, customExpiresAt, dndExpiresAt }`. The event fans out to all members of channels the user shares with others.

### Auto-away logic

When a presence heartbeat expires (> 35 s since last `POST /api/comms/presence/heartbeat`), the effective status transitions from `online` → `away` client-side. There is no server-side polling; the status route resolves the transition on next read.

---

## Scheduled Message Delivery

### Storage

`comms_scheduled_messages` holds `{ userId, channelId, parentId?, content, metadata, scheduledFor, status }`. Status values: `pending` → `sent` (success) or `failed` (delivery error).

### CRUD routes

| Route | Purpose |
| --- | --- |
| `POST /api/comms/channels/:id/scheduled-messages` | Create; `scheduledFor` must be in the future |
| `GET /api/comms/channels/:id/scheduled-messages` | List pending for a channel (member-gated) |
| `GET /api/comms/scheduled-messages` | List all own pending (cross-channel view, ScheduledMessagesPanel / AllScheduledMessagesPanel UI) |
| `PATCH /api/comms/scheduled-messages/:id` | Edit content or reschedule; own-only |
| `DELETE /api/comms/scheduled-messages/:id` | Cancel; own-only |

### Delivery worker

A recurring worker polls `comms_scheduled_messages WHERE status='pending' AND scheduled_for <= now()`. For each due message it calls the standard send path (including SSE broadcast + reaction/notification fan-out) then marks the row `sent`. Failed sends set `status='failed'` and a system message is posted.

---

## Incoming Webhooks

### Overview

Incoming webhooks let external systems post messages into a channel without a user session. Managed by team-lead+ users.

### Management routes

| Route | Auth | Purpose |
| --- | --- | --- |
| `POST /api/comms/webhooks` | team-lead+ | Create webhook (`{ channelId, name }`); returns `{ token }` (show once) |
| `GET /api/comms/webhooks` | team-lead+ | List all webhooks (tokens masked) |
| `DELETE /api/comms/webhooks/:id` | team-lead+ | Revoke |

### Posting a message

```
POST /api/comms/incoming/:token
Content-Type: application/json

{ "text": "Deployment complete", "username": "deploy-bot" }
```

- The `token` is the secret returned at creation time. No session auth — the token IS the credential.
- Optionally include `username` to override the display name.
- On success, the message is delivered via the normal SSE fan-out and appears in the channel immediately.
- Returns `200 { ok: true }` on success.
- `400` — token too short, missing `text`, or `text` exceeds 4 000 chars.
- `401` — token not found in DB or webhook has been revoked (`enabled = false`).
- `404` — the target channel was not found or is archived.
- `500` — internal DB lookup error.

### Security

Tokens are stored as SHA-256 hashes in `comms_incoming_webhooks`. The route re-hashes the provided token and does a DB lookup — raw tokens never persist after creation. Revoke by deleting the row (or setting `enabled = false`).

---

## Slash Commands

Built-in commands dispatched via `POST /api/comms/channels/:id/slash { command, args }`.

| Command | Effect |
| --- | --- |
| `/shrug` | Appends `¯\_(ツ)_/¯` to the message |
| `/me <text>` | Sends an italicised action message (e.g. _is in a meeting_) |
| `/away` | Sets status to `away` |
| `/online` | Sets status to `online` |
| `/dnd [minutes]` | Sets DND (optional duration in minutes; default = until manually cleared) |
| `/mute` | Mutes the current channel (sets `pref: muted`) |
| `/leave` | Removes the caller from the channel |
| `/help` | Returns the list of available commands |

The route returns `{ handled: true, message? }`. Unknown commands return `{ handled: false }`.

---

## Composer Formatting Preview & Compact Toolbar

The composer offers a live formatting preview (eye toggle) rendered via the shared `renderContent`, so the preview always matches how recipients see the message.

**Compact composers (deliberate decision):** thread reply boxes and docked popup windows render the composer with `compact` set. In compact mode the composer shows a **trimmed toolbar** — the formatting insertion buttons (bold / italic / inline code), the preview toggle, emoji, and send — and drops @channel, attach, and schedule-send to save horizontal space (those actions remain available in the full-view composer). Preview-only (no insertion buttons) was rejected because users composing formatted replies in threads/popups would see a preview with no way to insert markers except typing them by hand.

**Compact preview sizing:** in compact mode the preview panel uses tighter padding and is capped at `max-h-24` with internal scrolling, so a long preview scrolls instead of crowding the 380px popup body or the thread panel. The keyboard-hint footer line stays hidden in compact mode.

---

## Custom Emoji

### Storage

`comms_custom_emoji` holds `{ name, objectKey, createdBy }`. Names are unique, lowercase, and must match `/^[a-z0-9_+-]{1,64}$/`.

### Routes

| Route | Purpose |
| --- | --- |
| `POST /api/comms/emoji` (multipart) | Upload PNG/JPEG/GIF/WebP ≤ 256 KB; name must be unique |
| `GET /api/comms/emoji` | List all custom emoji (name + objectKey) |
| `GET /api/comms/emoji/:id/image` | Serve the image (auth-gated proxy to private object storage) |
| `DELETE /api/comms/emoji/:id` | Delete; own or team-lead+ |
| `GET /api/comms/emoji/autocomplete?q=` | Autocomplete ≥ 2 chars; used by composer `:query` trigger |
| `GET /api/comms/emoji/frequently-used` | Per-user most-used list (drives "Frequently Used" row in picker) |
| `POST /api/comms/emoji/usage` | Record emoji use (custom or standard); drives frequently-used list |

### In messages and reactions

The message renderer and reaction badges replace `:name:` tokens with `<img>` tags pointing to the auth'd image route. Standard Unicode emoji pass through unchanged. The emoji picker `custom` tab lists all custom emoji alongside the 8 standard categories.

**Skin-tone reaction pills (deliberate decision):** skin-tone variants of the same base emoji (👍, 👍🏻, 👍🏾) render as **separate reaction pills**, matching Slack. Each `user + emoji-string` is a distinct reaction row (verified in `tests/comms-custom-emoji.test.ts` §6), so counts never merge across variants and toggling one variant never touches another. Toned pills carry a tooltip (`reactionPillTitle` in `MessageItem.tsx`, backed by `baseEmojiOf`/`toneLabelOf` in `emojiSkinTone.ts`) that labels the variant, e.g. "👍 — Medium-Dark skin tone". Do **not** group variants into a single base pill — that would require per-user variant data on the wire and would break the "remove exactly what you added" toggle contract.

---

## Notification Resolution Order

When a message is sent, the system resolves whether to notify each channel member by walking this priority chain:

1. **Channel muted?** — if the member's channel pref is `muted`, skip. No notification regardless of mentions.
2. **@mention in message?** — if the message body mentions the user by `@username`, they always receive a notification (overrides `pref: mentions`).
3. **@channel / @here broadcast?** — all non-muted online (for `@here`) or all non-muted (for `@channel`) members receive a notification.
4. **Channel pref = `all`?** — every non-muted message triggers a notification.
5. **Channel pref = `mentions` (default)?** — only direct @mentions and broadcasts trigger a notification.

Notifications are delivered via `notifyUser()` (see [NOTIFICATIONS.md](./NOTIFICATIONS.md)), which fans out to the in-app inbox and, for users with a linked Slack DM, a forwarded Slack message.

### Keyword alerts

Not shipped. Personal keyword notification preferences (notify on specific words) are not yet implemented. See `COMMS_PARITY.md` gap #7.

### Do Not Disturb

When a user's effective status is `dnd`, the `notifyUser` call still creates the inbox notification row — the badge suppression is client-side (the DND indicator replaces the badge count in the UI). Server-side suppression during DND is not implemented.
