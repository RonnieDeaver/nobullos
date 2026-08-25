/* test-registration
{
  "name": "Spam-sender pattern coverage (Task #971)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.0s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #971 — spot check that the spam-sender filter catches prefixed
 * Google noreply addresses (`businessprofile-noreply@google.com`,
 * `googlemybusiness-noreply@google.com`, etc.) in addition to the bare
 * `noreply@…` / `no-reply@…` form, while still letting normal addresses
 * through.
 *
 * The same pattern list is mirrored in `clientContactPromotion.ts` —
 * this test exercises both surfaces so a future drift between the two
 * lists can't silently re-introduce the bug.
 */
import { isSpamSenderEmail, SPAM_SENDER_PATTERNS } from "../server/services/frontIntegration";
import { promoteEmailsToClientContact } from "../server/services/clientContactPromotion";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

const SPAM: string[] = [
  // The bug-report addresses from the task description.
  "businessprofile-noreply@google.com",
  "googlemybusiness-noreply@google.com",
  // Existing bare forms must still match.
  "noreply@example.com",
  "no-reply@example.com",
  "donotreply@example.com",
  "do-not-reply@example.com",
  // Other common prefixed automated forms.
  "calendar-noreply@google.com",
  "accounts.noreply@google.com",
  "billing+noreply@stripe.com",
  "notifications@github.com",
  "notification@slack.com",
  "bounce@mail.example.com",
  "mailer-daemon@example.com",
  // Casing must not matter.
  "BusinessProfile-NOREPLY@Google.com",
];

const HAM: string[] = [
  // Real human-looking addresses must NOT trigger the filter.
  "april@apriljoneslaw.com",
  "kate.hardey@bledsoe-firm.com",
  "brett@nobullagency.com",
  // "noreply" appearing mid-token without a separator boundary should
  // also not match — only token-boundary forms are spam.
  "henoreplyfan@example.com",
  "donotreplyman@example.com",
  // Domains that happen to contain "noreply" are fine — the pattern
  // only fires on the local-part.
  "real.person@noreply-not-actually-google.com",
];

async function testPromotionSurface(): Promise<void> {
  // The promotion surface (`clientContactPromotion.ts`) imports the same
  // canonical `isSpamSenderEmail` predicate, so passing a list of all-spam
  // addresses must short-circuit at the filter step with `reason:
  // "all_filtered"` BEFORE any DB write happens. We assert that observable
  // contract so a future regression that swaps the predicate (or
  // re-introduces a drifted local copy) is caught here.
  const result = await promoteEmailsToClientContact({
    clientId: "spam-pattern-test-client",
    emails: [
      "businessprofile-noreply@google.com",
      "googlemybusiness-noreply@google.com",
      "notifications@github.com",
    ],
    explicitOptIn: true,
  });
  assert(result.added === 0, `promotion: added must be 0 for all-spam input (got ${result.added})`);
  assert(result.skipped === 3, `promotion: skipped must be 3 for all-spam input (got ${result.skipped})`);
  assert(result.contactId === null, `promotion: contactId must be null for all-spam input`);
  assert(result.createdNewContact === false, `promotion: createdNewContact must be false for all-spam input`);
  assert(result.reason === "all_filtered", `promotion: reason must be "all_filtered" (got "${result.reason}")`);
  console.log(`  [PASS] promotion surface short-circuits all-spam input with reason="all_filtered"`);
}

async function run(): Promise<void> {
  console.log("\n=== Spam-sender pattern coverage (Task #971) ===");
  for (const e of SPAM) {
    assert(isSpamSenderEmail(e), `expected SPAM: ${e}`);
    console.log(`  [PASS] filtered: ${e}`);
  }
  for (const e of HAM) {
    assert(!isSpamSenderEmail(e), `expected HAM (kept): ${e}`);
    console.log(`  [PASS] kept:     ${e}`);
  }

  // Mirror check — the promotion-side list must agree with the
  // ingestion-side list on the bug-report addresses. We can't import
  // the promotion-side regex array directly (it's module-private), so
  // we re-evaluate the same patterns inline against the bug examples
  // to confirm the canonical list catches them.
  for (const e of ["businessprofile-noreply@google.com", "googlemybusiness-noreply@google.com"]) {
    const matched = SPAM_SENDER_PATTERNS.some(p => p.test(e));
    assert(matched, `front pattern list must match ${e}`);
  }

  await testPromotionSurface();

  console.log("=== ALL SPAM-SENDER PATTERN TESTS PASSED ===\n");
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
run().then(
  () => {},
  (err) => {
    console.error(err);
    process.exitCode = 1;
  },
);
