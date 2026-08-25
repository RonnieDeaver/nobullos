// @db-pool-intent: ambient
//
// Task #2367 — the canonical V1 QA checklist + an idempotent seeder.
//
// The catalog is data-driven (admins edit it in-app), but it ships with
// a full V1 QA checklist pre-seeded. The seed runs on every boot and is
// idempotent: `INSERT … ON CONFLICT (key) DO NOTHING` so re-running on a
// populated DB never overwrites admin edits. Only brand-new keys are
// inserted; an admin who disables or relabels a seeded check keeps their
// change across restarts.

import { getDb, withDbAttribution } from "../../db";
import { risChecks, type InsertRisCheck } from "@shared/schema";

type SeedCheck = Omit<InsertRisCheck, "isSystem" | "active"> & {
  active?: boolean;
};

// Each entry is one catalog row. `autoSource` is the dormant BigQuery tag
// (posts made, outbound calls, ad spend, listings, …) the downstream
// auto-pull task will populate; until then those checks sit at "Needs
// Review". Owner functions route the escalation flag.
const V1_QA_CHECKLIST: SeedCheck[] = [
  // ─── Universal ──────────────────────────────────────────────────────
  {
    key: "universal.access.gbp_access",
    label: "GBP management access confirmed",
    description: "We hold active manager access to the client's Google Business Profile.",
    layer: "qa", product: "universal", category: "access", frequency: "monthly",
    locationSpecific: false, defaultSeverity: "high", defaultOwnerFunction: "gbp_expert",
    sortOrder: 10,
  },
  {
    key: "universal.access.google_ads_access",
    label: "Google Ads account access confirmed",
    description: "MCC link to the client's Google Ads account is active.",
    layer: "qa", product: "universal", category: "access", frequency: "monthly",
    locationSpecific: false, defaultSeverity: "high", defaultOwnerFunction: "google_ads_expert",
    sortOrder: 20,
  },
  {
    key: "universal.access.billing_setup",
    label: "Billing / budget setup confirmed at launch",
    description: "Client billing and product budgets are configured before go-live.",
    layer: "qa", product: "universal", category: "access", frequency: "launch_only",
    locationSpecific: false, defaultSeverity: "high", defaultOwnerFunction: "reporting_expert",
    sortOrder: 30,
  },
  {
    key: "universal.tracking.call_tracking_active",
    label: "Call tracking numbers active & routing",
    description: "Tracking numbers are provisioned and forward to the correct destination.",
    layer: "qa", product: "universal", category: "tracking", frequency: "monthly",
    locationSpecific: false, defaultSeverity: "high", defaultOwnerFunction: "reporting_expert",
    sortOrder: 40,
  },
  {
    key: "universal.tracking.conversion_tracking",
    label: "Conversion tracking firing",
    description: "Primary conversion actions record events as expected.",
    layer: "qa", product: "universal", category: "tracking", frequency: "monthly",
    locationSpecific: false, defaultSeverity: "high", defaultOwnerFunction: "reporting_expert",
    autoSource: "conversions_tracked", sortOrder: 50,
  },
  {
    key: "universal.tracking.analytics_connected",
    label: "Analytics (GA4) connected & receiving data",
    description: "GA4 property is linked and receiving sessions.",
    layer: "qa", product: "universal", category: "tracking", frequency: "monthly",
    locationSpecific: false, defaultSeverity: "medium", defaultOwnerFunction: "reporting_expert",
    sortOrder: 60,
  },
  {
    key: "universal.reporting.dashboard_data_fresh",
    label: "Client dashboard data fresh (<48h)",
    description: "The client reporting dashboard reflects data no older than 48 hours.",
    layer: "qa", product: "universal", category: "reporting", frequency: "weekly",
    locationSpecific: false, defaultSeverity: "medium", defaultOwnerFunction: "reporting_expert",
    autoSource: "dashboard_freshness", sortOrder: 70,
  },
  {
    key: "universal.automation.crm_sync_healthy",
    label: "CRM sync running without errors",
    description: "Lead/CRM sync jobs completed their latest run without failures.",
    layer: "qa", product: "universal", category: "automation", frequency: "weekly",
    locationSpecific: false, defaultSeverity: "medium", defaultOwnerFunction: "reporting_expert",
    sortOrder: 80,
  },
  {
    key: "universal.automation.lead_notifications",
    label: "Lead notification automations firing",
    description: "New leads trigger the configured notifications to the client.",
    layer: "qa", product: "universal", category: "automation", frequency: "weekly",
    locationSpecific: false, defaultSeverity: "high", defaultOwnerFunction: "reporting_expert",
    sortOrder: 90,
  },

  // ─── GBP / Local SEO / Reputation ───────────────────────────────────
  {
    key: "gbp.fulfillment.posts_per_location",
    label: "GBP posts published per location (target met)",
    description: "The agreed number of GBP posts were published for each location this period.",
    layer: "qa", product: "gbp", category: "fulfillment", frequency: "weekly",
    locationSpecific: true, defaultSeverity: "medium", defaultOwnerFunction: "gbp_expert",
    autoSource: "posts_made", sortOrder: 100,
  },
  {
    key: "gbp.fulfillment.profile_complete",
    label: "GBP profile fields complete (hours, services, photos)",
    description: "Core profile fields are filled and current for the location.",
    layer: "qa", product: "gbp", category: "fulfillment", frequency: "monthly",
    locationSpecific: true, defaultSeverity: "medium", defaultOwnerFunction: "gbp_expert",
    sortOrder: 110,
  },
  {
    key: "gbp.fulfillment.review_responses",
    label: "New reviews responded to",
    description: "All new reviews for the location received a response this period.",
    layer: "qa", product: "gbp", category: "fulfillment", frequency: "weekly",
    locationSpecific: true, defaultSeverity: "medium", defaultOwnerFunction: "gbp_expert",
    sortOrder: 120,
  },
  {
    key: "gbp.tracking.listing_accuracy",
    label: "NAP / listing accuracy verified",
    description: "Name, address, phone match the canonical record across listings.",
    layer: "qa", product: "gbp", category: "tracking", frequency: "monthly",
    locationSpecific: true, defaultSeverity: "high", defaultOwnerFunction: "gbp_expert",
    autoSource: "listings_accurate", sortOrder: 130,
  },
  {
    key: "gbp.fulfillment.spam_check",
    label: "Competitor / spam listings checked",
    description: "Map spam and fake competitor listings reviewed and reported if needed.",
    layer: "qa", product: "gbp", category: "fulfillment", frequency: "monthly",
    locationSpecific: true, defaultSeverity: "low", defaultOwnerFunction: "gbp_expert",
    sortOrder: 140,
  },
  {
    key: "gbp.access.launch_verification",
    label: "GBP verified & published at launch",
    description: "The profile is verified and live before the engagement starts.",
    layer: "qa", product: "gbp", category: "access", frequency: "launch_only",
    locationSpecific: true, defaultSeverity: "high", defaultOwnerFunction: "gbp_expert",
    sortOrder: 150,
  },

  // ─── Google Ads ─────────────────────────────────────────────────────
  {
    key: "google_ads.spend_delivery.spend_pacing",
    label: "Ad spend pacing to budget",
    description: "Spend is on pace to deliver the monthly budget (not under/over).",
    layer: "qa", product: "google_ads", category: "spend_delivery", frequency: "weekly",
    locationSpecific: false, defaultSeverity: "high", defaultOwnerFunction: "google_ads_expert",
    autoSource: "ad_spend", sortOrder: 160,
  },
  {
    key: "google_ads.fulfillment.campaigns_active",
    label: "Campaigns active & not limited",
    description: "Campaigns are enabled and not held back by budget/policy limits.",
    layer: "qa", product: "google_ads", category: "fulfillment", frequency: "weekly",
    locationSpecific: false, defaultSeverity: "high", defaultOwnerFunction: "google_ads_expert",
    sortOrder: 170,
  },
  {
    key: "google_ads.fulfillment.negative_keywords",
    label: "Negative keywords reviewed",
    description: "Search terms reviewed and wasteful queries excluded.",
    layer: "qa", product: "google_ads", category: "fulfillment", frequency: "monthly",
    locationSpecific: false, defaultSeverity: "medium", defaultOwnerFunction: "google_ads_expert",
    sortOrder: 180,
  },
  {
    key: "google_ads.tracking.conversion_actions",
    label: "Conversion actions configured",
    description: "Primary conversion actions are set up and counted correctly.",
    layer: "qa", product: "google_ads", category: "tracking", frequency: "monthly",
    locationSpecific: false, defaultSeverity: "high", defaultOwnerFunction: "google_ads_expert",
    sortOrder: 190,
  },
  {
    key: "google_ads.fulfillment.landing_pages_live",
    label: "Landing pages live & loading",
    description: "Destination URLs resolve and load without errors.",
    layer: "qa", product: "google_ads", category: "fulfillment", frequency: "weekly",
    locationSpecific: false, defaultSeverity: "high", defaultOwnerFunction: "google_ads_expert",
    sortOrder: 200,
  },
  {
    key: "google_ads.access.launch_setup",
    label: "Campaign structure approved at launch",
    description: "Initial campaign structure reviewed and approved before go-live.",
    layer: "qa", product: "google_ads", category: "access", frequency: "launch_only",
    locationSpecific: false, defaultSeverity: "high", defaultOwnerFunction: "google_ads_expert",
    sortOrder: 210,
  },

  // ─── LSA (Local Services Ads) ───────────────────────────────────────
  {
    key: "lsa.spend_delivery.budget_pacing",
    label: "LSA budget pacing",
    description: "Local Services Ads budget is pacing to deliver for the month.",
    layer: "qa", product: "lsa", category: "spend_delivery", frequency: "weekly",
    locationSpecific: false, defaultSeverity: "high", defaultOwnerFunction: "google_ads_expert",
    autoSource: "ad_spend", sortOrder: 220,
  },
  {
    key: "lsa.fulfillment.leads_reviewed",
    label: "LSA leads reviewed / disputed",
    description: "Incoming LSA leads reviewed and ineligible ones disputed.",
    layer: "qa", product: "lsa", category: "fulfillment", frequency: "weekly",
    locationSpecific: false, defaultSeverity: "medium", defaultOwnerFunction: "google_ads_expert",
    sortOrder: 230,
  },
  {
    key: "lsa.fulfillment.profile_active",
    label: "LSA profile active & badged",
    description: "Google Guaranteed badge is active and the profile is live.",
    layer: "qa", product: "lsa", category: "fulfillment", frequency: "monthly",
    locationSpecific: false, defaultSeverity: "high", defaultOwnerFunction: "google_ads_expert",
    sortOrder: 240,
  },
  {
    key: "lsa.fulfillment.responsiveness",
    label: "Lead response time within target",
    description: "Leads are answered within the agreed response window.",
    layer: "qa", product: "lsa", category: "fulfillment", frequency: "weekly",
    locationSpecific: false, defaultSeverity: "medium", defaultOwnerFunction: "google_ads_expert",
    autoSource: "outbound_calls", sortOrder: 250,
  },
  {
    key: "lsa.access.launch_verification",
    label: "LSA verified & live at launch",
    description: "LSA account is verified and serving before go-live.",
    layer: "qa", product: "lsa", category: "access", frequency: "launch_only",
    locationSpecific: false, defaultSeverity: "high", defaultOwnerFunction: "google_ads_expert",
    sortOrder: 260,
  },

  // ─── Webinar ────────────────────────────────────────────────────────
  {
    key: "webinar.fulfillment.scheduled",
    label: "Monthly webinar scheduled",
    description: "The month's webinar is scheduled with a confirmed date.",
    layer: "qa", product: "webinar", category: "fulfillment", frequency: "monthly",
    locationSpecific: false, defaultSeverity: "medium", defaultOwnerFunction: "webinar_expert",
    sortOrder: 270,
  },
  {
    key: "webinar.fulfillment.promotion_live",
    label: "Webinar promotion / ads live",
    description: "Promotion (ads, email, social) for the webinar is running.",
    layer: "qa", product: "webinar", category: "fulfillment", frequency: "weekly",
    locationSpecific: false, defaultSeverity: "medium", defaultOwnerFunction: "webinar_expert",
    sortOrder: 280,
  },
  {
    key: "webinar.tracking.registrations_tracked",
    label: "Registrations tracked",
    description: "Registrations are captured and attributed correctly.",
    layer: "qa", product: "webinar", category: "tracking", frequency: "weekly",
    locationSpecific: false, defaultSeverity: "medium", defaultOwnerFunction: "webinar_expert",
    autoSource: "registrations", sortOrder: 290,
  },
  {
    key: "webinar.automation.followup_sent",
    label: "Post-webinar follow-up sent",
    description: "Attendees and no-shows received the configured follow-up.",
    layer: "qa", product: "webinar", category: "automation", frequency: "monthly",
    locationSpecific: false, defaultSeverity: "medium", defaultOwnerFunction: "webinar_expert",
    sortOrder: 300,
  },
  {
    key: "webinar.access.launch_setup",
    label: "Webinar funnel built at launch",
    description: "Registration page, reminders and follow-up funnel are built before launch.",
    layer: "qa", product: "webinar", category: "access", frequency: "launch_only",
    locationSpecific: false, defaultSeverity: "high", defaultOwnerFunction: "webinar_expert",
    sortOrder: 310,
  },
];

