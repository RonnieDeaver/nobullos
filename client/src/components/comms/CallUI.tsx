/**
 * NoBull Comms page — call UI.
 * Extracted verbatim from client/src/pages/Comms.tsx (Task #3787 split).
 * EndCallButton, VoiceCallControls, CallView, IncomingCallBanner (LiveKit).
 */

import "@livekit/components-styles";
import { useState, useCallback } from "react";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Phone, PhoneOff, Video, X, Loader2, PhoneIncoming } from "lucide-react";
import {
  LiveKitRoom,
  VideoConference,
  AudioConference,
  ControlBar,
  DisconnectButton,
  RoomAudioRenderer,
  useRoomContext,
} from "@livekit/components-react";
import { type ActiveCallRoom, type IncomingCallInfo } from "./pageTypes";

// ─── Call UI components ───────────────────────────────────────────────────────

function EndCallButton({ callId, onDone }: { callId: string; onDone: () => void }) {
  const room = useRoomContext();
  const [ending, setEnding] = useState(false);

  const handleEnd = async () => {
    setEnding(true);
    try {
      await apiRequest("PATCH", `/api/comms/calls/${callId}`, { action: "end" });
    } catch {
      /* best-effort */
    }
    try { void room.disconnect().catch(() => {}); } catch { /* ignore */ } // fire-and-forget: best-effort leave, errors ignored
    onDone();
  };

  return (
    <Button
      variant="destructive"
      size="sm"
      onClick={handleEnd}
      disabled={ending}
      data-testid="end-call-button"
    >
      {ending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <PhoneOff className="h-4 w-4 mr-1" />}
      End for everyone
    </Button>
  );
}

function VoiceCallControls({ callId, onDone }: { callId: string; onDone: () => void }) {
  const room = useRoomContext();
  const [ending, setEnding] = useState(false);

  const handleLeave = useCallback(() => {
    try { void room.disconnect().catch(() => {}); } catch { /* ignore */ } // fire-and-forget: best-effort leave, errors ignored
  }, [room]);

  const handleEnd = async () => {
    setEnding(true);
    try {
      await apiRequest("PATCH", `/api/comms/calls/${callId}`, { action: "end" });
    } catch {
      /* best-effort */
    }
    try { void room.disconnect().catch(() => {}); } catch { /* ignore */ } // fire-and-forget: best-effort leave, errors ignored
    onDone();
  };

  return (
    <div className="flex items-center gap-2 flex-wrap justify-center">
      <DisconnectButton onClick={handleLeave} data-testid="leave-call-button">
        <PhoneOff className="h-4 w-4 mr-1" />
        Leave call
      </DisconnectButton>
      <Button
        variant="destructive"
        size="sm"
        onClick={handleEnd}
        disabled={ending}
        data-testid="end-call-button-audio"
      >
        {ending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <PhoneOff className="h-4 w-4 mr-1" />}
        End for everyone
      </Button>
    </div>
  );
}

export function CallView({
  callRoom,
  channelName,
  onLeave,
}: {
  callRoom: ActiveCallRoom;
  channelName: string;
  onLeave: () => void;
}) {
  const handleDisconnected = useCallback(() => {
    apiRequest("PATCH", `/api/comms/calls/${callRoom.callId}`, { action: "leave" }).catch(() => {});
    onLeave();
  }, [callRoom.callId, onLeave]);

  const isVoice = callRoom.callType !== "video";

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-background"
      data-testid="call-view"
    >
      <div className="flex items-center justify-between px-4 py-2 bg-muted/50 border-b border-border flex-shrink-0 flex-wrap gap-2">
        <div className="flex items-center gap-2">
          {callRoom.callType === "video" ? (
            <Video className="h-4 w-4 text-primary" />
          ) : (
            <Phone className="h-4 w-4 text-primary" />
          )}
          <span className="font-semibold text-sm">
            {channelName} — {callRoom.callType === "video" ? "Video" : "Voice"} Call
          </span>
          <Badge variant="secondary" className="text-xs bg-green-100 dark:bg-green-950/35 text-green-700 dark:text-green-300">
            Live
          </Badge>
          {callRoom.recordingEnabled && (
            <Badge variant="secondary" className="text-xs bg-red-100 dark:bg-red-950/35 text-red-700 dark:text-red-300" data-testid="call-recording-badge">
              🔴 REC
            </Badge>
          )}
        </div>
        {!isVoice && (
          <LiveKitRoom
            token={callRoom.token}
            serverUrl={callRoom.serverUrl}
            connect={false}
          >
            <EndCallButton callId={callRoom.callId} onDone={onLeave} />
          </LiveKitRoom>
        )}
      </div>
      <div className="flex-1 min-h-0">
        <LiveKitRoom
          token={callRoom.token}
          serverUrl={callRoom.serverUrl}
          connect={true}
          video={callRoom.callType === "video"}
          audio={true}
          onDisconnected={handleDisconnected}
          style={{ height: "100%" }}
        >
          {isVoice ? (
            <div className="flex flex-col h-full">
              <div className="flex-1 min-h-0">
                <AudioConference />
              </div>
              <div className="flex items-center justify-center gap-4 p-4 border-t border-border bg-muted/30 flex-wrap">
                <ControlBar
                  controls={{ microphone: true, screenShare: false, camera: false, chat: false, leave: false }}
                  variation="minimal"
                />
                <VoiceCallControls callId={callRoom.callId} onDone={onLeave} />
              </div>
            </div>
          ) : (
            <>
              <VideoConference />
              <RoomAudioRenderer />
            </>
          )}
        </LiveKitRoom>
      </div>
    </div>
  );
}

export function IncomingCallBanner({
  info,
  onJoin,
  onDismiss,
}: {
  info: IncomingCallInfo;
  onJoin: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      className="fixed top-4 right-4 z-50 bg-background border border-border rounded-lg shadow-lg p-3 flex items-center gap-3 max-w-xs"
      data-testid="incoming-call-banner"
    >
      <div className="flex-shrink-0 h-9 w-9 bg-green-100 dark:bg-green-950/35 rounded-full flex items-center justify-center">
        <PhoneIncoming className="h-5 w-5 text-green-700 dark:text-green-300" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-semibold text-sm text-foreground">
          Incoming {info.callType === "video" ? "video" : "voice"} call
        </div>
        <div className="text-xs text-muted-foreground truncate">in {info.channelName}</div>
      </div>
      <div className="flex items-center gap-1 flex-shrink-0">
        <Button
          size="sm"
          className="bg-green-600 hover:bg-green-700 text-white h-8 px-3"
          onClick={onJoin}
          data-testid="incoming-call-join"
        >
          Join
        </Button>
        <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={onDismiss} data-testid="incoming-call-dismiss">
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

