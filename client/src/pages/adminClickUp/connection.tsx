// ClickUp admin — OAuth connection panel.
// Extracted VERBATIM from the former 10.8k-line ClickUpModule.tsx monolith
// (house aggregator pattern, cf. Task #3787). The page composition root is
// client/src/pages/admin/ClickUpModule.tsx — its size is capped by
// scripts/lint-monolith-aggregator-size.ts, so new ClickUp feature code
// belongs here (or in a new sibling module), never in the aggregator.

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CheckSquare, Plug } from "lucide-react";

// ─── Connection panel ─────────────────────────────────────────────────────────

export function ConnectionPanel({ onConnected: _onConnected }: { onConnected(): void }) {
  return (
    <Card className="max-w-md mx-auto mt-16 bg-card" data-testid="card-clickup-connect">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <CheckSquare className="w-5 h-5 text-purple-600" />
          Connect ClickUp
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Connect your ClickUp account to manage tasks, track time, and review goals right here in
          NoBull OS. Each team member connects their own account.
        </p>
        <p className="text-sm text-muted-foreground">
          Connect your account from your <strong>Profile page</strong>.
        </p>
        <Button
          asChild
          data-testid="button-clickup-connect"
          className="w-full"
        >
          <a href="/profile?tab=account">
            <Plug className="w-4 h-4 mr-2" />
            Go to Profile to Connect
          </a>
        </Button>
      </CardContent>
    </Card>
  );
}