// ─── Task #2371 — V1 Performance Layer checklist ──────────────────────
//
// Color-coded marketing-output health, one catalog row per dashboard check
// in the spec's "Final V1 Performance Layer Buildout". Each row carries a
// `metricType` (volume / cost / rate / budget) that drives how the
// threshold engine scores its period-over-period change, plus a dormant
// `autoSource` tag the BigQuery performance-pull wires to a real query. All
// are product-level (locationSpecific=false) and monthly in V1. Severity
// gates flagging only (Red + High/Critical escalates); category groups the
// metric on the health card. Sort order starts at 1000 to sit after QA.
const V1_PERFORMANCE_CHECKLIST: SeedCheck[] = [
  // ─── Universal Marketing Performance ────────────────────────────────
  {
    key: "perf.universal.total_leads",
    label: "Total marketing leads healthy?",
    description: "Total marketing leads across active products vs the prior period.",
    layer: "performance", product: "universal", category: "leads", frequency: "monthly",
    locationSpecific: false, defaultSeverity: "high", defaultOwnerFunction: "reporting_expert",
    metricType: "volume", autoSource: "perf_total_leads", sortOrder: 1000,
  },
  {
    key: "perf.universal.phone_leads",
    label: "Total phone call leads healthy?",
    description: "Total phone-call leads across active products vs the prior period.",
    layer: "performance", product: "universal", category: "leads", frequency: "monthly",
    locationSpecific: false, defaultSeverity: "medium", defaultOwnerFunction: "reporting_expert",
    metricType: "volume", autoSource: "perf_total_phone_leads", sortOrder: 1010,
  },
  {
    key: "perf.universal.form_leads",
    label: "Total form/chat leads healthy?",
    description: "Total form/chat leads across active products vs the prior period.",
    layer: "performance", product: "universal", category: "leads", frequency: "monthly",
    locationSpecific: false, defaultSeverity: "medium", defaultOwnerFunction: "reporting_expert",
    metricType: "volume", autoSource: "perf_total_form_leads", sortOrder: 1020,
  },
  {
    key: "perf.universal.cost_per_lead",
    label: "Total cost per lead healthy?",
    description: "Blended cost per marketing lead vs the prior period (lower is better).",
    layer: "performance", product: "universal", category: "efficiency", frequency: "monthly",
    locationSpecific: false, defaultSeverity: "high", defaultOwnerFunction: "reporting_expert",
    metricType: "cost", autoSource: "perf_total_cost_per_lead", sortOrder: 1030,
  },
  {
    key: "perf.universal.spend_pacing",
    label: "Total spend pacing healthy?",
    description: "Combined marketing spend pacing vs expected for the month.",
    layer: "performance", product: "universal", category: "spend_delivery", frequency: "monthly",
    locationSpecific: false, defaultSeverity: "high", defaultOwnerFunction: "reporting_expert",
    metricType: "budget", autoSource: "perf_total_spend_pacing", sortOrder: 1040,
  },
  {
    key: "perf.universal.products_output",
    label: "Active products producing expected output?",
    description: "Total marketing output across active products vs the prior period.",
    layer: "performance", product: "universal", category: "leads", frequency: "monthly",
    locationSpecific: false, defaultSeverity: "high", defaultOwnerFunction: "reporting_expert",
    metricType: "volume", autoSource: "perf_active_products_output", sortOrder: 1050,
  },

  // ─── GBP Performance ────────────────────────────────────────────────
  {
    key: "perf.gbp.total_leads",
    label: "GBP total leads healthy?",
    description: "Total GBP-attributed leads vs the prior period.",
    layer: "performance", product: "gbp", category: "leads", frequency: "monthly",
    locationSpecific: false, defaultSeverity: "high", defaultOwnerFunction: "gbp_expert",
    metricType: "volume", autoSource: "perf_gbp_total_leads", sortOrder: 1100,
  },
  {
    key: "perf.gbp.call_leads",
    label: "GBP call leads healthy?",
    description: "GBP phone-call leads vs the prior period.",
    layer: "performance", product: "gbp", category: "leads", frequency: "monthly",
    locationSpecific: false, defaultSeverity: "medium", defaultOwnerFunction: "gbp_expert",
    metricType: "volume", autoSource: "perf_gbp_call_leads", sortOrder: 1110,
  },
  {
    key: "perf.gbp.website_clicks",
    label: "GBP website clicks healthy?",
    description: "Website clicks from the GBP profile vs the prior period.",
    layer: "performance", product: "gbp", category: "visibility", frequency: "monthly",
    locationSpecific: false, defaultSeverity: "medium", defaultOwnerFunction: "gbp_expert",
    metricType: "volume", autoSource: "perf_gbp_website_clicks", sortOrder: 1120,
  },
  {
    key: "perf.gbp.views_impressions",
    label: "GBP views/impressions healthy?",
    description: "GBP profile search + map views/impressions vs the prior period.",
    layer: "performance", product: "gbp", category: "visibility", frequency: "monthly",
    locationSpecific: false, defaultSeverity: "medium", defaultOwnerFunction: "gbp_expert",
    metricType: "volume", autoSource: "perf_gbp_views_impressions", sortOrder: 1130,
  },
  {
    key: "perf.gbp.local_visibility",
    label: "Local visibility/heatmap healthy?",
    description: "Local visibility / heatmap score for target keywords vs the prior period.",
    layer: "performance", product: "gbp", category: "visibility", frequency: "monthly",
    locationSpecific: false, defaultSeverity: "medium", defaultOwnerFunction: "gbp_expert",
    metricType: "rate", autoSource: "perf_gbp_local_visibility", sortOrder: 1140,
  },
  {
    key: "perf.gbp.new_reviews",
    label: "New reviews healthy?",
    description: "New reviews generated vs the prior period.",
    layer: "performance", product: "gbp", category: "reviews", frequency: "monthly",
    locationSpecific: false, defaultSeverity: "medium", defaultOwnerFunction: "gbp_expert",
    metricType: "volume", autoSource: "perf_gbp_new_reviews", sortOrder: 1150,
  },
  {
    key: "perf.gbp.average_rating",
    label: "Average rating stable?",
    description: "Average star rating vs the prior period (higher is better).",
    layer: "performance", product: "gbp", category: "reviews", frequency: "monthly",
    locationSpecific: false, defaultSeverity: "medium", defaultOwnerFunction: "gbp_expert",
    metricType: "rate", autoSource: "perf_gbp_average_rating", sortOrder: 1160,
  },

  // ─── Google Ads Performance ─────────────────────────────────────────
  {
    key: "perf.google_ads.spend_pacing",
    label: "Google Ads spend pacing healthy?",
    description: "Google Ads spend pacing vs expected for the month.",
    layer: "performance", product: "google_ads", category: "spend_delivery", frequency: "monthly",
    locationSpecific: false, defaultSeverity: "high", defaultOwnerFunction: "google_ads_expert",
    metricType: "budget", autoSource: "perf_google_ads_spend_pacing", sortOrder: 1200,
  },
  {
    key: "perf.google_ads.impressions",
    label: "Google Ads impressions healthy?",
    description: "Google Ads impressions vs the prior period.",
    layer: "performance", product: "google_ads", category: "visibility", frequency: "monthly",
    locationSpecific: false, defaultSeverity: "medium", defaultOwnerFunction: "google_ads_expert",
    metricType: "volume", autoSource: "perf_google_ads_impressions", sortOrder: 1210,
  },
  {
    key: "perf.google_ads.clicks",
    label: "Google Ads clicks healthy?",
    description: "Google Ads clicks vs the prior period.",
    layer: "performance", product: "google_ads", category: "visibility", frequency: "monthly",
    locationSpecific: false, defaultSeverity: "medium", defaultOwnerFunction: "google_ads_expert",
    metricType: "volume", autoSource: "perf_google_ads_clicks", sortOrder: 1220,
  },
  {
    key: "perf.google_ads.cpc",
    label: "Google Ads CPC healthy?",
    description: "Average cost per click vs the prior period (lower is better).",
    layer: "performance", product: "google_ads", category: "efficiency", frequency: "monthly",
    locationSpecific: false, defaultSeverity: "medium", defaultOwnerFunction: "google_ads_expert",
    metricType: "cost", autoSource: "perf_google_ads_cpc", sortOrder: 1230,
  },
  {
    key: "perf.google_ads.total_leads",
    label: "Google Ads total leads healthy?",
    description: "Total Google Ads leads vs the prior period.",
    layer: "performance", product: "google_ads", category: "leads", frequency: "monthly",
    locationSpecific: false, defaultSeverity: "high", defaultOwnerFunction: "google_ads_expert",
    metricType: "volume", autoSource: "perf_google_ads_total_leads", sortOrder: 1240,
  },
  {
    key: "perf.google_ads.cost_per_lead",
    label: "Google Ads cost per lead healthy?",
    description: "Google Ads cost per lead vs the prior period (lower is better).",
    layer: "performance", product: "google_ads", category: "efficiency", frequency: "monthly",
    locationSpecific: false, defaultSeverity: "high", defaultOwnerFunction: "google_ads_expert",
    metricType: "cost", autoSource: "perf_google_ads_cost_per_lead", sortOrder: 1250,
  },
  {
    key: "perf.google_ads.landing_conversion_rate",
    label: "Landing page conversion rate healthy?",
    description: "Landing page conversion rate vs the prior period (higher is better).",
    layer: "performance", product: "google_ads", category: "efficiency", frequency: "monthly",
    locationSpecific: false, defaultSeverity: "medium", defaultOwnerFunction: "google_ads_expert",
    metricType: "rate", autoSource: "perf_google_ads_landing_conversion_rate", sortOrder: 1260,
  },
  {
    key: "perf.google_ads.spend_to_lead",
    label: "Spend-to-lead relationship healthy?",
    description: "Leads per $1,000 spent vs the prior period (higher is better).",
    layer: "performance", product: "google_ads", category: "efficiency", frequency: "monthly",
    locationSpecific: false, defaultSeverity: "medium", defaultOwnerFunction: "google_ads_expert",
    metricType: "rate", autoSource: "perf_google_ads_spend_to_lead", sortOrder: 1270,
  },

  // ─── LSA Performance ────────────────────────────────────────────────
  {
    key: "perf.lsa.lead_volume",
    label: "LSA lead volume healthy?",
    description: "Total LSA leads vs the prior period.",
    layer: "performance", product: "lsa", category: "leads", frequency: "monthly",
    locationSpecific: false, defaultSeverity: "high", defaultOwnerFunction: "google_ads_expert",
    metricType: "volume", autoSource: "perf_lsa_lead_volume", sortOrder: 1300,
  },
  {
    key: "perf.lsa.cost_per_lead",
    label: "LSA cost per lead healthy?",
    description: "LSA cost per lead vs the prior period (lower is better).",
    layer: "performance", product: "lsa", category: "efficiency", frequency: "monthly",
    locationSpecific: false, defaultSeverity: "high", defaultOwnerFunction: "google_ads_expert",
    metricType: "cost", autoSource: "perf_lsa_cost_per_lead", sortOrder: 1310,
  },
  {
    key: "perf.lsa.budget_pacing",
    label: "LSA budget pacing healthy?",
    description: "LSA budget pacing vs expected for the month.",
    layer: "performance", product: "lsa", category: "spend_delivery", frequency: "monthly",
    locationSpecific: false, defaultSeverity: "high", defaultOwnerFunction: "google_ads_expert",
    metricType: "budget", autoSource: "perf_lsa_budget_pacing", sortOrder: 1320,
  },
  {
    key: "perf.lsa.valid_lead_ratio",
    label: "LSA valid lead ratio healthy?",
    description: "Share of LSA leads that are valid (not disputed) vs the prior period.",
    layer: "performance", product: "lsa", category: "efficiency", frequency: "monthly",
    locationSpecific: false, defaultSeverity: "medium", defaultOwnerFunction: "google_ads_expert",
    metricType: "rate", autoSource: "perf_lsa_valid_lead_ratio", sortOrder: 1330,
  },
  {
    key: "perf.lsa.review_profile",
    label: "LSA review/rating profile healthy?",
    description: "LSA rating vs the prior period (higher is better).",
    layer: "performance", product: "lsa", category: "reviews", frequency: "monthly",
    locationSpecific: false, defaultSeverity: "medium", defaultOwnerFunction: "google_ads_expert",
    metricType: "rate", autoSource: "perf_lsa_review_profile", sortOrder: 1340,
  },

  // ─── Webinar Performance ────────────────────────────────────────────
  {
    key: "perf.webinar.spend_pacing",
    label: "Webinar spend pacing healthy?",
    description: "Webinar ad spend pacing vs expected for the month.",
    layer: "performance", product: "webinar", category: "spend_delivery", frequency: "monthly",
    locationSpecific: false, defaultSeverity: "high", defaultOwnerFunction: "webinar_expert",
    metricType: "budget", autoSource: "perf_webinar_spend_pacing", sortOrder: 1400,
  },
  {
    key: "perf.webinar.registrants",
    label: "Webinar registrants healthy?",
    description: "Webinar registrants vs the prior period.",
    layer: "performance", product: "webinar", category: "leads", frequency: "monthly",
    locationSpecific: false, defaultSeverity: "high", defaultOwnerFunction: "webinar_expert",
    metricType: "volume", autoSource: "perf_webinar_registrants", sortOrder: 1410,
  },
  {
    key: "perf.webinar.cost_per_registrant",
    label: "Webinar cost per registrant healthy?",
    description: "Webinar cost per registrant vs the prior period (lower is better).",
    layer: "performance", product: "webinar", category: "efficiency", frequency: "monthly",
    locationSpecific: false, defaultSeverity: "medium", defaultOwnerFunction: "webinar_expert",
    metricType: "cost", autoSource: "perf_webinar_cost_per_registrant", sortOrder: 1420,
  },
  {
    key: "perf.webinar.attendees",
    label: "Webinar attendees healthy?",
    description: "Webinar attendees vs the prior period.",
    layer: "performance", product: "webinar", category: "leads", frequency: "monthly",
    locationSpecific: false, defaultSeverity: "high", defaultOwnerFunction: "webinar_expert",
    metricType: "volume", autoSource: "perf_webinar_attendees", sortOrder: 1430,
  },
  {
    key: "perf.webinar.attendance_rate",
    label: "Webinar attendance rate healthy?",
    description: "Attendance rate (attendees / registrants) vs the prior period.",
    layer: "performance", product: "webinar", category: "efficiency", frequency: "monthly",
    locationSpecific: false, defaultSeverity: "medium", defaultOwnerFunction: "webinar_expert",
    metricType: "rate", autoSource: "perf_webinar_attendance_rate", sortOrder: 1440,
  },
  {
    key: "perf.webinar.cost_per_attendee",
    label: "Webinar cost per attendee healthy?",
    description: "Webinar cost per attendee vs the prior period (lower is better).",
    layer: "performance", product: "webinar", category: "efficiency", frequency: "monthly",
    locationSpecific: false, defaultSeverity: "medium", defaultOwnerFunction: "webinar_expert",
    metricType: "cost", autoSource: "perf_webinar_cost_per_attendee", sortOrder: 1450,
  },
  {
    key: "perf.webinar.calls_per_attendee",
    label: "Webinar calls per attendee healthy?",
    description: "Call-center calls per attendee vs the prior period (higher is better).",
    layer: "performance", product: "webinar", category: "efficiency", frequency: "monthly",
    locationSpecific: false, defaultSeverity: "medium", defaultOwnerFunction: "webinar_expert",
    metricType: "rate", autoSource: "perf_webinar_calls_per_attendee", sortOrder: 1460,
  },
  {
    key: "perf.webinar.consult_bookings",
    label: "Webinar consult bookings healthy?",
    description: "Consults booked from the webinar funnel vs the prior period.",
    layer: "performance", product: "webinar", category: "leads", frequency: "monthly",
    locationSpecific: false, defaultSeverity: "high", defaultOwnerFunction: "webinar_expert",
    metricType: "volume", autoSource: "perf_webinar_consult_bookings", sortOrder: 1470,
  },
  {
    key: "perf.webinar.attendee_to_consult_rate",
    label: "Webinar attendee-to-consult rate healthy?",
    description: "Attendee-to-consult rate vs the prior period (higher is better).",
    layer: "performance", product: "webinar", category: "efficiency", frequency: "monthly",
    locationSpecific: false, defaultSeverity: "medium", defaultOwnerFunction: "webinar_expert",
    metricType: "rate", autoSource: "perf_webinar_attendee_to_consult_rate", sortOrder: 1480,
  },
  {
    key: "perf.webinar.cost_per_consult",
    label: "Webinar cost per consult healthy?",
    description: "Webinar cost per consult vs the prior period (lower is better).",
    layer: "performance", product: "webinar", category: "efficiency", frequency: "monthly",
    locationSpecific: false, defaultSeverity: "high", defaultOwnerFunction: "webinar_expert",
    metricType: "cost", autoSource: "perf_webinar_cost_per_consult", sortOrder: 1490,
  },
];

