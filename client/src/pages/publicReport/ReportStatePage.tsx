/**
 * ReportStatePage — branded full-page states for the public report surface
 * (Task #4283, audit backlog #12 remainder; design system §8.6).
 *
 * Replaces the unbranded "Report Not Found / Report Not Ready" card in
 * PublicReport.tsx. Every state a client can land on (expired/invalid link,
 * report still in preparation, load failure) renders the NoBull treatment:
 * crimson masthead with the white logo (the cover-slide field), a
 * crimson-framed paper card, client-appropriate copy — ZERO operator
 * vocabulary ("finalized", "draft", "token") — and a working recovery CTA
 * (mailto to the client-service inbox; "Try again" for transient failures).
 *
 * The "login" state is the one staff-facing flavor (authed /preview/:reportId
 * route only); it gets the same visual treatment for consistency.
 *
 * Deliberately static (no framer-motion): these pages must be print-safe and
 * reduced-motion-safe by construction, and there is nothing to choreograph.
 */

import { Mail, RefreshCw } from "lucide-react";

export type ReportStateKind = "expired" | "not-ready" | "error" | "login";

/**
 * Maps the share/preview query's error message onto a page state. The client
 * keys off the server's stable error strings (server/routes/reports.ts):
 *   404 → "Report not found"                      → expired/invalid link
 *   403 → "…not yet finalized…"                   → report in preparation
 *   401 → "Unauthorized" (authed preview only)    → staff login
 *   anything else (500 body, network failure)     → load failure
 */
export function resolveReportStateKind(message: string | undefined): ReportStateKind {
  const msg = message ?? "";
  if (msg.includes("not yet finalized")) return "not-ready";
  if (msg.includes("Unauthorized")) return "login";
  if (msg.includes("Report not found")) return "expired";
  return "error";
}

/** Client-service inbox (see server/services/companyIdentity.ts company set).
 * Chosen over team@ for the client-facing voice; single-constant swap if the
 * routing preference changes. */
export const REPORT_CONTACT_EMAIL = "heretoserve@nobullmarketing.com";

const WHITE_LOGO = "/assets/NoBull.Primary.Logo.White_1768864291629.png";

/** Cover-slide plus-tile pattern (identical data-URI) — echoed in the masthead. */
const PLUS_TILE = `url("data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%23ffffff' fill-opacity='1'%3E%3Cpath d='M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E")`;

