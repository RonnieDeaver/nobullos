/**
 * useDesktopNotifications — browser Notification API integration for NoBull Comms.
 *
 * Behaviour:
 * - When the tab is NOT focused: shows a desktop notification for qualifying events.
 * - When the tab IS focused: plays a subtle sound instead.
 * - DND (effectiveStatus === "dnd") suppresses both.
 * - Muted channels are always silent.
 * - Notification click focuses the tab and navigates to the channel + message.
 *
 * The hook registers itself as an SSE listener via addSseListener from CommsContext.
 * It does NOT open its own SSE connection.
 */

import { useCallback, useEffect, useRef } from "react";
import { useLocation } from "wouter";
import { resolveEffectiveNotifDecision, contentMatchesKeywords } from "@shared/commsNotifResolution";
import type { CommsUserNotificationSettings } from "./types";
import type { CommsChannel } from "./types";
import { stripFormatting } from "./helpers";

// ─── Web Audio tone generator ─────────────────────────────────────────────────
// Generates a soft two-tone chime using the Web Audio API; no external file needed.

let audioCtx: AudioContext | null = null;
let unlockListenerInstalled = false;

/** Install a one-time user-gesture listener that resumes a suspended AudioContext.
 *  Firefox (and some Chromium configs) keep the context "suspended" until the
 *  first interaction; this unlocks Web Audio as soon as the user clicks or types. */
function installUnlockListener(): void {
  if (unlockListenerInstalled || typeof window === "undefined") return;
  unlockListenerInstalled = true;
  const unlock = () => {
    if (audioCtx && audioCtx.state === "suspended") {
      audioCtx.resume().catch(() => {});
    }
    if (audioCtx && audioCtx.state !== "suspended") {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
      unlockListenerInstalled = false;
    }
  };
  window.addEventListener("pointerdown", unlock);
  window.addEventListener("keydown", unlock);
}

function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined" || !window.AudioContext) return null;
  if (!audioCtx) {
    try {
      audioCtx = new AudioContext();
    } catch {
      return null;
    }
  }
  if (audioCtx.state === "suspended") installUnlockListener();
  return audioCtx;
}

// ─── HTMLAudio fallback (inline base64 WAV) ──────────────────────────────────
// Used when Web Audio is unavailable or blocked. The WAV bytes are synthesized
// once per sound choice in JS and encoded to a data: URI — no static files.

const fallbackAudioCache = new Map<string, HTMLAudioElement>();

function buildFallbackWavDataUri(
  choice: CommsUserNotificationSettings["soundChoice"],
): string | null {
  if (typeof window === "undefined" || typeof btoa !== "function") return null;

  const sampleRate = 22050;
  const tones: { freq: number; start: number; end: number }[] = (() => {
    switch (choice) {
      case "ding":
        return [{ freq: 880, start: 0, end: 0.4 }];
      case "subtle":
        return [{ freq: 523, start: 0, end: 0.15 }];
      default:
        return [
          { freq: 523, start: 0, end: 0.18 },
          { freq: 659, start: 0.12, end: 0.3 },
        ];
    }
  })();

  const duration = Math.max(...tones.map((t) => t.end)) + 0.05;
  const numSamples = Math.ceil(duration * sampleRate);
  const samples = new Float32Array(numSamples);

  for (const { freq, start, end } of tones) {
    const s0 = Math.floor(start * sampleRate);
    const s1 = Math.min(numSamples, Math.floor(end * sampleRate));
    const len = s1 - s0;
    for (let i = s0; i < s1; i++) {
      const t = (i - s0) / sampleRate;
      const pos = (i - s0) / len;
      // Quick attack, exponential-ish decay — mirrors the Web Audio envelope.
      const attack = Math.min(1, pos / 0.05);
      const decay = Math.pow(1 - pos, 1.8);
      samples[i] += Math.sin(2 * Math.PI * freq * t) * 0.18 * attack * decay;
    }
  }

  // 16-bit PCM mono WAV
  const dataSize = numSamples * 2;
  const buf = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buf);
  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);
  for (let i = 0; i < numSamples; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, Math.round(v * 32767), true);
  }

  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return `data:audio/wav;base64,${btoa(binary)}`;
}

