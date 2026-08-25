// Test stub for client/src/hooks/useTwilioDevice (Task #4490).
//
// The real hook instantiates the Twilio Voice JS SDK Device (browser-only).
// This stub exposes the same result shape with a test-drivable
// `incomingCall`: the suite calls
// `globalThis.__TEST_TWILIO_DEVICE.setIncomingCall({...})` inside act() and
// every mounted useTwilioDevice consumer re-renders via
// useSyncExternalStore — exactly the transition the hub's Task #4373
// onIncomingCall effect watches.

import * as React from "react";

let incoming = null;
const listeners = new Set();

globalThis.__TEST_TWILIO_DEVICE = {
  setIncomingCall(call) {
    incoming = call;
    for (const l of Array.from(listeners)) l();
  },
};

const subscribe = (l) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const getSnapshot = () => incoming;

// Stable function identities so effects keyed on them don't re-fire.
const noop = () => {};
const noopAsync = async () => {};
const rejectIncoming = () => globalThis.__TEST_TWILIO_DEVICE.setIncomingCall(null);

export function useTwilioDevice() {
  const incomingCall = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return {
    status: "ready",
    error: null,
    isMuted: false,
    callDurationMs: 0,
    connect: noopAsync,
    disconnect: noop,
    toggleMute: noop,
    isReady: true,
    incomingCall,
    acceptIncoming: noop,
    rejectIncoming,
  };
}
