import { useAuth } from "@/hooks/use-auth";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { useLocation } from "wouter";
import { AlertTriangle, Users } from "lucide-react";
import { PageHeader } from "@/components/admin/PageHeader";
import { useState } from "react";
import { SELECT_NONE_VALUE } from "@/lib/constants";
import { FormSkeleton } from "@/components/ui/skeleton-loaders";
import { CLIENT_PRODUCT_OPTIONS } from "@shared/productResolution";
import { dataAccessCategoryDefs } from "@shared/schema";
import {
  ClientSaveError,
  formatAllowedProducts,
  parseClientSaveError,
} from "@/lib/clientProductErrors";

// Task #4171 — Team assignments section: every client-facing department's
// supported roles, pre-filled with the department defaults and editable before
// the client is created.
const TEAM_ROLE_FIELDS = [
  { field: "primaryUserId", defaultField: "defaultPrimaryUserId", label: "Doer" },
  { field: "checkerUserId", defaultField: "defaultCheckerUserId", label: "Checker" },
] as const;
type TeamRoleField = (typeof TEAM_ROLE_FIELDS)[number]["field"];
type TeamRolePicks = Partial<Record<TeamRoleField, string | null>>;
/** Select sentinel meaning "untouched — seed the department default". */
const TEAM_DEFAULT_SENTINEL = "__default__";

interface TeamOptionsDept {
  id: string;
  name: string;
  sortOrder: number;
  defaultPrimaryUserId: string | null;
  defaultCheckerUserId?: string | null;
  roleCapabilities?: {
    checker: boolean;
  };
}

interface TeamOptionsResponse {
  departments: TeamOptionsDept[];
  membersByDept: Record<string, { id: string; name: string }[]>;
}

// Task #4463 — categories + labels from the shared single source of truth
// (shared/models/clients.ts) so every surface shows the same names.
const DATA_ACCESS_CATEGORIES = dataAccessCategoryDefs.map(d => ({
  id: d.id,
  label: d.label,
  description: `Unlocks ${d.unlocks}`,
}));

