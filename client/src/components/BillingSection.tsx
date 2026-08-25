import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { ConfirmActionDialog } from "@/components/kit/ConfirmActionDialog";
import { CreditCard, DollarSign, CalendarDays, AlertTriangle, CheckCircle2, XCircle, Link2, Unlink, Search, Loader2 } from "lucide-react";

interface BillingSummary {
  stripeCustomerId: string;
  customerName: string | null;
  customerEmail: string | null;
  lifetimeValue: number;
  currency: string;
  activeSubscription: {
    id: string;
    planName: string;
    amount: number;
    currency: string;
    interval: string;
    status: string;
    currentPeriodEnd: number;
    cancelAtPeriodEnd: boolean;
  } | null;
  paymentStatus: {
    lastPaymentStatus: string | null;
    lastPaymentDate: number | null;
    lastPaymentAmount: number | null;
    hasFailedPayments: boolean;
    subscriptionStatus: string | null;
    cardBrand: string | null;
    cardLast4: string | null;
    cardExpMonth: number | null;
    cardExpYear: number | null;
    isCardExpiring: boolean;
  };
}

interface BillingResponse {
  configured: boolean;
  linked: boolean;
  billing: BillingSummary | null;
  error?: string;
}

interface StripeCustomer {
  id: string;
  name: string | null;
  email: string | null;
}

function formatCurrency(amount: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(amount / 100);
}

