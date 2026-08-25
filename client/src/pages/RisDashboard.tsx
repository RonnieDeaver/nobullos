import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, Link, useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest, getQueryFn, formatQueryError } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, type CardAccent } from "@/components/ui/card";
import { OsTable } from "@/components/ui/os-table";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ShieldCheck,
  AlertTriangle,
  ChevronLeft,
  Settings2,
} from "lucide-react";
import { FUNCTION_LABELS, isUserFunction } from "@/lib/userLabels";

// ─── Types (mirror server/services/ris/risService.ts) ────────────────
interface RisRollup {
  totalDue: number;
  completed: number;
  completionPct: number;
  pass: number;
  fail: number;
  na: number;
  blocked: number;
  needsReview: number;
  untouched: number;
  openFails: number;
  openBlocked: number;
  topSeverity: string | null;
  dueThisWeek: number;
  dueThisMonth: number;
  launchDue: number;
}
interface ClientRollupSummary {
  clientId: string;
  firmName: string;
  products: string[];
  rollup: RisRollup;
}
interface PortfolioRollup {
  period: string;
  clients: ClientRollupSummary[];
  totals: RisRollup;
}
// Engagement layer (Task #2388): live comms volume for check #7.
interface CommunicationCadence {
  period: string;
  emailsSent: number;
  callsMade: number;
  textsSent: number;
  totalOutboundTouches: number;
  lastOutboundAt: string | null;
  lastInboundAt: string | null;
}
interface ChecklistInstance {
  checkId: string;
  key: string;
  label: string;
  description: string | null;
  product: string;
  category: string;
  frequency: string;
  locationSpecific: boolean;
  autoSource: string | null;
  defaultSeverity: string;
  effectiveSeverity: string;
  defaultOwnerFunction: string | null;
  locationId: string | null;
  locationName: string | null;
  period: string;
  dueBucket: "week" | "month" | "launch";
  resultId: string | null;
  status: string | null;
  observedValue: string | null;
  notes: string | null;
  evidenceUrl: string | null;
  failureReason: string | null;
  correctiveAction: string | null;
  source: string | null;
  checkedBy: string | null;
  checkedByName: string | null;
  checkedAt: string | null;
  autoError: string | null;
  confirmedAt: string | null;
  confirmedBy: string | null;
  confirmedByName: string | null;
  cadence?: CommunicationCadence | null;
}
interface ClientChecklist {
  client: { id: string; firmName: string };
  products: string[];
  period: string;
  instances: ChecklistInstance[];
  rollup: RisRollup;
}
interface RisCheck {
  id: string;
  key: string;
  label: string;
  description: string | null;
  layer: string;
  product: string;
  category: string;
  frequency: string;
  locationSpecific: boolean;
  defaultSeverity: string;
  defaultOwnerFunction: string | null;
  autoSource: string | null;
  active: boolean;
  sortOrder: number;
  isSystem: boolean;
}

// ─── Task #2371 — Performance Layer shapes (mirror risService.ts) ─────
type PerfStatus = "green" | "yellow" | "red" | "gray" | "na";
interface PerfStatusCounts {
  green: number;
  yellow: number;
  red: number;
  gray: number;
  na: number;
}
interface PerformanceMetric {
  checkId: string;
  key: string;
  label: string;
  description: string | null;
  product: string;
  category: string;
  metricType: string | null;
  defaultSeverity: string;
  effectiveSeverity: string;
  defaultOwnerFunction: string | null;
  period: string;
  resultId: string | null;
  status: PerfStatus | null;
  observedValue: string | null;
  currentValue: string | null;
  previousValue: string | null;
  targetValue: string | null;
  changePct: string | null;
  notes: string | null;
  source: string | null;
  autoError: string | null;
  checkedAt: string | null;
  confirmedAt: string | null;
}
interface ProductHealthCard {
  product: string;
  status: PerfStatus;
  counts: PerfStatusCounts;
  topSeverity: string | null;
  metrics: PerformanceMetric[];
}
interface ClientPerformance {
  client: { id: string; firmName: string };
  products: string[];
  period: string;
  cards: ProductHealthCard[];
}
interface ClientPerformanceSummary {
  clientId: string;
  firmName: string;
  products: string[];
  status: PerfStatus;
  counts: PerfStatusCounts;
  topSeverity: string | null;
}
interface PortfolioPerformance {
  period: string;
  clients: ClientPerformanceSummary[];
  totals: PerfStatusCounts;
}

const STATUS_OPTIONS = [
  { value: "pass", label: "Pass" },
  { value: "fail", label: "Fail" },
  { value: "na", label: "N/A" },
  { value: "blocked", label: "Blocked" },
  { value: "needs_review", label: "Needs Review" },
];

const STATUS_BADGE: Record<string, string> = {
  pass: "bg-status-ok/10 text-status-ok border-status-ok/40",
  fail: "bg-status-critical/10 text-status-critical border-status-critical/40",
  na: "bg-muted/50 text-muted-foreground border-border",
  blocked: "bg-status-warn/10 text-status-warn border-status-warn/40",
  needs_review: "bg-status-info/10 text-status-info border-status-info/40",
};

// ─── Task #2371 — Performance Layer status presentation ──────────────
const PERF_STATUS_LABEL: Record<PerfStatus, string> = {
  green: "Healthy",
  yellow: "Watch",
  red: "At risk",
  gray: "No data",
  na: "N/A",
};
const PERF_STATUS_BADGE: Record<PerfStatus, string> = {
  green: "bg-status-ok/10 text-status-ok border-status-ok/40",
  yellow: "bg-status-warn/10 text-status-warn border-status-warn/40",
  red: "bg-status-critical/10 text-status-critical border-status-critical/40",
  gray: "bg-muted/50 text-muted-foreground border-border",
  na: "bg-muted/30 text-muted-foreground border-border",
};
const PERF_STATUS_DOT: Record<PerfStatus, string> = {
  green: "bg-status-ok",
  yellow: "bg-status-warn",
  red: "bg-status-critical",
  gray: "bg-muted-foreground/40",
  na: "bg-muted-foreground/25",
};
// Task #4372 (audit P2-14): product-health rail rides the shared Card
// `accent` variant. gray/na carry no signal, so they get no stripe (the
// kit deliberately has no neutral-gray accent).
const PERF_ACCENT: Record<PerfStatus, CardAccent | undefined> = {
  green: "ok",
  yellow: "warn",
  red: "critical",
  gray: undefined,
  na: undefined,
};
const METRIC_TYPE_LABEL: Record<string, string> = {
  volume: "Volume",
  cost: "Cost",
  rate: "Rate",
  budget: "Budget pacing",
};

// Engagement layer (Task #2388): same underlying status enum, but the
// Engagement layer presents it as a Green / Yellow / Red traffic light.
const ENGAGEMENT_STATUS_LABELS: Record<string, string> = {
  pass: "Green",
  needs_review: "Yellow",
  fail: "Red",
  na: "N/A",
  blocked: "Blocked",
};
const ENGAGEMENT_STATUS_BADGE: Record<string, string> = {
  pass: "bg-status-ok/10 text-status-ok border-status-ok/40",
  needs_review: "bg-status-warn/10 text-status-warn border-status-warn/40",
  fail: "bg-status-critical/10 text-status-critical border-status-critical/40",
  na: "bg-muted/50 text-muted-foreground border-border",
  blocked: "bg-status-warn/10 text-status-warn border-status-warn/40",
};

const LAYER_OPTIONS = [
  { value: "qa", label: "QA" },
  { value: "performance", label: "Performance" },
  { value: "engagement", label: "Engagement" },
];

const CATEGORY_LABEL: Record<string, string> = {
  access: "Access",
  tracking: "Tracking",
  fulfillment: "Fulfillment",
  automation: "Automation",
  reporting: "Reporting",
  spend_delivery: "Spend & Delivery",
  client_engagement: "Client Engagement",
  nobull_cadence: "NoBull Cadence",
};

// Per-layer status presentation. QA keeps Pass/Fail/etc; Engagement maps
// the identical enum onto the Green/Yellow/Red traffic light.
function statusLabel(layer: string, value: string | null): string {
  if (!value) return layer === "engagement" ? "Not set" : "Not checked";
  if (layer === "engagement")
    return ENGAGEMENT_STATUS_LABELS[value] ?? value;
  return STATUS_OPTIONS.find((o) => o.value === value)?.label ?? value;
}
function statusBadgeClass(layer: string, value: string | null): string {
  if (!value) return "bg-gray-50 text-gray-500 border-gray-200";
  const map = layer === "engagement" ? ENGAGEMENT_STATUS_BADGE : STATUS_BADGE;
  return map[value] ?? "bg-gray-50 text-gray-500 border-gray-200";
}
function statusOptionsForLayer(layer: string) {
  if (layer === "engagement")
    return STATUS_OPTIONS.map((o) => ({
      value: o.value,
      label: ENGAGEMENT_STATUS_LABELS[o.value] ?? o.label,
    }));
  return STATUS_OPTIONS;
}
const PRODUCT_LABEL: Record<string, string> = {
  universal: "Universal",
  gbp: "GBP / Local SEO",
  google_ads: "Google Ads",
  lsa: "LSA",
  webinar: "Webinar",
};

const FREQUENCY_LABEL: Record<string, string> = {
  weekly: "Weekly",
  monthly: "Monthly",
  launch_only: "Launch",
};

