/**
 * Task #4337 — Campaign detail page.
 *
 * One campaign record: header + editable fields, tracked-link UTM builder
 * (links are create/delete only; the campaign-tagged URL is computed
 * server-side so a key edit re-tags every link), all-time attributed
 * stats, and the leads/deals whose immutable first-touch stamp carries
 * this campaign's utm_campaign key. Deleting the campaign removes the
 * record and its links but never the stamps — a recreated campaign with
 * the same key re-claims the history.
 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useRoute } from "wouter";
import { formatDistanceToNow } from "date-fns";
import type { CampaignLink, MarketingCampaign } from "@shared/schema";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { formatDealAmount } from "@/components/DealRequiredFieldsDialog";
import {
  CampaignFormFields,
  campaignBodyFromForm,
  sourceLabel,
  type CampaignStats,
} from "@/pages/Campaigns";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  ArrowLeft,
  Briefcase,
  Copy,
  Link2,
  Magnet,
  Megaphone,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { EmptyState } from "@/components/kit/EmptyState";

type LinkWithUrl = CampaignLink & { url: string };

interface CampaignDetailResponse {
  campaign: MarketingCampaign;
  links: LinkWithUrl[];
  stats: CampaignStats;
  attributedLeads: Array<{
    id: string;
    firmName: string;
    contactName: string | null;
    contactEmail: string | null;
    lifecycleStage: string;
    firstTouchSource: string | null;
    createdAt: string | null;
  }>;
  attributedDeals: Array<{
    id: string;
    name: string;
    amount: number | null;
    stageName: string | null;
    stageType: string | null;
    clientId: string | null;
    createdAt: string | null;
  }>;
}

interface LinkFormState {
  label: string;
  destinationUrl: string;
  utmSource: string;
  utmMedium: string;
  utmTerm: string;
  utmContent: string;
}

const EMPTY_LINK_FORM: LinkFormState = {
  label: "",
  destinationUrl: "",
  utmSource: "",
  utmMedium: "",
  utmTerm: "",
  utmContent: "",
};

function ago(ts: string | null): string {
  if (!ts) return "—";
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "—";
  return formatDistanceToNow(d, { addSuffix: true });
}

export default function CampaignDetail() {
  const [, params] = useRoute("/campaigns/:id");
  const id = params?.id ?? null;
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [editOpen, setEditOpen] = useState(false);
  const [editForm, setEditForm] = useState({
    name: "",
    utmCampaign: "",
    startDate: "",
    endDate: "",
    notes: "",
  });
  const [editArchived, setEditArchived] = useState(false);
  const [linkForm, setLinkForm] = useState<LinkFormState>(EMPTY_LINK_FORM);

  const detailKey = `/api/campaigns/${id}`;
  const detailQuery = useQuery<CampaignDetailResponse>({
    queryKey: [detailKey],
    enabled: !!id,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: [detailKey] });
    void queryClient.invalidateQueries({ queryKey: ["/api/campaigns"] });
  };

  const updateMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("PATCH", detailKey, {
        ...campaignBodyFromForm(editForm),
        isArchived: editArchived,
      });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Campaign updated" });
      setEditOpen(false);
      invalidate();
    },
    onError: (err: any) => {
      toast({
        title: "Could not update campaign",
        description: err?.message ?? "Unknown error",
        variant: "destructive",
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async () => apiRequest("DELETE", detailKey),
    onSuccess: () => {
      toast({
        title: "Campaign deleted",
        description: "Attributed leads and deals keep their first-touch stamps.",
      });
      void queryClient.invalidateQueries({ queryKey: ["/api/campaigns"] });
      setLocation("/campaigns");
    },
    onError: (err: any) => {
      toast({
        title: "Could not delete campaign",
        description: err?.message ?? "Unknown error",
        variant: "destructive",
      });
    },
  });

  const addLinkMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `${detailKey}/links`, {
        label: linkForm.label.trim() || null,
        destinationUrl: linkForm.destinationUrl.trim(),
        utmSource: linkForm.utmSource.trim() || null,
        utmMedium: linkForm.utmMedium.trim() || null,
        utmTerm: linkForm.utmTerm.trim() || null,
        utmContent: linkForm.utmContent.trim() || null,
      });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Link added" });
      setLinkForm(EMPTY_LINK_FORM);
      invalidate();
    },
    onError: (err: any) => {
      toast({
        title: "Could not add link",
        description: err?.message ?? "Unknown error",
        variant: "destructive",
      });
    },
  });

  const deleteLinkMutation = useMutation({
    mutationFn: async (linkId: string) =>
      apiRequest("DELETE", `${detailKey}/links/${linkId}`),
    onSuccess: () => {
      toast({ title: "Link removed" });
      invalidate();
    },
    onError: (err: any) => {
      toast({
        title: "Could not remove link",
        description: err?.message ?? "Unknown error",
        variant: "destructive",
      });
    },
  });

  const copyUrl = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast({ title: "Copied", description: "Tagged URL is on your clipboard." });
    } catch {
      toast({
        title: "Could not copy",
        description: "Select the URL text and copy manually.",
        variant: "destructive",
      });
    }
  };

  if (!id) return null;

  if (detailQuery.isLoading || !detailQuery.data) {
    return (
      <div className="p-4 md:p-6 max-w-6xl mx-auto space-y-4">
        <Skeleton className="h-8 w-1/3" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const { campaign, links, stats, attributedLeads, attributedDeals } = detailQuery.data;

  const openEdit = () => {
    setEditForm({
      name: campaign.name,
      utmCampaign: campaign.utmCampaign,
      startDate: campaign.startDate ?? "",
      endDate: campaign.endDate ?? "",
      notes: campaign.notes ?? "",
    });
    setEditArchived(campaign.isArchived);
    setEditOpen(true);
  };

  const canSaveEdit =
    editForm.name.trim().length > 0 && editForm.utmCampaign.trim().length > 0;
  const canAddLink = /^https?:\/\//i.test(linkForm.destinationUrl.trim());

  return (
    <div className="p-4 md:p-6 max-w-6xl mx-auto space-y-5" data-testid="page-campaign-detail">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <Button asChild variant="ghost" size="sm" className="-ml-2 mb-1">
            <Link href="/campaigns" data-testid="link-back-campaigns">
              <ArrowLeft className="h-4 w-4 mr-1" />
              Campaigns
            </Link>
          </Button>
          <h1
            className="text-2xl font-semibold flex items-center gap-2"
            data-testid="text-campaign-name"
          >
            <Megaphone className="h-6 w-6 text-muted-foreground" />
            {campaign.name}
            {campaign.isArchived && (
              <Badge variant="outline" className="text-muted-foreground">
                Archived
              </Badge>
            )}
          </h1>
          <p className="text-sm text-muted-foreground">
            <span className="font-mono">utm_campaign={campaign.utmCampaign}</span>
            {(campaign.startDate || campaign.endDate) &&
              ` · ${campaign.startDate ?? "…"} → ${campaign.endDate ?? "…"}`}
          </p>
          {campaign.notes && (
            <p className="text-sm text-muted-foreground whitespace-pre-wrap max-w-2xl">
              {campaign.notes}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={openEdit} data-testid="button-edit-campaign">
            <Pencil className="h-4 w-4 mr-1" />
            Edit
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="outline" size="sm" data-testid="button-delete-campaign">
                <Trash2 className="h-4 w-4 mr-1 text-destructive" />
                Delete
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete this campaign?</AlertDialogTitle>
                <AlertDialogDescription>
                  The campaign record and its tracked links are removed. Leads and
                  deals keep their first-touch attribution — recreating a campaign
                  with the same UTM key claims it again.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => deleteMutation.mutate()}
                  data-testid="button-confirm-delete-campaign"
                >
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {(
          [
            ["Leads", stats.leads, "stat-leads"],
            ["Deals", stats.deals, "stat-deals"],
            ["Won deals", stats.wonDeals, "stat-won-deals"],
            ["Won revenue", formatDealAmount(stats.wonAmount), "stat-won-revenue"],
          ] as const
        ).map(([label, value, testId]) => (
          <Card key={testId}>
            <CardContent className="pt-4 pb-3">
              <div className="text-xs text-muted-foreground">{label}</div>
              <div className="text-xl font-semibold" data-testid={testId}>
                {value}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card data-testid="card-campaign-links">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-1.5">
            <Link2 className="h-4 w-4" />
            Tracked links
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="link-label">Label</Label>
              <Input
                id="link-label"
                value={linkForm.label}
                onChange={(e) => setLinkForm({ ...linkForm, label: e.target.value })}
                placeholder="Newsletter footer CTA"
                maxLength={200}
                data-testid="input-link-label"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="link-destination">Destination URL</Label>
              <Input
                id="link-destination"
                value={linkForm.destinationUrl}
                onChange={(e) =>
                  setLinkForm({ ...linkForm, destinationUrl: e.target.value })
                }
                placeholder="https://nobullmarketing.co/pricing/"
                maxLength={2000}
                data-testid="input-link-destination"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="link-source">utm_source</Label>
              <Input
                id="link-source"
                value={linkForm.utmSource}
                onChange={(e) => setLinkForm({ ...linkForm, utmSource: e.target.value })}
                placeholder="newsletter"
                maxLength={200}
                data-testid="input-link-source"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="link-medium">utm_medium</Label>
              <Input
                id="link-medium"
                value={linkForm.utmMedium}
                onChange={(e) => setLinkForm({ ...linkForm, utmMedium: e.target.value })}
                placeholder="email"
                maxLength={200}
                data-testid="input-link-medium"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="link-term">utm_term</Label>
              <Input
                id="link-term"
                value={linkForm.utmTerm}
                onChange={(e) => setLinkForm({ ...linkForm, utmTerm: e.target.value })}
                maxLength={200}
                data-testid="input-link-term"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="link-content">utm_content</Label>
              <Input
                id="link-content"
                value={linkForm.utmContent}
                onChange={(e) => setLinkForm({ ...linkForm, utmContent: e.target.value })}
                maxLength={200}
                data-testid="input-link-content"
              />
            </div>
          </div>
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              utm_campaign is always this campaign's key — generated URLs stay in
              sync if the key changes.
            </p>
            <Button
              size="sm"
              disabled={!canAddLink || addLinkMutation.isPending}
              onClick={() => addLinkMutation.mutate()}
              data-testid="button-add-link"
            >
              <Plus className="h-4 w-4 mr-1" />
              Add link
            </Button>
          </div>

          {links.length === 0 ? (
            <EmptyState
              icon={<Link2 />}
              title="No tracked links yet"
              description="Build one above and use the generated URL in your sends and ads — every click carries this campaign's UTM key."
              testId="text-links-empty"
            />
          ) : (
            <div className="space-y-2">
              {links.map((link) => (
                <div
                  key={link.id}
                  className="border px-3 py-2 flex items-center justify-between gap-3"
                  data-testid={`row-link-${link.id}`}
                >
                  <div className="min-w-0">
                    {link.label && <div className="text-sm font-medium">{link.label}</div>}
                    <div
                      className="text-xs font-mono text-muted-foreground truncate"
                      title={link.url}
                      data-testid={`text-link-url-${link.id}`}
                    >
                      {link.url}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void copyUrl(link.url)}
                      aria-label="Copy tracking link"
                      data-testid={`button-copy-link-${link.id}`}
                    >
                      <Copy className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={deleteLinkMutation.isPending}
                      onClick={() => deleteLinkMutation.mutate(link.id)}
                      aria-label="Delete tracking link"
                      data-testid={`button-delete-link-${link.id}`}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card className="min-w-0" data-testid="card-attributed-leads">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-1.5">
              <Magnet className="h-4 w-4" />
              Attributed leads
            </CardTitle>
          </CardHeader>
          <CardContent>
            {attributedLeads.length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="text-leads-empty">
                No leads carry this campaign key yet.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Lead</TableHead>
                    <TableHead>Stage</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead className="text-right">Created</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {attributedLeads.map((lead) => (
                    <TableRow key={lead.id} data-testid={`row-attributed-lead-${lead.id}`}>
                      <TableCell>
                        <div className="font-medium">{lead.firmName}</div>
                        {lead.contactEmail && (
                          <div className="text-xs text-muted-foreground">
                            {lead.contactEmail}
                          </div>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary">{lead.lifecycleStage}</Badge>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {lead.firstTouchSource ? sourceLabel(lead.firstTouchSource) : "—"}
                      </TableCell>
                      <TableCell className="text-right text-sm text-muted-foreground">
                        {ago(lead.createdAt)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card className="min-w-0" data-testid="card-attributed-deals">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-1.5">
              <Briefcase className="h-4 w-4" />
              Attributed deals
            </CardTitle>
          </CardHeader>
          <CardContent>
            {attributedDeals.length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="text-deals-empty">
                No deals carry this campaign key yet.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Deal</TableHead>
                    <TableHead>Stage</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead className="text-right">Created</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {attributedDeals.map((deal) => (
                    <TableRow key={deal.id} data-testid={`row-attributed-deal-${deal.id}`}>
                      <TableCell>
                        <Link
                          href={`/deals/${deal.id}`}
                          className="font-medium hover:underline"
                        >
                          {deal.name}
                        </Link>
                      </TableCell>
                      <TableCell>
                        {deal.stageName ? (
                          <Badge
                            variant={deal.stageType === "won" ? "default" : "secondary"}
                          >
                            {deal.stageName}
                          </Badge>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        {formatDealAmount(deal.amount)}
                      </TableCell>
                      <TableCell className="text-right text-sm text-muted-foreground">
                        {ago(deal.createdAt)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-w-lg" data-testid="dialog-edit-campaign">
          <DialogHeader>
            <DialogTitle>Edit campaign</DialogTitle>
            <DialogDescription>
              Changing the UTM key re-points attribution to rows stamped with the
              new key.
            </DialogDescription>
          </DialogHeader>
          <CampaignFormFields form={editForm} setForm={setEditForm} />
          <div className="flex items-center gap-2">
            <Switch
              id="campaign-archived"
              checked={editArchived}
              onCheckedChange={setEditArchived}
              data-testid="switch-campaign-archived"
            />
            <Label htmlFor="campaign-archived">Archived</Label>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setEditOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!canSaveEdit || updateMutation.isPending}
              onClick={() => updateMutation.mutate()}
              data-testid="button-save-edit-campaign"
            >
              Save changes
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
