/**
 * Task #4327 — client-page entry point into the deals pipeline.
 *
 * Compact card on the client Command Panel tab listing the client's deals
 * (GET /api/clients/:clientId/deals) with stage + amount, linking each to
 * its detail view and out to the board. Renders nothing while loading and
 * collapses to a quiet empty state — the client page stays usable even if
 * the deals API errors (the card says so instead of breaking the tab).
 */
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { ArrowUpRight, Briefcase } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDealAmount } from "@/components/DealRequiredFieldsDialog";
import type { Deal } from "@shared/schema";

type ClientDeal = Deal & {
  stageName: string | null;
  ownerName: string | null;
};

export function ClientDealsCard({ clientId }: { clientId: string }) {
  const dealsQuery = useQuery<ClientDeal[]>({
    queryKey: ["/api/clients", clientId, "deals"],
    enabled: Boolean(clientId),
    retry: false,
  });

  const deals = dealsQuery.data ?? [];

  return (
    <Card data-testid="card-client-deals">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Briefcase className="h-4 w-4" />
          Deals
          {deals.length > 0 && (
            <Badge variant="secondary" data-testid="badge-client-deal-count">
              {deals.length}
            </Badge>
          )}
        </CardTitle>
        <Button asChild variant="ghost" size="sm" data-testid="link-deals-board">
          <Link href="/deals">
            Board
            <ArrowUpRight className="ml-1 h-3.5 w-3.5" />
          </Link>
        </Button>
      </CardHeader>
      <CardContent>
        {dealsQuery.isLoading ? (
          <div className="text-sm text-muted-foreground">Loading deals…</div>
        ) : dealsQuery.isError ? (
          <div className="text-sm text-muted-foreground" data-testid="text-client-deals-error">
            Deals unavailable.
          </div>
        ) : deals.length === 0 ? (
          <div className="text-sm text-muted-foreground" data-testid="text-client-deals-empty">
            No deals yet for this client.
          </div>
        ) : (
          <ul className="divide-y" data-testid="list-client-deals">
            {deals.map((deal) => (
              <li key={deal.id} className="flex items-center gap-3 py-2 first:pt-0 last:pb-0">
                <div className="min-w-0 flex-1">
                  <Link
                    href={`/deals/${deal.id}`}
                    className="block truncate text-sm font-medium hover:underline"
                    data-testid={`link-client-deal-${deal.id}`}
                  >
                    {deal.name}
                  </Link>
                  <div className="text-xs text-muted-foreground">
                    {deal.stageName ?? "—"}
                    {deal.ownerName ? ` · ${deal.ownerName}` : ""}
                  </div>
                </div>
                <div className="shrink-0 text-sm font-semibold">
                  {formatDealAmount(deal.amount)}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
