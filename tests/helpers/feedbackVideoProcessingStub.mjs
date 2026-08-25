// Stub for `server/services/feedbackVideoProcessing` used by the feedback
// video restart-resume sweep test (`tests/feedback-video-resume.test.ts`).
//
// The resume sweep (`feedbackVideoResume.ts`) re-drives a stuck row through a
// DYNAMIC `await import("./feedbackVideoProcessing")` and calls
// `processFeedbackVideos(feedbackId, paths, userId, { resumeAttempt })`. The
// REAL processor downloads the attachment, submits it to TwelveLabs, and polls
// for up to ~1h — none of which can run in a test. The companion resolve hook
// (`feedbackVideoProcessingLoader.mjs`) redirects every import of
// `feedbackVideoProcessing` to THIS module so the test can drive the re-drive
// outcome deterministically and assert the `resumeAttempt` the sweep threads.
//
// We re-export the REAL module untouched (so `isVideoAttachmentPath`,
// `FeedbackVideoAnalysis`, and every other binding any importer needs keep
// their real implementations) and override ONLY `processFeedbackVideos` with a
// test-configurable impl. The loader passes through the stub's own re-export of
// the real module (it keys on `context.parentURL`) so this does not redirect
// onto itself.
export * from "../../server/services/feedbackVideoProcessing";

let impl = null;
const calls = [];

export async function processFeedbackVideos(feedbackId, attachmentPaths, userId, opts) {
  calls.push({ feedbackId, attachmentPaths, userId, opts: opts ?? null });
  if (typeof impl !== "function") {
    throw new Error(
      "[feedbackVideoProcessingStub] processFeedbackVideos called but no impl configured — call __setProcessImpl first",
    );
  }
  return impl(feedbackId, attachmentPaths, userId, opts);
}

/**
 * Set the function backing the stubbed `processFeedbackVideos`. It receives
 * `(feedbackId, attachmentPaths, userId, opts)` and may write to the DB to
 * simulate the processor's effect on the row's `video_analysis` (e.g. mark it
 * `ready`, or leave it `processing` to simulate another restart-orphan).
 */
export function __setProcessImpl(fn) {
  impl = fn;
}

export function __getProcessCalls() {
  return calls.slice();
}

export function __resetProcessStub() {
  impl = null;
  calls.length = 0;
}
