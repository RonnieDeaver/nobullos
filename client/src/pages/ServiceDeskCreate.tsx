import { useState, useRef, useMemo, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useSearch, useLocation } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  XCircle,
  Loader2,
  Upload,
  X,
  FileText,
  Search,
} from "lucide-react";
import { Link } from "wouter";
import { PageHeader } from "@/components/admin/PageHeader";
import { resolveRequestTypeDept } from "@shared/lib/serviceDeskDeptMatcher";
import {
  stripOptionPrefix,
  parseTypeName,
  groupTypesByCategory,
  type TypeGroup,
} from "@/lib/serviceDeskCategories";

// ─── Types ─────────────────────────────────────────────────────────────────────

interface SdListMapping {
  clickupListId?: string | null;
  setupStep?: string | null;
}

interface SdClientOption {
  optionId: string;
  label: string;
  clientId: string | null;
}

interface SdDepartment {
  id: string;
  name: string;
  active: boolean;
  sortOrder: number;
}

interface SdRequestType {
  id: string;
  name: string;
  description?: string | null;
  departmentId?: string | null;
  active: boolean;
}

interface SdQuestion {
  id: string;
  label: string;
  questionType: string;
  required: boolean;
  sortOrder: number;
  options?: string[] | null;
  helpText?: string | null;
  placeholder?: string | null;
  defaultValue?: string | null;
}

// Multi-select answers are stored as a single ", "-joined string so they fit
// the existing [{questionId, value}] answer format end to end.
const MULTI_SELECT_SEPARATOR = ", ";
function splitMultiValue(value: string): string[] {
  return value ? value.split(MULTI_SELECT_SEPARATOR).filter(Boolean) : [];
}

// ─── Guardrails ────────────────────────────────────────────────────────────────

function GuardrailsChrome() {
  return (
    <Card className="border-amber-200 bg-amber-50 dark:bg-amber-950/20" data-testid="card-guardrails">
      <CardContent className="pt-4 pb-3 space-y-3">
        <p className="text-sm font-semibold text-amber-800 dark:text-amber-300 flex items-center gap-2">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          Before you submit — please read
        </p>
        <p className="text-xs font-medium text-amber-900 dark:text-amber-200">
          Name the person directly responsible for this request. Every request must have a single, named owner.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="bg-green-50 dark:bg-green-950/20 border border-green-200 p-3">
            <p className="font-medium text-green-800 dark:text-green-300 flex items-center gap-1 mb-1 text-xs">
              <CheckCircle2 className="h-3.5 w-3.5" /> Good examples
            </p>
            <ul className="text-xs text-green-700 dark:text-green-400 space-y-0.5 list-disc list-inside">
              <li>"Update the Google Ads campaign for ACME Corp to pause Brand keywords"</li>
              <li>"GBP listing for Smith Law is missing hours — please correct"</li>
              <li>"Onboarding doc for Jones &amp; Partners needed by Friday"</li>
            </ul>
          </div>
          <div className="bg-red-50 dark:bg-red-950/20 border border-red-200 p-3">
            <p className="font-medium text-red-800 dark:text-red-300 flex items-center gap-1 mb-1 text-xs">
              <XCircle className="h-3.5 w-3.5" /> Vague (will be returned)
            </p>
            <ul className="text-xs text-red-700 dark:text-red-400 space-y-0.5 list-disc list-inside">
              <li>"Fix the ads" — which client? Which campaign?</li>
              <li>"SEO stuff needs to be done" — what, for whom?</li>
              <li>"Check everything" — not actionable</li>
            </ul>
          </div>
        </div>
        <p className="text-xs text-amber-700 dark:text-amber-400 border-t border-amber-200 pt-2">
          Vague or incomplete requests will be returned. Include: client name, specific action, and requested completion date.
        </p>
      </CardContent>
    </Card>
  );
}

// ─── Grouped department picker ──────────────────────────────────────────────────

/**
 * Parse "Group – Short Name" or "Group - Short Name" (en dash or hyphen).
 * Returns { group, label } when the pattern matches, or null for unmatched names.
 */
function parseDeptName(rawName: string): { group: string; label: string } | null {
  const name = stripOptionPrefix(rawName);
  const match = name.match(/^(.+?)\s+[–-]\s+(.+)$/);
  if (!match) return null;
  return { group: match[1].trim(), label: match[2].trim() };
}

