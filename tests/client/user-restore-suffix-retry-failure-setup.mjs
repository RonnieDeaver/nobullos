// Setup for tests/client/user-restore-suffix-retry-failure.test.tsx (Task #2599).
    // Registers the shared heavy-client loader (tests/helpers/heavyClientLoader.mjs)
    // only to stub @clerk/react: the mounted graph reaches useAuth();
    // @clerk/react's hooks throw outside a live <ClerkProvider>. This suite
    // mounts the page AS A CEO and role-gates on the DB user, so a signed-IN stub lets the REAL use-auth hook fetch
    // /api/auth/user through the suite's fetch stub.
    // Passed via `--import ./tests/client/user-restore-suffix-retry-failure-setup.mjs`.

    import { register } from "node:module";

    register("../helpers/heavyClientLoader.mjs", import.meta.url, {
    data: { stubClerk: { signedIn: true } },
    });
    