function mailtoHref(subject: string, body: string): string {
  return `mailto:${REPORT_CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

interface StateContent {
  title: string;
  body: string;
  /** Primary mailto CTA (client states). */
  email?: { label: string; subject: string; mailBody: string };
  /** Show the reload button (load-failure state; email demotes to text link). */
  retry?: boolean;
  /** Staff sign-in link (preview route only). */
  signIn?: boolean;
}

const CONTENT: Record<ReportStateKind, StateContent> = {
  expired: {
    title: "This report link has expired",
    body: "Report links are refreshed from time to time to keep your numbers private. Your account manager can send you a fresh one right away.",
    email: {
      label: "Request a new link",
      subject: "New report link request",
      mailBody: "Hi — my report link is no longer working. Could you send me a fresh one?",
    },
  },
  "not-ready": {
    title: "Your report is almost ready",
    body: "We're putting the finishing touches on this month's numbers. Your report will appear right here the moment it's published — or your account manager can let you know as soon as it's live.",
    email: {
      label: "Ask when it's ready",
      subject: "When will my report be ready?",
      mailBody: "Hi — my report link says it's still being prepared. Could you let me know when it's ready?",
    },
  },
  error: {
    title: "We couldn't load your report",
    body: "Something went wrong on our end — it's usually temporary. Try again in a moment, or let your account manager know if it keeps happening.",
    retry: true,
    email: {
      label: "Email your account manager",
      subject: "Trouble viewing my report",
      mailBody: "Hi — my report page isn't loading. Could you take a look?",
    },
  },
  login: {
    title: "Sign in to preview this report",
    body: "This preview is only available to the NoBull team. Sign in to your account, then reload this page.",
    signIn: true,
  },
};

const PRIMARY_BUTTON_CLASSES =
  "inline-flex items-center justify-center gap-2 bg-report-crimson text-white hover:bg-report-crimson-deep " +
  "px-6 py-4 text-sm font-semibold transition-colors focus-visible:outline-2 " +
  "focus-visible:outline-offset-2 focus-visible:outline-report-crimson";

export function ReportStatePage({ kind }: { kind: ReportStateKind }) {
  const content = CONTENT[kind];
  const email = content.email;
  const emailHref = email ? mailtoHref(email.subject, email.mailBody) : undefined;

  return (
    <div
      className="report-surface min-h-screen slide-beige flex flex-col items-center justify-center px-4 py-12"
      data-testid="report-state-page"
      data-state={kind}
    >
      <div
        className="w-full max-w-lg overflow-hidden bg-report-paper shadow-xl"
        style={{
          borderRadius: "var(--report-radius)",
          border: "1px solid color-mix(in srgb, var(--report-crimson) 45%, transparent)",
        }}
      >
        {/* Crimson masthead — the cover slide's brand field in miniature. */}
        <div
          className="relative flex items-center justify-center px-8 py-6"
          style={{
            background:
              "linear-gradient(135deg, var(--report-crimson) 0%, var(--report-crimson-deep) 50%, var(--report-crimson-shadow) 100%)",
          }}
        >
          <div className="absolute inset-0 opacity-5" style={{ backgroundImage: PLUS_TILE }} />
          <div className="absolute top-2.5 left-2.5 h-6 w-6 border-t-2 border-l-2 border-report-gold/60" />
          <div className="absolute bottom-2.5 right-2.5 h-6 w-6 border-b-2 border-r-2 border-report-gold/60" />
          <img
            src={WHITE_LOGO}
            alt="NoBull Marketing"
            className="relative h-9 w-auto"
            data-testid="report-state-logo"
          />
        </div>

        {/* Paper body */}
        <div className="px-6 py-8 text-center sm:px-10">
          <div className="section-label-muted mb-4">Revenue Engine Report</div>
          <h1
            className="font-report-serif text-2xl font-bold leading-tight text-report-crimson mb-4"
            data-testid="report-state-title"
          >
            {content.title}
          </h1>
          <div className="mx-auto mb-4 h-0.5 w-12 bg-report-gold" />
          <p className="mx-auto mb-6 max-w-sm text-body leading-relaxed text-report-ink-muted">
            {content.body}
          </p>

          <div className="flex flex-col items-center gap-4">
            {content.retry && (
              <button
                type="button"
                onClick={() => window.location.reload()}
                className={PRIMARY_BUTTON_CLASSES}
                style={{ borderRadius: "var(--report-radius)" }}
                data-testid="report-state-retry"
              >
                <RefreshCw className="h-4 w-4" aria-hidden="true" />
                Try again
              </button>
            )}

            {email && !content.retry && (
              <a
                href={emailHref}
                className={PRIMARY_BUTTON_CLASSES}
                style={{ borderRadius: "var(--report-radius)" }}
                data-testid="report-state-cta-email"
              >
                <Mail className="h-4 w-4" aria-hidden="true" />
                {email.label}
              </a>
            )}

            {email && content.retry && (
              <a
                href={emailHref}
                className="text-sm font-medium text-report-crimson underline underline-offset-4 hover:text-report-crimson-deep"
                data-testid="report-state-cta-email"
              >
                {email.label}
              </a>
            )}

            {content.signIn && (
              <a
                href="/"
                className={PRIMARY_BUTTON_CLASSES}
                style={{ borderRadius: "var(--report-radius)" }}
                data-testid="report-state-cta-signin"
              >
                Go to sign in
              </a>
            )}
          </div>

          {email && (
            <div className="mt-4 text-xs text-report-ink-muted" data-testid="report-state-email-plain">
              {REPORT_CONTACT_EMAIL}
            </div>
          )}
        </div>
      </div>

      <div className="mt-6 text-caption font-medium uppercase tracking-[0.2em] text-report-ink-muted">
        nobullmarketing.com
      </div>
    </div>
  );
}
