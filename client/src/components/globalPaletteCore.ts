// -------------------------------------------------------------------------------------
// Global command palette — pure core (Task #4376)
// -------------------------------------------------------------------------------------
// Shared, render-free logic for the app-wide ⌘K palette. Kept dependency-light
// (lucide icons + types only) so both the eager shell (GlobalCommandPalette)
// and the lazy dialog (GlobalCommandPaletteDialog) can import it without
// cycles, and so tests can exercise the role gating and shortcut-ownership
// rules directly.
//
// Destinations are NEVER listed here — they derive from QUICKLINKS_MANIFEST
// (already role-filtered by the caller), so there is no second hand-maintained
// list to rot (audit §8.4-a).
// -------------------------------------------------------------------------------------

import { Home } from "lucide-react";
import type { QuicklinkContext, QuicklinkItem } from "@/components/QuicklinksBar";

/** Minimal user shape needed to derive quicklink gating. Matches the fields
 *  GlobalAppNav reads off the authed `/api/auth/user` record. */
export interface QuicklinkUserShape {
  role?: string | null;
  authorityLevel?: string | null;
  functions?: string[] | null;
}

/**
 * Derives the QuicklinkContext used by QUICKLINKS_MANIFEST `isVisible`
 * predicates. Extracted verbatim from GlobalAppNav (Task #4376) so the global
 * command palette and the nav share EXACTLY the same gating — if these ever
 * diverged, the palette could leak admin destinations the nav hides.
 */
export function buildQuicklinkContext(user: QuicklinkUserShape): QuicklinkContext {
  const isCeo = user.role === "ceo";
  const isTeamLead = user.role === "team_lead" || isCeo;
  // Task #2367 — RIS is owned by the Reporting role; anyone at `lead`
  // authority and above (lead / director / ceo) keeps oversight. Mirrors
  // server canAccessRIS (minus permissive mode, which the server still
  // enforces on every request) — director authority must see the entry too.
  const authority = user.authorityLevel;
  const isLeadPlus =
    authority === "lead" || authority === "director" || authority === "ceo";
  const canRis =
    isTeamLead ||
    isLeadPlus ||
    (user.functions ?? []).includes("reporting_expert");
  // Task #3691 — Churn Command Center is director+ only. Mirrors the strict
  // server gate canAccessChurnCommandCenter (legacy role "ceo" bridges to
  // ceo authority; permissive mode does NOT elevate anyone to director).
  const isDirector =
    isCeo || authority === "director" || authority === "ceo";
  // Task #4337 — mirrors server requireAccountManager (role ladder
  // account_manager < team_lead < ceo; "director" kept for parity with the
  // Leads view's client-side canManage check).
  const isAccountManager =
    isTeamLead ||
    user.role === "account_manager" ||
    user.role === "director";
  return { isTeamLead, isCeo, canRis, isDirector, isAccountManager };
}

// -------------------------------------------------------------------------------------
// Function-based tool groups (Task #4763)
// -------------------------------------------------------------------------------------

/**
 * THE ordered source of truth for the tool-menu sections. Every tool-menu
 * surface — the desktop "More" dropdown, the mobile hamburger sheet, and the
 * ⌘K palette groups below — derives its sections by iterating this list, so
 * a regrouping or reorder lands on all three at once and they can never
 * disagree. Each QUICKLINKS_MANIFEST item opts into one group via its
 * `cluster` field; the two non-tool clusters ("create" and "navigate") feed
 * the "+ New" menu and the inline primary band / Navigate section instead.
 */
export const QUICKLINK_TOOL_GROUPS = [
  { key: "crm", label: "CRM" },
  { key: "client-management", label: "Client Management" },
  { key: "workspace", label: "Workspace" },
  { key: "team", label: "Team" },
  { key: "system-admin", label: "System Admin" },
] as const;

export type QuicklinkToolGroupKey = (typeof QUICKLINK_TOOL_GROUPS)[number]["key"];

export interface PaletteDestination {
  id: string;
  label: string;
  href: string;
  icon: QuicklinkItem["icon"];
}

export interface PaletteGroup {
  heading: string;
  destinations: PaletteDestination[];
}

/**
 * Groups already-role-filtered manifest items into palette sections. Mirrors
 * the nav menus' taxonomy (Navigate = Dashboard + the "navigate" cluster,
 * then Create, then the five function-based QUICKLINK_TOOL_GROUPS in order —
 * Task #4763) so the palette and nav present the same mental model.
 * Dashboard is the one synthetic entry: like the header's dedicated
 * Dashboard link, it lives outside QUICKLINKS_MANIFEST.
 */
