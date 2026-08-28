import { Link, useLocation } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { BrandMark } from "@/components/kit/BrandMark";
import { Button } from "@/components/ui/button";
import PrefetchLink from "@/components/PrefetchLink";
import { GlobalCommandPalette } from "@/components/GlobalCommandPalette";
import {
  buildQuicklinkContext,
  QUICKLINK_TOOL_GROUPS,
  type QuicklinkToolGroupKey,
  type PaletteGlobalAction,
  type PaletteClientActionTemplate,
} from "@/components/globalPaletteCore";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
  DropdownMenuLabel, DropdownMenuSeparator,
  DropdownMenuSub, DropdownMenuSubTrigger, DropdownMenuSubContent,
  DropdownMenuRadioGroup, DropdownMenuRadioItem,
} from "@/components/ui/dropdown-menu";
import {
  Building2, TrendingUp, Settings, Plus, Sliders,
  BarChart3, UserPlus, PieChart, Webhook, LayoutGrid, HardDriveDownload,
  MessageSquare, Plug, Users, UserCog, Activity, MoreHorizontal, Hash,
  LogOut, Menu, Home, Inbox, MessageSquarePlus, ShieldCheck, FileSpreadsheet,
  ClipboardList, Radar, Signpost, Gauge, FolderOpen, Briefcase, Tags, Magnet, Megaphone, Zap, Send,
  MapPin, Sun, Moon, Monitor, BookOpenCheck, PhoneCall, UserCheck,
} from "lucide-react";
import { useTheme, isThemePreference } from "@/lib/theme";

// -------------------------------------------------------------------------------------
// Shared quicklinks manifest
// -------------------------------------------------------------------------------------
// Task #814 introduced current-page highlighting on the dashboard quicklinks bar.
// Task #1254 extracted the manifest + render helpers here so the same bar (and the
// same active-state treatment) can be reused above non-dashboard pages.
//
// Each item's `isVisible` predicate must preserve the EXACT gating that existed in
// the pre-refactor flat button row. Do not collapse a compound predicate into a
// simple role check unless the original behavior really was role-only. Hrefs,
// icons, and `data-testid` values must remain stable so existing tests keep
// finding the same controls.
//
// `activeMatch` lets an item own a route subtree (e.g. `/admin/clients` lights up
// on `/admin/clients/123`). Default behavior is an exact pathname match against
// `href`.
// -------------------------------------------------------------------------------------
import { Fragment, Suspense } from "react";
import { lazyWithRetry } from "@/lib/lazyWithRetry";
// Task #4482: the skip lists + shouldRenderGlobalQuicklinksBar live in
// lib/quicklinksVisibility so App/CommsContext can gate on them without
// statically importing this (now-lazy) nav module. Re-exported here so
// existing import sites/tests keep working.
export { shouldRenderGlobalQuicklinksBar } from "@/lib/quicklinksVisibility";
import { shouldRenderGlobalQuicklinksBar } from "@/lib/quicklinksVisibility";

// "create" fills the "+ New" menu; "navigate" fills the inline primary band
// (PRIMARY_INLINE_IDS) plus the palette/mobile Navigate section. Every other
// item carries one of the five function-based tool-group keys from
// QUICKLINK_TOOL_GROUPS (globalPaletteCore) — the single ordered list all
// three tool-menu surfaces (More dropdown, hamburger sheet, ⌘K palette)
// render their sections from (Task #4763).
export type QuicklinkClusterId = "create" | "navigate" | QuicklinkToolGroupKey;

export interface QuicklinkContext {
  isTeamLead: boolean;
  isCeo: boolean;
  canRis: boolean;
  /** Task #3691 — director+ authority (director/ceo). Gates the Churn
   *  Command Center entry; mirrors the STRICT server gate
   *  canAccessChurnCommandCenter, which does not open under permissive
   *  mode. */
  isDirector: boolean;
  /** Task #4337 — account_manager role or above. Gates Campaigns, whose
   *  server routes are ALL requireAccountManager (aggregate revenue). */
  isAccountManager: boolean;
}

export interface QuicklinkItem {
  id: string;
  label: string;
  href: string;
  icon: typeof Plus;
  cluster: QuicklinkClusterId;
  buttonTestId: string;
  menuTestId?: string;
  prefetch?: boolean;
  primary?: boolean;
  isVisible: (ctx: QuicklinkContext) => boolean;
  activeMatch?: (pathname: string) => boolean;
  /** Task #4494 — global ⌘K palette action commands owned by this feature.
   *  Gating derives from this item's `isVisible`; there is no separate
   *  action list (same manifest-derivation principle as destinations). */
  paletteActions?: PaletteGlobalAction[];
  /** Task #4494 — client-scoped ⌘K action templates owned by this feature
   *  (instantiated against the palette's top client match). */
  paletteClientActions?: PaletteClientActionTemplate[];
}

