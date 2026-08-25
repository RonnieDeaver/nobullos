// Entry passed via `tsx --import` so the resolve hook in
// `feedbackVideoLoader.mjs` is registered before
// `tests/feedback-video-upload-processing.test.ts` evaluates its static import
// of `processFeedbackVideos` (which statically imports `videoAnalysis` and the
// object-storage modules).
import { register } from "node:module";

register("./feedbackVideoLoader.mjs", import.meta.url);
