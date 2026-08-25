import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Target, RefreshCw, Check, ChevronsUpDown, Loader2, TrendingUp } from "lucide-react";
import { PercentText } from "./PercentText";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { ClientLite } from "./types";
import { SuggestRulesDialog } from "./SuggestRulesDialog";

type UnmatchedCause =
  | "wouldMatchNow"
  | "sharedEmail"
  | "sharedDomain"
  | "probableOperational"
  | "companyOnly"
  | "noExternalSignal"
  | "noClientData";

type UnmatchedDiagnosis = {
  total: number;
  byCause: Record<UnmatchedCause, number>;
  topUnmatchedDomains: Array<{ domain: string; messages: number; sampleSenders: string[] }>;
  topOperationalSenders: Array<{ senderEmail: string; messages: number }>;
  matchRate: { matched: number; unmatched: number; matchable: number; rate: number };
};

const CAUSE_COPY: Record<UnmatchedCause, { label: string; hint: string; tone: string }> = {
  wouldMatchNow: {
    label: "Would match now",
    hint: "Client data was added since last run — just re-run the matcher.",
    tone: "bg-emerald-50 text-emerald-700 border-emerald-200",
  },
  noClientData: {
    label: "No client owns sender",
    hint: "A real external sender no client has yet — attach the domain/email below.",
    tone: "bg-amber-50 text-amber-700 border-amber-200",
  },
  probableOperational: {
    label: "Looks operational",
    hint: "Automated/no-reply sender — best closed with an operational rule.",
    tone: "bg-muted/50 text-foreground border-border",
  },
  sharedEmail: {
    label: "Shared email",
    hint: "Exact email used by more than one client — not auto-claimed (precision).",
    tone: "bg-purple-50 text-purple-700 border-purple-200",
  },
  sharedDomain: {
    label: "Shared domain",
    hint: "Trusted domain points at more than one client — not auto-claimed (precision).",
    tone: "bg-purple-50 text-purple-700 border-purple-200",
  },
  companyOnly: {
    label: "Company-only",
    hint: "Only internal participants — nothing external to match on.",
    tone: "bg-muted/50 text-muted-foreground border-border",
  },
  noExternalSignal: {
    label: "No external signal",
    hint: "No external email participant at all.",
    tone: "bg-muted/50 text-muted-foreground border-border",
  },
};

const CAUSE_ORDER: UnmatchedCause[] = [
  "wouldMatchNow",
  "noClientData",
  "probableOperational",
  "sharedEmail",
  "sharedDomain",
  "companyOnly",
  "noExternalSignal",
];