// ─── Task #2388 — Engagement Layer (V1) ───────────────────────────────
//
// The Engagement layer answers two relationship questions per active
// client per calendar month: (1) is the client cooperating enough for the
// marketing engine to work, and (2) are WE communicating with the client
// enough to keep them engaged. All eight checks are client-level (not
// per-location, not product-scoped) and resolved by a human to
// Green / Yellow / Red / N/A (mapped onto pass / needs_review / fail / na
// in the shared status enum). Only check #7 surfaces auto-counted comms
// volume (auto_source = `comm_cadence`) — the human still sets the status.
const COMM_CADENCE_AUTO_SOURCE = "comm_cadence";

const V1_ENGAGEMENT_CHECKLIST: SeedCheck[] = [
  {
    key: "engagement.client.strategy_call_attended",
    label: "Monthly strategy call attended",
    description:
      "Green: client attended this month's strategy call. Yellow: rescheduled but held, or partial attendance. Red: missed with no reschedule. N/A: no strategy call due this month.",
    layer: "engagement", product: "universal", category: "client_engagement",
    frequency: "monthly", locationSpecific: false, defaultSeverity: "high",
    defaultOwnerFunction: "revenue_engineer", sortOrder: 1000,
  },
  {
    key: "engagement.client.responsive_when_needed",
    label: "Client responsive when needed",
    description:
      "Green: client replied to requests within the agreed window. Yellow: slow but eventually responsive. Red: unresponsive and blocking work. N/A: nothing required a client response this month.",
    layer: "engagement", product: "universal", category: "client_engagement",
    frequency: "monthly", locationSpecific: false, defaultSeverity: "high",
    defaultOwnerFunction: "revenue_engineer", sortOrder: 1010,
  },
  {
    key: "engagement.client.critical_approvals_completed",
    label: "Critical approvals completed",
    description:
      "Green: all approvals needed to proceed were given. Yellow: some approvals outstanding but not yet blocking. Red: critical approvals missing and blocking delivery. N/A: no approvals were required this month.",
    layer: "engagement", product: "universal", category: "client_engagement",
    frequency: "monthly", locationSpecific: false, defaultSeverity: "high",
    defaultOwnerFunction: "revenue_engineer", sortOrder: 1020,
  },
  {
    key: "engagement.client.lead_feedback_provided",
    label: "Lead feedback provided",
    description:
      "Green: client gave usable lead-quality feedback. Yellow: minimal or late feedback. Red: no feedback, so leads can't be optimized. N/A: no lead-feedback loop in scope this month.",
    layer: "engagement", product: "universal", category: "client_engagement",
    frequency: "monthly", locationSpecific: false, defaultSeverity: "medium",
    defaultOwnerFunction: "intake_engineer", sortOrder: 1030,
  },
  {
    key: "engagement.client.review_generation_participation",
    label: "Review generation participation healthy",
    description:
      "Green: client is actively requesting/forwarding reviews as agreed. Yellow: sporadic participation. Red: not participating in review generation. N/A: review generation not in scope.",
    layer: "engagement", product: "universal", category: "client_engagement",
    frequency: "monthly", locationSpecific: false, defaultSeverity: "medium",
    defaultOwnerFunction: "gbp_expert", sortOrder: 1040,
  },
  {
    key: "engagement.client.budget_cooperation",
    label: "Budget cooperation healthy",
    description:
      "Green: budget confirmed and funded on time. Yellow: late or partial budget cooperation. Red: budget issues blocking spend/delivery. N/A: no budget decision needed this month.",
    layer: "engagement", product: "universal", category: "client_engagement",
    frequency: "monthly", locationSpecific: false, defaultSeverity: "critical",
    defaultOwnerFunction: "revenue_engineer", sortOrder: 1050,
  },
  {
    key: "engagement.nobull.communication_cadence",
    label: "NoBull communication cadence healthy",
    description:
      "Green: we communicated with the client at the agreed cadence. Yellow: below the agreed cadence. Red: we went dark or well below cadence. N/A: client paused or cadence not applicable. Live counts of emails, calls and texts sent this month are shown below the status — they inform the call but never set it.",
    layer: "engagement", product: "universal", category: "nobull_cadence",
    frequency: "monthly", locationSpecific: false, defaultSeverity: "high",
    defaultOwnerFunction: "revenue_engineer", autoSource: COMM_CADENCE_AUTO_SOURCE,
    sortOrder: 1060,
  },
  {
    key: "engagement.nobull.strategic_interaction",
    label: "Strategic interaction healthy",
    description:
      "Green: meaningful two-way strategic conversations happened. Yellow: only transactional contact. Red: no strategic interaction. N/A: not applicable this month.",
    layer: "engagement", product: "universal", category: "nobull_cadence",
    frequency: "monthly", locationSpecific: false, defaultSeverity: "medium",
    defaultOwnerFunction: "revenue_engineer", sortOrder: 1070,
  },
];

