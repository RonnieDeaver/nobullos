// Task #4057 — shared manual-reassignment semantics for Zoom records.
//
// Originally extracted verbatim from PATCH /api/integrations/zoom/messages/
// :id/reassign (server/routes/communications.ts) so the Transcript Match
// Assistant's assign action and the comms-feed reassign cannot drift apart.
// Task #4050 then rebased the core mutation onto the review-queue service's
// manualReassignZoomRecordFromFeed, so BOTH callers get the full stamping
// semantics: every related raw record is stamped (recording + transcript
// share one externalSourceId), matchStatus flips to matched/unmatched (the
// old single-row update left rows `unmatched`, so the next reprocess
// clobbered manual assignments), client links are maintained, open review
// decisions resolve with the acting user recorded, and analysis is
// (re)queued so the call counts toward churn comms immediately.
//
// This wrapper keeps the original route contract on top of that core:
// input validation, client existence check, the delivery-mode-aware
// recording fan-out (Task #4025) after an assignment, and the
// {ok, updated, clientName} result shape.
//
// Route-called only (API pool via the plain `db` import) — never invoked
// from queue workers.

import { eq } from "drizzle-orm";

import { db } from "../db";
import { clients } from "@shared/schema";

export type ZoomReassignResult =
  | { ok: true; updated: any; clientName: string | null }
  | { ok: false; status: 400 | 404; error: string };

export async function reassignZoomRecordToClient(
  recordId: string,
  clientId: unknown,
  userId: string,
): Promise<ZoomReassignResult> {
  if (clientId !== undefined && clientId !== null && typeof clientId !== "string") {
    return { ok: false, status: 400, error: "clientId must be a string or null" };
  }

  if (clientId) {
    const clientExists = await db
      .select({ id: clients.id })
      .from(clients)
      .where(eq(clients.id, clientId as string));
    if (clientExists.length === 0) {
      return { ok: false, status: 404, error: "Client not found" };
    }
  }

  // Task #4050 — the shared core: stamps every related raw record, maintains
  // links, resolves open review decisions, re-queues analysis.
  const { manualReassignZoomRecordFromFeed } = await import("./zoomReviewQueue");
  const reassigned = await manualReassignZoomRecordFromFeed({
    recordId,
    clientId: (clientId as string | null | undefined) || null,
    userId,
  });
  if (!reassigned) {
    return { ok: false, status: 404, error: "Zoom meeting not found" };
  }
  const updated = reassigned.record;

  if (updated && clientId) {
    // Reassignment never touches googleDriveFileUrl/rawPayloadJson, so the
    // post-update row carries the same fan-out signals the original
    // pre-update read did.
    if (!updated.googleDriveFileUrl && updated.rawPayloadJson) {
      const payload = updated.rawPayloadJson as any;
      const meetingUuid = payload.meetingUuid || payload.meetingId;
      if (meetingUuid) {
        void (async () => {
          try {
            // Task #4025: deliver to the client's in-app files (sole
            // sink since the Task #4084 Drive retirement).
            const { deliverZoomRecording } = await import("./clientFileDelivery");
            const { listRecentRecordings } = await import("./zoomIntegration");
            const meetings = await listRecentRecordings();
            const meeting = meetings.find(
              (m: any) => (m.uuid || m.id?.toString()) === meetingUuid,
            );
            if (meeting) {
              await deliverZoomRecording(recordId, meeting, clientId as string);
            }
          } catch (err) {
            console.error(
              "[ClientFileDelivery] Background delivery failed on Zoom reassignment:",
              err,
            );
          }
        })();
      }
    }
    const [clientRow] = await db
      .select({ firmName: clients.firmName })
      .from(clients)
      .where(eq(clients.id, clientId as string));
    return { ok: true, updated, clientName: clientRow?.firmName || null };
  }

  return { ok: true, updated, clientName: null };
}
