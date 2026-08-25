# Per-User Notification System (Task #1686 / #1687 / #1688)

The per-user inbox is the in-app **bell + dropdown + `/notifications`**
surface. Every event source writes through a single helper —
`notifyUser()` in `server/services/notifications/userInbox.ts` — which
owns persistence, dedupe, SSE broadcast, and (Phase 2) Slack-DM
mirroring.

This document covers **Phase 3**: the event sources that produce inbox
rows, the recipient helpers they rely on, and the contract every source
must honor.

## Hard rule for event sources

> An event source ONLY resolves recipients and calls `notifyUser`.
> It must never:
>   - insert into `user_notifications` directly,
>   - broadcast `notification:*` SSE events itself,
>   - call Slack APIs to DM a user.
>
> Those concerns belong to `notifyUser()` / the dispatcher.

This keeps the bell, Slack DM forwarding (Phase 2), and dedupe semantics
consistent across every event family.

## Categories

Defined in `shared/models/notifications.ts`:

| Category | Used for |
| --- | --- |
| `comms.sms` | Inbound SMS + failed outbound SMS |
| `comms.call` | Inbound missed calls + failed outbound calls |
| `comms.voicemail` | Voicemail transcripts ready |
| `booking` | Native booking create / cancel |
| `mention` | `@handle` mentions in Conversation Hub thread notes |
| `assignment` | A conversation thread was assigned to you |
| `agent` | An AI matching decision needs human review |
| `feedback` | A new in-app feedback item landed |
| `system` | Generic admin alerts (non-queue dispatcher mirror) |
| `queue_health` | Backlog / health alerts for `queue.*` ids |

## Recipient helpers

`server/services/notifications/recipients.ts` exports the resolvers
event sources call. Each returns an array of user IDs (de-duplicated,
never throws, returns `[]` on failure):