export function getV1QaChecklist(): ReadonlyArray<SeedCheck> {
  return V1_QA_CHECKLIST;
}

export function getV1PerformanceChecklist(): ReadonlyArray<SeedCheck> {
  return V1_PERFORMANCE_CHECKLIST;
}

export function getV1EngagementChecklist(): ReadonlyArray<SeedCheck> {
  return V1_ENGAGEMENT_CHECKLIST;
}

/** The full seed set across all V1 layers. */
const V1_FULL_CATALOG: SeedCheck[] = [
  ...V1_QA_CHECKLIST,
  ...V1_PERFORMANCE_CHECKLIST,
  ...V1_ENGAGEMENT_CHECKLIST,
];

/** Machine key the UI keys off to render the live comms-cadence panel. */
export { COMM_CADENCE_AUTO_SOURCE };

export interface SeedRisCatalogResult {
  inserted: number;
  total: number;
}

/**
 * Idempotently seed the V1 catalog (QA + Performance + Engagement layers).
 * New keys are inserted; existing rows (including admin-edited ones) are
 * left untouched. Safe to call on every boot — `ON CONFLICT (key) DO
 * NOTHING` never clobbers admin edits or re-activates a disabled check.
 */
export async function seedRisCatalog(): Promise<SeedRisCatalogResult> {
  return withDbAttribution("ris:seedCatalog", async () => {
    let inserted = 0;
    for (const check of V1_FULL_CATALOG) {
      const res = await getDb()
        .insert(risChecks)
        .values({ ...check, isSystem: true, active: check.active ?? true })
        .onConflictDoNothing({ target: risChecks.key });
      inserted += (res as any)?.rowCount ?? 0;
    }
    return { inserted, total: V1_FULL_CATALOG.length };
  });
}
