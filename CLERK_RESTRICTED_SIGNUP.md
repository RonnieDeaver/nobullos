# Clerk Restricted Sign-up — Flip & Verification Runbook

Canonical procedure for enabling Clerk's **Restricted** sign-up mode
(allowlist) via the CEO button and verifying that a stranger genuinely cannot
create an account afterwards. Companion to Tasks #4611 (the button) and
#4632 (this verification).

## Background

- Clerk's sign-up mode is an **instance-level** setting, and Clerk instances
  are **environment-scoped**: the Development instance (dev `CLERK_SECRET_KEY`)
  governs the Replit workspace, the Production instance governs the deployed
  app. The flip must be performed **once per environment**.
- The in-app control lives at `/admin/system-health?tab=auth` (CEO only):
  the "Clerk Sign-up Restrictions" card reads live state via
  `GET /api/admin/clerk/restrictions` and flips it via
  `POST /api/admin/clerk/enable-restricted-signup`
  (`server/routes/clerkAdmin.ts`; UI in
  `client/src/pages/admin/ClerkRestrictionsSection.tsx`).
- Note: app-level **closed admission** (`server/middlewares/requireAuth.ts`,
  approved emails only) already denies unapproved users at the API layer even
  when Clerk sign-up is open. Restricted mode additionally blocks account
  creation at Clerk's own hosted sign-up page, before the app is reached.

## Flip procedure (per environment)

1. Sign in as the CEO and open `/admin/system-health?tab=auth`
   (dev workspace URL for the Development instance; the deployed production
   URL for the Production instance).
2. On the "Clerk Sign-up Restrictions" card press **Enable Restricted
   Sign-up**, then confirm. The action is idempotent — re-pressing when
   already enabled is safe.
3. Press **Refresh** on the card and confirm the badge reads
   **"Restricted (enabled)"** and the detail line shows
   "✓ Restricted sign-up is active for this Clerk instance."

## Manual verification checklist (run after each flip)

Do this for **both** environments (dev and prod), since each has its own
Clerk instance:

- [ ] Admin card at `/admin/system-health?tab=auth` shows
      **"Restricted (enabled)"** after a Refresh.
- [ ] In a private/incognito browser window (no existing session), open the
      app's sign-in surface and choose **Sign up**.
- [ ] Attempt to sign up with an **unknown email address** (one that is not
      allowlisted in Clerk and has no `users` row), e.g. a fresh
      mailbox/alias you control.
- [ ] Confirm Clerk **rejects the sign-up on its own hosted page** (a
      "restricted access" style message) **before** the app is ever reached —
      no new Clerk account is created, no app session starts.
- [ ] (Prod only) Confirm a known teammate can still sign in normally.
- [ ] If the unknown email got further than Clerk's page, STOP: the flip did
      not take on this instance. Re-check which environment's URL you pressed
      the button on, press it again, and re-verify. `GET
      /api/admin/clerk/restrictions` (as CEO) must return
      `{"allowlist": true, ...}`.

## Automated coverage

`tests/clerk-restricted-signup-flip.test.ts` (gate-registered smoke) locks the
endpoint contract against a stubbed Clerk API: CEO-only authz, the PATCH body
sent to Clerk, `allowlist === true` on read-after-write, idempotence, and
vendor-error surfacing. It cannot observe the real Clerk instances — the
manual checklist above remains the authority for "the live flip took".