function formatDate(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function PaymentStatusBadge({ billing }: { billing: BillingSummary }) {
  const { paymentStatus, activeSubscription } = billing;

  if (paymentStatus.subscriptionStatus === "past_due" || paymentStatus.subscriptionStatus === "unpaid") {
    return (
      <Badge variant="outline" className="bg-red-50 dark:bg-red-950/25 text-red-700 dark:text-red-300 border-red-200 dark:border-red-800" data-testid="badge-payment-past-due">
        <XCircle className="w-3 h-3 mr-1" />
        {paymentStatus.subscriptionStatus === "past_due" ? "Past Due" : "Unpaid"}
      </Badge>
    );
  }

  if (paymentStatus.hasFailedPayments || paymentStatus.lastPaymentStatus === "failed") {
    return (
      <Badge variant="outline" className="bg-red-50 dark:bg-red-950/25 text-red-700 dark:text-red-300 border-red-200 dark:border-red-800" data-testid="badge-payment-failed">
        <XCircle className="w-3 h-3 mr-1" />
        Payment Failed
      </Badge>
    );
  }

  if (paymentStatus.isCardExpiring) {
    return (
      <Badge variant="outline" className="bg-amber-50 dark:bg-amber-950/25 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800" data-testid="badge-payment-expiring">
        <AlertTriangle className="w-3 h-3 mr-1" />
        Card Expiring
      </Badge>
    );
  }

  if (activeSubscription && (activeSubscription.status === "active" || activeSubscription.status === "trialing")) {
    return (
      <Badge variant="outline" className="bg-green-50 dark:bg-green-950/25 text-green-700 dark:text-green-300 border-green-200 dark:border-green-800" data-testid="badge-payment-current">
        <CheckCircle2 className="w-3 h-3 mr-1" />
        Current
      </Badge>
    );
  }

  if (paymentStatus.lastPaymentStatus === "succeeded") {
    return (
      <Badge variant="outline" className="bg-green-50 dark:bg-green-950/25 text-green-700 dark:text-green-300 border-green-200 dark:border-green-800" data-testid="badge-payment-good">
        <CheckCircle2 className="w-3 h-3 mr-1" />
        Good Standing
      </Badge>
    );
  }

  return (
    <Badge variant="outline" className="bg-muted/50 text-muted-foreground border-border" data-testid="badge-payment-unknown">
      No Payment History
    </Badge>
  );
}

function StripeCustomerSearch({ clientId, onLinked }: { clientId: string; onLinked: () => void }) {
  const [searchQuery, setSearchQuery] = useState("");
  const [isSearching, setIsSearching] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: searchResults, isFetching } = useQuery<{ customers: StripeCustomer[] }>({
    queryKey: ["/api/stripe/customers/search", searchQuery],
    queryFn: async () => {
      const res = await fetch(`/api/stripe/customers/search?q=${encodeURIComponent(searchQuery)}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Search failed");
      return res.json();
    },
    enabled: isSearching,
  });

  const linkMutation = useMutation({
    mutationFn: async (stripeCustomerId: string) => {
      const res = await fetch(`/api/clients/${clientId}/stripe-link`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ stripeCustomerId }),
      });
      if (!res.ok) throw new Error("Failed to link");
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/clients", clientId, "billing"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/clients", clientId] }); // fire-and-forget: cache refresh only
      toast({ title: "Stripe customer linked" });
      setIsSearching(false);
      onLinked();
    },
    onError: () => {
      toast({ title: "Failed to link customer", variant: "destructive" });
    },
  });

  if (!isSearching) {
    return (
      <Button
        variant="outline"
        size="sm"
        onClick={() => setIsSearching(true)}
        className="border-primary/15 text-primary-ink"
        data-testid="button-link-stripe"
      >
        <Link2 className="w-3.5 h-3.5 mr-1.5" />
        Link Stripe Customer
      </Button>
    );
  }

  return (
    <div className="space-y-3" data-testid="stripe-customer-search">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-2.5 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Search by name or email..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9 h-9"
            data-testid="input-stripe-search"
          />
        </div>
        <Button variant="ghost" size="sm" onClick={() => setIsSearching(false)} data-testid="button-cancel-search">
          Cancel
        </Button>
      </div>

      {isFetching && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
          <Loader2 className="w-4 h-4 animate-spin" />
          Searching Stripe customers...
        </div>
      )}

      {searchResults?.customers && searchResults.customers.length > 0 && (
        <div className="border rounded-lg divide-y max-h-60 overflow-y-auto">
          {searchResults.customers.map((customer) => (
            <div
              key={customer.id}
              className="flex items-center justify-between p-3 hover:bg-surface-warm-1/50 cursor-pointer"
              data-testid={`stripe-customer-${customer.id}`}
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-foreground truncate">
                  {customer.name || "No Name"}
                </p>
                <p className="text-xs text-muted-foreground truncate">
                  {customer.email || customer.id}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => linkMutation.mutate(customer.id)}
                disabled={linkMutation.isPending}
                className="ml-2 shrink-0"
                data-testid={`button-link-customer-${customer.id}`}
              >
                {linkMutation.isPending ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  "Link"
                )}
              </Button>
            </div>
          ))}
        </div>
      )}

      {searchResults?.customers && searchResults.customers.length === 0 && !isFetching && (
        <p className="text-sm text-muted-foreground py-2" data-testid="text-no-stripe-results">
          No Stripe customers found.
        </p>
      )}
    </div>
  );
}

export default function BillingSection({ clientId }: { clientId: string }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data, isLoading, isError } = useQuery<BillingResponse>({
    queryKey: ["/api/clients", clientId, "billing"],
    queryFn: async () => {
      const res = await fetch(`/api/clients/${clientId}/billing`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch billing");
      return res.json();
    },
  });

  const unlinkMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/clients/${clientId}/stripe-link`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ stripeCustomerId: null }),
      });
      if (!res.ok) throw new Error("Failed to unlink");
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/clients", clientId, "billing"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/clients", clientId] }); // fire-and-forget: cache refresh only
      toast({ title: "Stripe customer unlinked" });
    },
    onError: () => {
      toast({ title: "Failed to unlink customer", variant: "destructive" });
    },
  });

  if (isLoading) {
    return (
      <Card className="bg-card border-border" data-testid="card-billing-loading">
        <CardContent className="py-8 text-center">
          <Loader2 className="w-6 h-6 animate-spin mx-auto text-primary/40" />
          <p className="text-sm text-muted-foreground mt-2">Loading billing data...</p>
        </CardContent>
      </Card>
    );
  }

  if (isError) {
    return (
      <Card className="bg-card border-border" data-testid="card-billing-error">
        <CardHeader>
          <CardTitle className="text-foreground flex items-center gap-2">
            <CreditCard className="w-5 h-5" />
            Billing
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-center py-6">
            <AlertTriangle className="w-10 h-10 mx-auto text-amber-400 mb-3" />
            <p className="text-sm text-muted-foreground">Unable to load billing data. Please try again later.</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!data?.configured) {
    return (
      <Card className="bg-card border-border" data-testid="card-billing-not-configured">
        <CardHeader>
          <CardTitle className="text-foreground flex items-center gap-2">
            <CreditCard className="w-5 h-5" />
            Billing
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-center py-6">
            <CreditCard className="w-10 h-10 mx-auto text-primary/20 mb-3" />
            <p className="text-sm text-muted-foreground mb-1">Stripe is not connected yet.</p>
            <p className="text-xs text-muted-foreground">Connect your Stripe account to view billing data for clients.</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!data.linked) {
    return (
      <Card className="bg-card border-border" data-testid="card-billing-unlinked">
        <CardHeader>
          <CardTitle className="text-foreground flex items-center gap-2">
            <CreditCard className="w-5 h-5" />
            Billing
          </CardTitle>
          <CardDescription>Link this client to a Stripe customer to see their billing information.</CardDescription>
        </CardHeader>
        <CardContent>
          <StripeCustomerSearch clientId={clientId} onLinked={() => {}} />
        </CardContent>
      </Card>
    );
  }

  const billing = data.billing;

  if (!billing) {
    return (
      <Card className="bg-card border-border" data-testid="card-billing-error">
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-foreground flex items-center gap-2">
              <CreditCard className="w-5 h-5" />
              Billing
            </CardTitle>
            <ConfirmActionDialog
              title="Unlink this Stripe customer?"
              description="The client is disconnected from this Stripe customer and billing data stops showing here. No Stripe data is deleted — you can re-link the customer at any time."
              confirmLabel="Unlink"
              testId="dialog-confirm-unlink-stripe"
              onConfirm={() => unlinkMutation.mutate()}
              trigger={
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs text-red-500 hover:text-red-600 dark:text-red-400"
                  data-testid="button-unlink-stripe"
                >
                  <Unlink className="w-3.5 h-3.5 mr-1" />
                  Unlink
                </Button>
              }
            />
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            {data.error || "Unable to load billing data. The Stripe customer may have been deleted."}
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="bg-card border-border" data-testid="card-billing">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-foreground flex items-center gap-2">
              <CreditCard className="w-5 h-5" />
              Billing
            </CardTitle>
            <CardDescription className="mt-1">
              {billing.customerName || billing.customerEmail || billing.stripeCustomerId}
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <PaymentStatusBadge billing={billing} />
            <ConfirmActionDialog
              title="Unlink this Stripe customer?"
              description="The client is disconnected from this Stripe customer and billing data stops showing here. No Stripe data is deleted — you can re-link the customer at any time."
              confirmLabel="Unlink"
              testId="dialog-confirm-unlink-stripe"
              onConfirm={() => unlinkMutation.mutate()}
              trigger={
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs text-red-500 hover:text-red-600 dark:text-red-400"
                  data-testid="button-unlink-stripe"
                >
                  <Unlink className="w-3.5 h-3.5 mr-1" />
                  Unlink
                </Button>
              }
            />
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="p-4 bg-surface-warm-1 rounded-lg" data-testid="billing-ltv">
            <div className="flex items-center gap-2 mb-1">
              <DollarSign className="w-4 h-4 text-primary/60" />
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Lifetime Value</span>
            </div>
            <p className="text-2xl font-bold text-foreground">
              {formatCurrency(billing.lifetimeValue, billing.currency)}
            </p>
          </div>

          <div className="p-4 bg-surface-warm-1 rounded-lg" data-testid="billing-subscription">
            <div className="flex items-center gap-2 mb-1">
              <CreditCard className="w-4 h-4 text-primary/60" />
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Current Plan</span>
            </div>
            {billing.activeSubscription ? (
              <>
                <p className="text-sm font-semibold text-foreground">{billing.activeSubscription.planName}</p>
                <p className="text-xs text-muted-foreground">
                  {formatCurrency(billing.activeSubscription.amount, billing.activeSubscription.currency)}/{billing.activeSubscription.interval}
                </p>
                {billing.activeSubscription.cancelAtPeriodEnd && (
                  <Badge variant="outline" className="mt-1 text-caption bg-amber-50 dark:bg-amber-950/25 text-amber-600 dark:text-amber-400 border-amber-200 dark:border-amber-800">
                    Cancels at period end
                  </Badge>
                )}
              </>
            ) : (
              <p className="text-sm text-muted-foreground">No active subscription</p>
            )}
          </div>

          <div className="p-4 bg-surface-warm-1 rounded-lg" data-testid="billing-next-date">
            <div className="flex items-center gap-2 mb-1">
              <CalendarDays className="w-4 h-4 text-primary/60" />
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Next Billing Date</span>
            </div>
            {billing.activeSubscription ? (
              <p className="text-sm font-semibold text-foreground">
                {formatDate(billing.activeSubscription.currentPeriodEnd)}
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">N/A</p>
            )}
          </div>

          <div className="p-4 bg-surface-warm-1 rounded-lg" data-testid="billing-payment-method">
            <div className="flex items-center gap-2 mb-1">
              <CreditCard className="w-4 h-4 text-primary/60" />
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Payment Method</span>
            </div>
            {billing.paymentStatus.cardLast4 ? (
              <>
                <p className="text-sm font-semibold text-foreground capitalize">
                  {billing.paymentStatus.cardBrand} **** {billing.paymentStatus.cardLast4}
                </p>
                <p className="text-xs text-muted-foreground">
                  Exp {billing.paymentStatus.cardExpMonth}/{billing.paymentStatus.cardExpYear}
                </p>
                {billing.paymentStatus.isCardExpiring && (
                  <Badge variant="outline" className="mt-1 text-caption bg-amber-50 dark:bg-amber-950/25 text-amber-600 dark:text-amber-400 border-amber-200 dark:border-amber-800">
                    <AlertTriangle className="w-2.5 h-2.5 mr-0.5" />
                    Expiring soon
                  </Badge>
                )}
              </>
            ) : (
              <p className="text-sm text-muted-foreground">No card on file</p>
            )}
          </div>
        </div>

        {billing.paymentStatus.lastPaymentDate && (
          <div className="mt-4 pt-3 border-t border-primary/5">
            <p className="text-xs text-muted-foreground" data-testid="billing-last-payment">
              Last payment: {billing.paymentStatus.lastPaymentAmount
                ? formatCurrency(billing.paymentStatus.lastPaymentAmount, billing.currency)
                : ""}{" "}
              on {formatDate(billing.paymentStatus.lastPaymentDate)}
              {billing.paymentStatus.lastPaymentStatus && (
                <span className={`ml-1 ${billing.paymentStatus.lastPaymentStatus === "succeeded" ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}>
                  ({billing.paymentStatus.lastPaymentStatus})
                </span>
              )}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
