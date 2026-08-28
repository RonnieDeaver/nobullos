// Task #5297 — stage 3 of the "New Client Onboarding" epic: the internal,
// signed-in-staff-only intake screen sales uses live on the call. Combines
// the minimum basic-info fields from ClientAdd.tsx, a required private
// notes field (persisted as an Intel entry), and a slot picker modeled on
// ClientSchedulingPanel's day-grid interaction style but reading the
// onboarding POOL's combined availability instead of one AM's calendar.
//
// Reachable from the app nav via QuicklinksBar's "Onboarding Call" entry
// (Task #5298, stage 4 of the epic) — no public/unauthenticated variant of
// this page exists; it's for signed-in staff only.
import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { apiRequest } from "@/lib/queryClient";
import { useDisplayTimezone } from "@/lib/displayTimezone";
import { useToast } from "@/hooks/use-toast";
import { useLocation, Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PageHeader } from "@/components/admin/PageHeader";
import { FormSkeleton } from "@/components/ui/skeleton-loaders";
import { CLIENT_PRODUCT_OPTIONS } from "@shared/productResolution";
import { Calendar, ChevronLeft, ChevronRight, Clock, CheckCircle2, AlertTriangle } from "lucide-react";

type Slot = { startUtc: string; endUtc: string; dateLocal: string; timeLocal: string };

type SlotsResponse = {
  durationMinutes: number;
  poolSize: number;
  slots: Slot[];
};

const RANGE_OPTIONS = [
  { label: "2 weeks", days: 14 },
  { label: "1 month", days: 30 },
];

interface IntakeErrorInfo {
  title: string;
  description: string;
  clientId?: string;
  clientCreated?: boolean;
}

function describeIntakeError(err: unknown): IntakeErrorInfo {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  const m = raw.match(/^\d+:\s*(.*)$/s);
  const body = m ? m[1] : raw;
  let parsed: any = null;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = null;
  }
  const code = parsed?.code as string | undefined;
  const message = typeof parsed?.error === "string" ? parsed.error : undefined;

  if (code === "onboarding_assignment_failed") {
    return {
      title: "Nobody on the onboarding roster is available",
      description:
        message ||
        "No one on the onboarding roster is free at that time. Pick a different slot.",
      clientId: parsed?.clientId,
      clientCreated: parsed?.clientCreated,
    };
  }
  if (code === "slot_taken" || code === "slot_unavailable") {
    return {
      title: "That time is no longer available",
      description: message || "The selected slot was just taken. Pick another time.",
      clientId: parsed?.clientId,
      clientCreated: parsed?.clientCreated,
    };
  }
  if (code === "INVALID_PRODUCTS") {
    return {
      title: "Unknown product selected",
      description: message || "One of the selected products isn't recognized.",
    };
  }
  if (code === "VENDOR_IDENTIFIER_REFUSED") {
    return {
      title: "That email/domain can't be used for a client",
      description: message || "That identifier looks like a vendor or receipt address, not a client contact.",
    };
  }
  if (parsed?.clientCreated) {
    return {
      title: "Client saved, but booking failed",
      description: message || "The client record was created, but the meeting could not be booked.",
      clientId: parsed?.clientId,
      clientCreated: true,
    };
  }
  return {
    title: "Could not complete onboarding intake",
    description: message || body || raw || "Please try again.",
  };
}

