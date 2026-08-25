/**
 * Ads OS · System Checks page (/ads-os/proofs)
 *
 * CEO-only verification surface running four live integration checks:
 *  1. MCC account list from Google Ads
 *  2. ClickUp Client List parsed into client blocks
 *  3. OpenAI structured-output round-trip
 *  4. Store put/get round-trip
 *
 * Task #4375 (design audit P3-7): this is an engineering self-check page, not
 * an operator workflow, and its APIs are CEO-gated server-side (requireCeo).
 * The client now matches: the shell hides the tab / ⌘K entry from non-CEO
 * roles, and a non-CEO deep link renders a designed "restricted" notice
 * WITHOUT mounting the check queries (they'd just spray 403s). The CEO view
 * self-explains as a verification status page. What the checks verify is
 * unchanged from Phase 0.
 *
 * Rendered inside AdsOsShell so it shares the module top bar and honors the
 * module light/dark theme (Task #3705) — styles live in adsOs.css (.proof-*),
 * no inline light-only colors.
 */

import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { humanizeQueryError } from "@/lib/queryErrorCopy";
import { CheckCircle2, XCircle, RefreshCw } from "lucide-react";
import { useState } from "react";
import { Link } from "wouter";
import { AdsOsShell } from "./adsOs/components/AdsOsShell";

// ─── Sub-components ──────────────────────────────────────────────────────────

/** Status chip with an explicit, screen-reader-friendly status word — never
 *  color/icon alone. The icon is decorative (aria-hidden); the word carries it. */
function StatusChip({ ok, label }: { ok: boolean | null; label: string }) {
  if (ok === null) return <span className="proof-chip wait" role="status">{label}</span>;
  return ok ? (
    <span className="proof-chip pass">
      <CheckCircle2 size={12} aria-hidden="true" /> {label}
    </span>
  ) : (
    <span className="proof-chip fail" role="alert">
      <XCircle size={12} aria-hidden="true" /> {label}
    </span>
  );
}

function ProofCard({
  title,
  purpose,
  impact,
  isLoading,
  isError,
  error,
  ok,
  data,
  children,
  onRefresh,
  testId,
}: {
  /** Plain-language integration name, e.g. "Google Ads accounts". */
  title: string;
  /** What this integration is used for, in operator language. */
  purpose: string;
  /** What it means for day-to-day work when this check fails. */
  impact: string;
  isLoading: boolean;
  isError: boolean;
  error?: string;
  ok?: boolean;
  /** Raw payload, tucked behind a "Technical details" disclosure. */
  data?: unknown;
  children?: React.ReactNode;
  onRefresh: () => void;
  testId?: string;
}) {
  const failed = isError || ok === false;
  const passed = ok === true && !isError;
  // Human, one-line readiness sentence — no status codes, no field names.
  const sentence = isLoading
    ? "Checking this connection now…"
    : passed
      ? "Connected and answering correctly."
      : failed
        ? impact
        : "Not checked yet.";

  return (
    <div className="proof-card" data-testid={testId}>
      <div className="proof-card-head">
        <div>
          <h3>{title}</h3>
          <p className="proof-card-sub">{purpose}</p>
        </div>
        <div className="proof-card-status">
          {isLoading ? (
            <StatusChip ok={null} label="Checking…" />
          ) : failed ? (
            <StatusChip ok={false} label="Needs attention" />
          ) : passed ? (
            <StatusChip ok={true} label="Ready" />
          ) : null}
          <button
            type="button"
            className="proof-rerun"
            onClick={onRefresh}
            disabled={isLoading}
            aria-label={`Re-run ${title} check`}
          >
            <RefreshCw size={11} aria-hidden="true" />
            Re-run
          </button>
        </div>
      </div>

      <p
        className="proof-count"
        role={isLoading ? "status" : failed ? "alert" : undefined}
      >
        {sentence}
      </p>

      {children}

      {data != null && !isLoading && (
        <details className="proof-details">
          <summary>Technical details</summary>
          <RawJsonBlock data={data} />
        </details>
      )}
    </div>
  );
}

