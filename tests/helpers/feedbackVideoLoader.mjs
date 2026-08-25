// Node ESM resolve hook for the feedback video upload + auto-analysis
// regression test. It redirects, ONLY for imports made by
// `server/services/feedbackVideoProcessing.ts` (the sole importer of all three
// in this test's module graph), the following modules to minimal in-memory
// stubs so the test drives video indexing deterministically without hitting
// the real TwelveLabs API or Replit Object Storage:
//
//   server/services/videoAnalysis                           → feedbackVideoStub.mjs
//   server/replit_integrations/object_storage/objectStorage → feedbackVideoObjectStorageStub.mjs
//   server/replit_integrations/object_storage/audit         → feedbackVideoAuditStub.mjs
//
// Scoping the redirect to feedbackVideoProcessing's own parentURL means the
// REAL, side-effectful modules are never evaluated in this process (notably
// `objectStorage.ts`'s top-level `new Storage(...)` GCS client, which would
// otherwise keep a live handle and prevent clean process exit). The stubs are
// minimal — they do NOT `export *` the real modules — so nothing heavy loads.
//
// Registered via `--import ./tests/helpers/feedbackVideoSetup.mjs` so it is
// active before the test file (and feedbackVideoProcessing) evaluates.

const PARENT_RE = /\/server\/services\/feedbackVideoProcessing\.[tj]s$/;

const REDIRECTS = [
  {
    re: /\/server\/services\/videoAnalysis\.[tj]s$/,
    stubUrl: new URL("./feedbackVideoStub.mjs", import.meta.url).href,
  },
  {
    re: /\/server\/replit_integrations\/object_storage\/objectStorage\.[tj]s$/,
    stubUrl: new URL("./feedbackVideoObjectStorageStub.mjs", import.meta.url)
      .href,
  },
  {
    re: /\/server\/replit_integrations\/object_storage\/audit\.[tj]s$/,
    stubUrl: new URL("./feedbackVideoAuditStub.mjs", import.meta.url).href,
  },
];

export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (resolved?.url && PARENT_RE.test(context.parentURL ?? "")) {
    for (const { re, stubUrl } of REDIRECTS) {
      if (re.test(resolved.url)) {
        return { url: stubUrl, shortCircuit: true, format: "module" };
      }
    }
  }
  return resolved;
}
