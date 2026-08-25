import { ShieldOff } from "lucide-react";

import { AuthShell } from "@/components/AuthShell";

export default function AccessRevoked() {
  return (
    // Task #4742: framed by AuthShell (the shared signed-out brand chrome).
    // The band's reverse-bull lockup supersedes the old earth-bull letterhead
    // (Task #4618) — one brand mark per surface. The band is --chrome page
    // chrome, not --accent decoration beside the message, so the Task #4600
    // rule (never crimson next to a dead-end message where it could read as
    // an error state) still holds: the card content below stays neutral.
    <AuthShell testId="page-access-revoked">
      <div className="max-w-md w-full bg-card rounded-lg shadow-sm border border-border p-8 text-center">
        <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-4">
          <ShieldOff className="w-7 h-7 text-primary" />
        </div>
        <h1
          className="text-xl font-semibold text-foreground mb-2"
          data-testid="text-access-revoked-title"
        >
          Access revoked
        </h1>
        <p className="text-sm text-muted-foreground mb-4" data-testid="text-access-revoked-body">
          Your account no longer has access to NoBull OS. If you believe this is a
          mistake, please contact your administrator.
        </p>
      </div>
    </AuthShell>
  );
}
