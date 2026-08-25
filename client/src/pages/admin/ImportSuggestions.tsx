import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, X, Loader2, Inbox, RefreshCw } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { usePageTitle } from "@/hooks/use-page-title";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/admin/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/form-field";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
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
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { format } from "date-fns";
import { PhoneHubIconActions } from "@/components/ClientCommsQuickActions";
import { CLIENT_PRODUCT_OPTIONS } from "@shared/productResolution";

type SuggestionCandidate = {
  name?: string;
  emails?: string[];
  phones?: string[];
  address?: string;
  city?: string;
  state?: string;
  product?: string;
};

type SuggestionSourceRef = {
  conversationId?: string;
  messageId?: string;
  subject?: string;
  snippet?: string;
};

type Suggestion = {
  id: string;
  clientId: string;
  entityKind: string;
  surface: string;
  candidate: SuggestionCandidate | null;
  sourceRef: SuggestionSourceRef | null;
  reason: string | null;
  status: string;
  reviewedByUserId: string | null;
  reviewedAt: string | null;
  promotedEntityId: string | null;
  createdAt: string | null;
  clientFirmName: string | null;
  reviewedByName: string | null;
};

type Client = { id: string; firmName: string };

type PromotionResult = {
  added: number;
  skipped: number;
  contactId: string | null;
  createdNewContact: boolean;
  reason?: string;
};

type ApproveResponse = {
  suggestion: Suggestion | undefined;
  promotion?: PromotionResult;
  location?: { id: string; name: string };
  product?: string;
  alreadyPresent?: boolean;
};

const STATUS_OPTIONS = ["pending", "promoted", "dismissed"] as const;
const APPROVABLE_KINDS = new Set(["client_contact", "client_location", "product"]);

// Task #4348 — the queue renders bounded pages instead of the first 200
// rows. Card anatomy is unchanged; the server supplies `total` for the
// pager.
const PAGE_SIZE = 50;

