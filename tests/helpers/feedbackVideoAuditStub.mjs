// Minimal stub for `server/replit_integrations/object_storage/audit` used by
// the feedback video upload + auto-analysis regression test
// (`tests/feedback-video-upload-processing.test.ts`).
//
// `processFeedbackVideos`'s temp-file download pipes
// `auditedCreateReadStream(objectFile)` into a write stream. The companion
// resolve hook (`feedbackVideoLoader.mjs`) redirects feedbackVideoProcessing's
// import of this module to THIS stub so the read never touches real Object
// Storage.
//
// Deliberately minimal — it does NOT re-export the real module, so nothing
// heavy loads. We provide only the one binding feedbackVideoProcessing
// consumes: `auditedCreateReadStream`, returning a Readable over a fixed buffer
// so the download produces a small, valid temp file the (stubbed) indexer
// ignores.
import { Readable } from "node:stream";

export function auditedCreateReadStream(_objectFile, _opts) {
  return Readable.from([Buffer.from("stub-video-bytes")]);
}
