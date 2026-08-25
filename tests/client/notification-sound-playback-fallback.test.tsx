/* test-registration
{
  "name": "Notification sound playback state + HTMLAudio fallback — getSoundPlaybackState fallback/unsupported/needs-interaction/ready, playNotificationSound inline-WAV fallback when Web Audio missing or suspended, panel activation hint + unsupported toggle disable (Task #3408)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3408: notification sound playback state + HTMLAudio fallback — getSoundPlaybackState across fallback/unsupported/needs-interaction/ready, playNotificationSound uses the inline-WAV HTMLAudio fallback when Web Audio is missing or stuck suspended, and NotificationSettingsPanel shows the amber activation hint / disables the toggle appropriately. A regression here silently mutes Firefox/blocked-audio users. Fast, DB-free, network-free jsdom test with fake AudioContext/Audio.",
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #3408 — notification sound playback state + HTMLAudio fallback contracts.
 *
 * Pins the Firefox/blocked-audio behavior added by the "Deliver desktop
 * notification sounds to users on browsers that don't support Web Audio API"
 * task, so a regression can't silently make sounds go quiet again:
 *
 *  A. getSoundPlaybackState():
 *     - no AudioContext, Audio present            → "fallback"
 *     - no AudioContext, no Audio                 → "unsupported"
 *     - AudioContext present but suspended        → "needs-interaction"
 *     - AudioContext running                      → "ready"
 *  B. playNotificationSound() uses the HTMLAudio inline-WAV fallback
 *     (Audio constructed with a data:audio/wav URI and .play() called) when
 *     AudioContext is missing OR stuck suspended after a resume attempt.
 *  C. NotificationSettingsPanel:
 *     - state "needs-interaction" → amber activation hint
 *       (notif-sound-activation-hint) is shown, toggle stays enabled
 *     - state "unsupported" → sound toggle is disabled + unsupported hint shown
 *
 * NOTE ordering matters: getSoundPlaybackState checks window.AudioContext
 * BEFORE consulting the module-level cached context, so scenarios are driven
 * by installing/removing the window.AudioContext + Audio globals and by
 * flipping the fake context's state — no module re-import needed.
 */

import { JSDOM } from "jsdom";

const dom = new JSDOM(
  "<!doctype html><html><body><div id='root'></div></body></html>",
  { pretendToBeVisual: true, url: "http://localhost/comms" },
);
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
(globalThis as any).navigator = dom.window.navigator;
(globalThis as any).HTMLElement = dom.window.HTMLElement;
(globalThis as any).Element = dom.window.Element;
(globalThis as any).Node = dom.window.Node;
(globalThis as any).DocumentFragment = dom.window.DocumentFragment;
(globalThis as any).HTMLButtonElement = dom.window.HTMLButtonElement;
(globalThis as any).HTMLInputElement = dom.window.HTMLInputElement;
(globalThis as any).CustomEvent = dom.window.CustomEvent;
(globalThis as any).MutationObserver = dom.window.MutationObserver;
(globalThis as any).Event = dom.window.Event;
(globalThis as any).MouseEvent = dom.window.MouseEvent;
(globalThis as any).KeyboardEvent = dom.window.KeyboardEvent;
(globalThis as any).history = dom.window.history;
(globalThis as any).location = dom.window.location;
(globalThis as any).getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
(globalThis as any).requestAnimationFrame = (cb: any) => setTimeout(cb, 0);
(globalThis as any).cancelAnimationFrame = (id: any) => clearTimeout(id);
(globalThis as any).dispatchEvent = dom.window.dispatchEvent.bind(dom.window);
(globalThis as any).addEventListener = dom.window.addEventListener.bind(dom.window);
(globalThis as any).removeEventListener = dom.window.removeEventListener.bind(dom.window);
// NOTE: deliberately keep Node's native btoa — jsdom's btoa rejects the
// latin1 WAV byte string with "invalid characters", Node's (and real
// browsers') handles it fine.
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
// Radix Switch/Select internals touch ResizeObserver in some paths.
(globalThis as any).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
(dom.window as any).ResizeObserver = (globalThis as any).ResizeObserver;

