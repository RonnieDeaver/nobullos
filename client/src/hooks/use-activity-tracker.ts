import { useEffect, useRef, useCallback } from "react";
import { useLocation } from "wouter";
import { useAuth } from "./use-auth";
import {
  ACTIVITY_FLUSH_INTERVAL_MS,
  ACTIVITY_MAX_EVENTS_PER_FLUSH,
  ACTIVITY_MAX_BUFFERED_EVENTS,
  ACTIVITY_EVENT_COALESCE_WINDOW_MS,
} from "@shared/activityConfig";

type ActivityEvent = {
  actionType: string;
  route?: string;
  actionDetail?: string;
  metadata?: Record<string, unknown>;
  sessionId?: string;
  duration?: number;
  timestamp: string;
};

const SESSION_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

const LOW_VALUE_EVENT_TYPES = new Set(["heartbeat", "ping", "focus", "blur", "idle"]);

let eventQueue: ActivityEvent[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;
let isFlushing = false;
let lastEventByType: Map<string, number> = new Map();
let coalescedCount = 0;

function shouldCoalesce(actionType: string): boolean {
  if (!LOW_VALUE_EVENT_TYPES.has(actionType)) return false;
  const lastTime = lastEventByType.get(actionType);
  const now = Date.now();
  if (lastTime && now - lastTime < ACTIVITY_EVENT_COALESCE_WINDOW_MS) {
    coalescedCount++;
    return true;
  }
  lastEventByType.set(actionType, now);
  return false;
}

function buildPayload(batch: ActivityEvent[]): string {
  const payload: { events: ActivityEvent[]; coalescedCount?: number } = { events: batch };
  if (coalescedCount > 0) {
    payload.coalescedCount = coalescedCount;
  }
  return JSON.stringify(payload);
}

function onFlushSuccess(batchLength: number) {
  eventQueue.splice(0, batchLength);
  coalescedCount = 0;
}

function sendViaFetch(payload: string, batchLength: number) {
  fetch("/api/activity", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payload,
    credentials: "include",
    keepalive: true,
  }).then((res) => {
    if (res.ok) {
      onFlushSuccess(batchLength);
    }
  }).catch(() => {}).finally(() => {
    isFlushing = false;
  });
}

function flush() {
  if (isFlushing || eventQueue.length === 0) return;
  isFlushing = true;
  const batch = eventQueue.slice(0, ACTIVITY_MAX_EVENTS_PER_FLUSH);
  const payload = buildPayload(batch);

  if (typeof navigator.sendBeacon === "function") {
    const sent = navigator.sendBeacon("/api/activity", new Blob([payload], { type: "application/json" }));
    if (sent) {
      onFlushSuccess(batch.length);
      isFlushing = false;
      return;
    }
    sendViaFetch(payload, batch.length);
    return;
  }

  sendViaFetch(payload, batch.length);
}

function enqueue(event: Omit<ActivityEvent, "sessionId" | "timestamp">) {
  if (shouldCoalesce(event.actionType)) return;

  if (eventQueue.length >= ACTIVITY_MAX_BUFFERED_EVENTS) {
    eventQueue.splice(0, eventQueue.length - ACTIVITY_MAX_BUFFERED_EVENTS + 1);
  }

  eventQueue.push({
    ...event,
    sessionId: SESSION_ID,
    timestamp: new Date().toISOString(),
  });

  if (eventQueue.length >= ACTIVITY_MAX_EVENTS_PER_FLUSH) flush();
}

export function logActivity(
  actionType: string,
  detail?: string,
  metadata?: Record<string, unknown>
) {
  enqueue({
    actionType,
    route: typeof window !== "undefined" ? window.location.pathname : undefined,
    actionDetail: detail,
    metadata,
  });
}

export function useActivityTracker() {
  const [location] = useLocation();
  const { user } = useAuth();
  const pageEnteredAt = useRef<number>(Date.now());
  const prevRoute = useRef<string | null>(null);

  const logPageDwell = useCallback(() => {
    if (prevRoute.current) {
      const duration = Math.round((Date.now() - pageEnteredAt.current) / 1000);
      if (duration > 0 && duration < 7200) {
        enqueue({
          actionType: "page_view",
          route: prevRoute.current,
          actionDetail: `Viewed ${prevRoute.current}`,
          duration,
        });
      }
    }
  }, []);

  useEffect(() => {
    if (!user) return;

    if (prevRoute.current !== null && prevRoute.current !== location) {
      logPageDwell();
    }

    prevRoute.current = location;
    pageEnteredAt.current = Date.now();

    enqueue({
      actionType: "navigation",
      route: location,
      actionDetail: `Navigated to ${location}`,
    });
    // `logPageDwell` is a stable useCallback (empty deps).
  }, [location, user, logPageDwell]);

  useEffect(() => {
    if (!user) {
      if (flushTimer) {
        clearInterval(flushTimer);
        flushTimer = null;
      }
      return;
    }

    if (!flushTimer) {
      flushTimer = setInterval(flush, ACTIVITY_FLUSH_INTERVAL_MS);
    }

    const handleVisChange = () => {
      if (document.visibilityState === "hidden") {
        logPageDwell();
        flush();
      }
    };

    const handleBeforeUnload = () => {
      logPageDwell();
      flush();
    };

    document.addEventListener("visibilitychange", handleVisChange);
    window.addEventListener("beforeunload", handleBeforeUnload);

    return () => {
      document.removeEventListener("visibilitychange", handleVisChange);
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [user, logPageDwell]);
}
