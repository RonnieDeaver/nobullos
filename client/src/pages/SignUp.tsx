import { SignUp } from "@clerk/react";

import { AuthShell } from "@/components/AuthShell";

// typeof-guarded: import.meta.env is vite-only — undefined under tsx/jsdom harnesses.
const basePath = (typeof import.meta.env !== "undefined" ? import.meta.env.BASE_URL : "/").replace(/\/$/, "");

export default function SignUpPage() {
  return (
    // Shared signed-out brand frame (Task #4742) — same chrome band as
    // sign-in; the Clerk card internals stay pinned light via clerkAppearance.
    <AuthShell>
      <SignUp
        routing="path"
        path={`${basePath}/sign-up`}
        signInUrl={`${basePath}/sign-in`}
        fallbackRedirectUrl="/"
      />
    </AuthShell>
  );
}