export function isItemActive(item: QuicklinkItem, pathname: string): boolean {
  if (item.activeMatch) return item.activeMatch(pathname);
  return pathname === item.href;
}

const NEW_REPORT_CLIENT_ACTION: PaletteClientActionTemplate = {
  id: "new-report-for-client",
  label: (c) => `New report for ${c.firmName}`,
  icon: Plus,
  run: (c, { navigate }) => navigate(`/reports/new?clientId=${encodeURIComponent(c.id)}`),
};
// Hoisted above the manifest (which references them at module evaluation) — module-scope
// consts below the manifest are in TDZ when the array initializer runs (TS2448 + post-login
// crash). NOTE: three separate task rebases (#4464, #4286, this one) each had this hoist
// silently reverted to ancestor placement by completion auto-merge — if you see the consts
// back below QUICKLINKS_MANIFEST, re-hoist; do not trust commit messages claiming it fixed.
const GOOGLE_ADS_SYNC_NOW_ACTION: PaletteGlobalAction = {
  id: "google-ads-sync-now",
  label: "Run Google Ads sync now",
  icon: TrendingUp,
  confirm: "Run a Google Ads sync now? This pulls live data for every sync-enabled customer.",
  run: async ({ toast }) => {
    try {
      const res = await fetch("/api/integrations/google-ads/sync-now", {
        method: "POST",
        credentials: "include",
      });
      const body: any = await res.json().catch(() => null);
      if (!res.ok) {
        toast({
          title: "Google Ads sync failed",
          description: body?.error ?? `Request failed (HTTP ${res.status}).`,
          variant: "destructive",
        });
        return;
      }
      if (body?.skipped) {
        toast({ title: "Google Ads sync skipped", description: String(body.reason ?? "") });
        return;
      }
      toast({
        title: "Google Ads sync finished",
        description: `${body?.customersSynced ?? 0} customer(s) synced.`,
      });
    } catch {
      toast({
        title: "Google Ads sync failed",
        description: "Check your connection and try again.",
        variant: "destructive",
      });
    }
  },
};

const OPEN_LATEST_REPORT_CLIENT_ACTION: PaletteClientActionTemplate = {
  id: "open-latest-report",
  label: (c) => `Open latest report for ${c.firmName}`,
  icon: LayoutGrid,
  run: async (c, { navigate, toast }) => {
    try {
      const res = await fetch(`/api/clients/${encodeURIComponent(c.id)}/reports`, {
        credentials: "include",
      });
      if (!res.ok) {
        toast({
          title: "Couldn't load reports",
          description: `Request failed (HTTP ${res.status}) — try again from the client panel.`,
          variant: "destructive",
        });
        return;
      }
      const reports: Array<{ id: string }> = await res.json();
      if (!Array.isArray(reports) || reports.length === 0) {
        toast({
          title: `No reports yet for ${c.firmName}`,
          description: "Start one with “New report” from the ⌘K palette.",
        });
        return;
      }
      // Server orders by reportMonth DESC — first row is the latest.
      navigate(`/reports/${reports[0].id}`);
    } catch {
      toast({
        title: "Couldn't load reports",
        description: "Check your connection and try again.",
        variant: "destructive",
      });
    }
  },
};

