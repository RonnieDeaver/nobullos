// Stub for server/services/adsOs/store.ts (see ads-os-pyramid-hooks.mjs).
// Shadows only pyramidBreakdownStore with an in-memory doc map (local export
// wins over the star re-export); every other collection stays the real module.
export * from "../../server/services/adsOs/store";

const g = (): any => ((globalThis as any).__pyrTest ??= {});

export const pyramidBreakdownStore = {
  async get(key: string): Promise<any | null> {
    return (g().store ?? {})[key] ?? null;
  },
  async put(key: string, data: any): Promise<void> {
    (g().store ??= {})[key] = data;
  },
};
