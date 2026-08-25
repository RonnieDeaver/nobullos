import { Link } from "wouter";
import { Compass, ArrowLeft } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

/**
 * Operator-facing 404 (Task #4364, audit §6.1-D). Says what happened and
 * where to go — no router/engineering talk.
 */
export default function NotFound() {
  // Protected fallback route — renders under the global nav, so size
  // below it like other authed pages (nav-height sweep).
  return (
    <div className="min-h-[calc(100dvh-var(--nav-height))] w-full flex items-center justify-center bg-surface-warm-1">
      <Card className="w-full max-w-md mx-4" data-testid="card-not-found">
        <CardContent className="pt-6 space-y-4">
          <div className="flex items-center gap-3">
            <Compass className="h-8 w-8 text-primary shrink-0" />
            <h1 className="text-2xl font-bold text-foreground">Page not found</h1>
          </div>

          <p className="text-sm text-muted-foreground" data-testid="text-not-found-explainer">
            This page doesn&apos;t exist or may have moved. If a saved link or
            bookmark brought you here, it&apos;s likely out of date.
          </p>

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button asChild data-testid="button-not-found-home">
              <Link href="/">Go to Dashboard</Link>
            </Button>
            <Button
              variant="outline"
              onClick={() => window.history.back()}
              data-testid="button-not-found-back"
            >
              <ArrowLeft className="w-4 h-4 mr-1.5" />
              Go back
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