| Helper | Used by |
| --- | --- |
| `getClientAccountManagers(clientId)` | Agent review fan-out |
| `getAssignedUserForThread(threadKey)` | Inside `getConversationOwners` |
| `getConversationOwners({ threadKey, clientId })` | Inbound SMS |
| `getRoutedCallUser({ callId, callSid, clientId })` | Missed calls + voicemail (falls back to client AM) |
| `getBookingHost(meetingId)` | Reserved for downstream booking events |
| `getResponsibleAdminsForAlert()` | Dispatcher mirror + new feedback (CEO / team_lead) |
| `getDirectorPlusUsers()` | Client risk-shift alerts — director+ (assigned authority, legacy-role bridge) fan-out (Task #3693) |
| `getThreadParticipants(threadKey)` | Outbound SMS + thread note "teammate replied" fan-out (Task #1703) |
| `resolveMentionsToUserIds(body)` | Thread-note `@mention` parsing |
| `excludeActor(recipients, actorId)` | Filter the actor out of every fan-out |

## Wired event sources

| Source | File | Category | Dedupe key shape |
| --- | --- | --- | --- |
| Inbound SMS | `server/services/twilioService.ts` (`handleInboundSms`) | `comms.sms` | `sms-inbound:<MessageSid>` |
| Failed outbound SMS | `server/services/twilioService.ts` (`handleSmsStatus`) | `comms.sms` | `sms-failed:<MessageSid>` |
| Missed inbound call | `server/services/twilioService.ts` (`handleCallStatus`) | `comms.call` | `call-missed:<CallSid>` |
| Failed outbound call | `server/services/twilioService.ts` (`handleCallStatus`) | `comms.call` | `call-failed:<CallSid>` |
| Voicemail transcript | `server/routes/twilio.ts` (voicemail-transcription webhook) | `comms.voicemail` | `voicemail:<CallSid>` |
| Thread `@mention` | `server/routes/twilio.ts` (POST `/api/twilio/threads/:key/notes`) | `mention` | `mention:note:<noteId>:<uid>` |
| Thread assignment | `server/routes/twilio.ts` (PATCH `/api/twilio/threads/:key/assignment`) | `assignment` | `assignment:<threadKey>:<assigneeId>` |
| Booking created | `server/services/bookingScheduler.ts` (`bookSlot`) | `booking` | `booking-created:<meetingId>` |
| Booking canceled (one-off) | `server/services/bookingScheduler.ts` (`cancelBooking`) | `booking` | `booking-canceled:<meetingId>` |
| Agent match review_required | `server/services/agentMatchingEngine.ts` | `agent` | `agent-review:<commId>:<clientId>:<uid>` |
| New feedback | `server/routes.ts` (POST `/api/feedback`) | `feedback` | `feedback:<feedbackId>:<uid>` |
| Admin queue/system alerts | `server/services/notifications/dispatcher.ts` (`notifyByType`) | `queue_health` or `system` | `alert:<notificationId>:<dedupeKey?>:<uid>` |
| Integration token auto-cleared (Task #1978) | `server/services/integrationTokenClearedAlerts.ts` (called from `slackIntegration.disconnect` on the `connect_terminal_auth_error` trigger) | `system` | `integration-token-cleared:<provider>` |
| Outbound gap-close last-run corrupt (Task #2197) | `server/services/frontOutboundGapCloser.ts` (`alertIfLastRunUnreadable`, called by the `front_outbound_gap_close` worker tick before it overwrites the value) | `system` | `front-outbound-gap-close-last-run-unreadable` |
| Outbound SMS — thread reply (Task #1703) | `server/services/twilioService.ts` (`sendSms`) | `mention` | `thread-reply:<threadKey>:<actorId>:<hourBucket>:<uid>` |
| Webinar breakdown ≠ Hot Transfers on report save (Task #2851) | `server/services/webinarBreakdownMismatchReview.ts` (`notifyWebinarBreakdownMismatchOnSave`, called from the marketing section PUT in `server/routes/reports.ts`) | `system` | `webinar-breakdown-mismatch:<reportId>:<hotTransfers>:<breakdownSum>` |
| Thread note — thread reply (Task #1703) | `server/routes/twilio.ts` (POST `/api/twilio/threads/:key/notes`) | `mention` | `thread-reply:<threadKey>:<actorId>:<hourBucket>:<uid>` |
| Client risk shift (Task #3693) | `server/services/clientRiskShiftAlert.ts` (`dispatchClientRiskShiftAlerts`, called at the end of `runDailyJudgmentCron`) | `system` | `client-risk-shift:<clientId>:<judgmentDate>:<uid>` (bundled run: `client-risk-shift:bulk:<judgmentDate>:<uid>`) |

All sources wrap their fan-out in `try { … } catch (err) { console.warn(…) }`
so notification failure cannot block the primary handler.

## Channel matrix (per event)

Every event in the table above lands in the per-user **in-app bell**
unconditionally — that is the contract of `notifyUser()`. After the
in-app row is persisted, `notifyUser()` *always* invokes
`maybeEnqueueUserSlackDm()`, which fans out a per-user Slack DM **only
when**:

1. the global kill switch `system_settings.user_slack_dm_enabled` is
   ON (default ON),
2. the recipient has opted into Slack DMs for the event's category in
   `user_notification_preferences` (Profile → Notifications panel; the
   default is OFF for every category — users opt in),
3. the recipient has a linked Slack identity (see
   `linkSlackIdentityByEmail`).

When all three hold, a `user_slack_dm` work-queue job is enqueued with
`dedupeKey: user_slack_dm:<notificationId>` and delivered out-of-band
via `chat.postMessage`. Terminal Slack errors dead-letter without
burning retry budget; the in-app row is unaffected.

A small subset of events ALSO fans out to a **global Slack channel**
and/or **email list** via the unified dispatcher (`notifyByType`) or
the legacy per-service Slack/email senders. The global Slack channel is
configured per `notificationId` in the Notifications Console; email
lists are configured per-service in their respective admin panel.

| Event | Category | In-app bell | Per-user Slack DM (opt-in) | Global Slack | Email list |
| --- | --- | --- | --- | --- | --- |
| Inbound SMS | `comms.sms` | ✓ | ✓ | ✓ (`notifyByType("workflow.client_sms.received")` → `#client-texts` by default, @-mentions conversation owners; Task #2779, `clientTextSlackAlert.ts`) | ✗ |
| Failed outbound SMS | `comms.sms` | ✓ | ✓ | ✗ | ✗ |
| Missed inbound call | `comms.call` | ✓ | ✓ | ✗ | ✗ |
| Failed outbound call | `comms.call` | ✓ | ✓ | ✗ | ✗ |
| Voicemail transcript | `comms.voicemail` | ✓ | ✓ | ✗ | ✗ |
| Thread `@mention` | `mention` | ✓ | ✓ | ✗ | ✗ |
| Thread assignment | `assignment` | ✓ | ✓ | ✗ | ✗ |
| Booking created / canceled | `booking` | ✓ | ✓ | ✗ | ✗ |
| Agent match `review_required` | `agent` | ✓ | ✓ | ✗ | ✗ |
| New feedback | `feedback` | ✓ | ✓ | ✗ | ✗ |
| Admin queue/system alerts (dispatcher mirror) | `queue_health` / `system` | ✓ (responsible admins) | ✓ | ✓ (via `notifyByType`) | ✗ |
| Webinar breakdown mismatch on save (Task #2851) | `system` | ✓ (saving editor + report owner) | ✓ | ✗ | ✗ |
| Monthly review blocked (Task #1713) | `system` | ✓ (client owner) | ✓ | ✗ | ✗ |
| Monthly review reminder (Task #1713) | `system` | ✓ (client owner) | ✓ | ✗ | ✗ |
| Comm-suggestions ready (Task #1713) | `system` | ✓ (client owner) | ✓ | ✗ | ✗ |
| Match-settings change (Task #1713) | `system` | ✓ (CEO recipients) | ✓ | ✓ (`broadcastMatchSettingChange`) | ✓ (`broadcastMatchSettingChange`) |
| Match-settings auto-retry give-up (Task #1713) | `system` | ✓ (admin recipients) | ✓ | ✓ (`notifyByType("workflow.match_settings.changed")`) | ✗ |
| Zoom review backlog (Task #1713) | `queue_health` | ✓ (CEO + team_lead) | ✓ | ✓ (`notifyByType("queue.zoom_review.backlog")`) | ✓ (`sendEmailNotification`, recipients from settings) |
| Zoom review cleared (Task #1713) | `queue_health` | ✓ (CEO + team_lead) | ✓ | ✓ (same channel) | ✓ (same email list) |
| Client risk shift (Task #3693) | `system` | ✓ (director+ users + client owner) | ✓ | ✓ (`notifyByType("workflow.client_risk.shift_detected")`, posts only when a channel is configured; generic admin mirror skipped) | ✗ |

The "Per-user Slack DM (opt-in)" column is universally ✓ because the
DM hook lives inside `notifyUser()` itself — every category is
forward-able the moment a user opts in. Regression coverage:

- `tests/user-slack-dm-forwarding.test.ts` — kill-switch, per-category
  pref gating, "no identity" suppression, handler short-circuits.
- `tests/user-slack-dm-stage-bc.test.ts` (Task #1719) — each Stage B/C
  event (monthly-review-blocked, monthly-review-reminder,
  match-settings-change, zoom-review backlog + cleared, comm-suggestions)
  enqueues a `user_slack_dm` job for an opted-in recipient and is
  suppressed under default-off prefs or with the kill switch flipped.
- `tests/match-settings-alert-giveup-notification.test.ts` (Task #1719
  extension) — additionally asserts the match-settings auto-retry
  give-up tick enqueues exactly one `user_slack_dm` job for the
  opted-in CEO (pref + Slack identity) and zero for the AM (default
  pref + no identity) firing in the same tick.

## Adding a new event source

1. Pick the right category from the table above (extend
   `userNotificationCategories` if a new one is genuinely needed).
2. Resolve recipients via a helper in `recipients.ts` — add a new helper
   if no existing one fits. Helpers must be best-effort and return `[]`
   on failure.
3. Call `excludeActor(recipients, actorUserId)` whenever the event has
   an actor (mentions, assignments, feedback, etc).
4. Call `notifyUser(uid, { category, title, body, deepLink, dedupeKey,
   metadata })` for each recipient, inside a try/catch, after the
   primary work is durably saved.
5. Choose a stable `dedupeKey` (use the event's natural unique id —
   MessageSid, CallSid, meetingId, noteId, etc).
6. Do **not** call Slack, do **not** insert into `user_notifications`,
   do **not** broadcast SSE — `notifyUser()` owns those.

### Dedupe guarantee (DB-level)

A stable `dedupeKey` is deduped both in-query and at the DB level. The
partial UNIQUE index `user_notifications_user_dedupe_unread_uniq` (unique
on `(user_id, dedupe_key)` where `dedupe_key IS NOT NULL AND read_at IS
NULL AND archived_at IS NULL`) means at most **one UNREAD** notification
can exist per `(user, dedupeKey)` — a duplicate is impossible even under
a race the in-query check misses (`notifyUser` catches the 23505 and
returns the existing row). There is **no time window**: the duplicate is
suppressed for as long as the original stays unread/unarchived. Once the
user reads or archives it, the row leaves the partial index and the next
dispatch with the same key produces a fresh notification.

The index was disabled 2026-05-26 and re-added in migration
`0085_readd_user_notifications_dedupe_unique_index.sql`. Because a Replit
Publish only applies the diffed `CREATE UNIQUE INDEX` (not the migration's
pre-cleanup DELETE), **run the `dedupe_user_notifications_unread`
prod-action before publishing** so prod has no duplicate unread rows for
the index build to trip on. See `shared/models/notifications.ts` for the
full sequence.

## Legacy table retirement (Stage G, Task #1716)

The legacy `notifications` table was dropped in migration
`migrations/0069_drop_legacy_notifications.sql` (May 21, 2026), one full
release cycle after Stage E+F removed the last runtime reader/writer.
The Drizzle definition was removed from `shared/models/reports.ts` in
the same change so `drizzle-kit push` will not recreate it.

Final architectural statement:

- `notifyUser()` (`server/services/notifications/userInbox.ts`) is the
  **only** writer of per-user notifications.
- `/api/notifications` (and the per-user inbox routes under it) is the
  **only** API surface for reading them.
- There are **no** storage-level notification helpers — event sources
  resolve recipients via `server/services/notifications/recipients.ts`
  and call `notifyUser()` directly.

## Client risk-shift alerts (Task #3693)

`server/services/clientRiskShiftAlert.ts` — fired from the 6am ET daily
judgment cron (`runDailyJudgmentCron`), which records each client's freshly
persisted judgment and dispatches ONCE at the end of the run.

- **Degradation** = status moved to a worse severity (explicit ordering
  `Healthy < Watch < At Risk < Critical`) **or** the 0–100 risk score
  jumped by **more than** `system_settings.client_risk_shift_score_jump_threshold`
  (default 20). Either signal alone alerts.
- **Once per streak**: comparisons are always against the client's
  *previous persisted judgment*, so a client that stays degraded produces
  no daily repeats — durable across restarts because the baseline is the
  judgment history, not a per-process flag. A *further* slip (e.g.
  Watch→At Risk after a Healthy→Watch alert) is a new transition and
  alerts again (distinct dispatcher `failureType` per target status).
- **Recovery re-arm**: a status improvement (or a score drop past the same
  threshold on score-only streaks) calls the dispatcher's `markRecovered`
  for `client:<clientId>`. Recovery marking runs even under the kill
  switch so state stays correct while alerts are muted.
- **Bundling**: ≥4 degradations in one run (`CLIENT_RISK_SHIFT_BUNDLE_THRESHOLD`)
  collapse into a single alert listing the clients (guards against a
  judgment-model behavior shift flooding the bell).
- **Recipients**: in-app rows go to director-level+ users
  (`getDirectorPlusUsers()`, assigned authority incl. the legacy-role
  bridge) plus the client's account owner (`getClientAccountManagers`);
  the dispatcher's generic CEO/team_lead mirror is skipped
  (`skipAdminInAppMirror`) because the module owns its targeted fan-out.
  Payload carries old→new status, risk scores, the judgment
  headline/top concerns, and a `/clients/<id>` deep link.
- **Slack**: global-channel post via
  `notifyByType("workflow.client_risk.shift_detected")` only when a
  channel is configured in the Notifications Console (no default channel).
- **Kill switch**: `system_settings.kill_switch_client_risk_shift_alert`
  (default ON; set to `"false"` to disable all risk-shift notifications).
- **Out of scope by design**: manual single-client judgment regeneration
  (API route) does not alert — only the daily run compares day-over-day.

Regression coverage: `tests/client-risk-shift-alert.test.ts` (transition
classification, streak/no-repeat + escalation, recovery re-arm, bundling,
kill switch, threshold tuning, recipient targeting).

## Related runbooks

- `WORKERS_QUEUES_RUNBOOK.md` — queue backlog alerts that the
  dispatcher now mirrors into the admin bell.
- `RUNBOOKS.md` — operational runbook index.

## Per-user Slack DM forwarding (Task #1687 / Phase 2)

Adds `user_slack_identities` (linked via Slack `users.lookupByEmail`
against the user's NoBull OS email — no per-user OAuth) and
`user_notification_preferences` (per-user × per-category in-app / Slack
toggles).

`notifyUser()` enqueues a `user_slack_dm` work-queue job (maintenance
class, `user_slack_dm:${notificationId}` dedupe key, max 4 attempts)
**after** the in-app row is persisted; Slack failures never block
in-app and never throw past the hook. Terminal Slack errors
(`user_not_found`, `invalid_auth`, `missing_scope`, etc.) dead-letter
with a `terminal:` cursor instead of burning retries.

Surfaced in `client/src/components/UserNotificationSettingsPanel.tsx`
(Profile page) and the per-user oversight section of
`SlackNotificationsConsole.tsx` (admin).

Global kill switch: `system_settings.user_slack_dm_enabled` (default
ON; set to `"false"` to disable). Tables are created via migration
`0068_add_user_slack_preferences.sql` with an on-demand
`ensureUserSlackPreferenceTables()` mirror.