export const QUICKLINKS_MANIFEST: QuicklinkItem[] = [
  // Create
  { id: "add-client", label: "New Client", href: "/clients/add", icon: Building2, cluster: "create", buttonTestId: "button-add-client", menuTestId: "menu-add-client", isVisible: () => true },
  { id: "new-report", label: "New Report", href: "/reports/new", icon: Plus, cluster: "create", buttonTestId: "button-new-report", menuTestId: "menu-new-report", primary: true, isVisible: () => true, paletteClientActions: [NEW_REPORT_CLIENT_ACTION] },
  { id: "add-user", label: "New User", href: "/admin/users", icon: UserPlus, cluster: "create", buttonTestId: "button-add-user", menuTestId: "menu-add-user", isVisible: ({ isTeamLead }) => isTeamLead },
  { id: "ceo-pulse", label: "Brief", href: "/admin/ceo-pulse", icon: TrendingUp, cluster: "create", buttonTestId: "button-ceo-pulse", menuTestId: "menu-ceo-pulse", prefetch: true, isVisible: ({ isCeo }) => isCeo },

  // Navigate — the inline primary band (PRIMARY_INLINE_IDS) plus the
  // palette/mobile Navigate section. Every non-create item below instead
  // carries one of the five function-based QUICKLINK_TOOL_GROUPS keys
  // (Task #4763); within a group, manifest order is menu order.
  { id: "all-reports", label: "All Reports", href: "/reports/matrix", icon: LayoutGrid, cluster: "navigate", buttonTestId: "button-all-reports", menuTestId: "menu-all-reports", isVisible: () => true, paletteClientActions: [OPEN_LATEST_REPORT_CLIENT_ACTION] },
  // Task #4373 (audit §8.4-b): one communication surface — /comms serves team
  // chat AND client texts/calls (retired /conversations redirects there).
  { id: "comms", label: "Comms", href: "/comms", icon: MessageSquare, cluster: "navigate", buttonTestId: "button-comms", menuTestId: "menu-comms", isVisible: () => true, activeMatch: (p) => p === "/comms" || p.startsWith("/comms/") || p === "/conversations" || p.startsWith("/conversations/") },

  // CRM — the deal pipeline: sales objects, their configuration
  // (Scoring/Automations/Sequences are pipeline config, not platform admin —
  // deliberate Task #4763 placement call), and the sales-side MCU tools.
  // Task #4327 — deals pipeline board.
  { id: "deals", label: "Deals", href: "/deals", icon: Briefcase, cluster: "crm", buttonTestId: "button-deals", menuTestId: "menu-deals", isVisible: () => true, activeMatch: (p) => p === "/deals" || p.startsWith("/deals/") },
  // Task #4330 — leads view (lifecycle-gated prospects from inquiries/bookings).
  { id: "leads", label: "Leads", href: "/leads", icon: Magnet, cluster: "crm", buttonTestId: "button-leads", menuTestId: "menu-leads", isVisible: () => true, activeMatch: (p) => p === "/leads" || p.startsWith("/leads/") },
  // Task #4337 — campaigns & first-touch attribution (AM+ server gate).
  { id: "campaigns", label: "Campaigns", href: "/campaigns", icon: Megaphone, cluster: "crm", buttonTestId: "button-campaigns", menuTestId: "menu-campaigns", isVisible: ({ isAccountManager }) => isAccountManager, activeMatch: (p) => p === "/campaigns" || p.startsWith("/campaigns/") },
  { id: "email-sequences", label: "Sequences", href: "/admin/email-sequences", icon: Send, cluster: "crm", buttonTestId: "button-email-sequences", menuTestId: "menu-email-sequences", isVisible: ({ isTeamLead }) => isTeamLead },
  // Task #4333 — deal & lead scoring config (point rules + recompute status).
  { id: "scoring", label: "Scoring", href: "/admin/scoring", icon: Gauge, cluster: "crm", buttonTestId: "button-scoring", menuTestId: "menu-scoring", isVisible: ({ isTeamLead }) => isTeamLead, activeMatch: (p) => p === "/admin/scoring" },
  // Task #4331 — deal stage automation rules (trigger stage + bounded actions).
  { id: "deal-automation", label: "Automations", href: "/admin/deal-automation", icon: Zap, cluster: "crm", buttonTestId: "button-deal-automation", menuTestId: "menu-deal-automation", isVisible: ({ isTeamLead }) => isTeamLead },
  { id: "mcu-dashboard", label: "MCU", href: "/mcu-dashboard", icon: BarChart3, cluster: "crm", buttonTestId: "button-mcu-dashboard", menuTestId: "menu-mcu-dashboard", prefetch: true, isVisible: ({ isCeo }) => isCeo },
  // Task #4370 — MCU Checker adopted into the nav (design audit P2-4,
  // decision §8.4-d: adopt). Grouped with — and gated like — the MCU
  // dashboard entry above. The /mcu-checker ROUTE stays public
  // (lib/publicPaths.ts) for signed-out sales use; this entry only governs
  // discoverability in the internal nav.
  { id: "mcu-checker", label: "MCU Checker", href: "/mcu-checker", icon: MapPin, cluster: "crm", buttonTestId: "button-mcu-checker", menuTestId: "menu-mcu-checker", prefetch: true, isVisible: ({ isCeo }) => isCeo },
  // Task #5298 (stage 4 of the New Client Onboarding epic) — the sales
  // intake entry point: capture a new client's info + call notes and book
  // them immediately against the onboarding pool. Any authenticated staff
  // member can place a sales call, matching the "add-client" gate.
  { id: "onboarding-intake", label: "Onboarding Call", href: "/onboarding-intake", icon: PhoneCall, cluster: "crm", buttonTestId: "button-onboarding-intake", menuTestId: "menu-onboarding-intake", isVisible: () => true },

  // Client Management — operating live client accounts + client-facing
  // market intel (Tags and Insights are client-portfolio tools — deliberate
  // Task #4763 placement call).
  { id: "manage-clients", label: "Client Admin", href: "/admin/clients", icon: Settings, cluster: "client-management", buttonTestId: "button-manage-clients", menuTestId: "menu-manage-clients", prefetch: true, isVisible: ({ isTeamLead }) => isTeamLead, activeMatch: (p) => p === "/admin/clients" || p.startsWith("/admin/clients/") },
  { id: "ris", label: "RIS", href: "/ris", icon: ShieldCheck, cluster: "client-management", buttonTestId: "button-ris", menuTestId: "menu-ris", prefetch: true, isVisible: ({ canRis }) => canRis, activeMatch: (p) => p === "/ris" || p.startsWith("/ris/") },
  // Task #3691 — Churn Command Center: portfolio churn early-warning hub,
  // director+ only (strict gate — no permissive-mode opening).
  { id: "churn-command-center", label: "Churn Command Center", href: "/churn", icon: Radar, cluster: "client-management", buttonTestId: "button-churn-command-center", menuTestId: "menu-churn-command-center", prefetch: true, isVisible: ({ isDirector }) => isDirector, activeMatch: (p) => p === "/churn" || p.startsWith("/churn/") },
  { id: "ceo-insights", label: "Insights", href: "/ceo/insights", icon: PieChart, cluster: "client-management", buttonTestId: "button-ceo-insights", menuTestId: "menu-ceo-insights", isVisible: ({ isCeo }) => isCeo },
  // Legacy /admin/ads-os entry removed (Task #3603) — the rebuilt module at
  // /ads-os is the only Google Ads OS surface. Test ids kept stable.
  // Task #4977 — Ads OS reads are open to all staff (routes are
  // requireAccountManager), so the nav entry matches: AM tier and up see it.
  { id: "ads-os-v2", label: "Ads OS", href: "/ads-os", icon: TrendingUp, cluster: "client-management", buttonTestId: "button-ads-os-v2", menuTestId: "menu-ads-os-v2", isVisible: ({ isAccountManager }) => isAccountManager, activeMatch: (p) => p === "/ads-os" || p.startsWith("/ads-os/") },
  { id: "practice-areas", label: "Practice Areas", href: "/admin/practice-areas", icon: Sliders, cluster: "client-management", buttonTestId: "button-practice-areas", menuTestId: "menu-practice-areas", prefetch: true, isVisible: ({ isCeo }) => isCeo },
  { id: "tags-segments", label: "Tags", href: "/admin/tags-segments", icon: Tags, cluster: "client-management", buttonTestId: "button-tags-segments", menuTestId: "menu-tags-segments", isVisible: ({ isTeamLead }) => isTeamLead },

  // Workspace — general-purpose working surfaces.
  { id: "sheets", label: "Sheets", href: "/sheets", icon: FileSpreadsheet, cluster: "workspace", buttonTestId: "button-sheets", menuTestId: "menu-sheets", isVisible: () => true, activeMatch: (p) => p === "/sheets" || p.startsWith("/sheets/") },
  // Task #4023 — global client-file library (in-app storage).
  { id: "files", label: "Files", href: "/files", icon: FolderOpen, cluster: "workspace", buttonTestId: "button-files", menuTestId: "menu-files", isVisible: () => true, activeMatch: (p) => p === "/files" || p.startsWith("/files/") },

  // Team — internal team operations.
  { id: "service-desk", label: "Service Desk", href: "/service-desk", icon: ClipboardList, cluster: "team", buttonTestId: "button-service-desk", menuTestId: "menu-service-desk", isVisible: () => true, activeMatch: (p) => p === "/admin/service-desk/home" || p.startsWith("/admin/service-desk/home") || p === "/service-desk" || p === "/service-desk/create" || p.startsWith("/admin/service-desk/reports") },
  { id: "book-operations", label: "Book Operations", href: "/admin/book-operations", icon: BookOpenCheck, cluster: "team", buttonTestId: "button-book-operations", menuTestId: "menu-book-operations", isVisible: ({ isTeamLead }) => isTeamLead, activeMatch: (p) => p === "/admin/book-operations" || p.startsWith("/admin/book-operations/") },
  { id: "role-assignments", label: "Role Assignments", href: "/admin/role-assignments", icon: Users, cluster: "team", buttonTestId: "button-role-assignments", menuTestId: "menu-role-assignments", isVisible: ({ isTeamLead }) => isTeamLead, activeMatch: (p) => p === "/admin/role-assignments" || p === "/admin/service-desk/role-assignments" },
  { id: "ats", label: "ATS", href: "/ceo/ats", icon: Users, cluster: "team", buttonTestId: "button-ats", menuTestId: "menu-ats", prefetch: true, isVisible: ({ isCeo }) => isCeo },
  // Task #3728 — company roadmap curation (public page + third-party embeds).
  { id: "roadmap-admin", label: "Roadmap", href: "/admin/roadmap", icon: Signpost, cluster: "team", buttonTestId: "button-roadmap-admin", menuTestId: "menu-roadmap-admin", isVisible: ({ isTeamLead }) => isTeamLead, activeMatch: (p) => p === "/admin/roadmap" },
  { id: "feedback-admin", label: "Feedback", href: "/admin/feedback", icon: MessageSquarePlus, cluster: "team", buttonTestId: "button-feedback-admin", menuTestId: "menu-feedback-admin", prefetch: true, isVisible: ({ isTeamLead }) => isTeamLead },
  // Task #3721 — internal tool-usage tracker (leadership only).
  { id: "internal-usage", label: "Usage", href: "/admin/internal-usage", icon: Gauge, cluster: "team", buttonTestId: "button-internal-usage", menuTestId: "menu-internal-usage", isVisible: ({ isTeamLead }) => isTeamLead },

  // System Admin — platform administration (Unmatched is an admin triage
  // queue — deliberate Task #4763 placement call).
  { id: "user-management", label: "Users", href: "/admin/users", icon: UserCog, cluster: "system-admin", buttonTestId: "button-user-management", menuTestId: "menu-user-management", prefetch: true, isVisible: ({ isTeamLead }) => isTeamLead },
  { id: "system-health", label: "Health", href: "/admin/system-health", icon: Activity, cluster: "system-admin", buttonTestId: "button-system-health", menuTestId: "menu-system-health", prefetch: true, isVisible: ({ isTeamLead }) => isTeamLead },
  { id: "integrations", label: "Integrations", href: "/admin/integrations", icon: Plug, cluster: "system-admin", buttonTestId: "button-integrations", menuTestId: "menu-integrations", prefetch: true, isVisible: ({ isCeo }) => isCeo, paletteActions: [GOOGLE_ADS_SYNC_NOW_ACTION] },
  { id: "webhook-logs", label: "Webhooks", href: "/ceo/webhook-logs", icon: Webhook, cluster: "system-admin", buttonTestId: "button-webhook-logs", menuTestId: "menu-webhook-logs", prefetch: true, isVisible: ({ isCeo }) => isCeo },
  { id: "unmatched", label: "Unmatched", href: "/admin/unmatched", icon: Inbox, cluster: "system-admin", buttonTestId: "button-unmatched", menuTestId: "menu-unmatched", prefetch: true, isVisible: ({ isCeo }) => isCeo },
  { id: "default-channels", label: "Default Channels", href: "/admin/comms/default-channels", icon: Hash, cluster: "system-admin", buttonTestId: "button-default-channels", menuTestId: "menu-default-channels", isVisible: ({ isTeamLead }) => isTeamLead },
  // Task #4336 — SMS consent ledger (opt-outs, keyword events, send-gate audit).
  { id: "sms-consent", label: "SMS Consent", href: "/admin/sms-consent", icon: ShieldCheck, cluster: "system-admin", buttonTestId: "button-sms-consent", menuTestId: "menu-sms-consent", isVisible: ({ isTeamLead }) => isTeamLead, activeMatch: (p) => p === "/admin/sms-consent" },
];

