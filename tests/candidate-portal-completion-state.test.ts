/* test-registration
{
  "name": "Candidate portal only shows completion after the server confirms submission",
  "smokeReason": "Pure deterministic unit coverage for the public candidate portal's terminal-state gate; no DB, network, DOM, or external services.",
  "tier": "small"
}
test-registration */
import assert from "node:assert/strict";

import {
  isPortalApplicationComplete,
  portalCompletionEndpoints,
  type PortalJob,
} from "../client/src/pages/CandidatePortal";

const baseCandidate = {
  id: "candidate",
  name: "Candidate",
  stage: "screening",
  screeningCompletedAt: null,
  videoCompletedAt: null,
};

const textOnlyJob: PortalJob = {
  title: "Text-only role",
  screeningQuestions: null,
  videoTasks: null,
  assessmentJson: {
    items: [{
      id: "q1",
      prompt: "Why this role?",
      type: "text",
      layer: "role_skill",
      ordering_index: 0,
      required: true,
    }],
    meta: {},
  },
};

const mixedLegacyJob: PortalJob = {
  ...textOnlyJob,
  videoTasks: [{
    id: "legacy-video",
    prompt: "Introduce yourself",
    durationSec: 60,
    required: true,
  }],
};

assert.equal(
  isPortalApplicationComplete(baseCandidate, textOnlyJob),
  false,
  "a text-only application is not complete before the server stamps screening completion",
);
assert.equal(
  isPortalApplicationComplete(
    { ...baseCandidate, screeningCompletedAt: "2026-08-27T12:00:00.000Z" },
    textOnlyJob,
  ),
  true,
  "a text-only application completes from the server screening timestamp",
);
assert.deepEqual(
  portalCompletionEndpoints(textOnlyJob),
  ["complete-screening"],
  "a text-only application does not call video completion",
);

assert.deepEqual(
  portalCompletionEndpoints(mixedLegacyJob),
  ["complete-screening", "complete-video"],
  "legacy videoTasks still require the video-completion request when assessmentJson has text items",
);
assert.equal(
  isPortalApplicationComplete(
    { ...baseCandidate, screeningCompletedAt: "2026-08-27T12:00:00.000Z" },
    mixedLegacyJob,
  ),
  false,
  "a mixed legacy application does not complete from screening completion alone",
);
assert.equal(
  isPortalApplicationComplete(
    {
      ...baseCandidate,
      screeningCompletedAt: "2026-08-27T12:00:00.000Z",
      videoCompletedAt: "2026-08-27T12:05:00.000Z",
    },
    mixedLegacyJob,
  ),
  true,
  "a mixed legacy application completes only from the server video timestamp",
);

console.log("[candidate-portal-completion-state] PASS");