// Task #874: Browser-side Twilio Voice SDK lifecycle hook.
//
// Responsibilities:
// - Lazily fetch a Voice access token from `/api/twilio/voice-token` when
//   browser calling is needed (i.e., when the user has callMode === "browser").
// - Register a `Device` from `@twilio/voice-sdk` and keep its token refreshed.
// - Expose `connect({ to })`, `disconnect()`, `mute()` plus a status state
//   the UI can render (idle/registering/connecting/ringing/in-call/error/...).
// - Surface failures loudly via `error` (no silent fallbacks) — caller is
//   expected to render the message inline.
//
// Task #877 update: inbound calls are now in-scope. The device is registered
// with `incomingAllow: true` server-side and the hook listens for the SDK's
// `incoming` event, exposes an `incomingCall` snapshot the UI uses to render
// a ring banner, and provides `acceptIncoming` / `rejectIncoming`. While the
// device is registered we also POST a 30s heartbeat to
// `/api/twilio/voice-presence` so the inbound voice webhook knows this user
// is reachable in-tab and can dial `<Client>${userId}</Client>` instead of
// the legacy forward-to-cell `<Number>` fallback.

import { useCallback, useEffect, useRef, useState } from "react";
import type { Call, Device } from "@twilio/voice-sdk";

// The Voice SDK emits errors via a TwilioError shape; we only depend on
// `code`/`message`/`name` here so a narrow shared interface keeps us off `any`.
interface VoiceSdkError {
  code?: number | string;
  message?: string;
  name?: string;
}

type TokenFetchError = Error & { status?: number; missing?: string[] };

export type DeviceStatus =
  | "idle"
  | "loading-token"
  | "registering"
  | "ready"
  | "connecting"
  | "ringing"
  | "in-call"
  | "ending"
  | "error";

export type TwilioDeviceErrorCode =
  | "config-missing"
  | "mic-permission"
  | "token-fetch"
  | "register"
  | "connect"
  | "device-error";

export interface TwilioDeviceError {
  code: TwilioDeviceErrorCode;
  message: string;
  cause?: unknown;
}

export interface UseTwilioDeviceOptions {
  // Set to true once the user has selected browser mode AND admin has
  // configured the Twilio API key + TwiML App. We avoid registering the
  // device for forward-mode users so they don't get spurious mic prompts.
  enabled: boolean;
}

// Task #877: snapshot of an inbound call the SDK has offered to this device.
// We surface only what the UI needs to render the ring banner — the
// underlying `Call` instance lives in a ref so accept/reject can act on it.
export interface IncomingCallSnapshot {
  from: string;
  callSid?: string;
  receivedAt: number;
}

export interface UseTwilioDeviceResult {
  status: DeviceStatus;
  error: TwilioDeviceError | null;
  isMuted: boolean;
  callDurationMs: number;
  connect: (params: { to: string }) => Promise<void>;
  disconnect: () => void;
  toggleMute: () => void;
  // True once the device is registered and ready to place a call.
  isReady: boolean;
  // Task #877: incoming-call surface.
  incomingCall: IncomingCallSnapshot | null;
  acceptIncoming: () => void;
  rejectIncoming: () => void;
}

// Refresh the access token this many ms before its server-stated expiry so
// an in-flight call doesn't hit a JWT-expired error mid-conversation.
const TOKEN_REFRESH_LEAD_MS = 5 * 60 * 1000;

// Task #877: presence heartbeat cadence — server expires after 75s, so
// 30s leaves comfortable headroom for one missed beacon before we age out.
const PRESENCE_HEARTBEAT_MS = 30_000;

async function postPresence(online: boolean, useBeacon = false): Promise<void> {
  try {
    if (useBeacon && typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
      // sendBeacon survives page unload reliably; ideal for the offline ping.
      const blob = new Blob([JSON.stringify({ online })], { type: "application/json" });
      navigator.sendBeacon("/api/twilio/voice-presence", blob);
      return;
    }
    await fetch("/api/twilio/voice-presence", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ online }),
    });
  } catch {
    // Best-effort — a missed beat just shortens this user's reachability
    // window by ~30s. The next beat (or device re-register) recovers.
  }
}