export function QuicklinkDropdownItem({ item, testId, isActive }: { item: QuicklinkItem; testId: string; isActive: boolean }) {
  const Icon = item.icon;
  const LinkComp = item.prefetch ? PrefetchLink : Link;
  return (
    <DropdownMenuItem
      asChild
      data-testid={testId}
      data-active={isActive ? "true" : undefined}
      className={isActive ? "bg-primary/10 font-semibold text-primary-ink focus:bg-primary/15" : ""}
    >
      <LinkComp href={item.href} aria-current={isActive ? "page" : undefined}>
        <Icon className="w-4 h-4 mr-2" />
        {item.label}
        {isActive && <span className="sr-only"> (current page)</span>}
      </LinkComp>
    </DropdownMenuItem>
  );
}

// Task #4675 — inline set trimmed from 4 to 2 primary links. The full CEO
// link set + right cluster intrinsically needed ~1410px, so 1280–1408px
// viewports (1366px laptops) still horizontally scrolled after the #4659
// container fix. "Client Admin" and "Insights" folded into the More menu
// (since the Task #4763 regrouping, under Client Management) at ALL widths
// — a static IA change, not a breakpoint fork, so the placement contract
// stays deterministic and jsdom-testable.
const PRIMARY_INLINE_IDS = new Set(["all-reports", "comms"]);

