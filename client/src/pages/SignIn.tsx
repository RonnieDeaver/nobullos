import { SignIn } from "@clerk/react";

import { AuthShell } from "@/components/AuthShell";

// typeof-guarded: import.meta.env is vite-only — undefined under tsx/jsdom harnesses.
const basePath = (typeof import.meta.env !== "undefined" ? import.meta.env.BASE_URL : "/").replace(/\/$/, "");

export default function SignInPage() {
  return (
    <AuthShell>
      {/* Brand (Task #4742): the chrome band above carries the reverse-bull
          brand lockup — the sign-in identity moment the token constitution
          sanctions — while the card keeps the canonical full-color logo
          (clerkAppearance.options.logoImageUrl → client/public/brand/,
          Task #4618). No third lockup on the canvas. */}
      <SignIn
        routing="path"
        path={`${basePath}/sign-in`}
        signUpUrl={`${basePath}/sign-up`}
        fallbackRedirectUrl="/"
      />
    </AuthShell>
  );
}
