/**
 * Lightweight stub for every @univerjs/* import used in UniverEditor.tsx.
 *
 * createUniver returns a minimal univerAPI whose createWorkbook gives back
 * an FWorkbook stub with a working `save()` that returns the snapshot passed
 * in.  The onReady callback fires immediately so the page reaches its "ready"
 * state without waiting for real Univer initialisation.
 */

export function createUniver({ presets } = {}) {
  // Run preset factories (they may call onReady via the container arg).
  presets?.forEach((p) => {
    if (typeof p === "function") p({});
  });

  let _snapshot = null;

  const univerAPI = {
    createWorkbook(data) {
      _snapshot = data;
      return {
        save() {
          return _snapshot;
        },
      };
    },
    dispose() {},
  };

  return { univerAPI };
}

export const LocaleType = { EN_US: "en-US" };
export function mergeLocales(...args) {
  return args[0] ?? {};
}

// preset-sheets-core exports
export function UniverSheetsCorePreset(opts) {
  return opts;
}

// Default export (for locales/en-US)
export default {};
