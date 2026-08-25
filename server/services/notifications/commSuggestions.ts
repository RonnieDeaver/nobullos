// Task #1713 — Stage B/C migration helper.
//
// Replaces the four near-identical legacy-notification create call sites
// (type "comm_suggestions") in server/routes/communications.ts
// (manual log, manual re-analyze, Front ingest, Zoom ingest). Each call
// site previously fanned out an AI-suggestions notice to the client's
// owner via the legacy `notifications` table; this helper writes to the
// per-user inbox via `notifyUser()` instead.
//
// Dedupe key: `comms:suggestions:<recordId>:<ownerId>` so a re-analyze
// of the same communication record within the 1-hour dedupe window
// collapses to a single inbox row.
//
// Deep link: `/clients/<clientId>?tab=comm-log&recordId=<recordId>` —
// per the Stage B/C review, comm-suggestions should land on the
// specific communication thread, not the generic client page. The
// `comm-log` tab is the Communications Log inside the Client Command
// Center; the `recordId` query param identifies the raw communication
// record that triggered the suggestions.

import { storage } from "../../storage";
import { notifyUser } from "./userInbox";

export interface NotifyCommSuggestionsParams {
  clientId: string;
  recordId: string;
  recordTitle: string;
  suggestionCount: number;
  /** Origin label used in the body when no record title fits, e.g.
   *  "Front conversation" or "Zoom recording". When omitted, the
   *  record title is used. */
  sourceLabel?: string;
}

export async function notifyOwnerOfCommSuggestions(
  params: NotifyCommSuggestionsParams,
): Promise<void> {
  if (params.suggestionCount <= 0) return;
  try {
    const client = await storage.getClient(params.clientId);
    if (!client?.ownerId) return;
    const plural = params.suggestionCount > 1 ? "s" : "";
    const fromLabel = params.sourceLabel
      ? params.sourceLabel
      : `"${params.recordTitle}"`;
    await notifyUser(client.ownerId, {
      category: "system",
      title: `${params.suggestionCount} AI suggestion${plural} ready to review`,
      body: `AI found ${params.suggestionCount} suggested update${plural} from ${fromLabel}`,
      deepLink: `/clients/${params.clientId}?tab=comm-log&recordId=${encodeURIComponent(params.recordId)}`,
      dedupeKey: `comms:suggestions:${params.recordId}:${client.ownerId}`,
      metadata: {
        clientId: params.clientId,
        recordId: params.recordId,
        suggestionCount: params.suggestionCount,
        sourceLabel: params.sourceLabel ?? null,
      },
    });
  } catch (err: any) {
    console.error(
      "[commSuggestions] notifyOwnerOfCommSuggestions failed:",
      err?.message ?? err,
    );
  }
}
