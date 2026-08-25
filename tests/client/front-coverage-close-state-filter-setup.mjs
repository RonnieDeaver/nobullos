// Setup for tests/client/front-coverage-close-state-filter.test.tsx (Task #2139).
    // Registers the shared heavy-client loader (tests/helpers/heavyClientLoader.mjs)
    // only to stub @clerk/react: the mounted FrontHistoricalRecoveryPanel reads
    // useAuth(), whose @clerk/react hooks throw outside a live <ClerkProvider>.
    // This suite asserts the coverage table's close-state filter + badges, which the panel gates on user.role
    // (ceo/team_lead), so a signed-IN stub lets the REAL use-auth hook fetch
    // /api/auth/user through this suite's fetch stub (which returns the ceo
    // ADMIN_USER), keeping the role gating genuine.
    // Passed via `--import ./tests/client/front-coverage-close-state-filter-setup.mjs`.

    import { register } from "node:module";

    register("../helpers/heavyClientLoader.mjs", import.meta.url, {
    data: { stubClerk: { signedIn: true } },
    });
    