function playFallbackSound(choice: CommsUserNotificationSettings["soundChoice"]): void {
  if (typeof Audio !== "function") return;
  try {
    let audio = fallbackAudioCache.get(choice);
    if (!audio) {
      const uri = buildFallbackWavDataUri(choice);
      if (!uri) return;
      audio = new Audio(uri);
      fallbackAudioCache.set(choice, audio);
    }
    audio.currentTime = 0;
    void audio.play().catch(() => {});
  } catch {
    /* best-effort */
  }
}

// ─── Playback support state (used by NotificationSettingsPanel) ──────────────

export type SoundPlaybackState =
  | "ready" // Web Audio available and running
  | "needs-interaction" // Web Audio present but suspended until a user gesture
  | "fallback" // Web Audio unavailable — HTMLAudio fallback will be used
  | "unsupported"; // no audio playback available at all

export function getSoundPlaybackState(): SoundPlaybackState {
  if (typeof window === "undefined") return "unsupported";
  const hasHtmlAudio = typeof Audio === "function";
  if (!window.AudioContext) return hasHtmlAudio ? "fallback" : "unsupported";
  const ctx = getAudioContext();
  if (!ctx) return hasHtmlAudio ? "fallback" : "unsupported";
  return ctx.state === "suspended" ? "needs-interaction" : "ready";
}

/** Subscribe to AudioContext state changes (e.g. suspended → running after a
 *  user gesture). Returns an unsubscribe function. */
export function subscribeSoundPlaybackState(cb: () => void): () => void {
  const ctx = getAudioContext();
  if (!ctx) return () => {};
  ctx.addEventListener("statechange", cb);
  return () => ctx.removeEventListener("statechange", cb);
}

export function playNotificationSound(
  choice: CommsUserNotificationSettings["soundChoice"],
): void {
  const ctx = getAudioContext();
  if (!ctx) {
    // Web Audio unavailable (or construction failed) — use HTMLAudio fallback.
    playFallbackSound(choice);
    return;
  }

  // Resume context if suspended (browser autoplay policy). Kick off the resume,
  // but still try the HTMLAudio fallback so this event isn't silently dropped.
  if (ctx.state === "suspended") {
    ctx.resume().catch(() => {});
    if (ctx.state === "suspended") {
      playFallbackSound(choice);
      return;
    }
  }

  try {
    const now = ctx.currentTime;
    const gain = ctx.createGain();
    gain.connect(ctx.destination);

    const configs: { freq: number; start: number; end: number }[] = (() => {
      switch (choice) {
        case "ding":
          return [{ freq: 880, start: now, end: now + 0.4 }];
        case "subtle":
          return [{ freq: 523, start: now, end: now + 0.15 }];
        default: // "default"
          return [
            { freq: 523, start: now, end: now + 0.18 },
            { freq: 659, start: now + 0.12, end: now + 0.30 },
          ];
      }
    })();

    for (const { freq, start, end } of configs) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, start);
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.18, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, end);
      osc.connect(gain);
      osc.start(start);
      osc.stop(end);
    }
  } catch {
    /* best-effort */
  }
}

// ─── Active notification registry ─────────────────────────────────────────────
// Keep at most one open Notification per channel so we don't flood.
const openNotifs = new Map<string, Notification>();

// ─── Hook ─────────────────────────────────────────────────────────────────────

export interface UseDesktopNotificationsOptions {
  settings: CommsUserNotificationSettings | null;
  channels: CommsChannel[];
  myUserId: string | null;
  isDndActive: boolean;
  addSseListener: (fn: (e: MessageEvent) => void) => () => void;
}