export default function ImportSuggestions() {
  usePageTitle("Import Suggestions");
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [status, setStatusRaw] = useState<string>("pending");
  const [clientId, setClientIdRaw] = useState<string>("__all__");
  const [surface, setSurfaceRaw] = useState<string>("__all__");
  const [page, setPage] = useState(1);
  // Filter changes restart at page 1 so the pager never points past the
  // new (possibly smaller) result set.
  const setStatus = (v: string) => { setStatusRaw(v); setPage(1); };
  const setClientId = (v: string) => { setClientIdRaw(v); setPage(1); };
  const setSurface = (v: string) => { setSurfaceRaw(v); setPage(1); };
  const [approveTarget, setApproveTarget] = useState<Suggestion | null>(null);
  const [approveEmails, setApproveEmails] = useState<Record<string, boolean>>({});
  const [approveName, setApproveName] = useState<string>("");
  const [approveLocationName, setApproveLocationName] = useState<string>("");
  const [approveLocationAddress, setApproveLocationAddress] = useState<string>("");
  const [approveProduct, setApproveProduct] = useState<string>("");
  // Task #4420 — field validation is inline (FormField), never a toast.
  const [approveErrors, setApproveErrors] = useState<{
    emails?: string;
    locationName?: string;
    locationAddress?: string;
    product?: string;
  }>({});

  const { data: clients } = useQuery<Client[]>({
    queryKey: ["/api/clients"],
  });

  const queryKey = useMemo(
    () => [
      "/api/import-suggestions",
      { status, clientId, surface, page },
    ],
    [status, clientId, surface, page],
  );

  const { data, isLoading, refetch, isFetching } = useQuery<{ items: Suggestion[]; total?: number }>({
    queryKey,
    queryFn: async () => {
      const params = new URLSearchParams();
      if (status) params.set("status", status);
      if (clientId && clientId !== "__all__") params.set("clientId", clientId);
      if (surface && surface !== "__all__") params.set("surface", surface);
      params.set("limit", String(PAGE_SIZE));
      params.set("offset", String((page - 1) * PAGE_SIZE));
      const res = await fetch(`/api/import-suggestions?${params.toString()}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
      return res.json();
    },
  });

  const items = useMemo(() => data?.items ?? [], [data?.items]);
  const total = data?.total ?? items.length;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // If the current page falls past the end (e.g. the last item on the
  // last page was dismissed), clamp back instead of showing a bare page.
  useEffect(() => {
    if (data && page > pageCount) setPage(pageCount);
  }, [data, page, pageCount]);

  const surfaces = useMemo(() => {
    const s = new Set<string>();
    items.forEach(i => s.add(i.surface));
    return Array.from(s).sort();
  }, [items]);

  const dismissMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("POST", `/api/import-suggestions/${id}/dismiss`);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Suggestion dismissed" });
      void queryClient.invalidateQueries({ queryKey: ["/api/import-suggestions"] }); // fire-and-forget: cache refresh only
    },
  });

  const approveMutation = useMutation<
    ApproveResponse,
    Error,
    {
      id: string;
      kind: string;
      emails?: string[];
      contactName?: string;
      locationName?: string;
      locationAddress?: string;
      product?: string;
    }
  >({
    meta: { silent: true },
    mutationFn: async (payload) => {
      const body: Record<string, unknown> = {};
      if (payload.emails) body.emails = payload.emails;
      if (payload.contactName !== undefined) body.contactName = payload.contactName;
      if (payload.locationName !== undefined) body.locationName = payload.locationName;
      if (payload.locationAddress !== undefined) body.locationAddress = payload.locationAddress;
      if (payload.product !== undefined) body.product = payload.product;
      const res = await apiRequest(
        "POST",
        `/api/import-suggestions/${payload.id}/approve`,
        body,
      );
      return res.json() as Promise<ApproveResponse>;
    },
    onSuccess: (resp, vars) => {
      if (vars.kind === "client_contact" && resp.promotion) {
        const promo = resp.promotion;
        toast({
          title: "Promoted to client contact",
          description: `Added ${promo.added} email(s)${promo.createdNewContact ? " on a new primary contact" : ""}.`,
        });
      } else if (vars.kind === "client_location" && resp.location) {
        toast({
          title: "Location created",
          description: resp.location.name,
        });
      } else if (vars.kind === "product") {
        toast({
          title: resp.alreadyPresent ? "Product already present" : "Product added",
          description: resp.product,
        });
      } else {
        toast({ title: "Suggestion promoted" });
      }
      setApproveTarget(null);
      void queryClient.invalidateQueries({ queryKey: ["/api/import-suggestions"] }); // fire-and-forget: cache refresh only
    },
    onError: (err) => {
      toast({ title: "Approval failed", description: err.message, variant: "destructive" });
    },
  });

  function openApprove(s: Suggestion) {
    setApproveTarget(s);
    setApproveErrors({});
    if (s.entityKind === "client_contact") {
      const emails = (s.candidate?.emails ?? []).filter((e): e is string => typeof e === "string");
      const checks: Record<string, boolean> = {};
      emails.forEach(e => { checks[e] = true; });
      setApproveEmails(checks);
      setApproveName(s.candidate?.name ?? "");
    } else if (s.entityKind === "client_location") {
      setApproveLocationName(s.candidate?.name ?? "");
      const addrParts = [
        s.candidate?.address,
        s.candidate?.city,
        s.candidate?.state,
      ].filter(Boolean);
      setApproveLocationAddress(addrParts.join(", "));
    } else if (s.entityKind === "product") {
      setApproveProduct(s.candidate?.product ?? s.candidate?.name ?? "");
    }
  }

  function submitApprove() {
    if (!approveTarget) return;
    const id = approveTarget.id;
    const kind = approveTarget.entityKind;

    if (kind === "client_contact") {
      const emails = Object.entries(approveEmails).filter(([, v]) => v).map(([k]) => k);
      if (emails.length === 0) {
        setApproveErrors({ emails: "Select at least one email." });
        return;
      }
      setApproveErrors({});
      approveMutation.mutate({ id, kind, emails, contactName: approveName });
      return;
    }

    if (kind === "client_location") {
      const next: typeof approveErrors = {};
      if (!approveLocationName.trim()) {
        next.locationName = "Location name is required.";
      }
      if (approveLocationAddress.trim().length < 10) {
        next.locationAddress = "Enter a valid full address.";
      }
      setApproveErrors(next);
      if (next.locationName || next.locationAddress) return;
      approveMutation.mutate({
        id,
        kind,
        locationName: approveLocationName.trim(),
        locationAddress: approveLocationAddress.trim(),
      });
      return;
    }

    if (kind === "product") {
      if (!approveProduct) {
        setApproveErrors({ product: "Pick a product." });
        return;
      }
      setApproveErrors({});
      approveMutation.mutate({ id, kind, product: approveProduct });
      return;
    }
  }

  const dialogTitle = approveTarget?.entityKind === "client_location"
    ? "Promote to client location"
    : approveTarget?.entityKind === "product"
      ? "Promote to client product"
      : "Promote to client contact";

  const dialogDescription = approveTarget?.entityKind === "client_location"
    ? "The address is geocoded before the location is created. Adjust the name or address if needed."
    : approveTarget?.entityKind === "product"
      ? "The selected product is added to the client's product list."
      : "Pick the emails to add. If this client has no contacts yet, a new primary contact will be created.";

  return (
    <div className="container mx-auto max-w-6xl p-4 md:p-6 space-y-4">
      <PageHeader
        title="Import Suggestions"
        icon={Inbox}
        backHref="/admin/integrations"
        backLabel="Integrations Hub"
        backTestId="button-back-integrations"
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => refetch()}
            disabled={isFetching}
            data-testid="button-refresh"
          >
            {isFetching ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-1" />}
            Refresh
          </Button>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Filters</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div>
            <Label className="text-xs">Status</Label>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger data-testid="select-status"><SelectValue /></SelectTrigger>
              <SelectContent>
                {STATUS_OPTIONS.map(s => (
                  <SelectItem key={s} value={s} data-testid={`option-status-${s}`}>{s}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">Client</Label>
            <Select value={clientId} onValueChange={setClientId}>
              <SelectTrigger data-testid="select-client"><SelectValue placeholder="All clients" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All clients</SelectItem>
                {(clients ?? []).map(c => (
                  <SelectItem key={c.id} value={c.id} data-testid={`option-client-${c.id}`}>
                    {c.firmName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">Surface</Label>
            <Select value={surface} onValueChange={setSurface}>
              <SelectTrigger data-testid="select-surface"><SelectValue placeholder="All surfaces" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All surfaces</SelectItem>
                {surfaces.map(s => (
                  <SelectItem key={s} value={s} data-testid={`option-surface-${s}`}>{s}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading suggestions…
        </div>
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-muted-foreground" data-testid="text-empty">
            No suggestions match these filters.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {items.map(s => {
            const candidate = s.candidate ?? {};
            const emails = candidate.emails ?? [];
            const phones = candidate.phones ?? [];
            const src = s.sourceRef ?? {};
            return (
              <Card key={s.id} data-testid={`card-suggestion-${s.id}`}>
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <CardTitle className="text-base flex flex-wrap items-center gap-2 min-w-0">
                      <span data-testid={`text-candidate-name-${s.id}`}>
                        {candidate.name || candidate.product || (
                          <span className="italic font-normal text-muted-foreground">
                            Name not provided
                          </span>
                        )}
                      </span>
                      <Badge variant="secondary" data-testid={`badge-kind-${s.id}`}>{s.entityKind}</Badge>
                      <Badge variant="outline" className="max-w-full whitespace-normal break-all" data-testid={`badge-surface-${s.id}`}>{s.surface}</Badge>
                      <Badge data-testid={`badge-status-${s.id}`}>{s.status}</Badge>
                    </CardTitle>
                    <div className="text-xs text-muted-foreground" data-testid={`text-client-${s.id}`}>
                      {s.clientFirmName ?? s.clientId}
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                  {emails.length > 0 && (
                    <div>
                      <span className="font-medium">Emails: </span>
                      <span className="break-all" data-testid={`text-emails-${s.id}`}>{emails.join(", ")}</span>
                    </div>
                  )}
                  {phones.length > 0 && (
                    <div>
                      <span className="font-medium">Phones: </span>
                      <span className="break-all" data-testid={`text-phones-${s.id}`}>
                        {phones.map((phone, i) => (
                          <span key={i} className="inline-flex items-center">
                            {i > 0 && <span className="mr-1">,</span>}
                            {phone}
                            <PhoneHubIconActions
                              phone={phone}
                              contactName={candidate.name ?? ""}
                              clientId={s.clientId ?? ""}
                              messageTestId={`button-phone-message-${s.id}-${i}`}
                              callTestId={`button-phone-call-${s.id}-${i}`}
                            />
                          </span>
                        ))}
                      </span>
                    </div>
                  )}
                  {candidate.address && (
                    <div>
                      <span className="font-medium">Address: </span>
                      <span data-testid={`text-address-${s.id}`}>
                        {[candidate.address, candidate.city, candidate.state].filter(Boolean).join(", ")}
                      </span>
                    </div>
                  )}
                  {candidate.product && (
                    <div>
                      <span className="font-medium">Product: </span>
                      <span data-testid={`text-product-${s.id}`}>{candidate.product}</span>
                    </div>
                  )}
                  {src.subject && (
                    <div>
                      <span className="font-medium">Subject: </span>
                      <span data-testid={`text-subject-${s.id}`}>{src.subject}</span>
                    </div>
                  )}
                  {src.snippet && (
                    <div className="text-muted-foreground italic line-clamp-3" data-testid={`text-snippet-${s.id}`}>
                      “{src.snippet}”
                    </div>
                  )}
                  {s.reason && (
                    <div className="text-xs text-muted-foreground">
                      Reason: <code>{s.reason}</code>
                    </div>
                  )}
                  <div className="text-xs text-muted-foreground">
                    Discovered {s.createdAt ? format(new Date(s.createdAt), "PP p") : "—"}
                    {s.reviewedAt && (
                      <>
                        {" • Reviewed "}
                        {format(new Date(s.reviewedAt), "PP p")}
                        {s.reviewedByName ? ` by ${s.reviewedByName}` : ""}
                      </>
                    )}
                  </div>

                  {s.status === "pending" && (
                    <div className="flex gap-2 pt-2">
                      <Button
                        size="sm"
                        onClick={() => openApprove(s)}
                        disabled={!APPROVABLE_KINDS.has(s.entityKind)}
                        data-testid={`button-approve-${s.id}`}
                      >
                        <Check className="w-4 h-4 mr-1" /> Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => dismissMutation.mutate(s.id)}
                        disabled={dismissMutation.isPending}
                        data-testid={`button-dismiss-${s.id}`}
                      >
                        <X className="w-4 h-4 mr-1" /> Dismiss
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {!isLoading && total > 0 && (
        <div className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
          <span data-testid="text-suggestions-range">
            {(page - 1) * PAGE_SIZE + (items.length > 0 ? 1 : 0)}–{(page - 1) * PAGE_SIZE + items.length} of {total}
          </span>
          {pageCount > 1 && (
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1 || isFetching}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                data-testid="button-suggestions-prev"
              >
                Previous
              </Button>
              <span data-testid="text-suggestions-page">
                Page {page} of {pageCount}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= pageCount || isFetching}
                onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
                data-testid="button-suggestions-next"
              >
                Next
              </Button>
            </div>
          )}
        </div>
      )}

      <Dialog open={!!approveTarget} onOpenChange={(open) => !open && setApproveTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{dialogTitle}</DialogTitle>
            <DialogDescription>{dialogDescription}</DialogDescription>
          </DialogHeader>

          {approveTarget?.entityKind === "client_contact" && (
            <div className="space-y-3">
              <div>
                <Label>Contact name</Label>
                <Input
                  value={approveName}
                  onChange={(e) => setApproveName(e.target.value)}
                  placeholder="Display name"
                  data-testid="input-approve-name"
                />
              </div>
              <FormField
                label="Emails"
                htmlFor="approve-emails"
                error={approveErrors.emails}
                className="space-y-1"
              >
                {(ctx) => (
                  <div
                    id={ctx.fieldId}
                    aria-invalid={ctx.invalid || undefined}
                    aria-describedby={ctx.describedBy}
                    className="space-y-1"
                  >
                    {Object.keys(approveEmails).length === 0 ? (
                      <p className="text-xs text-muted-foreground">No emails on this suggestion.</p>
                    ) : Object.keys(approveEmails).map(email => (
                      <label key={email} className="flex items-center gap-2 text-sm">
                        <Checkbox
                          checked={approveEmails[email]}
                          onCheckedChange={(v) => {
                            setApproveEmails(prev => ({ ...prev, [email]: !!v }));
                            setApproveErrors(prev => ({ ...prev, emails: undefined }));
                          }}
                          data-testid={`checkbox-email-${email}`}
                        />
                        <span>{email}</span>
                      </label>
                    ))}
                  </div>
                )}
              </FormField>
            </div>
          )}

          {approveTarget?.entityKind === "client_location" && (
            <div className="space-y-3">
              <FormField
                label="Location name"
                htmlFor="input-approve-location-name"
                error={approveErrors.locationName}
              >
                <Input
                  value={approveLocationName}
                  onChange={(e) => {
                    setApproveLocationName(e.target.value);
                    setApproveErrors(prev => ({ ...prev, locationName: undefined }));
                  }}
                  placeholder="e.g. Downtown Office"
                  data-testid="input-approve-location-name"
                />
              </FormField>
              <FormField
                label="Address"
                htmlFor="input-approve-location-address"
                error={approveErrors.locationAddress}
              >
                <Input
                  value={approveLocationAddress}
                  onChange={(e) => {
                    setApproveLocationAddress(e.target.value);
                    setApproveErrors(prev => ({ ...prev, locationAddress: undefined }));
                  }}
                  placeholder="Street, city, state, zip"
                  data-testid="input-approve-location-address"
                />
              </FormField>
            </div>
          )}

          {approveTarget?.entityKind === "product" && (
            <div className="space-y-3">
              <FormField
                label="Product"
                htmlFor="select-approve-product"
                error={approveErrors.product}
              >
                {(ctx) => (
                <Select
                  value={approveProduct}
                  onValueChange={(v) => {
                    setApproveProduct(v);
                    setApproveErrors(prev => ({ ...prev, product: undefined }));
                  }}
                >
                  <SelectTrigger
                    id={ctx.fieldId}
                    aria-invalid={ctx.invalid}
                    aria-describedby={ctx.describedBy}
                    data-testid="select-approve-product"
                  >
                    <SelectValue placeholder="Pick a product" />
                  </SelectTrigger>
                  <SelectContent>
                    {CLIENT_PRODUCT_OPTIONS.map(opt => (
                      <SelectItem
                        key={opt.value}
                        value={opt.value}
                        data-testid={`option-approve-product-${opt.value}`}
                      >
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                )}
              </FormField>
            </div>
          )}

          <DialogFooter>
            <Button variant="ghost" onClick={() => setApproveTarget(null)} data-testid="button-cancel-approve">
              Cancel
            </Button>
            <Button
              onClick={submitApprove}
              disabled={approveMutation.isPending}
              data-testid="button-confirm-approve"
            >
              {approveMutation.isPending && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}
              Promote
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
