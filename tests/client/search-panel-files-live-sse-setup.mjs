// Setup for tests/client/search-panel-files-live-sse.test.tsx (Task #3311).
    // Registers the shared heavy-client loader (tests/helpers/heavyClientLoader.mjs)
    // only to stub @clerk/react: the mounted graph reaches useAuth();
    // @clerk/react's hooks throw outside a live <ClerkProvider>. This suite
    // mounts the real CommsProvider + SearchPanel graph, which reaches useAuth, so a signed-IN stub lets the REAL use-auth hook fetch
    // /api/auth/user through the suite's fetch stub.
    // Passed via `--import ./tests/client/search-panel-files-live-sse-setup.mjs`.

    import { register } from "node:module";

    register("../helpers/heavyClientLoader.mjs", import.meta.url, {
    data: { stubClerk: { signedIn: true } },
    });
    