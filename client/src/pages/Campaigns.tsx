/**
 * Task #4337 — Campaigns & first-touch attribution.
 *
 * Campaign records group marketing work under a normalized utm_campaign
 * key; attribution joins BY KEY (no FK), so a campaign created after its
 * traffic still claims history and deleting a campaign never destroys the
 * stamps on leads/deals. The source report answers "where did this
 * quarter's won deals come from" over immutable first-touch stamps —
 * "direct" is a captured touch with no signal, "unknown" is a pre-feature
 * row (NULL stamp). AM+ only, mirroring the server gate.
 */
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import type { MarketingCampaign } from "@shared/schema";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { formatDealAmount } from "@/components/DealRequiredFieldsDialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Megaphone, Plus, BarChart3, ArrowUpRight } from "lucide-react";
import { EmptyState } from "@/components/kit/EmptyState";

export interface CampaignStats {
  leads: number;
  deals: number;
  wonDeals: number;
  wonAmount: number;
}

type CampaignWithStats = MarketingCampaign & { stats: CampaignStats };

interface SourceReportRow {
  source: string;
  leads: number;
  deals: number;
  wonDeals: number;
  wonAmount: number;
}

interface CampaignReportRow {
  utmCampaign: string;
  campaignId: string | null;
  campaignName: string | null;
  leads: number;
  deals: number;
  wonDeals: number;
  wonAmount: number;
}

interface AttributionReportResponse {
  sources: SourceReportRow[];
  campaigns: CampaignReportRow[];
}

/** Human label for a first-touch bucket ("direct" and "unknown" get copy). */
export function sourceLabel(source: string): string {
  if (source === "direct") return "Direct (no campaign signal)";
  if (source === "unknown") return "Unknown (pre-tracking)";
  return source;
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** UTC quarter bounds; offset 0 = current quarter, -1 = previous. */
function quarterRange(offsetQuarters: number): { from: string; to: string } {
  const now = new Date();
  const startMonth = Math.floor(now.getUTCMonth() / 3) * 3 + offsetQuarters * 3;
  const start = new Date(Date.UTC(now.getUTCFullYear(), startMonth, 1));
  // Day 0 of month+3 = last day of the quarter.
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 3, 0));
  return { from: isoDay(start), to: isoDay(end) };
}

type RangePreset = "all" | "this_quarter" | "last_quarter" | "ytd" | "custom";

const PRESET_LABELS: Record<RangePreset, string> = {
  all: "All time",
  this_quarter: "This quarter",
  last_quarter: "Last quarter",
  ytd: "This year",
  custom: "Custom range",
};

interface CampaignFormState {
  name: string;
  utmCampaign: string;
  startDate: string;
  endDate: string;
  notes: string;
}

const EMPTY_FORM: CampaignFormState = {
  name: "",
  utmCampaign: "",
  startDate: "",
  endDate: "",
  notes: "",
};

