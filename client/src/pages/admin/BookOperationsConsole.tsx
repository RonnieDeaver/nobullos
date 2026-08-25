/**
 * BookOperationsConsole — Task #5107
 *
 * Thin admin operations console for book commerce oversight.
 * Splits into three tabs backed by local DB read-models only:
 *   Overview  — funnel + financials + health cache
 *   Orders    — search/filter/paginate list + detail/actions
 *   Exceptions — union exception queue
 *
 * Authority boundary:
 *   - Payment state is read-only; no charge or refund is issued here.
 *   - No entitlements are granted from this console.
 *   - SMS consent and GHL sales records are not accessible.
 *   - Mutations are limited to: payment-event retry, GHL outbox replay,
 *     delivery resend, delivery reissue, entitlement revoke (reason required).
 */
import { BookOpen, Activity, PackageCheck, ServerCrash, ShieldX } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/admin/PageHeader";
import { OverviewTab } from "./bookOperations/OverviewTab";
import { OrdersTab } from "./bookOperations/OrdersTab";
import { ExceptionsTab } from "./bookOperations/ExceptionsTab";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent } from "@/components/ui/card";

export default function BookOperationsConsole() {
  const { user, isLoading } = useAuth();
  const isTeamLead = user?.role === "team_lead" || user?.role === "ceo";

  if (isLoading) {
    return (
      <div className="mx-auto max-w-7xl p-6 text-sm text-muted-foreground">
        Loading access…
      </div>
    );
  }
  if (!user || !isTeamLead) {
    return (
      <div className="mx-auto max-w-2xl p-6">
        <Card>
          <CardContent className="flex items-start gap-3 py-6">
            <ShieldX className="mt-0.5 h-5 w-5 text-muted-foreground" />
            <div>
              <h1 className="font-semibold">Book Operations access required</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Team Lead or CEO access is required to view commerce support records.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-7xl space-y-4 p-4 md:p-6">
      <PageHeader
        title="Book Operations"
        backHref="/admin"
        backLabel="Admin"
        icon={BookOpen}
        subtitle="Monitor book commerce operations — funnel, orders, delivery, and exception queues"
      />

      <Tabs defaultValue="overview">
        <TabsList className="h-auto bg-slate-100 p-1 dark:bg-slate-800/40">
          <TabsTrigger
            value="overview"
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs"
          >
            <Activity className="h-3.5 w-3.5" />
            Overview
          </TabsTrigger>
          <TabsTrigger
            value="orders"
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs"
          >
            <PackageCheck className="h-3.5 w-3.5" />
            Orders &amp; Support
          </TabsTrigger>
          <TabsTrigger
            value="exceptions"
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs"
          >
            <ServerCrash className="h-3.5 w-3.5" />
            Exceptions
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-4">
          <OverviewTab />
        </TabsContent>

        <TabsContent value="orders" className="mt-4">
          <OrdersTab />
        </TabsContent>

        <TabsContent value="exceptions" className="mt-4">
          <ExceptionsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