export default function ClientAdd() {
  const { user, isLoading: authLoading } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const [formData, setFormData] = useState({
    firmName: "",
    contactName: "",
    contactEmail: "",
    contactPhone: "",
    consultType: "free",
    products: [] as string[],
    hasPostConsultReviewAccess: false,
    hasPostCaseClosedReviewAccess: false,
  });
  const [dataAccess, setDataAccess] = useState<Record<string, "available" | "pending" | "refused" | "unknown">>({
    consult_bookings: "unknown",
    sales_conversions: "unknown",
    sales_transcripts: "unknown",
    no_show_rate: "unknown",
    follow_up_touches: "unknown",
  });
  const [invalidProductsError, setInvalidProductsError] = useState<{
    invalid: string[];
    allowed: string[];
  } | null>(null);

  // Task #4171 — per-department role picks. Absent key = untouched (the
  // server seeds the department default); explicit null = "None" (no
  // explicit person; runtime resolution still falls back to the default,
  // like any empty slot).
  const [teamPicks, setTeamPicks] = useState<Record<string, TeamRolePicks>>({});
  const teamOptions = useQuery<TeamOptionsResponse>({
    queryKey: ["/api/service-desk/client-team-options"],
    enabled: !!user,
  });

  function setTeamPick(deptId: string, role: TeamRoleField, value: string) {
    setTeamPicks(prev => {
      const dept = { ...(prev[deptId] ?? {}) };
      if (value === TEAM_DEFAULT_SENTINEL) {
        delete dept[role];
      } else {
        dept[role] = value === SELECT_NONE_VALUE ? null : value;
      }
      const next = { ...prev };
      if (Object.keys(dept).length === 0) delete next[deptId];
      else next[deptId] = dept;
      return next;
    });
  }

  function toggleProduct(productId: string) {
    setFormData(prev => {
      const current = prev.products || [];
      if (current.includes(productId)) {
        return { ...prev, products: current.filter(p => p !== productId) };
      } else {
        return { ...prev, products: [...current, productId] };
      }
    });
  }

  const createMutation = useMutation({
    mutationFn: async (data: typeof formData) => {
      // Only explicitly-changed roles ride along; untouched roles are seeded
      // from the department defaults server-side.
      const checkerCapableByDepartment = new Map(
        (teamOptions.data?.departments ?? []).map((department) => [
          department.id,
          department.roleCapabilities?.checker === true,
        ]),
      );
      const teamAssignments = Object.entries(teamPicks).map(([departmentId, roles]) => ({
        departmentId,
        ...(Object.prototype.hasOwnProperty.call(roles, "primaryUserId")
          ? { primaryUserId: roles.primaryUserId }
          : {}),
        ...(checkerCapableByDepartment.get(departmentId) &&
        Object.prototype.hasOwnProperty.call(roles, "checkerUserId")
          ? { checkerUserId: roles.checkerUserId }
          : {}),
      }));
      const res = await fetch("/api/clients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(teamAssignments.length > 0 ? { ...data, teamAssignments } : data),
      });
      if (!res.ok) throw await parseClientSaveError(res, "Failed to create client");
      const client = await res.json();
      
      for (const [category, status] of Object.entries(dataAccess)) {
        await fetch(`/api/clients/${client.id}/data-access/${category}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ status }),
        });
      }
      
      return client;
    },
    onSuccess: (client: any) => {
      void queryClient.invalidateQueries({ queryKey: ["/api/clients"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/dashboard/client-summaries"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/reports/matrix"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/admin/role-assignments"] }); // fire-and-forget: cache refresh only
      if (client?.teamAssignmentWarning) {
        toast({
          title: "Team assignments not saved",
          description: client.teamAssignmentWarning,
          variant: "destructive",
        });
      }
      toast({ title: "Client added to your account" });
      navigate("/");
    },
    onError: (err: Error) => {
      const e = err as ClientSaveError;
      if (e.code === "INVALID_PRODUCTS") {
        setInvalidProductsError({
          invalid: e.invalidProducts ?? [],
          allowed: e.allowedProducts ?? [],
        });
      }
      toast({
        title: e.message || "Failed to create client",
        description: e.description,
        variant: "destructive",
      });
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (formData.products.length === 0) {
      toast({ title: "Please select at least one product before adding the client.", variant: "destructive" });
      return;
    }
    setInvalidProductsError(null);
    createMutation.mutate(formData);
  }

  if (authLoading) {
    return <FormSkeleton />;
  }

  if (!user) {
    return (
      <div className="min-h-[calc(100dvh-var(--nav-height))] bg-surface-warm-1 flex items-center justify-center">
        <div className="text-muted-foreground">Please sign in to continue.</div>
      </div>
    );
  }

  return (
    <div className="min-h-[calc(100dvh-var(--nav-height))] bg-surface-warm-1">
      {/* Task #4710 — standard page-header grammar (PageHeader, Task #4344)
          on the light canvas; replaces the legacy bg-primary band whose bare
          h1 was repainted illegible by the base-layer heading rule. Header
          container matches the form's max-w-xl column. */}
      <div className="max-w-xl mx-auto px-3 pt-3 sm:px-6 sm:pt-6">
        <PageHeader title="Add New Client" backHref="/" />
      </div>

      <main className="max-w-xl mx-auto p-3 sm:p-6">
        <Card className="bg-card border-primary/10">
          <CardHeader>
            <CardTitle className="text-foreground">Add Client to Your Account</CardTitle>
            <CardDescription>
              This client will be assigned to you automatically
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <Label htmlFor="firmName">Firm Name *</Label>
                <Input
                  id="firmName"
                  value={formData.firmName}
                  onChange={e => setFormData(prev => ({ ...prev, firmName: e.target.value }))}
                  required
                  placeholder="e.g., Smith & Associates Law Firm"
                  data-testid="input-firm-name"
                />
              </div>
              <div>
                <Label htmlFor="contactName">Contact Name</Label>
                <Input
                  id="contactName"
                  value={formData.contactName}
                  onChange={e => setFormData(prev => ({ ...prev, contactName: e.target.value }))}
                  placeholder="Primary contact person"
                  data-testid="input-contact-name"
                />
              </div>
              <div>
                <Label htmlFor="contactEmail">Contact Email</Label>
                <Input
                  id="contactEmail"
                  type="email"
                  value={formData.contactEmail}
                  onChange={e => setFormData(prev => ({ ...prev, contactEmail: e.target.value }))}
                  placeholder="email@lawfirm.com"
                  data-testid="input-contact-email"
                />
              </div>
              <div>
                <Label htmlFor="contactPhone">Contact Phone</Label>
                <Input
                  id="contactPhone"
                  value={formData.contactPhone}
                  onChange={e => setFormData(prev => ({ ...prev, contactPhone: e.target.value }))}
                  placeholder="(555) 123-4567"
                  data-testid="input-contact-phone"
                />
              </div>
              <div>
                <Label htmlFor="consultType">Consultation Type</Label>
                <Select value={formData.consultType} onValueChange={v => setFormData(prev => ({ ...prev, consultType: v }))}>
                  <SelectTrigger data-testid="select-consult-type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="free">Free Consultation</SelectItem>
                    <SelectItem value="paid">Paid Consultation</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="pt-4 border-t">
                <Label className="text-base font-semibold">Products Purchased *</Label>
                <p className="text-sm text-muted-foreground mb-3">Select which services this client has purchased</p>
                <div className="space-y-3">
                  {CLIENT_PRODUCT_OPTIONS.map(product => (
                    <div key={product.value} className="flex items-start gap-3">
                      <Checkbox
                        id={`product-${product.value}`}
                        checked={formData.products.includes(product.value)}
                        onCheckedChange={() => toggleProduct(product.value)}
                        data-testid={`checkbox-product-${product.value}`}
                      />
                      <div className="flex-1">
                        <label htmlFor={`product-${product.value}`} className="text-sm font-medium cursor-pointer">
                          {product.label}
                        </label>
                        <p className="text-xs text-muted-foreground/70">{product.description}</p>
                      </div>
                    </div>
                  ))}
                </div>
                {formData.products.length === 0 && (
                  <p className="text-xs text-red-600 mt-2" data-testid="text-products-required-error">
                    Please select at least one product before adding the client.
                  </p>
                )}
                {invalidProductsError && (
                  <div
                    className="mt-3 p-3 rounded-md border border-red-300 bg-red-50 text-xs text-red-900"
                    data-testid="text-invalid-products-error"
                  >
                    <p className="font-semibold mb-1">Save blocked: unknown product value submitted</p>
                    {invalidProductsError.invalid.length > 0 && (
                      <p>
                        Rejected:{" "}
                        <span className="font-mono">
                          {invalidProductsError.invalid.map(v => `"${v}"`).join(", ")}
                        </span>
                      </p>
                    )}
                    <p className="mt-1">
                      Allowed: <span className="font-mono">{formatAllowedProducts(invalidProductsError.allowed)}</span>
                    </p>
                    <p className="mt-1">
                      Fix the typo, or ask an admin to add the alias to the product normalizer.
                    </p>
                  </div>
                )}
              </div>

              <div className="pt-4 border-t">
                <Label className="text-base font-semibold">Review Generation Automation</Label>
                <p className="text-sm text-muted-foreground mb-3">Track which automated review sources are enabled for this client</p>
                <div className="space-y-3">
                  <div className="flex items-start gap-3">
                    <Checkbox
                      id="hasPostConsultReviewAccess"
                      checked={formData.hasPostConsultReviewAccess}
                      onCheckedChange={(checked) => setFormData(prev => ({ ...prev, hasPostConsultReviewAccess: !!checked }))}
                      data-testid="checkbox-post-consult-review"
                    />
                    <div className="flex-1">
                      <label htmlFor="hasPostConsultReviewAccess" className="text-sm font-medium cursor-pointer">
                        Post Consult Automation Enabled?
                      </label>
                      <p className="text-xs text-muted-foreground/70">Automated review request after consultation</p>
                    </div>
                  </div>
                  <div className="flex items-start gap-3">
                    <Checkbox
                      id="hasPostCaseClosedReviewAccess"
                      checked={formData.hasPostCaseClosedReviewAccess}
                      onCheckedChange={(checked) => setFormData(prev => ({ ...prev, hasPostCaseClosedReviewAccess: !!checked }))}
                      data-testid="checkbox-post-case-closed-review"
                    />
                    <div className="flex-1">
                      <label htmlFor="hasPostCaseClosedReviewAccess" className="text-sm font-medium cursor-pointer">
                        Post Case Closed Automation Enabled?
                      </label>
                      <p className="text-xs text-muted-foreground/70">Automated review request after case resolution</p>
                    </div>
                  </div>
                </div>
              </div>

              <div className="pt-4 border-t">
                <div className="flex items-center gap-2 mb-2">
                  <AlertTriangle className="w-5 h-5 text-amber-500" />
                  <Label className="text-base font-semibold">Data Access Status</Label>
                </div>
                <p className="text-sm text-muted-foreground mb-3">Track which data the client has provided access to</p>
                <div className="space-y-3">
                  {DATA_ACCESS_CATEGORIES.map(cat => (
                    <div key={cat.id} className="flex items-center gap-3">
                      <div className="flex-1">
                        <p className="text-sm font-medium">{cat.label}</p>
                        <p className="text-xs text-muted-foreground/70">{cat.description}</p>
                      </div>
                      <Select 
                        value={dataAccess[cat.id]} 
                        onValueChange={v => setDataAccess(prev => ({ ...prev, [cat.id]: v as any }))}
                      >
                        <SelectTrigger className="w-32" data-testid={`select-access-${cat.id}`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="available">Available</SelectItem>
                          <SelectItem value="pending">Pending</SelectItem>
                          <SelectItem value="refused">Refused</SelectItem>
                          <SelectItem value="unknown">Unknown</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  ))}
                </div>
              </div>

              {(teamOptions.data?.departments.length ?? 0) > 0 && (
                <div className="pt-4 border-t">
                  <div className="flex items-center gap-2 mb-2">
                    <Users className="w-5 h-5 text-primary" />
                    <Label className="text-base font-semibold">Team assignments</Label>
                  </div>
                  <p className="text-sm text-muted-foreground mb-3">
                    Each department's supported roles. Department defaults pre-fill the
                    starting team; the selected people are saved as this client's assignments when the client is
                    created. Manage defaults and client overrides later in the company Role Assignments console.
                  </p>
                  <div className="space-y-4">
                    {teamOptions.data!.departments.map(dept => {
                      const members = teamOptions.data!.membersByDept[dept.id] ?? [];
                      const nameOf = (id: string | null) => members.find(m => m.id === id)?.name ?? null;
                      return (
                        <div key={dept.id} className="rounded-md border border-primary/10 p-3" data-testid={`team-dept-${dept.id}`}>
                          <p className="text-sm font-medium mb-2">{dept.name}</p>
                          <div className="grid gap-2 sm:grid-cols-3">
                            {TEAM_ROLE_FIELDS
                              .filter(({ field }) => field !== "checkerUserId" || dept.roleCapabilities?.checker === true)
                              .map(({ field, defaultField, label }) => {
                              const defaultId = dept[defaultField];
                              const defaultName = defaultId ? nameOf(defaultId) : null;
                              const deptPicks = teamPicks[dept.id] ?? {};
                              const hasPick = Object.prototype.hasOwnProperty.call(deptPicks, field);
                              const picked = deptPicks[field];
                              const value = hasPick
                                ? (picked === null ? SELECT_NONE_VALUE : picked!)
                                : TEAM_DEFAULT_SENTINEL;
                              return (
                                <div key={field}>
                                  <Label className="text-xs text-muted-foreground">{label}</Label>
                                  <Select value={value} onValueChange={v => setTeamPick(dept.id, field, v)}>
                                    <SelectTrigger className="h-9" data-testid={`select-team-${dept.id}-${field}`}>
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value={TEAM_DEFAULT_SENTINEL}>
                                        {defaultName ? `${defaultName} (inherited default)` : "No default — unassigned"}
                                      </SelectItem>
                                      <SelectItem value={SELECT_NONE_VALUE}>None</SelectItem>
                                      {members.map(m => (
                                        <SelectItem key={m.id} value={m.id}>
                                          {m.name}
                                        </SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                </div>
                              );
                              })}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              <Button 
                type="submit" 
                className="w-full bg-primary hover:bg-primary/90"
                disabled={!formData.firmName || formData.products.length === 0 || createMutation.isPending}
                data-testid="button-submit-client"
              >
                {createMutation.isPending ? "Adding..." : "Add Client"}
              </Button>
              {(!formData.firmName || formData.products.length === 0) && (
                <p className="text-xs text-muted-foreground text-center mt-2" data-testid="text-submit-requirements">
                  {!formData.firmName && formData.products.length === 0
                    ? "Enter a firm name and select at least one product to add the client."
                    : !formData.firmName
                      ? "Enter a firm name to add the client."
                      : "Select at least one product to add the client."}
                </p>
              )}
            </form>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
