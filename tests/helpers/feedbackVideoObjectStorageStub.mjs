// Minimal stub for `server/replit_integrations/object_storage/objectStorage`
// used by the feedback video upload + auto-analysis regression test
// (`tests/feedback-video-upload-processing.test.ts`).
//
// `processFeedbackVideos` downloads each attachment to a temp file BEFORE
// indexing, via `new ObjectStorageService().getObjectEntityFile(path)`. The
// companion resolve hook (`feedbackVideoLoader.mjs`) redirects
// feedbackVideoProcessing's import of this module to THIS stub so the download
// never reaches real Replit Object Storage.
//
// Deliberately minimal — it does NOT re-export the real module, so the real
// `objectStorage` (whose top-level `new Storage(...)` GCS client would keep a
// live handle and block clean process exit) is never evaluated. We provide
// only the one binding feedbackVideoProcessing consumes: `ObjectStorageService`
// with a `getObjectEntityFile` that returns a sentinel handle (the companion
// audit stub's `auditedCreateReadStream` ignores it and streams a fixed
// buffer).

export class ObjectStorageService {
  async getObjectEntityFile(objectPath) {
    return { __stubObjectPath: objectPath };
  }
}
