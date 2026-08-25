// Stub for the `openai` npm package (see ads-os-pyramid-hooks.mjs).
//
// The REAL openAiHelper/ai.ts logic (strip-and-retry on parameter-rejection
// 400s, truncation/refusal/parse checks, model-not-found fallback) runs
// unchanged on top of this fake transport: every chat.completions.create call
// is delegated to globalThis.__pyrOpenAiCreate so the test can route responses
// by response_format.json_schema.name and simulate API rejections.
export default class OpenAI {
  chat = {
    completions: {
      create: async (kwargs: any): Promise<any> => {
        const fn = (globalThis as any).__pyrOpenAiCreate;
        if (typeof fn !== "function") {
          throw new Error("__pyrOpenAiCreate not set — seed the OpenAI stub before running");
        }
        return fn(kwargs);
      },
    },
  };

  constructor(_opts?: any) {}
}
