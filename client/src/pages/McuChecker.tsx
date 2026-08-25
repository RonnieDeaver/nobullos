import { useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PageHeader } from "@/components/admin/PageHeader";
import { StatusPill, type StatusTone } from "@/components/kit/StatusPill";
import { CheckCircle, XCircle, AlertTriangle, MapPin, TrendingUp, Building2 } from "lucide-react";

// Task #4370 — MCU Checker adoption (design audit P2-4, owner decision §8.4-d).
// This page used to be a chrome-less navy/gold orphan (its own
// #1a1a2e/#C4A35A palette, no nav entry). It now renders on the house tokens
// (beige canvas, crimson primary, square corners, the status-* scale) under
// the standard PageHeader, and is reachable from the global nav's Internal
// Tools cluster (CEO-gated quicklink grouped with the MCU dashboard). The
// route itself stays PUBLIC (lib/publicPaths.ts) so sales can run checks
// without signing in — checker logic and the /api/mcu contract are unchanged.

type CapacityStatus = "Open" | "Filling" | "Tight" | "Saturated";

interface EvaluationResult {
  address: string;
  capacityUsedPercent: number;
  status: CapacityStatus;
  statusColor: "green" | "yellow" | "orange" | "red";
  narrative: string;
  verdict: "approved" | "conditional" | "decline";
}

interface SalesEvaluationResponse {
  results: EvaluationResult[];
}