function RawJsonBlock({ data }: { data: unknown }) {
  return <pre className="proof-json">{JSON.stringify(data, null, 2)}</pre>;
}

/** Turn a check's raw error (server-provided string or thrown Error) into
 *  operator-grade impact copy — never raw JSON/status codes. */
function impactCopy(base: string, isError: boolean, error: unknown): string {
  if (isError) {
    const h = humanizeQueryError(error, { kind: "query" });
    return `${base} ${h.description}`;
  }
  return base;
}

// ─── Proof 1: Google Ads accounts ────────────────────────────────────────────

function AccountsProof() {
  const [tick, setTick] = useState(0);
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["ads-os-proof-accounts", tick],
    queryFn: () => apiRequest("GET", "/api/ads-os/proofs/accounts").then((r) => r.json()),
    retry: false,
    staleTime: 0,
  });
  const ok = (data as any)?.ok;
  return (
    <ProofCard
      title="Google Ads accounts"
      purpose="Lists the client accounts under our managed Google Ads account."
      impact={impactCopy(
        "Can't reach Google Ads right now, so account lists and spend won't refresh. Re-run in a moment.",
        isError,
        error,
      )}
      isLoading={isLoading}
      isError={isError}
      ok={ok}
      data={data}
      onRefresh={() => setTick((t) => t + 1)}
      testId="proof-google-ads"
    >
      {ok && (
        <p className="proof-count">
          Found <strong style={{ fontVariantNumeric: "tabular-nums" }}>{data.count}</strong> managed
          account{data.count === 1 ? "" : "s"}.
        </p>
      )}
    </ProofCard>
  );
}

// ─── Proof 2: ClickUp client blocks ──────────────────────────────────────────

function ClickUpProof() {
  const [tick, setTick] = useState(0);
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["ads-os-proof-clickup", tick],
    queryFn: () => apiRequest("GET", "/api/ads-os/proofs/clickup").then((r) => r.json()),
    retry: false,
    staleTime: 0,
  });
  const ok = (data as any)?.ok;
  return (
    <ProofCard
      title="ClickUp client list"
      purpose="Reads the client roster — names, accounts, budgets and who owns each one."
      impact={impactCopy(
        "Can't read the ClickUp client list right now, so client and budget details won't refresh. Re-run in a moment.",
        isError,
        error,
      )}
      isLoading={isLoading}
      isError={isError}
      ok={ok}
      data={data}
      onRefresh={() => setTick((t) => t + 1)}
      testId="proof-clickup"
    >
      {ok && (
        <p className="proof-count">
          Read <strong style={{ fontVariantNumeric: "tabular-nums" }}>{data.count}</strong> client
          {data.count === 1 ? "" : "s"} from the list.
        </p>
      )}
    </ProofCard>
  );
}

// ─── Proof 3: OpenAI structured-output ───────────────────────────────────────

function OpenAiProof() {
  const [tick, setTick] = useState(0);
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["ads-os-proof-openai", tick],
    queryFn: () => apiRequest("GET", "/api/ads-os/proofs/openai").then((r) => r.json()),
    retry: false,
    staleTime: 0,
  });
  const ok = (data as any)?.ok;
  return (
    <ProofCard
      title="AI analysis (OpenAI)"
      purpose="Confirms the AI service that powers search-term and campaign analysis is responding."
      impact={impactCopy(
        "The AI service isn't responding, so AI-written summaries and recommendations may be unavailable. Re-run in a moment.",
        isError,
        error,
      )}
      isLoading={isLoading}
      isError={isError}
      ok={ok}
      data={data}
      onRefresh={() => setTick((t) => t + 1)}
      testId="proof-openai"
    />
  );
}

// ─── Proof 4: Store round-trip ────────────────────────────────────────────────

