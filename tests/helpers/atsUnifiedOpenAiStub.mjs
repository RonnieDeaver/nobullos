// Stub for `server/services/ai/openAiClient` used by
// `tests/ats-unified-reeval-failure-run.test.ts`.
//
// `server/services/atsUnifiedScoring.ts` builds a module-local OpenAI client
// at eval time (`const openai = createDefaultOpenAiClient()`), so there is no
// runtime singleton the test could mutate. The companion resolve hook
// (`atsUnifiedOpenAiLoader.mjs`) redirects every import of the canonical
// OpenAI adapter to THIS module, which keeps every other export real
// (`export *`) and overrides ONLY `createDefaultOpenAiClient` to return a
// fake client whose `chat.completions.create` delegates to a test-settable
// impl. The impl lives on globalThis so any module instance boundary (tsx
// .ts vs .mjs graphs) still observes the configured behavior.
export * from "../../server/services/ai/openAiClient";

export function createDefaultOpenAiClient() {
  return {
    chat: {
      completions: {
        create: async (...args) => {
          const impl = globalThis.__atsUnifiedOpenAiCreateImpl;
          if (typeof impl !== "function") {
            throw new Error(
              "[atsUnifiedOpenAiStub] chat.completions.create called with no impl configured — call __setChatCompletionsCreate first",
            );
          }
          return impl(...args);
        },
      },
    },
  };
}

export function __setChatCompletionsCreate(fn) {
  globalThis.__atsUnifiedOpenAiCreateImpl = fn;
}

export function __resetChatCompletionsCreate() {
  globalThis.__atsUnifiedOpenAiCreateImpl = null;
}