// jsdom has no Notification API — the panel reads permission on mount.
class FakeNotification {
  static permission: NotificationPermission = "default";
}
(dom.window as any).Notification = FakeNotification;
(globalThis as any).Notification = FakeNotification;

// ── Fake Web Audio + HTMLAudio APIs ──────────────────────────────────────────

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  state: "suspended" | "running" = "suspended";
  resumeCalls = 0;
  currentTime = 0;
  destination = {};
  private listeners = new Set<() => void>();
  constructor() {
    FakeAudioContext.instances.push(this);
  }
  resume(): Promise<void> {
    this.resumeCalls++;
    // Simulates Firefox refusing to resume without a user gesture:
    // state deliberately STAYS "suspended".
    return Promise.resolve();
  }
  addEventListener(_t: string, cb: () => void) {
    this.listeners.add(cb);
  }
  removeEventListener(_t: string, cb: () => void) {
    this.listeners.delete(cb);
  }
  createGain() {
    return {
      connect() {},
      gain: {
        setValueAtTime() {},
        linearRampToValueAtTime() {},
        exponentialRampToValueAtTime() {},
      },
    };
  }
  createOscillator() {
    return {
      type: "sine",
      frequency: { setValueAtTime() {} },
      connect() {},
      start() {},
      stop() {},
    };
  }
}

interface PlayRecord {
  src: string;
}
const playCalls: PlayRecord[] = [];
class FakeAudio {
  src: string;
  currentTime = 0;
  constructor(src: string) {
    this.src = src;
  }
  play(): Promise<void> {
    playCalls.push({ src: this.src });
    return Promise.resolve();
  }
}

function installAudioContext(): void {
  (dom.window as any).AudioContext = FakeAudioContext;
  (globalThis as any).AudioContext = FakeAudioContext;
}
function removeAudioContext(): void {
  delete (dom.window as any).AudioContext;
  delete (globalThis as any).AudioContext;
}
function installHtmlAudio(): void {
  (dom.window as any).Audio = FakeAudio;
  (globalThis as any).Audio = FakeAudio;
}
function removeHtmlAudio(): void {
  delete (dom.window as any).Audio;
  delete (globalThis as any).Audio;
}

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

// ── Imports after jsdom ───────────────────────────────────────────────────────
const React = (await import("react")).default ?? (await import("react"));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { getSoundPlaybackState, playNotificationSound } = await import(
  "../../client/src/components/comms/useDesktopNotifications"
);
const { NotificationSettingsPanel } = await import(
  "../../client/src/components/comms/NotificationSettingsPanel"
);

const settingsBase = {
  globalDefault: "all" as const,
  soundEnabled: true,
  soundChoice: "default" as const,
  desktopEnabled: false,
  suppressSnippetPrivate: false,
  keywords: [] as string[],
};

async function renderPanel(): Promise<{ container: HTMLElement; unmount: () => Promise<void> }> {
  const container = document.getElementById("root")!;
  const root = createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(NotificationSettingsPanel, {
        settings: settingsBase as any,
        onSave: async () => {},
        saving: false,
        isDndActive: false,
      }),
    );
  });
  return {
    container,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
    },
  };
}