function GroupedDeptPicker({
  depts,
  selectedDeptId,
  onSelect,
}: {
  depts: SdDepartment[];
  selectedDeptId: string | null;
  onSelect: (id: string) => void;
}) {
  const pillClass = (id: string) =>
    `px-3 py-1.5 border text-sm font-medium transition-colors ${
      selectedDeptId === id
        ? "bg-primary text-primary-foreground border-primary"
        : "bg-card text-primary-ink border-primary/25 hover:bg-primary/5"
    }`;

  const grouped: Map<string, { dept: SdDepartment; label: string }[]> = new Map();
  const ungrouped: SdDepartment[] = [];

  for (const dept of depts) {
    const parsed = parseDeptName(dept.name);
    if (parsed) {
      const existing = grouped.get(parsed.group) ?? [];
      existing.push({ dept, label: parsed.label });
      grouped.set(parsed.group, existing);
    } else {
      ungrouped.push(dept);
    }
  }

  return (
    <div className="space-y-3" data-testid="department-picker">
      {Array.from(grouped.entries()).map(([group, items]) => (
        <div key={group}>
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">
            {group}
          </p>
          <div className="flex flex-wrap gap-2">
            {items.map(({ dept, label }) => (
              <button
                key={dept.id}
                type="button"
                data-testid={`button-dept-${dept.id}`}
                onClick={() => onSelect(dept.id)}
                className={pillClass(dept.id)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      ))}
      {ungrouped.length > 0 && (
        <div>
          {grouped.size > 0 && (
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">
              Other
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {ungrouped.map((dept) => (
              <button
                key={dept.id}
                type="button"
                data-testid={`button-dept-${dept.id}`}
                onClick={() => onSelect(dept.id)}
                className={pillClass(dept.id)}
              >
                {stripOptionPrefix(dept.name)}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Grouped request-type picker ────────────────────────────────────────────────

function GroupedTypePicker({
  types,
  selectedTypeId,
  onSelect,
}: {
  types: SdRequestType[];
  selectedTypeId: string;
  onSelect: (id: string) => void;
}) {
  const [search, setSearch] = useState("");

  const groups = useMemo(() => groupTypesByCategory(types), [types]);
  const singleCategory = groups.length === 1;

  // Lazy-init: open the group that contains the pre-selected type (if any),
  // but allow users to collapse it afterwards.
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(() => {
    if (selectedTypeId) {
      const sel = types.find((t) => t.id === selectedTypeId);
      if (sel) return new Set([parseTypeName(sel.name).category]);
    }
    return new Set<string>();
  });

  const normalizedSearch = search.trim().toLowerCase();

  // Filter groups by search
  const filteredGroups: TypeGroup<SdRequestType>[] = normalizedSearch
    ? groups
        .map((g) => ({
          ...g,
          items: g.items.filter(
            ({ rt }) =>
              rt.name.toLowerCase().includes(normalizedSearch) ||
              (rt.description ?? "").toLowerCase().includes(normalizedSearch),
          ),
        }))
        .filter((g) => g.items.length > 0)
    : groups;

  const isExpanded = (cat: string): boolean => {
    if (singleCategory) return true;
    // When searching: auto-expand all matching groups
    if (normalizedSearch) return filteredGroups.some((g) => g.category === cat);
    return expandedCategories.has(cat);
  };

  const toggleCategory = (cat: string) => {
    if (normalizedSearch) return; // search controls expansion
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  };

  const cardClass = (id: string) =>
    `flex items-start gap-3 p-3 border text-left transition-colors w-full ${
      selectedTypeId === id
        ? "bg-primary/5 border-primary/40 ring-1 ring-primary/25"
        : "bg-card border-primary/15 hover:bg-primary/3"
    }`;

  return (
    <div className="space-y-2" data-testid="request-type-picker">
      {/* Search */}
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
        <input
          type="text"
          placeholder="Search request types…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          data-testid="input-type-search"
          className="w-full pl-8 pr-3 py-2 text-sm border bg-background focus:outline-none focus:ring-1 focus:ring-primary/30"
        />
        {search && (
          <button
            type="button"
            onClick={() => setSearch("")}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            aria-label="Clear search"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/* Groups */}
      {filteredGroups.length === 0 && (
        <p className="text-xs text-muted-foreground italic py-2" data-testid="hint-no-type-search-results">
          No request types match "{search}".
        </p>
      )}

      {singleCategory ? (
        // Single category — flat list, no grouping layer
        <div className="grid gap-2">
          {filteredGroups[0]?.items.map(({ rt, shortLabel }) => (
            <TypeCard
              key={rt.id}
              rt={rt}
              shortLabel={shortLabel}
              selected={selectedTypeId === rt.id}
              onSelect={onSelect}
              cardClass={cardClass}
            />
          ))}
        </div>
      ) : (
        filteredGroups.map(({ category, items }) => {
          const expanded = isExpanded(category);
          const hasSelected = items.some((i) => i.rt.id === selectedTypeId);
          const selectedItem = hasSelected ? items.find((i) => i.rt.id === selectedTypeId) : null;

          return (
            <div key={category} className="border border-primary/12 overflow-hidden">
              {/* Category header */}
              <button
                type="button"
                data-testid={`button-category-${category.replace(/\s+/g, "-").toLowerCase()}`}
                onClick={() => toggleCategory(category)}
                className={`w-full flex items-center justify-between px-3 py-2.5 text-left transition-colors ${
                  expanded ? "bg-primary/5" : "bg-card hover:bg-primary/3"
                }`}
              >
                <div className="flex items-center gap-2 min-w-0">
                  {expanded ? (
                    <ChevronDown className="h-3.5 w-3.5 text-primary-ink/70 flex-shrink-0" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5 text-primary-ink/70 flex-shrink-0" />
                  )}
                  <span className="text-sm font-semibold text-primary-ink truncate">{category}</span>
                  <span className="text-xs text-muted-foreground bg-primary/8 rounded-pill px-1.5 py-0.5 flex-shrink-0">
                    {items.length}
                  </span>
                </div>
                {/* Compact selected chip when collapsed */}
                {!expanded && selectedItem && (
                  <span
                    className="text-xs text-primary font-medium bg-primary/10 rounded px-2 py-0.5 truncate max-w-[140px] flex-shrink-0"
                    data-testid={`chip-selected-type-${selectedItem.rt.id}`}
                  >
                    ✓ {selectedItem.shortLabel}
                  </span>
                )}
              </button>

              {/* Expanded items */}
              {expanded && (
                <div className="border-t border-primary/10 p-2 grid gap-1.5 bg-[#FDFAF6]">
                  {items.map(({ rt, shortLabel }) => (
                    <TypeCard
                      key={rt.id}
                      rt={rt}
                      shortLabel={shortLabel}
                      selected={selectedTypeId === rt.id}
                      onSelect={onSelect}
                      cardClass={cardClass}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}

function TypeCard({
  rt,
  shortLabel,
  selected,
  onSelect,
  cardClass,
}: {
  rt: SdRequestType;
  shortLabel: string;
  selected: boolean;
  onSelect: (id: string) => void;
  cardClass: (id: string) => string;
}) {
  return (
    <button
      key={rt.id}
      type="button"
      data-testid={`button-type-${rt.id}`}
      onClick={() => onSelect(rt.id)}
      className={cardClass(rt.id)}
    >
      <div
        className={`mt-0.5 h-4 w-4 rounded-pill border-2 flex-shrink-0 flex items-center justify-center ${
          selected ? "border-primary bg-primary" : "border-primary/30"
        }`}
      >
        {selected && <div className="h-1.5 w-1.5 rounded-pill bg-card" />}
      </div>
      <div className="min-w-0">
        <p className="text-sm font-medium text-primary-ink">{shortLabel}</p>
        {rt.description && (
          <p className="text-xs text-muted-foreground mt-0.5">{rt.description}</p>
        )}
      </div>
    </button>
  );
}

// ─── Question field renderer ────────────────────────────────────────────────────

function QuestionField({
  question,
  value,
  onChange,
}: {
  question: SdQuestion;
  value: string;
  onChange: (val: string) => void;
}) {
  const id = `q-${question.id}`;
  const placeholder = question.placeholder?.trim() || undefined;
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id} className="text-sm font-medium">
        {question.label}
        {question.required && <span className="text-destructive ml-1">*</span>}
      </Label>
      {question.helpText?.trim() && (
        <p className="text-xs text-muted-foreground" data-testid={`help-question-${question.id}`}>
          {question.helpText}
        </p>
      )}
      {question.questionType === "long_text" ? (
        <Textarea
          id={id}
          data-testid={`textarea-question-${question.id}`}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder ?? "Your answer…"}
          rows={3}
        />
      ) : question.questionType === "multi_select" && question.options?.length ? (
        <div className="grid gap-1.5" data-testid={`multiselect-question-${question.id}`}>
          {question.options.map((opt) => {
            const selected = splitMultiValue(value).includes(opt);
            return (
              <label key={opt} className="flex items-center gap-2 cursor-pointer text-sm">
                <input
                  type="checkbox"
                  checked={selected}
                  onChange={() => {
                    const current = splitMultiValue(value);
                    const next = selected
                      ? current.filter((v) => v !== opt)
                      : [...(question.options ?? []).filter((o) => current.includes(o) || o === opt)];
                    onChange(next.join(MULTI_SELECT_SEPARATOR));
                  }}
                  className="accent-primary"
                />
                {opt}
              </label>
            );
          })}
        </div>
      ) : question.questionType === "select" && question.options?.length ? (
        <select
          id={id}
          data-testid={`select-question-${question.id}`}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="border text-sm px-3 py-2 bg-background w-full"
        >
          <option value="">— Select —</option>
          {question.options.map((opt) => (
            <option key={opt} value={opt}>{opt}</option>
          ))}
        </select>
      ) : question.questionType === "yes_no" ? (
        <div className="flex gap-4" data-testid={`radio-question-${question.id}`}>
          {["Yes", "No"].map((opt) => (
            <label key={opt} className="flex items-center gap-2 cursor-pointer text-sm">
              <input
                type="radio"
                name={id}
                value={opt}
                checked={value === opt}
                onChange={() => onChange(opt)}
                className="accent-primary"
              />
              {opt}
            </label>
          ))}
        </div>
      ) : question.questionType === "date" ? (
        <Input
          id={id}
          type="date"
          data-testid={`date-question-${question.id}`}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : question.questionType === "number" ? (
        <Input
          id={id}
          type="number"
          data-testid={`number-question-${question.id}`}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder ?? "0"}
        />
      ) : (
        <Input
          id={id}
          data-testid={`input-question-${question.id}`}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder ?? "Your answer…"}
        />
      )}
    </div>
  );
}

// ─── Client combobox ───────────────────────────────────────────────────────────

const INTERNAL_SENTINEL = "__internal__";

function ClientCombobox({
  options,
  selectedClientId,
  selectedLabel,
  onChange,
}: {
  options: SdClientOption[];
  selectedClientId: string | null;
  selectedLabel: string;
  onChange: (clientId: string | null, label: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setSearch("");
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const filtered = search.trim()
    ? options.filter((o) => o.label.toLowerCase().includes(search.toLowerCase()))
    : options;

  const isInternal = selectedClientId === INTERNAL_SENTINEL;
  const displayLabel = isInternal
    ? "Internal (no client)"
    : selectedLabel || "Select a client…";

  function select(clientId: string | null, label: string) {
    onChange(clientId, label);
    setOpen(false);
    setSearch("");
  }

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        data-testid="combobox-client"
        onClick={() => setOpen((v) => !v)}
        className={`w-full flex items-center justify-between gap-2 border text-sm px-3 py-2 bg-background text-left transition-colors ${
          open ? "ring-2 ring-primary/30 border-primary/40" : "border-input hover:border-primary/30"
        }`}
      >
        <span className={selectedClientId == null && !selectedLabel ? "text-muted-foreground" : ""}>
          {displayLabel}
        </span>
        <ChevronDown className="h-4 w-4 text-muted-foreground flex-shrink-0" />
      </button>

      {open && (
        <div className="absolute z-50 mt-1 w-full border bg-card shadow-lg">
          <div className="p-2 border-b">
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
              <input
                autoFocus
                data-testid="combobox-client-search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search clients…"
                className="w-full pl-8 pr-3 py-1.5 text-sm border bg-background focus:outline-none focus:ring-1 focus:ring-primary/30"
              />
            </div>
          </div>
          <ul className="max-h-56 overflow-y-auto py-1" role="listbox">
            {!search.trim() && (
              <li
                role="option"
                data-testid="combobox-option-internal"
                aria-selected={isInternal}
                onClick={() => select(INTERNAL_SENTINEL, "")}
                className={`flex items-center gap-2 px-3 py-2 text-sm cursor-pointer select-none ${
                  isInternal
                    ? "bg-primary/8 text-primary-ink font-medium"
                    : "text-muted-foreground hover:bg-primary/5"
                }`}
              >
                <span className="italic">Internal (no client)</span>
              </li>
            )}
            {filtered.length === 0 && (
              <li className="px-3 py-2 text-sm text-muted-foreground italic">No clients match.</li>
            )}
            {filtered.map((opt) => {
              const selected = selectedClientId === opt.clientId && !isInternal && !!opt.clientId;
              const selectedUnmapped = !opt.clientId && selectedLabel === opt.label && !isInternal;
              const isSelected = selected || selectedUnmapped;
              return (
                <li
                  key={opt.optionId}
                  role="option"
                  data-testid={`combobox-option-${opt.optionId}`}
                  aria-selected={isSelected}
                  onClick={() => select(opt.clientId, opt.label)}
                  className={`flex items-center justify-between gap-2 px-3 py-2 text-sm cursor-pointer select-none ${
                    isSelected
                      ? "bg-primary/8 text-primary-ink font-medium"
                      : "hover:bg-primary/5"
                  }`}
                >
                  <span>{opt.label}</span>
                  {!opt.clientId && (
                    <span className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5 flex-shrink-0">
                      unmapped
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

// ─── Main page ─────────────────────────────────────────────────────────────────

export default function ServiceDeskCreate() {
  const { user, isLoading: authLoading } = useAuth();
  const searchString = useSearch();
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const searchParams = new URLSearchParams(searchString);
  const prefillClientName = searchParams.get("clientName") ?? "";
  const prefillClientId = searchParams.get("clientId") ?? "";
  const prefillDeptId = searchParams.get("departmentId") ?? "";

  // Form state
  const [selectedDeptId, setSelectedDeptId] = useState(prefillDeptId);
  const [selectedTypeId, setSelectedTypeId] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState("3");
  const [requestedDate, setRequestedDate] = useState("");
  // clientName = display label (also the text fallback for unmapped options)
  // clientId   = NoBull clients.id UUID (null for internal / unmapped)
  const [clientName, setClientName] = useState(prefillClientName);
  const [clientId, setClientId] = useState<string>(prefillClientId);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [file, setFile] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // Track whether client combobox has been used (to avoid clobbering prefill text fallback)
  const [clientComboReady, setClientComboReady] = useState(false);
  // Set when a ?clientId/?clientName prefill couldn't be matched to a combobox option
  const [prefillUnmatched, setPrefillUnmatched] = useState(false);

  const isCeo = !!user && (user as any).role === "ceo";

  // ─── Data queries ─────────────────────────────────────────────────────────────

  const configQ = useQuery<{ config: SdListMapping | null }>({
    queryKey: ["/api/service-desk/config"],
    staleTime: 60_000,
  });

  const deptsQ = useQuery<{ departments: SdDepartment[] }>({
    queryKey: ["/api/service-desk/departments"],
    staleTime: 60_000,
  });

  const typesQ = useQuery<{ requestTypes: SdRequestType[] }>({
    queryKey: ["/api/service-desk/request-types"],
    staleTime: 60_000,
  });

  const questionsQ = useQuery<{ questions: SdQuestion[] }>({
    queryKey: [`/api/service-desk/request-types/${selectedTypeId}/questions`],
    enabled: !!selectedTypeId,
    staleTime: 30_000,
  });

  const clientOptionsQ = useQuery<{ options: SdClientOption[] | null; configured: boolean }>({
    queryKey: ["/api/service-desk/client-options"],
    staleTime: 120_000,
  });

  // ─── Derived state ────────────────────────────────────────────────────────────

  const cfg = configQ.data?.config ?? null;
  const configured = !!cfg?.clickupListId;

  // Client options combobox helpers
  const clientOptions: SdClientOption[] = clientOptionsQ.data?.options ?? [];
  const clientOptionsConfigured = !!clientOptionsQ.data?.configured;
  const useCombobox = clientOptionsConfigured && clientOptions.length > 0;

  // On options load: if there was a prefill clientId or clientName, match it to
  // an option so the combobox shows the right selection. Runs once per options load.
  useEffect(() => {
    if (!useCombobox || clientComboReady) return;
    if (prefillClientId) {
      const match = clientOptions.find((o) => o.clientId === prefillClientId);
      if (match) {
        setClientId(match.clientId ?? "");
        setClientName(match.label);
        setClientComboReady(true);
      } else {
        // Prefill couldn't be matched to a dropdown option — clear the stale
        // clientId so the combobox doesn't silently submit an unmapped value,
        // and surface a notice prompting the user to pick manually.
        setClientId("");
        setPrefillUnmatched(true);
      }
    } else if (prefillClientName) {
      const match = clientOptions.find((o) =>
        o.label.toLowerCase() === prefillClientName.toLowerCase(),
      );
      if (match) {
        setClientId(match.clientId ?? "");
        setClientName(match.label);
        setClientComboReady(true);
      } else {
        setPrefillUnmatched(true);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [useCombobox]);

  const activeDepts = (deptsQ.data?.departments ?? []).filter((d) => d.active);
  const allTypes = typesQ.data?.requestTypes ?? [];
  const filteredTypes = selectedDeptId
    ? allTypes.filter((t) => {
        if (!t.active) return false;
        const resolved = resolveRequestTypeDept(t, activeDepts);
        // Show when: explicitly assigned to this dept, name-prefix matches this
        // dept, truly unmatchable (null — no prefix match), or ambiguous (prefix
        // matches multiple depts equally). Null and ambiguous are both kept
        // visible everywhere so no request type becomes unreachable.
        return resolved === selectedDeptId || resolved === null || resolved === "ambiguous";
      })
    : allTypes.filter((t) => t.active);

  const selectedType = allTypes.find((t) => t.id === selectedTypeId);
  const selectedDept = activeDepts.find((d) => d.id === selectedDeptId);
  const questions = questionsQ.data?.questions ?? [];

  // Clear selected type when department changes
  const handleDeptChange = (deptId: string) => {
    setSelectedDeptId(deptId);
    setSelectedTypeId("");
    setAnswers({});
  };

  // Clear answers when type changes
  const handleTypeChange = (typeId: string) => {
    setSelectedTypeId(typeId);
    setAnswers({});
  };

  const setAnswer = (questionId: string, val: string) => {
    setAnswers((prev) => ({ ...prev, [questionId]: val }));
  };

  // Seed per-question default values once the template's questions load,
  // without clobbering anything the user has already typed (Task #3656).
  useEffect(() => {
    const qs = questionsQ.data?.questions;
    if (!qs?.length) return;
    setAnswers((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const q of qs) {
        if (q.defaultValue?.trim() && next[q.id] === undefined) {
          next[q.id] = q.defaultValue;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [questionsQ.data]);

  // ─── Submission ────────────────────────────────────────────────────────────────

  // Resolved values for submission (normalise the INTERNAL_SENTINEL sentinel)
  const submitClientId = clientId && clientId !== INTERNAL_SENTINEL ? clientId : "";
  const submitClientName = clientId === INTERNAL_SENTINEL ? "" : clientName;

  const submitMutation = useMutation({
    mutationFn: async () => {
      const formData = new FormData();
      formData.append("departmentId", selectedDeptId);
      formData.append("requestTypeId", selectedTypeId);
      formData.append("title", title.trim());
      formData.append("description", description.trim());
      formData.append("priority", priority);
      if (requestedDate) formData.append("requestedDate", requestedDate);
      if (submitClientName.trim()) formData.append("clientName", submitClientName.trim());
      if (submitClientId) formData.append("clientId", submitClientId);
      formData.append(
        "answers",
        JSON.stringify(
          Object.entries(answers).map(([questionId, value]) => ({ questionId, value })),
        ),
      );
      if (file) formData.append("file", file);

      const res = await fetch("/api/service-desk/tickets/submit", {
        method: "POST",
        body: formData,
        credentials: "include",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error ?? `Submission failed (${res.status})`);
      }
      return res.json() as Promise<{
        success: boolean;
        taskId: string;
        taskUrl: string;
        resolvedOwnerName?: string | null;
        statusFallbackUsed?: boolean;
        statusNotice?: string;
      }>;
    },
    onSuccess: (data) => {
      const ownerSuffix = data.resolvedOwnerName
        ? ` Your request will be handled by ${data.resolvedOwnerName}.`
        : "";
      if (data.statusFallbackUsed && data.statusNotice) {
        toast({ title: "Request submitted!", description: data.statusNotice + ownerSuffix });
      } else {
        toast({
          title: "Request submitted!",
          description: `Your ticket has been created.${ownerSuffix}`,
        });
      }
      void queryClient.invalidateQueries({ queryKey: ["/api/service-desk/tickets"] }); // fire-and-forget: cache refresh only
      navigate("/service-desk");
    },
    onError: (err: any) => {
      toast({ title: "Submission failed", description: err?.message, variant: "destructive" });
    },
  });

  // ─── Validation ────────────────────────────────────────────────────────────────

  const missingRequired = questions
    .filter((q) => q.required)
    .filter((q) => !(answers[q.id] ?? "").trim());

  const canSubmit =
    !!selectedDeptId &&
    !!selectedTypeId &&
    title.trim().length > 0 &&
    missingRequired.length === 0 &&
    !submitMutation.isPending;

  // ─── Loading / unconfigured states ────────────────────────────────────────────

  if (authLoading || configQ.isLoading) {
    return (
      <div className="min-h-[calc(100dvh-var(--nav-height))] bg-surface-warm-1 flex items-center justify-center">
        <p className="text-muted-foreground text-sm" data-testid="status-loading">Loading…</p>
      </div>
    );
  }

  // ─── Render ────────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-[calc(100dvh-var(--nav-height))] bg-surface-warm-1 p-4 sm:p-6" data-testid="page-service-desk-create">
      <div className="max-w-3xl mx-auto space-y-4">

        {/* Header */}
        <div className="bg-card shadow-sm border border-primary/8 px-5 py-4">
          <PageHeader
            title="Submit a Service Request"
            backHref={submitClientId ? `/clients/${submitClientId}` : "/service-desk"}
            titleTestId="heading-create-request"
            subtitle={submitClientName ? `Client: ${submitClientName}` : undefined}
            actions={
              isCeo && (
                <Button
                  asChild
                  variant="outline"
                  size="sm"
                  className="text-xs border-primary/20 text-primary-ink hover:bg-primary/5"
                  data-testid="link-service-desk-settings"
                >
                  <Link href="/admin/service-desk">Settings</Link>
                </Button>
              )
            }
          />
        </div>

        {!configured ? (
          <Card data-testid="card-form-not-configured">
            <CardContent className="py-10 text-center">
              <AlertCircle className="h-8 w-8 text-amber-400 mx-auto mb-3" />
              <p className="font-medium text-sm">Service Desk is not configured yet.</p>
              <p className="text-sm text-muted-foreground mt-1">
                {isCeo ? (
                  <>
                    Go to{" "}
                    <Link href="/admin/service-desk" className="underline text-primary-ink">
                      Service Desk Settings
                    </Link>{" "}
                    to complete setup.
                  </>
                ) : (
                  "Ask your administrator to configure the Service Desk."
                )}
              </p>
            </CardContent>
          </Card>
        ) : (
          <>
            <GuardrailsChrome />

            <Card data-testid="card-native-form">
              <CardHeader className="pb-3 border-b">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  Fill in all required fields (<span className="text-destructive">*</span>) and click Submit.
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-5 space-y-6">

                {/* Department picker */}
                <div className="grid gap-1.5">
                  <Label className="text-sm font-semibold text-foreground">
                    Department <span className="text-destructive">*</span>
                  </Label>
                  {deptsQ.isLoading ? (
                    <p className="text-xs text-muted-foreground">Loading departments…</p>
                  ) : (
                    <GroupedDeptPicker
                      depts={activeDepts}
                      selectedDeptId={selectedDeptId}
                      onSelect={handleDeptChange}
                    />
                  )}
                </div>

                {/* Request type picker — requires a department first */}
                <div className="grid gap-1.5">
                  <Label className="text-sm font-semibold text-foreground">
                    Request Type <span className="text-destructive">*</span>
                  </Label>
                  {!selectedDeptId ? (
                    <p className="text-xs text-muted-foreground italic" data-testid="hint-pick-department-first">
                      Pick a department above to see available request types.
                    </p>
                  ) : typesQ.isLoading ? (
                    <p className="text-xs text-muted-foreground">Loading request types…</p>
                  ) : filteredTypes.length === 0 ? (
                    <p className="text-xs text-muted-foreground" data-testid="hint-no-types-for-dept">
                      No request types for this department yet. Contact your administrator.
                    </p>
                  ) : (
                    <GroupedTypePicker
                      types={filteredTypes}
                      selectedTypeId={selectedTypeId}
                      onSelect={handleTypeChange}
                    />
                  )}
                </div>

                {/* Template questions (shown after type is selected) */}
                {selectedTypeId && (
                  <>
                    {questionsQ.isLoading ? (
                      <p className="text-xs text-muted-foreground">Loading questions…</p>
                    ) : questions.length > 0 ? (
                      <div className="space-y-4 pt-1">
                        <div className="flex items-center gap-2">
                          <div className="h-px flex-1 bg-primary/10" />
                          <span className="text-xs font-semibold text-foreground/60 uppercase tracking-wider">
                            {selectedType?.name} Questions
                          </span>
                          <div className="h-px flex-1 bg-primary/10" />
                        </div>
                        {questions.map((q) => (
                          <QuestionField
                            key={q.id}
                            question={q}
                            value={answers[q.id] ?? ""}
                            onChange={(val) => setAnswer(q.id, val)}
                          />
                        ))}
                      </div>
                    ) : null}

                    {/* Standard fields */}
                    <div className="space-y-4 pt-1">
                      <div className="flex items-center gap-2">
                        <div className="h-px flex-1 bg-primary/10" />
                        <span className="text-xs font-semibold text-foreground/60 uppercase tracking-wider">
                          Request Details
                        </span>
                        <div className="h-px flex-1 bg-primary/10" />
                      </div>

                      {/* Client name / combobox */}
                      <div className="grid gap-1.5">
                        <Label htmlFor="client-name" className="text-sm font-medium">
                          Client Name
                        </Label>
                        {clientOptionsQ.isLoading ? (
                          <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            Loading clients…
                          </div>
                        ) : useCombobox ? (
                          <>
                            {prefillUnmatched && (
                              <p className="text-xs text-amber-600 flex items-center gap-1" data-testid="notice-prefill-unmatched">
                                <AlertCircle className="h-3 w-3" />
                                We couldn't find {prefillClientName ? `"${prefillClientName}"` : "this client"} in the client list — pick it manually below
                              </p>
                            )}
                            <ClientCombobox
                              options={clientOptions}
                              selectedClientId={clientId || null}
                              selectedLabel={clientName}
                              onChange={(newClientId, newLabel) => {
                                setClientId(newClientId ?? "");
                                setClientName(newLabel);
                                setClientComboReady(true);
                                setPrefillUnmatched(false);
                              }}
                            />
                          </>
                        ) : (
                          <>
                            <Input
                              id="client-name"
                              data-testid="input-client-name"
                              value={clientName}
                              onChange={(e) => setClientName(e.target.value)}
                              placeholder="Which client is this for? (leave blank if internal)"
                            />
                            {(clientOptionsQ.isError || (!clientOptionsQ.isLoading && !useCombobox)) && (
                              <p className="text-xs text-amber-600 flex items-center gap-1" data-testid="notice-client-options-unavailable">
                                <AlertCircle className="h-3 w-3" />
                                {clientOptionsQ.isError
                                  ? "Client list unavailable — type the name manually."
                                  : "Client list not set up yet — type the name manually. Ask your admin to sync the ClickUp client options."}
                              </p>
                            )}
                          </>
                        )}
                      </div>

                      {/* Title */}
                      <div className="grid gap-1.5">
                        <Label htmlFor="title" className="text-sm font-medium">
                          Request Title <span className="text-destructive">*</span>
                        </Label>
                        <Input
                          id="title"
                          data-testid="input-title"
                          value={title}
                          onChange={(e) => setTitle(e.target.value)}
                          placeholder="One-line summary of what you need done"
                        />
                      </div>

                      {/* Description */}
                      <div className="grid gap-1.5">
                        <Label htmlFor="description" className="text-sm font-medium">
                          Additional Details
                        </Label>
                        <Textarea
                          id="description"
                          data-testid="textarea-description"
                          value={description}
                          onChange={(e) => setDescription(e.target.value)}
                          placeholder="Any additional context, links, or instructions…"
                          rows={4}
                        />
                      </div>

                      {/* Priority + requested date */}
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div className="grid gap-1.5">
                          <Label htmlFor="priority" className="text-sm font-medium">
                            Priority
                          </Label>
                          <select
                            id="priority"
                            data-testid="select-priority"
                            value={priority}
                            onChange={(e) => setPriority(e.target.value)}
                            className="border text-sm px-3 py-2 bg-background"
                          >
                            <option value="1">🔴 Urgent</option>
                            <option value="2">🟠 High</option>
                            <option value="3">🔵 Normal</option>
                            <option value="4">⚪ Low</option>
                          </select>
                        </div>
                        <div className="grid gap-1.5">
                          <Label htmlFor="requested-date" className="text-sm font-medium">
                            Requested Completion Date
                          </Label>
                          <Input
                            id="requested-date"
                            type="date"
                            data-testid="input-requested-date"
                            value={requestedDate}
                            onChange={(e) => setRequestedDate(e.target.value)}
                          />
                        </div>
                      </div>

                      {/* File attachment */}
                      <div className="grid gap-1.5">
                        <Label className="text-sm font-medium">Attachment (optional)</Label>
                        {file ? (
                          <div
                            className="flex items-center gap-2 p-2 border bg-muted/30"
                            data-testid="file-selected"
                          >
                            <FileText className="h-4 w-4 text-primary flex-shrink-0" />
                            <span className="text-sm truncate flex-1">{file.name}</span>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6"
                              aria-label="Remove attachment"
                              data-testid="button-remove-file"
                              onClick={() => { setFile(null); if (fileRef.current) fileRef.current.value = ""; }}
                            >
                              <X className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        ) : (
                          <div>
                            <input
                              ref={fileRef}
                              type="file"
                              className="hidden"
                              data-testid="input-file"
                              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                            />
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="text-xs border-dashed"
                              data-testid="button-attach-file"
                              onClick={() => fileRef.current?.click()}
                            >
                              <Upload className="h-3.5 w-3.5 mr-1.5" />
                              Attach a file
                            </Button>
                            <p className="text-xs text-muted-foreground mt-1">Max 25 MB</p>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Missing required warning */}
                    {missingRequired.length > 0 && title.trim() && (
                      <div className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-200">
                        <AlertCircle className="h-4 w-4 text-amber-500 flex-shrink-0 mt-0.5" />
                        <div>
                          <p className="text-xs font-medium text-amber-800">Required fields missing:</p>
                          <ul className="text-xs text-amber-700 mt-1 list-disc list-inside">
                            {missingRequired.map((q) => <li key={q.id}>{q.label}</li>)}
                          </ul>
                        </div>
                      </div>
                    )}

                    {/* Submit */}
                    <div className="flex items-center gap-3 pt-2 border-t">
                      <Button
                        data-testid="button-submit"
                        disabled={!canSubmit}
                        onClick={() => submitMutation.mutate()}
                        className="bg-primary hover:bg-primary/90 text-primary-foreground"
                      >
                        {submitMutation.isPending ? (
                          <>
                            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                            Submitting…
                          </>
                        ) : (
                          "Submit Request"
                        )}
                      </Button>
                      <Badge variant="secondary" className="text-xs">
                        {selectedDept?.name} › {selectedType?.name}
                      </Badge>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          </>
        )}

        <p className="text-xs text-center text-muted-foreground pb-4" data-testid="text-footer-note">
          Requests are tracked in ClickUp and managed by the responsible department.
          You will receive updates on your ticket as it progresses.
        </p>
      </div>
    </div>
  );
}
