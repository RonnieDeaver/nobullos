// Minimal stub for `server/services/videoAnalysis` used by the feedback video
// upload + auto-analysis regression test
// (`tests/feedback-video-upload-processing.test.ts`).
//
// `processFeedbackVideos` reaches the TwelveLabs-backed video tool through a
// STATIC `import { submitVideo, getJobStatus, getFullAnalysis,
// isTerminalStatus } from "./videoAnalysis"`. The companion resolve hook
// (`feedbackVideoLoader.mjs`) redirects feedbackVideoProcessing's import of
// `videoAnalysis` to THIS module.
//
// Deliberately minimal — it does NOT re-export the real module, so the real
// `videoAnalysis` (and the TwelveLabs client it pulls in) is never evaluated.
// We provide exactly the four bindings feedbackVideoProcessing consumes:
// `submitVideo`/`getJobStatus`/`getFullAnalysis` are test-driven, and
// `isTerminalStatus` is a verbatim copy of the real (pure) predicate.
//
// The test file imports THIS path directly to configure the scenario; the
// production code path resolves to the same singleton via the hook, so the
// configured behavior is observed by `processFeedbackVideos`.

let scenario = null;
let taskCounter = 0;

/**
 * Configure the stubbed indexing run.
 *   {
 *     jobStatus: "ready" | "failed" | "timeout",  // what the poll returns
 *     fullAnalysis: { transcript, summary, scenes, keyMoments } | null,
 *   }
 */
export function __setScenario(next) {
  scenario = next;
}

export function __reset() {
  scenario = null;
}

function requireScenario(fn) {
  if (!scenario) {
    throw new Error(
      `[feedbackVideoStub] ${fn} called but no scenario configured — call __setScenario first`,
    );
  }
  return scenario;
}

// Verbatim copy of the real (pure) predicate in server/services/videoAnalysis.ts.
export function isTerminalStatus(status) {
  return status === "ready" || status === "failed" || status === "timeout";
}

// Mirrors the real `submitVideo` return shape closely enough for the caller,
// which only reads `taskId`. Never touches TwelveLabs or the network.
export async function submitVideo(filePath, ownerUserId) {
  requireScenario("submitVideo");
  taskCounter += 1;
  return {
    taskId: `stub-task-${taskCounter}`,
    indexId: "stub-index",
    ownerUserId,
    status: "pending",
    filePath,
    createdAt: new Date(),
  };
}

// The caller's `waitForJobTerminal` loops on this until `isTerminalStatus` is
// true; returning a terminal status immediately keeps the test fast.
export function getJobStatus(taskId, userId) {
  const s = requireScenario("getJobStatus");
  return {
    taskId,
    indexId: "stub-index",
    ownerUserId: userId,
    status: s.jobStatus,
    filePath: "/tmp/stub",
    createdAt: new Date(),
  };
}

export async function getFullAnalysis(_taskId, _userId) {
  const s = requireScenario("getFullAnalysis");
  return s.fullAnalysis ?? null;
}
