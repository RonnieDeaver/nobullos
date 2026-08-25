// Stub for server/services/adsOs/keywordIntel/suggest.ts (see
// ads-os-ki-hooks.mjs). Shadows the OpenAI review; the verbatim prompt builder
// stays real via the re-export.
export * from "../../server/services/adsOs/keywordIntel/suggest";

const g = (): any => ((globalThis as any).__kiTest ??= {});

export async function suggestNegatives(...args: any[]): Promise<[any[], string[]]> {
  const impl = g().suggestImpl;
  if (!impl) throw new Error("__kiTest.suggestImpl not seeded");
  return impl(...args);
}
