import { useAuth } from "@/hooks/use-auth";
import { usePageTitle } from "@/hooks/use-page-title";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { ConfirmActionDialog } from "@/components/kit/ConfirmActionDialog";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { Link } from "wouter";
import { Plus, Pencil, Trash2, MapPin, X, Eye, Archive, ArchiveRestore, AlertTriangle, Download } from "lucide-react";
import { PageHeader } from "@/components/admin/PageHeader";
import { useMemo, useState } from "react";
import { HideDemoToggle } from "@/components/HideDemoToggle";
import { useHideDemoAccounts } from "@/hooks/use-hide-demo-accounts";
import { partitionDemoAccounts } from "@/lib/demoAccounts";
import { PRACTICE_AREA_OPTIONS } from "@shared/practiceAreas";
import { CLIENT_PRODUCT_OPTIONS, validateProductList } from "@shared/productResolution";
import { dataAccessCategoryDefs } from "@shared/schema";
import {
  ClientSaveError,
  formatAllowedProducts,
  parseClientSaveError,
} from "@/lib/clientProductErrors";
import { Checkbox } from "@/components/ui/checkbox";
import { logActivity } from "@/hooks/use-activity-tracker";
import { PageSkeleton, InlineLoadingSkeleton } from "@/components/ui/skeleton-loaders";
import { AuditHistoryPopover, useAuditHistory } from "@/components/AuditHistoryPopover";

type Client = {
  id: string;
  clientCode: string | null;
  firmName: string;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  consultType: string | null;
  practiceAreas: string[] | null;
  products: string[] | null;
  ownerId: string | null;
  initialLeads: number | null;
  initialReviews: number | null;
  initialCases: number | null;
  isArchived: boolean | null;
  /** Task #4363 — demo-account marker (same flag as the "Demo Account" badge). */
  isDemo?: boolean | null;
  clientStartDate: string | null;
  // Task #3711 — scheduled offboarding (auto-archive on final service day).
  offboarding?: { id: string; finalServiceDate: string; status: string } | null;
};

// Format a YYYY-MM-DD calendar date without a timezone shift (Task #3711).
function formatFinalServiceDay(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  if (!y || !m || !d) return isoDate;
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}


// Task #4463 — categories + labels from the shared single source of truth
// (shared/models/clients.ts) so every surface shows the same names.
const DATA_ACCESS_CATEGORIES = dataAccessCategoryDefs.map(d => ({
  id: d.id,
  label: d.label,
  description: `Unlocks ${d.unlocks}`,
}));

type User = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  role: string | null;
};

type Location = {
  id: string;
  clientId: string;
  name: string;
  address: string | null;
  city: string | null;
  state: string | null;
  lat: number | null;
  lng: number | null;
  isActive: boolean | null;
};