interface NavLinkProps {
  href: string;
  label: string;
  icon?: typeof Plus;
  isActive: boolean;
  prefetch?: boolean;
  testId: string;
}

function HeaderNavLink({ href, label, icon: Icon, isActive, prefetch, testId }: NavLinkProps) {
  const LinkComp = prefetch ? PrefetchLink : Link;
  return (
    <LinkComp
      href={href}
      className={`inline-flex items-center gap-1.5 h-9 px-3 text-sm transition-colors ${
        isActive
          ? "bg-chrome-foreground/15 text-chrome-foreground font-semibold"
          : "text-chrome-foreground/85 hover:bg-chrome-foreground/10 hover:text-chrome-foreground"
      }`}
      data-testid={testId}
      data-active={isActive ? "true" : undefined}
      aria-current={isActive ? "page" : undefined}
    >
      {Icon && <Icon className="w-4 h-4" aria-hidden="true" />}
      {label}
    </LinkComp>
  );
}

function ManifestDropdownGroup({
  label,
  items,
  pathname,
}: {
  label: string;
  items: QuicklinkItem[];
  pathname: string;
}) {
  if (items.length === 0) return null;
  return (
    <>
      <DropdownMenuLabel className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </DropdownMenuLabel>
      {items.map((item) => (
        <QuicklinkDropdownItem
          key={item.id}
          item={item}
          testId={item.menuTestId ?? item.buttonTestId}
          isActive={isItemActive(item, pathname)}
        />
      ))}
    </>
  );
}

