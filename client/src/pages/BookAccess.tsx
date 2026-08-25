import { useEffect, useState } from "react";

type Asset = {
  id: string;
  filename: string;
  contentType: string;
  entitlementCode: "digital_book" | "audiobook";
};
type ViewState = "exchanging" | "ready" | "unavailable";

async function readAssets(): Promise<Asset[] | null> {
  const response = await fetch("/api/book/delivery/assets", { credentials: "include" });
  if (!response.ok) return null;
  const body = (await response.json()) as { assets?: Asset[] };
  return Array.isArray(body.assets) ? body.assets : null;
}

export default function BookAccess() {
  const [state, setState] = useState<ViewState>("exchanging");
  const [assets, setAssets] = useState<Asset[]>([]);
  const [email, setEmail] = useState("");
  const [resendMessage, setResendMessage] = useState("");

  useEffect(() => {
    let live = true;
    const open = async () => {
      const token = new URLSearchParams(window.location.hash.slice(1)).get("access");
      // Clear the capability before any network request, third-party script, or
      // browser history entry can observe it. The server receives it only in
      // this POST body and replaces it with an HttpOnly session cookie.
      if (window.location.hash) window.history.replaceState(null, "", window.location.pathname);
      if (token) {
        const exchanged = await fetch("/api/book/delivery/exchange", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        });
        if (!exchanged.ok) {
          if (live) setState("unavailable");
          return;
        }
      }
      const nextAssets = await readAssets();
      if (!live) return;
      if (nextAssets === null) setState("unavailable");
      else {
        setAssets(nextAssets);
        setState("ready");
      }
    };
    void open().catch(() => live && setState("unavailable"));
    return () => { live = false; };
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

  return (
    <main className="mx-auto flex min-h-[calc(100dvh-var(--nav-height))] max-w-2xl flex-col justify-center px-6 py-16">
      <p className="text-sm font-semibold uppercase tracking-[0.18em] text-muted-foreground">Law Firm Revenue Engine</p>
      <h1 className="mt-3 text-3xl font-bold tracking-tight">Your book library</h1>
      {state === "exchanging" && <p className="mt-4 text-muted-foreground">Checking your secure access…</p>}
      {state === "ready" && (
        <section className="mt-6 space-y-4">
          {assets.length > 0 ? assets.map((asset) => (
            <a key={asset.id} className="block border p-4 font-medium underline" href={`/api/book/delivery/download/${encodeURIComponent(asset.id)}`}>
              {asset.entitlementCode === "audiobook" ? "Download audiobook" : "Download digital book"}
              <span className="mt-1 block text-sm font-normal text-muted-foreground">{asset.filename}</span>
            </a>
          )) : <p className="text-muted-foreground">Your purchase is verified, but no approved download is available right now. We’ll email you when your entitled file is ready.</p>}
          <a className="inline-block font-medium underline" href="/book/order-status">View order status</a>
        </section>
      )}
      {state === "unavailable" && <p className="mt-4 text-muted-foreground">This access link is unavailable or has expired.</p>}
      <form className="mt-8 space-y-3" onSubmit={requestResend}>
        <h2 className="text-xl font-semibold">Send a new access link</h2>
        <p className="text-sm text-muted-foreground">Use the email from checkout if your link expired, you changed devices, or you lost the original message.</p>
        <label className="block text-sm font-medium" htmlFor="delivery-email">Purchase email</label>
        <input id="delivery-email" className="w-full border px-3 py-2" type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} />
        <button className="bg-primary px-4 py-2 font-medium text-primary-foreground" type="submit">Send a new access link</button>
        {resendMessage && <p className="text-sm text-muted-foreground">{resendMessage}</p>}
      </form>
      <aside className="mt-8 border bg-muted/40 p-4 text-sm text-muted-foreground">
        If a refund, revocation, or unavailable file may apply, a new link will not override it. Contact NoBull support with your purchase email and order number—never send card details or an access link.
      </aside>
    </main>
  );
}