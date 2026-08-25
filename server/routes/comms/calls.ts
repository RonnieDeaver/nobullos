// @db-pool-intent: api (request-scoped reads/writes)
/**
 * NoBull Comms routes — calls.
 * Extracted verbatim from server/routes/comms.ts (Task #3787 split);
 * sections: Calls (LiveKit), Call recording access, LiveKit room webhook.
 * Mounted by registerCommsRoutes in ../comms.ts — route order is
 * preserved by the aggregator's call sequence.
 */

import express, { type Express } from "express";
import { isAuthenticated } from "../../middlewares/requireAuth";
import { broadcastTwilioEvent } from "../../services/twilioEvents";
import { notifyUser } from "../../services/notifications/userInbox";
import * as commsStorage from "../../storage/commsStorage";
import { createRoomWithRecording, mirrorRecordingFromTransit, deleteTransitObject } from "../../services/livekitRecording";
import { getUserId, mintLiveKitToken, finalizeEndedCall, objectStorage } from "./shared";

export function registerCommsCallRoutes(app: Express): void {
  // ──────────────────────────────────────────────────────────────────────────
  // Calls (LiveKit)
  // ──────────────────────────────────────────────────────────────────────────
  app.post("/api/comms/calls/token", isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const userName = req.user?.dbUser?.username ?? userId;
      const { roomName } = req.body;
      if (!roomName || typeof roomName !== "string") {
        return res.status(400).json({ error: "roomName required" });
      }
      if (!process.env.LIVEKIT_API_KEY || !process.env.LIVEKIT_API_SECRET || !process.env.LIVEKIT_SERVER_URL) {
        return res.status(503).json({ error: "Voice/video calls not configured (LiveKit API keys not set)" });
      }
      // Room-scoped grant: the room must belong to a known call, the call must
      // still be active, and the requester must be a member of its channel.
      const call = await commsStorage.getCallByRoomName(roomName);
      if (!call) return res.status(404).json({ error: "No call found for that room" });
      if (call.status !== "active") return res.status(410).json({ error: "Call has ended" });
      const isMember = await commsStorage.isChannelMember(call.channelId, userId);
      if (!isMember) return res.status(403).json({ error: "Not a member of this call's channel" });
      const token = await mintLiveKitToken(roomName, userId, userName);
      if (!token) {
        return res.status(503).json({ error: "Failed to mint call token" });
      }
      const serverUrl = process.env.LIVEKIT_SERVER_URL ?? "";
      res.json({ token, serverUrl, roomName });
    } catch (err: any) {
      console.error("[Comms] Call token error:", err.message);
      res.status(500).json({ error: "Failed to generate call token" });
    }
  });

  app.post("/api/comms/channels/:id/calls", isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const callType: "voice" | "video" =
        req.body?.callType === "video" ? "video" : "voice";

      if (!process.env.LIVEKIT_API_KEY || !process.env.LIVEKIT_API_SECRET || !process.env.LIVEKIT_SERVER_URL) {
        return res.status(503).json({ error: "Voice/video calls not configured (LiveKit API keys not set)" });
      }

      const channel = await commsStorage.getChannelById(req.params.id);
      if (!channel) return res.status(404).json({ error: "Channel not found" });
      const isMember = await commsStorage.isChannelMember(channel.id, userId);
      if (!isMember) return res.status(403).json({ error: "Not a member" });

      const existing = await commsStorage.getActiveCallForChannel(channel.id);
      if (existing) return res.status(409).json({ error: "Call already active", call: existing });

      const roomName = `comms-${channel.id}-${Date.now()}`;
      const callIcon = callType === "video" ? "🎥" : "📞";
      const sysMsg = await commsStorage.createMessage({
        channelId: channel.id,
        userId: null,
        content: `${callIcon} A ${callType} call was started`,
        contentType: "system",
        metadata: { type: "call_started", initiatedBy: userId, roomName, callType },
      });

      let call = await commsStorage.createCall({
        channelId: channel.id,
        initiatedBy: userId,
        livekitRoomName: roomName,
        callType,
        systemMessageId: sysMsg.id,
      });

      // Create the LiveKit room server-side with auto-egress recording.
      // Non-fatal: if recording setup fails the call proceeds without recording.
      try {
        const recResult = await createRoomWithRecording({ roomName });
        const recUpdate: Parameters<typeof commsStorage.updateCallRecording>[1] = {
          recordingStatus: recResult.status,
        };
        if (recResult.transitKey) recUpdate.recordingTransitKey = recResult.transitKey;
        if (recResult.error) recUpdate.recordingError = recResult.error.slice(0, 256);
        const updated = await commsStorage.updateCallRecording(call.id, recUpdate);
        if (updated) call = updated;

        // Post a loud system message for non-silent failures at setup time
        if (recResult.status === "failed" || recResult.status === "not_configured") {
          const errContent =
            recResult.status === "failed"
              ? `⚠️ Call recording failed to start: ${(recResult.error ?? "unknown error").slice(0, 120)}`
              : "⚠️ Call recording is not configured (transit S3 bucket env vars missing). The call will proceed without recording.";
          void commsStorage
            .createMessage({
              channelId: channel.id,
              userId: null,
              content: errContent,
              contentType: "system",
              metadata: {
                type: "call_recording_setup_failed",
                callId: call.id,
                reason: recResult.status,
              },
            })
            .catch((e: any) =>
              console.error("[Comms] Recording setup msg error:", e?.message),
            );
          void notifyUser(
            userId,
            {
              category: "comms.recording",
              title: "Call recording unavailable",
              body: errContent.slice(0, 150),
              deepLink: "/comms",
              dedupeKey: `comms.recording:setup_failed:${call.id}`,
              metadata: { callId: call.id, reason: recResult.status },
            },
            { source: "api" },
          ).catch(() => {});
        }

        if (recResult.status === "failed") {
          console.error(`[Comms] Recording setup failed for call ${call.id}:`, recResult.error);
        }
      } catch (e: any) {
        console.error("[Comms] Recording setup error for call", call.id, ":", e?.message);
      }

      const memberIds = await commsStorage.getChannelMemberIds(channel.id);
      broadcastTwilioEvent({
        type: "comms:call",
        channelId: channel.id,
        callId: call.id,
        status: "started",
        initiatedBy: userId,
        callType,
        livekitRoomName: roomName,
        recordingStatus: call.recordingStatus ?? "not_configured",
        ...(memberIds !== null ? { targetUserIds: memberIds } : {}),
      });

      // Notify all channel members (except the caller) via the inbox
      const callLabel = callType === "video" ? "video" : "voice";
      const channelLabel = channel.name ?? "a channel";
      if (memberIds) {
        for (const memberId of memberIds) {
          if (memberId === userId) continue;
          void notifyUser(
            memberId,
            {
              category: "comms.call",
              title: `Incoming ${callLabel} call`,
              body: `A ${callLabel} call started in #${channelLabel}`,
              deepLink: "/comms",
              dedupeKey: `comms.call:started:${call.id}:${memberId}`,
              metadata: { callId: call.id, channelId: channel.id, callType },
            },
            { source: "api" },
          );
        }
      }

      res.status(201).json({ call, systemMessageId: sysMsg.id, roomName });
    } catch (err: any) {
      console.error("[Comms] Start call error:", err.message);
      res.status(500).json({ error: "Failed to start call" });
    }
  });

  app.patch("/api/comms/calls/:id", isAuthenticated, async (req: any, res) => {
    try {
      const { action } = req.body;
      const userId = getUserId(req);
      const userName = req.user?.dbUser?.username ?? userId;
      const existing = await commsStorage.getCallById(req.params.id);
      if (!existing) return res.status(404).json({ error: "Call not found" });
      const isMember = await commsStorage.isChannelMember(existing.channelId, userId);
      if (!isMember) return res.status(403).json({ error: "Not a member of this call's channel" });

      if (action === "join") {
        if (existing.status !== "active") return res.status(410).json({ error: "Call has ended" });
        const call = await commsStorage.addCallParticipant(req.params.id, userId);
        res.json(call ?? existing);
      } else if (action === "leave") {
        const call = await commsStorage.removeCallParticipant(req.params.id, userId);
        res.json(call ?? existing);
      } else if (action === "end") {
        const call = await commsStorage.endCall(req.params.id);
        if (!call) return res.status(404).json({ error: "Call not found" });

        // Stage summary message creation outside the DB hold already done in endCall
        await finalizeEndedCall(call, userId);
        res.json(call);
      } else {
        res.status(400).json({ error: "action must be 'join', 'leave', or 'end'" });
      }
    } catch (err: any) {
      console.error("[Comms] Update call error:", err.message);
      res.status(500).json({ error: "Failed to update call" });
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Call recording access — authenticated, channel-member gated
  // ──────────────────────────────────────────────────────────────────────────
  app.get("/api/comms/calls/:id/recording", isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const call = await commsStorage.getCallById(req.params.id);
      if (!call) return res.status(404).json({ error: "Call not found" });

      const isMember = await commsStorage.isChannelMember(call.channelId, userId);
      if (!isMember) return res.status(403).json({ error: "Not a member of this call's channel" });

      if (call.recordingStatus !== "completed" || !call.recordingObjectKey) {
        const status = call.recordingStatus ?? "not_available";
        return res.status(404).json({ error: "Recording not available", status });
      }

      let file;
      try {
        file = await objectStorage.getPrivateObjectFileByKey(call.recordingObjectKey);
      } catch {
        return res.status(404).json({ error: "Recording file not found in storage" });
      }

      res.set("Content-Disposition", `attachment; filename="call-${call.id}.mp4"`);
      await objectStorage.downloadObject(file, res, 3600);
    } catch (err: any) {
      console.error("[Comms] Recording access error:", err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to retrieve recording" });
      }
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // LiveKit room webhook (Task #3132)
  //
  // LiveKit Cloud POSTs room lifecycle events here with Content-Type
  // `application/webhook+json` and a signed JWT in the Authorization header
  // (the token embeds a sha256 hash of the raw body). We verify via the SDK's
  // WebhookReceiver, which needs the RAW body string — the global express.json
  // parser skips this content type, so a route-level express.raw captures it.
  //
  // On room_finished: if the matching comms_calls row is still `active`
  // (everyone left without pressing "End for everyone"), end it server-side
  // and broadcast comms:call status=ended so all clients clear their state.
  // egress_started: captures the egress ID on the call row.
  // egress_ended: mirrors the MP4 from the transit S3 bucket to Replit
  //   private object storage (async, non-blocking webhook response), then
  //   posts a "Recording ready" system message.
  // No session auth — the signature IS the auth; unverifiable requests
  // get 401 (fail closed).
  // ──────────────────────────────────────────────────────────────────────────
  app.post(
    "/api/comms/webhook/livekit",
    express.raw({ type: "application/webhook+json" }),
    async (req: any, res) => {
      try {
        const apiKey = process.env.LIVEKIT_API_KEY;
        const apiSecret = process.env.LIVEKIT_API_SECRET;
        if (!apiKey || !apiSecret) {
          return res.status(503).json({ error: "LiveKit not configured" });
        }

        // Raw body: route-level express.raw gives a Buffer for
        // application/webhook+json; fall back to the global json parser's
        // captured rawBody for any other content type.
        const rawBody: string | null = Buffer.isBuffer(req.body)
          ? req.body.toString("utf8")
          : Buffer.isBuffer(req.rawBody)
            ? req.rawBody.toString("utf8")
            : null;
        if (!rawBody) {
          return res.status(400).json({ error: "Missing body" });
        }

        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore -- livekit-server-sdk is optional; route 401s if verification fails
        const { WebhookReceiver } = await import("livekit-server-sdk");
        const receiver = new WebhookReceiver(apiKey, apiSecret);

        let event: any;
        try {
          event = await receiver.receive(rawBody, req.get("Authorization"));
        } catch (verifyErr: any) {
          console.warn(
            "[Comms] LiveKit webhook signature verification failed:",
            verifyErr?.message,
          );
          return res.status(401).json({ error: "Invalid webhook signature" });
        }

        const eventType: string = event?.event ?? "";

        // ── egress_started: capture egress ID so we can correlate with the ended event ──
        if (eventType === "egress_started") {
          const egressId: string = event?.egressInfo?.egressId ?? "";
          const eRoom: string = event?.egressInfo?.roomName ?? "";
          if (egressId && eRoom) {
            try {
              const eCall = await commsStorage.getCallByRoomName(eRoom);
              if (eCall?.recordingTransitKey) {
                await commsStorage.updateCallRecording(eCall.id, {
                  recordingEgressId: egressId,
                  recordingStatus: "recording",
                });
                console.log(`[Comms] Recording started for call ${eCall.id} (egress ${egressId})`);
              }
            } catch (e: any) {
              console.error("[Comms] egress_started handler error:", e?.message);
            }
          }
          return res.status(200).json({ ok: true });
        }

        // ── egress_ended: mirror MP4 from transit S3 → Replit private storage ──
        if (eventType === "egress_ended") {
          const egressId: string = event?.egressInfo?.egressId ?? "";
          const eRoom: string = event?.egressInfo?.roomName ?? "";
          const fileResult = event?.egressInfo?.fileResults?.[0];

          if (!eRoom) return res.status(200).json({ ok: true });

          let eCall: Awaited<ReturnType<typeof commsStorage.getCallByRoomName>>;
          try {
            eCall = await commsStorage.getCallByRoomName(eRoom);
          } catch (e: any) {
            console.error("[Comms] egress_ended DB lookup error:", e?.message);
            return res.status(200).json({ ok: true });
          }
          if (!eCall?.recordingTransitKey) return res.status(200).json({ ok: true });

          const durNs = fileResult?.duration ? Number(BigInt(fileResult.duration)) : 0;
          const sizeBytesRaw = fileResult?.size ? Number(BigInt(fileResult.size)) : 0;
          const durSeconds = durNs > 0 ? Math.round(durNs / 1_000_000_000) : undefined;
          const sizeBytes = sizeBytesRaw > 0 ? Math.min(sizeBytesRaw, 2147483647) : undefined;

          // Mark completing immediately so the UI can reflect in-progress state
          await commsStorage.updateCallRecording(eCall.id, {
            recordingEgressId: egressId || undefined,
            recordingStatus: "completing",
            recordingDurationSeconds: durSeconds,
            recordingFileSizeBytes: sizeBytes,
          }).catch((e: any) => console.error("[Comms] egress_ended status update error:", e?.message));

          // Mirror asynchronously — return 200 to LiveKit without waiting for the upload
          const capturedCall = eCall;
          void (async () => {
            try {
              const { objectKey, fileSizeBytes: mirrored } = await mirrorRecordingFromTransit({
                transitKey: capturedCall.recordingTransitKey!,
                callId: capturedCall.id,
              });

              const recMsg = await commsStorage.createMessage({
                channelId: capturedCall.channelId,
                userId: null,
                content: "🎙️ Call recording is ready.",
                contentType: "system",
                metadata: { type: "call_recording_ready", callId: capturedCall.id },
              });

              await commsStorage.updateCallRecording(capturedCall.id, {
                recordingStatus: "completed",
                recordingObjectKey: objectKey,
                recordingFileSizeBytes:
                  mirrored !== null ? Math.min(mirrored, 2147483647) : sizeBytes,
                recordingCompletedAt: new Date(),
                recordingSystemMessageId: recMsg.id,
              });

              console.log(`[Comms] Recording mirrored for call ${capturedCall.id} → ${objectKey}`);

              // Best-effort transit cleanup — failure is non-fatal
              void deleteTransitObject(capturedCall.recordingTransitKey!).catch((e: any) =>
                console.warn("[Comms] Transit object delete failed:", e?.message),
              );
            } catch (e: any) {
              console.error(
                `[Comms] Recording mirror FAILED for call ${capturedCall.id}:`,
                e?.message,
              );
              try {
                await commsStorage.createMessage({
                  channelId: capturedCall.channelId,
                  userId: null,
                  content: `⚠️ Call recording failed: ${String(e?.message ?? "unknown error").slice(0, 120)}`,
                  contentType: "system",
                  metadata: { type: "call_recording_failed", callId: capturedCall.id },
                });
              } catch {
                /* non-fatal */
              }
              await commsStorage
                .updateCallRecording(capturedCall.id, {
                  recordingStatus: "failed",
                  recordingError: String(e?.message || e).slice(0, 256),
                })
                .catch(() => {});
            }
          })();

          return res.status(200).json({ ok: true });
        }

        if (eventType !== "room_finished") {
          // Acknowledge everything else (room_started, participant_joined, …)
          return res.status(200).json({ ok: true });
        }

        const roomName: string | undefined = event?.room?.name;
        if (!roomName) return res.status(200).json({ ok: true });

        const call = await commsStorage.getCallByRoomName(roomName);
        if (!call || call.status !== "active") {
          // Unknown room or already ended (e.g. someone pressed End) — idempotent no-op.
          return res.status(200).json({ ok: true });
        }

        const ended = await commsStorage.endCall(call.id);
        if (ended) {
          await finalizeEndedCall(ended, "livekit_webhook");
          console.log(
            `[Comms] LiveKit room_finished auto-ended call ${ended.id} (room ${roomName})`,
          );
        }
        res.status(200).json({ ok: true });
      } catch (err: any) {
        console.error("[Comms] LiveKit webhook error:", err.message);
        res.status(500).json({ error: "Webhook processing failed" });
      }
    },
  );

}