/**
 * Top-of-page global app shell. Sticky brand-chrome band (v2 crimson in
 * light, machinery charcoal with a crimson edge in dark — the --chrome
 * token family, Task #4600 rebalance) with the reverse bull mark, brand,
 * primary nav, action menus, and user controls. Returns `null` for
 * public/unauthenticated routes so we don't leak internal nav.
 */
/**
 * Theme picker submenu (Task #4377) — shared by the desktop user menu and
 * the mobile hamburger sheet. Light / Dark / System radio group backed by
 * the global ThemeProvider (persists via PUT /api/users/me/theme).
 */
function ThemeMenuSub({ idSuffix = "" }: { idSuffix?: string }) {
  const { preference, resolved, setPreference } = useTheme();
  const Icon = resolved === "dark" ? Moon : Sun;
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger data-testid={`button-theme-toggle${idSuffix}`}>
        <Icon className="w-4 h-4 mr-2" />
        Theme
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <DropdownMenuRadioGroup
          value={preference}
          onValueChange={(value) => {
            if (isThemePreference(value)) setPreference(value);
          }}
        >
          <DropdownMenuRadioItem value="light" data-testid={`option-theme-light${idSuffix}`}>
            <Sun className="w-4 h-4 mr-2" />
            Light
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark" data-testid={`option-theme-dark${idSuffix}`}>
            <Moon className="w-4 h-4 mr-2" />
            Dark
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system" data-testid={`option-theme-system${idSuffix}`}>
            <Monitor className="w-4 h-4 mr-2" />
            System
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
export function GlobalAppNav() {
  const { user, isAuthenticated, logout } = useAuth();
  const [pathname] = useLocation();

  if (!isAuthenticated || !user) return null;
  if (!shouldRenderGlobalQuicklinksBar(pathname)) return null;

  // Task #4376 — derivation extracted to buildQuicklinkContext (in
  // globalPaletteCore) so the global ⌘K palette shares EXACTLY this gating.
  const ctx: QuicklinkContext = buildQuicklinkContext(user);

  const visible = QUICKLINKS_MANIFEST.filter((item) => item.isVisible(ctx));
  const createItems = visible.filter((i) => i.cluster === "create");
  const navigateItems = visible.filter((i) => i.cluster === "navigate");
  // Function-based tool groups (Task #4763), derived from the ordered
  // QUICKLINK_TOOL_GROUPS list so the More dropdown, the hamburger sheet,
  // and the ⌘K palette all present the same sections in the same order.
  // Groups a role can't see any member of drop out here.
  const toolGroups = QUICKLINK_TOOL_GROUPS.map((group) => ({
    ...group,
    items: visible.filter((i) => i.cluster === group.key),
  })).filter((group) => group.items.length > 0);

  const inlinePrimary = navigateItems.filter((i) => PRIMARY_INLINE_IDS.has(i.id));
  const moreNavigateItems = navigateItems.filter((i) => !PRIMARY_INLINE_IDS.has(i.id));

  const dashboardActive = pathname === "/";
  const roleLabel = user.role === "ceo" ? "CEO" : user.role === "team_lead" ? "Team Lead" : "Account Manager";

  // "+ New" dropdown shows the Create cluster. Primary item (New Report) gets a
  // primary-on-white accent inside the menu.
  const hasCreateItems = createItems.length > 0;

  // "More" dropdown collapses the rest (any Navigate links that aren't
  // inline, plus the five function-based tool groups).
  const hasMoreItems = moreNavigateItems.length > 0 || toolGroups.length > 0;

  return (
    <header
      className="sticky top-0 z-[var(--z-nav)] bg-chrome text-chrome-foreground border-b border-chrome-edge shadow-sm"
      data-testid="global-app-nav"
    >
      {/* w-full below 2xl (not `container`): the centered container caps at
          1280px on xl screens while the full CEO link set + right cluster
          needs ~1410px — the cap pushed the user menu past the viewport edge
          (horizontal page scroll at 1440). Full width uses the real estate;
          ≥1536px keeps a centered cap so ultra-wide nav doesn't sprawl
          (Task #4659). */}
      <div className="mx-auto w-full max-w-[1536px] px-3 sm:px-4 h-[var(--nav-content-height)] flex items-center gap-2 sm:gap-4">
        {/* Brand — reverse bull mark is the exact approved artwork
            (never redrawn or recolored); white reads on both the light
            crimson band and the dark charcoal band. */}
        <Link
          href="/"
          className="flex items-center gap-2 font-bold text-base sm:text-lg shrink-0 hover:opacity-90 transition-opacity"
          data-testid="link-brand"
        >
          {/* Reverse bull mark on the crimson chrome band (Task #4600) —
              same exact artwork bytes, now rendered via the canonical kit
              component + OS-owned /brand/ namespace (Task #4618). */}
          <BrandMark
            kind="icon"
            variant="white"
            className="h-6 w-auto"
            testId="img-brand-bull"
          />
          NoBull OS
        </Link>

        {/* Desktop inline primary nav. xl boundary (not md): the CEO
            link set + action menus must fit 1280px viewports, so tablet
            widths use the hamburger sheet below instead of overflowing the
            page (Task #3796 mobile-compat pass; inline set trimmed to fit
            1280–1408px in Task #4675). */}
        <nav className="hidden xl:flex items-center gap-1 ml-2" aria-label="Primary">
          <HeaderNavLink
            href="/"
            label="Dashboard"
            icon={Home}
            isActive={dashboardActive}
            testId="nav-dashboard"
          />
          {inlinePrimary.map((item) => (
            <HeaderNavLink
              key={item.id}
              href={item.href}
              label={item.label}
              icon={item.icon}
              isActive={isItemActive(item, pathname)}
              prefetch={item.prefetch}
              testId={item.buttonTestId}
            />
          ))}
        </nav>

        <div className="flex-1" />

        {/* Global ⌘K quick-jump palette + its visible affordance (Task #4376).
            Rendered from the same `visible` list as the nav, so the palette
            can never show a destination this user's nav would hide. */}
        <GlobalCommandPalette items={visible} />

        {/* "+ New" create dropdown (desktop) */}
        {hasCreateItems && (
          <div className="hidden xl:block">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="sm"
                  className="bg-chrome-foreground text-chrome hover:bg-chrome-foreground/90 font-semibold"
                  data-testid="button-new-menu"
                >
                  <Plus className="w-4 h-4 mr-1" />
                  New
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <ManifestDropdownGroup label="Create" items={createItems} pathname={pathname} />
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}

        {/* "More" overflow dropdown (desktop) */}
        {hasMoreItems && (
          <div className="hidden xl:block">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-chrome-foreground hover:bg-chrome-foreground/10 hover:text-chrome-foreground"
                  data-testid="button-more-menu"
                >
                  More
                  <MoreHorizontal className="w-4 h-4 ml-1" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-60">
                {moreNavigateItems.length > 0 && (
                  <ManifestDropdownGroup label="Navigate" items={moreNavigateItems} pathname={pathname} />
                )}
                {toolGroups.map((group, index) => (
                  <Fragment key={group.key}>
                    {(index > 0 || moreNavigateItems.length > 0) && <DropdownMenuSeparator />}
                    <ManifestDropdownGroup label={group.label} items={group.items} pathname={pathname} />
                  </Fragment>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}

        {/* Fixed-size fallbacks (both render h-9 w-9 icon buttons) so the
            lazy chunks loading after first paint cause no nav layout shift. */}
        <Suspense fallback={<div className="h-9 w-9" aria-hidden="true" />}>
          <NotificationBell />
        </Suspense>

        <Suspense fallback={<div className="h-9 w-9" aria-hidden="true" />}>
          <FeedbackButton />
        </Suspense>

        {/* User menu (desktop) */}
        <div className="hidden sm:block">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex items-center gap-2 h-9 px-2 hover:bg-chrome-foreground/10 transition-colors"
                data-testid="button-user-menu"
              >
                {user.profileImageUrl && (
                  <img
                    src={user.profileImageUrl}
                    alt=""
                    className="w-7 h-7 rounded-pill"
                    data-testid="img-user-avatar"
                  />
                )}
                {/* max-w + truncate: users without a first name fall back to
                    their full email address, which otherwise stretches the
                    menu ~270px wide and overflows the band (Task #4659). */}
                <span
                  className="text-sm font-medium max-w-[10rem] truncate"
                  data-testid="text-username"
                  title={(user.firstName || user.email) ?? undefined}
                >
                  {user.firstName || user.email}
                </span>
                <span
                  className="hidden lg:inline text-caption uppercase tracking-wide bg-chrome-foreground/15 px-1.5 py-0.5 rounded-pill"
                  data-testid="text-user-role"
                >
                  {roleLabel}
                </span>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                Signed in as {user.firstName || user.email}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem asChild data-testid="menu-profile">
                <Link href="/profile">
                  <Users className="w-4 h-4 mr-2" />
                  Profile
                </Link>
              </DropdownMenuItem>
              <ThemeMenuSub />
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => logout()}
                data-testid="button-logout"
                className="text-destructive focus:text-destructive"
              >
                <LogOut className="w-4 h-4 mr-2" />
                Sign Out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Mobile/tablet hamburger — single sheet with everything (< xl) */}
        <div className="xl:hidden">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="sm"
                variant="ghost"
                className="text-chrome-foreground hover:bg-chrome-foreground/10 hover:text-chrome-foreground px-2"
                data-testid="button-mobile-menu"
                aria-label="Open navigation menu"
              >
                <Menu className="w-5 h-5" aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuLabel className="text-xs uppercase tracking-wide text-muted-foreground">
                Navigate
              </DropdownMenuLabel>
              <DropdownMenuItem asChild data-testid="menu-dashboard">
                <Link href="/" aria-current={dashboardActive ? "page" : undefined}>
                  <Home className="w-4 h-4 mr-2" />
                  Dashboard
                </Link>
              </DropdownMenuItem>
              {navigateItems.map((item) => (
                <QuicklinkDropdownItem
                  key={item.id}
                  item={item}
                  testId={item.menuTestId ?? item.buttonTestId}
                  isActive={isItemActive(item, pathname)}
                />
              ))}
              {createItems.length > 0 && (
                <>
                  <DropdownMenuSeparator />
                  <ManifestDropdownGroup label="Create" items={createItems} pathname={pathname} />
                </>
              )}
              {toolGroups.map((group) => (
                <Fragment key={group.key}>
                  <DropdownMenuSeparator />
                  <ManifestDropdownGroup label={group.label} items={group.items} pathname={pathname} />
                </Fragment>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem asChild data-testid="menu-profile-mobile">
                <Link href="/profile">
                  <Users className="w-4 h-4 mr-2" />
                  Profile · {roleLabel}
                </Link>
              </DropdownMenuItem>
              <ThemeMenuSub idSuffix="-mobile" />
              <DropdownMenuItem
                onSelect={() => logout()}
                data-testid="button-logout-mobile"
                className="text-destructive focus:text-destructive"
              >
                <LogOut className="w-4 h-4 mr-2" />
                Sign Out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </header>
  );
}

/**
 * @deprecated Use `GlobalAppNav` instead. Kept as an alias so any external
 * import sites don't break during the rename.
 */
export const GlobalQuicklinksHeader = GlobalAppNav;

const FeedbackButton = lazyWithRetry(() => import("@/components/FeedbackButton"));

const NotificationBell = lazyWithRetry(() =>
  import("@/components/NotificationBell").then((m) => ({ default: m.NotificationBell })),
);
