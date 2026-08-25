import type { ReactNode } from "react";

import { BrandMark } from "@/components/kit/BrandMark";

/**
 * AuthShell — the shared brand frame for the signed-out surface family
 * (Task #4742): /sign-in, /sign-up, and the auth-adjacent dead ends
 * (/not-approved, /access-revoked).
 *
 * The frame is the crimson brand-chrome band — the SAME chrome idiom as the
 * global app nav (QuicklinksBar, Task #4600 rebalance): `--chrome` token
 * family, reverse bull mark, "NoBull OS" lockup, sticky at the top. Light
 * renders the v2 crimson band; dark follows the app shell's chrome behavior
 * (machinery charcoal with the crimson `--chrome-edge` hairline) with zero
 * extra code — the tokens flip in index.css. The point is continuity: the
 * front door wears the same chrome as the house, so the login reads as
 * NoBull OS instead of a stock auth card.
 *
 * Token constitution notes (client/src/index.css):
 *   - The band is `--chrome` (a sanctioned chrome surface — see the CHROME
 *     usage rule), NOT `--accent` and NOT `--primary`; buttons, links, and
 *     focus rings below the band stay Liberty.
 *   - Text over the band is `--chrome-foreground` (AA: 7.06:1 on the light
 *     crimson band, 13.96:1 on the dark charcoal band — documented at the
 *     token definitions).
 *   - The band carries NO interactive elements: no nav to leak to signed-out
 *     visitors, and the brand cluster is deliberately not a link (on these
 *     pages "/" would just bounce back through the AuthGate).
 */
export function AuthShell({
  children,
  testId,
}: {
  children: ReactNode;
  /** Optional data-testid for the page root (dead-end pages assert it). */
  testId?: string;
}) {
  return (
    <div
      className="flex min-h-[100dvh] flex-col bg-background"
      data-testid={testId}
    >
      <header
        className="sticky top-0 z-[var(--z-nav)] bg-chrome text-chrome-foreground border-b border-chrome-edge shadow-sm"
        data-testid="auth-chrome-band"
      >
        {/* Same band anatomy as the global nav (h-14, 1536px cap) so the
            door-to-house transition is seamless. The reverse bull mark is
            the exact approved artwork — never redrawn or recolored; white
            reads on both the light crimson and the dark charcoal band. */}
        <div className="mx-auto flex h-14 w-full max-w-[1536px] items-center px-3 sm:px-4">
          <div className="flex items-center gap-2 text-base font-bold sm:text-lg">
            <BrandMark
              kind="icon"
              variant="white"
              className="h-6 w-auto"
              testId="img-auth-brand-bull"
            />
            NoBull OS
          </div>
        </div>
      </header>
      <main className="flex w-full flex-1 flex-col items-center justify-center px-4 py-8">
        {children}
      </main>
    </div>
  );
}