export function buildPaletteGroups(items: QuicklinkItem[]): PaletteGroup[] {
  const byCluster = (cluster: QuicklinkItem["cluster"]): PaletteDestination[] =>
    items
      .filter((i) => i.cluster === cluster)
      .map(({ id, label, href, icon }) => ({ id, label, href, icon }));
  const groups: PaletteGroup[] = [
    {
      heading: "Navigate",
      destinations: [
        { id: "dashboard", label: "Dashboard", href: "/", icon: Home },
        ...byCluster("navigate"),
      ],
    },
    { heading: "Create", destinations: byCluster("create") },
    ...QUICKLINK_TOOL_GROUPS.map(({ key, label }) => ({
      heading: label,
      destinations: byCluster(key),
    })),
  ];
  return groups.filter((g) => g.destinations.length > 0);
}

// -------------------------------------------------------------------------------------
// Palette actions (Task #4494)
// -------------------------------------------------------------------------------------
// Action commands (run/trigger verbs) surfaced in the palette's "Actions"
// group. Like destinations, actions are NEVER listed here — each one is
// declared on its owning QUICKLINKS_MANIFEST item (`paletteActions` /
// `paletteClientActions`), so role gating derives from the item's own
// `isVisible` predicate and there is no second hand-maintained list to rot.
// The collectors below just flatten the already-role-filtered items.

/** Side-effect seams handed to an action's `run` — kept minimal so manifest
 *  declarations stay render-free and tests can pass fakes. */
export interface PaletteActionDeps {
  navigate: (href: string) => void;
  toast: (opts: { title: string; description?: string; variant?: "destructive" }) => void;
}

/** Narrow client shape client-scoped actions receive (matches the palette's
 *  /api/clients slice). */
export interface PaletteActionClient {
  id: string;
  firmName: string;
}

/** A global (client-independent) action command. */
export interface PaletteGlobalAction {
  id: string;
  label: string;
  icon: QuicklinkItem["icon"];
  /** Present ⇒ the palette shows an explicit keyboard confirm step before
   *  running (required for destructive / side-effecting verbs). */
  confirm?: string;
  run: (deps: PaletteActionDeps) => void | Promise<void>;
}

/** A client-scoped action template, instantiated against the top client
 *  match while the user is searching. */
export interface PaletteClientActionTemplate {
  id: string;
  label: (client: PaletteActionClient) => string;
  icon: QuicklinkItem["icon"];
  confirm?: (client: PaletteActionClient) => string;
  run: (client: PaletteActionClient, deps: PaletteActionDeps) => void | Promise<void>;
}

/** Flattens global actions off already-role-filtered manifest items. */
export function collectPaletteActions(items: QuicklinkItem[]): PaletteGlobalAction[] {
  return items.flatMap((i) => i.paletteActions ?? []);
}

/** Flattens client-scoped action templates off already-role-filtered items. */
export function collectPaletteClientActions(
  items: QuicklinkItem[],
): PaletteClientActionTemplate[] {
  return items.flatMap((i) => i.paletteClientActions ?? []);
}

// Route subtrees whose own module already binds Cmd/Ctrl+K. The global
// palette must NOT contest the shortcut there (its nav affordance still
// works everywhere):
//   /ads-os — AdsOsShell toggles the module command palette (module-specific
//             actions stay, per audit §8.4-a promotion note).
//   /comms  — CommsSidebar focuses the channel-search filter (Task #3399).
const MODULE_SHORTCUT_OWNER_PREFIXES = ["/ads-os", "/comms"] as const;

/** True when the GLOBAL palette owns Cmd/Ctrl+K at this pathname. */
export function globalPaletteOwnsShortcut(pathname: string): boolean {
  return !MODULE_SHORTCUT_OWNER_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/**
 * True when a keydown originated inside an editable control. The global
 * shortcut never fires from inputs/textareas/contenteditables — same
 * discipline as the comms channel-search shortcut (composer typing and the
 * Sheets/Docs editors keep their keystrokes).
 */
export function isEditableShortcutTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

/** Platform-aware shortcut hint for the nav affordance ("⌘K" vs "Ctrl K"). */
export function isApplePlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const probe = `${navigator.platform ?? ""} ${navigator.userAgent ?? ""}`;
  return /Mac|iPhone|iPad|iPod/i.test(probe);
}
