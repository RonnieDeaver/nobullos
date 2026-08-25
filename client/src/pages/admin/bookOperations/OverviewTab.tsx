/**
 * Book Operations — Overview tab.
 * Summary: funnel stages + conversion rates, financials, slices, health.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { KpiCard } from "@/components/kit/KpiCard";
import { AlertCircle, CheckCircle2, XCircle, TriangleAlert, Clock, Shield, Info } from "lucide-react";

import type { BookOpsSummary, BookOpsHealth } from "./types";
import {
  fmtCurrency,
  fmtRate,
  capitalize,
  daysAgoStr,
  todayStr,
  localDateStr,
  dateStrToIsoFrom,
  dateStrToIsoTo,
} from "./utils";

// ─── Date range bar ───────────────────────────────────────────────────────────

function DateRangeBar({
  fromStr,
  toStr,
  onChange,
}: {
  fromStr: string;
  toStr: string;
  onChange: (from: string, to: string) => void;
}) {
  const [localFrom, setLocalFrom] = useState(fromStr);
  const [localTo, setLocalTo] = useState(toStr);

  function apply() {
    if (!localFrom || !localTo) return;
    const f = new Date(localFrom);
    const t = new Date(localTo);
    if (f > t) return;
    // Must not exceed 366 days (server validation)
    const diffDays = (t.getTime() - f.getTime()) / 86_400_000;
    if (diffDays > 366) return;
    onChange(dateStrToIsoFrom(localFrom), dateStrToIsoTo(localTo));
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-muted-foreground">Period:</span>
      <input
        type="date"
        aria-label="From date"
        className="h-8 rounded border border-input bg-background px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
        value={localFrom}
        max={localTo}
        onChange={(e) => setLocalFrom(e.target.value)}
      />
      <span className="text-muted-foreground text-xs">–</span>
      <input
        type="date"
        aria-label="To date"
        className="h-8 rounded border border-input bg-background px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
        value={localTo}
        min={localFrom}
        onChange={(e) => setLocalTo(e.target.value)}
      />
      <button
        type="button"
        className="h-8 rounded border border-input bg-background px-3 text-xs hover:bg-accent"
        onClick={apply}
      >
        Apply
      </button>
    </div>
  );
}

// ─── Health chip ──────────────────────────────────────────────────────────────

function HealthChip({
  label,
  provider,
}: {
  label: string;
  provider: BookOpsHealth["providers"]["stripe"];
}) {
  const { connected, disconnectReason, lastCheckedAt, lastProbeError } = provider;
  const isCold = lastCheckedAt == null;

  const icon = isCold ? (
    <Clock className="h-3.5 w-3.5 text-slate-400" />
  ) : connected === true ? (
    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
  ) : connected === false ? (
    <XCircle className="h-3.5 w-3.5 text-red-500" />
  ) : (
    <Info className="h-3.5 w-3.5 text-slate-400" />
  );

  const borderCls = isCold
    ? "border-slate-200 dark:border-slate-700"
    : connected === true
      ? "border-emerald-200 dark:border-emerald-800"
      : connected === false
        ? "border-red-200 dark:border-red-800"
        : "border-slate-200 dark:border-slate-700";

  const stateLabel = isCold
    ? "Not yet checked"
    : connected === true
      ? "Connected"
      : connected === false
        ? "Disconnected"
        : "Unknown";

  return (
    <div className={`rounded border px-3 py-2 text-sm ${borderCls}`}>
      <div className="flex items-center gap-1.5 font-medium">
        {icon}
        <span>{label}</span>
        <span className="text-xs text-muted-foreground font-normal">— {stateLabel}</span>
      </div>
      <div className="mt-1 space-y-0.5 text-xs text-muted-foreground">
        {isCold ? (
          <p>Cache will populate on first health probe.</p>
        ) : (
          <>
            {lastCheckedAt && (
              <p>
                Cached:{" "}
                {new Date(lastCheckedAt).toLocaleString("en-US", {
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </p>
            )}
            {disconnectReason && (
              <p className="text-red-600 dark:text-red-400">Reason: {disconnectReason}</p>
            )}
            {lastProbeError && (
              <p className="text-amber-600 dark:text-amber-400">
                Last probe error: {lastProbeError}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function LaunchReadinessPanel({ health }: { health: BookOpsHealth }) {
  const readiness = health.launchReadiness;
  return (
    <Card accent={readiness.packages.digital.purchasable ? undefined : "warn"}>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Book funnel launch readiness</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <p className="text-xs text-muted-foreground">
          Environment: {readiness.environment}. Detailed blockers are operator-only;
          customer checkout receives a generic availability response.
        </p>
        <div className="grid gap-3 lg:grid-cols-2">
          {(["digital", "complete"] as const).map((code) => {
            const item = readiness.packages[code];
            return (
              <div key={code} className="rounded border border-border p-3">
                <div className="flex items-center justify-between gap-2">
                  <strong>{code === "digital" ? "Digital Edition" : "Complete Collection"}</strong>
                  <span className={item.purchasable ? "text-emerald-600" : "text-amber-700 dark:text-amber-300"}>
                    {item.purchasable ? "Purchasable" : "Blocked"}
                  </span>
                </div>
                {item.blockers.length > 0 && (
                  <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                    {item.blockers.map((blocker) => (
                      <li key={blocker.code}>
                        <code className="font-mono text-caption">{blocker.code}</code>
                        {" — "}
                        {blocker.detail}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground">
          Physical fulfillment boundary: <strong>{readiness.fulfillmentBoundary.state}</strong>.
          No provider calls or credentials are active.
        </p>
      </CardContent>
    </Card>
  );
}

// ─── Funnel display ───────────────────────────────────────────────────────────

function FunnelSection({ summary }: { summary: BookOpsSummary }) {
  const { funnel, conversionRates } = summary;
  if (!funnel.length) return null;

  // Build a rate map: "visitor→checkout" → rate
  const rateMap = new Map<string, number | null>();
  for (const cr of conversionRates) {
    rateMap.set(`${cr.from}→${cr.to}`, cr.rate);
  }

  return (
    <div>
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Funnel Stages
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-xs text-muted-foreground">
              <th className="pb-1 text-left font-medium">Stage</th>
              <th className="pb-1 text-right font-medium">Count</th>
              <th className="pb-1 text-right font-medium">→ Next</th>
            </tr>
          </thead>
          <tbody>
            {funnel.map((stage, i) => {
              const next = funnel[i + 1];
              const rateKey = next ? `${stage.stage}→${next.stage}` : null;
              const rate = rateKey ? rateMap.get(rateKey) ?? null : null;
              return (
                <tr key={stage.stage} className="border-b last:border-0">
                  <td className="py-1.5 font-medium">{capitalize(stage.stage)}</td>
                  <td className="py-1.5 text-right tabular-nums">
                    {stage.count.toLocaleString()}
                  </td>
                  <td className="py-1.5 text-right tabular-nums text-muted-foreground">
                    {rateKey ? (
                      <span
                        className={
                          rate != null && rate < 0.1
                            ? "text-amber-600 dark:text-amber-400"
                            : ""
                        }
                      >
                        {fmtRate(rate)}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Slice breakdown card ─────────────────────────────────────────────────────

function SliceCard({ title, slices }: { title: string; slices: BookOpsSummary["packageSlices"] }) {
  return (
    <Card>
      <CardHeader className="pb-2 pt-4 px-4">
        <CardTitle className="text-sm font-semibold">{title}</CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-4 pt-0">
        {slices.length === 0 ? (
          <p className="text-xs text-muted-foreground">No data</p>
        ) : (
          <ul className="space-y-2">
            {slices.map((s) => (
              <li key={s.key} className="text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-medium text-slate-700 dark:text-slate-300">
                    {s.label || s.key}
                  </span>
                  <span className="shrink-0 text-muted-foreground">
                    {s.orderCount.toLocaleString()} orders
                  </span>
                </div>
                <div className="mt-0.5 flex gap-3 text-muted-foreground">
                  <span>Gross {fmtCurrency(s.grossCents)}</span>
                  {s.refundCents > 0 && (
                    <span className="text-amber-600 dark:text-amber-400">
                      − {fmtCurrency(s.refundCents)}
                    </span>
                  )}
                  <span className="text-slate-600 dark:text-slate-400">
                    Net {fmtCurrency(s.netCents)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export function OverviewTab() {
  const defaultFrom = daysAgoStr(30);
  const defaultTo = todayStr();
  const [fromIso, setFromIso] = useState(dateStrToIsoFrom(defaultFrom));
  const [toIso, setToIso] = useState(dateStrToIsoTo(defaultTo));

  const { data, isLoading, isError, dataUpdatedAt } = useQuery<BookOpsSummary>({
    queryKey: ["/api/admin/book-operations/summary", fromIso, toIso],
    queryFn: () =>
      apiRequest(
        "GET",
        `/api/admin/book-operations/summary?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`,
      ).then((r) => r.json()),
    staleTime: 60_000,
  });

  const healthQuery = useQuery<BookOpsHealth>({
    queryKey: ["/api/admin/book-operations/health"],
    queryFn: () =>
      apiRequest("GET", "/api/admin/book-operations/health").then((r) => r.json()),
    staleTime: 120_000,
    refetchInterval: 120_000,
  });

  const isStale = dataUpdatedAt > 0 && Date.now() - dataUpdatedAt > 300_000;

  return (
    <div className="space-y-6">
      <DateRangeBar
        fromStr={defaultFrom}
        toStr={localDateStr(new Date())}
        onChange={(f, t) => {
          setFromIso(f);
          setToIso(t);
        }}
      />

      {isLoading && (
        <div className="flex items-center justify-center gap-2 py-16 text-muted-foreground">
          <Spinner className="h-5 w-5" />
          Loading summary…
        </div>
      )}

      {isError && (
        <Card accent="critical">
          <CardContent className="flex items-center gap-2 py-4 text-sm text-red-700 dark:text-red-400">
            <AlertCircle className="h-4 w-4 shrink-0" />
            Failed to load overview summary. The API may be unavailable.
          </CardContent>
        </Card>
      )}

      {!isLoading && !isError && data && (
        <>
          {isStale && (
            <div className="flex items-center gap-2 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
              <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
              Summary data may be stale — last loaded over 5 minutes ago.
            </div>
          )}

          {/* Financials KPIs */}
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Financials — {data.period.from.slice(0, 10)} to {data.period.to.slice(0, 10)}
            </p>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <KpiCard
                label="Orders"
                value={data.financials.orderCount.toLocaleString()}
                testId="kpi-orders"
              />
              <KpiCard
                label="Gross Revenue"
                value={fmtCurrency(data.financials.grossCents)}
                testId="kpi-gross"
              />
              <KpiCard
                label="Net Revenue"
                value={fmtCurrency(data.financials.netCents)}
                caption={
                  data.financials.refundCents > 0
                    ? `−${fmtCurrency(data.financials.refundCents)} refunded`
                    : "No refunds"
                }
                accent={data.financials.refundCents > 0 ? "warn" : undefined}
                testId="kpi-net"
              />
              <KpiCard
                label="AOV"
                value={fmtCurrency(data.financials.aovCents)}
                caption="Avg order value (gross)"
                testId="kpi-aov"
              />
            </div>
          </div>

          {/* Margin unavailable notice */}
          {data.marginInputs.status === "unavailable" && (
            <div className="flex items-start gap-2 rounded border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600 dark:border-slate-700 dark:bg-slate-800/30 dark:text-slate-400">
              <Shield className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                <strong>Margin data not available.</strong> Cost-of-goods and fulfillment cost are
                outside this console's authority boundary. Contact Finance for margin reporting.
              </span>
            </div>
          )}

          {/* Funnel */}
          <Card>
            <CardContent className="pt-4 px-4 pb-4">
              <FunnelSection summary={data} />
            </CardContent>
          </Card>

          {/* Slices */}
          <div className="grid gap-4 sm:grid-cols-3">
            <SliceCard title="By Package" slices={data.packageSlices} />
            <SliceCard title="By Channel" slices={data.channelSlices} />
            <SliceCard title="By Campaign" slices={data.campaignSlices} />
          </div>
        </>
      )}

      {/* Health — cache_only, max refetch 2 min */}
      <div>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Integration Health (cache only)
        </p>
        <p className="mb-2 text-xs text-muted-foreground">
          Results reflect the last known cached probe state — no live provider call is made from
          this console. GHL sales records, SMS consent, and payment state are outside this
          console's read boundary.
        </p>
        {healthQuery.isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner className="h-4 w-4" /> Loading health cache…
          </div>
        ) : healthQuery.isError || !healthQuery.data ? (
          <p className="text-sm text-muted-foreground">Health cache unavailable.</p>
        ) : (
          <>
            <div className="grid gap-2 sm:grid-cols-2">
              <HealthChip label="Stripe" provider={healthQuery.data.providers.stripe} />
              <HealthChip label="GoHighLevel (GHL)" provider={healthQuery.data.providers.ghl} />
            </div>
            <div className="mt-4">
              <LaunchReadinessPanel health={healthQuery.data} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