async function main(): Promise<void> {
  // ── A1: no AudioContext, HTMLAudio present → "fallback" ────────────────────
  removeAudioContext();
  installHtmlAudio();
  assert(
    getSoundPlaybackState() === "fallback",
    `no AudioContext + Audio present → "fallback" (got "${getSoundPlaybackState()}")`,
  );
  console.log('  ok  no AudioContext + HTMLAudio → "fallback"');

  // ── A2: no AudioContext, no Audio → "unsupported" ───────────────────────────
  removeHtmlAudio();
  assert(
    getSoundPlaybackState() === "unsupported",
    `no AudioContext + no Audio → "unsupported" (got "${getSoundPlaybackState()}")`,
  );
  console.log('  ok  no AudioContext + no HTMLAudio → "unsupported"');

  // ── B1: playNotificationSound falls back to HTMLAudio when Web Audio missing ─
  installHtmlAudio();
  playCalls.length = 0;
  playNotificationSound("default");
  assert(playCalls.length === 1, `expected 1 fallback play, got ${playCalls.length}`);
  assert(
    playCalls[0].src.startsWith("data:audio/wav;base64,"),
    `fallback Audio constructed with inline WAV data URI (got "${playCalls[0].src.slice(0, 40)}…")`,
  );
  console.log("  ok  missing AudioContext → HTMLAudio fallback plays inline WAV");

  // ── A3: suspended AudioContext → "needs-interaction" ────────────────────────
  installAudioContext();
  assert(
    getSoundPlaybackState() === "needs-interaction",
    `suspended context → "needs-interaction" (got "${getSoundPlaybackState()}")`,
  );
  assert(FakeAudioContext.instances.length === 1, "one AudioContext created and cached");
  const ctx = FakeAudioContext.instances[0];
  console.log('  ok  suspended AudioContext → "needs-interaction"');

  // ── B2: suspended context that won't resume → HTMLAudio fallback ────────────
  playCalls.length = 0;
  playNotificationSound("ding");
  assert(ctx.resumeCalls >= 1, "playNotificationSound attempts ctx.resume() first");
  assert(playCalls.length === 1, `suspended ctx → fallback play (got ${playCalls.length})`);
  assert(
    playCalls[0].src.startsWith("data:audio/wav;base64,"),
    "suspended-context fallback also uses inline WAV data URI",
  );
  console.log("  ok  suspended AudioContext → resume attempted, HTMLAudio fallback plays");

  // ── C1: panel shows amber activation hint when needs-interaction ────────────
  {
    const { container, unmount } = await renderPanel();
    const hint = container.querySelector('[data-testid="notif-sound-activation-hint"]');
    assert(hint, "activation hint rendered when state is needs-interaction");
    assert(
      /interact|click/i.test(hint!.textContent ?? ""),
      "activation hint explains a user gesture is needed",
    );
    const toggle = container.querySelector(
      '[data-testid="notif-sound-toggle"]',
    ) as HTMLButtonElement | null;
    assert(toggle, "sound toggle rendered");
    assert(!toggle!.disabled, "sound toggle stays ENABLED when needs-interaction");
    assert(
      !container.querySelector('[data-testid="notif-sound-unsupported-hint"]'),
      "no unsupported hint when needs-interaction",
    );
    await unmount();
  }
  console.log("  ok  panel needs-interaction → amber activation hint, toggle enabled");

  // ── A4: running context → "ready" ───────────────────────────────────────────
  ctx.state = "running";
  assert(
    getSoundPlaybackState() === "ready",
    `running context → "ready" (got "${getSoundPlaybackState()}")`,
  );
  console.log('  ok  running AudioContext → "ready"');

  // ── C2: panel disables sound toggle when unsupported ────────────────────────
  removeAudioContext();
  removeHtmlAudio();
  assert(getSoundPlaybackState() === "unsupported", "precondition: state is unsupported");
  {
    const { container, unmount } = await renderPanel();
    const toggle = container.querySelector(
      '[data-testid="notif-sound-toggle"]',
    ) as HTMLButtonElement | null;
    assert(toggle, "sound toggle rendered");
    assert(toggle!.disabled, "sound toggle DISABLED when unsupported");
    assert(
      container.querySelector('[data-testid="notif-sound-unsupported-hint"]'),
      "unsupported hint shown",
    );
    assert(
      !container.querySelector('[data-testid="notif-sound-activation-hint"]'),
      "no activation hint when unsupported",
    );
    assert(
      !container.querySelector('[data-testid="notif-sound-test-btn"]'),
      "Test button hidden when unsupported",
    );
    await unmount();
  }
  console.log("  ok  panel unsupported → toggle disabled, unsupported hint shown");

  console.log("All notification-sound playback-state/fallback tests passed");
}

await main();
