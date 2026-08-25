import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import type { ClientCriteria } from "../lib/types";

// Central per-client criteria modal (spec §6.11) — port of the bundle's
// frontend/src/components/CriteriaEditor.tsx. The editor only needs an id to
// load/save by and a name to title the modal, so any account-like object works —
// a dashboard row, a combined member, or a full AccountSummary (which
// structurally satisfies this).
interface CriteriaTarget {
  customer_id: string;
  descriptive_name: string;
}

interface Props {
  account: CriteriaTarget;
  onClose: () => void;
  onSaved: () => void;
}

type TextKey = Exclude<keyof ClientCriteria, "practice_areas" | "schedule_days" | "lsa_schedule_days">;
type ScheduleKey = "schedule_days" | "lsa_schedule_days";

const EMPTY: ClientCriteria = {
  business_name: "",
  website: "",
  practice_areas: [],
  service_area: "",
  services_offered: "",
  services_not_offered: "",
  competitors: "",
  extra_protected_terms: "",
  notes: "",
  schedule_days: [],
  lsa_schedule_days: [],
};

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const FIELDS: {
  key: TextKey;
  label: string;
  help: string;
  derived?: "business_name" | "service_area";
  big?: boolean;
}[] = [
  { key: "business_name", label: "Business name", help: "Brand — always protected.", derived: "business_name" },
  { key: "website", label: "Website", help: "Optional context for the model." },
  {
    key: "service_area",
    label: "Service area",
    help: "Cities / neighborhoods / counties / states served — NEVER negated.",
    derived: "service_area",
    big: true,
  },
  {
    key: "services_offered",
    label: "Services offered",
    help: "Practice areas / services — protected words.",
    big: true,
  },
  {
    key: "services_not_offered",
    label: "Services NOT offered",
    help: "When these show up, they're candidates to negate.",
    big: true,
  },
  { key: "competitors", label: "Known competitors", help: "Competitor / firm names to watch for.", big: true },
  {
    key: "extra_protected_terms",
    label: "Extra protected terms",
    help: "Any other words that must never become a negative.",
  },
  { key: "notes", label: "Notes for the AI", help: "Anything else worth knowing.", big: true },
];

