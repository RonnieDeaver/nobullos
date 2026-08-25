// @db-pool-intent: ambient
/**
 * NoBull Comms storage — calls.
 * Extracted verbatim from server/storage/commsStorage.ts (Task #3787 split);
 * sections: Calls, Call recording.
 */

import { and, desc, eq, inArray } from "drizzle-orm";
import { dbRetry, getDb, withDbAttribution } from "../../db";
import { commsCalls, type CommsCall } from "@shared/schema";

// ─── Calls ───────────────────────────────────────────────────────────────────

export async function createCall(data: {
  channelId: string;
  initiatedBy: string;
  livekitRoomName: string;
  callType?: "voice" | "video";
  systemMessageId?: string;
}): Promise<CommsCall> {
  return withDbAttribution("comms:createCall", async () => {
    const [row] = await dbRetry(
      () =>
        getDb()
          .insert(commsCalls)
          .values({ ...data, callType: data.callType ?? "voice", status: "active" })
          .returning(),
      "comms.createCall",
    );
    return row;
  });
}

export async function addCallParticipant(callId: string, userId: string): Promise<CommsCall | null> {
  return withDbAttribution("comms:addCallParticipant", async () => {
    const [existing] = await getDb()
      .select()
      .from(commsCalls)
      .where(eq(commsCalls.id, callId))
      .limit(1);
    if (!existing) return null;
    const participants: Array<{ userId: string; joinedAt: string; leftAt?: string }> =
      existing.participantsJson ?? [];
    if (!participants.find((p) => p.userId === userId && !p.leftAt)) {
      participants.push({ userId, joinedAt: new Date().toISOString() });
    }
    const [row] = await getDb()
      .update(commsCalls)
      .set({ participantsJson: participants })
      .where(eq(commsCalls.id, callId))
      .returning();
    return row ?? null;
  });
}

export async function removeCallParticipant(callId: string, userId: string): Promise<CommsCall | null> {
  return withDbAttribution("comms:removeCallParticipant", async () => {
    const [existing] = await getDb()
      .select()
      .from(commsCalls)
      .where(eq(commsCalls.id, callId))
      .limit(1);
    if (!existing) return null;
    const participants: Array<{ userId: string; joinedAt: string; leftAt?: string }> =
      existing.participantsJson ?? [];
    const now = new Date().toISOString();
    const updated = participants.map((p) =>
      p.userId === userId && !p.leftAt ? { ...p, leftAt: now } : p,
    );
    const [row] = await getDb()
      .update(commsCalls)
      .set({ participantsJson: updated })
      .where(eq(commsCalls.id, callId))
      .returning();
    return row ?? null;
  });
}

export async function endCall(id: string): Promise<CommsCall | null> {
  return withDbAttribution("comms:endCall", async () => {
    const [existing] = await getDb()
      .select()
      .from(commsCalls)
      .where(eq(commsCalls.id, id))
      .limit(1);
    if (!existing) return null;
    const endedAt = new Date();
    const durationSeconds = existing.startedAt
      ? Math.round((endedAt.getTime() - existing.startedAt.getTime()) / 1000)
      : 0;
    const [row] = await getDb()
      .update(commsCalls)
      .set({ status: "ended", endedAt, durationSeconds })
      .where(eq(commsCalls.id, id))
      .returning();
    return row ?? null;
  });
}

export async function getCallById(id: string): Promise<CommsCall | null> {
  return withDbAttribution("comms:getCallById", async () => {
    const [row] = await dbRetry(
      () => getDb().select().from(commsCalls).where(eq(commsCalls.id, id)).limit(1),
      "comms.getCallById",
    );
    return row ?? null;
  });
}

export async function getCallByRoomName(roomName: string): Promise<CommsCall | null> {
  return withDbAttribution("comms:getCallByRoomName", async () => {
    const [row] = await dbRetry(
      () =>
        getDb()
          .select()
          .from(commsCalls)
          .where(eq(commsCalls.livekitRoomName, roomName))
          .orderBy(desc(commsCalls.startedAt))
          .limit(1),
      "comms.getCallByRoomName",
    );
    return row ?? null;
  });
}

export async function getActiveCallForChannel(channelId: string): Promise<CommsCall | null> {
  return withDbAttribution("comms:getActiveCallForChannel", async () => {
    const [row] = await dbRetry(
      () =>
        getDb()
          .select()
          .from(commsCalls)
          .where(
            and(eq(commsCalls.channelId, channelId), eq(commsCalls.status, "active")),
          )
          .orderBy(desc(commsCalls.startedAt))
          .limit(1),
      "comms.getActiveCallForChannel",
    );
    return row ?? null;
  });
}

export async function getActiveCallsForChannels(channelIds: string[]): Promise<Map<string, CommsCall>> {
  if (channelIds.length === 0) return new Map();
  return withDbAttribution("comms:getActiveCallsForChannels", async () => {
    const rows = await dbRetry(
      () =>
        getDb()
          .select()
          .from(commsCalls)
          .where(
            and(inArray(commsCalls.channelId, channelIds), eq(commsCalls.status, "active")),
          )
          .orderBy(desc(commsCalls.startedAt)),
      "comms.getActiveCallsForChannels",
    );
    const map = new Map<string, CommsCall>();
    for (const row of rows) {
      if (!map.has(row.channelId)) map.set(row.channelId, row);
    }
    return map;
  });
}

// ─── Call recording ──────────────────────────────────────────────────────────

export async function updateCallRecording(
  callId: string,
  data: Partial<
    Pick<
      CommsCall,
      | "recordingEgressId"
      | "recordingStatus"
      | "recordingObjectKey"
      | "recordingTransitKey"
      | "recordingDurationSeconds"
      | "recordingFileSizeBytes"
      | "recordingCompletedAt"
      | "recordingError"
      | "recordingSystemMessageId"
    >
  >,
): Promise<CommsCall | null> {
  return withDbAttribution("comms:updateCallRecording", async () => {
    const [row] = await getDb()
      .update(commsCalls)
      .set(data)
      .where(eq(commsCalls.id, callId))
      .returning();
    return row ?? null;
  });
}