export default function OnboardingIntake() {
  const { user, isLoading: authLoading } = useAuth();
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const displayTimezone = useDisplayTimezone();
  const viewerTimezone = displayTimezone.timezone;

  const [formData, setFormData] = useState({
    firmName: "",
    contactName: "",
    contactEmail: "",
    contactPhone: "",
    consultType: "free",
    products: [] as string[],
    googleAdsBudget: "",
    lsaBudget: "",
    webinarBudget: "",
    gbpPlannedLocationCount: "",
    gbpPlannedLocationCities: [] as string[],
  });
  const [notes, setNotes] = useState("");
  const [selected, setSelected] = useState<Slot | null>(null);
  const [rangeDays, setRangeDays] = useState<number>(14);
  const [windowStartMs, setWindowStartMs] = useState<number>(() => Date.now());
  const [result, setResult] = useState<{
    resolvedUserName: string | null;
    startUtc: string;
  } | null>(null);
  const [failure, setFailure] = useState<IntakeErrorInfo | null>(null);

  const fromIso = useMemo(() => new Date(windowStartMs).toISOString(), [windowStartMs]);
  const toIso = useMemo(
    () => new Date(windowStartMs + rangeDays * 24 * 60 * 60 * 1000).toISOString(),
    [windowStartMs, rangeDays],
  );
  const windowLabel = useMemo(() => {
    const start = new Date(windowStartMs);
    const end = new Date(windowStartMs + rangeDays * 24 * 60 * 60 * 1000);
    const fmt = (d: Date) => d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    return `${fmt(start)} – ${fmt(end)}`;
  }, [windowStartMs, rangeDays]);
  const isAtToday = windowStartMs <= Date.now() + 60 * 1000;
  const shiftWindow = (deltaDays: number) => {
    setWindowStartMs((prev) => Math.max(prev + deltaDays * 24 * 60 * 60 * 1000, Date.now()));
  };

  const slotsQuery = useQuery<SlotsResponse>({
    queryKey: ["/api/onboarding/intake/slots", fromIso, toIso, viewerTimezone],
    queryFn: async () => {
      const params = new URLSearchParams({ from: fromIso, to: toIso, viewerTimezone });
      const res = await apiRequest("GET", `/api/onboarding/intake/slots?${params.toString()}`);
      return res.json();
    },
    enabled: !!user,
  });

  const slotsByDay = useMemo(() => {
    const slots = slotsQuery.data?.slots ?? [];
    const byDay = new Map<string, Slot[]>();
    for (const s of slots) {
      const arr = byDay.get(s.dateLocal) ?? [];
      arr.push(s);
      byDay.set(s.dateLocal, arr);
    }
    return Array.from(byDay.entries());
  }, [slotsQuery.data]);

  function toggleProduct(productId: string) {
    setFormData((prev) => {
      const current = prev.products;
      return current.includes(productId)
        ? { ...prev, products: current.filter((p) => p !== productId) }
        : { ...prev, products: [...current, productId] };
    });
  }

  const productErrors = useMemo(() => {
    const errors: Record<string, string> = {};
    const positiveBudget = (value: string, label: string) => {
      if (!value.trim()) return `${label} budget is required.`;
      const amount = Number(value);
      if (!Number.isFinite(amount) || amount <= 0) return `${label} budget must be greater than $0.`;
      return null;
    };
    if (formData.products.includes("google_ads")) {
      const error = positiveBudget(formData.googleAdsBudget, "Google Ads");
      if (error) errors.googleAdsBudget = error;
    }
    if (formData.products.includes("lsa")) {
      const error = positiveBudget(formData.lsaBudget, "LSA");
      if (error) errors.lsaBudget = error;
    }
    if (formData.products.includes("webinar")) {
      const error = positiveBudget(formData.webinarBudget, "Webinars");
      if (error) errors.webinarBudget = error;
    }
    if (formData.products.includes("gbp")) {
      const count = Number(formData.gbpPlannedLocationCount);
      if (!Number.isInteger(count) || count < 1 || count > 50) {
        errors.gbpPlannedLocationCount = "Enter a whole number from 1 to 50.";
      } else {
        const cities = formData.gbpPlannedLocationCities.slice(0, count);
        const missingIndex = cities.findIndex((city) => !city.trim());
        if (cities.length !== count || missingIndex >= 0) {
          errors.gbpPlannedLocationCities = `Enter a city for each of the ${count} planned ${count === 1 ? "location" : "locations"}.`;
        }
      }
    }
    return errors;
  }, [formData]);

  const submitMutation = useMutation({
    mutationFn: async () => {
      if (!selected) throw new Error("Pick a time slot first");
      const res = await apiRequest("POST", "/api/onboarding/intake", {
        firmName: formData.firmName,
        contactName: formData.contactName || undefined,
        contactEmail: formData.contactEmail,
        contactPhone: formData.contactPhone || undefined,
        consultType: formData.consultType,
        products: formData.products,
        googleAdsBudget: formData.products.includes("google_ads") ? Number(formData.googleAdsBudget) : undefined,
        lsaBudget: formData.products.includes("lsa") ? Number(formData.lsaBudget) : undefined,
        webinarBudget: formData.products.includes("webinar") ? Number(formData.webinarBudget) : undefined,
        gbpPlannedLocationCount: formData.products.includes("gbp")
          ? Number(formData.gbpPlannedLocationCount)
          : undefined,
        gbpPlannedLocationCities: formData.products.includes("gbp")
          ? formData.gbpPlannedLocationCities
              .slice(0, Number(formData.gbpPlannedLocationCount))
              .map((city) => city.trim())
          : undefined,
        notes,
        startTimeUtc: selected.startUtc,
      });
      return res.json();
    },
    onSuccess: (data: any) => {
      setFailure(null);
      setResult({ resolvedUserName: data?.resolvedUser?.name ?? null, startUtc: selected!.startUtc });
      if (data?.intelWarning) {
        toast({ title: "Notes not saved", description: data.intelWarning, variant: "destructive" });
      } else {
        toast({ title: "Client booked and notes logged" });
      }
    },
    onError: (err: Error) => {
      setFailure(describeIntakeError(err));
    },
  });

  const canSubmit =
    !!formData.firmName.trim() &&
    !!formData.contactEmail.trim() &&
    formData.products.length > 0 &&
    Object.keys(productErrors).length === 0 &&
    !!notes.trim() &&
    !!selected;

  if (authLoading) return <FormSkeleton />;

  if (!user) {
    return (
      <div className="min-h-[calc(100dvh-var(--nav-height))] bg-surface-warm-1 flex items-center justify-center">
        <div className="text-muted-foreground">Please sign in to continue.</div>
      </div>
    );
  }

  if (result) {
    return (
      <div className="min-h-[calc(100dvh-var(--nav-height))] bg-surface-warm-1">
        <div className="max-w-xl mx-auto px-3 pt-3 sm:px-6 sm:pt-6">
          <PageHeader title="Onboarding call" backHref="/" />
        </div>
        <main className="max-w-xl mx-auto p-3 sm:p-6">
          <Card className="bg-card border-primary/10" data-testid="card-intake-success">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-foreground">
                <CheckCircle2 className="w-5 h-5 text-emerald-600" /> Booked
              </CardTitle>
              <CardDescription>The client was created and the call is booked.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <p data-testid="text-confirmed-time">
                <span className="font-medium">Time:</span>{" "}
                {new Date(result.startUtc).toLocaleString(undefined, { timeZone: viewerTimezone })}
              </p>
              <p data-testid="text-confirmed-assignee">
                <span className="font-medium">Assigned to:</span>{" "}
                {result.resolvedUserName || "onboarding team"}
              </p>
              <Button className="mt-3" onClick={() => navigate("/")} data-testid="button-back-home">
                Done
              </Button>
            </CardContent>
          </Card>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-[calc(100dvh-var(--nav-height))] bg-surface-warm-1">
      <div className="max-w-xl mx-auto px-3 pt-3 sm:px-6 sm:pt-6">
        <PageHeader title="New Client Onboarding Call" backHref="/" />
      </div>

      <main className="max-w-xl mx-auto p-3 sm:p-6 space-y-4">
        {failure && (
          <div
            className="rounded border border-rose-300 dark:border-rose-800 bg-rose-50 dark:bg-rose-950/30 p-3 text-sm text-rose-900 dark:text-rose-300"
            data-testid="banner-intake-error"
          >
            <div className="font-medium flex items-center gap-1.5">
              <AlertTriangle className="w-4 h-4" /> {failure.title}
            </div>
            <p className="mt-1 text-xs">{failure.description}</p>
            {failure.clientCreated && failure.clientId && (
              <p className="mt-2 text-xs">
                The client was already saved.{" "}
                <Link
                  href={`/clients/${failure.clientId}`}
                  className="underline hover:text-rose-950 dark:hover:text-rose-100"
                  data-testid="link-intake-saved-client"
                >
                  Open the client
                </Link>{" "}
                to book the meeting or log notes manually.
              </p>
            )}
          </div>
        )}

        <Card className="bg-card border-primary/10">
          <CardHeader>
            <CardTitle className="text-foreground">Client info</CardTitle>
            <CardDescription>Captured live while you're on the call.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label htmlFor="firmName">Firm Name *</Label>
              <Input
                id="firmName"
                value={formData.firmName}
                onChange={(e) => setFormData((p) => ({ ...p, firmName: e.target.value }))}
                placeholder="e.g., Smith & Associates Law Firm"
                data-testid="input-firm-name"
              />
            </div>
            <div>
              <Label htmlFor="contactName">Contact Name</Label>
              <Input
                id="contactName"
                value={formData.contactName}
                onChange={(e) => setFormData((p) => ({ ...p, contactName: e.target.value }))}
                placeholder="Primary contact person"
                data-testid="input-contact-name"
              />
            </div>
            <div>
              <Label htmlFor="contactEmail">Contact Email *</Label>
              <Input
                id="contactEmail"
                type="email"
                value={formData.contactEmail}
                onChange={(e) => setFormData((p) => ({ ...p, contactEmail: e.target.value }))}
                placeholder="email@lawfirm.com"
                data-testid="input-contact-email"
              />
              <p className="text-xs text-muted-foreground/70 mt-1">
                Required — this is who the meeting invite goes to.
              </p>
            </div>
            <div>
              <Label htmlFor="contactPhone">Contact Phone</Label>
              <Input
                id="contactPhone"
                value={formData.contactPhone}
                onChange={(e) => setFormData((p) => ({ ...p, contactPhone: e.target.value }))}
                placeholder="(555) 123-4567"
                data-testid="input-contact-phone"
              />
            </div>
            <div>
              <Label htmlFor="consultType">Consultation Type</Label>
              <Select
                value={formData.consultType}
                onValueChange={(v) => setFormData((p) => ({ ...p, consultType: v }))}
              >
                <SelectTrigger data-testid="select-consult-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="free">Free Consultation</SelectItem>
                  <SelectItem value="paid">Paid Consultation</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="pt-2 border-t">
              <Label className="text-base font-semibold">Products *</Label>
              <p className="text-sm text-muted-foreground mb-3">Which services did the client purchase?</p>
              <div className="space-y-3">
                {CLIENT_PRODUCT_OPTIONS.map((product) => (
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
              {formData.products.includes("gbp") && (
                <div className="mt-4 space-y-3 rounded border border-emerald-200 bg-emerald-50/50 p-3" data-testid="section-gbp-planning">
                  <div>
                    <Label htmlFor="gbpPlannedLocationCount">Planned GBP locations *</Label>
                    <Input
                      id="gbpPlannedLocationCount"
                      type="number"
                      min={1}
                      max={50}
                      step={1}
                      value={formData.gbpPlannedLocationCount}
                      onChange={(e) =>
                        setFormData((prev) => ({ ...prev, gbpPlannedLocationCount: e.target.value }))
                      }
                      aria-invalid={!!productErrors.gbpPlannedLocationCount}
                      aria-describedby="gbp-location-count-error"
                      data-testid="input-gbp-planned-location-count"
                    />
                    {productErrors.gbpPlannedLocationCount && (
                      <p id="gbp-location-count-error" className="mt-1 text-xs text-destructive">
                        {productErrors.gbpPlannedLocationCount}
                      </p>
                    )}
                  </div>
                  {Number.isInteger(Number(formData.gbpPlannedLocationCount)) &&
                    Number(formData.gbpPlannedLocationCount) > 0 &&
                    Number(formData.gbpPlannedLocationCount) <= 50 && (
                      <div className="grid gap-3 sm:grid-cols-2">
                        {Array.from({ length: Number(formData.gbpPlannedLocationCount) }, (_, index) => (
                          <div key={index}>
                            <Label htmlFor={`gbpPlannedCity-${index}`}>Location {index + 1} city *</Label>
                            <Input
                              id={`gbpPlannedCity-${index}`}
                              value={formData.gbpPlannedLocationCities[index] ?? ""}
                              onChange={(e) =>
                                setFormData((prev) => {
                                  const cities = [...prev.gbpPlannedLocationCities];
                                  cities[index] = e.target.value;
                                  return { ...prev, gbpPlannedLocationCities: cities };
                                })
                              }
                              placeholder="e.g., Dallas"
                              aria-invalid={!!productErrors.gbpPlannedLocationCities}
                              data-testid={`input-gbp-planned-location-city-${index}`}
                            />
                          </div>
                        ))}
                      </div>
                    )}
                  {productErrors.gbpPlannedLocationCities && (
                    <p className="text-xs text-destructive" data-testid="error-gbp-planned-location-cities">
                      {productErrors.gbpPlannedLocationCities}
                    </p>
                  )}
                </div>
              )}
              {[
                ["google_ads", "googleAdsBudget", "Google Ads"],
                ["lsa", "lsaBudget", "LSA"],
                ["webinar", "webinarBudget", "Webinars"],
              ].map(([productId, field, label]) =>
                formData.products.includes(productId) ? (
                  <div key={productId} className="mt-3 rounded border bg-muted/20 p-3" data-testid={`section-${productId}-budget`}>
                    <Label htmlFor={field}>{label} budget *</Label>
                    <div className="relative mt-1">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
                      <Input
                        id={field}
                        type="number"
                        min="0.01"
                        step="0.01"
                        value={formData[field as "googleAdsBudget" | "lsaBudget" | "webinarBudget"]}
                        onChange={(e) =>
                          setFormData((prev) => ({ ...prev, [field]: e.target.value }))
                        }
                        className="pl-7"
                        aria-invalid={!!productErrors[field]}
                        aria-describedby={`${field}-error`}
                        data-testid={`input-onboarding-${field}`}
                      />
                    </div>
                    {productErrors[field] && (
                      <p id={`${field}-error`} className="mt-1 text-xs text-destructive">
                        {productErrors[field]}
                      </p>
                    )}
                  </div>
                ) : null,
              )}
            </div>
          </CardContent>
        </Card>

        <Card className="bg-card border-primary/10">
          <CardHeader>
            <CardTitle className="text-foreground">Notes for the team</CardTitle>
            <CardDescription>
              Private — never shown to the client. Saved to the client's Intel feed.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="What did the client say? Goals, budget, urgency, anything the team should know before the call…"
              rows={5}
              data-testid="textarea-onboarding-notes"
            />
          </CardContent>
        </Card>

        <Card className="bg-card border-primary/10" data-testid="card-onboarding-slots">
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2 text-foreground">
              <Calendar className="w-5 h-5" /> Book the call
            </CardTitle>
            <CardDescription>
              {slotsQuery.data?.poolSize != null
                ? `Combined availability across ${slotsQuery.data.poolSize} onboarding team member${slotsQuery.data.poolSize === 1 ? "" : "s"}.`
                : "Combined onboarding team availability."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
              <div className="text-sm font-medium flex items-center gap-2 flex-wrap">
                <Clock className="w-4 h-4" /> Available times
                <span className="text-xs text-muted-foreground font-normal" data-testid="text-slots-window-label">
                  ({windowLabel})
                </span>
                <span className="text-xs text-muted-foreground font-normal">
                  · Times in {viewerTimezone}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Select value={String(rangeDays)} onValueChange={(v) => setRangeDays(Number(v) || 14)}>
                  <SelectTrigger className="h-8 w-[110px]" data-testid="select-slots-range">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {RANGE_OPTIONS.map((opt) => (
                      <SelectItem key={opt.days} value={String(opt.days)} data-testid={`option-slots-range-${opt.days}`}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 px-2"
                  disabled={isAtToday}
                  onClick={() => shiftWindow(-rangeDays)}
                  data-testid="button-slots-earlier"
                >
                  <ChevronLeft className="w-4 h-4" />
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 px-2"
                  onClick={() => shiftWindow(rangeDays)}
                  data-testid="button-slots-later"
                >
                  <ChevronRight className="w-4 h-4" />
                </Button>
              </div>
            </div>

            {slotsQuery.isLoading ? (
              <div className="text-sm text-muted-foreground">Loading…</div>
            ) : slotsQuery.isError ? (
              <div className="text-sm text-destructive" data-testid="text-slots-error">
                Could not load onboarding availability. Please try again in a moment.
              </div>
            ) : slotsByDay.length === 0 ? (
              <div className="text-sm text-muted-foreground" data-testid="text-no-slots">
                No availability in this window — try a later date range.
              </div>
            ) : (
              <div className="space-y-3 max-h-[45vh] overflow-y-auto pr-2">
                {slotsByDay.map(([dateLocal, daySlots]) => (
                  <div key={dateLocal}>
                    <div className="text-xs font-medium mb-1">{dateLocal}</div>
                    <div className="flex flex-wrap gap-1">
                      {daySlots.map((s) => {
                        const isSel = selected?.startUtc === s.startUtc;
                        const t = new Date(s.startUtc).toLocaleTimeString(undefined, {
                          hour: "numeric",
                          minute: "2-digit",
                          timeZone: viewerTimezone,
                        });
                        return (
                          <Button
                            key={s.startUtc}
                            type="button"
                            size="sm"
                            variant={isSel ? "default" : "outline"}
                            onClick={() => setSelected(s)}
                            data-testid={`button-onboarding-slot-${s.startUtc}`}
                          >
                            {t}
                          </Button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Button
          type="button"
          className="w-full bg-primary hover:bg-primary/90"
          disabled={!canSubmit || submitMutation.isPending}
          onClick={() => submitMutation.mutate()}
          data-testid="button-submit-intake"
        >
          {submitMutation.isPending ? "Booking…" : "Create client & book call"}
        </Button>
        {!canSubmit && (
          <p className="text-xs text-muted-foreground text-center" data-testid="text-submit-requirements">
            Firm name, contact email, product setup details, notes for the team, and a time slot are all required.
          </p>
        )}
      </main>
    </div>
  );
}
