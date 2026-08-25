import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Mail } from "lucide-react";

export function FrontMatchStatsTile() {
  // Task #2633 — message grain. The endpoint returns matched / unmatched /
  // matchRate from the same canonical helper the KPI strip and Messages tab use,
  // so all three agree. `byMethod` counts matched MESSAGES per match method.
  const { data, isLoading } = useQuery<{
    total: number;
    matched: number;
    unmatched: number;
    matchable: number;
    matchRate: number;
    byMethod: Record<string, number>;
  }>({
    queryKey: ["/api/integrations/front/match-stats"],
    queryFn: async () => {
      const res = await fetch("/api/integrations/front/match-stats", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load match stats");
      return res.json();
    },
    staleTime: 60_000,
  });

  const METHOD_LABELS: Record<string, string> = {
    EXACT_CONTACT_EMAIL_UNIQUE: "Email exact",
    EXACT_CLIENT_DOMAIN_UNIQUE: "Trusted domain",
    MANUAL: "Manual",
    FILTER_RULE: "Filter rule",
    OTHER: "Other (legacy)",
    UNKNOWN: "Unknown",
  };

  const methodEntries = Object.entries(data?.byMethod ?? {}).sort(
    (a, b) => (b[1] as number) - (a[1] as number),
  );

  return (
    <Card data-testid="card-front-match-stats">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base sm:text-lg">
          <Mail className="w-4 h-4 text-emerald-600" />
          Hard-match outcomes
        </CardTitle>
        <p className="text-xs text-muted-foreground" data-testid="text-match-stats-subtitle">
          Deterministic Front → client matching (Task #867). Only exact-email
          and trusted-domain auto-match; everything else is left Unmatched.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <div className="text-sm text-muted-foreground" data-testid="text-match-stats-loading">Loading…</div>
        ) : (
          <>
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground mb-2">
                Matched by method
              </p>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-2 text-sm">
                {methodEntries.length === 0 ? (
                  <div className="text-muted-foreground col-span-full" data-testid="text-no-method-rows">
                    No matched emails yet.
                  </div>
                ) : (
                  methodEntries.map(([method, count]) => (
                    <div
                      key={method}
                      className="flex items-center justify-between bg-card border rounded px-3 py-2"
                      data-testid={`row-method-${method.toLowerCase()}`}
                    >
                      <span className="text-foreground">
                        {METHOD_LABELS[method] || method}
                      </span>
                      <span className="font-semibold text-foreground">{count as number}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