export default function McuChecker() {
  const { isAuthenticated } = useAuth();
  const [practiceArea, setPracticeArea] = useState("");
  const [addressesText, setAddressesText] = useState("");
  const [results, setResults] = useState<EvaluationResult[] | null>(null);

  const { data: practiceAreas } = useQuery<string[]>({
    queryKey: ["/api/mcu/practice-areas"],
    queryFn: async () => {
      const res = await fetch("/api/mcu/practice-areas");
      if (!res.ok) throw new Error("Failed to fetch practice areas");
      return res.json();
    },
  });

  const evaluateMutation = useMutation({
    mutationFn: async (data: { addresses: string[]; practiceArea: string }) => {
      const res = await fetch("/api/mcu/evaluate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error("Failed to evaluate");
      return res.json() as Promise<SalesEvaluationResponse>;
    },
    onSuccess: (data) => {
      setResults(data.results);
    },
  });

  const handleEvaluate = () => {
    const addresses = addressesText
      .split("\n")
      .map((a) => a.trim())
      .filter((a) => a.length > 0);

    if (addresses.length === 0 || !practiceArea) return;

    evaluateMutation.mutate({ addresses, practiceArea });
  };

  const getVerdictConfig = (verdict: string) => {
    switch (verdict) {
      case "approved":
        return { icon: CheckCircle, text: "Approved", textColor: "text-status-ok" };
      case "conditional":
        return { icon: AlertTriangle, text: "Conditional", textColor: "text-status-warn" };
      case "decline":
        return { icon: XCircle, text: "Decline", textColor: "text-status-critical" };
      default:
        return { icon: AlertTriangle, text: "Unknown", textColor: "text-muted-foreground" };
    }
  };

  // The server's four-color capacity ramp maps onto the OS's three-step
  // status scale (index.css usage rule: ok / warn / critical — there is
  // deliberately no fourth "orange" token). yellow and orange share the warn
  // family; the pill label (Filling vs Tight) plus the percent readout carry
  // the distinction, so status is never color-alone.
  const getStatusConfig = (
    color: "green" | "yellow" | "orange" | "red",
  ): { barColor: string; tone: StatusTone } => {
    switch (color) {
      case "green": return { barColor: "bg-status-ok", tone: "ok" };
      case "yellow": return { barColor: "bg-status-warn", tone: "warn" };
      case "orange": return { barColor: "bg-status-warn", tone: "warn" };
      case "red": return { barColor: "bg-status-critical", tone: "critical" };
    }
  };

  return (
    <div
      // Hybrid route (Task #4370/#4753): signed-in users get the global nav
      // above this page, so subtract --nav-height like other authed pages;
      // anonymous visitors render chrome-less and keep full viewport height.
      className={
        isAuthenticated
          ? "min-h-[calc(100dvh-var(--nav-height))] bg-background"
          : "min-h-screen bg-background"
      }
    >
      <main className="max-w-4xl mx-auto p-4 sm:p-6 space-y-6">
        <PageHeader
          title="MCU Capacity Checker"
          icon={Building2}
          subtitle="Check market capacity for new prospects"
          backHref="/"
          backLabel="Dashboard"
        />

        <Card>
          <CardHeader>
            <CardTitle>Evaluate Prospect Locations</CardTitle>
            <CardDescription>
              Enter addresses to check market capacity and overlap with existing clients
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label>Practice Area</Label>
              <Select value={practiceArea} onValueChange={setPracticeArea}>
                <SelectTrigger data-testid="select-practice-area">
                  <SelectValue placeholder="Select practice area" />
                </SelectTrigger>
                <SelectContent>
                  {practiceAreas?.map((area) => (
                    <SelectItem key={area} value={area}>
                      {area}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label>Addresses (one per line)</Label>
              <Textarea
                value={addressesText}
                onChange={(e) => setAddressesText(e.target.value)}
                placeholder="123 Main St, Dallas, TX 75201&#10;456 Oak Ave, Houston, TX 77002"
                className="min-h-[120px]"
                data-testid="input-addresses"
              />
              <p className="text-caption text-muted-foreground">
                Enter full addresses including city and state for accurate results
              </p>
            </div>

            <Button
              onClick={handleEvaluate}
              disabled={!practiceArea || !addressesText.trim() || evaluateMutation.isPending}
              className="w-full"
              data-testid="button-evaluate"
            >
              {evaluateMutation.isPending ? "Evaluating..." : "Check Capacity"}
            </Button>
          </CardContent>
        </Card>

        {results && (
          <section className="space-y-4" aria-label="Evaluation results">
            <h2 className="text-xl font-bold text-foreground flex items-center gap-2">
              <TrendingUp className="w-5 h-5 text-primary" />
              Evaluation Results
            </h2>

            {results.map((result, index) => {
              const verdictConfig = getVerdictConfig(result.verdict);
              const VerdictIcon = verdictConfig.icon;
              const statusConfig = getStatusConfig(result.statusColor);

              return (
                <Card key={index} className="overflow-hidden" data-testid={`result-card-${index}`}>
                  <div className={`h-2 ${statusConfig.barColor}`} />
                  <CardContent className="p-4 sm:p-6">
                    <div className="flex flex-col gap-4">
                      <div className="flex items-start gap-3">
                        <MapPin className="w-5 h-5 text-muted-foreground mt-0.5 shrink-0" />
                        <div className="flex-1">
                          <p className="font-medium text-foreground">{result.address}</p>
                          <div className="flex items-center gap-2 mt-2">
                            <VerdictIcon className={`w-5 h-5 ${verdictConfig.textColor}`} />
                            <span className={`font-bold text-lg ${verdictConfig.textColor}`}>
                              {verdictConfig.text}
                            </span>
                          </div>
                        </div>
                      </div>

                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="text-sm text-muted-foreground">Safe Capacity Used</span>
                          <StatusPill tone={statusConfig.tone}>{result.status}</StatusPill>
                        </div>
                        <div className="flex items-center gap-3">
                          {/* Square capacity track — the OS's machined-corner
                              contract (--radius: 0rem) applies to gauges too. */}
                          <div className="flex-1 h-3 bg-muted overflow-hidden">
                            <div
                              className={`h-full ${statusConfig.barColor} transition-all`}
                              style={{ width: `${Math.min(100, result.capacityUsedPercent)}%` }}
                            />
                          </div>
                          <span className="font-bold text-foreground text-lg w-14 text-right">{result.capacityUsedPercent}%</span>
                        </div>
                      </div>

                      <div className="border border-border bg-muted/40 p-4">
                        <p className="text-base leading-relaxed text-foreground">
                          {result.narrative}
                        </p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </section>
        )}
      </main>
    </div>
  );
}