export function useDesktopNotifications({
  settings,
  channels,
  myUserId,
  isDndActive,
  addSseListener,
}: UseDesktopNotificationsOptions) {
  const [, navigate] = useLocation();

  // Keep mutable refs so the SSE callback always sees the latest values
  // without needing re-subscription.
  const settingsRef = useRef(settings);
  const channelsRef = useRef(channels);
  const myUserIdRef = useRef(myUserId);
  const isDndRef = useRef(isDndActive);

  useEffect(() => { settingsRef.current = settings; }, [settings]);
  useEffect(() => { channelsRef.current = channels; }, [channels]);
  useEffect(() => { myUserIdRef.current = myUserId; }, [myUserId]);
  useEffect(() => { isDndRef.current = isDndActive; }, [isDndActive]);

  // Store navigate in a ref so the SSE callback doesn't go stale
  const navigateRef = useRef(navigate);
  useEffect(() => { navigateRef.current = navigate; }, [navigate]);

  const handleEvent = useCallback((e: MessageEvent) => {
    const s = settingsRef.current;
    if (!s) return;

    let data: any;
    try { data = JSON.parse(e.data); } catch { return; }
    if (data?.type !== "comms:message") return;

    const message = data.message;
    if (!message) return;

    // Don't notify for own messages
    if (message.userId && message.userId === myUserIdRef.current) return;
    // Don't notify for system messages
    if (message.contentType === "system") return;

    const channelId: string = data.channelId;
    const channel = channelsRef.current.find((c) => c.id === channelId);
    if (!channel) return;

    const content: string = message.content ?? "";
    const isDm = channel.type === "dm" || channel.type === "group_dm";
    const channelPref = channel.notifPref ?? null;

    // Detect whether this message is a mention/keyword for the current user
    const mentionPattern = /@\[([^\]]+)\]\(user:([^)]+)\)/g;
    let isMention = false;
    let match;
    while ((match = mentionPattern.exec(content)) !== null) {
      if (match[2] === myUserIdRef.current) { isMention = true; break; }
    }
    const isKeyword = !isMention && contentMatchesKeywords(content, s.keywords ?? []);
    const isMentionOrKeyword = isMention || isKeyword;

    const decision = resolveEffectiveNotifDecision({
      channelPref: channelPref as any,
      globalDefault: s.globalDefault,
      isDndActive: isDndRef.current,
      isMentionOrKeyword,
      isDmChannel: isDm,
    });

    if (decision === "suppress" || decision === "quiet") return;

    // ── Determine sender name ────────────────────────────────────────────────
    const u = message.user;
    const senderName = u
      ? [u.firstName, u.lastName].filter(Boolean).join(" ") || u.id?.slice(0, 8) || "Someone"
      : "Someone";

    // ── Channel display name ─────────────────────────────────────────────────
    const chName = channel.name ?? channelId.slice(0, 8);

    // ── Snippet — suppress for private channels if configured ────────────────
    const isPrivate = channel.visibility === "private" || isDm;
    const snippet =
      s.suppressSnippetPrivate && isPrivate
        ? "(private message)"
        : stripFormatting(content).slice(0, 80);

    const tabFocused = !document.hidden;

    if (tabFocused) {
      // Tab is focused — play sound only
      if (s.soundEnabled) {
        playNotificationSound(s.soundChoice);
      }
      return;
    }

    // Tab is unfocused — try desktop notification
    if (s.desktopEnabled && "Notification" in window && Notification.permission === "granted") {
      // Close any previous notification for this channel
      openNotifs.get(channelId)?.close();

      const notif = new Notification(senderName, {
        body: isDm ? snippet : `#${chName}: ${snippet}`,
        tag: `comms-${channelId}`,
        // Task #4618: crimson bull identity mark (192px raster — notification
        // renderers want a real bitmap; the old "/favicon.ico" never existed,
        // so notifications showed the missing-icon fallback).
        icon: "/brand/nobull-icon-crimson-192.png",
      });

      notif.onclick = () => {
        window.focus();
        const messageId: string | undefined = message.id;
        navigateRef.current(
          messageId
            ? `/comms?channel=${channelId}&message=${messageId}`
            : `/comms?channel=${channelId}`,
        );
        notif.close();
        openNotifs.delete(channelId);
      };

      notif.onclose = () => { openNotifs.delete(channelId); };
      openNotifs.set(channelId, notif);
    } else if (s.soundEnabled) {
      // Desktop blocked or not enabled — fall back to sound
      playNotificationSound(s.soundChoice);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps — all state via refs

  useEffect(() => {
    return addSseListener(handleEvent);
  }, [addSseListener, handleEvent]);
}

/**
 * Request browser notification permission and return the resulting state.
 * Resolves to "granted" | "denied" | "default".
 */
export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (!("Notification" in window)) return "denied";
  if (Notification.permission !== "default") return Notification.permission;
  return Notification.requestPermission();
}

/** Returns current browser notification permission, or "denied" if unsupported. */
export function getNotificationPermission(): NotificationPermission {
  if (!("Notification" in window)) return "denied";
  return Notification.permission;
}
