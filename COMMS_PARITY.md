# NoBull Comms — Mattermost Parity Audit

> **Scope**: Compares NoBull Comms (as of this task) against Mattermost's core feature set.
> **Purpose**: Surface gaps and guide the parity roadmap. "✅" = shipped, "🔲" = planned / in-progress, "❌" = not planned.

---

## 1. Channels & Organisation

| Feature | Mattermost | NoBull | Notes |
|---|---|---|---|
| Public channels | ✅ | ✅ | `visibility: public`, joinable via `/join` |
| Private channels | ✅ | ✅ | `visibility: private`, invite-only |
| DM (1:1) | ✅ | ✅ | `type: dm`, slug-deduped |
| Group DM | ✅ | ✅ | `type: group_dm`, hash-slug for >2 users |
| Client-bound channels | ❌ (no CRM) | ✅ | Channels linked to a client, team-wide access |
| Channel archive / restore | ✅ | ✅ | `archivedAt`, `/unarchive` route |
| Channel search | ✅ | 🔲 | Public channel list endpoint exists; no search UI yet |
| Shared channels (cross-org) | ✅ (Enterprise) | ❌ | Out of scope |
| Categories / sidebar groups | ✅ | ✅ | `comms_sidebar_categories` CRUD + reorder; favorites toggle; drag-drop not shipped |
| Default channels | ✅ | ✅ | New users auto-join a team-lead-managed default channel list (`/admin/comms/default-channels`) |
| Channel bookmarks | ✅ (v7.10+) | ✅ | `comms_bookmarks` schema + storage; CRUD routes shipped |

---

## 2. Messaging

| Feature | Mattermost | NoBull | Notes |
|---|---|---|---|
| Send text message | ✅ | ✅ | 10 000-char limit |
| Markdown rendering | ✅ | ✅ | Bold, italic, inline code, code blocks, blockquotes, ordered/unordered lists rendered client-side (shared `renderContent` in `client/src/components/comms/helpers.tsx`, used by the shared MessageItem/MessagePane — /comms and popups both render the same shared components, so per-message features cannot drift between surfaces) |
| Message edit (own) | ✅ | ✅ | `editedAt` set, SSE `comms:message_edit` broadcast |
| Message soft-delete (own) | ✅ | ✅ | `deletedAt`, SSE `comms:message_delete` |
| Team-lead / mod delete | ✅ | ✅ | `isTeamLead` gate; DM privacy hardened |
| Threaded replies | ✅ | ✅ | `parentId` foreign key; reply count in list; thread follow/unfollow |
| File attachments | ✅ | ✅ | Multer → Replit Object Storage; 25 MB limit |
| Image preview | ✅ | ✅ | Inline `<img>` thumbnail in message bubble; click opens lightbox (arrow-key gallery nav); served via auth-gated `/api/comms/attachments/*` (channel-membership check); non-image files keep filename+download link |
| Emoji reactions | ✅ | ✅ | Add/remove; SSE `comms:reaction`; dedup by user+emoji; skin-tone variants are separate pills (Slack parity) with tone-labelled tooltip |
| Custom emoji upload | ✅ | ✅ | Upload PNG/JPEG/GIF/WebP (≤256 KB); served via auth'd image route |
| Custom emoji in messages | ✅ | ✅ | `:name:` rendered as `<img>` in MessagePane, MessageItem, reaction badges |
| Emoji autocomplete in composer | ✅ | ✅ | `:query` inline autocomplete (2+ chars triggers custom emoji dropdown) |
| Emoji picker — categories | ✅ | ✅ | 8 standard categories with tab icons + custom tab |
| Emoji picker — skin tones | ✅ | ✅ | 6 skin tone modifiers; persisted in localStorage |
| Emoji picker — recently used | ✅ | ✅ | Frequently-used row (API-backed); custom + standard emoji tracked |
| Pin message | ✅ | ✅ | `comms_pinned_messages`; SSE `comms:pin` |
| Save / bookmark message | ✅ | ✅ | `comms_saved_messages`; per-user |
| @mention users | ✅ | ✅ | Regex extract → `notifyUser` |
| @channel / @here | ✅ | ✅ | Broadcasts to non-muted members |
| Message permalinks | ✅ | ✅ | `GET /api/comms/permalink?messageId=…` resolves channel + message |
| Scheduled messages | ✅ | ✅ | `comms_scheduled_messages`; POST/GET/PATCH/DELETE routes; scheduled delivery worker |
| Priority / urgent messages | ✅ (v7.7+) | ❌ | Not planned |
| Message forwarding | ✅ | ✅ | `POST /api/comms/messages/:id/forward`; ForwardDialog UI |
| Post drafts | ✅ | ✅ | `comms_drafts` per user+channel; PUT/GET/DELETE; DraftsView UI |

