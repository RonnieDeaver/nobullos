// Entry passed via `tsx --import` so the resolve hook in
// `feedbackVideoProcessingLoader.mjs` is registered before
// `tests/feedback-video-resume.test.ts` evaluates its import chain that
// resolves `feedbackVideoProcessing`.
import { register } from "node:module";

register("./feedbackVideoProcessingLoader.mjs", import.meta.url);
