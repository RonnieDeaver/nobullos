type Preparer = () => Promise<void>;
type SyncPreparer = () => void;

const preparers = new Set<Preparer>();
const syncPreparers = new Set<SyncPreparer>();
const printModeListeners = new Set<(v: boolean) => void>();
let printMode = false;

export function registerHeatmapPrintPreparer(fn: Preparer): () => void {
  preparers.add(fn);
  return () => {
    preparers.delete(fn);
  };
}

export function registerHeatmapPrintSyncPreparer(fn: SyncPreparer): () => void {
  syncPreparers.add(fn);
  return () => {
    syncPreparers.delete(fn);
  };
}

export async function prepareAllHeatmapsForPrint(timeoutMs = 3000): Promise<void> {
  if (preparers.size === 0) return;
  const tasks = Array.from(preparers).map((fn) =>
    Promise.race([
      Promise.resolve().then(() => fn()).catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ])
  );
  await Promise.all(tasks);
}

export function prepareAllHeatmapsForPrintSync(): void {
  syncPreparers.forEach((fn) => {
    try {
      fn();
    } catch {
      // ignore
    }
  });
}

export function setHeatmapPrintMode(v: boolean): void {
  if (printMode === v) return;
  printMode = v;
  printModeListeners.forEach((cb) => {
    try {
      cb(v);
    } catch {
      // ignore listener errors
    }
  });
}

export function getHeatmapPrintMode(): boolean {
  return printMode;
}

export function subscribeHeatmapPrintMode(cb: (v: boolean) => void): () => void {
  printModeListeners.add(cb);
  return () => {
    printModeListeners.delete(cb);
  };
}

export interface RunHeatmapPrintSequenceOptions {
  print: () => void;
  prepareTimeoutMs?: number;
  beforePrintDelayMs?: number;
  afterPrintDelayMs?: number;
}

export async function runHeatmapPrintSequence(
  opts: RunHeatmapPrintSequenceOptions,
): Promise<void> {
  const prepareTimeoutMs = opts.prepareTimeoutMs ?? 3000;
  const beforePrintDelayMs = opts.beforePrintDelayMs ?? 150;
  const afterPrintDelayMs = opts.afterPrintDelayMs ?? 1000;
  try {
    await prepareAllHeatmapsForPrint(prepareTimeoutMs);
  } catch {
    // Never block print on prepare failures.
  }
  setHeatmapPrintMode(true);
  await new Promise<void>((resolve) => setTimeout(resolve, beforePrintDelayMs));
  opts.print();
  await new Promise<void>((resolve) => setTimeout(resolve, afterPrintDelayMs));
  setHeatmapPrintMode(false);
}

// Install global beforeprint / afterprint hooks so that browser-native print
// flows (Cmd+P / Ctrl+P) on pages that render InteractiveHeatmap — e.g. the
// Local Dominance Dashboard and GBP heatmap admin views — also get a print-
// safe PNG snapshot instead of a blank WebGL canvas. Idempotent: safe to call
// from every InteractiveHeatmap mount.
let browserPrintHooksInstalled = false;
export function installHeatmapBrowserPrintHooks(): void {
  if (browserPrintHooksInstalled) return;
  if (typeof window === "undefined") return;
  browserPrintHooksInstalled = true;

  window.addEventListener("beforeprint", () => {
    // Sync preparers must flush their snapshot state into the DOM before the
    // browser captures the page. They use flushSync internally for that.
    prepareAllHeatmapsForPrintSync();
    setHeatmapPrintMode(true);
  });

  window.addEventListener("afterprint", () => {
    setHeatmapPrintMode(false);
  });
}
