// Stub for `server/routes/middleware` used by the sync-client-options
// route test (Task #3571).
// Re-exports everything from the real middleware, then overrides the `openai`
// singleton with a controllable stub whose `chat.completions.create` reads
// from globalThis.__sdSyncOpenaiResponse.
//
// Set globalThis.__sdSyncOpenaiResponse to:
//   { content: "..." }          → returns that JSON string as the AI response
//   { throw: true }             → throws an error (simulates AI failure)
//   undefined/null              → returns an empty array response

export * from "../server/routes/middleware";

const stubOpenai = {
  chat: {
    completions: {
      create: async (_params) => {
        const ctrl = globalThis.__sdSyncOpenaiResponse;
        if (ctrl?.throw) {
          throw new Error("Stubbed AI failure");
        }
        const content = ctrl?.content ?? "[]";
        return {
          choices: [{ message: { content } }],
        };
      },
    },
  },
};

export const openai = stubOpenai;
