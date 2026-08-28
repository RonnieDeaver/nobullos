// Shared Zoom vendor test stub for `server/services/zoomIntegration`
// (Task #5313 — shared vendor test stubs instead of one-off; promoted
// verbatim from the one-off stub built for Task #5298's onboarding
// end-to-end test).
//
// A genuine `bookOnboardingSlot`/`scheduler.bookSlot` success requires a
// real Zoom host resolution + meeting creation — both real network calls
// with no existing dependency-injection seam. This stub re-exports the
// real module verbatim and overrides just those two functions (plus the
// compensation-path delete, kept a safe no-op) so a booking saga's own DB
// writes, advisory locking, and Google-Calendar-required gate all run for
// real while the Zoom leg is faked.
//
// See TESTING.md, "Shared vendor test stubs", for the convention and for
// how a suite's resolve-hook loader wires this in.
//
// Consuming suites:
//   - onboarding-e2e-full-chain.test.ts (Task #5298, stage 4 of the New
//     Client Onboarding epic)

export * from "../../server/services/zoomIntegration";

let seq = 0;

export async function resolveEffectiveZoomHostForUser(user) {
  if (!user) {
    return { source: "none", error: "User not found." };
  }
  return {
    source: "override",
    zoomUserId: `stub-zoom-user-${user.id}`,
    zoomEmail: user.email || `${user.id}@onboarding-e2e.test`,
    displayName: user.firstName || user.id,
  };
}

export async function createScheduledMeeting(_input) {
  seq += 1;
  const id = `stub-zoom-meeting-${seq}`;
  return {
    id,
    uuid: `stub-zoom-uuid-${seq}`,
    joinUrl: `https://zoom.onboarding-e2e.test/j/${id}`,
    startUrl: `https://zoom.onboarding-e2e.test/s/${id}`,
    password: null,
    raw: null,
  };
}

export async function deleteScheduledMeeting(_meetingId, _opts) {
  // No-op: compensation path only, never expected on the happy path this
  // test exercises. Kept safe (no throw) in case a resolution race forces
  // the saga to roll back.
}
