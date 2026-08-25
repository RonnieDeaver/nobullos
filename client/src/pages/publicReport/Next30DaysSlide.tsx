/**
 * Next30DaysSlide — one slide of the public client report.
 * Extracted VERBATIM from client/src/pages/PublicReport.tsx (lines 4449–4571 @ d31d7c0c7, Task #4271).
 * Task #4282 (Backlog #29 + §8.7-11) — redesigned as the deck's climax:
 *   - opening verdict sentence (VerdictLine, slideVerdicts.next30Days),
 *   - owner initials + due hints on both action columns,
 *   - "The Question We're Always Asking" expansion band now CONDITIONAL on
 *     the section's showExpansionQuestion flag (was hardcoded on every
 *     report),
 *   - closing CTA names the account manager with a mailto button
 *     (data.accountManager — null in privacy mode / no owner → generic
 *     closing line).
 */

import { Target, Settings, Crosshair, Users, FileText, Mail } from "lucide-react";
import { Slide } from "./Slide";
import { REPORT_COLORS } from "./reportTokens";
import { VerdictLine } from "./VerdictLine";
import { EmptySlideBand } from "./EmptyState";
import type { PublicReportViewModel } from "./derive";

/** Owner-initials chip + due hint, rendered under an action's why-line. */
function ActionMetaRow({
  owner,
  due,
  tone,
  testIdPrefix,
  index,
}: {
  owner?: unknown;
  due?: unknown;
  tone: "crimson" | "gold";
  testIdPrefix: string;
  index: number;
}) {
  const ownerText = typeof owner === "string" && owner.trim().length > 0 ? owner.trim() : null;
  const dueText = typeof due === "string" && due.trim().length > 0 ? due.trim() : null;
  if (!ownerText && !dueText) return null;
  // Typographic marks, not pills — keeps the editorial register of the deck
  // (and the design ratchets: no new radii/arbitrary sizes).
  const ownerClasses = tone === "crimson" ? "text-report-crimson" : "text-report-ink";
  return (
    <div className="flex items-center flex-wrap gap-4 mt-2">
      {ownerText && (
        <span
          className={`text-xs font-bold uppercase tracking-wide ${ownerClasses}`}
          title="Owner"
          data-testid={`${testIdPrefix}-owner-${index}`}
        >
          {ownerText}
        </span>
      )}
      {dueText && (
        <span className="text-xs text-report-ink-muted" data-testid={`${testIdPrefix}-due-${index}`}>
          Due: {dueText}
        </span>
      )}
    </div>
  );
}