---

## 3. Search

| Feature | Mattermost | NoBull | Notes |
|---|---|---|---|
| Full-text message search | ✅ | ✅ | `plainto_tsquery` on `content`; accessible-channel scoped |
| Filter by channel | ✅ | ✅ | `?channelId=` param; or `in:#channel` modifier |
| Filter by sender | ✅ | ✅ | `?fromUserId=` param; or `from:name` modifier |
| Filter by date range | ✅ | ✅ | `?dateFrom=`, `?dateTo=` params; or `before:`/`after:`/`on:` modifiers |
| Typed search modifiers | ✅ | ✅ | `from:name`, `in:#channel`, `before:/after:/on:`, `"phrase"`, `-excluded` — combinable; modifier autocomplete popover |
| Recent searches | ✅ | ✅ | Per-user history in localStorage (up to 10); removable |
| Search in files / attachments | ✅ | ✅ | `GET /api/comms/search/files` — membership-scoped; Files tab with download + jump-to-message |
| Jump to message from result | ✅ | ✅ | Click any result opens the channel scrolled to the message with highlight |
| Global search view | ✅ | ✅ | "Search" nav item in sidebar — cross-channel search with `in:` scope modifier |
| Full-text search in file contents | ✅ | ❌ | Deferred — filename + MIME type only for now |
| Saved search / pinned filters | ✅ | ❌ | Not planned |

---

## 4. Real-Time & Presence

| Feature | Mattermost | NoBull | Notes |
|---|---|---|---|
| Online presence | ✅ | ✅ | `commsPresence`; TTL-based; heartbeat every 25 s |
| SSE delivery | ✅ (WebSocket) | ✅ | Server-Sent Events (SSE); per-user scoped |
| Typing indicators | ✅ | ✅ | SSE `comms:typing`; broadcast to other members |
| Message event | ✅ | ✅ | SSE `comms:message` |
| Edit event | ✅ | ✅ | SSE `comms:message_edit` |
| Delete event | ✅ | ✅ | SSE `comms:message_delete` |
| Reaction event | ✅ | ✅ | SSE `comms:reaction` (add/remove) |
| Pin event | ✅ | ✅ | SSE `comms:pin` (pin/unpin action + channelId) |
| Member change event | ✅ | ✅ | SSE `comms:member_change` (add/remove + userId) |
| Channel update event | ✅ | ✅ | SSE `comms:channel_update` (name/topic changed) |
| Read-state event | ✅ | ✅ | SSE `comms:read_state` |
| Presence event | ✅ | ✅ | SSE `comms:presence` |
| Call event | ✅ (Calls plugin) | ✅ | SSE `comms:call` |
| Reconnect catch-up resync | ✅ | ✅ | `GET /api/comms/events/catch-up?since=<ISO>` + client resync |
| Push notifications (mobile) | ✅ | ❌ | Not planned (web-only app) |
| Email digest | ✅ | ❌ | Not planned |
| Desktop notifications | ✅ | 🔲 | `notifyUser` in-app inbox; browser Notification API TBD |

---

## 5. Notifications & Preferences