/** Shared create/edit form body (Task #4337). */
export function CampaignFormFields({
  form,
  setForm,
  errors,
}: {
  form: CampaignFormState;
  setForm: (next: CampaignFormState) => void;
  /** Optional inline validation flags (create dialog wires these on submit). */
  errors?: { name?: boolean; utmCampaign?: boolean };
}) {
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="campaign-name">Name</Label>
        <Input
          id="campaign-name"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          placeholder="Spring podcast push"
          maxLength={200}
          aria-invalid={errors?.name || undefined}
          aria-describedby={errors?.name ? "campaign-name-error" : undefined}
          data-testid="input-campaign-name"
        />
        {errors?.name && (
          <p
            id="campaign-name-error"
            role="alert"
            className="text-xs text-status-critical"
            data-testid="error-campaign-name"
          >
            Enter a campaign name.
          </p>
        )}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="campaign-key">UTM campaign key</Label>
        <Input
          id="campaign-key"
          value={form.utmCampaign}
          onChange={(e) => setForm({ ...form, utmCampaign: e.target.value })}
          placeholder="spring-podcast-2026"
          maxLength={120}
          aria-invalid={errors?.utmCampaign || undefined}
          aria-describedby={errors?.utmCampaign ? "campaign-key-error" : undefined}
          data-testid="input-campaign-key"
        />
        {errors?.utmCampaign && (
          <p
            id="campaign-key-error"
            role="alert"
            className="text-xs text-status-critical"
            data-testid="error-campaign-key"
          >
            Enter a UTM campaign key.
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          Lowercased on save. Leads and deals whose first touch carried this
          utm_campaign value are attributed to this campaign — including ones
          captured before the campaign record existed.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="campaign-start">Start</Label>
          <Input
            id="campaign-start"
            type="date"
            value={form.startDate}
            onChange={(e) => setForm({ ...form, startDate: e.target.value })}
            data-testid="input-campaign-start"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="campaign-end">End</Label>
          <Input
            id="campaign-end"
            type="date"
            value={form.endDate}
            onChange={(e) => setForm({ ...form, endDate: e.target.value })}
            data-testid="input-campaign-end"
          />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="campaign-notes">Notes</Label>
        <Textarea
          id="campaign-notes"
          value={form.notes}
          onChange={(e) => setForm({ ...form, notes: e.target.value })}
          placeholder="Channels, budget owner, creative links…"
          rows={3}
          maxLength={5000}
          data-testid="input-campaign-notes"
        />
      </div>
    </div>
  );
}

/** Request body from the form ("" dates/notes → null). */
export function campaignBodyFromForm(form: CampaignFormState) {
  return {
    name: form.name.trim(),
    utmCampaign: form.utmCampaign.trim(),
    startDate: form.startDate || null,
    endDate: form.endDate || null,
    notes: form.notes.trim() || null,
  };
}

export default function Campaigns() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState<CampaignFormState>(EMPTY_FORM);
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [preset, setPreset] = useState<RangePreset>("this_quarter");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");

  const listQuery = useQuery<{ data: CampaignWithStats[] }>({
    queryKey: ["/api/campaigns"],
  });

  const reportUrl = useMemo(() => {
    let from = "";
    let to = "";
    if (preset === "this_quarter") ({ from, to } = quarterRange(0));
    else if (preset === "last_quarter") ({ from, to } = quarterRange(-1));
    else if (preset === "ytd") {
      from = `${new Date().getUTCFullYear()}-01-01`;
      to = isoDay(new Date());
    } else if (preset === "custom") {
      from = customFrom;
      to = customTo;
    }
    const params = new URLSearchParams();
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    const qs = params.toString();
    return qs ? `/api/attribution/report?${qs}` : "/api/attribution/report";
  }, [preset, customFrom, customTo]);

  const reportQuery = useQuery<AttributionReportResponse>({
    queryKey: [reportUrl],
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/campaigns", campaignBodyFromForm(form));
      return res.json() as Promise<MarketingCampaign>;
    },
    onSuccess: () => {
      toast({ title: "Campaign created" });
      setCreateOpen(false);
      setForm(EMPTY_FORM);
      setSubmitAttempted(false);
      void queryClient.invalidateQueries({ queryKey: ["/api/campaigns"] });
    },
    onError: (err: any) => {
      toast({
        title: "Could not create campaign",
        description: err?.message ?? "Unknown error",
        variant: "destructive",
      });
    },
  });

  const campaigns = listQuery.data?.data ?? [];
  const nameMissing = form.name.trim().length === 0;
  const utmMissing = form.utmCampaign.trim().length === 0;
  const canSave = !nameMissing && !utmMissing;

  const submitCreate = () => {
    if (!canSave) {
      setSubmitAttempted(true);
      return;
    }
    createMutation.mutate();
  };

  return (
    <div className="p-4 md:p-6 max-w-6xl mx-auto space-y-4" data-testid="page-campaigns">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1
            className="text-2xl font-semibold flex items-center gap-2"
            data-testid="text-campaigns-title"
          >
            <Megaphone className="h-6 w-6 text-muted-foreground" />
            Campaigns
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Group marketing pushes under a UTM key and see the leads, deals, and
            won revenue each one produced — first touch only.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)} data-testid="button-new-campaign">
          <Plus className="h-4 w-4 mr-1" />
          New campaign
        </Button>
      </div>

      <Tabs defaultValue="campaigns">
        <TabsList>
          <TabsTrigger value="campaigns" data-testid="tab-campaigns">
            <Megaphone className="h-4 w-4 mr-1.5" />
            Campaigns
          </TabsTrigger>
          <TabsTrigger value="report" data-testid="tab-report">
            <BarChart3 className="h-4 w-4 mr-1.5" />
            Source report
          </TabsTrigger>
        </TabsList>

        <TabsContent value="campaigns" className="mt-4">
          {listQuery.isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : campaigns.length === 0 ? (
            <EmptyState
              icon={<Megaphone />}
              title="No campaigns yet"
              description="Create one and tag your links with its utm_campaign key — leads that already carried the key are attributed retroactively."
              action={
                <Button onClick={() => setCreateOpen(true)} data-testid="button-empty-new-campaign">
                  <Plus className="h-4 w-4 mr-1" />
                  New campaign
                </Button>
              }
              testId="text-campaigns-empty"
            />
          ) : (
            <div className="border overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Campaign</TableHead>
                    <TableHead>UTM key</TableHead>
                    <TableHead>Period</TableHead>
                    <TableHead className="text-right">Leads</TableHead>
                    <TableHead className="text-right">Deals</TableHead>
                    <TableHead className="text-right">Won</TableHead>
                    <TableHead className="text-right">Won revenue</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {campaigns.map((c) => (
                    <TableRow key={c.id} data-testid={`row-campaign-${c.id}`}>
                      <TableCell>
                        <Link
                          href={`/campaigns/${c.id}`}
                          className="font-medium hover:underline inline-flex items-center gap-1"
                          data-testid={`link-campaign-${c.id}`}
                        >
                          {c.name}
                          <ArrowUpRight className="h-3.5 w-3.5 text-muted-foreground" />
                        </Link>
                        {c.isArchived && (
                          <Badge variant="outline" className="ml-2 text-muted-foreground">
                            Archived
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {c.utmCampaign}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {c.startDate || c.endDate
                          ? `${c.startDate ?? "…"} → ${c.endDate ?? "…"}`
                          : "—"}
                      </TableCell>
                      <TableCell className="text-right">{c.stats.leads}</TableCell>
                      <TableCell className="text-right">{c.stats.deals}</TableCell>
                      <TableCell className="text-right">{c.stats.wonDeals}</TableCell>
                      <TableCell className="text-right font-medium">
                        {formatDealAmount(c.stats.wonAmount)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </TabsContent>

        <TabsContent value="report" className="mt-4 space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Select value={preset} onValueChange={(v) => setPreset(v as RangePreset)}>
              <SelectTrigger className="w-[170px]" data-testid="select-report-range">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(PRESET_LABELS) as RangePreset[]).map((p) => (
                  <SelectItem key={p} value={p}>
                    {PRESET_LABELS[p]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {preset === "custom" && (
              <>
                <Input
                  type="date"
                  value={customFrom}
                  onChange={(e) => setCustomFrom(e.target.value)}
                  className="w-[150px]"
                  data-testid="input-report-from"
                />
                <span className="text-muted-foreground text-sm">to</span>
                <Input
                  type="date"
                  value={customTo}
                  onChange={(e) => setCustomTo(e.target.value)}
                  className="w-[150px]"
                  data-testid="input-report-to"
                />
              </>
            )}
            <p className="text-xs text-muted-foreground">
              Leads/deals count by creation date; won revenue by the date the
              deal entered its won stage.
            </p>
          </div>

          {reportQuery.isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : !reportQuery.data ? (
            <p role="alert" className="text-sm text-muted-foreground" data-testid="text-report-error">
              Couldn't load the attribution report. Refresh to try again.
            </p>
          ) : (
            <>
              <section className="space-y-2">
                <h2 className="text-sm font-semibold">By source</h2>
                {reportQuery.data.sources.length === 0 ? (
                  <EmptyState
                    icon={<BarChart3 />}
                    title="Nothing in this range yet"
                    description="No leads or deals were attributed to a source in the selected period. Widen the date range to see more."
                    testId="text-report-sources-empty"
                  />
                ) : (
                  <div className="border overflow-x-auto">
                    <Table data-testid="table-source-report">
                      <TableHeader>
                        <TableRow>
                          <TableHead>Source</TableHead>
                          <TableHead className="text-right">Leads</TableHead>
                          <TableHead className="text-right">Deals</TableHead>
                          <TableHead className="text-right">Won</TableHead>
                          <TableHead className="text-right">Won revenue</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {reportQuery.data.sources.map((row) => (
                          <TableRow key={row.source} data-testid={`row-source-${row.source}`}>
                            <TableCell className="font-medium">
                              {sourceLabel(row.source)}
                            </TableCell>
                            <TableCell className="text-right">{row.leads}</TableCell>
                            <TableCell className="text-right">{row.deals}</TableCell>
                            <TableCell className="text-right">{row.wonDeals}</TableCell>
                            <TableCell className="text-right font-medium">
                              {formatDealAmount(row.wonAmount)}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </section>

              <section className="space-y-2">
                <h2 className="text-sm font-semibold">By campaign</h2>
                {reportQuery.data.campaigns.length === 0 ? (
                  <EmptyState
                    icon={<Megaphone />}
                    title="No campaign-tagged touches in this range"
                    description="Tag your links with a campaign's utm_campaign key so their leads and deals show up here. Widen the date range to see more."
                    testId="text-report-campaigns-empty"
                  />
                ) : (
                  <div className="border overflow-x-auto">
                    <Table data-testid="table-campaign-report">
                      <TableHeader>
                        <TableRow>
                          <TableHead>Campaign</TableHead>
                          <TableHead className="text-right">Leads</TableHead>
                          <TableHead className="text-right">Deals</TableHead>
                          <TableHead className="text-right">Won</TableHead>
                          <TableHead className="text-right">Won revenue</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {reportQuery.data.campaigns.map((row) => (
                          <TableRow
                            key={row.utmCampaign}
                            data-testid={`row-campaign-report-${row.utmCampaign}`}
                          >
                            <TableCell>
                              {row.campaignId ? (
                                <Link
                                  href={`/campaigns/${row.campaignId}`}
                                  className="font-medium hover:underline"
                                >
                                  {row.campaignName ?? row.utmCampaign}
                                </Link>
                              ) : (
                                <span className="font-mono text-xs">
                                  {row.utmCampaign}
                                  <Badge variant="outline" className="ml-2 text-muted-foreground">
                                    No campaign record
                                  </Badge>
                                </span>
                              )}
                            </TableCell>
                            <TableCell className="text-right">{row.leads}</TableCell>
                            <TableCell className="text-right">{row.deals}</TableCell>
                            <TableCell className="text-right">{row.wonDeals}</TableCell>
                            <TableCell className="text-right font-medium">
                              {formatDealAmount(row.wonAmount)}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </section>
            </>
          )}
        </TabsContent>
      </Tabs>

      <Dialog
        open={createOpen}
        onOpenChange={(next) => {
          setCreateOpen(next);
          if (!next) setSubmitAttempted(false);
        }}
      >
        <DialogContent className="max-w-lg" data-testid="dialog-campaign-form">
          <DialogHeader>
            <DialogTitle>New campaign</DialogTitle>
            <DialogDescription>
              The UTM key ties tagged links, leads, and deals back to this campaign.
            </DialogDescription>
          </DialogHeader>
          <CampaignFormFields
            form={form}
            setForm={setForm}
            errors={
              submitAttempted
                ? { name: nameMissing, utmCampaign: utmMissing }
                : undefined
            }
          />
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={createMutation.isPending}
              onClick={submitCreate}
              data-testid="button-save-campaign"
            >
              Create campaign
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