function fmtCheckedAt(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function currentPeriod(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function recentPeriods(count = 6): string[] {
  const out: string[] = [];
  const d = new Date();
  for (let i = 0; i < count; i++) {
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
    d.setMonth(d.getMonth() - 1);
  }
  return out;
}

function SeverityBadge({ severity }: { severity: string | null }) {
  if (!severity) return null;
  // Alarm color stays reserved for critical; high/medium ride the warn tint
  // ramp and low is neutral, so a wall of findings doesn't read as all-red.
  const cls =
    severity === "critical"
      ? "border border-status-critical/60 bg-status-critical/15 text-status-critical font-semibold"
      : severity === "high"
        ? "border border-status-warn/60 bg-status-warn/15 text-status-warn font-semibold"
        : severity === "medium"
          ? "border border-status-warn/40 bg-status-warn/10 text-status-warn"
          : "border border-border bg-muted/50 text-muted-foreground";
  return (
    <span
      className={`text-[11px] uppercase px-1.5 py-0.5 rounded ${cls}`}
      data-testid={`badge-severity-${severity}`}
    >
      {severity}
    </span>
  );
}

function RollupStat({
  label,
  value,
  testId,
  tone,
}: {
  label: string;
  value: number | string;
  testId: string;
  tone?: string;
}) {
  return (
    <div className="flex flex-col">
      <span className={`text-2xl font-semibold ${tone ?? ""}`} data-testid={testId}>
        {value}
      </span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}

// ─── Task #2368 — Auto-source mapping registry editor ────────────────
interface AutoMapping {
  id: string;
  autoSource: string;
  label: string;
  enabled: boolean;
  sqlTemplate: string | null;
  valueColumn: string;
  comparator: string;
  threshold: string | null;
  unitLabel: string | null;
  bqLocation: string | null;
  description: string | null;
}

const COMPARATOR_OPTIONS = [
  { value: "none", label: "No rule (record only)" },
  { value: "gte", label: "≥ threshold" },
  { value: "lte", label: "≤ threshold" },
  { value: "gt", label: "> threshold" },
  { value: "lt", label: "< threshold" },
  { value: "eq", label: "= threshold" },
  { value: "ne", label: "≠ threshold" },
];

function MappingEditor({
  autoSource,
  existing,
}: {
  autoSource: string;
  existing: AutoMapping | null;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [label, setLabel] = useState(existing?.label ?? autoSource);
  const [enabled, setEnabled] = useState(existing?.enabled ?? false);
  const [sqlTemplate, setSqlTemplate] = useState(existing?.sqlTemplate ?? "");
  const [valueColumn, setValueColumn] = useState(existing?.valueColumn ?? "value");
  const [comparator, setComparator] = useState(existing?.comparator ?? "none");
  const [threshold, setThreshold] = useState(existing?.threshold ?? "");
  const [unitLabel, setUnitLabel] = useState(existing?.unitLabel ?? "");
  const [bqLocation, setBqLocation] = useState(existing?.bqLocation ?? "");
  const [open, setOpen] = useState(false);

  const save = useMutation({
    mutationFn: async () => {
      const res = await apiRequest(
        "PUT",
        `/api/ris/auto-mappings/${encodeURIComponent(autoSource)}`,
        {
          label,
          enabled,
          sqlTemplate: sqlTemplate || null,
          valueColumn,
          comparator,
          threshold: threshold || null,
          unitLabel: unitLabel || null,
          bqLocation: bqLocation || null,
        },
      );
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Saved", description: `Mapping for ${autoSource} saved.` });
      void queryClient.invalidateQueries({ queryKey: ["/api/ris/auto-mappings"] }); // fire-and-forget: cache refresh only
      setOpen(false);
    },
    onError: (e: any) => {
      toast({
        title: "Save failed",
        description: formatQueryError(e),
        variant: "destructive",
      });
    },
  });

  return (
    <div className="border rounded-md p-3" data-testid={`mapping-${autoSource}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium text-sm">{autoSource}</span>
          <Badge
            variant="outline"
            className={`text-[11px] ${existing?.enabled ? "text-status-ok" : "text-muted-foreground"}`}
          >
            {existing ? (existing.enabled ? "enabled" : "disabled") : "not configured"}
          </Badge>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setOpen((v) => !v)}
          data-testid={`button-edit-mapping-${autoSource}`}
        >
          {open ? "Close" : existing ? "Edit" : "Configure"}
        </Button>
      </div>
      {open && (
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <div>
            <label className="text-xs font-medium">Label</label>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} data-testid={`input-mapping-label-${autoSource}`} />
          </div>
          <div>
            <label className="text-xs font-medium">Value column</label>
            <Input value={valueColumn} onChange={(e) => setValueColumn(e.target.value)} data-testid={`input-mapping-valuecol-${autoSource}`} />
          </div>
          <div className="md:col-span-2">
            <label className="text-xs font-medium">
              SQL template (params: @clientId @locationId @periodStart @periodEnd)
            </label>
            <Textarea
              value={sqlTemplate}
              onChange={(e) => setSqlTemplate(e.target.value)}
              rows={4}
              className="font-mono text-xs"
              data-testid={`input-mapping-sql-${autoSource}`}
            />
          </div>
          <div>
            <label className="text-xs font-medium">Comparator</label>
            <Select value={comparator} onValueChange={setComparator}>
              <SelectTrigger data-testid={`select-mapping-comparator-${autoSource}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {COMPARATOR_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-xs font-medium">Threshold</label>
            <Input value={threshold} onChange={(e) => setThreshold(e.target.value)} data-testid={`input-mapping-threshold-${autoSource}`} />
          </div>
          <div>
            <label className="text-xs font-medium">Unit label</label>
            <Input value={unitLabel} onChange={(e) => setUnitLabel(e.target.value)} data-testid={`input-mapping-unit-${autoSource}`} />
          </div>
          <div>
            <label className="text-xs font-medium">BigQuery location (optional)</label>
            <Input value={bqLocation} onChange={(e) => setBqLocation(e.target.value)} data-testid={`input-mapping-location-${autoSource}`} />
          </div>
          <div className="md:col-span-2 flex items-center justify-between">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
                data-testid={`checkbox-mapping-enabled-${autoSource}`}
              />
              Enabled
            </label>
            <Button
              onClick={() => save.mutate()}
              disabled={save.isPending}
              data-testid={`button-save-mapping-${autoSource}`}
            >
              {save.isPending ? "Saving…" : "Save mapping"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function MappingsPanel() {
  const { data, isLoading } = useQuery<{ mappings: AutoMapping[]; unmapped: string[] }>({
    queryKey: ["/api/ris/auto-mappings"],
    queryFn: getQueryFn({ on401: "throw" }),
  });

  return (
    <Card data-testid="card-auto-mappings">
      <CardHeader>
        <CardTitle className="text-base">Auto-source mappings (BigQuery)</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-xs text-muted-foreground">
          Configure how each auto-sourced check pulls its value from BigQuery.
          Mappings are disabled by default; unconfigured or unreachable checks
          stay at Needs Review.
        </p>
        {isLoading && <p className="text-muted-foreground text-sm">Loading mappings…</p>}
        {data?.mappings.map((m) => (
          <MappingEditor key={m.autoSource} autoSource={m.autoSource} existing={m} />
        ))}
        {data?.unmapped.map((s) => (
          <MappingEditor key={s} autoSource={s} existing={null} />
        ))}
        {data && data.mappings.length === 0 && data.unmapped.length === 0 && (
          <p className="text-muted-foreground text-sm">
            No auto-sourced checks in the catalog yet.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Task #2485 — Per-client BigQuery binding (managers only) ─────────
interface ClientOverride {
  id: string;
  clientId: string;
  autoSource: string;
  sqlTemplate: string | null;
  valueColumn: string | null;
  comparator: string | null;
  threshold: string | null;
  bqLocation: string | null;
  filterValue: string | null;
}

interface ClientBinding {
  clientId: string;
  firmName: string;
  bigQueryClientKey: string | null;
  overrides: ClientOverride[];
}

interface ClientLite {
  id: string;
  firmName: string;
}

// One auto-source override row for a single client. Every field is optional:
// left blank it inherits the global mapping value (shown as a placeholder).
function ClientOverrideEditor({
  clientId,
  mapping,
  existing,
}: {
  clientId: string;
  mapping: AutoMapping;
  existing: ClientOverride | null;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const autoSource = mapping.autoSource;
  const [open, setOpen] = useState(false);
  const [sqlTemplate, setSqlTemplate] = useState(existing?.sqlTemplate ?? "");
  const [valueColumn, setValueColumn] = useState(existing?.valueColumn ?? "");
  const [comparator, setComparator] = useState(existing?.comparator ?? "");
  const [threshold, setThreshold] = useState(existing?.threshold ?? "");
  const [bqLocation, setBqLocation] = useState(existing?.bqLocation ?? "");
  const [filterValue, setFilterValue] = useState(existing?.filterValue ?? "");

  const bindingKey = ["/api/ris/client-bindings", clientId];

  const save = useMutation({
    mutationFn: async () => {
      const res = await apiRequest(
        "PUT",
        `/api/ris/client-bindings/${encodeURIComponent(clientId)}/overrides/${encodeURIComponent(autoSource)}`,
        {
          // Blank → null → inherit the global mapping value.
          sqlTemplate: sqlTemplate.trim() || null,
          valueColumn: valueColumn.trim() || null,
          comparator: comparator || null,
          threshold: threshold.trim() || null,
          bqLocation: bqLocation.trim() || null,
          filterValue: filterValue.trim() || null,
        },
      );
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Override saved", description: `Override for ${autoSource} saved.` });
      void queryClient.invalidateQueries({ queryKey: bindingKey }); // fire-and-forget: cache refresh only
      setOpen(false);
    },
    onError: (e: any) => {
      toast({
        title: "Save failed",
        description: formatQueryError(e),
        variant: "destructive",
      });
    },
  });

  const remove = useMutation({
    mutationFn: async () => {
      await apiRequest(
        "DELETE",
        `/api/ris/client-bindings/${encodeURIComponent(clientId)}/overrides/${encodeURIComponent(autoSource)}`,
      );
    },
    onSuccess: () => {
      toast({ title: "Override removed", description: `${autoSource} reverted to the global mapping.` });
      void queryClient.invalidateQueries({ queryKey: bindingKey }); // fire-and-forget: cache refresh only
      setOpen(false);
    },
    onError: (e: any) => {
      toast({
        title: "Remove failed",
        description: formatQueryError(e),
        variant: "destructive",
      });
    },
  });

  return (
    <div className="border rounded-md p-3" data-testid={`override-${autoSource}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium text-sm">{autoSource}</span>
          <Badge
            variant="outline"
            className={`text-[11px] ${existing ? "text-foreground" : "text-muted-foreground"}`}
          >
            {existing ? "overridden" : "inherits global"}
          </Badge>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setOpen((v) => !v)}
          data-testid={`button-edit-override-${autoSource}`}
        >
          {open ? "Close" : existing ? "Edit" : "Override"}
        </Button>
      </div>
      {open && (
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <div>
            <label className="text-xs font-medium">Value column</label>
            <Input
              value={valueColumn}
              placeholder={mapping.valueColumn || "value"}
              onChange={(e) => setValueColumn(e.target.value)}
              data-testid={`input-override-valuecol-${autoSource}`}
            />
          </div>
          <div>
            <label className="text-xs font-medium">BigQuery location</label>
            <Input
              value={bqLocation}
              placeholder={mapping.bqLocation || "(global / default)"}
              onChange={(e) => setBqLocation(e.target.value)}
              data-testid={`input-override-location-${autoSource}`}
            />
          </div>
          <div className="md:col-span-2">
            <label className="text-xs font-medium">
              SQL template (params: @clientId @locationId @periodStart @periodEnd @clientKey @filterValue)
            </label>
            <Textarea
              value={sqlTemplate}
              placeholder={mapping.sqlTemplate || "(inherits global template)"}
              onChange={(e) => setSqlTemplate(e.target.value)}
              rows={4}
              className="font-mono text-xs"
              data-testid={`input-override-sql-${autoSource}`}
            />
          </div>
          <div>
            <label className="text-xs font-medium">Comparator</label>
            <Select value={comparator || "__inherit__"} onValueChange={(v) => setComparator(v === "__inherit__" ? "" : v)}>
              <SelectTrigger data-testid={`select-override-comparator-${autoSource}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__inherit__">Inherit global ({mapping.comparator})</SelectItem>
                {COMPARATOR_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-xs font-medium">Threshold</label>
            <Input
              value={threshold}
              placeholder={mapping.threshold ?? "(global)"}
              onChange={(e) => setThreshold(e.target.value)}
              data-testid={`input-override-threshold-${autoSource}`}
            />
          </div>
          <div className="md:col-span-2">
            <label className="text-xs font-medium">
              Extra filter value (bound as @filterValue)
            </label>
            <Input
              value={filterValue}
              placeholder="(none)"
              onChange={(e) => setFilterValue(e.target.value)}
              data-testid={`input-override-filtervalue-${autoSource}`}
            />
          </div>
          <div className="md:col-span-2 flex items-center justify-between">
            {existing ? (
              <Button
                variant="outline"
                onClick={() => remove.mutate()}
                disabled={remove.isPending}
                data-testid={`button-remove-override-${autoSource}`}
              >
                {remove.isPending ? "Removing…" : "Remove override"}
              </Button>
            ) : (
              <span />
            )}
            <Button
              onClick={() => save.mutate()}
              disabled={save.isPending}
              data-testid={`button-save-override-${autoSource}`}
            >
              {save.isPending ? "Saving…" : "Save override"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function ClientBindingPanel() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [clientId, setClientId] = useState<string>("");

  const clientsQuery = useQuery<ClientLite[]>({
    queryKey: ["/api/clients"],
    queryFn: getQueryFn({ on401: "throw" }),
  });
  const mappingsQuery = useQuery<{ mappings: AutoMapping[]; unmapped: string[] }>({
    queryKey: ["/api/ris/auto-mappings"],
    queryFn: getQueryFn({ on401: "throw" }),
  });
  const bindingQuery = useQuery<ClientBinding>({
    queryKey: ["/api/ris/client-bindings", clientId],
    queryFn: getQueryFn({ on401: "throw" }),
    enabled: !!clientId,
  });

  const [keyInput, setKeyInput] = useState("");
  useEffect(() => {
    setKeyInput(bindingQuery.data?.bigQueryClientKey ?? "");
  }, [bindingQuery.data?.bigQueryClientKey, clientId]);

  const saveKey = useMutation({
    mutationFn: async () => {
      const res = await apiRequest(
        "PUT",
        `/api/ris/client-bindings/${encodeURIComponent(clientId)}/bigquery-key`,
        { bigQueryClientKey: keyInput.trim() || null },
      );
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Saved", description: "BigQuery client key saved." });
      void queryClient.invalidateQueries({ queryKey: ["/api/ris/client-bindings", clientId] }); // fire-and-forget: cache refresh only
    },
    onError: (e: any) => {
      toast({
        title: "Save failed",
        description: formatQueryError(e),
        variant: "destructive",
      });
    },
  });

  const mappings = mappingsQuery.data?.mappings ?? [];
  const overrideBySource = new Map(
    (bindingQuery.data?.overrides ?? []).map((o) => [o.autoSource, o]),
  );

  return (
    <Card data-testid="card-client-bindings">
      <CardHeader>
        <CardTitle className="text-base">Per-client BigQuery binding</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          Set a client's BigQuery client key (bound into queries as
          <span className="font-mono"> @clientKey</span>) and override individual
          auto-source pull rules for that client. Blank override fields inherit
          the global mapping. If a query needs a client key but none is set, that
          check degrades to Needs Review — never a silent Pass.
        </p>

        <div>
          <label className="text-xs font-medium">Client</label>
          <Select value={clientId} onValueChange={setClientId}>
            <SelectTrigger data-testid="select-binding-client">
              <SelectValue placeholder="Select a client…" />
            </SelectTrigger>
            <SelectContent>
              {(clientsQuery.data ?? []).map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.firmName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {clientId && bindingQuery.isLoading && (
          <p className="text-muted-foreground text-sm">Loading binding…</p>
        )}

        {clientId && bindingQuery.data && (
          <>
            <div className="grid gap-2 md:grid-cols-[1fr_auto] md:items-end">
              <div>
                <label className="text-xs font-medium">BigQuery client key</label>
                <Input
                  value={keyInput}
                  placeholder="(none set)"
                  onChange={(e) => setKeyInput(e.target.value)}
                  data-testid="input-binding-bigquery-key"
                />
              </div>
              <Button
                onClick={() => saveKey.mutate()}
                disabled={saveKey.isPending}
                data-testid="button-save-bigquery-key"
              >
                {saveKey.isPending ? "Saving…" : "Save key"}
              </Button>
            </div>

            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">
                Auto-source overrides
              </p>
              {mappings.length === 0 && (
                <p className="text-muted-foreground text-sm">
                  No global auto-source mappings configured yet.
                </p>
              )}
              {mappings.map((m) => (
                <ClientOverrideEditor
                  key={`${clientId}:${m.autoSource}`}
                  clientId={clientId}
                  mapping={m}
                  existing={overrideBySource.get(m.autoSource) ?? null}
                />
              ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Task #2371 — Performance Layer presentation helpers ─────────────
type RisLayer = "qa" | "performance" | "engagement";

function LayerSwitcher({
  layer,
  onLayerChange,
}: {
  layer: RisLayer;
  onLayerChange: (l: RisLayer) => void;
}) {
  return (
    <div
      className="inline-flex rounded-md border bg-muted/40 p-0.5"
      data-testid="switcher-ris-layer"
    >
      {LAYER_OPTIONS.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onLayerChange(opt.value as RisLayer)}
          className={
            "px-3 py-1.5 text-sm rounded transition-colors " +
            (layer === opt.value
              ? "bg-card shadow-sm font-medium text-primary-ink"
              : "text-muted-foreground hover:text-foreground")
          }
          data-testid={`tab-layer-${opt.value}`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

// ─── Task #2462 — Overview / Setup area navigation ───────────────────
type RisArea = "overview" | "setup";

// Task #2477 — persist the last-used RIS area per user so reopening /ris from
// the nav (a bare URL, no `?area=`) resumes where the admin left off. Stored in
// localStorage; reads/writes are guarded so SSR and storage-disabled browsers
// degrade silently to the default (overview). The key is scoped by user id so a
// shared browser / account switch can't leak one admin's area to another.
function risAreaStorageKey(userId: string | undefined): string {
  return `ris:lastArea:${userId ?? "anon"}`;
}

function readStoredRisArea(userId: string | undefined): RisArea | null {
  if (typeof window === "undefined") return null;
  try {
    const v = window.localStorage.getItem(risAreaStorageKey(userId));
    return v === "setup" || v === "overview" ? v : null;
  } catch {
    return null;
  }
}

function writeStoredRisArea(userId: string | undefined, area: RisArea): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(risAreaStorageKey(userId), area);
  } catch {
    // Ignore (private mode / quota / disabled storage) — persistence is best-effort.
  }
}

function RisAreaTabs({
  area,
  onAreaChange,
}: {
  area: RisArea;
  onAreaChange: (a: RisArea) => void;
}) {
  const tabs: { value: RisArea; label: string }[] = [
    { value: "overview", label: "Overview" },
    { value: "setup", label: "Setup" },
  ];
  return (
    <div
      className="inline-flex rounded-md border bg-muted/40 p-0.5"
      data-testid="switcher-ris-area"
    >
      {tabs.map((t) => (
        <button
          key={t.value}
          type="button"
          onClick={() => onAreaChange(t.value)}
          className={
            "px-3 py-1.5 text-sm rounded transition-colors " +
            (area === t.value
              ? "bg-card shadow-sm font-medium text-primary-ink"
              : "text-muted-foreground hover:text-foreground")
          }
          data-testid={`tab-area-${t.value}`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

// Setup area (Task #2462): gathers all RIS configuration in one place —
// the check-catalog management (per-layer) plus the auto-source BigQuery
// mappings editor — so the day-to-day Overview is never interrupted by
// configuration cards. Only rendered for users with manage permission.
function SetupView({
  layer,
  onLayerChange,
  area,
  onAreaChange,
}: {
  layer: RisLayer;
  onLayerChange: (l: RisLayer) => void;
  area: RisArea;
  onAreaChange: (a: RisArea) => void;
}) {
  return (
    <div className="space-y-6" data-testid="ris-setup-view">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <Settings2 className="h-6 w-6 text-primary" />
            <h1 className="text-2xl font-bold" data-testid="text-ris-setup-title">
              RIS Setup
            </h1>
          </div>
          <RisAreaTabs area={area} onAreaChange={onAreaChange} />
        </div>
        <LayerSwitcher layer={layer} onLayerChange={onLayerChange} />
      </div>

      <ManageView layer={layer} />
      <MappingsPanel />
      <ClientBindingPanel />
    </div>
  );
}

function PerfStatusBadge({
  status,
  className = "",
}: {
  status: PerfStatus;
  className?: string;
}) {
  return (
    <span
      className={
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium " +
        PERF_STATUS_BADGE[status] +
        " " +
        className
      }
      data-testid={`badge-perf-${status}`}
    >
      <span className={"h-2 w-2 rounded-full " + PERF_STATUS_DOT[status]} />
      {PERF_STATUS_LABEL[status]}
    </span>
  );
}

/** Compact green/yellow/red/gray counts row. */
function PerfCountChips({ counts }: { counts: PerfStatusCounts }) {
  const chips: { key: PerfStatus; n: number }[] = [
    { key: "red", n: counts.red },
    { key: "yellow", n: counts.yellow },
    { key: "green", n: counts.green },
    { key: "gray", n: counts.gray },
  ];
  return (
    <div className="flex items-center gap-1.5">
      {chips
        .filter((c) => c.n > 0)
        .map((c) => (
          <span
            key={c.key}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground"
            data-testid={`count-perf-${c.key}`}
          >
            <span className={"h-2 w-2 rounded-full " + PERF_STATUS_DOT[c.key]} />
            {c.n}
          </span>
        ))}
    </div>
  );
}

function fmtPct(changePct: string | null): { text: string; tone: string } | null {
  if (changePct == null || changePct === "") return null;
  const n = Number(changePct);
  if (!Number.isFinite(n)) return null;
  const sign = n > 0 ? "+" : "";
  const tone = n > 0 ? "text-status-ok" : n < 0 ? "text-status-critical" : "text-muted-foreground";
  return { text: `${sign}${n.toFixed(1)}%`, tone };
}

/** A single Product Health Card: worst-of status + main + supporting metrics. */
function ProductHealthCardView({ card }: { card: ProductHealthCard }) {
  // Main metric = first metric (the catalog orders the headline metric first);
  // the rest are supporting.
  const [main, ...supporting] = card.metrics;
  return (
    <Card
      accent={PERF_ACCENT[card.status]}
      data-testid={`card-product-health-${card.product}`}
    >
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base">
            {PRODUCT_LABEL[card.product] ?? card.product}
          </CardTitle>
          <PerfStatusBadge status={card.status} />
        </div>
        <PerfCountChips counts={card.counts} />
      </CardHeader>
      <CardContent className="space-y-3">
        {!main && (
          <p className="text-sm text-muted-foreground" data-testid={`text-no-metrics-${card.product}`}>
            No performance metrics configured.
          </p>
        )}
        {main && <MetricRow metric={main} primary />}
        {supporting.length > 0 && (
          <div className="space-y-2 border-t pt-3">
            {supporting.map((m) => (
              <MetricRow key={m.checkId} metric={m} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function MetricRow({
  metric,
  primary = false,
}: {
  metric: PerformanceMetric;
  primary?: boolean;
}) {
  const pct = fmtPct(metric.changePct);
  const status = (metric.status ?? "gray") as PerfStatus;
  return (
    <div
      className="flex items-start justify-between gap-3"
      data-testid={`metric-row-${metric.key}`}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className={"h-2 w-2 rounded-full shrink-0 " + PERF_STATUS_DOT[status]} />
          <span className={primary ? "font-medium" : "text-sm"}>{metric.label}</span>
          {metric.metricType && (
            <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
              {METRIC_TYPE_LABEL[metric.metricType] ?? metric.metricType}
            </span>
          )}
        </div>
        {metric.notes && (
          <p className="text-xs text-muted-foreground mt-0.5" data-testid={`metric-notes-${metric.key}`}>
            {metric.notes}
          </p>
        )}
        {metric.autoError && (
          <p className="text-xs text-status-warn mt-0.5" data-testid={`metric-error-${metric.key}`}>
            {metric.autoError}
          </p>
        )}
      </div>
      <div className="text-right shrink-0">
        <div className="text-sm font-medium" data-testid={`metric-current-${metric.key}`}>
          {metric.currentValue ?? "—"}
        </div>
        <div className="text-xs text-muted-foreground" data-testid={`metric-previous-${metric.key}`}>
          prev {metric.previousValue ?? "—"}
        </div>
        {pct && (
          <div className={"text-xs font-medium " + pct.tone} data-testid={`metric-change-${metric.key}`}>
            {pct.text}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Portfolio view ──────────────────────────────────────────────────
function PortfolioView({
  period,
  onPeriodChange,
  layer,
  onLayerChange,
  canManage,
  area,
  onAreaChange,
}: {
  period: string;
  onPeriodChange: (p: string) => void;
  canManage: boolean;
  area: RisArea;
  onAreaChange: (a: RisArea) => void;
  layer: RisLayer;
  onLayerChange: (l: RisLayer) => void;
}) {
  const { data, isLoading, error } = useQuery<PortfolioRollup>({
    queryKey: [`/api/ris/portfolio?period=${period}&layer=${layer}`],
    queryFn: getQueryFn({ on401: "throw" }),
    enabled: layer !== "performance",
  });

  const perf = useQuery<PortfolioPerformance>({
    queryKey: [`/api/ris/performance/portfolio?period=${period}`],
    queryFn: getQueryFn({ on401: "throw" }),
    enabled: layer === "performance",
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-6 w-6 text-primary" />
            <h1 className="text-2xl font-bold" data-testid="text-ris-title">
              Revenue Integrity System
            </h1>
          </div>
          {canManage && (
            <RisAreaTabs area={area} onAreaChange={onAreaChange} />
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <LayerSwitcher layer={layer} onLayerChange={onLayerChange} />
          <Select value={period} onValueChange={onPeriodChange}>
            <SelectTrigger className="w-[140px]" data-testid="select-period">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {recentPeriods().map((p) => (
                <SelectItem key={p} value={p} data-testid={`option-period-${p}`}>
                  {p}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {layer === "performance" ? (
        <PortfolioPerformanceBody
          isLoading={perf.isLoading}
          error={!!perf.error}
          data={perf.data}
        />
      ) : (
        <>
      {isLoading && (
        <p className="text-muted-foreground" data-testid="text-loading">
          Loading portfolio…
        </p>
      )}
      {error && (
        <p className="text-status-critical" data-testid="text-error">
          Failed to load RIS portfolio.
        </p>
      )}

      {data && (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Portfolio summary</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-3 md:grid-cols-7 gap-4">
                <RollupStat label="Completion" value={`${data.totals.completionPct}%`} testId="stat-completion" />
                <RollupStat label="Due (week)" value={data.totals.dueThisWeek} testId="stat-due-week" />
                <RollupStat label="Due (month)" value={data.totals.dueThisMonth} testId="stat-due-month" />
                <RollupStat label="Launch due" value={data.totals.launchDue} testId="stat-launch-due" />
                <RollupStat label="Open fails" value={data.totals.openFails} testId="stat-open-fails" tone={data.totals.openFails ? "text-status-critical" : ""} />
                <RollupStat label="Blocked" value={data.totals.openBlocked} testId="stat-blocked" tone={data.totals.openBlocked ? "text-status-warn" : ""} />
                <RollupStat label="Needs review" value={data.totals.needsReview + data.totals.untouched} testId="stat-needs-review" />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Clients</CardTitle>
            </CardHeader>
            <CardContent>
              {/* Task #4369 — OsTable refit (audit P2-5): the shared kit's
                  bounded viewport, sticky header, pinned client column and
                  overflow shadows replace the bare <table>. Data and default
                  ordering (worst-first by open issues) are unchanged. */}
              <OsTable
                data-testid="table-ris-clients"
                rows={data.clients
                  .slice()
                  .sort(
                    (a, b) =>
                      b.rollup.openFails + b.rollup.openBlocked -
                      (a.rollup.openFails + a.rollup.openBlocked),
                  )}
                rowKey={(c) => c.clientId}
                maxHeight="70vh"
                emptyState="No active clients."
                columns={[
                  {
                    key: "client",
                    header: "Client",
                    sortable: true,
                    sortValue: (c) => c.firmName.toLowerCase(),
                    cell: (c) => (
                      <Link
                        href={`/ris/${c.clientId}`}
                        className="font-medium text-primary-ink hover:underline"
                        data-testid={`link-client-${c.clientId}`}
                      >
                        {c.firmName}
                      </Link>
                    ),
                  },
                  {
                    key: "products",
                    header: "Products",
                    cell: (c) => (
                      <span className="text-muted-foreground">
                        {c.products.length ? c.products.join(", ") : "—"}
                      </span>
                    ),
                  },
                  {
                    key: "completion",
                    header: "Completion",
                    align: "center",
                    sortable: true,
                    sortValue: (c) => c.rollup.completionPct,
                    cell: (c) => (
                      <span data-testid={`text-completion-${c.clientId}`}>
                        {c.rollup.completionPct}%
                      </span>
                    ),
                  },
                  {
                    key: "openFails",
                    header: "Open fails",
                    align: "center",
                    sortable: true,
                    sortValue: (c) => c.rollup.openFails,
                    cell: (c) =>
                      c.rollup.openFails > 0 ? (
                        <span className="text-status-critical font-semibold">
                          {c.rollup.openFails}
                        </span>
                      ) : (
                        "0"
                      ),
                  },
                  {
                    key: "blocked",
                    header: "Blocked",
                    align: "center",
                    sortable: true,
                    sortValue: (c) => c.rollup.openBlocked,
                    cell: (c) =>
                      c.rollup.openBlocked > 0 ? (
                        <span className="text-status-warn font-semibold">
                          {c.rollup.openBlocked}
                        </span>
                      ) : (
                        "0"
                      ),
                  },
                  {
                    key: "severity",
                    header: "Severity",
                    align: "center",
                    cell: (c) => <SeverityBadge severity={c.rollup.topSeverity} />,
                  },
                ]}
              />
            </CardContent>
          </Card>
        </>
      )}
        </>
      )}
    </div>
  );
}

// ─── Portfolio Performance body ──────────────────────────────────────
function PortfolioPerformanceBody({
  isLoading,
  error,
  data,
}: {
  isLoading: boolean;
  error: boolean;
  data: PortfolioPerformance | undefined;
}) {
  if (isLoading)
    return (
      <p className="text-muted-foreground" data-testid="text-loading-perf">
        Loading performance…
      </p>
    );
  if (error)
    return (
      <p className="text-status-critical" data-testid="text-error-perf">
        Failed to load RIS performance portfolio.
      </p>
    );
  if (!data) return null;

  const sorted = data.clients
    .slice()
    .sort((a, b) => (PERF_RANK_UI[b.status] ?? 0) - (PERF_RANK_UI[a.status] ?? 0));

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Performance summary</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            <RollupStat label="At risk" value={data.totals.red} testId="stat-perf-red" tone={data.totals.red ? "text-status-critical" : ""} />
            <RollupStat label="Watch" value={data.totals.yellow} testId="stat-perf-yellow" tone={data.totals.yellow ? "text-status-warn" : ""} />
            <RollupStat label="Healthy" value={data.totals.green} testId="stat-perf-green" tone={data.totals.green ? "text-status-ok" : ""} />
            <RollupStat label="No data" value={data.totals.gray} testId="stat-perf-gray" />
            <RollupStat label="N/A" value={data.totals.na} testId="stat-perf-na" />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Clients</CardTitle>
        </CardHeader>
        <CardContent>
          {/* Task #4369 — OsTable refit (audit P2-5), same kit treatment as
              the QA-layer client table. Default ordering is unchanged:
              status rank, worst first. */}
          <OsTable
            data-testid="table-ris-perf-clients"
            rows={sorted}
            rowKey={(c) => c.clientId}
            maxHeight="70vh"
            emptyState="No active clients."
            columns={[
              {
                key: "client",
                header: "Client",
                sortable: true,
                sortValue: (c) => c.firmName.toLowerCase(),
                cell: (c) => (
                  <Link
                    href={`/ris/${c.clientId}`}
                    className="font-medium text-primary-ink hover:underline"
                    data-testid={`link-perf-client-${c.clientId}`}
                  >
                    {c.firmName}
                  </Link>
                ),
              },
              {
                key: "products",
                header: "Products",
                cell: (c) => (
                  <span className="text-muted-foreground">
                    {c.products.length ? c.products.join(", ") : "—"}
                  </span>
                ),
              },
              {
                key: "status",
                header: "Status",
                sortable: true,
                sortValue: (c) => PERF_RANK_UI[c.status] ?? 0,
                cell: (c) => <PerfStatusBadge status={c.status} />,
              },
              {
                key: "breakdown",
                header: "Breakdown",
                cell: (c) => <PerfCountChips counts={c.counts} />,
              },
              {
                key: "severity",
                header: "Severity",
                align: "center",
                cell: (c) => <SeverityBadge severity={c.topSeverity} />,
              },
            ]}
          />
        </CardContent>
      </Card>
    </>
  );
}

const PERF_RANK_UI: Record<PerfStatus, number> = {
  red: 4,
  yellow: 3,
  green: 2,
  gray: 1,
  na: 0,
};

// ─── Per-instance editor row ─────────────────────────────────────────
function InstanceRow({
  instance,
  clientId,
  period,
  layer,
}: {
  instance: ChecklistInstance;
  clientId: string;
  period: string;
  layer: string;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<string>(instance.status ?? "needs_review");
  const [notes, setNotes] = useState(instance.notes ?? "");
  const [observedValue, setObservedValue] = useState(instance.observedValue ?? "");
  const [failureReason, setFailureReason] = useState(instance.failureReason ?? "");
  const [correctiveAction, setCorrectiveAction] = useState(
    instance.correctiveAction ?? "",
  );
  const [evidenceUrl, setEvidenceUrl] = useState(instance.evidenceUrl ?? "");
  const [severityOverride, setSeverityOverride] = useState<string>("");

  const isAuto = instance.source === "auto";
  const isConfirmed = !!instance.confirmedAt;

  const confirm = useMutation({
    mutationFn: async () => {
      const res = await apiRequest(
        "POST",
        `/api/ris/results/${instance.resultId}/confirm`,
        {},
      );
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Confirmed", description: `${instance.label} confirmed.` });
      void queryClient.invalidateQueries({ // fire-and-forget: cache refresh only
        queryKey: [`/api/ris/clients/${clientId}?period=${period}`],
      });
    },
    onError: (e: any) => {
      toast({
        title: "Confirm failed",
        description: formatQueryError(e),
        variant: "destructive",
      });
    },
  });

  const save = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {
        checkId: instance.checkId,
        locationId: instance.locationId,
        period: instance.period,
        status,
        notes: notes || null,
        observedValue: observedValue || null,
        failureReason: failureReason || null,
        correctiveAction: correctiveAction || null,
        evidenceUrl: evidenceUrl || null,
      };
      if (severityOverride) body.severityOverride = severityOverride;
      const res = await apiRequest(
        "POST",
        `/api/ris/clients/${clientId}/results`,
        body,
      );
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Saved", description: `${instance.label} updated.` });
      void queryClient.invalidateQueries({ // fire-and-forget: cache refresh only
        queryKey: [`/api/ris/clients/${clientId}?period=${period}`],
      });
      setOpen(false);
    },
    onError: (e: any) => {
      toast({
        title: "Save failed",
        description: formatQueryError(e),
        variant: "destructive",
      });
    },
  });

  const rowTestId = `row-instance-${instance.key}${instance.locationId ? `-${instance.locationId}` : ""}`;

  return (
    <div className="border rounded-md p-3" data-testid={rowTestId}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium">{instance.label}</span>
            <SeverityBadge severity={instance.effectiveSeverity} />
            <Badge variant="outline" className="text-[11px]">
              {FREQUENCY_LABEL[instance.frequency] ?? instance.frequency}
            </Badge>
            {instance.locationName && (
              <Badge variant="secondary" className="text-[11px]">
                {instance.locationName}
              </Badge>
            )}
            {instance.autoSource && (
              <Badge variant="outline" className="text-[11px] text-status-info">
                auto: {instance.autoSource}
              </Badge>
            )}
          </div>
          {instance.description && (
            <p className="text-xs text-muted-foreground mt-1">
              {instance.description}
            </p>
          )}
          {instance.checkedAt && (
            <p
              className="text-[11px] text-muted-foreground mt-1"
              data-testid={`text-checked-${instance.key}${instance.locationId ? `-${instance.locationId}` : ""}`}
            >
              Last checked {fmtCheckedAt(instance.checkedAt)}
              {instance.checkedByName ? ` by ${instance.checkedByName}` : ""}
              {instance.source && instance.source !== "manual"
                ? ` · ${instance.source}`
                : ""}
            </p>
          )}
          {isAuto && (
            <p
              className="text-[11px] mt-1"
              data-testid={`text-auto-${instance.key}${instance.locationId ? `-${instance.locationId}` : ""}`}
            >
              <span className="text-status-info font-medium">Auto-pulled</span>
              {instance.observedValue ? ` · observed ${instance.observedValue}` : ""}
              {isConfirmed
                ? ` · confirmed${instance.confirmedByName ? ` by ${instance.confirmedByName}` : ""}`
                : ""}
              {instance.autoError ? (
                <span className="text-status-warn"> · {instance.autoError}</span>
              ) : (
                ""
              )}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`text-xs px-2 py-1 rounded border ${statusBadgeClass(
              layer,
              instance.status,
            )}`}
            data-testid={`status-${instance.key}`}
          >
            {statusLabel(layer, instance.status)}
          </span>
          {isAuto && !isConfirmed && instance.resultId && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => confirm.mutate()}
              disabled={confirm.isPending}
              data-testid={`button-confirm-${instance.key}${instance.locationId ? `-${instance.locationId}` : ""}`}
            >
              {confirm.isPending ? "Confirming…" : "Confirm"}
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={() => setOpen((v) => !v)}
            data-testid={`button-edit-${instance.key}${instance.locationId ? `-${instance.locationId}` : ""}`}
          >
            {open ? "Close" : isAuto ? "Override" : "Set"}
          </Button>
        </div>
      </div>

      {instance.cadence && (
        <div
          className="mt-3 rounded-md border bg-muted/30 p-3"
          data-testid={`panel-cadence-${instance.key}`}
        >
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Live outbound communication (this month) — informational only
          </p>
          <div className="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-3">
            <RollupStat
              label="Emails"
              value={instance.cadence.emailsSent}
              testId={`cadence-emails-${instance.key}`}
            />
            <RollupStat
              label="Calls"
              value={instance.cadence.callsMade}
              testId={`cadence-calls-${instance.key}`}
            />
            <RollupStat
              label="Texts"
              value={instance.cadence.textsSent}
              testId={`cadence-texts-${instance.key}`}
            />
            <RollupStat
              label="Total touches"
              value={instance.cadence.totalOutboundTouches}
              testId={`cadence-total-${instance.key}`}
            />
          </div>
          <p
            className="text-[11px] text-muted-foreground mt-2"
            data-testid={`cadence-last-${instance.key}`}
          >
            Last outbound:{" "}
            {fmtCheckedAt(instance.cadence.lastOutboundAt) ?? "never"} · Last
            inbound: {fmtCheckedAt(instance.cadence.lastInboundAt) ?? "never"}
          </p>
        </div>
      )}

      {open && (
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <div>
            <label className="text-xs font-medium">Status</label>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger data-testid={`select-status-${instance.key}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {statusOptionsForLayer(layer).map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-xs font-medium">Severity override</label>
            <Select
              value={severityOverride || "none"}
              onValueChange={(v) => setSeverityOverride(v === "none" ? "" : v)}
            >
              <SelectTrigger data-testid={`select-severity-${instance.key}`}>
                <SelectValue placeholder="Use default" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Use default</SelectItem>
                <SelectItem value="low">Low</SelectItem>
                <SelectItem value="medium">Medium</SelectItem>
                <SelectItem value="high">High</SelectItem>
                <SelectItem value="critical">Critical</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-xs font-medium">Observed value</label>
            <Input
              value={observedValue}
              onChange={(e) => setObservedValue(e.target.value)}
              data-testid={`input-observed-${instance.key}`}
            />
          </div>
          <div>
            <label className="text-xs font-medium">Evidence URL</label>
            <Input
              value={evidenceUrl}
              onChange={(e) => setEvidenceUrl(e.target.value)}
              data-testid={`input-evidence-${instance.key}`}
            />
          </div>
          {(status === "fail" || status === "blocked") && (
            <>
              <div>
                <label className="text-xs font-medium">Failure reason</label>
                <Textarea
                  value={failureReason}
                  onChange={(e) => setFailureReason(e.target.value)}
                  rows={2}
                  data-testid={`input-failure-${instance.key}`}
                />
              </div>
              <div>
                <label className="text-xs font-medium">Corrective action</label>
                <Textarea
                  value={correctiveAction}
                  onChange={(e) => setCorrectiveAction(e.target.value)}
                  rows={2}
                  data-testid={`input-corrective-${instance.key}`}
                />
              </div>
            </>
          )}
          <div className="md:col-span-2">
            <label className="text-xs font-medium">Notes</label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              data-testid={`input-notes-${instance.key}`}
            />
          </div>
          <div className="md:col-span-2 flex justify-end">
            <Button
              onClick={() => save.mutate()}
              disabled={save.isPending}
              data-testid={`button-save-${instance.key}${instance.locationId ? `-${instance.locationId}` : ""}`}
            >
              {save.isPending ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Per-client drilldown ────────────────────────────────────────────
function ClientView({
  clientId,
  period,
  layer,
  onLayerChange,
}: {
  clientId: string;
  period: string;
  layer: RisLayer;
  onLayerChange: (l: RisLayer) => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery<ClientChecklist>({
    queryKey: [`/api/ris/clients/${clientId}?period=${period}&layer=${layer}`],
    queryFn: getQueryFn({ on401: "throw" }),
    enabled: layer !== "performance",
  });

  const perf = useQuery<ClientPerformance>({
    queryKey: [`/api/ris/performance/clients/${clientId}?period=${period}`],
    queryFn: getQueryFn({ on401: "throw" }),
    enabled: layer === "performance",
  });
  const isEngagement = layer === "engagement";

  const refresh = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/ris/refresh", {
        clientId,
        period,
      });
      return res.json();
    },
    onSuccess: (s: any) => {
      toast({
        title: "Auto-pull complete",
        description: `${s?.written ?? 0} updated, ${s?.needsReview ?? 0} need review.`,
      });
      void queryClient.invalidateQueries({ // fire-and-forget: cache refresh only
        queryKey: [`/api/ris/clients/${clientId}?period=${period}`],
      });
    },
    onError: (e: any) => {
      toast({
        title: "Auto-pull failed",
        description: formatQueryError(e),
        variant: "destructive",
      });
    },
  });

  const [fProduct, setFProduct] = useState("all");
  const [fStatus, setFStatus] = useState("all");
  const [fSeverity, setFSeverity] = useState("all");
  const [fFrequency, setFFrequency] = useState("all");
  const [fOwner, setFOwner] = useState("all");

  const filtered = useMemo(() => {
    return (data?.instances ?? []).filter((inst) => {
      if (fProduct !== "all" && inst.product !== fProduct) return false;
      if (fFrequency !== "all" && inst.frequency !== fFrequency) return false;
      if (fSeverity !== "all" && inst.effectiveSeverity !== fSeverity) return false;
      if (fOwner !== "all" && (inst.defaultOwnerFunction ?? "") !== fOwner)
        return false;
      if (fStatus !== "all") {
        if (fStatus === "untouched" ? inst.status !== null : inst.status !== fStatus)
          return false;
      }
      return true;
    });
  }, [data, fProduct, fStatus, fSeverity, fFrequency, fOwner]);

  // QA nests product → category (one card per product). Engagement
  // (Task #2388) is client-level / product-agnostic, so it groups one card
  // per category instead. `groupKey` is the outer card key; `groupLabel`
  // resolves its display name from the right lookup.
  const grouped = useMemo(() => {
    const byOuter = new Map<string, Map<string, ChecklistInstance[]>>();
    for (const inst of filtered) {
      const outer = isEngagement ? inst.category : inst.product;
      const cats = byOuter.get(outer) ?? new Map();
      const arr = cats.get(inst.category) ?? [];
      arr.push(inst);
      cats.set(inst.category, arr);
      byOuter.set(outer, cats);
    }
    return Array.from(byOuter.entries()).map(
      ([outer, cats]) =>
        [outer, Array.from(cats.entries())] as [
          string,
          [string, ChecklistInstance[]][],
        ],
    );
  }, [filtered, isEngagement]);

  const productOptions = useMemo(
    () => Array.from(new Set((data?.instances ?? []).map((i) => i.product))),
    [data],
  );

  const ownerOptions = useMemo(
    () =>
      Array.from(
        new Set(
          (data?.instances ?? [])
            .map((i) => i.defaultOwnerFunction)
            .filter((o): o is string => !!o),
        ),
      ),
    [data],
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <Link href="/ris" data-testid="link-back-portfolio">
          <Button variant="ghost" size="sm">
            <ChevronLeft className="h-4 w-4 mr-1" /> Portfolio
          </Button>
        </Link>
        <div className="flex items-center gap-2">
          <LayerSwitcher layer={layer} onLayerChange={onLayerChange} />
          <Button
            variant="outline"
            size="sm"
            onClick={() => refresh.mutate()}
            disabled={refresh.isPending}
            data-testid="button-refresh-autopull"
          >
            {refresh.isPending ? "Refreshing…" : "Refresh auto checks"}
          </Button>
        </div>
      </div>

      {layer === "performance" ? (
        <ClientPerformanceBody
          isLoading={perf.isLoading}
          error={!!perf.error}
          data={perf.data}
        />
      ) : (
        <>
      {isLoading && <p className="text-muted-foreground">Loading checklist…</p>}
      {error && (
        <p className="text-status-critical" data-testid="text-error">
          Failed to load client checklist.
        </p>
      )}

      {data && (
        <>
          <div className="flex items-center justify-between flex-wrap gap-2">
            <h1 className="text-2xl font-bold" data-testid="text-client-name">
              {data.client.firmName}
            </h1>
            <div className="flex items-center gap-4 text-sm">
              <span data-testid="text-client-completion">
                Completion: <strong>{data.rollup.completionPct}%</strong>
              </span>
              {data.rollup.openFails > 0 && (
                <span className="text-status-critical flex items-center gap-1">
                  <AlertTriangle className="h-4 w-4" /> {data.rollup.openFails} fail
                </span>
              )}
              {data.rollup.openBlocked > 0 && (
                <span className="text-status-warn">{data.rollup.openBlocked} blocked</span>
              )}
            </div>
          </div>

          <div className="flex flex-wrap gap-2" data-testid="filters-client">
            <Select value={fProduct} onValueChange={setFProduct}>
              <SelectTrigger className="w-[150px]" data-testid="filter-product">
                <SelectValue placeholder="Product" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All products</SelectItem>
                {productOptions.map((p) => (
                  <SelectItem key={p} value={p}>
                    {PRODUCT_LABEL[p] ?? p}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={fStatus} onValueChange={setFStatus}>
              <SelectTrigger className="w-[150px]" data-testid="filter-status">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                {STATUS_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
                <SelectItem value="untouched">Not checked</SelectItem>
              </SelectContent>
            </Select>
            <Select value={fSeverity} onValueChange={setFSeverity}>
              <SelectTrigger className="w-[150px]" data-testid="filter-severity">
                <SelectValue placeholder="Severity" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All severities</SelectItem>
                <SelectItem value="low">Low</SelectItem>
                <SelectItem value="medium">Medium</SelectItem>
                <SelectItem value="high">High</SelectItem>
                <SelectItem value="critical">Critical</SelectItem>
              </SelectContent>
            </Select>
            <Select value={fFrequency} onValueChange={setFFrequency}>
              <SelectTrigger className="w-[150px]" data-testid="filter-frequency">
                <SelectValue placeholder="Frequency" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All frequencies</SelectItem>
                <SelectItem value="weekly">Weekly</SelectItem>
                <SelectItem value="monthly">Monthly</SelectItem>
                <SelectItem value="launch_only">Launch</SelectItem>
              </SelectContent>
            </Select>
            <Select value={fOwner} onValueChange={setFOwner}>
              <SelectTrigger className="w-[170px]" data-testid="filter-owner">
                <SelectValue placeholder="Owner" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All owners</SelectItem>
                {ownerOptions.map((o) => (
                  <SelectItem key={o} value={o}>
                    {isUserFunction(o) ? FUNCTION_LABELS[o] : o}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {grouped.length === 0 && (
            <p className="text-muted-foreground" data-testid="text-no-checks">
              No checks match the current filters.
            </p>
          )}

          {grouped.map(([outer, categories]) => (
            <Card
              key={outer}
              data-testid={
                isEngagement
                  ? `card-category-${outer}`
                  : `card-product-${outer}`
              }
            >
              <CardHeader>
                <CardTitle className="text-base">
                  {isEngagement
                    ? CATEGORY_LABEL[outer] ?? outer
                    : PRODUCT_LABEL[outer] ?? outer}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {categories.map(([category, instances]) => (
                  <div
                    key={category}
                    className="space-y-2"
                    data-testid={`group-category-${outer}-${category}`}
                  >
                    {/* Engagement already groups by category at the card
                        level, so the inner sub-heading would be redundant. */}
                    {!isEngagement && (
                      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        {CATEGORY_LABEL[category] ?? category}
                      </h3>
                    )}
                    {instances.map((inst) => (
                      <InstanceRow
                        key={`${inst.key}-${inst.locationId ?? "global"}`}
                        instance={inst}
                        clientId={clientId}
                        period={period}
                        layer={layer}
                      />
                    ))}
                  </div>
                ))}
              </CardContent>
            </Card>
          ))}
        </>
      )}
        </>
      )}
    </div>
  );
}

// ─── Client Performance body — Product Health Cards ──────────────────
function ClientPerformanceBody({
  isLoading,
  error,
  data,
}: {
  isLoading: boolean;
  error: boolean;
  data: ClientPerformance | undefined;
}) {
  if (isLoading)
    return (
      <p className="text-muted-foreground" data-testid="text-loading-perf">
        Loading performance…
      </p>
    );
  if (error)
    return (
      <p className="text-status-critical" data-testid="text-error-perf">
        Failed to load client performance.
      </p>
    );
  if (!data) return null;

  return (
    <>
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-2xl font-bold" data-testid="text-client-name-perf">
          {data.client.firmName}
        </h1>
        <span className="text-sm text-muted-foreground">
          {data.products.length} product{data.products.length === 1 ? "" : "s"} ·{" "}
          {data.period}
        </span>
      </div>

      {data.cards.length === 0 ? (
        <Card>
          <CardContent className="p-6 text-center text-muted-foreground" data-testid="text-no-cards">
            No performance products configured for this client.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2" data-testid="grid-product-health">
          {data.cards.map((card) => (
            <ProductHealthCardView key={card.product} card={card} />
          ))}
        </div>
      )}
    </>
  );
}

// ─── Catalog manager (managers only) ─────────────────────────────────
const QA_CATEGORY_OPTIONS = [
  "access",
  "tracking",
  "fulfillment",
  "automation",
  "reporting",
  "spend_delivery",
];
const ENGAGEMENT_CATEGORY_OPTIONS = ["client_engagement", "nobull_cadence"];
function categoryOptionsForLayer(layer: string): string[] {
  return layer === "engagement"
    ? ENGAGEMENT_CATEGORY_OPTIONS
    : QA_CATEGORY_OPTIONS;
}
const FREQUENCY_OPTIONS = ["weekly", "monthly", "launch_only"];
const PRODUCT_OPTIONS = ["universal", "gbp", "google_ads", "lsa", "webinar"];
const SEVERITY_OPTIONS = ["low", "medium", "high", "critical"];

interface CheckDraft {
  key: string;
  label: string;
  description: string;
  product: string;
  category: string;
  frequency: string;
  defaultSeverity: string;
  locationSpecific: boolean;
}

const EMPTY_DRAFT: CheckDraft = {
  key: "",
  label: "",
  description: "",
  product: "universal",
  category: "access",
  frequency: "monthly",
  defaultSeverity: "medium",
  locationSpecific: false,
};

function CheckForm({
  initial,
  isEdit,
  onSubmit,
  onCancel,
  pending,
  categoryOptions,
}: {
  initial: CheckDraft;
  isEdit: boolean;
  onSubmit: (d: CheckDraft) => void;
  onCancel: () => void;
  pending: boolean;
  categoryOptions: string[];
}) {
  const [draft, setDraft] = useState<CheckDraft>(initial);
  const set = (k: keyof CheckDraft, v: any) => setDraft((d) => ({ ...d, [k]: v }));

  return (
    <div className="grid gap-3 md:grid-cols-2 border rounded-md p-4 bg-muted/30">
      {!isEdit && (
        <div>
          <label className="text-xs font-medium">Key (unique)</label>
          <Input
            value={draft.key}
            onChange={(e) => set("key", e.target.value)}
            placeholder="gbp_posts_per_location"
            data-testid="input-check-key"
          />
        </div>
      )}
      <div>
        <label className="text-xs font-medium">Label</label>
        <Input
          value={draft.label}
          onChange={(e) => set("label", e.target.value)}
          data-testid="input-check-label"
        />
      </div>
      <div className="md:col-span-2">
        <label className="text-xs font-medium">Description</label>
        <Textarea
          value={draft.description}
          onChange={(e) => set("description", e.target.value)}
          rows={2}
          data-testid="input-check-description"
        />
      </div>
      <div>
        <label className="text-xs font-medium">Product</label>
        <Select value={draft.product} onValueChange={(v) => set("product", v)}>
          <SelectTrigger data-testid="select-check-product">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PRODUCT_OPTIONS.map((p) => (
              <SelectItem key={p} value={p}>
                {PRODUCT_LABEL[p] ?? p}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div>
        <label className="text-xs font-medium">Category</label>
        <Select value={draft.category} onValueChange={(v) => set("category", v)}>
          <SelectTrigger data-testid="select-check-category">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {categoryOptions.map((c) => (
              <SelectItem key={c} value={c}>
                {CATEGORY_LABEL[c] ?? c}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div>
        <label className="text-xs font-medium">Frequency</label>
        <Select value={draft.frequency} onValueChange={(v) => set("frequency", v)}>
          <SelectTrigger data-testid="select-check-frequency">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FREQUENCY_OPTIONS.map((f) => (
              <SelectItem key={f} value={f}>
                {FREQUENCY_LABEL[f] ?? f}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div>
        <label className="text-xs font-medium">Default severity</label>
        <Select
          value={draft.defaultSeverity}
          onValueChange={(v) => set("defaultSeverity", v)}
        >
          <SelectTrigger data-testid="select-check-severity">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SEVERITY_OPTIONS.map((s) => (
              <SelectItem key={s} value={s}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={draft.locationSpecific}
          onChange={(e) => set("locationSpecific", e.target.checked)}
          data-testid="input-check-location-specific"
        />
        Location-specific (one row per location)
      </label>
      <div className="md:col-span-2 flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel} data-testid="button-cancel-check">
          Cancel
        </Button>
        <Button
          onClick={() => onSubmit(draft)}
          disabled={pending || !draft.label || (!isEdit && !draft.key)}
          data-testid="button-submit-check"
        >
          {pending ? "Saving…" : isEdit ? "Save changes" : "Create check"}
        </Button>
      </div>
    </div>
  );
}

function ManageView({
  layer,
}: {
  layer: string;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const { data: checks } = useQuery<RisCheck[]>({
    queryKey: [`/api/ris/checks`],
    queryFn: getQueryFn({ on401: "throw" }),
  });
  const layerLabel =
    LAYER_OPTIONS.find((l) => l.value === layer)?.label ?? layer;
  const emptyDraft: CheckDraft = {
    ...EMPTY_DRAFT,
    category: categoryOptionsForLayer(layer)[0],
  };

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: [`/api/ris/checks`] });
  const onError = (e: any) =>
    toast({ title: "Failed", description: formatQueryError(e), variant: "destructive" });

  const toggleActive = useMutation({
    mutationFn: async (check: RisCheck) =>
      (await apiRequest("PATCH", `/api/ris/checks/${check.id}`, {
        active: !check.active,
      })).json(),
    onSuccess: invalidate,
    onError,
  });

  const createCheck = useMutation({
    mutationFn: async (d: CheckDraft) =>
      (await apiRequest("POST", `/api/ris/checks`, {
        ...d,
        description: d.description || null,
        layer,
      })).json(),
    onSuccess: () => {
      void invalidate(); // fire-and-forget: cache refresh only
      setCreating(false);
      toast({ title: "Check created" });
    },
    onError,
  });

  const editCheck = useMutation({
    mutationFn: async ({ id, d }: { id: string; d: CheckDraft }) =>
      (await apiRequest("PATCH", `/api/ris/checks/${id}`, {
        label: d.label,
        description: d.description || null,
        product: d.product,
        category: d.category,
        frequency: d.frequency,
        defaultSeverity: d.defaultSeverity,
        locationSpecific: d.locationSpecific,
      })).json(),
    onSuccess: () => {
      void invalidate(); // fire-and-forget: cache refresh only
      setEditingId(null);
      toast({ title: "Check updated" });
    },
    onError,
  });

  const reorder = useMutation({
    mutationFn: async (orderedIds: string[]) =>
      (await apiRequest("POST", `/api/ris/checks/reorder`, { orderedIds })).json(),
    onSuccess: invalidate,
    onError,
  });

  // The catalog endpoint returns every layer; the Manage screen scopes to
  // whichever layer the dashboard is showing (Task #2388).
  const sorted = useMemo(
    () =>
      (checks ?? [])
        .filter((c) => c.layer === layer)
        .slice()
        .sort((a, b) => a.sortOrder - b.sortOrder),
    [checks, layer],
  );

  const move = (idx: number, dir: -1 | 1) => {
    const next = sorted.slice();
    const j = idx + dir;
    if (j < 0 || j >= next.length) return;
    [next[idx], next[j]] = [next[j], next[idx]];
    reorder.mutate(next.map((c) => c.id));
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Manage {layerLabel} Checks</h1>
        <Button onClick={() => setCreating((v) => !v)} data-testid="button-add-check">
          {creating ? "Close" : "Add check"}
        </Button>
      </div>

      {creating && (
        <CheckForm
          initial={emptyDraft}
          isEdit={false}
          pending={createCheck.isPending}
          categoryOptions={categoryOptionsForLayer(layer)}
          onSubmit={(d) => createCheck.mutate(d)}
          onCancel={() => setCreating(false)}
        />
      )}

      <Card>
        <CardContent>
          {/* Task #4484 — OsTable refit (audit P2-5 follow-through): the
              Setup checks list joins the shared table kit (sticky header,
              bounded viewport, overflow shadows) via the new
              renderExpandedRow seam, which keeps the inline expand-to-edit
              CheckForm behavior intact. Columns stay unsortable because the
              manual ▲/▼ reorder owns the row order; the first column is the
              reorder control (not an identity), so the pinned column is off. */}
          <OsTable
            data-testid="table-ris-checks"
            rows={sorted}
            rowKey={(c) => c.key}
            maxHeight="70vh"
            stickyFirstColumn={false}
            emptyState="No checks in this layer yet."
            renderExpandedRow={(c) =>
              editingId === c.id ? (
                <CheckForm
                  initial={{
                    key: c.key,
                    label: c.label,
                    description: c.description ?? "",
                    product: c.product,
                    category: c.category,
                    frequency: c.frequency,
                    defaultSeverity: c.defaultSeverity,
                    locationSpecific: c.locationSpecific,
                  }}
                  isEdit
                  pending={editCheck.isPending}
                  categoryOptions={categoryOptionsForLayer(layer)}
                  onSubmit={(d) => editCheck.mutate({ id: c.id, d })}
                  onCancel={() => setEditingId(null)}
                />
              ) : null
            }
            columns={[
              {
                key: "order",
                header: "Order",
                cell: (c, idx) => (
                  <div className="flex flex-col">
                    <button
                      className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-30"
                      disabled={idx === 0 || reorder.isPending}
                      onClick={() => move(idx, -1)}
                      data-testid={`button-moveup-${c.key}`}
                    >
                      ▲
                    </button>
                    <button
                      className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-30"
                      disabled={idx === sorted.length - 1 || reorder.isPending}
                      onClick={() => move(idx, 1)}
                      data-testid={`button-movedown-${c.key}`}
                    >
                      ▼
                    </button>
                  </div>
                ),
              },
              { key: "label", header: "Label", cell: (c) => c.label },
              {
                key: "product",
                header: "Product",
                cell: (c) => PRODUCT_LABEL[c.product] ?? c.product,
              },
              { key: "category", header: "Category", cell: (c) => c.category },
              { key: "frequency", header: "Frequency", cell: (c) => c.frequency },
              {
                key: "severity",
                header: "Severity",
                cell: (c) => <SeverityBadge severity={c.defaultSeverity} />,
              },
              {
                key: "active",
                header: "Active",
                align: "center",
                cell: (c) => (
                  <Button
                    size="sm"
                    variant={c.active ? "default" : "outline"}
                    onClick={() => toggleActive.mutate(c)}
                    data-testid={`button-toggle-${c.key}`}
                  >
                    {c.active ? "On" : "Off"}
                  </Button>
                ),
              },
              {
                key: "edit",
                header: "Edit",
                align: "center",
                cell: (c) => (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setEditingId((id) => (id === c.id ? null : c.id))
                    }
                    data-testid={`button-edit-check-${c.key}`}
                  >
                    {editingId === c.id ? "Close" : "Edit"}
                  </Button>
                ),
              },
            ]}
          />
        </CardContent>
      </Card>
    </div>
  );
}

export default function RisDashboard() {
  const params = useParams();
  const { user } = useAuth();
  const clientId = params.clientId;

  // Deep-links from RIS escalation notifications carry clientId + period in
  // the query string (e.g. /ris?clientId=...&period=2026-05). Parse BOTH so
  // the notification lands on the right client AND the right month instead
  // of silently defaulting to the current period.
  const qs = new URLSearchParams(
    typeof window !== "undefined" ? window.location.search : "",
  );
  const qsClientId = qs.get("clientId");
  const qsPeriodRaw = qs.get("period");
  const qsPeriod =
    qsPeriodRaw && /^\d{4}-\d{2}$/.test(qsPeriodRaw) ? qsPeriodRaw : null;

  // Layer selector. Deep-links may carry ?layer=performance or
  // ?layer=engagement; default to QA so existing links and the legacy
  // landing view are unchanged.
  const qsLayerRaw = qs.get("layer");
  const qsLayer: RisLayer =
    qsLayerRaw && LAYER_OPTIONS.some((l) => l.value === qsLayerRaw)
      ? (qsLayerRaw as RisLayer)
      : "qa";

  // Area selector (Task #2462): Overview (default) vs Setup. Reflected in the
  // URL via ?area=setup so it is linkable/refresh-safe; the per-client deep
  // dive (`/ris/:clientId`) ignores it entirely.
  //
  // Task #2477 — remember the last-used area per user (localStorage). When the
  // URL carries an explicit `?area=` it always wins (linkable deep links are
  // unchanged); only a bare `/ris` (e.g. from the nav quicklink) falls back to
  // the remembered value so admins resume where they left off.
  const qsAreaRaw = qs.get("area");

  const [, navigate] = useLocation();
  const [period, setPeriod] = useState(qsPeriod ?? currentPeriod());
  const [layer, setLayer] = useState<RisLayer>(qsLayer);
  const [area, setAreaState] = useState<RisArea>(() => {
    if (qsAreaRaw === "setup") return "setup";
    if (qsAreaRaw === "overview") return "overview";
    return readStoredRisArea(user?.id) ?? "overview";
  });

  // Task #2477 — `user` from useAuth resolves asynchronously, so on a fresh
  // mount the initializer above usually runs before the real user id is known
  // and reads the wrong (anon) key. Once the identity loads, rehydrate the
  // remembered area for that user — but only when the URL doesn't pin an
  // explicit ?area=, and only once per user id so an in-session choice is never
  // clobbered.
  const hydratedAreaForUserRef = useRef<string | null>(null);
  useEffect(() => {
    const uid = user?.id;
    if (!uid || hydratedAreaForUserRef.current === uid) return;
    hydratedAreaForUserRef.current = uid;
    if (qsAreaRaw === "setup" || qsAreaRaw === "overview") return;
    const stored = readStoredRisArea(uid);
    if (stored) setAreaState(stored);
  }, [user?.id, qsAreaRaw]);

  // Mirror server canManageRIS: authority `lead` and above (lead / director
  // / ceo) — the legacy `role` bridge covers team_lead / ceo too.
  const authority = user?.authorityLevel;
  const canManage =
    user?.role === "ceo" ||
    user?.role === "team_lead" ||
    authority === "lead" ||
    authority === "director" ||
    authority === "ceo";

  // Setup is manage-only; non-admins always fall back to Overview even if the
  // URL carries ?area=setup.
  const effectiveArea: RisArea = area === "setup" && canManage ? "setup" : "overview";

  const setArea = (next: RisArea) => {
    setAreaState(next);
    writeStoredRisArea(user?.id, next);
    const sp = new URLSearchParams(
      typeof window !== "undefined" ? window.location.search : "",
    );
    if (next === "setup") sp.set("area", "setup");
    else sp.delete("area");
    const search = sp.toString();
    navigate(`/ris${search ? `?${search}` : ""}`);
  };

  const effectiveClientId = clientId ?? qsClientId ?? undefined;

  return (
    <div className="container mx-auto px-4 py-6 max-w-6xl" data-testid="page-ris">
      {effectiveClientId ? (
        <ClientView
          clientId={effectiveClientId}
          period={period}
          layer={layer}
          onLayerChange={setLayer}
        />
      ) : effectiveArea === "setup" ? (
        <SetupView
          layer={layer}
          onLayerChange={setLayer}
          area={effectiveArea}
          onAreaChange={setArea}
        />
      ) : (
        <PortfolioView
          period={period}
          onPeriodChange={setPeriod}
          layer={layer}
          onLayerChange={setLayer}
          canManage={canManage}
          area={effectiveArea}
          onAreaChange={setArea}
        />
      )}
    </div>
  );
}
