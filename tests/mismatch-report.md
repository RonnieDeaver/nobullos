# Route Mismatch Report: Hand-Written Plan vs Code-Derived Inventory

Generated: 2026-04-16

## Overview

The original hand-written plan (from progress/scratchpad notes) identified key route patterns and public routes by manual inspection. This report compares those observations against the code-derived inventory of **405 routes** discovered by automated parsing of all 16 route registration files.

## Public Routes: Plan vs Discovered

### Routes listed in plan as public
| Route (Plan) | Found in Code? | Notes |
|---|---|---|
| POST /api/mcu/evaluate | YES | Confirmed public |
| GET /api/public/heatmaps/* | YES | Two routes: geojson and meta |
| GET /api/public/config/maptiler-key | YES | Confirmed public |
| GET /api/health | YES | Confirmed public |
| GET /api/health/history | YES | Confirmed public |
| GET /api/health/history/export | YES | Confirmed public |
| POST /api/twilio/webhooks/* | YES | 6 webhook routes with validateTwilioWebhook |
| POST /api/integrations/front/webhook | YES | Confirmed public |
| POST /api/stripe/webhook | YES | Confirmed public |

### Public routes MISSED by hand-written plan (exist in code, not listed)
| Method | Path | File | Notes |
|---|---|---|---|
| GET | /api/ceo-pulse/share/:token | reports.ts:800 | Token-gated sharing, no auth middleware |
| GET | /api/ceo-pulse-charts/:monthKey/chart-:index.png | reports.ts:827 | Static chart image serving |
| POST | /api/webhooks/report-import | reports.ts:1075 | PDF upload webhook, no auth |
| GET | /api/share/:token | reports.ts:2629 | Token-gated report sharing |
| GET | /api/demo-report | reports.ts:2716 | Demo report endpoint |
| POST | /api/ats/jobs/:id/generate-webhook | ats.ts:259 | ATS webhook for job data generation |
| GET | /api/ats/portal/:token | ats.ts:1030 | Candidate portal (token-gated) |
| POST | /api/ats/portal/:token/submit | ats.ts:1078 | Portal submission |
| POST | /api/ats/portal/:token/complete-screening | ats.ts:1157 | Portal screening completion |
| POST | /api/ats/portal/:token/complete-video | ats.ts:1190 | Portal video completion |
| POST | /api/ats/portal/:token/video-upload-url | ats.ts:1553 | Portal video upload URL |
| POST | /api/ats/portal/:token/submit-video | ats.ts:1575 | Portal video submission |
| GET | /api/integrations/front/callback | communications.ts:330 | OAuth callback |
| GET | /api/integrations/zoom/callback | communications.ts:943 | OAuth callback |
| POST | /api/integrations/zoom/webhook | integrations.ts:1494 | Zoom webhook |
| GET | /api/mcu/practice-areas | mcu.ts:12 | Practice area list |
| GET | /api/trends | settings.ts:171 | Trends data |
| POST | /api/trends/practice-areas | settings.ts:284 | Practice area trends |
| GET | /api/trends/practice-areas/list | settings.ts:733 | Practice area list |
| GET | /api/phase-settings | settings.ts:858 | Phase settings |
| POST | /api/activity | activity.ts:17 | Activity logging (manual userId check) |
| GET | /api/activity | activity.ts:73 | Activity query |
| GET | /api/activity/stats | activity.ts:106 | Activity stats |

**Total public routes missed by plan: 23** (of 32 total discovered)

## Role-Based Access: Plan vs Discovered

### Plan observations verified
| Observation | Status | Details |
|---|---|---|
| Role hierarchy: CEO > team_lead > account_manager > sales | CONFIRMED | `hasRole()` in middleware.ts uses ROLE_LEVELS |
| ATS routes use requireTeamLead | CONFIRMED | All 39 ATS routes use requireTeamLead (except portals/webhooks) |
| Demo clients: only CEO can see/delete | NEEDS VERIFICATION | Inline role check in clients.ts, not middleware-level |
| requireCommandCenterAccess attaches req.dbUser | CONFIRMED | middleware.ts line 235 |
| CEO Tools list uses isAuthenticated + requireTeamLead | CONFIRMED | ceoTools.ts:84 |
| CEO Tools individual get/create use requireCeoToolsAuth | CONFIRMED | ceoTools.ts:11, :55 |
| Twilio config PUT checks role inline | CONFIRMED | twilio.ts:760-765 |
| aiLimiter used on CEO Pulse analyze | CONFIRMED | reports.ts:328 |
| requireCeoToolsAuth uses bearer token | CONFIRMED | middleware.ts:173-185 |

### Routes with inline role checks (not middleware-enforced)
These routes have auth checks inside route handlers rather than using middleware, which the plan partially noted:

| Method | Path | File | Inline Check |
|---|---|---|---|
| PUT | /api/twilio/config | twilio.ts:760 | user.role !== "ceo" && user.role !== "team_lead" |
| POST | /api/activity | activity.ts:17 | Manual userId check |
| GET | /api/clients/:clientId/judgments | agents.ts:835 | hasRole + ownerId check |
| GET | /api/clients/:clientId/judgments/:judgmentId | agents.ts:861 | hasRole + ownerId check |
| GET | /api/clients/:clientId/daily-judgments | agents.ts:887 | hasRole + ownerId check |
| GET | /api/clients/:clientId/daily-judgments/:judgmentId | agents.ts:908 | hasRole + ownerId check |
| GET | /api/clients/:clientId/relationship-signals | agents.ts:954 | hasRole + ownerId check |
| GET | /api/clients/:clientId/open-asks | agents.ts:975 | hasRole + ownerId check |
| PATCH | /api/clients/:clientId/open-asks/:askId | agents.ts:999 | hasRole + ownerId check |
| POST | /api/clients/:clientId/open-asks/cleanup-contaminated | agents.ts:1034 | hasRole(role, 'account_manager') |

## Route Files: Plan vs Discovered

### Files listed in plan
| File | In Code? | Route Count |
|---|---|---|
| server/routes.ts | YES | 28 |
| server/routes/middleware.ts | YES | 0 (middleware only) |
| server/routes/clients.ts | YES | 17 |
| server/routes/reports.ts | YES | 32 |
| server/routes/ats.ts | YES | 39 |
| server/routes/commandCenter.ts | YES | 21 |
| server/routes/communications.ts | YES | 44 |
| server/routes/agents.ts | YES | 63 |
| server/routes/heatmap.ts | YES | 46 |
| server/routes/integrations.ts | YES | 46 |
| server/routes/mcu.ts | YES | 10 |
| server/routes/settings.ts | YES | 14 |
| server/routes/billing.ts | YES | 5 |
| server/routes/ceoTools.ts | YES | 5 |

### Files NOT listed in plan but contain routes
| File | Route Count | Notes |
|---|---|---|
| server/routes/twilio.ts | 24 | Twilio conversations, calls, config, user settings |
| server/routes/videoAnalysis.ts | 8 | Video analysis, transcript, search |
| server/routes/activity.ts | 3 | Activity logging and stats |
| server/routes/helpers.ts | 0 | Utility functions, no routes |

## Middleware Inventory

### Auth Middleware
| Name | Type | Location |
|---|---|---|
| isAuthenticated | Session/Replit auth | replit_integrations/auth |
| requireCeo | Role >= ceo | middleware.ts |
| requireTeamLead | Role >= team_lead | middleware.ts |
| requireAccountManager | Role >= account_manager | middleware.ts |
| requireCommandCenterAccess | Role >= account_manager + client exists | middleware.ts |
| requireTwilioAccess | Role-based (sales=read-only) | middleware.ts |
| requireCeoToolsAuth | Bearer token | middleware.ts |
| requireInternal | isAuthenticated + user exists (MCU-only) | mcu.ts (local) |
| validateTwilioWebhook | Twilio signature validation | twilio.ts (local) |

### Rate Limiters
| Name | Window | Base Max | Used On |
|---|---|---|---|
| aiLimiter | 15 min | 20 | CEO Pulse analyze/refine, AI format, ATS score |
| webhookLimiter | 15 min | 300 | Not applied to any route directly |
| writeLimiter | 15 min | 60 | Not applied to any route directly |
| uploadLimiter | 15 min | 20 | Not applied to any route directly |
| adminLimiter | 15 min | 30 | Not applied to any route directly |
| sensitiveWriteLimiter | 15 min | 15 | Not applied to any route directly |

Note: webhookLimiter, writeLimiter, uploadLimiter, adminLimiter, and sensitiveWriteLimiter are exported but NOT applied to any routes in the current codebase. They may be intended for future use or applied at a different layer.

### Upload Middleware
| Name | Max Size | File Types | Used On |
|---|---|---|---|
| upload | 10MB | PDF only | report import/reimport |
| jdUpload | 10MB | PDF, DOCX, TXT | ATS parse-jd, parse-scorecard, upload-resume |

## Anomalies Detected

### Duplicate Route Registrations
| Method | Path | Files | Notes |
|---|---|---|---|
| POST | /api/integrations/work-queue/dead-letter/replay-all | integrations.ts:1572, integrations.ts:1600 | Registered twice — second registration will shadow the first |

### Security Observations
1. **Activity routes** (POST/GET /api/activity, GET /api/activity/stats) — RESOLVED (Task #372). POST /api/activity now uses `isAuthenticated`; GET /api/activity and GET /api/activity/stats use `isAuthenticated` + `requireAccountManager`.
2. **Trends routes**:
   - POST /api/trends/practice-areas — RESOLVED (Task #372): now requires `isAuthenticated` (invokes OpenAI).
   - GET /api/trends, GET /api/trends/practice-areas/list, GET /api/phase-settings — INTENTIONALLY PUBLIC (documented inline in `server/routes/settings.ts`). They return only generic, hardcoded reference data and are used by publicly-shared report views. Writes to phase-settings remain CEO-only.
3. **ATS generate-webhook** (POST /api/ats/jobs/:id/generate-webhook) — RESOLVED (Task #372): now uses `requireCeoToolsAuth` middleware (Authorization Bearer CEO_TOOLS_API_TOKEN). Intentionally public for external scheduler/webhook callers.
4. **Webhook import** (POST /api/webhooks/report-import) — INTENTIONALLY PUBLIC, documented in `server/routes/reports.ts`. Authenticated inside the handler via either Authorization Bearer CEO_TOOLS_API_TOKEN or x-webhook-secret matching WEBHOOK_SECRET.
5. **Five rate limiters** (webhookLimiter, writeLimiter, uploadLimiter, adminLimiter, sensitiveWriteLimiter) are defined but never applied to any routes.

## Summary

| Metric | Value |
|---|---|
| Total routes discovered | 405 |
| Public routes in plan | 9 patterns |
| Public routes in code | 32 |
| Public routes missed by plan | 23 |
| Route files in plan | 14 |
| Route files with routes (actual) | 16 |
| Route files missed by plan | 3 (twilio, videoAnalysis, activity) |
| Middleware types discovered | 9 |
| Rate limiters defined | 6 |
| Rate limiters actually applied | 1 (aiLimiter) |
| Upload middleware types | 2 |
