// Task #4554 — closed admission: landing page for a signed-in Clerk session
// whose email has no approved users row. Public path (publicPaths.ts) so the
// auth probe/AuthGate never re-fires here — the page must settle, not loop.
// The email comes from Clerk's client-side session (useUser) with the auth
// probe's 403 payload as fallback; sign-out goes straight to /sign-in so the
// signed-out visitor doesn't bounce through the AuthGate again.
// Task #4742: framed by AuthShell (the shared signed-out brand chrome), so
// the dead end reads as part of the same family as sign-in; the canvas moves
// from surface-warm-1 to the shared eggshell background.
import { UserX } from "lucide-react";
import { useUser, useClerk } from "@clerk/react";
import { useAuth } from "@/hooks/use-auth";
import { AuthShell } from "@/components/AuthShell";
import { Button } from "@/components/ui/button";

export default function NotApproved() {
  const { user: clerkUser } = useUser();
  const { signOut } = useClerk();
  const { notApprovedEmail } = useAuth();

  const email =
    clerkUser?.primaryEmailAddress?.emailAddress ?? notApprovedEmail ?? null;

  return (
    <AuthShell testId="page-not-approved">
      <div className="max-w-md w-full bg-card rounded-lg shadow-sm border border-border p-8 text-center">
        <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-4">
          <UserX className="w-7 h-7 text-primary" />
        </div>
        <h1
          className="text-xl font-semibold text-foreground mb-2"
          data-testid="text-not-approved-title"
        >
          Account not approved
        </h1>
        <p className="text-sm text-muted-foreground mb-2" data-testid="text-not-approved-body">
          {email ? (
            <>
              You signed in as{" "}
              <span className="font-medium text-foreground" data-testid="text-not-approved-email">
                {email}
              </span>
              , but that email hasn't been approved for NoBull OS.
            </>
          ) : (
            <>Your account hasn't been approved for NoBull OS.</>
          )}
        </p>
        <p className="text-sm text-muted-foreground mb-6">
          Ask an admin to approve you, then sign in again. If you meant to use a
          different account, sign out below.
        </p>
        <Button
          variant="outline"
          onClick={() => void signOut({ redirectUrl: "/sign-in" })}
          data-testid="button-not-approved-sign-out"
        >
          Sign out
        </Button>
      </div>
    </AuthShell>
  );
}
