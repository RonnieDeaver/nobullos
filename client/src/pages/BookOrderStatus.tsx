import { useEffect, useState } from "react";

type OrderStatus = {
  orderNumber: string;
  placedAt: string;
  packageLabel: string;
  orderState: "confirmed" | "partially_refunded" | "refunded" | "cancelled" | "under_review";
  totalAmountCents: number;
  refundedAmountCents: number;
  digitalDelivery: "available" | "preparing" | "unavailable";
  audioDelivery: "available" | "preparing" | "not_included";
  physicalFulfillment: "not_active" | "not_included";
};

function money(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}

function deliveryLabel(value: OrderStatus["digitalDelivery"]): string {
  if (value === "available") return "Ready in your secure access center";
  if (value === "preparing") return "Entitled — approved file is being prepared";
  return "Unavailable — contact support if this seems incorrect";
}

export default function BookOrderStatus() {
  const [order, setOrder] = useState<OrderStatus | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [email, setEmail] = useState("");
  const [resendMessage, setResendMessage] = useState("");

  useEffect(() => {
    if (window.location.hash) {
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    }
    let live = true;
    void fetch("/api/book/delivery/order-status", { credentials: "include" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Order access unavailable");
        return response.json() as Promise<{ order?: OrderStatus }>;
      })
      .then((body) => {
        if (!body.order) throw new Error("Order status missing");
        if (live) setOrder(body.order);
      })
      .catch(() => live && setUnavailable(true));
    return () => {
      live = false;
    };
  }, []);

  const requestResend = async (event: React.FormEvent) => {
    event.preventDefault();
    await fetch("/api/book/delivery/resend", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    }).catch(() => undefined);
    setResendMessage("If an active purchase matches this address, a fresh access email is on its way.");
  };

  const stateLabels: Record<OrderStatus["orderState"], string> = {
    confirmed: "Payment confirmed",
    partially_refunded: order ? `Partially refunded (${money(order.refundedAmountCents)})` : "Partially refunded",
    refunded: "Refunded",
    cancelled: "Cancelled",
    under_review: "Payment under review",
  };

  return (
    <main className="mx-auto flex min-h-[calc(100dvh-var(--nav-height))] max-w-2xl flex-col justify-center px-6 py-16">
      <p className="text-sm font-semibold uppercase tracking-[0.18em] text-muted-foreground">The Law Firm Revenue Engine</p>
      <h1 className="mt-3 text-3xl font-bold tracking-tight">Order status</h1>
      {!order && !unavailable && <p className="mt-4 text-muted-foreground">Checking your secure order session…</p>}
      {order && (
        <section className="mt-6 space-y-5 border p-5">
          <dl className="grid gap-3 text-sm">
            <div><dt className="text-muted-foreground">Order</dt><dd className="font-medium">{order.orderNumber}</dd></div>
            <div><dt className="text-muted-foreground">Edition</dt><dd className="font-medium">{order.packageLabel}</dd></div>
            <div><dt className="text-muted-foreground">Placed</dt><dd className="font-medium">{new Intl.DateTimeFormat("en-US", { year: "numeric", month: "long", day: "numeric" }).format(new Date(order.placedAt))}</dd></div>
            <div><dt className="text-muted-foreground">Total</dt><dd className="font-medium">{money(order.totalAmountCents)}</dd></div>
            <div><dt className="text-muted-foreground">Order state</dt><dd className="font-medium">{stateLabels[order.orderState]}</dd></div>
            <div><dt className="text-muted-foreground">Digital book</dt><dd className="font-medium">{deliveryLabel(order.digitalDelivery)}</dd></div>
            {order.audioDelivery !== "not_included" && <div><dt className="text-muted-foreground">Audiobook</dt><dd className="font-medium">{deliveryLabel(order.audioDelivery)}</dd></div>}
            {order.physicalFulfillment === "not_active" && <div><dt className="text-muted-foreground">Printed edition</dt><dd className="font-medium">Not active — no shipment, carrier, or tracking details are available</dd></div>}
          </dl>
          <p className="text-xs text-muted-foreground">For your privacy, this page never displays an email, address, card information, carrier, or private application answers.</p>
          <a className="inline-block font-medium underline" href="/book/access">Go to my downloads</a>
        </section>
      )}
      {unavailable && (
        <>
          <p className="mt-4 text-muted-foreground">Order access is unavailable or has expired. Open a fresh secure link to continue.</p>
          <form className="mt-8 space-y-3" onSubmit={requestResend}>
            <label className="block text-sm font-medium" htmlFor="order-delivery-email">Purchase email</label>
            <input id="order-delivery-email" className="w-full border px-3 py-2" type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} />
            <button className="bg-primary px-4 py-2 font-medium text-primary-foreground" type="submit">Send a new access link</button>
            {resendMessage && <p className="text-sm text-muted-foreground">{resendMessage}</p>}
          </form>
        </>
      )}
    </main>
  );
}