/**
 * Task #3945 — Pure leaf module for the Front conversation message-version
 * extractor, shared by `frontHistoricalRecovery.ts` (recovery dedupe keys),
 * `frontWebhookIngestion.ts` (discovery/reconciliation dedupe keys +
 * hydration version), and the legacy dedupe-key rewrite prod action.
 * Extracted verbatim from `frontHistoricalRecovery.ts` to break the
 * two-node runtime import cycle (recovery imported the ingestion write
 * helpers while ingestion imported this extractor back).
 *
 * This module must stay a leaf: it imports neither service and has no
 * database/storage, webhook-route, scheduler, or worker access — guarded
 * by `tests/front-ingestion-recovery-cycle-guard.test.ts`.
 */

/**
 * Task #1887 — Compose the version slot for a Front conversation's dedupe
 * key. Front's list endpoint has been observed returning `last_message: null`
 * on 100% of recovery payloads in production, which collapsed
 * `front:recovery:<convId>:<lastMsgId>` to `front:recovery:<convId>:` (empty
 * trailing suffix). That defeats `FRONT_PIPELINE_VERSIONED_DISCOVERY_ENABLED`:
 * every message on the same thread shares one dedupe entry, so a new inbound
 * message on an already-seen thread is silently dropped by the
 * `source_event_log` UNIQUE on `dedupe_key`.
 *
 * Resolution order — pick the first source that yields a non-empty string:
 *   1. `last_message.id` (preferred; populated when Front embeds the object)
 *   2. `_links.related.last_message` URL — Front returns this on the list
 *      response in the form `.../messages/msg_xxx` even when the embedded
 *      object is omitted; we extract the trailing `msg_xxx`.
 *   3. A timestamp that advances on new activity — `last_message.created_at`,
 *      then `waiting_since`, then `updated_at`. We intentionally skip
 *      `created_at` (it's fixed at conv creation and doesn't version new
 *      messages).
 *   4. `"noversion"` sentinel — never returns an empty string, so the
 *      dedupe key never degrades back to the trailing-empty-colon shape.
 */
export function extractFrontConvMessageVersion(conv: any): string {
  const directId = conv?.last_message?.id;
  if (typeof directId === "string" && directId.length > 0) return directId;

  const link = conv?._links?.related?.last_message;
  if (typeof link === "string") {
    const m = link.match(/\/messages\/([A-Za-z0-9_-]+)(?:\?|$|#)/);
    if (m && m[1]) return m[1];
  }

  const ts =
    conv?.last_message?.created_at ??
    conv?.waiting_since ??
    conv?.updated_at;
  if (typeof ts === "number" && Number.isFinite(ts) && ts > 0) {
    return `t${ts}`;
  }
  if (typeof ts === "string" && ts.length > 0) return `t${ts}`;

  return "noversion";
}