function ClientCombobox({
  clients,
  value,
  onChange,
  testIdSuffix,
}: {
  clients: ClientLite[];
  value: string | null;
  onChange: (id: string) => void;
  testIdSuffix: string;
}) {
  const [open, setOpen] = useState(false);
  const options = useMemo(
    () =>
      clients
        .map((c) => ({ value: c.id, label: c.firmName || c.name || c.id }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [clients],
  );
  const selected = options.find((o) => o.value === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          role="combobox"
          aria-expanded={open}
          className="h-8 justify-between min-w-[180px] max-w-[220px] text-xs font-normal"
          data-testid={`button-select-client-${testIdSuffix}`}
        >
          <span className="truncate">{selected ? selected.label : "Select client…"}</span>
          <ChevronsUpDown className="ml-1 h-3.5 w-3.5 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[260px] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search clients…" className="h-9" data-testid={`input-search-client-${testIdSuffix}`} />
          <CommandList>
            <CommandEmpty>No client found.</CommandEmpty>
            <CommandGroup>
              {options.map((o) => (
                <CommandItem
                  key={o.value}
                  value={o.label}
                  onSelect={() => {
                    onChange(o.value);
                    setOpen(false);
                  }}
                  data-testid={`option-client-${o.value}`}
                >
                  <Check className={`mr-2 h-4 w-4 ${value === o.value ? "opacity-100" : "opacity-0"}`} />
                  <span className="truncate">{o.label}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export function FrontUnmatchedDiagnosisCard() {
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data, isLoading, isFetching, refetch, error } = useQuery<UnmatchedDiagnosis>({
    queryKey: ["/api/integrations/front/unmatched-diagnosis"],
    queryFn: async () => {
      const res = await fetch("/api/integrations/front/unmatched-diagnosis", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load unmatched diagnosis");
      return res.json();
    },
    refetchOnWindowFocus: false,
  });

  const { data: clients = [] } = useQuery<ClientLite[]>({
    queryKey: ["/api/clients"],
    queryFn: async () => {
      const res = await fetch("/api/clients", { credentials: "include" });
      if (!res.ok) return [];
      const body = await res.json();
      return Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : [];
    },
    staleTime: 5 * 60 * 1000,
  });

  // domain -> selected clientId
  const [selectedClientByDomain, setSelectedClientByDomain] = useState<Record<string, string>>({});
  const [attachingDomain, setAttachingDomain] = useState<string | null>(null);
  const [ruleSender, setRuleSender] = useState<string | null>(null);

  // Batch mode: a set of checked domains + a single client to attach them all to.
  const [checkedDomains, setCheckedDomains] = useState<Set<string>>(new Set());
  const [batchClientId, setBatchClientId] = useState<string | null>(null);
  const [batchAttaching, setBatchAttaching] = useState(false);

  const topDomains = useMemo(
    () => data?.topUnmatchedDomains ?? [],
    [data?.topUnmatchedDomains],
  );
  const checkedList = useMemo(
    () => topDomains.filter((d) => checkedDomains.has(d.domain)).map((d) => d.domain),
    [topDomains, checkedDomains],
  );
  const allChecked = topDomains.length > 0 && checkedList.length === topDomains.length;

  const toggleDomain = (domain: string) => {
    setCheckedDomains((prev) => {
      const next = new Set(prev);
      if (next.has(domain)) next.delete(domain);
      else next.add(domain);
      return next;
    });
  };

  const toggleAll = () => {
    setCheckedDomains((prev) => {
      if (topDomains.length > 0 && prev.size >= topDomains.length) return new Set();
      return new Set(topDomains.map((d) => d.domain));
    });
  };

  const attachBatch = async () => {
    if (!batchClientId) {
      toast({ title: "Pick a client first", description: "Choose which client owns the selected domains.", variant: "destructive" });
      return;
    }
    if (checkedList.length === 0) {
      toast({ title: "Select domains first", description: "Tick the domains you want to attach.", variant: "destructive" });
      return;
    }
    setBatchAttaching(true);
    try {
      const res = await apiRequest("POST", "/api/integrations/front/attach-senders-to-client", {
        clientId: batchClientId,
        domains: checkedList,
      });
      const body = await res.json();
      const firm = body.firmName ?? "client";
      const parts: string[] = [];
      if (body.attached > 0) parts.push(`${body.attached} attached`);
      if (body.skipped > 0) parts.push(`${body.skipped} skipped`);
      toast({
        title: body.matched > 0 ? `Matched ${body.matched.toLocaleString()}` : "Domains attached",
        description:
          body.matched > 0
            ? `${parts.join(", ")} to ${firm} — ${body.matched} of ${body.reEvaluated} re-evaluated now match.`
            : `${parts.join(", ") || "Done"} to ${firm}. No unmatched rows flipped (they may need an exact contact).`,
      });
      setCheckedDomains(new Set());
      setBatchClientId(null);
      await Promise.all([
        refetch(),
        qc.invalidateQueries({ queryKey: ["/api/integrations/front/console/overview"] }),
        qc.invalidateQueries({ queryKey: ["/api/integrations/front/match-stats"] }),
      ]);
    } catch (e: any) {
      toast({ title: "Could not attach domains", description: e?.message ?? "Unknown error", variant: "destructive" });
    } finally {
      setBatchAttaching(false);
    }
  };

  const attachDomain = async (domain: string) => {
    const clientId = selectedClientByDomain[domain];
    if (!clientId) {
      toast({ title: "Pick a client first", description: `Choose which client owns ${domain}.`, variant: "destructive" });
      return;
    }
    setAttachingDomain(domain);
    try {
      const res = await apiRequest("POST", "/api/integrations/front/attach-sender-to-client", { clientId, domain });
      const body = await res.json();
      toast({
        title: body.matched > 0 ? `Matched ${body.matched.toLocaleString()}` : "Domain attached",
        description:
          body.matched > 0
            ? `Attached ${domain} to ${body.firmName ?? "client"} — ${body.matched} of ${body.reEvaluated} re-evaluated now match.`
            : `Attached ${domain} to ${body.firmName ?? "client"}. No unmatched rows flipped (they may need an exact contact).`,
      });
      await Promise.all([
        refetch(),
        qc.invalidateQueries({ queryKey: ["/api/integrations/front/console/overview"] }),
        qc.invalidateQueries({ queryKey: ["/api/integrations/front/match-stats"] }),
      ]);
    } catch (e: any) {
      toast({ title: "Could not attach domain", description: e?.message ?? "Unknown error", variant: "destructive" });
    } finally {
      setAttachingDomain(null);
    }
  };

  const byCause = data?.byCause;
  const rate = data?.matchRate;

  return (
    <Card data-testid="card-front-unmatched-diagnosis">
      <CardHeader>
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <CardTitle className="flex items-center gap-2 text-lg sm:text-xl">
            <Target className="w-5 h-5 text-amber-600" />
            Raise match rate
          </CardTitle>
          <Button
            size="sm"
            variant="outline"
            onClick={() => refetch()}
            disabled={isFetching}
            data-testid="button-refresh-unmatched-diagnosis"
          >
            <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${isFetching ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          Hard-match-only is preserved — this closes client-data gaps the deterministic matcher depends on. No fuzzy or name guessing.
        </p>
      </CardHeader>
      <CardContent className="space-y-5">
        {error ? (
          <div className="text-sm bg-red-50 border border-red-200 rounded p-3 text-red-700" data-testid="error-unmatched-diagnosis">
            Failed to load diagnosis: {(error as Error).message}
          </div>
        ) : null}

        {rate ? (
          <div className="flex flex-wrap items-center gap-4 text-sm bg-blue-50 rounded p-3" data-testid="row-diagnosis-match-rate">
            <span className="inline-flex items-center gap-1.5 font-semibold text-blue-700">
              <TrendingUp className="w-4 h-4" />
              Match rate <PercentText value={rate.rate} digits={0} />
            </span>
            <span className="text-muted-foreground" data-testid="text-diagnosis-matched">
              {rate.matched.toLocaleString()} matched of {rate.matchable.toLocaleString()} matchable
            </span>
            <span className="text-muted-foreground" data-testid="text-diagnosis-unmatched">
              {rate.unmatched.toLocaleString()} unmatched
            </span>
          </div>
        ) : null}

        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="text-diagnosis-loading">
            <Loader2 className="w-4 h-4 animate-spin" /> Analyzing the unmatched backlog…
          </div>
        ) : null}

        {byCause ? (
          <div data-testid="section-diagnosis-causes">
            <h3 className="text-sm font-medium text-foreground mb-2">Why {data?.total.toLocaleString()} are unmatched</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {CAUSE_ORDER.filter((c) => (byCause[c] ?? 0) > 0).map((c) => (
                <div key={c} className={`rounded border p-2.5 ${CAUSE_COPY[c].tone}`} data-testid={`cause-${c}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold">{CAUSE_COPY[c].label}</span>
                    <span className="text-sm font-bold" data-testid={`cause-count-${c}`}>{byCause[c].toLocaleString()}</span>
                  </div>
                  <p className="text-xs opacity-80 mt-0.5">{CAUSE_COPY[c].hint}</p>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {data && data.topUnmatchedDomains.length > 0 ? (
          <div data-testid="section-top-unmatched-domains">
            <div className="flex items-center justify-between gap-2 flex-wrap mb-2">
              <h3 className="text-sm font-medium text-foreground">
                Top sender domains with no client (attach to match)
              </h3>
              <button
                type="button"
                onClick={toggleAll}
                className="text-xs text-blue-600 hover:underline"
                data-testid="button-toggle-all-domains"
              >
                {allChecked ? "Clear all" : "Select all"}
              </button>
            </div>

            {/* Batch bar — attach all checked domains to one client at once. */}
            <div
              className="flex items-center gap-2 flex-wrap rounded border border-amber-200 bg-amber-50 p-2.5 mb-2"
              data-testid="bar-batch-attach"
            >
              <span className="text-xs font-medium text-amber-800" data-testid="text-batch-selected-count">
                {checkedList.length} selected
              </span>
              <span className="text-xs text-amber-700">→ attach all to</span>
              <ClientCombobox
                clients={clients}
                value={batchClientId}
                onChange={setBatchClientId}
                testIdSuffix="batch"
              />
              <Button
                size="sm"
                onClick={attachBatch}
                disabled={batchAttaching || checkedList.length === 0 || !batchClientId}
                data-testid="button-attach-batch"
              >
                {batchAttaching ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  `Attach ${checkedList.length || ""} selected & match`.replace("  ", " ")
                )}
              </Button>
            </div>

            <div className="space-y-1.5">
              {data.topUnmatchedDomains.map((d) => (
                <div
                  key={d.domain}
                  className="flex items-center justify-between gap-3 flex-wrap border rounded p-2.5 bg-card"
                  data-testid={`row-unmatched-domain-${d.domain}`}
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <Checkbox
                      checked={checkedDomains.has(d.domain)}
                      onCheckedChange={() => toggleDomain(d.domain)}
                      data-testid={`checkbox-domain-${d.domain}`}
                    />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm truncate" data-testid={`text-domain-${d.domain}`}>{d.domain}</span>
                        <Badge variant="outline" className="text-xs">
                          {d.messages.toLocaleString()} msg{d.messages === 1 ? "" : "s"}
                        </Badge>
                      </div>
                      {d.sampleSenders.length > 0 ? (
                        <p className="text-xs text-muted-foreground truncate mt-0.5">{d.sampleSenders.slice(0, 3).join(", ")}</p>
                      ) : null}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <ClientCombobox
                      clients={clients}
                      value={selectedClientByDomain[d.domain] ?? null}
                      onChange={(id) => setSelectedClientByDomain((prev) => ({ ...prev, [d.domain]: id }))}
                      testIdSuffix={d.domain}
                    />
                    <Button
                      size="sm"
                      onClick={() => attachDomain(d.domain)}
                      disabled={attachingDomain === d.domain || !selectedClientByDomain[d.domain]}
                      data-testid={`button-attach-domain-${d.domain}`}
                    >
                      {attachingDomain === d.domain ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        "Attach & match"
                      )}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {data && data.topOperationalSenders.length > 0 ? (
          <div data-testid="section-top-operational-senders">
            <h3 className="text-sm font-medium text-foreground mb-2">
              High-volume automated senders (create a rule to dismiss)
            </h3>
            <div className="space-y-1.5">
              {data.topOperationalSenders.map((s) => (
                <div
                  key={s.senderEmail}
                  className="flex items-center justify-between gap-3 flex-wrap border rounded p-2.5 bg-card"
                  data-testid={`row-operational-sender-${s.senderEmail}`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-mono text-sm truncate">{s.senderEmail}</span>
                    <Badge variant="outline" className="text-xs">
                      {s.messages.toLocaleString()} msg{s.messages === 1 ? "" : "s"}
                    </Badge>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setRuleSender(s.senderEmail)}
                    data-testid={`button-create-rule-${s.senderEmail}`}
                  >
                    Create rule
                  </Button>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </CardContent>

      <SuggestRulesDialog
        open={!!ruleSender}
        onClose={() => setRuleSender(null)}
        senderEmail={ruleSender}
        onSaved={() => {
          void refetch(); // fire-and-forget: refetch only
          void qc.invalidateQueries({ queryKey: ["/api/integrations/front/console/overview"] }); // fire-and-forget: cache refresh only
        }}
      />
    </Card>
  );
}
