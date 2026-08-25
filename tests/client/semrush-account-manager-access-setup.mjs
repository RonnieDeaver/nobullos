// Setup for tests/client/semrush-account-manager-access.test.tsx (Task #2907).
    // Registers the shared heavy-client loader (tests/helpers/heavyClientLoader.mjs)
    // only to stub @clerk/react: the mounted graph reaches useAuth();
    // @clerk/react's hooks throw outside a live <ClerkProvider>. This suite
    // role-gates the SEMrush AM console on the DB user's role, so a signed-IN stub lets the REAL use-auth hook fetch
    // /api/auth/user through the suite's fetch stub.
    // Passed via `--import ./tests/client/semrush-account-manager-access-setup.mjs`.

    import { register } from "node:module";

    register("../helpers/heavyClientLoader.mjs", import.meta.url, {
    data: { stubClerk: { signedIn: true } },
    });
    