export function Next30DaysSlide({ view }: { view: PublicReportViewModel }) {
  const { actionsSection, data, monthLabel, sectionPresence, slideNumbers } = view;

  // Task #4285 — deck-wide empty-state convention: with no actions in
  // either column, no expansion question, and no notes, the slide collapses
  // to one explanatory band (no empty two-column scaffold + CTA) and its
  // agenda row drops out. A half-empty plan keeps the full layout — each
  // empty column shows its own "No actions defined" line. Hand-built views
  // without the presence map fail open.
  if (!(sectionPresence?.next30 ?? true)) {
    return (
      <Slide slideNumber={slideNumbers.next30} variant="cream" pattern="geometric" id="next-30-days" vCenter>
        <div className="slide-header">
          <Crosshair className="slide-header-icon text-report-crimson" />
          <h2 className="slide-title text-report-ink">Next 30 Days</h2>
        </div>
        <p className="slide-subtitle-light">Clear actions, shared accountability</p>
        <VerdictLine verdict={data.slideVerdicts?.next30Days} slideKey="next30Days" className="mt-2" />
        <EmptySlideBand
          icon={Crosshair}
          monthLabel={monthLabel}
          variant="light"
          testId="empty-next-30-days"
          unlocks="Your action plan appears here once next month's priorities are set."
        />
      </Slide>
    );
  }

  return (
        <Slide slideNumber={slideNumbers.next30} variant="cream" pattern="geometric" id="next-30-days">
          {(() => {
            const ours = actionsSection?.data?.ours || [];
            const theirs = actionsSection?.data?.theirs || [];
            const showExpansionQuestion = actionsSection?.data?.showExpansionQuestion === true;
            const accountManager = data.accountManager || null;
            const amFirstName = accountManager ? accountManager.name.split(/\s+/)[0] : null;
            const mailtoHref = accountManager?.email
              ? `mailto:${accountManager.email}?subject=${encodeURIComponent(`Re: ${monthLabel} report — Next 30 Days`)}`
              : null;

            return (
              <>
                <div className="slide-header">
                  <Crosshair className="slide-header-icon text-report-crimson" />
                  <h2 className="slide-title text-report-ink">Next 30 Days</h2>
                </div>
                <p className="slide-subtitle-light">Clear actions, shared accountability</p>
                {/* Task #4282 — the slide's opening verdict (stored copy only). */}
                <VerdictLine verdict={data.slideVerdicts?.next30Days} slideKey="next30Days" className="mt-2" />
                <div className="divider-thin" style={{ background: `linear-gradient(90deg, transparent, ${REPORT_COLORS.crimson}, transparent)` }} />

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {/* Our Actions (Agency) */}
                  <div className="bg-report-eggshell rounded-xl p-6 border border-report-crimson/20">
                    <div className="bg-report-crimson -m-6 mb-6 p-4 rounded-t-xl">
                      <div className="flex items-center gap-2">
                        <Settings className="w-5 h-5 text-white" />
                        <div className="text-sm uppercase tracking-wider font-bold text-white">Our Actions</div>
                      </div>
                      <div className="text-[11px] text-white/60 mt-1">What we're doing for you</div>
                    </div>
                    
                    <div className="space-y-4">
                      {ours.length > 0 ? (
                        ours.map((item: any, i: number) => (
                          <div key={i} className="bg-white/60 rounded-lg p-4 border-l-4 border-report-crimson" data-testid={`our-action-${i}`}>
                            <div className="flex items-start gap-4">
                              <div className="w-6 h-6 rounded-full bg-report-crimson text-white flex items-center justify-center text-xs font-bold flex-shrink-0 mt-1">
                                {i + 1}
                              </div>
                              <div>
                                <div className="font-medium text-report-ink text-sm">{item.action}</div>
                                {typeof item.why === "string" && item.why.trim().length > 0 && (
                                  <div className="text-[11px] text-report-ink-muted mt-1 italic">Why: {item.why}</div>
                                )}
                                <ActionMetaRow owner={item.owner} due={item.due} tone="crimson" testIdPrefix="our-action" index={i} />
                              </div>
                            </div>
                          </div>
                        ))
                      ) : (
                        <div className="bg-white/60 rounded-lg p-4 text-center text-report-ink-muted">No actions defined</div>
                      )}
                    </div>
                  </div>

                  {/* Their Actions (Client) */}
                  <div className="bg-report-gold/10 rounded-xl p-6 border-2 border-report-gold/40">
                    <div className="bg-report-gold -m-6 mb-6 p-4 rounded-t-xl">
                      <div className="flex items-center gap-2">
                        {/* Task #4542 — ink-on-gold (audit R1): white-on-gold was 2.12:1; matches the "Email …" button treatment. */}
                        <Users className="w-5 h-5 text-report-ink" />
                        <div className="text-sm uppercase tracking-wider font-bold text-report-ink">Your Actions</div>
                      </div>
                      <div className="text-xs text-report-ink/80 mt-1">What we need from you</div>
                    </div>
                    
                    <div className="space-y-4">
                      {theirs.length > 0 ? (
                        theirs.map((item: any, i: number) => (
                          <div key={i} className="bg-white/80 rounded-lg p-4 border-l-4 border-report-gold" data-testid={`your-action-${i}`}>
                            <div className="flex items-start gap-4">
                              <div className="w-6 h-6 rounded-full bg-report-gold text-report-ink flex items-center justify-center text-xs font-bold flex-shrink-0 mt-1">
                                {i + 1}
                              </div>
                              <div>
                                <div className="font-medium text-report-ink text-sm">{item.action}</div>
                                {typeof item.why === "string" && item.why.trim().length > 0 && (
                                  <div className="text-[11px] text-report-ink-muted mt-1 italic">Why: {item.why}</div>
                                )}
                                <ActionMetaRow owner={item.owner} due={item.due} tone="gold" testIdPrefix="your-action" index={i} />
                              </div>
                            </div>
                          </div>
                        ))
                      ) : (
                        <div className="bg-white/80 rounded-lg p-4 text-center text-report-ink-muted">No actions defined</div>
                      )}
                    </div>
                  </div>
                </div>

                {/* Guiding Philosophy Callout — Task #4282: renders ONLY when the
                    operator flags that expansion is genuinely on the table for
                    this report (was hardcoded on every report before). */}
                {showExpansionQuestion && (
                  <div className="mt-6 bg-gradient-to-r from-report-gold/20 to-report-gold/10 rounded-xl p-6 border border-report-gold/40" data-testid="expansion-question-band">
                    <div className="flex items-start gap-4">
                      <div className="w-10 h-10 rounded-full bg-report-gold flex items-center justify-center flex-shrink-0">
                        <Target className="w-5 h-5 text-white" />
                      </div>
                      <div>
                        <div className="text-report-crimson font-bold text-sm mb-1">The Question We're Always Asking</div>
                        <div className="text-report-ink italic text-sm leading-relaxed">
                          "What's stopping you from spending more and/or expanding locations to increase your geographic reach?"
                        </div>
                        <div className="text-report-ink-muted text-xs mt-2">
                          Every recommendation above points back to removing that barrier.
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {actionsSection?.data?.showNotes && actionsSection?.data?.notes?.trim() && (
                  <div className="mt-6 bg-white/80 rounded-xl p-6 border border-report-crimson/15" data-testid="section-notes">
                    <div className="flex items-start gap-4">
                      <div className="w-8 h-8 rounded-full bg-report-crimson/10 flex items-center justify-center flex-shrink-0">
                        <FileText className="w-4 h-4 text-report-crimson" />
                      </div>
                      <div>
                        <div className="text-report-crimson font-bold text-sm mb-2">Notes</div>
                        <div className="text-report-ink text-sm leading-relaxed whitespace-pre-wrap">{actionsSection.data.notes}</div>
                      </div>
                    </div>
                  </div>
                )}

                {/* Closing CTA — Task #4282: the deck ends with a person, not a
                    platitude. Account manager resolved server-side; null
                    (privacy mode, no owner, pre-#4282 payloads) degrades to
                    the original generic closing line. */}
                <div className="mt-6 bg-report-crimson p-6 text-center" data-testid="closing-cta">
                  {accountManager ? (
                    <>
                      <div className="text-white text-base font-semibold" data-testid="text-cta-am">
                        Questions on this plan? Talk to {accountManager.name}.
                      </div>
                      <div className="text-white/80 text-sm mt-1">
                        Your account manager owns every action on the left column.
                      </div>
                      {mailtoHref && (
                        <a
                          href={mailtoHref}
                          className="inline-flex items-center gap-2 bg-report-gold text-report-ink font-bold text-sm px-6 py-2 mt-4 hover:opacity-90 transition-opacity"
                          data-testid="button-email-am"
                        >
                          <Mail className="w-4 h-4" />
                          Email {amFirstName}
                        </a>
                      )}
                    </>
                  ) : (
                    <div className="text-white/80 text-sm">Questions? Let's align on priorities and timelines.</div>
                  )}
                  <div className="flex items-center justify-center gap-4 text-[11px] text-white/50 uppercase tracking-wider mt-4">
                    <span>Confidential</span>
                    <span className="w-1 h-1 rounded-full bg-report-gold" />
                    <span>{monthLabel}</span>
                  </div>
                </div>
              </>
            );
          })()}
        </Slide>
  );
}