| Feature | Mattermost | NoBull | Notes |
|---|---|---|---|
| Per-channel notification pref | ✅ | ✅ | `all` / `mentions` / `muted`; `comms_notification_prefs` |
| Muted channels | ✅ | ✅ | `pref: muted`; excluded from badge / @here |
| Unread badge count | ✅ | ✅ | `unreadCount` on channel list |
| Do Not Disturb | ✅ | ✅ | `manualStatus: "dnd"` with `dndExpiresAt`; suppresses desktop badge; `comms_user_statuses` |
| Keyword alerts | ✅ | ❌ | Not planned |

---

## 6. Voice & Video Calls

| Feature | Mattermost | NoBull | Notes |
|---|---|---|---|
| Voice call | ✅ (Calls plugin) | ✅ | LiveKit; SSE `comms:call` |
| Video call | ✅ (Calls plugin) | ✅ | LiveKit video track |
| Call recording | ✅ (Enterprise) | ✅ | Auto-egress → Object Storage; system message on ready |
| Screen share | ✅ | 🔲 | LiveKit supports it; no UI yet |
| Call transcript | ✅ (Enterprise) | ❌ | Not planned |

---

## 7. Access Control & Security

| Feature | Mattermost | NoBull | Notes |
|---|---|---|---|
| Auth-gated access | ✅ | ✅ | `isAuthenticated` (Replit Auth OIDC) on all routes |
| Channel membership check | ✅ | ✅ | `isChannelMember` before every mutation |
| DM strict membership | ✅ | ✅ | `isStrictChannelMember` — no role bypass for DMs |
| Team-lead moderation | ✅ | ✅ | Delete others' messages; DM privacy hardened |
| Attachment ACL | ✅ | ✅ | Channel-member gate on `GET /api/comms/attachments/*` |
| Per-user rate limiting | ✅ | ✅ | `commsWriteLimiter` (60 req/min base, role-multiplied) |
| SSE user-scoped delivery | ✅ | ✅ | `targetUserIds` fan-out; client-bound channels = all |
| Guest accounts | ✅ | ❌ | All users are internal staff |
| MFA enforcement | ✅ | ❌ | Handled by Replit Auth; out of NoBull scope |
| Channel export / audit log | ✅ (Enterprise) | ❌ | Not planned |
| Data retention policies | ✅ (Enterprise) | ❌ | Not planned |

---

## 8. Integrations & Extensibility

| Feature | Mattermost | NoBull | Notes |
|---|---|---|---|
| Incoming webhooks | ✅ | ✅ | `POST /api/comms/incoming/:token`; token SHA-256-hashed and compared to DB; team-lead management routes |
| Slash commands | ✅ | ✅ | `POST /api/comms/channels/:id/slash`; /shrug /me /away /online /dnd /mute /leave /help |
| Bot accounts | ✅ | ❌ | `userId: null` system messages only |
| Plugin framework | ✅ | ❌ | Not applicable |
| Client comms feed | ❌ | ✅ | `/api/clients/:id/comms-feed` — client-tagged view |

---

## 9. Gap Summary (Priority Order)

| # | Gap | Priority | Notes |
|---|---|---|---|
| 1 | ~~Markdown rendering (client-side)~~ | ~~High~~ | ✅ Shipped — shared `renderContent` renders bold/italic/code/code blocks/blockquotes/lists in both message panes |
| 2 | ~~Default channels on user creation~~ | ~~Medium~~ | ✅ Shipped — auto-join new users to admin-managed list |
| 3 | ~~Image preview in MessagePane~~ | ~~Medium~~ | ✅ Shipped — inline thumbnail + lightbox in MessageItem; auth-gated attachment proxy |
| 4 | Desktop browser Notification API | Medium | `notifyUser` in-app; push TBD |
| 5 | Screen share (LiveKit) | Low | SDK-capable; no UI surface |
| 6 | Channel search UI | Low | Public list endpoint exists |
| 7 | Sidebar drag-drop ordering | Low | CRUD + reorder API shipped; drag-drop UI TBD |

---

*Last updated: 2026-07-20. Features verified against shipped code in tasks 1–14 of the Comms parity epic. Maintain this file alongside changes to `server/routes/comms.ts` and `COMMS.md`.*
