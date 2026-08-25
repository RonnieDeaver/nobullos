import type { SectionNavItem } from "@/components/admin/SectionNav";

/**
 * Task #4344 — jump-nav registry for the health dashboard's stacked sections
 * (audit §6.1-E / §8.3: 15+ sections with no wayfinding). Kept in a leaf
 * module so tests can import the real registry without evaluating the whole
 * dashboard import graph.
 *
 * LOCKSTEP: every id here must exist as a `<section id="…">` anchor in
 * HealthDashboardSection.tsx — guarded by tests/client/section-nav.test.tsx.
 */
export const HEALTH_DASHBOARD_SECTIONS: SectionNavItem[] = [
  { id: "post-deploy-verification", label: "Post-deploy verification" },
  { id: "diagnostic-command-center", label: "Diagnostics" },
  { id: "operational-health", label: "Operational health" },
  { id: "stats-overview", label: "Stats overview" },
  { id: "manual-reserve", label: "Manual reserve" },
  { id: "advisory-bypass", label: "Advisory bypass" },
  { id: "reserve-alerts", label: "Reserve alerts" },
  { id: "latency", label: "Latency" },
  { id: "alerts-status", label: "Alerts & status" },
  { id: "open-incidents", label: "Open incidents" },
  { id: "sampler-runtime", label: "Samplers" },
  { id: "db-pools", label: "DB pools" },
  { id: "semrush-ghost-cleanup", label: "SEMrush ghost cleanup" },
  { id: "import-ghosts", label: "Import ghosts" },
  { id: "queue-drain", label: "Queue drain" },
  { id: "thresholds", label: "Thresholds" },
];
