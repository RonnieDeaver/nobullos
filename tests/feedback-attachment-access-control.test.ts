/* test-registration
{
  "name": "Feedback attachment access control (Task #2409)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.0s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Guards the access-control decisions for feedback attachments. A prior version
 * of the admin attachment streaming route bypassed the object ACL and trusted a
 * user-controlled `screenshots` list, so a submitter could persist an arbitrary
 * `/objects/...` path that a team-lead would then stream (broken access
 * control). The fix confines attachments to a dedicated namespace and verifies
 * object ownership; this test pins the pure decision functions both the POST
 * claim path and the admin streaming path delegate to.
 */
import assert from "node:assert/strict";

import {
  FEEDBACK_ATTACHMENT_PREFIX,
  isFeedbackAttachmentPath,
  feedbackAttachmentClaimAllowed,
  canStreamFeedbackAttachment,
} from "../shared/attachments";

const OWNER = "user-owner";
const ATTACKER = "user-attacker";
const GOOD_PATH = `${FEEDBACK_ATTACHMENT_PREFIX}11111111-1111-1111-1111-111111111111.png`;
const GOOD_VIDEO = `${FEEDBACK_ATTACHMENT_PREFIX}22222222-2222-2222-2222-222222222222.mp4`;

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

// --- namespace confinement -------------------------------------------------
check("path inside the feedback namespace is recognized", () => {
  assert.equal(isFeedbackAttachmentPath(GOOD_PATH), true);
});

check("arbitrary /objects path outside the namespace is rejected", () => {
  assert.equal(isFeedbackAttachmentPath("/objects/uploads/secret.png"), false);
  assert.equal(isFeedbackAttachmentPath("/objects/.private/secret"), false);
  assert.equal(isFeedbackAttachmentPath("/objects/feedback-uploads"), false);
});

check("non-string / empty path is rejected", () => {
  assert.equal(isFeedbackAttachmentPath(undefined), false);
  assert.equal(isFeedbackAttachmentPath(null), false);
  assert.equal(isFeedbackAttachmentPath(123 as unknown), false);
  assert.equal(isFeedbackAttachmentPath(""), false);
});

// --- claim path (POST /api/feedback) ---------------------------------------
check("unclaimed in-namespace object can be claimed by submitter", () => {
  assert.equal(
    feedbackAttachmentClaimAllowed({ path: GOOD_PATH, existingOwner: null, userId: OWNER }),
    true,
  );
  assert.equal(
    feedbackAttachmentClaimAllowed({ path: GOOD_PATH, existingOwner: undefined, userId: OWNER }),
    true,
  );
});

check("object already owned by the same submitter can be re-claimed", () => {
  assert.equal(
    feedbackAttachmentClaimAllowed({ path: GOOD_PATH, existingOwner: OWNER, userId: OWNER }),
    true,
  );
});

check("object owned by a different user cannot be claimed (forged reference)", () => {
  assert.equal(
    feedbackAttachmentClaimAllowed({ path: GOOD_PATH, existingOwner: ATTACKER, userId: OWNER }),
    false,
  );
});

check("out-of-namespace path cannot be claimed even if unowned", () => {
  assert.equal(
    feedbackAttachmentClaimAllowed({
      path: "/objects/uploads/victim.png",
      existingOwner: null,
      userId: OWNER,
    }),
    false,
  );
});

// --- admin streaming path (GET /api/feedback/:id/attachment) ---------------
check("admin may stream an in-namespace, listed, owner-matched attachment", () => {
  assert.equal(
    canStreamFeedbackAttachment({
      requestedPath: GOOD_PATH,
      storedPaths: [GOOD_PATH, GOOD_VIDEO],
      aclOwner: OWNER,
      feedbackUserId: OWNER,
    }),
    true,
  );
});

check("streaming denied when path is not in the row's stored list", () => {
  assert.equal(
    canStreamFeedbackAttachment({
      requestedPath: GOOD_VIDEO,
      storedPaths: [GOOD_PATH],
      aclOwner: OWNER,
      feedbackUserId: OWNER,
    }),
    false,
  );
});

check("streaming denied when the object has no ACL owner", () => {
  assert.equal(
    canStreamFeedbackAttachment({
      requestedPath: GOOD_PATH,
      storedPaths: [GOOD_PATH],
      aclOwner: null,
      feedbackUserId: OWNER,
    }),
    false,
  );
});

check("streaming denied when object owner != feedback submitter (forged path)", () => {
  assert.equal(
    canStreamFeedbackAttachment({
      requestedPath: GOOD_PATH,
      storedPaths: [GOOD_PATH],
      aclOwner: ATTACKER,
      feedbackUserId: OWNER,
    }),
    false,
  );
});

check("streaming denied for an out-of-namespace path even if listed + owned", () => {
  const forged = "/objects/.private/secret";
  assert.equal(
    canStreamFeedbackAttachment({
      requestedPath: forged,
      storedPaths: [forged],
      aclOwner: OWNER,
      feedbackUserId: OWNER,
    }),
    false,
  );
});

check("streaming denied when the feedback row has no user id", () => {
  assert.equal(
    canStreamFeedbackAttachment({
      requestedPath: GOOD_PATH,
      storedPaths: [GOOD_PATH],
      aclOwner: OWNER,
      feedbackUserId: null,
    }),
    false,
  );
});

console.log(`\nfeedback-attachment-access-control: ${passed} checks passed`);
