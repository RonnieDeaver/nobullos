// Test-only stub for `@/contexts/CommsContext`, wired via
// `tests/comms-popup-narrow-viewport-loader.mjs`. The real provider drags in
// SSE wiring and auth; the popup layout under test only needs the handful of
// fields CommsPopupManager/CommsPopup read. The test file populates
// `globalThis.__COMMS_POPUP_TEST_CTX` before importing the component.

export function useCommsContext() {
  const ctx = globalThis.__COMMS_POPUP_TEST_CTX;
  if (!ctx) {
    throw new Error(
      "comms-popup-narrow-viewport-stub: globalThis.__COMMS_POPUP_TEST_CTX not set",
    );
  }
  return ctx;
}

// Narrow-selector hook (Tasks #3838/#3848): the stub has no store/subscription
// machinery — the tests drive updates via full re-renders — so selecting from
// the current ctx snapshot is behaviorally equivalent.
export function useCommsSelector(selector) {
  return selector(useCommsContext());
}

export function CommsProvider({ children }) {
  return children;
}