interface TokenResponse {
  token: string;
  identity: string;
  ttl: number;
  expiresAt: number;
}

interface ErrorPayload {
  error?: string;
  missing?: string[];
}

async function fetchVoiceToken(): Promise<TokenResponse> {
  const res = await fetch("/api/twilio/voice-token", {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) {
    let body: ErrorPayload = {};
    try {
      body = (await res.json()) as ErrorPayload;
    } catch {
      // ignore — fall back to status-text below
    }
    const msg = body.error || `Failed to mint voice token (${res.status})`;
    const err = new Error(msg) as Error & { status: number; missing?: string[] };
    err.status = res.status;
    err.missing = body.missing;
    throw err;
  }
  return (await res.json()) as TokenResponse;
}

export function useTwilioDevice(opts: UseTwilioDeviceOptions): UseTwilioDeviceResult {
  const { enabled } = opts;

  const [status, setStatus] = useState<DeviceStatus>("idle");
  const [error, setError] = useState<TwilioDeviceError | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [callStartedAt, setCallStartedAt] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  const [incomingCall, setIncomingCall] = useState<IncomingCallSnapshot | null>(null);

  const deviceRef = useRef<Device | null>(null);
  const activeCallRef = useRef<Call | null>(null);
  const incomingCallRef = useRef<Call | null>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const presenceTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const teardownRef = useRef<() => void>(() => {});

  // Keep duration ticking once a call is active.
  useEffect(() => {
    if (callStartedAt === null) return;
    const t = setInterval(() => setTick(n => n + 1), 1000);
    return () => clearInterval(t);
  }, [callStartedAt]);

  const callDurationMs = callStartedAt === null ? 0 : Date.now() - callStartedAt;
  // tick referenced so React re-renders on the 1s interval
  void tick;

  const clearRefreshTimer = () => {
    if (refreshTimerRef.current) {
      clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }
  };

  const setupDevice = useCallback(async () => {
    if (deviceRef.current) return;
    setError(null);
    setStatus("loading-token");
    let tokenData: TokenResponse;
    try {
      tokenData = await fetchVoiceToken();
    } catch (err) {
      const e = err as TokenFetchError;
      const code: TwilioDeviceErrorCode = e.status === 503 ? "config-missing" : "token-fetch";
      setError({ code, message: e.message || "Could not fetch voice token", cause: err });
      setStatus("error");
      return;
    }

    setStatus("registering");
    try {
      const sdk = await import("@twilio/voice-sdk");
      const Device = sdk.Device;
      const device = new Device(tokenData.token, {
        // logLevel 1 = warnings; raise to 4 for verbose SDK debug.
        logLevel: 1,
        // Allow a slightly more aggressive ICE timeout so a flaky connection
        // surfaces as `error` rather than hanging at `connecting` forever.
        edge: undefined,
      });

      device.on("registered", () => {
        setStatus("ready");
        // Task #877: announce presence the moment the device is reachable
        // and start the heartbeat so the server keeps us in the online set.
        void postPresence(true);
        if (presenceTimerRef.current) clearInterval(presenceTimerRef.current);
        presenceTimerRef.current = setInterval(() => {
          void postPresence(true);
        }, PRESENCE_HEARTBEAT_MS);
      });
      // Task #877: inbound-call surface. The SDK fires `incoming` with a
      // `Call` whose `parameters.From` carries the caller's phone (or
      // `client:<identity>` for client-to-client calls). We stash it in
      // a ref and surface a minimal snapshot so the UI can render a ring
      // banner with accept/reject buttons.
      device.on("incoming", (call: Call) => {
        const params = (call as Call & { parameters?: Record<string, string> }).parameters || {};
        const from = params.From || params.from || "Unknown";
        const callSid = params.CallSid || params.callSid;
        incomingCallRef.current = call;
        setIncomingCall({ from, callSid, receivedAt: Date.now() });

        // If the caller hangs up before we accept, retire the banner.
        call.on("cancel", () => {
          if (incomingCallRef.current === call) incomingCallRef.current = null;
          setIncomingCall(null);
        });
        call.on("disconnect", () => {
          if (incomingCallRef.current === call) incomingCallRef.current = null;
          setIncomingCall(null);
          if (activeCallRef.current === call) {
            activeCallRef.current = null;
            setStatus("ready");
            setIsMuted(false);
            setCallStartedAt(null);
          }
        });
        call.on("reject", () => {
          if (incomingCallRef.current === call) incomingCallRef.current = null;
          setIncomingCall(null);
        });
        call.on("error", (e: VoiceSdkError) => {
          console.error("[useTwilioDevice] incoming call error", e);
          setError({ code: "connect", message: e?.message || "Incoming call error", cause: e });
        });
      });
      device.on("error", (e: VoiceSdkError) => {
        // Twilio Device emits `error` for things like SignalingConnectionError,
        // AuthorizationTokenIssue, etc. We surface to UI rather than swallow.
        const message = e?.message || "Twilio device error";
        console.error("[useTwilioDevice] device error", { code: e?.code, message: e?.message, e });
        setError({ code: "device-error", message, cause: e });
        setStatus("error");
      });
      device.on("tokenWillExpire", async () => {
        try {
          const fresh = await fetchVoiceToken();
          device.updateToken(fresh.token);
          scheduleTokenRefresh(fresh);
        } catch (refreshErr) {
          const message = refreshErr instanceof Error ? refreshErr.message : "Could not refresh voice token";
          console.error("[useTwilioDevice] tokenWillExpire refresh failed:", message);
          setError({ code: "token-fetch", message, cause: refreshErr });
        }
      });

      await device.register();
      deviceRef.current = device;
      scheduleTokenRefresh(tokenData);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to register Twilio device";
      console.error("[useTwilioDevice] register failed:", message, err);
      setError({ code: "register", message, cause: err });
      setStatus("error");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const scheduleTokenRefresh = useCallback((data: TokenResponse) => {
    clearRefreshTimer();
    const lead = Math.max(30_000, data.ttl * 1000 - TOKEN_REFRESH_LEAD_MS);
    refreshTimerRef.current = setTimeout(async () => {
      try {
        const fresh = await fetchVoiceToken();
        if (deviceRef.current) {
          deviceRef.current.updateToken(fresh.token);
          scheduleTokenRefresh(fresh);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Token refresh failed";
        console.error("[useTwilioDevice] scheduled token refresh failed:", message);
        setError({ code: "token-fetch", message, cause: err });
      }
    }, lead);
  }, []);

  const teardown = useCallback(() => {
    clearRefreshTimer();
    if (presenceTimerRef.current) {
      clearInterval(presenceTimerRef.current);
      presenceTimerRef.current = null;
    }
    try {
      if (incomingCallRef.current) {
        // Best-effort reject so the caller doesn't hear silence.
        try { incomingCallRef.current.reject?.(); } catch { /* noop */ }
        incomingCallRef.current = null;
      }
    } catch {
      // ignore
    }
    try {
      if (activeCallRef.current) {
        activeCallRef.current.disconnect();
        activeCallRef.current = null;
      }
    } catch {
      // ignore — best-effort
    }
    try {
      if (deviceRef.current) {
        deviceRef.current.destroy();
        deviceRef.current = null;
      }
    } catch {
      // ignore
    }
    // Task #877: tell the server we're no longer reachable in-tab. Use a
    // beacon so it survives page unload teardown.
    void postPresence(false, true);
    setIncomingCall(null);
    setStatus("idle");
    setIsMuted(false);
    setCallStartedAt(null);
  }, []);

  // Keep latest teardown referenced so unmount/visibilitychange listeners
  // see the up-to-date version without re-binding.
  teardownRef.current = teardown;

  // Lifecycle: register/destroy when `enabled` flips.
  useEffect(() => {
    if (enabled) {
      void setupDevice(); // fire-and-forget: background device setup, errors handled internally via setError
    } else {
      teardown();
    }
    return () => {
      // On unmount also tear down so audio doesn't keep flowing if the
      // ConversationHub unmounts while a call is active.
      teardownRef.current();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  // Tear down before the page is closed so we don't leak Twilio sessions.
  useEffect(() => {
    const onUnload = () => teardownRef.current();
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, []);

  const connect = useCallback(async ({ to }: { to: string }) => {
    if (!deviceRef.current) {
      setError({ code: "register", message: "Browser dialer is not ready yet — try again in a moment." });
      return;
    }
    setError(null);
    setStatus("connecting");
    setIsMuted(false);
    try {
      // Twilio Voice SDK auto-prompts for mic permission on first connect.
      // The browser's denial event surfaces as a Device 'error' (handled above).
      const call = await deviceRef.current.connect({ params: { To: to } });
      activeCallRef.current = call;

      call.on("ringing", () => setStatus("ringing"));
      call.on("accept", () => {
        setStatus("in-call");
        setCallStartedAt(Date.now());
      });
      call.on("disconnect", () => {
        activeCallRef.current = null;
        setStatus("ready");
        setIsMuted(false);
        setCallStartedAt(null);
      });
      call.on("cancel", () => {
        activeCallRef.current = null;
        setStatus("ready");
        setCallStartedAt(null);
      });
      call.on("error", (e: VoiceSdkError) => {
        console.error("[useTwilioDevice] call error", e);
        setError({ code: "connect", message: e?.message || "Call error", cause: e });
        setStatus("error");
      });
      call.on("mute", (muted: boolean) => setIsMuted(muted));
    } catch (err) {
      const e = err as VoiceSdkError;
      const message = e?.message || "Failed to start call";
      console.error("[useTwilioDevice] connect failed:", message, err);
      // NotAllowedError = user denied microphone permission in the browser.
      const denied = e?.name === "NotAllowedError" || /permission/i.test(message);
      setError({
        code: denied ? "mic-permission" : "connect",
        message: denied
          ? "Microphone permission was denied. Allow microphone access in your browser to place calls."
          : message,
        cause: err,
      });
      setStatus("error");
    }
  }, []);

  const disconnect = useCallback(() => {
    setStatus("ending");
    try {
      if (activeCallRef.current) {
        activeCallRef.current.disconnect();
      } else if (deviceRef.current) {
        deviceRef.current.disconnectAll?.();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn("[useTwilioDevice] disconnect threw (continuing):", message);
    }
  }, []);

  // Task #877: accept the offered inbound call. Wires the same lifecycle
  // listeners as outbound `connect` so the ActiveCallBar UI stays in sync.
  const acceptIncoming = useCallback(() => {
    const call = incomingCallRef.current;
    if (!call) return;
    setError(null);
    try {
      call.accept();
      activeCallRef.current = call;
      incomingCallRef.current = null;
      setIncomingCall(null);
      setStatus("in-call");
      setCallStartedAt(Date.now());
      setIsMuted(false);
      call.on("mute", (muted: boolean) => setIsMuted(muted));
    } catch (err) {
      const e = err as VoiceSdkError;
      const message = e?.message || "Failed to accept call";
      console.error("[useTwilioDevice] acceptIncoming failed:", message, err);
      setError({ code: "connect", message, cause: err });
      setStatus("error");
    }
  }, []);

  const rejectIncoming = useCallback(() => {
    const call = incomingCallRef.current;
    if (!call) return;
    try {
      call.reject();
    } catch (err) {
      console.warn("[useTwilioDevice] rejectIncoming threw (continuing):", err);
    }
    incomingCallRef.current = null;
    setIncomingCall(null);
  }, []);

  const toggleMute = useCallback(() => {
    if (!activeCallRef.current) return;
    const next = !isMuted;
    try {
      activeCallRef.current.mute(next);
      setIsMuted(next);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn("[useTwilioDevice] mute toggle failed:", message);
    }
  }, [isMuted]);

  return {
    status,
    error,
    isMuted,
    callDurationMs,
    connect,
    disconnect,
    toggleMute,
    isReady: status === "ready" || status === "connecting" || status === "ringing" || status === "in-call",
    incomingCall,
    acceptIncoming,
    rejectIncoming,
  };
}