function StoreProof() {
  const [tick, setTick] = useState(0);
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["ads-os-proof-store", tick],
    queryFn: () => apiRequest("GET", "/api/ads-os/proofs/store").then((r) => r.json()),
    retry: false,
    staleTime: 0,
  });
  const ok = (data as any)?.ok && (data as any)?.roundtripOk;
  return (
    <ProofCard
      title="Saved settings storage"
      purpose="Checks that per-client criteria and settings can be saved and read back correctly."
      impact={impactCopy(
        "Saved settings can't be written or read right now, so criteria changes may not stick. Re-run in a moment.",
        isError,
        error,
      )}
      isLoading={isLoading}
      isError={isError}
      ok={ok}
      data={data}
      onRefresh={() => setTick((t) => t + 1)}
      testId="proof-store"
    />
  );
}

// ─── Config status strip ─────────────────────────────────────────────────────

function ConfigStrip() {
  const { data } = useQuery({
    queryKey: ["ads-os-status"],
    queryFn: () => apiRequest("GET", "/api/ads-os/status").then((r) => r.json()),
    staleTime: 30_000,
  });
  if (!data) return null;
  const items: { label: string; ok: boolean }[] = [
    { label: "Google Ads", ok: data.googleAds?.configured },
    { label: "ClickUp", ok: data.clickUp?.configured },
    { label: "OpenAI", ok: data.openAi?.configured },
    { label: "Slack", ok: data.slack?.configured },
    { label: "Cron", ok: data.cron?.configured },
  ];
  return (
    <div className="proofs-strip">
      {items.map((it) => (
        <StatusChip key={it.label} ok={it.ok} label={it.label} />
      ))}
    </div>
  );
}

// ─── CEO view: the checks themselves ─────────────────────────────────────────

/** Mounted only for the CEO role so the four check queries (all requireCeo
 *  server-side) never fire — and never 403 — for anyone else. */
function SystemChecks() {
  return (
    <>
      <div className="proofs-head" style={{ marginBottom: 28 }}>
        <h1 data-testid="heading-system-checks">Integration readiness</h1>
        <p className="proofs-sub">
          A live check that Ads OS can reach the services it depends on — Google Ads, ClickUp,
          the AI service and saved-settings storage. Each check is read-only: running one never
          changes a campaign. If everything reads “Ready”, the dashboards and tools have what they
          need.
        </p>
        <ConfigStrip />
      </div>

      <div className="proofs-cards" data-testid="list-system-checks">
        <AccountsProof />
        <ClickUpProof />
        <OpenAiProof />
        <StoreProof />
      </div>

      <p className="proofs-foot">
        These checks only read data — they never change campaigns, and account credentials never
        reach your browser.
      </p>
    </>
  );
}

// ─── Non-CEO view: designed restricted notice ────────────────────────────────

/** Deep links (old bookmarks, pasted URLs) from non-CEO operators land here:
 *  a self-explaining notice in the module's own idiom instead of a wall of
 *  403-failing checks. No check queries are mounted on this branch. */
function RestrictedNotice() {
  return (
    <>
      <div className="proofs-head" style={{ marginBottom: 28 }}>
        <h1 data-testid="heading-system-checks">Integration readiness</h1>
        <p className="proofs-sub">A readiness check for this module's connected services.</p>
      </div>

      <div className="proof-card" data-testid="panel-proofs-restricted">
        <div className="proof-card-head">
          <div>
            <h3>Restricted to the CEO role</h3>
            <p className="proof-card-sub">
              This page checks that the module can reach its connected services (Google Ads,
              ClickUp, the AI service and saved-settings storage). It's read-only — nothing here
              affects client campaigns or needs action from account managers.
            </p>
          </div>
        </div>
        <div>
          <Link href="/ads-os" className="proof-rerun" data-testid="link-proofs-back">
            Back to Main Dashboard
          </Link>
        </div>
      </div>
    </>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function AdsOsProofs() {
  const { user, isLoading } = useAuth();
  const isCeo = user?.role === "ceo";
  return (
    <AdsOsShell>
      <div className="proofs">
        {isLoading ? (
          <p className="proofs-sub" role="status" data-testid="text-checks-auth-loading">
            Checking access…
          </p>
        ) : isCeo ? (
          <SystemChecks />
        ) : (
          <RestrictedNotice />
        )}
      </div>
    </AdsOsShell>
  );
}