export default function ClientManagement() {
  const { user, isLoading: authLoading } = useAuth();
  usePageTitle("Client Admin");
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isOpen, setIsOpen] = useState(false);
  const [editingClient, setEditingClient] = useState<Client | null>(null);
  const [editingInvalidProducts, setEditingInvalidProducts] = useState<string[]>([]);
  const [invalidProductsError, setInvalidProductsError] = useState<{
    invalid: string[];
    allowed: string[];
  } | null>(null);
  const [locationsDialogClient, setLocationsDialogClient] = useState<Client | null>(null);
  const [pendingDeleteClient, setPendingDeleteClient] = useState<Client | null>(null);
  const [newLocationName, setNewLocationName] = useState("");
  const [newLocationAddress, setNewLocationAddress] = useState("");
  const [reGeocodeLocationId, setReGeocodeLocationId] = useState<string | null>(null);
  const [reGeocodeAddress, setReGeocodeAddress] = useState("");
  const [formData, setFormData] = useState({
    firmName: "",
    contactName: "",
    contactEmail: "",
    contactPhone: "",
    consultType: "free",
    practiceAreas: [] as string[],
    products: ["gbp"] as string[],
    ownerId: "",
    initialLeads: 0,
    initialReviews: 0,
    initialCases: 0,
    clientStartDate: "",
  });
  const [showArchived, setShowArchived] = useState(false);
  const [draftLocations, setDraftLocations] = useState<{ name: string; address: string }[]>([]);
  const [newDraftLocation, setNewDraftLocation] = useState("");
  const [newDraftLocationAddress, setNewDraftLocationAddress] = useState("");
  const [dataAccess, setDataAccess] = useState<Record<string, "available" | "pending" | "refused" | "unknown">>({
    consult_bookings: "unknown",
    sales_conversions: "unknown",
    sales_transcripts: "unknown",
    no_show_rate: "unknown",
    follow_up_touches: "unknown",
  });

  const { data: clients, isLoading } = useQuery<Client[]>({
    queryKey: ["/api/clients", showArchived],
    queryFn: async () => {
      const url = showArchived ? "/api/clients?showArchived=true" : "/api/clients";
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch clients");
      return res.json();
    },
    enabled: !!user && (user.role === "team_lead" || user.role === "ceo"),
  });

  // Task #4363 — global hide-demo filter (audit P3-4): display-only
  // partition on the same clients.isDemo marker as the "Demo Account"
  // badge; the persisted per-user toggle renders next to Show Archived.
  const [hideDemo, setHideDemo] = useHideDemoAccounts(user?.id);
  const demoPartition = useMemo(
    () => partitionDemoAccounts(clients ?? [], hideDemo),
    [clients, hideDemo],
  );
  const visibleClients = demoPartition.visible;
  const hiddenDemoCount = demoPartition.hiddenDemoCount;

  type InvalidProductsRow = {
    id: string;
    clientCode: string | null;
    firmName: string;
    storedProducts: string[];
    invalidValues: string[];
    isArchived: boolean;
  };
  type InvalidProductsResponse = { scanned: number; offenders: InvalidProductsRow[] };

  const { data: invalidProducts } = useQuery<InvalidProductsResponse>({
    queryKey: ["/api/admin/clients/invalid-products"],
    queryFn: async () => {
      const res = await fetch("/api/admin/clients/invalid-products", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch invalid product audit");
      return res.json();
    },
    enabled: !!user && (user.role === "team_lead" || user.role === "ceo"),
  });

  const { data: users } = useQuery<User[]>({
    queryKey: ["/api/users"],
    queryFn: async () => {
      const res = await fetch("/api/users", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch users");
      return res.json();
    },
    enabled: !!user && (user.role === "team_lead" || user.role === "ceo"),
  });

  type UngeocodedClient = {
    clientId: string;
    firmName: string;
    clientCode: string | null;
    locations: { id: string; name: string; address: string | null }[];
  };
  type UngeocodedResponse = { clients: UngeocodedClient[]; totalClients: number; totalLocations: number };

  const { data: ungeocoded } = useQuery<UngeocodedResponse>({
    queryKey: ["/api/admin/locations/ungeocoded"],
    queryFn: async () => {
      const res = await fetch("/api/admin/locations/ungeocoded", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch ungeocoded locations");
      return res.json();
    },
    enabled: !!user && (user.role === "team_lead" || user.role === "ceo"),
  });

  const createMutation = useMutation({
    meta: { silent: true },
    mutationFn: async (data: typeof formData & { locations?: { name: string; address: string }[] }) => {
      // Clean up data before sending - convert empty strings to null and dates to Date objects
      const cleanedData = {
        ...data,
        clientStartDate: data.clientStartDate ? new Date(data.clientStartDate) : null,
        contactName: data.contactName || null,
        contactEmail: data.contactEmail || null,
        contactPhone: data.contactPhone || null,
        ownerId: data.ownerId || null,
      };
      const res = await fetch("/api/clients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(cleanedData),
      });
      if (!res.ok) {
        throw await parseClientSaveError(res, "Failed to create client");
      }
      const client = await res.json();
      
      // Save data access settings for the new client (non-blocking - don't fail the entire creation if this fails)
      try {
        for (const [category, status] of Object.entries(dataAccess)) {
          const accessRes = await fetch(`/api/clients/${client.id}/data-access/${category}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ status }),
          });
          if (!accessRes.ok) {
            console.warn(`Failed to save data access for ${category}:`, await accessRes.text());
          }
        }
      } catch (accessError) {
        console.warn("Failed to save data access settings:", accessError);
        // Don't throw - client was created successfully
      }
      
      return client;
    },
    onSuccess: (client: any) => {
      logActivity("save", "Created new client", { firmName: formData.firmName });
      void queryClient.invalidateQueries({ queryKey: ["/api/clients"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/dashboard/client-summaries"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/reports/matrix"] }); // fire-and-forget: cache refresh only
      const warnings = client?.locationWarnings as { name: string; reason: string }[] | undefined;
      if (warnings && warnings.length > 0) {
        toast({
          title: "Client created, but some locations weren't added",
          description: warnings.map((w) => `${w.name}: ${w.reason}`).join("\n"),
          variant: "destructive",
        });
      } else {
        toast({ title: "Client created successfully" });
      }
      setIsOpen(false);
      resetForm();
    },
    onError: (err: Error) => {
      const e = err as ClientSaveError;
      console.error("Create client error:", e);
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

  const updateMutation = useMutation({
    meta: { silent: true },
    mutationFn: async ({ id, data, accessData }: { id: string; data: typeof formData; accessData: typeof dataAccess }) => {
      // Clean up data before sending - convert empty strings to null and dates to Date objects
      const cleanedData = {
        ...data,
        clientStartDate: data.clientStartDate ? new Date(data.clientStartDate) : null,
        contactName: data.contactName || null,
        contactEmail: data.contactEmail || null,
        contactPhone: data.contactPhone || null,
        ownerId: data.ownerId || null,
      };
      const res = await fetch(`/api/clients/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(cleanedData),
      });
      if (!res.ok) {
        throw await parseClientSaveError(res, "Failed to update client");
      }
      const updated = await res.json();
      // Save data access values (PUT matches the registered backend route)
      const failedAccessCategories: string[] = [];
      for (const [category, status] of Object.entries(accessData)) {
        try {
          const accessRes = await fetch(`/api/clients/${id}/data-access/${category}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ status }),
          });
          if (!accessRes.ok) {
            failedAccessCategories.push(category);
            console.warn(`Failed to save data access for ${category}:`, await accessRes.text());
          }
        } catch (e) {
          failedAccessCategories.push(category);
          console.error("Failed to save data access:", e);
        }
      }
      return { client: updated, failedAccessCategories };
    },
    onSuccess: ({ failedAccessCategories }: { client: any; failedAccessCategories: string[] }) => {
      logActivity("save", "Updated client", { firmName: formData.firmName });
      void queryClient.invalidateQueries({ queryKey: ["/api/clients"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/dashboard/client-summaries"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/reports/matrix"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/admin/clients/invalid-products"] }); // fire-and-forget: cache refresh only
      if (failedAccessCategories.length > 0) {
        toast({
          title: "Client saved, but some Data Access changes didn't save",
          description: `Couldn't save: ${failedAccessCategories.join(", ")}. Please try again.`,
          variant: "destructive",
        });
      } else {
        toast({ title: "Client updated successfully" });
      }
      setIsOpen(false);
      setEditingClient(null);
      resetForm();
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
        title: e.message || "Failed to update client",
        description: e.description,
        variant: "destructive",
      });
    },
  });

  const deleteMutation = useMutation({
    meta: { silent: true },
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/clients/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to delete client");
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/clients"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/dashboard/client-summaries"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/reports/matrix"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/admin/clients/invalid-products"] }); // fire-and-forget: cache refresh only
      toast({ title: "Client deleted successfully" });
    },
    onError: () => {
      toast({ title: "Failed to delete client", variant: "destructive" });
    },
  });

  const archiveMutation = useMutation({
    meta: { silent: true },
    mutationFn: async ({ id, isArchived }: { id: string; isArchived: boolean }) => {
      const res = await fetch(`/api/clients/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ isArchived }),
      });
      if (!res.ok) throw new Error("Failed to update client");
      return res.json();
    },
    onSuccess: (_, { isArchived }) => {
      void queryClient.invalidateQueries({ queryKey: ["/api/clients"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/reports/matrix"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/dashboard/client-summaries"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/admin/clients/invalid-products"] }); // fire-and-forget: cache refresh only
      toast({ title: isArchived ? "Client archived" : "Client restored" });
    },
    onError: () => {
      toast({ title: "Failed to update client", variant: "destructive" });
    },
  });

  // Locations query - fetches when a client is selected for location management
  const { data: locations, isLoading: locationsLoading } = useQuery<Location[]>({
    queryKey: ["/api/clients", locationsDialogClient?.id, "locations"],
    queryFn: async () => {
      if (!locationsDialogClient) return [];
      const res = await fetch(`/api/clients/${locationsDialogClient.id}/locations`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch locations");
      return res.json();
    },
    enabled: !!locationsDialogClient,
  });

  // Locations query for editing client dialog
  const { data: editingClientLocations } = useQuery<Location[]>({
    queryKey: ["/api/clients", editingClient?.id, "locations"],
    queryFn: async () => {
      if (!editingClient) return [];
      const res = await fetch(`/api/clients/${editingClient.id}/locations`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch locations");
      return res.json();
    },
    enabled: !!editingClient,
  });

  const createLocationMutation = useMutation({
    meta: { silent: true },
    mutationFn: async ({ clientId, name, address }: { clientId: string; name: string; address: string }) => {
      const res = await fetch(`/api/clients/${clientId}/locations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ name, address }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || err.message || "Failed to add location");
      }
      return res.json();
    },
    onSuccess: (_, { clientId }) => {
      void queryClient.invalidateQueries({ queryKey: ["/api/clients", clientId, "locations"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/clients", clientId, "locations", "audit"] }); // fire-and-forget: cache refresh only
      setNewLocationName("");
      setNewLocationAddress("");
      setNewDraftLocation("");
      setNewDraftLocationAddress("");
      toast({ title: "Location added" });
    },
    onError: (err: Error) => {
      toast({ title: err.message || "Failed to add location", variant: "destructive" });
    },
  });

  const deleteLocationMutation = useMutation({
    meta: { silent: true },
    mutationFn: async ({ clientId, locationId }: { clientId: string; locationId: string }) => {
      const res = await fetch(`/api/clients/${clientId}/locations/${locationId}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to delete location");
      return { clientId };
    },
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: ["/api/clients", data.clientId, "locations"] }); // fire-and-forget: cache refresh only
      toast({ title: "Location removed" });
    },
    onError: () => {
      toast({ title: "Failed to remove location", variant: "destructive" });
    },
  });

  const updateLocationAddressMutation = useMutation({
    meta: { silent: true },
    mutationFn: async ({ clientId, locationId, address }: { clientId: string; locationId: string; address: string }) => {
      const res = await fetch(`/api/clients/${clientId}/locations/${locationId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ address }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || err.message || "Failed to update address");
      }
      return res.json();
    },
    onSuccess: (_, { clientId }) => {
      void queryClient.invalidateQueries({ queryKey: ["/api/clients", clientId, "locations"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/clients", clientId, "locations", "audit"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/admin/locations/ungeocoded"] }); // fire-and-forget: cache refresh only
      setReGeocodeLocationId(null);
      setReGeocodeAddress("");
      toast({ title: "Address updated and location re-geocoded" });
    },
    onError: (err: Error) => {
      toast({ title: err.message || "Failed to update address", variant: "destructive" });
    },
  });

  function resetForm() {
    setEditingInvalidProducts([]);
    setInvalidProductsError(null);
    setFormData({
      firmName: "",
      contactName: "",
      contactEmail: "",
      contactPhone: "",
      consultType: "free",
      practiceAreas: [],
      products: ["gbp"],
      ownerId: "",
      initialLeads: 0,
      initialReviews: 0,
      initialCases: 0,
      clientStartDate: "",
    });
    setDraftLocations([]);
    setNewDraftLocation("");
    setNewDraftLocationAddress("");
    setDataAccess({
      consult_bookings: "unknown",
      sales_conversions: "unknown",
      sales_transcripts: "unknown",
      no_show_rate: "unknown",
      follow_up_touches: "unknown",
    });
  }
  
  function addDraftLocation() {
    if (newDraftLocation.trim() && newDraftLocationAddress.trim().length >= 10) {
      setDraftLocations(prev => [...prev, { name: newDraftLocation.trim(), address: newDraftLocationAddress.trim() }]);
      setNewDraftLocation("");
      setNewDraftLocationAddress("");
    }
  }
  
  function removeDraftLocation(index: number) {
    setDraftLocations(prev => prev.filter((_, i) => i !== index));
  }

  async function openEditForOffender(clientId: string) {
    const local = clients?.find((c) => c.id === clientId);
    if (local) {
      await handleEdit(local);
      return;
    }
    try {
      const res = await fetch(`/api/clients/${clientId}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load client");
      const full: Client = await res.json();
      await handleEdit(full);
    } catch (e) {
      console.error("Failed to load offender client:", e);
      toast({
        title: "Could not open client",
        description: "Failed to load this client for editing.",
        variant: "destructive",
      });
    }
  }

  async function handleEdit(client: Client) {
    setEditingClient(client);
    setInvalidProductsError(null);
    // Sanitize stored products to canonical values only. The edit UI only
    // renders canonical checkbox options, so any invalid entries (Task #778)
    // would otherwise be invisible in the form yet still submitted to the
    // strict /api/clients/:id validator and rejected. Stripping them on load
    // means a plain re-save clears the bad values.
    const { normalized, invalid } = validateProductList(client.products || []);
    setEditingInvalidProducts(invalid);
    setFormData({
      firmName: client.firmName,
      contactName: client.contactName || "",
      contactEmail: client.contactEmail || "",
      contactPhone: client.contactPhone || "",
      consultType: client.consultType || "free",
      practiceAreas: client.practiceAreas || [],
      products: normalized,
      ownerId: client.ownerId || "",
      initialLeads: client.initialLeads || 0,
      initialReviews: client.initialReviews || 0,
      initialCases: client.initialCases || 0,
      clientStartDate: client.clientStartDate ? client.clientStartDate.split("T")[0] : "",
    });
    // Load existing data access values
    try {
      const res = await fetch(`/api/clients/${client.id}/data-access`, { credentials: "include" });
      if (res.ok) {
        const accessData = await res.json();
        const accessMap: Record<string, "available" | "pending" | "refused" | "unknown"> = {
          consult_bookings: "unknown",
          sales_conversions: "unknown",
          sales_transcripts: "unknown",
          no_show_rate: "unknown",
          follow_up_touches: "unknown",
        };
        for (const item of accessData) {
          if (item.category in accessMap) {
            accessMap[item.category] = item.status;
          }
        }
        setDataAccess(accessMap);
      }
    } catch (e) {
      console.error("Failed to load data access:", e);
    }
    setIsOpen(true);
  }


  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setInvalidProductsError(null);
    if (formData.products.length === 0) {
      toast({
        title: editingClient
          ? "Please select at least one product before saving the client."
          : "Please select at least one product before creating the client.",
        variant: "destructive",
      });
      return;
    }
    if (editingClient) {
      updateMutation.mutate({ id: editingClient.id, data: formData, accessData: dataAccess });
    } else {
      createMutation.mutate({ ...formData, locations: draftLocations });
    }
  }

  if (authLoading || isLoading) {
    return <PageSkeleton />;
  }

  const isTeamLead = user?.role === "team_lead" || user?.role === "ceo";
  
  if (!user || !isTeamLead) {
    return (
      <div className="min-h-[calc(100dvh-var(--nav-height))] bg-surface-warm-1 flex items-center justify-center">
        <div className="text-foreground">Access denied. Team Lead or CEO access required.</div>
      </div>
    );
  }

  const allUsers = users || [];

  return (
    <div className="min-h-[calc(100dvh-var(--nav-height))] bg-surface-warm-1">
      <main className="max-w-7xl mx-auto p-3 sm:p-6 space-y-4 sm:space-y-6">
        <PageHeader title="Client Management" backHref="/" />
        {invalidProducts && invalidProducts.offenders.length > 0 && (
          <Card
            className="bg-amber-50 border-amber-300"
            data-testid="panel-invalid-products"
          >
            <CardHeader className="flex flex-row items-center gap-2 flex-wrap">
              <AlertTriangle className="w-5 h-5 text-amber-700" />
              <CardTitle className="text-amber-900 text-base sm:text-lg">
                Clients with invalid product values
              </CardTitle>
              <span
                className="text-xs sm:text-sm text-amber-800"
                data-testid="text-invalid-products-count"
              >
                {invalidProducts.offenders.length} client
                {invalidProducts.offenders.length === 1 ? "" : "s"} need cleanup
              </span>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-amber-900 mb-3">
                These clients have stored product values that no longer pass
                validation. Open each client and re-save with a valid product
                selection to clear the bad values.
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-amber-900 border-b border-amber-200">
                      <th className="py-2 pr-4 font-medium">Client</th>
                      <th className="py-2 pr-4 font-medium">Stored products</th>
                      <th className="py-2 pr-4 font-medium">Invalid values</th>
                      <th className="py-2 pr-4 font-medium"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {invalidProducts.offenders.map((o) => {
                      return (
                        <tr
                          key={o.id}
                          className="border-b border-amber-100 last:border-0"
                          data-testid={`row-invalid-product-${o.id}`}
                        >
                          <td className="py-2 pr-4 align-top">
                            <div
                              className="font-medium text-foreground"
                              data-testid={`text-invalid-firm-${o.id}`}
                            >
                              {o.firmName}
                              {o.isArchived && (
                                <span className="ml-2 text-xs font-normal text-amber-700 bg-amber-100 border border-amber-300 rounded px-1.5 py-0.5">
                                  archived
                                </span>
                              )}
                            </div>
                            {o.clientCode && (
                              <div className="text-xs text-muted-foreground">
                                {o.clientCode}
                              </div>
                            )}
                          </td>
                          <td
                            className="py-2 pr-4 align-top text-amber-900"
                            data-testid={`text-stored-products-${o.id}`}
                          >
                            {o.storedProducts.length > 0
                              ? o.storedProducts.join(", ")
                              : "—"}
                          </td>
                          <td
                            className="py-2 pr-4 align-top text-red-700 font-mono text-xs"
                            data-testid={`text-invalid-values-${o.id}`}
                          >
                            {o.invalidValues.join(", ")}
                          </td>
                          <td className="py-2 pr-4 align-top">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => openEditForOffender(o.id)}
                              data-testid={`button-edit-invalid-products-${o.id}`}
                            >
                              <Pencil className="w-3 h-3 mr-1" />
                              Edit products
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        )}

        <Card className="bg-card border-primary/10">
          <CardHeader className="flex flex-row items-center justify-between flex-wrap gap-2">
            <CardTitle className="text-foreground">All Clients</CardTitle>
            <div className="flex items-center gap-4 flex-wrap min-w-0">
              <HideDemoToggle
                surface="clients"
                checked={hideDemo}
                onCheckedChange={setHideDemo}
                hiddenCount={hiddenDemoCount}
              />
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={showArchived}
                  onChange={(e) => setShowArchived(e.target.checked)}
                  className="w-4 h-4 text-primary border-border rounded focus:ring-primary"
                  data-testid="checkbox-show-archived"
                />
                Show Archived
              </label>
              <Button
                variant="outline"
                onClick={() => {
                  // Task #4990 — full client-list CSV download (all client-record
                  // fields, archived included; rows match this list's role scoping).
                  logActivity("export", "Exported client list CSV");
                  window.location.href = "/api/clients/export.csv";
                }}
                data-testid="button-export-clients-csv"
              >
                <Download className="w-4 h-4 mr-2" />
                Export CSV
              </Button>
              <Dialog open={isOpen} onOpenChange={(open) => {
                setIsOpen(open);
                if (!open) {
                  setEditingClient(null);
                  resetForm();
                }
              }}>
                <DialogTrigger asChild>
                  <Button className="bg-primary hover:bg-primary/90" data-testid="button-add-client">
                    <Plus className="w-4 h-4 mr-2" />
                    Add Client
                  </Button>
                </DialogTrigger>
              <DialogContent className="max-h-[90vh] overflow-y-auto">
                <DialogHeader>
                  <DialogTitle>{editingClient ? "Edit Client" : "Add New Client"}</DialogTitle>
                </DialogHeader>
                <form onSubmit={handleSubmit} className="space-y-4">
                  <div>
                    <Label htmlFor="firmName">Firm Name *</Label>
                    <Input
                      id="firmName"
                      value={formData.firmName}
                      onChange={e => setFormData(prev => ({ ...prev, firmName: e.target.value }))}
                      required
                      data-testid="input-firm-name"
                    />
                  </div>
                  <div>
                    <Label htmlFor="contactName">Contact Name</Label>
                    <Input
                      id="contactName"
                      value={formData.contactName}
                      onChange={e => setFormData(prev => ({ ...prev, contactName: e.target.value }))}
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
                      data-testid="input-contact-email"
                    />
                  </div>
                  <div>
                    <Label htmlFor="contactPhone">Contact Phone</Label>
                    <Input
                      id="contactPhone"
                      value={formData.contactPhone}
                      onChange={e => setFormData(prev => ({ ...prev, contactPhone: e.target.value }))}
                      data-testid="input-contact-phone"
                    />
                  </div>
                  <div>
                    <Label htmlFor="clientStartDate">Client Start Date</Label>
                    <Input
                      id="clientStartDate"
                      type="date"
                      value={formData.clientStartDate}
                      onChange={e => setFormData(prev => ({ ...prev, clientStartDate: e.target.value }))}
                      data-testid="input-client-start-date"
                    />
                    <p className="text-xs text-muted-foreground mt-1">When did this client relationship begin?</p>
                  </div>
                  <div>
                    <Label htmlFor="consultType">Consult Type</Label>
                    <Select value={formData.consultType} onValueChange={v => setFormData(prev => ({ ...prev, consultType: v }))}>
                      <SelectTrigger data-testid="select-consult-type">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="free">Free</SelectItem>
                        <SelectItem value="paid">Paid</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label>Practice Areas</Label>
                    <div className="grid grid-cols-2 gap-2 mt-2 p-3 bg-surface-warm-1 rounded-md max-h-48 overflow-y-auto">
                      {PRACTICE_AREA_OPTIONS.map(area => (
                        <label 
                          key={area} 
                          className="flex items-center gap-2 text-sm cursor-pointer hover:bg-muted/60 p-1 rounded"
                        >
                          <input
                            type="checkbox"
                            checked={formData.practiceAreas.includes(area)}
                            onChange={(e) => {
                              if (e.target.checked) {
                                setFormData(prev => ({ ...prev, practiceAreas: [...prev.practiceAreas, area] }));
                              } else {
                                setFormData(prev => ({ ...prev, practiceAreas: prev.practiceAreas.filter(a => a !== area) }));
                              }
                            }}
                            className="w-4 h-4 text-primary border-border rounded focus:ring-primary"
                            data-testid={`checkbox-practice-area-${area.toLowerCase().replace(/\s+/g, '-')}`}
                          />
                          <span>{area}</span>
                        </label>
                      ))}
                    </div>
                    {formData.practiceAreas.length > 0 && (
                      <p className="text-xs text-muted-foreground mt-1">
                        Selected: {formData.practiceAreas.join(", ")}
                      </p>
                    )}
                  </div>
                  <div>
                    <Label>Products Purchased *</Label>
                    <p className="text-xs text-muted-foreground mb-2">Which services this client has purchased</p>
                    {editingInvalidProducts.length > 0 && (
                      <div
                        className="mb-2 p-2 rounded-md border border-amber-300 bg-amber-50 text-xs text-amber-900"
                        data-testid="text-invalid-products-warning"
                      >
                        <span className="font-medium">Heads up:</span> this client had{" "}
                        {editingInvalidProducts.length} invalid stored product
                        value{editingInvalidProducts.length === 1 ? "" : "s"} (
                        <span className="font-mono">
                          {editingInvalidProducts.join(", ")}
                        </span>
                        ) that have been removed from the selection below. Save
                        to clear them from the database.
                      </div>
                    )}
                    <div className="space-y-2 p-3 bg-surface-warm-1 rounded-md">
                      {CLIENT_PRODUCT_OPTIONS.map(product => (
                        <div key={product.value} className="flex items-start gap-3">
                          <Checkbox
                            id={`product-${product.value}`}
                            checked={formData.products.includes(product.value)}
                            onCheckedChange={(checked) => {
                              setFormData(prev => ({
                                ...prev,
                                products: checked
                                  ? Array.from(new Set([...prev.products, product.value]))
                                  : prev.products.filter(p => p !== product.value),
                              }));
                            }}
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
                        {editingClient
                          ? "Please select at least one product before saving the client."
                          : "Please select at least one product before creating the client."}
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
                  <div>
                    <Label htmlFor="ownerId">Account Manager</Label>
                    <Select 
                      value={formData.ownerId || "_unassigned"} 
                      onValueChange={v => setFormData(prev => ({ ...prev, ownerId: v === "_unassigned" ? "" : v }))}
                    >
                      <SelectTrigger data-testid="select-owner">
                        <SelectValue placeholder="Select account manager" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="_unassigned">Unassigned</SelectItem>
                        {allUsers.map(u => (
                          <SelectItem key={u.id} value={u.id}>
                            {u.firstName ? `${u.firstName}${u.lastName ? ` ${u.lastName}` : ''}` : u.email || u.id}
                            {u.role && ` (${u.role === 'ceo' ? 'CEO' : u.role === 'team_lead' ? 'Team Lead' : 'Account Manager'})`}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Baseline Lifetime Value - Historical data before tracking */}
                  <div className="space-y-3 pt-2 border-t">
                    <Label className="text-sm font-medium">Lifetime Value Baseline</Label>
                    <p className="text-xs text-muted-foreground">Historical metrics from before we started tracking in this system</p>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      <div className="space-y-1">
                        <Label htmlFor="initialLeads" className="text-xs">Initial Leads</Label>
                        <Input
                          id="initialLeads"
                          type="number"
                          min="0"
                          value={formData.initialLeads}
                          onChange={e => setFormData(prev => ({ ...prev, initialLeads: parseInt(e.target.value) || 0 }))}
                          placeholder="0"
                          data-testid="input-initial-leads"
                        />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor="initialReviews" className="text-xs">Initial Reviews</Label>
                        <Input
                          id="initialReviews"
                          type="number"
                          min="0"
                          value={formData.initialReviews}
                          onChange={e => setFormData(prev => ({ ...prev, initialReviews: parseInt(e.target.value) || 0 }))}
                          placeholder="0"
                          data-testid="input-initial-reviews"
                        />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor="initialCases" className="text-xs">Initial Cases</Label>
                        <Input
                          id="initialCases"
                          type="number"
                          min="0"
                          value={formData.initialCases}
                          onChange={e => setFormData(prev => ({ ...prev, initialCases: parseInt(e.target.value) || 0 }))}
                          placeholder="0"
                          data-testid="input-initial-cases"
                        />
                      </div>
                    </div>
                  </div>
                  
                  {/* Data Access */}
                  <div className="space-y-3 pt-2 border-t">
                      <Label>Data Access</Label>
                      <p className="text-xs text-muted-foreground">What data does this client provide access to?</p>
                      <div className="space-y-2">
                        {DATA_ACCESS_CATEGORIES.map(cat => (
                          <div key={cat.id} className="flex items-center justify-between gap-3 p-2 bg-surface-warm-1 rounded">
                            <div className="flex-1">
                              <p className="text-xs font-medium">{cat.label}</p>
                            </div>
                            <Select 
                              value={dataAccess[cat.id]} 
                              onValueChange={v => setDataAccess(prev => ({ ...prev, [cat.id]: v as any }))}
                            >
                              <SelectTrigger className="w-32 h-7 text-xs shrink-0" data-testid={`select-access-${cat.id}`}>
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="available">
                                  <span className="flex items-center gap-1">
                                    <span className="w-2 h-2 rounded-full bg-green-500" />
                                    Available
                                  </span>
                                </SelectItem>
                                <SelectItem value="pending">
                                  <span className="flex items-center gap-1">
                                    <span className="w-2 h-2 rounded-full bg-yellow-500" />
                                    Pending
                                  </span>
                                </SelectItem>
                                <SelectItem value="refused">
                                  <span className="flex items-center gap-1">
                                    <span className="w-2 h-2 rounded-full bg-red-500" />
                                    Refused
                                  </span>
                                </SelectItem>
                                <SelectItem value="unknown">
                                  <span className="flex items-center gap-1">
                                    <span className="w-2 h-2 rounded-full bg-gray-400" />
                                    Unknown
                                  </span>
                                </SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                        ))}
                      </div>
                  </div>
                  
                  {/* GBP Locations */}
                  <div className="space-y-3 pt-2 border-t">
                    <Label>GBP Locations {!editingClient && "(Optional)"}</Label>
                    <p className="text-xs text-muted-foreground">
                      {editingClient 
                        ? "Add new locations for this client" 
                        : "Add Google Business Profile locations for this client"}
                    </p>
                      
                    {editingClient ? (
                      <div className="space-y-2">
                        <Input
                          placeholder="Location name (e.g., Downtown Office)"
                          value={newDraftLocation}
                          onChange={(e) => setNewDraftLocation(e.target.value)}
                          data-testid="input-draft-location"
                        />
                        <Input
                          placeholder="Street address (e.g., 123 Main St, Dallas, TX 75201)"
                          value={newDraftLocationAddress}
                          onChange={(e) => setNewDraftLocationAddress(e.target.value)}
                          data-testid="input-draft-location-address"
                        />
                        <p className="text-xs text-muted-foreground">
                          A full street address (street, city, state, ZIP) is required — it's geocoded for MCU capacity analysis.
                        </p>
                        <Button
                          type="button"
                          onClick={() => {
                            if (newDraftLocation.trim() && newDraftLocationAddress.trim().length >= 10) {
                              createLocationMutation.mutate({
                                clientId: editingClient.id,
                                name: newDraftLocation.trim(),
                                address: newDraftLocationAddress.trim(),
                              });
                            }
                          }}
                          disabled={!newDraftLocation.trim() || newDraftLocationAddress.trim().length < 10 || createLocationMutation.isPending}
                          variant="outline"
                          className="w-full"
                          data-testid="button-add-draft-location"
                        >
                          <Plus className="w-4 h-4 mr-1" /> Add Location
                        </Button>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        <Input
                          placeholder="Location name (e.g., Downtown Office)"
                          value={newDraftLocation}
                          onChange={(e) => setNewDraftLocation(e.target.value)}
                          data-testid="input-draft-location"
                        />
                        <Input
                          placeholder="Street address (e.g., 123 Main St, Dallas, TX 75201)"
                          value={newDraftLocationAddress}
                          onChange={(e) => setNewDraftLocationAddress(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              addDraftLocation();
                            }
                          }}
                          data-testid="input-draft-location-address"
                        />
                        <p className="text-xs text-muted-foreground">
                          A full street address (street, city, state, ZIP) is required — it's geocoded for MCU capacity analysis.
                        </p>
                        <Button
                          type="button"
                          onClick={() => addDraftLocation()}
                          disabled={!newDraftLocation.trim() || newDraftLocationAddress.trim().length < 10}
                          variant="outline"
                          className="w-full"
                          data-testid="button-add-draft-location"
                        >
                          <Plus className="w-4 h-4 mr-1" /> Add Location
                        </Button>
                      </div>
                    )}
                      
                    {/* Show existing locations when editing */}
                    {editingClient && editingClientLocations && editingClientLocations.length > 0 && (
                      <div className="space-y-2">
                        <p className="text-xs text-muted-foreground font-medium">Current Locations:</p>
                        {editingClientLocations.map((loc) => {
                          const isUngeocoded = loc.lat == null || loc.lng == null;
                          return (
                          <div 
                            key={loc.id} 
                            className={`flex items-center justify-between p-2 rounded ${isUngeocoded ? "bg-amber-50 border border-amber-300" : "bg-surface-warm-1"}`}
                            data-testid={`existing-location-${loc.id}`}
                          >
                            <div className="flex items-center gap-2">
                              <MapPin className={`w-4 h-4 ${isUngeocoded ? "text-amber-600" : "text-primary"}`} />
                              <div className="flex flex-col">
                                <span className="text-sm">{loc.name}</span>
                                {isUngeocoded && (
                                  <span className="text-xs text-amber-800 flex items-center gap-1" data-testid={`warning-ungeocoded-edit-${loc.id}`}>
                                    <AlertTriangle className="w-3 h-3" />
                                    No coordinates — open Locations to re-enter address
                                  </span>
                                )}
                              </div>
                            </div>
                            <ConfirmActionDialog
                              title={`Remove location "${loc.name}"?`}
                              description="The location is deleted from this client immediately. Rankings, heatmaps, and reports scoped to it stop updating. This cannot be undone."
                              confirmLabel="Remove location"
                              testId={`dialog-confirm-remove-location-${loc.id}`}
                              onConfirm={() => {
                                deleteLocationMutation.mutate({ clientId: editingClient.id, locationId: loc.id });
                              }}
                              trigger={
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  aria-label={`Remove location ${loc.name}`}
                                  className="text-red-600 hover:text-red-700 h-6 w-6 p-0"
                                >
                                  <X className="w-4 h-4" />
                                </Button>
                              }
                            />
                          </div>
                          );
                        })}
                      </div>
                    )}

                    {/* Show draft locations when creating */}
                    {!editingClient && draftLocations.length > 0 && (
                      <div className="space-y-2">
                        {draftLocations.map((loc, index) => (
                          <div 
                            key={index} 
                            className="flex items-center justify-between p-2 bg-surface-warm-1 rounded"
                            data-testid={`draft-location-${index}`}
                          >
                            <div className="flex items-center gap-2">
                              <MapPin className="w-4 h-4 text-primary shrink-0" />
                              <div className="flex flex-col">
                                <span className="text-sm">{loc.name}</span>
                                <span className="text-xs text-muted-foreground">{loc.address}</span>
                              </div>
                            </div>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => removeDraftLocation(index)}
                              aria-label={`Remove location ${loc.name}`}
                              className="text-red-600 hover:text-red-700 h-6 w-6 p-0"
                            >
                              <X className="w-4 h-4" />
                            </Button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  
                  <Button
                    type="submit"
                    className="w-full bg-primary hover:bg-primary/90"
                    disabled={formData.products.length === 0}
                    data-testid="button-submit-client"
                  >
                    {editingClient ? "Update Client" : "Create Client"}
                  </Button>
                </form>
              </DialogContent>
            </Dialog>
            </div>
          </CardHeader>
          <CardContent>
            {(() => {
              const zeroProductClients = (clients || []).filter(
                c => !c.isArchived && (!c.products || c.products.length === 0)
              );
              if (zeroProductClients.length === 0) return null;
              return (
                <div
                  className="mb-4 p-3 border border-amber-300 bg-amber-50 rounded-md"
                  data-testid="banner-zero-product-clients"
                >
                  <p className="text-sm font-medium text-amber-900">
                    {zeroProductClients.length} client{zeroProductClients.length === 1 ? "" : "s"} {zeroProductClients.length === 1 ? "has" : "have"} no products selected. This breaks reporting and the command panel — please edit each one and pick at least one product.
                  </p>
                  <ul className="mt-2 space-y-1">
                    {zeroProductClients.map(c => (
                      <li
                        key={c.id}
                        className="flex items-center justify-between gap-2 text-sm text-amber-900"
                        data-testid={`row-zero-product-client-${c.id}`}
                      >
                        <span className="truncate" data-testid={`text-zero-product-firm-${c.id}`}>
                          {c.firmName}
                        </span>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleEdit(c)}
                          data-testid={`button-fix-zero-product-${c.id}`}
                        >
                          <Pencil className="w-3 h-3 mr-1" />
                          Fix
                        </Button>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })()}
            {ungeocoded && ungeocoded.totalClients > 0 && (
              <div
                className="mb-4 p-3 border border-amber-300 bg-amber-50 rounded-md"
                data-testid="banner-ungeocoded-locations"
              >
                <p className="text-sm font-medium text-amber-900">
                  {ungeocoded.totalClients} client{ungeocoded.totalClients === 1 ? "" : "s"} {ungeocoded.totalClients === 1 ? "has" : "have"} {ungeocoded.totalLocations} saved location{ungeocoded.totalLocations === 1 ? "" : "s"} with no map coordinates. These are excluded from MCU capacity analysis — open Locations and re-enter the address to fix.
                </p>
                <ul className="mt-2 space-y-1">
                  {ungeocoded.clients.map(uc => (
                    <li
                      key={uc.clientId}
                      className="flex items-center justify-between gap-2 text-sm text-amber-900"
                      data-testid={`row-ungeocoded-client-${uc.clientId}`}
                    >
                      <span className="truncate" data-testid={`text-ungeocoded-firm-${uc.clientId}`}>
                        {uc.firmName} ({uc.locations.length} location{uc.locations.length === 1 ? "" : "s"})
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          const c = (clients || []).find(cl => cl.id === uc.clientId);
                          if (c) setLocationsDialogClient(c);
                        }}
                        data-testid={`button-fix-ungeocoded-${uc.clientId}`}
                      >
                        <MapPin className="w-3 h-3 mr-1" />
                        Fix
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {!clients?.length ? (
              <p className="text-foreground">No clients yet.</p>
            ) : !visibleClients.length ? (
              <p className="text-foreground" data-testid="text-all-demo-hidden">
                All {clients.length} clients are demo accounts — hidden by the demo filter.
              </p>
            ) : (
              <ClientListWithHistory
                clients={visibleClients}
                users={users}
                onLocations={(c) => setLocationsDialogClient(c)}
                onEdit={handleEdit}
                onArchive={(id, isArchived) => archiveMutation.mutate({ id, isArchived: !isArchived })}
                onDelete={(id) => setPendingDeleteClient(visibleClients.find((c) => c.id === id) ?? null)}
                archivePending={archiveMutation.isPending}
              />
            )}
          </CardContent>
        </Card>
      </main>

      <ConfirmActionDialog
        open={!!pendingDeleteClient}
        onOpenChange={(open) => { if (!open) setPendingDeleteClient(null); }}
        title={`Delete client "${pendingDeleteClient?.firmName ?? ""}"?`}
        description="This permanently deletes the client and its locations. Rankings, heatmaps, and reports for this client stop updating, and history is no longer reachable from the admin panel. This cannot be undone — consider Archive instead if you only want it out of the way."
        confirmLabel="Delete client"
        testId="dialog-confirm-delete-client"
        onConfirm={() => {
          if (pendingDeleteClient) deleteMutation.mutate(pendingDeleteClient.id);
          setPendingDeleteClient(null);
        }}
      />

      {/* Locations Dialog */}
      <Dialog open={!!locationsDialogClient} onOpenChange={(open) => {
        if (!open) {
          setLocationsDialogClient(null);
          setNewLocationName("");
          setNewLocationAddress("");
        }
      }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              GBP Locations - {locationsDialogClient?.firmName}
            </DialogTitle>
          </DialogHeader>
          
          <div className="space-y-4">
            {/* Add new location */}
            <div className="space-y-2">
              <Input
                placeholder="Location name (e.g., Downtown Office)"
                value={newLocationName}
                onChange={(e) => setNewLocationName(e.target.value)}
                data-testid="input-new-location"
              />
              <Input
                placeholder="Street address (e.g., 123 Main St, Dallas, TX 75201)"
                value={newLocationAddress}
                onChange={(e) => setNewLocationAddress(e.target.value)}
                data-testid="input-new-location-address"
              />
              <p className="text-xs text-muted-foreground">
                A full street address (street, city, state, ZIP) is required — it's geocoded for MCU capacity analysis.
              </p>
              <Button
                onClick={() => {
                  if (newLocationName.trim() && newLocationAddress.trim().length >= 10 && locationsDialogClient) {
                    createLocationMutation.mutate({ 
                      clientId: locationsDialogClient.id, 
                      name: newLocationName.trim(),
                      address: newLocationAddress.trim(),
                    });
                  }
                }}
                disabled={!newLocationName.trim() || newLocationAddress.trim().length < 10 || createLocationMutation.isPending}
                className="w-full bg-primary hover:bg-primary/90"
                data-testid="button-add-location"
              >
                <Plus className="w-4 h-4 mr-1" /> Add Location
              </Button>
            </div>

            {/* Locations list */}
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {locationsLoading ? (
                <InlineLoadingSkeleton lines={3} />
              ) : !locations?.length ? (
                <p className="text-sm text-muted-foreground">No locations yet. Add your first GBP location above.</p>
              ) : (
                locations.map(loc => {
                  const isUngeocoded = loc.lat == null || loc.lng == null;
                  const isEditing = reGeocodeLocationId === loc.id;
                  return (
                  <div 
                    key={loc.id} 
                    className={`p-3 rounded-lg ${isUngeocoded ? "bg-amber-50 border border-amber-300" : "bg-surface-warm-1"}`}
                    data-testid={`row-location-${loc.id}`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <MapPin className={`w-4 h-4 ${isUngeocoded ? "text-amber-600" : "text-primary"}`} />
                        <span className="text-sm font-medium text-foreground">{loc.name}</span>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          if (locationsDialogClient) {
                            deleteLocationMutation.mutate({ 
                              clientId: locationsDialogClient.id, 
                              locationId: loc.id 
                            });
                          }
                        }}
                        className="text-red-600 hover:text-red-700 hover:bg-red-50"
                        aria-label={`Remove location ${loc.name}`}
                        data-testid={`button-delete-location-${loc.id}`}
                      >
                        <X className="w-4 h-4" />
                      </Button>
                    </div>
                    {isUngeocoded && (
                      <div className="mt-2 pl-6" data-testid={`warning-ungeocoded-${loc.id}`}>
                        <div className="flex items-start gap-1.5 text-xs text-amber-800">
                          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                          <span>
                            This location has no map coordinates, so it's excluded from MCU capacity analysis. Re-enter its full address to fix it.
                          </span>
                        </div>
                        {isEditing ? (
                          <div className="mt-2 space-y-2">
                            <Input
                              placeholder="123 Main St, Dallas, TX 75201"
                              value={reGeocodeAddress}
                              onChange={(e) => setReGeocodeAddress(e.target.value)}
                              data-testid={`input-regeocode-${loc.id}`}
                            />
                            <div className="flex gap-2">
                              <Button
                                size="sm"
                                onClick={() => {
                                  if (locationsDialogClient && reGeocodeAddress.trim().length >= 10) {
                                    updateLocationAddressMutation.mutate({
                                      clientId: locationsDialogClient.id,
                                      locationId: loc.id,
                                      address: reGeocodeAddress.trim(),
                                    });
                                  }
                                }}
                                disabled={reGeocodeAddress.trim().length < 10 || updateLocationAddressMutation.isPending}
                                className="bg-primary hover:bg-primary/90"
                                data-testid={`button-save-regeocode-${loc.id}`}
                              >
                                Save & re-geocode
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => {
                                  setReGeocodeLocationId(null);
                                  setReGeocodeAddress("");
                                }}
                                data-testid={`button-cancel-regeocode-${loc.id}`}
                              >
                                Cancel
                              </Button>
                            </div>
                          </div>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setReGeocodeLocationId(loc.id);
                              setReGeocodeAddress(loc.address ?? "");
                            }}
                            className="mt-2 h-7 text-xs border-amber-400 text-amber-800 hover:bg-amber-100"
                            data-testid={`button-regeocode-${loc.id}`}
                          >
                            Re-enter address
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                  );
                })
              )}
            </div>

            <p className="text-xs text-muted-foreground">
              These locations will appear in monthly report forms for data entry.
            </p>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ClientListWithHistory({
  clients,
  users,
  onLocations,
  onEdit,
  onArchive,
  onDelete,
  archivePending,
}: {
  clients: Client[];
  users: User[] | undefined;
  onLocations: (c: Client) => void;
  onEdit: (c: Client) => void;
  onArchive: (id: string, isArchived: boolean) => void;
  onDelete: (id: string) => void;
  archivePending: boolean;
}) {
  const ids = clients.map((c) => c.id);
  const { data: clientHistory } = useAuditHistory("client", ids);
  // Task #4038: flag clients whose command panel has a product selected but
  // the matching budget NULL (lsa/google_ads/webinar), so operators can work
  // down all gaps from the list without opening each panel.
  const { data: panelSummaries } = useQuery<{ clientId: string; missingBudgets: string[] }[]>({
    queryKey: ["/api/command-panel-summaries"],
    queryFn: async () => {
      const res = await fetch("/api/command-panel-summaries", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch command panel summaries");
      return res.json();
    },
  });
  const missingBudgetsByClient = new Map(
    (panelSummaries || [])
      .filter((s) => (s.missingBudgets?.length ?? 0) > 0)
      .map((s) => [s.clientId, s.missingBudgets]),
  );
  const MISSING_BUDGET_LABELS: Record<string, string> = {
    lsa: "LSA",
    google_ads: "Google Ads",
    webinar: "Webinars",
  };
  // For products, the backend filters by metadata.clientId and buckets
  // returned events under `${clientId}:${product}`. We therefore send
  // just the client IDs that actually carry products.
  const { data: productHistory } = useAuditHistory(
    "product",
    clients.filter((c) => (c.products?.length ?? 0) > 0).map((c) => c.id),
  );
  return (
    <div className="space-y-3">
      {clients.map((client) => {
        const owner = users?.find((u) => u.id === client.ownerId);
        const events = clientHistory?.[client.id];
        return (
          <div
            key={client.id}
            className="flex flex-col sm:flex-row sm:items-center justify-between p-3 sm:p-4 bg-surface-warm-1 rounded-lg gap-3"
            data-testid={`row-client-${client.id}`}
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <p className="font-medium text-foreground truncate">{client.firmName}</p>
                {client.isArchived && (
                  <span className="px-2 py-0.5 bg-amber-100 text-amber-800 text-xs font-medium rounded">
                    Archived
                  </span>
                )}
                {!client.isArchived && client.offboarding && (
                  <span
                    className="px-2 py-0.5 bg-orange-100 text-orange-800 text-xs font-medium rounded whitespace-nowrap"
                    data-testid={`badge-offboarding-${client.id}`}
                  >
                    Offboarding — final day {formatFinalServiceDay(client.offboarding.finalServiceDate)}
                  </span>
                )}
                <AuditHistoryPopover entity="client" targetId={client.id} events={events} />
                {missingBudgetsByClient.has(client.id) && (
                  <Link
                    href={`/clients/${client.id}?tab=command-panel&highlight=productTypes`}
                    className="inline-flex items-center gap-1 px-2 py-0.5 bg-red-100 text-red-800 text-xs font-medium rounded whitespace-nowrap hover:bg-red-200"
                    title="Product selected but no budget entered — click to open Products & Budget"
                    data-testid={`badge-missing-budget-${client.id}`}
                  >
                    <AlertTriangle className="w-3 h-3" />
                    Budget missing: {missingBudgetsByClient.get(client.id)!.map((p) => MISSING_BUDGET_LABELS[p] || p).join(", ")}
                  </Link>
                )}
              </div>
              <p className="text-sm text-muted-foreground truncate">
                {client.contactName && <span>{client.contactName} • </span>}
                {client.contactEmail}
              </p>
              <p className="text-xs text-muted-foreground/70">
                Owner: {owner ? (owner.firstName || owner.email) : "Unassigned"}
              </p>
              {client.products && client.products.length > 0 && (
                <div className="flex items-center gap-1 mt-1 flex-wrap">
                  {client.products.map((product) => {
                    const key = `${client.id}:${product}`;
                    const prodEvents = productHistory?.[key];
                    return (
                      <span
                        key={product}
                        className="inline-flex items-center gap-1 px-2 py-0.5 bg-card text-primary dark:text-foreground text-xs rounded border border-primary/20"
                      >
                        {product}
                        <AuditHistoryPopover
                          entity="product"
                          targetId={key}
                          testIdSuffix={`${client.id}-${product}`}
                          events={prodEvents}
                          title={`${product} history`}
                          size="xs"
                        />
                      </span>
                    );
                  })}
                </div>
              )}
              {client.practiceAreas && client.practiceAreas.length > 0 && (
                <p className="text-xs text-foreground mt-1 truncate">
                  {client.practiceAreas.join(" • ")}
                </p>
              )}
            </div>
            <div className="flex gap-2 shrink-0">
              <Button
                asChild
                variant="outline"
                size="sm"
                aria-label={`View ${client.firmName}`}
                data-testid={`button-view-client-${client.id}`}
              >
                <Link href={`/clients/${client.id}`}>
                  <Eye className="w-4 h-4 sm:mr-1" />
                  <span className="hidden sm:inline">View</span>
                </Link>
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => onLocations(client)}
                aria-label={`Manage locations for ${client.firmName}`}
                data-testid={`button-locations-client-${client.id}`}
                className="text-xs sm:text-sm"
              >
                <MapPin className="w-4 h-4 sm:mr-1" />
                <span className="hidden sm:inline">Locations</span>
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => onEdit(client)}
                aria-label={`Edit ${client.firmName}`}
                data-testid={`button-edit-client-${client.id}`}
              >
                <Pencil className="w-4 h-4" />
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => onArchive(client.id, client.isArchived ?? false)}
                disabled={archivePending}
                aria-label={`${client.isArchived ? "Restore" : "Archive"} ${client.firmName}`}
                data-testid={`button-archive-client-${client.id}`}
              >
                {client.isArchived ? (
                  <ArchiveRestore className="w-4 h-4" />
                ) : (
                  <Archive className="w-4 h-4" />
                )}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="text-red-600 hover:text-red-700"
                onClick={() => onDelete(client.id)}
                aria-label={`Delete ${client.firmName}`}
                data-testid={`button-delete-client-${client.id}`}
              >
                <Trash2 className="w-4 h-4" />
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