export function CriteriaEditor({ account, onClose, onSaved }: Props) {
  const [form, setForm] = useState<ClientCriteria>(EMPTY);
  const [derived, setDerived] = useState<{ business_name: string; service_area: string }>({
    business_name: "",
    service_area: "",
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);          // save errors (keep the form)
  const [loadError, setLoadError] = useState<string | null>(null);  // load errors (block the form)
  const [practiceAreaOptions, setPracticeAreaOptions] = useState<string[]>([]);
  const [practiceAreaSyncBase, setPracticeAreaSyncBase] = useState<string[]>([]);
  const [practiceAreaSyncAvailable, setPracticeAreaSyncAvailable] = useState(false);
  const [practiceAreaSyncReason, setPracticeAreaSyncReason] = useState<string | null>(null);
  const [paOpen, setPaOpen] = useState(false);
  const [schedOpen, setSchedOpen] = useState(false);
  const [lsaSchedOpen, setLsaSchedOpen] = useState(false);
  const paRef = useRef<HTMLDivElement>(null);
  const schedRef = useRef<HTMLDivElement>(null);
  const lsaSchedRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = "ads-os-criteria-title";

  // Escape-to-close + focus management: move focus into the dialog on open and
  // restore it to the previously focused element on unmount (close).
  useEffect(() => {
    const prevFocus = document.activeElement as HTMLElement | null;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    // Focus the first focusable control (falls back to the dialog itself).
    const first = dialogRef.current?.querySelector<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    (first ?? dialogRef.current)?.focus();
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      prevFocus?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function load() {
    setLoading(true);
    setLoadError(null);
    api
      .getCriteria(account.customer_id)
      .then((r) => {
        setForm({ ...EMPTY, ...r.criteria });
        setDerived(r.derived);
        setPracticeAreaSyncBase([...r.criteria.practice_areas]);
        setPracticeAreaOptions(r.practice_area_options ?? []);
        setPracticeAreaSyncAvailable(r.practice_area_sync_available === true);
        setPracticeAreaSyncReason(r.practice_area_sync_reason ?? null);
        setPaOpen(false);
      })
      // Block the editor on a failed load — never show a blank form whose Save would
      // overwrite the client's real saved criteria with empty values.
      .catch((e) => setLoadError(e instanceof Error ? e.message : "Couldn't load criteria"))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account.customer_id]);

  function set(key: TextKey, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function togglePractice(area: string) {
    setForm((f) => ({
      ...f,
      practice_areas: f.practice_areas.includes(area)
        ? f.practice_areas.filter((a) => a !== area)
        : practiceAreaOptions.filter(
            (option) => option === area || f.practice_areas.includes(option),
          ),
    }));
  }

  function toggleDay(key: ScheduleKey, day: string) {
    setForm((f) => ({
      ...f,
      [key]: f[key].includes(day)
        ? f[key].filter((d) => d !== day)
        : DAYS.filter((d) => d === day || f[key].includes(d)), // keep Mon→Sun order
    }));
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await api.saveCriteria(
        account.customer_id,
        form,
        practiceAreaSyncBase,
      );
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
      setSaving(false);
    }
  }

  return (
    <div className="ki-modal-backdrop" onMouseDown={onClose} data-testid="modal-criteria">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="ki-modal"
        onMouseDown={(e) => {
          e.stopPropagation();
          if (paRef.current && !paRef.current.contains(e.target as Node)) setPaOpen(false);
          if (schedRef.current && !schedRef.current.contains(e.target as Node)) setSchedOpen(false);
          if (lsaSchedRef.current && !lsaSchedRef.current.contains(e.target as Node)) setLsaSchedOpen(false);
        }}
      >
        <div className="ki-modal-head">
          <h3 id={titleId}>Client criteria — {account.descriptive_name}</h3>
          <button className="link" onClick={onClose} aria-label="Close criteria editor" data-testid="button-criteria-close">
            close
          </button>
        </div>

        {loading ? (
          <div className="panel loading" role="status">
            <div className="spinner" />
            Loading criteria…
          </div>
        ) : loadError ? (
          <div className="panel error" role="alert" data-testid="text-criteria-load-error">
            Couldn’t load this client’s criteria. Saving is disabled so
            nothing gets overwritten. ({loadError}){" "}
            <button className="link" onClick={load}>
              Retry
            </button>
          </div>
        ) : (
          <>
            <p className="muted ki-modal-intro">
              Central per-client settings, shared across tools. Empty Search-Term-Analyzer fields
              fall back to auto-detected defaults (shown as placeholders).
            </p>
            <div className="ki-form">
              {/* ---------------- Ad schedules ----------------
                  One schedule per platform — GAds and LSA clients sometimes run
                  on different days, and each drives only its own budget-pacing
                  math. Budgets are NOT set here — the ClickUp Client List
                  ("Paid Search Budget" per account subtask) is the source of
                  truth. */}
              <div className="ki-field ki-field--wide ki-section-head">Ad schedules</div>

              <ScheduleDaysField
                label="Google Ads schedule (days ads run)"
                help="Drives the Google Ads avg-daily-spend and pacing math — only these days count."
                selected={form.schedule_days}
                open={schedOpen}
                onOpenToggle={() => setSchedOpen((o) => !o)}
                onDayToggle={(d) => toggleDay("schedule_days", d)}
                boxRef={schedRef}
                triggerTestId="button-schedule-days"
                dayTestIdPrefix="checkbox-day-"
              />

              <ScheduleDaysField
                label="LSA schedule (days ads run)"
                help="Drives the LSA pacing math, incl. the weekly recommendation — only these days count."
                selected={form.lsa_schedule_days}
                open={lsaSchedOpen}
                onOpenToggle={() => setLsaSchedOpen((o) => !o)}
                onDayToggle={(d) => toggleDay("lsa_schedule_days", d)}
                boxRef={lsaSchedRef}
                triggerTestId="button-lsa-schedule-days"
                dayTestIdPrefix="checkbox-lsa-day-"
              />

              {/* ---------------- Search Term Analyzer ---------------- */}
              <div className="ki-field ki-field--wide ki-section-head">Search Term Analyzer</div>

              <div className="ki-field ki-field--wide">
                <span className="ki-field-label">Practice areas</span>
                <div className="pa-select" ref={paRef}>
                  <button
                    type="button"
                    className="pa-trigger"
                    onClick={() => setPaOpen((o) => !o)}
                    aria-expanded={paOpen}
                    aria-describedby="practice-area-help"
                    disabled={!practiceAreaSyncAvailable}
                    data-testid="button-practice-areas"
                  >
                    {form.practice_areas.length ? (
                      <span>{form.practice_areas.join(", ")}</span>
                    ) : (
                      <span className="pa-placeholder">
                        {practiceAreaSyncAvailable
                          ? "Select practice areas…"
                          : "Practice areas unavailable"}
                      </span>
                    )}
                    <span className="pa-caret">▾</span>
                  </button>
                  {paOpen && (
                    <div className="pa-menu" role="group" aria-label="Practice areas">
                      {practiceAreaOptions.map((a) => (
                        <label key={a} className="pa-opt">
                          <input
                            type="checkbox"
                            checked={form.practice_areas.includes(a)}
                            onChange={() => togglePractice(a)}
                            data-testid={`checkbox-practice-${a
                              .toLowerCase()
                              .replace(/[^a-z0-9]+/g, "-")
                              .replace(/^-|-$/g, "")}`}
                          />
                          <span>{a}</span>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
                <span
                  id="practice-area-help"
                  className={`ki-field-help${practiceAreaSyncAvailable ? "" : " ki-field-help--warning"}`}
                  role={practiceAreaSyncAvailable ? undefined : "status"}
                  data-testid={
                    practiceAreaSyncAvailable
                      ? "text-practice-area-help"
                      : "text-practice-area-unavailable"
                  }
                >
                  {practiceAreaSyncAvailable
                    ? "Managed in ClickUp. Choose zero or more areas; the saved order follows ClickUp."
                    : `Unavailable — ${practiceAreaSyncReason ?? "the ClickUp client directory has not loaded successfully yet."} Other criteria can still be edited and saved.`}
                </span>
              </div>

              {FIELDS.map((f) => {
                const ph = f.derived ? derived[f.derived] : "";
                return (
                  <label key={f.key} className={`ki-field${f.big ? " ki-field--wide" : ""}`}>
                    <span className="ki-field-label">{f.label}</span>
                    {f.big ? (
                      <textarea
                        rows={2}
                        value={form[f.key]}
                        placeholder={ph}
                        onChange={(e) => set(f.key, e.target.value)}
                        data-testid={`input-${f.key}`}
                      />
                    ) : (
                      <input
                        type="text"
                        value={form[f.key]}
                        placeholder={ph}
                        onChange={(e) => set(f.key, e.target.value)}
                        data-testid={`input-${f.key}`}
                      />
                    )}
                    <span className="ki-field-help">{f.help}</span>
                  </label>
                );
              })}
            </div>
            {error && (
              <div className="login-error" role="alert" data-testid="text-criteria-save-error">
                Couldn’t save criteria. {error}
              </div>
            )}
            <div className="ki-modal-actions">
              <button className="btn-secondary" onClick={onClose} disabled={saving} data-testid="button-criteria-cancel">
                Cancel
              </button>
              <button className="ki-save" onClick={save} disabled={saving} data-testid="button-criteria-save">
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// Checkbox-dropdown day picker (one per platform schedule). Shared so the GAds
// and LSA pickers can't drift; "Every day" placeholder when nothing is set.
function ScheduleDaysField({
  label,
  help,
  selected,
  open,
  onOpenToggle,
  onDayToggle,
  boxRef,
  triggerTestId,
  dayTestIdPrefix,
}: {
  label: string;
  help: string;
  selected: string[];
  open: boolean;
  onOpenToggle: () => void;
  onDayToggle: (day: string) => void;
  boxRef: { current: HTMLDivElement | null };
  triggerTestId: string;
  dayTestIdPrefix: string;
}) {
  return (
    <div className="ki-field ki-field--wide">
      <span className="ki-field-label">{label}</span>
      <div className="pa-select" ref={boxRef}>
        <button
          type="button"
          className="pa-trigger"
          onClick={onOpenToggle}
          aria-expanded={open}
          data-testid={triggerTestId}
        >
          {selected.length ? (
            <span>{selected.join(", ")}</span>
          ) : (
            <span className="pa-placeholder">Every day (no schedule set)</span>
          )}
          <span className="pa-caret">▾</span>
        </button>
        {open && (
          <div className="pa-menu">
            {DAYS.map((d) => (
              <label key={d} className="pa-opt">
                <input
                  type="checkbox"
                  checked={selected.includes(d)}
                  onChange={() => onDayToggle(d)}
                  data-testid={`${dayTestIdPrefix}${d}`}
                />
                <span>{d}</span>
              </label>
            ))}
          </div>
        )}
      </div>
      <span className="ki-field-help">{help}</span>
    </div>
  );
}
