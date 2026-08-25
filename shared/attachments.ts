// Shared attachment classification for feedback (and any other private
// object-storage uploads that mix images and short videos).
//
// Feedback attachments are stored in Replit Object Storage under
// extension-bearing keys (e.g. `/objects/uploads/<uuid>.mp4`). The upload
// endpoint stamps the extension onto the signed-PUT key so a stored path is
// self-describing: the client widget, the admin console, and the server-side
// Slack relay can all tell an image apart from a video by inspecting the
// path, without re-reading object metadata. Legacy rows written before video
// support have no extension and are treated as images (which is what they are).

// Feedback attachments are minted into their own private object-storage
// sub-namespace (`/objects/feedback-uploads/<uuid>`). The admin streaming route
// bypasses the generic object ACL, so it confines itself to this namespace —
// an arbitrary `/objects/...` path a submitter might inject can never be served.
export const FEEDBACK_ATTACHMENT_PREFIX = "/objects/feedback-uploads/";

/** True when a path is inside the dedicated feedback attachment namespace. */
export function isFeedbackAttachmentPath(path: unknown): path is string {
  return typeof path === "string" && path.startsWith(FEEDBACK_ATTACHMENT_PREFIX);
}

// Byte caps for feedback attachment uploads — enforced BOTH client-side (the
// FeedbackButton pre-filter, best-effort UX) and server-side at claim time
// (Task #3964 / audit A-006: presigned PUT URLs cannot bind size or content
// type at mint time, so the server re-verifies the stored bytes before a
// submission may reference them). Shared so the two ends cannot drift.
export const FEEDBACK_MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10MB
export const FEEDBACK_MAX_VIDEO_BYTES = 50 * 1024 * 1024; // 50MB (Task #2409 cap)

/**
 * Decide whether a user-submitted attachment path may be claimed onto a feedback
 * row. Allowed only when the path is in the feedback namespace and the object is
 * either unclaimed or already owned by this user — an object already owned by a
 * different user is a forged/injected reference and is rejected. (The caller
 * still performs the side-effecting ownership stamp + existence check.)
 */
export function feedbackAttachmentClaimAllowed(args: {
  path: string;
  existingOwner: string | null | undefined;
  userId: string;
}): boolean {
  if (!isFeedbackAttachmentPath(args.path)) return false;
  if (args.existingOwner && args.existingOwner !== args.userId) return false;
  return true;
}

/**
 * Decide whether an admin may stream a stored feedback attachment. All three
 * conditions must hold: the path is in the feedback namespace, it is in the
 * feedback row's stored attachment list, and the object's ACL owner is the user
 * who submitted that row (proving it was genuinely claimed through the feedback
 * upload flow rather than injected). Guards the ACL-bypassing download path.
 */
export function canStreamFeedbackAttachment(args: {
  requestedPath: string;
  storedPaths: string[];
  aclOwner: string | null | undefined;
  feedbackUserId: string | null | undefined;
}): boolean {
  const { requestedPath, storedPaths, aclOwner, feedbackUserId } = args;
  if (!isFeedbackAttachmentPath(requestedPath)) return false;
  if (!storedPaths.includes(requestedPath)) return false;
  if (!feedbackUserId) return false;
  if (!aclOwner || aclOwner !== feedbackUserId) return false;
  return true;
}

export const VIDEO_ATTACHMENT_EXTENSIONS = [
  "mp4",
  "webm",
  "mov",
  "m4v",
  "ogv",
  "ogg",
  "avi",
  "mkv",
  "qt",
] as const;

/** True when the object path looks like a video by its file extension. */
export function isVideoAttachmentPath(path: string): boolean {
  if (typeof path !== "string") return false;
  const clean = path.split("?")[0].split("#")[0];
  const dot = clean.lastIndexOf(".");
  if (dot === -1) return false;
  const ext = clean.slice(dot + 1).toLowerCase();
  return (VIDEO_ATTACHMENT_EXTENSIONS as readonly string[]).includes(ext);
}

export interface AttachmentSummary {
  imageCount: number;
  videoCount: number;
  total: number;
  videoPaths: string[];
}

/** Split a list of attachment paths into image vs video counts. */
export function summarizeAttachments(paths: string[]): AttachmentSummary {
  let imageCount = 0;
  let videoCount = 0;
  const videoPaths: string[] = [];
  for (const p of paths) {
    if (isVideoAttachmentPath(p)) {
      videoCount += 1;
      videoPaths.push(p);
    } else {
      imageCount += 1;
    }
  }
  return { imageCount, videoCount, total: paths.length, videoPaths };
}
