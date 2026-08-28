# Route Inventory Report
Generated: 2026-08-27T20:56:58.685Z
Total routes discovered: 1558

## Summary by Protection Level

| Protection | Count |
|---|---|
| authenticated | 546 |
| requireAccountManager | 312 |
| requireCeo | 136 |
| public | 64 |
| requireTeamLead | 408 |
| requireCommandCenterAccess | 34 |
| requireCeoToolsAuth | 3 |
| requireInternal | 6 |
| requireTwilioAccess | 36 |
| validateTwilioWebhook | 13 |

## Summary by File

| File | Count |
|---|---|
| server/routes/activity.ts | 4 |
| server/routes/adsOs.ts | 53 |
| server/routes/agents.ts | 71 |
| server/routes/alertChannels.ts | 9 |
| server/routes/ats.ts | 39 |
| server/routes/auditRetentionAdmin.ts | 19 |
| server/routes/backups.ts | 4 |
| server/routes/billing.ts | 5 |
| server/routes/blockedEventsRetentionAdmin.ts | 7 |
| server/routes/bookBuyerJourney.ts | 3 |
| server/routes/bookCheckout.ts | 6 |
| server/routes/bookDelivery.ts | 8 |
| server/routes/bookOperations.ts | 7 |
| server/routes/booking.ts | 34 |
| server/routes/campaigns.ts | 8 |
| server/routes/ceoTools.ts | 11 |
| server/routes/churn.ts | 14 |
| server/routes/clerkAdmin.ts | 2 |
| server/routes/clickup.ts | 155 |
| server/routes/clickupCompanyToken.ts | 4 |
| server/routes/clientFiles.ts | 4 |
| server/routes/clients.ts | 23 |
| server/routes/commandCenter.ts | 23 |
| server/routes/comms/bookmarks.ts | 6 |
| server/routes/comms/calls.ts | 5 |
| server/routes/comms/channels.ts | 20 |
| server/routes/comms/clientAndAttachments.ts | 3 |
| server/routes/comms/draftsScheduled.ts | 10 |
| server/routes/comms/interactions.ts | 14 |
| server/routes/comms/messages.ts | 15 |
| server/routes/comms/realtime.ts | 9 |
| server/routes/comms/sidebarPrefs.ts | 21 |
| server/routes/comms/webhooksEmoji.ts | 11 |
| server/routes/communications.ts | 55 |
| server/routes/conversationDedupeConflicts.ts | 2 |
| server/routes/dealAutomation.ts | 14 |
| server/routes/deals.ts | 10 |
| server/routes/docs.ts | 20 |
| server/routes/emailSequences.ts | 21 |
| server/routes/feedback.ts | 7 |
| server/routes/feedbackSlackRetry.ts | 3 |
| server/routes/ghlMarketplaceWebhook.ts | 1 |
| server/routes/googleAds.ts | 6 |
| server/routes/googleAdsAudit.ts | 4 |
| server/routes/googleAdsHygiene.ts | 9 |
| server/routes/health/core.ts | 17 |
| server/routes/health/diagnosticsAndDigests.ts | 14 |
| server/routes/health/manualReserveAlertsAdmin.ts | 3 |
| server/routes/health/opsAndIncidents.ts | 16 |
| server/routes/health/postDeployVerification.ts | 9 |
| server/routes/heatmap.ts | 59 |
| server/routes/importSuggestions.ts | 3 |
| server/routes/integrations/frontAnalyticsCoverage.ts | 19 |
| server/routes/integrations/frontAutoClosure.ts | 8 |
| server/routes/integrations/frontConnection.ts | 4 |
| server/routes/integrations/frontConsole.ts | 12 |
| server/routes/integrations/frontFilterRules.ts | 10 |
| server/routes/integrations/frontHistoricalRecovery.ts | 26 |
| server/routes/integrations/frontOps.ts | 8 |
| server/routes/integrations/ghl.ts | 3 |
| server/routes/integrations/hub.ts | 7 |
| server/routes/integrations/pipeline.ts | 3 |
| server/routes/integrations/semrush.ts | 8 |
| server/routes/integrations/unmatched.ts | 13 |
| server/routes/integrations/workQueue.ts | 19 |
| server/routes/integrations/zoom.ts | 2 |
| server/routes/internalUsage.ts | 2 |
| server/routes/ipBlocking.ts | 5 |
| server/routes/leads.ts | 5 |
| server/routes/liveData.ts | 2 |
| server/routes/matchSettings.ts | 11 |
| server/routes/mcu.ts | 10 |
| server/routes/notifications.ts | 14 |
| server/routes/onboardingIntake.ts | 2 |
| server/routes/onboardingRosterAdmin.ts | 5 |
| server/routes/orphanedUserHeal.ts | 1 |
| server/routes/outboundEmail.ts | 18 |
| server/routes/poolAuditTrends.ts | 1 |
| server/routes/prodActions.ts | 5 |
| server/routes/queueControl.ts | 12 |
| server/routes/rateLimitAdmin.ts | 22 |
| server/routes/rateLimitMultipliers.ts | 8 |
| server/routes/rateLimitNotifications.ts | 23 |
| server/routes/rateLimitRetention.ts | 8 |
| server/routes/reports.ts | 38 |
| server/routes/revAiWebhook.ts | 1 |
| server/routes/ris.ts | 17 |
| server/routes/roadmap.ts | 9 |
| server/routes/savePlays.ts | 6 |
| server/routes/scoring.ts | 7 |
| server/routes/semrushCadence.ts | 2 |
| server/routes/serviceDesk/clickupImports.ts | 3 |
| server/routes/serviceDesk/configSetup.ts | 5 |
| server/routes/serviceDesk/departments.ts | 34 |
| server/routes/serviceDesk/reports.ts | 3 |
| server/routes/serviceDesk/requestTypes.ts | 8 |
| server/routes/serviceDesk/templates.ts | 9 |
| server/routes/serviceDesk/ticketActions.ts | 7 |
| server/routes/serviceDesk/ticketsRead.ts | 10 |
| server/routes/settings.ts | 28 |
| server/routes/sheets.ts | 47 |
| server/routes/smsConsent.ts | 8 |
| server/routes/tagsSegments.ts | 13 |
| server/routes/timeline.ts | 2 |
| server/routes/twilio.ts | 71 |
| server/routes/userNotifications.ts | 13 |
| server/routes/userSlackPreferences.ts | 10 |
| server/routes/videoAnalysis.ts | 9 |
| server/routes/website.ts | 2 |

## Summary by Classification

| Classification | Count |
|---|---|
| authenticated | 1478 |
| admin_only | 295 |
| public | 64 |
| upload | 8 |
| token_auth | 3 |
| ai_rate_limited | 118 |
| webhook | 32 |

## Public Routes (No Auth Required)

| Method | Path | File | Middleware |
|---|---|---|---|
| GET | /api/ads-os/cron/clickup-health | server/routes/adsOs.ts:1365 | none |
| POST | /api/ads-os/cron/refresh-pacing | server/routes/adsOs.ts:1387 | none |
| GET | /api/ats/portal/:token | server/routes/ats.ts:1282 | none |
| POST | /api/ats/portal/:token/submit | server/routes/ats.ts:1350 | none |
| POST | /api/ats/portal/:token/complete-screening | server/routes/ats.ts:1455 | none |
| POST | /api/ats/portal/:token/complete-video | server/routes/ats.ts:1505 | none |
| POST | /api/ats/portal/:token/video-upload-url | server/routes/ats.ts:1888 | none |
| POST | /api/ats/portal/:token/submit-video | server/routes/ats.ts:1918 | none |
| POST | /api/stripe/webhook | server/routes/billing.ts:151 | none |
| POST | /api/book/journey/start | server/routes/bookBuyerJourney.ts:275 | bookCheckoutLimiter |
| POST | /api/book/journey/submit | server/routes/bookBuyerJourney.ts:350 | bookCheckoutLimiter |
| POST | /api/book/journey/status | server/routes/bookBuyerJourney.ts:385 | bookCheckoutLimiter |
| GET | /api/book/checkout/catalog | server/routes/bookCheckout.ts:351 | bookCheckoutLimiter |
| POST | /api/book/checkout/start | server/routes/bookCheckout.ts:379 | bookCheckoutLimiter |
| POST | /api/book/checkout/resume | server/routes/bookCheckout.ts:477 | bookCheckoutLimiter |
| POST | /api/book/checkout/contact | server/routes/bookCheckout.ts:541 | bookCheckoutLimiter |
| POST | /api/book/checkout/totals | server/routes/bookCheckout.ts:663 | bookCheckoutLimiter |
| POST | /api/book/checkout/payment-intent | server/routes/bookCheckout.ts:760 | bookCheckoutLimiter |
| POST | /api/book/delivery/exchange | server/routes/bookDelivery.ts:93 | bookCheckoutLimiter |
| POST | /api/book/delivery/resend | server/routes/bookDelivery.ts:114 | bookCheckoutLimiter |
| GET | /api/book/delivery/assets | server/routes/bookDelivery.ts:131 | bookCheckoutLimiter |
| GET | /api/book/delivery/order-status | server/routes/bookDelivery.ts:144 | bookCheckoutLimiter |
| GET | /api/book/delivery/download/:assetId | server/routes/bookDelivery.ts:157 | bookCheckoutLimiter |
| GET | /api/integrations/google-calendar/callback | server/routes/booking.ts:1047 | none |
| POST | /api/book/:slug/recurrence/preview-availability | server/routes/booking.ts:2923 | none |
| DELETE | /api/booking/:id | server/routes/booking.ts:3153 | writeLimiter |
| GET | /api/ceo-tools/call-analysis/:analysisId | server/routes/ceoTools.ts:397 | none |
| GET | /api/integrations/clickup/callback | server/routes/clickup.ts:187 | none |
| POST | /api/webhooks/clickup | server/routes/clickup.ts:2047 | none |
| GET | /share/file/:token | server/routes/clientFiles.ts:1057 | none |
| POST | /api/comms/incoming/:token | server/routes/comms/bookmarks.ts:233 | none |
| POST | /api/comms/webhook/livekit | server/routes/comms/calls.ts:269 | none |
| GET | /api/integrations/front/callback | server/routes/communications.ts:499 | none |
| GET | /api/integrations/zoom/callback | server/routes/communications.ts:1460 | none |
| GET | /api/admin/conversation-dedupe-conflicts | server/routes/conversationDedupeConflicts.ts:25 | none |
| POST | /api/admin/conversation-dedupe-conflicts/resolve | server/routes/conversationDedupeConflicts.ts:48 | none |
| POST | /api/integrations/ghl/marketplace-webhook | server/routes/ghlMarketplaceWebhook.ts:497 | none |
| GET | /api/health | server/routes/health/core.ts:63 | none |
| GET | /api/health/history | server/routes/health/core.ts:309 | none |
| GET | /api/health/history/export | server/routes/health/core.ts:479 | none |
| GET | /api/public/heatmaps/:snapshotId/geojson | server/routes/heatmap.ts:39 | none |
| GET | /api/public/heatmaps/:snapshotId/meta | server/routes/heatmap.ts:65 | none |
| POST | /api/integrations/front/webhook | server/routes/integrations/frontConnection.ts:22 | none |
| POST | /api/integrations/zoom/webhook | server/routes/integrations/zoom.ts:34 | none |
| GET | /api/mcu/practice-areas | server/routes/mcu.ts:12 | none |
| POST | /api/mcu/evaluate | server/routes/mcu.ts:16 | none |
| GET | /api/public/config/maptiler-key | server/routes/mcu.ts:197 | none |
| GET | /api/email/unsubscribe | server/routes/outboundEmail.ts:455 | none |
| POST | /api/email/unsubscribe | server/routes/outboundEmail.ts:475 | none |
| POST | /api/webhooks/sendgrid-events | server/routes/outboundEmail.ts:506 | none |
| GET | /api/ceo-pulse/share/:token | server/routes/reports.ts:1484 | none |
| GET | /api/ceo-pulse-charts/:monthKey/chart-:index.png | server/routes/reports.ts:1531 | none |
| GET | /api/ceo-pulse-charts/:monthKey/image-:slot | server/routes/reports.ts:1567 | none |
| POST | /api/webhooks/report-import | server/routes/reports.ts:1983 | upload.single |
| GET | /api/share/:token | server/routes/reports.ts:5270 | none |
| GET | /api/demo-report | server/routes/reports.ts:5418 | none |
| POST | /api/webhooks/rev-ai | server/routes/revAiWebhook.ts:42 | none |
| GET | /api/public/roadmap | server/routes/roadmap.ts:197 | none |
| GET | /api/phase-settings | server/routes/settings.ts:1143 | none |
| POST | /api/twilio/webhooks/voice-twiml-browser | server/routes/twilio.ts:1039 | none |
| POST | /api/twilio/webhooks/voice-whisper | server/routes/twilio.ts:1133 | none |
| POST | /api/integrations/twelvelabs/webhook | server/routes/videoAnalysis.ts:285 | none |
| GET | /api/website/inquiry/config | server/routes/website.ts:179 | none |
| POST | /api/website/inquiry | server/routes/website.ts:188 | none |

## Webhook Routes

| Method | Path | File | Protection | Middleware |
|---|---|---|---|---|
| POST | /api/stripe/webhook | server/routes/billing.ts:151 | public | none |
| GET | /api/clickup/workspaces/:workspaceId/webhooks | server/routes/clickup.ts:1973 | requireAccountManager | isAuthenticated, requireAccountManager |
| POST | /api/clickup/workspaces/:workspaceId/webhooks | server/routes/clickup.ts:1989 | requireAccountManager | isAuthenticated, requireAccountManager |
| DELETE | /api/clickup/webhooks/:webhookId | server/routes/clickup.ts:2025 | requireAccountManager | isAuthenticated, requireAccountManager |
| POST | /api/webhooks/clickup | server/routes/clickup.ts:2047 | public | none |
| POST | /api/comms/webhook/livekit | server/routes/comms/calls.ts:269 | public | none |
| POST | /api/comms/webhooks | server/routes/comms/webhooksEmoji.ts:30 | authenticated | isAuthenticated |
| GET | /api/comms/webhooks | server/routes/comms/webhooksEmoji.ts:79 | authenticated | isAuthenticated |
| DELETE | /api/comms/webhooks/:id | server/routes/comms/webhooksEmoji.ts:97 | authenticated | isAuthenticated |
| POST | /api/integrations/front/webhook | server/routes/integrations/frontConnection.ts:22 | public | none |
| POST | /api/integrations/zoom/webhook | server/routes/integrations/zoom.ts:34 | public | none |
| POST | /api/webhooks/sendgrid-events | server/routes/outboundEmail.ts:506 | public | none |
| POST | /api/webhooks/report-import | server/routes/reports.ts:1983 | public | upload.single |
| GET | /api/webhook-import-logs | server/routes/reports.ts:3012 | requireCeo | isAuthenticated, requireCeo |
| GET | /api/webhook-import-logs/:id/extracted-text | server/routes/reports.ts:3044 | requireCeo | isAuthenticated, requireCeo |
| POST | /api/webhooks/rev-ai | server/routes/revAiWebhook.ts:42 | public | none |
| POST | /api/twilio/webhooks/sms | server/routes/twilio.ts:692 | validateTwilioWebhook | validateTwilioWebhook |
| POST | /api/twilio/webhooks/sms-status | server/routes/twilio.ts:726 | validateTwilioWebhook | validateTwilioWebhook |
| POST | /api/twilio/webhooks/call-status | server/routes/twilio.ts:758 | validateTwilioWebhook | validateTwilioWebhook |
| POST | /api/twilio/webhooks/voice-twiml | server/routes/twilio.ts:786 | validateTwilioWebhook | validateTwilioWebhook |
| POST | /api/twilio/webhooks/voice-routing-callback | server/routes/twilio.ts:856 | validateTwilioWebhook | validateTwilioWebhook |
| POST | /api/twilio/webhooks/voice-ivr | server/routes/twilio.ts:930 | validateTwilioWebhook | validateTwilioWebhook |
| POST | /api/twilio/webhooks/voice-twiml-outbound | server/routes/twilio.ts:972 | validateTwilioWebhook | validateTwilioWebhook |
| POST | /api/twilio/webhooks/voice-twiml-forward-bridge | server/routes/twilio.ts:1004 | validateTwilioWebhook | validateTwilioWebhook |
| POST | /api/twilio/webhooks/voice-twiml-browser | server/routes/twilio.ts:1039 | public | none |
| POST | /api/twilio/webhooks/voice-whisper | server/routes/twilio.ts:1133 | public | none |
| POST | /api/twilio/webhooks/recording-status | server/routes/twilio.ts:1175 | validateTwilioWebhook | validateTwilioWebhook |
| POST | /api/twilio/webhooks/voicemail-recording-status | server/routes/twilio.ts:1262 | validateTwilioWebhook | validateTwilioWebhook |
| POST | /api/twilio/webhooks/voicemail-transcription | server/routes/twilio.ts:1296 | validateTwilioWebhook | validateTwilioWebhook |
| POST | /api/twilio/webhooks/voicemail-action | server/routes/twilio.ts:1354 | validateTwilioWebhook | validateTwilioWebhook |
| POST | /api/twilio/webhooks/voice-twiml-browser-dial-status | server/routes/twilio.ts:1363 | validateTwilioWebhook | validateTwilioWebhook |
| POST | /api/integrations/twelvelabs/webhook | server/routes/videoAnalysis.ts:285 | public | none |

## Token-Auth Routes (API Key / Bearer Token)

| Method | Path | File | Middleware |
|---|---|---|---|
| POST | /api/ats/jobs/:id/generate-webhook | server/routes/ats.ts:443 | requireCeoToolsAuth |
| POST | /api/ats/batch-rescore | server/routes/ats.ts:857 | requireCeoToolsAuth |
| POST | /api/ceo-tools/call-analysis | server/routes/ceoTools.ts:30 | requireCeoToolsAuth |

## AI/Rate-Limited Routes

| Method | Path | File | Rate Limiter | Protection |
|---|---|---|---|---|
| POST | /api/ats/candidates/:id/score | server/routes/ats.ts:1020 | aiLimiter | requireTeamLead |
| POST | /api/book/journey/start | server/routes/bookBuyerJourney.ts:275 | bookCheckoutLimiter | public |
| POST | /api/book/journey/submit | server/routes/bookBuyerJourney.ts:350 | bookCheckoutLimiter | public |
| POST | /api/book/journey/status | server/routes/bookBuyerJourney.ts:385 | bookCheckoutLimiter | public |
| GET | /api/book/checkout/catalog | server/routes/bookCheckout.ts:351 | bookCheckoutLimiter | public |
| POST | /api/book/checkout/start | server/routes/bookCheckout.ts:379 | bookCheckoutLimiter | public |
| POST | /api/book/checkout/resume | server/routes/bookCheckout.ts:477 | bookCheckoutLimiter | public |
| POST | /api/book/checkout/contact | server/routes/bookCheckout.ts:541 | bookCheckoutLimiter | public |
| POST | /api/book/checkout/totals | server/routes/bookCheckout.ts:663 | bookCheckoutLimiter | public |
| POST | /api/book/checkout/payment-intent | server/routes/bookCheckout.ts:760 | bookCheckoutLimiter | public |
| POST | /api/book/delivery/exchange | server/routes/bookDelivery.ts:93 | bookCheckoutLimiter | public |
| POST | /api/book/delivery/resend | server/routes/bookDelivery.ts:114 | bookCheckoutLimiter | public |
| GET | /api/book/delivery/assets | server/routes/bookDelivery.ts:131 | bookCheckoutLimiter | public |
| GET | /api/book/delivery/order-status | server/routes/bookDelivery.ts:144 | bookCheckoutLimiter | public |
| GET | /api/book/delivery/download/:assetId | server/routes/bookDelivery.ts:157 | bookCheckoutLimiter | public |
| PUT | /api/booking/me/page | server/routes/booking.ts:529 | writeLimiter | authenticated |
| PUT | /api/booking/me/availability/rules | server/routes/booking.ts:612 | writeLimiter | authenticated |
| POST | /api/booking/me/availability/overrides | server/routes/booking.ts:639 | writeLimiter | authenticated |
| DELETE | /api/booking/me/availability/overrides/:id | server/routes/booking.ts:660 | writeLimiter | authenticated |
| POST | /api/booking/me/meeting-types | server/routes/booking.ts:717 | writeLimiter | authenticated |
| PUT | /api/booking/me/meeting-types/:id | server/routes/booking.ts:757 | writeLimiter | authenticated |
| DELETE | /api/booking/me/meeting-types/:id | server/routes/booking.ts:801 | writeLimiter | authenticated |
| POST | /api/booking/me/meetings/:id/cancel | server/routes/booking.ts:989 | writeLimiter | authenticated |
| POST | /api/integrations/google-calendar/disconnect | server/routes/booking.ts:1075 | writeLimiter | authenticated |
| PUT | /api/booking/me/calendar | server/routes/booking.ts:1111 | writeLimiter | authenticated |
| PUT | /api/booking/me/zoom-host | server/routes/booking.ts:1556 | writeLimiter | authenticated |
| DELETE | /api/booking/me/zoom-host | server/routes/booking.ts:1667 | writeLimiter | authenticated |
| POST | /api/booking/me/client-links | server/routes/booking.ts:1702 | writeLimiter | authenticated |
| POST | /api/booking/clients/:clientId/book | server/routes/booking.ts:2433 | writeLimiter | authenticated |
| PATCH | /api/booking/:id | server/routes/booking.ts:3015 | writeLimiter | authenticated |
| DELETE | /api/booking/:id | server/routes/booking.ts:3153 | writeLimiter | public |
| POST | /api/comms/channels/:id/bookmarks | server/routes/comms/bookmarks.ts:78 | commsWriteLimiter | authenticated |
| PATCH | /api/comms/channels/:id/bookmarks/:bId | server/routes/comms/bookmarks.ts:132 | commsWriteLimiter | authenticated |
| DELETE | /api/comms/channels/:id/bookmarks/:bId | server/routes/comms/bookmarks.ts:163 | commsWriteLimiter | authenticated |
| PUT | /api/comms/channels/:id/bookmarks/reorder | server/routes/comms/bookmarks.ts:201 | commsWriteLimiter | authenticated |
| PUT | /api/comms/default-channels | server/routes/comms/channels.ts:146 | commsWriteLimiter | authenticated |
| POST | /api/comms/default-channels/apply-existing | server/routes/comms/channels.ts:179 | commsWriteLimiter | authenticated |
| PUT | /api/comms/channels/:id/draft | server/routes/comms/draftsScheduled.ts:28 | commsWriteLimiter | authenticated |
| POST | /api/comms/channels/:id/scheduled-messages | server/routes/comms/draftsScheduled.ts:178 | commsWriteLimiter | authenticated |
| PATCH | /api/comms/scheduled-messages/:id | server/routes/comms/draftsScheduled.ts:238 | commsWriteLimiter | authenticated |
| DELETE | /api/comms/scheduled-messages/:id | server/routes/comms/draftsScheduled.ts:277 | commsWriteLimiter | authenticated |
| POST | /api/comms/messages/:id/reminders | server/routes/comms/interactions.ts:29 | commsWriteLimiter | authenticated |
| DELETE | /api/comms/reminders/:id | server/routes/comms/interactions.ts:69 | commsWriteLimiter | authenticated |
| POST | /api/comms/messages/:id/forward | server/routes/comms/interactions.ts:91 | commsWriteLimiter | authenticated |
| POST | /api/comms/channels/:id/typing | server/routes/comms/interactions.ts:145 | commsWriteLimiter | authenticated |
| POST | /api/comms/messages/:id/reactions | server/routes/comms/interactions.ts:174 | commsWriteLimiter | authenticated |
| DELETE | /api/comms/messages/:id/reactions/:emoji | server/routes/comms/interactions.ts:208 | commsWriteLimiter | authenticated |
| POST | /api/comms/channels/:id/messages | server/routes/comms/messages.ts:126 | commsWriteLimiter | authenticated |
| PATCH | /api/comms/messages/:id | server/routes/comms/messages.ts:453 | commsWriteLimiter | authenticated |
| DELETE | /api/comms/messages/:id | server/routes/comms/messages.ts:489 | commsWriteLimiter | authenticated |
| POST | /api/comms/messages/:id/edit-history/:historyId/restore | server/routes/comms/messages.ts:564 | commsWriteLimiter | authenticated |
| POST | /api/comms/presence/heartbeat | server/routes/comms/realtime.ts:158 | commsWriteLimiter | authenticated |
| PUT | /api/comms/status/me | server/routes/comms/realtime.ts:234 | commsWriteLimiter | authenticated |
| PUT | /api/comms/status/me/custom | server/routes/comms/realtime.ts:289 | commsWriteLimiter | authenticated |
| PUT | /api/comms/notification-settings | server/routes/comms/sidebarPrefs.ts:291 | commsWriteLimiter | authenticated |
| POST | /api/docs/documents | server/routes/docs.ts:175 | writeLimiter | requireAccountManager |
| PATCH | /api/docs/documents/:id | server/routes/docs.ts:261 | sheetsAutosaveLimiter | requireAccountManager |
| DELETE | /api/docs/documents/:id | server/routes/docs.ts:386 | writeLimiter | requireAccountManager |
| POST | /api/docs/documents/:id/lock | server/routes/docs.ts:417 | writeLimiter | requireAccountManager |
| PUT | /api/docs/documents/:id/permissions | server/routes/docs.ts:613 | writeLimiter | requireAccountManager |
| DELETE | /api/docs/documents/:id/permissions/:userId | server/routes/docs.ts:666 | writeLimiter | requireAccountManager |
| POST | /api/docs/documents/:id/versions | server/routes/docs.ts:766 | writeLimiter | requireAccountManager |
| POST | /api/docs/documents/:id/versions/:versionId/restore | server/routes/docs.ts:820 | writeLimiter | requireAccountManager |
| POST | /api/docs/documents/import | server/routes/docs.ts:905 | uploadLimiter | requireAccountManager |
| POST | /api/email-templates | server/routes/emailSequences.ts:209 | writeLimiter | authenticated |
| PATCH | /api/email-templates/:id | server/routes/emailSequences.ts:240 | writeLimiter | authenticated |
| POST | /api/email-templates/:id/preview | server/routes/emailSequences.ts:272 | writeLimiter | authenticated |
| POST | /api/email-sequences | server/routes/emailSequences.ts:337 | writeLimiter | authenticated |
| POST | /api/email-sequences/settings | server/routes/emailSequences.ts:388 | writeLimiter | requireCeo |
| POST | /api/email-sequences/step-sends/:id/approve | server/routes/emailSequences.ts:433 | writeLimiter | authenticated |
| PATCH | /api/email-sequences/step-sends/:id | server/routes/emailSequences.ts:466 | writeLimiter | authenticated |
| POST | /api/email-sequences/step-sends/:id/reject | server/routes/emailSequences.ts:496 | writeLimiter | authenticated |
| POST | /api/email-sequences/enrollments/:enrollmentId/cancel | server/routes/emailSequences.ts:524 | writeLimiter | authenticated |
| PATCH | /api/email-sequences/:id | server/routes/emailSequences.ts:580 | writeLimiter | authenticated |
| PATCH | /api/email-sequences/:id/auto-send | server/routes/emailSequences.ts:610 | writeLimiter | authenticated |
| PUT | /api/email-sequences/:id/steps | server/routes/emailSequences.ts:640 | writeLimiter | authenticated |
| POST | /api/email-sequences/:id/enroll | server/routes/emailSequences.ts:671 | writeLimiter | authenticated |
| POST | /api/email-sequences/:id/enroll-segment | server/routes/emailSequences.ts:705 | writeLimiter | authenticated |
| POST | /api/onboarding/intake | server/routes/onboardingIntake.ts:97 | writeLimiter | authenticated |
| POST | /api/outbound-email/compose | server/routes/outboundEmail.ts:168 | writeLimiter | authenticated |
| POST | /api/outbound-email/suppressions | server/routes/outboundEmail.ts:259 | writeLimiter | requireTeamLead |
| DELETE | /api/outbound-email/suppressions/:id | server/routes/outboundEmail.ts:283 | writeLimiter | requireTeamLead |
| PUT | /api/outbound-email/identities/:userId | server/routes/outboundEmail.ts:321 | writeLimiter | requireTeamLead |
| PUT | /api/outbound-email/settings | server/routes/outboundEmail.ts:370 | writeLimiter | requireCeo |
| POST | /api/outbound-email/pause | server/routes/outboundEmail.ts:403 | writeLimiter | requireTeamLead |
| POST | /api/outbound-email/verify-domain | server/routes/outboundEmail.ts:417 | writeLimiter | requireCeo |
| POST | /api/outbound-email/fallback-enabled | server/routes/outboundEmail.ts:432 | writeLimiter | requireCeo |
| POST | /api/ceo-pulses/:id/analyze | server/routes/reports.ts:574 | aiLimiter | requireCeo |
| POST | /api/ceo-pulses/:id/refine | server/routes/reports.ts:897 | aiLimiter | requireCeo |
| POST | /api/ai/format-issues | server/routes/reports.ts:1847 | aiLimiter | authenticated |
| POST | /api/reports/:id/verdicts/draft | server/routes/reports.ts:4531 | aiLimiter | requireAccountManager |
| POST | /api/sheets/folders | server/routes/sheets.ts:114 | writeLimiter | requireAccountManager |
| PATCH | /api/sheets/folders/:id | server/routes/sheets.ts:138 | writeLimiter | requireAccountManager |
| DELETE | /api/sheets/folders/:id | server/routes/sheets.ts:166 | writeLimiter | requireAccountManager |
| POST | /api/sheets/workbooks | server/routes/sheets.ts:306 | writeLimiter | requireAccountManager |
| PATCH | /api/sheets/workbooks/:id | server/routes/sheets.ts:353 | sheetsAutosaveLimiter | requireAccountManager |
| DELETE | /api/sheets/workbooks/:id | server/routes/sheets.ts:471 | writeLimiter | requireAccountManager |
| POST | /api/sheets/workbooks/:id/lock | server/routes/sheets.ts:511 | writeLimiter | requireAccountManager |
| POST | /api/sheets/workbooks/:id/lock/heartbeat | server/routes/sheets.ts:551 | writeLimiter | requireAccountManager |
| DELETE | /api/sheets/workbooks/:id/lock | server/routes/sheets.ts:584 | writeLimiter | requireAccountManager |
| PUT | /api/sheets/workbooks/:id/permissions | server/routes/sheets.ts:690 | writeLimiter | requireAccountManager |
| DELETE | /api/sheets/workbooks/:id/permissions/:userId | server/routes/sheets.ts:735 | writeLimiter | requireAccountManager |
| POST | /api/sheets/workbooks/import | server/routes/sheets.ts:789 | uploadLimiter | requireAccountManager |
| POST | /api/sheets/workbooks/:id/versions | server/routes/sheets.ts:1074 | writeLimiter | requireAccountManager |
| POST | /api/sheets/workbooks/:id/versions/:versionId/restore | server/routes/sheets.ts:1122 | writeLimiter | requireAccountManager |
| POST | /api/sheets/workbooks/:id/blocks | server/routes/sheets.ts:1239 | writeLimiter | requireAccountManager |
| PUT | /api/sheets/workbooks/:id/role-grants | server/routes/sheets.ts:1279 | writeLimiter | requireAccountManager |
| PATCH | /api/sheets/workbooks/:wId/blocks/:bId | server/routes/sheets.ts:1314 | writeLimiter | requireAccountManager |
| DELETE | /api/sheets/workbooks/:wId/blocks/:bId | server/routes/sheets.ts:1347 | writeLimiter | requireAccountManager |
| DELETE | /api/sheets/workbooks/:id/role-grants/:role | server/routes/sheets.ts:1373 | writeLimiter | requireAccountManager |
| POST | /api/sheets/workbooks/:id/duplicate | server/routes/sheets.ts:1403 | writeLimiter | requireAccountManager |
| POST | /api/sheets/workbooks/:id/save-as-template | server/routes/sheets.ts:1454 | writeLimiter | requireAccountManager |
| PATCH | /api/sheets/templates/:id | server/routes/sheets.ts:1542 | writeLimiter | requireAccountManager |
| DELETE | /api/sheets/templates/:id | server/routes/sheets.ts:1587 | writeLimiter | requireAccountManager |
| POST | /api/sheets/templates/:id/workbook | server/routes/sheets.ts:1618 | writeLimiter | requireAccountManager |
| POST | /api/sheets/workbooks/:id/dashboard | server/routes/sheets.ts:1709 | writeLimiter | requireAccountManager |
| DELETE | /api/sheets/workbooks/:id/dashboard | server/routes/sheets.ts:1746 | writeLimiter | requireAccountManager |
| POST | /api/sheets/workbooks/:wId/blocks/:bId/refresh | server/routes/sheets.ts:1852 | writeLimiter | requireAccountManager |

## Upload Routes

| Method | Path | File | Upload Middleware | Protection |
|---|---|---|---|---|
| POST | /api/ats/parse-jd | server/routes/ats.ts:232 | jdUpload.single | requireTeamLead |
| POST | /api/ats/parse-scorecard | server/routes/ats.ts:301 | jdUpload.single | requireTeamLead |
| POST | /api/ats/candidates/:id/upload-resume | server/routes/ats.ts:771 | jdUpload.single | requireTeamLead |
| POST | /api/clickup/tasks/:taskId/attachments | server/routes/clickup.ts:1033 | upload.single | authenticated |
| POST | /api/clickup/entity/:entityId/attachments | server/routes/clickup.ts:1106 | upload.single | authenticated |
| POST | /api/reports/import-pdf | server/routes/reports.ts:1911 | upload.single | requireAccountManager |
| POST | /api/webhooks/report-import | server/routes/reports.ts:1983 | upload.single | public |
| POST | /api/reports/:id/reimport | server/routes/reports.ts:3059 | upload.single | requireAccountManager |

## Full Route Inventory

| # | Method | Path | File:Line | Protection | Middleware | Classifications |
|---|---|---|---|---|---|---|
| 1 | POST | /api/activity | server/routes/activity.ts:24 | authenticated | isAuthenticated | authenticated |
| 2 | GET | /api/activity | server/routes/activity.ts:77 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 3 | GET | /api/audit-history | server/routes/activity.ts:123 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 4 | GET | /api/activity/stats | server/routes/activity.ts:140 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 5 | GET | /api/ads-os/status | server/routes/adsOs.ts:187 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 6 | GET | /api/ads-os/proofs/accounts | server/routes/adsOs.ts:222 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 7 | GET | /api/ads-os/proofs/clickup | server/routes/adsOs.ts:247 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 8 | GET | /api/ads-os/proofs/openai | server/routes/adsOs.ts:292 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 9 | GET | /api/ads-os/proofs/store | server/routes/adsOs.ts:328 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 10 | GET | /api/ads-os/dashboard | server/routes/adsOs.ts:426 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 11 | GET | /api/ads-os/lsa/dashboard | server/routes/adsOs.ts:443 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 12 | GET | /api/ads-os/combined/dashboard | server/routes/adsOs.ts:460 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 13 | GET | /api/ads-os/accounts | server/routes/adsOs.ts:482 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 14 | GET | /api/ads-os/monitored-accounts | server/routes/adsOs.ts:503 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 15 | GET | /api/ads-os/lsa/monitored-accounts | server/routes/adsOs.ts:519 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 16 | GET | /api/ads-os/clients | server/routes/adsOs.ts:538 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 17 | GET | /api/ads-os/dashboard/pacing | server/routes/adsOs.ts:559 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 18 | POST | /api/ads-os/directory/refresh | server/routes/adsOs.ts:606 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 19 | GET | /api/ads-os/budget-pacing/:cid | server/routes/adsOs.ts:633 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 20 | GET | /api/ads-os/lsa/pacing/:cid | server/routes/adsOs.ts:648 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 21 | GET | /api/ads-os/clients/:cid/criteria | server/routes/adsOs.ts:773 | authenticated | isAuthenticated | authenticated |
| 22 | GET | /api/ads-os/keyword-intel/:cid/criteria | server/routes/adsOs.ts:778 | authenticated | isAuthenticated | authenticated |
| 23 | PUT | /api/ads-os/clients/:cid/criteria | server/routes/adsOs.ts:783 | authenticated | isAuthenticated | authenticated |
| 24 | PUT | /api/ads-os/keyword-intel/:cid/criteria | server/routes/adsOs.ts:788 | authenticated | isAuthenticated | authenticated |
| 25 | GET | /api/ads-os/audit/:cid | server/routes/adsOs.ts:816 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 26 | POST | /api/ads-os/audit/:cid/run | server/routes/adsOs.ts:840 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 27 | GET | /api/ads-os/audit/:cid/report.html | server/routes/adsOs.ts:854 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 28 | POST | /api/ads-os/dashboard/run-audits | server/routes/adsOs.ts:875 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 29 | GET | /api/ads-os/audit/:cid/history | server/routes/adsOs.ts:885 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 30 | GET | /api/ads-os/lsa/hygiene/:cid | server/routes/adsOs.ts:895 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 31 | GET | /api/ads-os/lsa/hygiene/:cid/history | server/routes/adsOs.ts:909 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 32 | GET | /api/ads-os/lsa/hygiene/:cid/report.html | server/routes/adsOs.ts:919 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 33 | POST | /api/ads-os/lsa/dashboard/run-audits | server/routes/adsOs.ts:938 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 34 | GET | /api/ads-os/keyword-intel/:cid | server/routes/adsOs.ts:955 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 35 | GET | /api/ads-os/keyword-intel/:cid/keywords | server/routes/adsOs.ts:969 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 36 | GET | /api/ads-os/pyramid/:cid | server/routes/adsOs.ts:988 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 37 | POST | /api/ads-os/keyword-intel/:cid/keywords/actioned | server/routes/adsOs.ts:1004 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 38 | GET | /api/ads-os/client/profile | server/routes/adsOs.ts:1022 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 39 | GET | /api/ads-os/client/performance | server/routes/adsOs.ts:1044 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 40 | GET | /api/ads-os/client/log-summary | server/routes/adsOs.ts:1082 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 41 | GET | /api/ads-os/clients/:cid/sibling | server/routes/adsOs.ts:1106 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 42 | POST | /api/ads-os/dashboard/run-alerts | server/routes/adsOs.ts:1119 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 43 | POST | /api/ads-os/lsa/dashboard/run-alerts | server/routes/adsOs.ts:1127 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 44 | POST | /api/ads-os/combined/dashboard/run-alerts | server/routes/adsOs.ts:1138 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 45 | GET | /api/ads-os/am/dashboard | server/routes/adsOs.ts:1153 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 46 | POST | /api/ads-os/dashboard/run-status-checks | server/routes/adsOs.ts:1185 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 47 | POST | /api/ads-os/lsa/dashboard/run-status-checks | server/routes/adsOs.ts:1206 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 48 | POST | /api/ads-os/am/dashboard/refresh | server/routes/adsOs.ts:1224 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 49 | GET | /api/ads-os/clickup/enabled | server/routes/adsOs.ts:1267 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 50 | POST | /api/ads-os/clickup/task | server/routes/adsOs.ts:1274 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 51 | GET | /api/ads-os/health | server/routes/adsOs.ts:1301 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 52 | GET | /api/ads-os/accounts/:cid/probe | server/routes/adsOs.ts:1313 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 53 | GET | /api/ads-os/cron/clickup-health | server/routes/adsOs.ts:1365 | public | none | public |
| 54 | POST | /api/ads-os/cron/refresh-pacing | server/routes/adsOs.ts:1387 | public | none | public |
| 55 | GET | /api/ads-os/admin/paid-search-role-cutover | server/routes/adsOs.ts:1435 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 56 | GET | /api/ads-os/admin/paid-search-role-cutover/state | server/routes/adsOs.ts:1457 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 57 | PUT | /api/ads-os/admin/paid-search-role-cutover/state | server/routes/adsOs.ts:1490 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 58 | GET | /api/clients/:clientId/contacts | server/routes/agents.ts:149 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 59 | GET | /api/clients/:clientId/contacts/audit | server/routes/agents.ts:161 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 60 | GET | /api/clients/:clientId/locations/audit | server/routes/agents.ts:174 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 61 | GET | /api/clients/:clientId/locations/:id/audit | server/routes/agents.ts:184 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 62 | GET | /api/clients/:clientId/contacts/:id/audit | server/routes/agents.ts:201 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 63 | POST | /api/clients/:clientId/contacts | server/routes/agents.ts:221 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 64 | PUT | /api/clients/:clientId/contacts/:id | server/routes/agents.ts:290 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 65 | DELETE | /api/clients/:clientId/contacts/:id | server/routes/agents.ts:374 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 66 | GET | /api/clients/:clientId/agent-memory | server/routes/agents.ts:400 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 67 | POST | /api/clients/:clientId/agent-memory | server/routes/agents.ts:409 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 68 | PUT | /api/clients/:clientId/agent-memory/:id | server/routes/agents.ts:432 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 69 | DELETE | /api/clients/:clientId/agent-memory/:id | server/routes/agents.ts:456 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 70 | POST | /api/clients/:clientId/agent-memory/:id/promote | server/routes/agents.ts:471 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 71 | GET | /api/clients/:clientId/agent-decisions | server/routes/agents.ts:491 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 72 | GET | /api/clients/:clientId/agent-stats | server/routes/agents.ts:504 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 73 | GET | /api/agent-decisions | server/routes/agents.ts:520 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 74 | PUT | /api/agent-decisions/:id/correct | server/routes/agents.ts:534 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 75 | PUT | /api/agent-decisions/:id/confirm | server/routes/agents.ts:558 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 76 | POST | /api/agent-engine/retroactive/:clientId | server/routes/agents.ts:595 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 77 | POST | /api/integrations/pandadoc/connect | server/routes/agents.ts:664 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 78 | POST | /api/integrations/pandadoc/disconnect | server/routes/agents.ts:706 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 79 | POST | /api/integrations/stripe/connect | server/routes/agents.ts:723 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 80 | POST | /api/integrations/stripe/disconnect | server/routes/agents.ts:741 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 81 | POST | /api/integrations/pandadoc/sync | server/routes/agents.ts:756 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 82 | GET | /api/integrations/pandadoc/documents | server/routes/agents.ts:782 | authenticated | isAuthenticated | authenticated |
| 83 | GET | /api/integrations/pandadoc/documents/:id | server/routes/agents.ts:795 | authenticated | isAuthenticated | authenticated |
| 84 | GET | /api/integrations/pandadoc/documents/:id/pdf | server/routes/agents.ts:806 | authenticated | isAuthenticated | authenticated |
| 85 | POST | /api/integrations/pandadoc/documents/:id/link | server/routes/agents.ts:846 | authenticated | isAuthenticated | authenticated |
| 86 | GET | /api/clients/:clientId/pandadoc-documents | server/routes/agents.ts:868 | authenticated | isAuthenticated | authenticated |
| 87 | GET | /api/clients/:clientId/agent-chat | server/routes/agents.ts:881 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 88 | DELETE | /api/clients/:clientId/agent-chat | server/routes/agents.ts:891 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 89 | POST | /api/clients/:clientId/agent-chat | server/routes/agents.ts:901 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 90 | GET | /api/clients/:clientId/judgments | server/routes/agents.ts:1081 | authenticated | isAuthenticated | authenticated |
| 91 | GET | /api/clients/:clientId/judgments/:judgmentId | server/routes/agents.ts:1107 | authenticated | isAuthenticated | authenticated |
| 92 | GET | /api/clients/:clientId/daily-judgments | server/routes/agents.ts:1133 | authenticated | isAuthenticated | authenticated |
| 93 | GET | /api/clients/:clientId/daily-judgments/:judgmentId | server/routes/agents.ts:1154 | authenticated | isAuthenticated | authenticated |
| 94 | POST | /api/clients/:clientId/daily-judgments/generate | server/routes/agents.ts:1177 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 95 | GET | /api/clients/:clientId/relationship-signals | server/routes/agents.ts:1201 | authenticated | isAuthenticated | authenticated |
| 96 | GET | /api/clients/:clientId/open-asks | server/routes/agents.ts:1222 | authenticated | isAuthenticated | authenticated |
| 97 | PATCH | /api/clients/:clientId/open-asks/:askId | server/routes/agents.ts:1246 | authenticated | isAuthenticated | authenticated |
| 98 | POST | /api/clients/:clientId/open-asks/cleanup-contaminated | server/routes/agents.ts:1293 | authenticated | isAuthenticated | authenticated |
| 99 | GET | /api/clients/:clientId/recent-comms-count | server/routes/agents.ts:1356 | authenticated | isAuthenticated | authenticated |
| 100 | POST | /api/admin/daily-judgments/run-all | server/routes/agents.ts:1378 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 101 | POST | /api/clients/:clientId/judgments/regenerate | server/routes/agents.ts:1390 | authenticated | isAuthenticated | authenticated |
| 102 | GET | /api/clients/:clientId/knowledge | server/routes/agents.ts:1421 | requireCommandCenterAccess | isAuthenticated, requireCommandCenterAccess | authenticated |
| 103 | POST | /api/clients/:clientId/knowledge | server/routes/agents.ts:1439 | requireCommandCenterAccess | isAuthenticated, requireCommandCenterAccess | authenticated |
| 104 | PUT | /api/clients/:clientId/knowledge/:id | server/routes/agents.ts:1473 | requireCommandCenterAccess | isAuthenticated, requireCommandCenterAccess | authenticated |
| 105 | DELETE | /api/clients/:clientId/knowledge/:id | server/routes/agents.ts:1504 | requireCommandCenterAccess | isAuthenticated, requireCommandCenterAccess | authenticated |
| 106 | POST | /api/agent-feedback | server/routes/agents.ts:1522 | authenticated | isAuthenticated | authenticated |
| 107 | GET | /api/clients/:clientId/feedback | server/routes/agents.ts:1596 | requireCommandCenterAccess | isAuthenticated, requireCommandCenterAccess | authenticated |
| 108 | POST | /api/judgments/:judgmentId/feedback | server/routes/agents.ts:1607 | authenticated | isAuthenticated | authenticated |
| 109 | POST | /api/suggestions/:suggestionId/feedback | server/routes/agents.ts:1662 | authenticated | isAuthenticated | authenticated |
| 110 | GET | /api/agents/threshold-policy | server/routes/agents.ts:1725 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 111 | GET | /api/admin/zoom/review-queue | server/routes/agents.ts:1762 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated, admin_only |
| 112 | GET | /api/admin/zoom/guardrail-impact | server/routes/agents.ts:1864 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated, admin_only |
| 113 | GET | /api/admin/zoom/guardrail-change-history-trends | server/routes/agents.ts:2047 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated, admin_only |
| 114 | GET | /api/admin/zoom/review-queue/alert-settings | server/routes/agents.ts:2281 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated, admin_only |
| 115 | PATCH | /api/admin/zoom/review-queue/alert-settings | server/routes/agents.ts:2305 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated, admin_only |
| 116 | POST | /api/admin/zoom/review-queue/alert-settings/test | server/routes/agents.ts:2325 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated, admin_only |
| 117 | GET | /api/admin/zoom/review-queue/trend | server/routes/agents.ts:2348 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated, admin_only |
| 118 | GET | /api/admin/zoom/review-queue/:id | server/routes/agents.ts:2359 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated, admin_only |
| 119 | POST | /api/admin/zoom/review-queue/:id/approve | server/routes/agents.ts:2375 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated, admin_only |
| 120 | POST | /api/admin/zoom/review-queue/:id/dismiss | server/routes/agents.ts:2391 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated, admin_only |
| 121 | POST | /api/admin/zoom/review-queue/bulk-dismiss | server/routes/agents.ts:2412 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated, admin_only |
| 122 | POST | /api/admin/zoom/review-queue/bulk-approve | server/routes/agents.ts:2441 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated, admin_only |
| 123 | POST | /api/admin/zoom/review-queue/:id/reopen | server/routes/agents.ts:2467 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated, admin_only |
| 124 | POST | /api/admin/zoom/match-assistant/sweep | server/routes/agents.ts:2487 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated, admin_only |
| 125 | GET | /api/admin/zoom/match-assistant/sweep | server/routes/agents.ts:2502 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated, admin_only |
| 126 | GET | /api/admin/zoom/match-assistant/calls | server/routes/agents.ts:2513 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated, admin_only |
| 127 | POST | /api/admin/zoom/match-assistant/calls/:id/assign | server/routes/agents.ts:2534 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated, admin_only |
| 128 | POST | /api/admin/zoom/match-assistant/calls/:id/reanalyze | server/routes/agents.ts:2550 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated, admin_only |
| 129 | GET | /api/integrations/slack/channels | server/routes/alertChannels.ts:28 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 130 | GET | /api/admin/match-settings/alert-channel | server/routes/alertChannels.ts:45 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 131 | PUT | /api/admin/match-settings/alert-channel | server/routes/alertChannels.ts:56 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 132 | GET | /api/admin/match-settings/alert-channel/history | server/routes/alertChannels.ts:88 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 133 | GET | /api/admin/match-settings/alert-channel/test-history | server/routes/alertChannels.ts:117 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 134 | GET | /api/admin/match-settings/alert-channel/channel-info | server/routes/alertChannels.ts:138 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 135 | POST | /api/admin/match-settings/alert-channel/test | server/routes/alertChannels.ts:187 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 136 | GET | /api/admin/heatmap-coverage-check/settings | server/routes/alertChannels.ts:263 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 137 | PUT | /api/admin/heatmap-coverage-check/settings | server/routes/alertChannels.ts:286 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 138 | GET | /api/ats/jobs | server/routes/ats.ts:194 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 139 | GET | /api/ats/jobs/:id | server/routes/ats.ts:221 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 140 | POST | /api/ats/parse-jd | server/routes/ats.ts:232 | requireTeamLead | isAuthenticated, requireTeamLead, jdUpload.single | authenticated, upload |
| 141 | POST | /api/ats/parse-scorecard | server/routes/ats.ts:301 | requireTeamLead | isAuthenticated, requireTeamLead, jdUpload.single | authenticated, upload |
| 142 | POST | /api/ats/jobs | server/routes/ats.ts:389 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 143 | PATCH | /api/ats/jobs/:id | server/routes/ats.ts:415 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 144 | POST | /api/ats/jobs/:id/generate-webhook | server/routes/ats.ts:443 | requireCeoToolsAuth | requireCeoToolsAuth | token_auth |
| 145 | POST | /api/ats/jobs/:id/generate | server/routes/ats.ts:505 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 146 | GET | /api/ats/jobs/:jobId/candidates | server/routes/ats.ts:572 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 147 | POST | /api/ats/jobs/:jobId/candidates | server/routes/ats.ts:612 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 148 | POST | /api/ats/jobs/:jobId/candidates/bulk | server/routes/ats.ts:636 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 149 | PATCH | /api/ats/candidates/:id | server/routes/ats.ts:666 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 150 | DELETE | /api/ats/candidates/:id | server/routes/ats.ts:706 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 151 | GET | /api/ats/candidates/:id/submissions | server/routes/ats.ts:739 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 152 | POST | /api/ats/candidates/:id/upload-resume | server/routes/ats.ts:771 | requireTeamLead | isAuthenticated, requireTeamLead, jdUpload.single | authenticated, upload |
| 153 | POST | /api/ats/batch-rescore | server/routes/ats.ts:857 | requireCeoToolsAuth | requireCeoToolsAuth | token_auth |
| 154 | POST | /api/ats/candidates/:id/score | server/routes/ats.ts:1020 | requireTeamLead | isAuthenticated, requireTeamLead, aiLimiter | authenticated, ai_rate_limited |
| 155 | GET | /api/ats/portal/:token | server/routes/ats.ts:1282 | public | none | public |
| 156 | POST | /api/ats/portal/:token/submit | server/routes/ats.ts:1350 | public | none | public |
| 157 | POST | /api/ats/portal/:token/complete-screening | server/routes/ats.ts:1455 | public | none | public |
| 158 | POST | /api/ats/portal/:token/complete-video | server/routes/ats.ts:1505 | public | none | public |
| 159 | POST | /api/ats/jobs/:jobId/candidates/import-csv | server/routes/ats.ts:1737 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 160 | POST | /api/ats/jobs/:jobId/candidates/bulk-update | server/routes/ats.ts:1797 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 161 | POST | /api/ats/jobs/:jobId/recalibrate | server/routes/ats.ts:1825 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 162 | GET | /api/ats/jobs/:jobId/analytics | server/routes/ats.ts:1836 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 163 | POST | /api/ats/portal/:token/video-upload-url | server/routes/ats.ts:1888 | public | none | public |
| 164 | POST | /api/ats/portal/:token/submit-video | server/routes/ats.ts:1918 | public | none | public |
| 165 | POST | /api/ats/candidates/:id/retry-transcription | server/routes/ats.ts:2071 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 166 | GET | /api/ats/email-templates | server/routes/ats.ts:2103 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 167 | POST | /api/ats/email-templates | server/routes/ats.ts:2132 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 168 | PATCH | /api/ats/email-templates/:id | server/routes/ats.ts:2159 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 169 | DELETE | /api/ats/email-templates/:id | server/routes/ats.ts:2189 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 170 | GET | /api/ats/candidates/:id/interviews | server/routes/ats.ts:2205 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 171 | POST | /api/ats/candidates/:id/interviews | server/routes/ats.ts:2236 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 172 | POST | /api/ats/candidates/:id/interviews/:interviewId/analyze | server/routes/ats.ts:2271 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 173 | DELETE | /api/ats/candidates/:id/interviews/:interviewId | server/routes/ats.ts:2375 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 174 | PATCH | /api/ats/candidates/:id/interviews/:interviewId | server/routes/ats.ts:2426 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 175 | GET | /api/ats/candidates/:id/final-decision | server/routes/ats.ts:2450 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 176 | POST | /api/ats/candidates/:id/final-decision | server/routes/ats.ts:2463 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 177 | GET | /api/admin/audit-retention | server/routes/auditRetentionAdmin.ts:21 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 178 | PUT | /api/admin/audit-retention | server/routes/auditRetentionAdmin.ts:45 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 179 | GET | /api/admin/blocked-ip-audit-retention | server/routes/auditRetentionAdmin.ts:81 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 180 | PUT | /api/admin/blocked-ip-audit-retention | server/routes/auditRetentionAdmin.ts:103 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 181 | GET | /api/admin/blocked-ip-trim-alert-config | server/routes/auditRetentionAdmin.ts:141 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 182 | PUT | /api/admin/blocked-ip-trim-alert-config | server/routes/auditRetentionAdmin.ts:168 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 183 | POST | /api/admin/blocked-ip-trim-alert-config/test | server/routes/auditRetentionAdmin.ts:352 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 184 | POST | /api/admin/blocked-ip-trim-alert-config/flush | server/routes/auditRetentionAdmin.ts:373 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 185 | GET | /api/admin/blocked-ip-trim-alert-history | server/routes/auditRetentionAdmin.ts:393 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 186 | GET | /api/admin/audit-prune-anomaly-config | server/routes/auditRetentionAdmin.ts:460 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 187 | PUT | /api/admin/audit-prune-anomaly-config | server/routes/auditRetentionAdmin.ts:538 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 188 | GET | /api/admin/audit-retention/history | server/routes/auditRetentionAdmin.ts:652 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 189 | GET | /api/admin/audit-retention/prune-events | server/routes/auditRetentionAdmin.ts:678 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 190 | POST | /api/admin/audit-retention/prune-now | server/routes/auditRetentionAdmin.ts:807 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 191 | GET | /api/admin/client-contacts-audit-retention | server/routes/auditRetentionAdmin.ts:844 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 192 | PUT | /api/admin/client-contacts-audit-retention | server/routes/auditRetentionAdmin.ts:872 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 193 | POST | /api/admin/client-contacts-audit-retention/prune-now | server/routes/auditRetentionAdmin.ts:895 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 194 | GET | /api/admin/audit-retention/stats | server/routes/auditRetentionAdmin.ts:910 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 195 | GET | /api/admin/audit-retention/audit/:id | server/routes/auditRetentionAdmin.ts:929 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 196 | GET | /api/admin/backups | server/routes/backups.ts:44 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 197 | POST | /api/admin/backups/run | server/routes/backups.ts:65 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 198 | GET | /api/admin/backups/:id/download/db | server/routes/backups.ts:90 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 199 | GET | /api/admin/backups/:id/download/manifest | server/routes/backups.ts:99 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 200 | GET | /api/stripe/status | server/routes/billing.ts:39 | authenticated | isAuthenticated | authenticated |
| 201 | GET | /api/clients/:clientId/billing | server/routes/billing.ts:58 | authenticated | isAuthenticated | authenticated |
| 202 | PATCH | /api/clients/:clientId/stripe-link | server/routes/billing.ts:95 | authenticated | isAuthenticated | authenticated |
| 203 | GET | /api/stripe/customers/search | server/routes/billing.ts:126 | authenticated | isAuthenticated | authenticated |
| 204 | POST | /api/stripe/webhook | server/routes/billing.ts:151 | public | none | public, webhook |
| 205 | GET | /api/health/rate-limits/blocked-events-retention | server/routes/blockedEventsRetentionAdmin.ts:32 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 206 | GET | /api/health/rate-limits/blocked-events-retention/preview | server/routes/blockedEventsRetentionAdmin.ts:51 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 207 | GET | /api/health/rate-limits/blocked-events-retention/sweeps | server/routes/blockedEventsRetentionAdmin.ts:87 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 208 | GET | /api/health/rate-limits/blocked-events-retention/history | server/routes/blockedEventsRetentionAdmin.ts:102 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 209 | POST | /api/health/rate-limits/blocked-events-retention/prune | server/routes/blockedEventsRetentionAdmin.ts:122 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 210 | PUT | /api/health/rate-limits/blocked-events-retention | server/routes/blockedEventsRetentionAdmin.ts:142 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 211 | GET | /api/health/blocked-ips/:ip/history | server/routes/blockedEventsRetentionAdmin.ts:208 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 212 | POST | /api/book/journey/start | server/routes/bookBuyerJourney.ts:275 | public | bookCheckoutLimiter | public, ai_rate_limited |
| 213 | POST | /api/book/journey/submit | server/routes/bookBuyerJourney.ts:350 | public | bookCheckoutLimiter | public, ai_rate_limited |
| 214 | POST | /api/book/journey/status | server/routes/bookBuyerJourney.ts:385 | public | bookCheckoutLimiter | public, ai_rate_limited |
| 215 | GET | /api/book/checkout/catalog | server/routes/bookCheckout.ts:351 | public | bookCheckoutLimiter | public, ai_rate_limited |
| 216 | POST | /api/book/checkout/start | server/routes/bookCheckout.ts:379 | public | bookCheckoutLimiter | public, ai_rate_limited |
| 217 | POST | /api/book/checkout/resume | server/routes/bookCheckout.ts:477 | public | bookCheckoutLimiter | public, ai_rate_limited |
| 218 | POST | /api/book/checkout/contact | server/routes/bookCheckout.ts:541 | public | bookCheckoutLimiter | public, ai_rate_limited |
| 219 | POST | /api/book/checkout/totals | server/routes/bookCheckout.ts:663 | public | bookCheckoutLimiter | public, ai_rate_limited |
| 220 | POST | /api/book/checkout/payment-intent | server/routes/bookCheckout.ts:760 | public | bookCheckoutLimiter | public, ai_rate_limited |
| 221 | POST | /api/book/delivery/exchange | server/routes/bookDelivery.ts:93 | public | bookCheckoutLimiter | public, ai_rate_limited |
| 222 | POST | /api/book/delivery/resend | server/routes/bookDelivery.ts:114 | public | bookCheckoutLimiter | public, ai_rate_limited |
| 223 | GET | /api/book/delivery/assets | server/routes/bookDelivery.ts:131 | public | bookCheckoutLimiter | public, ai_rate_limited |
| 224 | GET | /api/book/delivery/order-status | server/routes/bookDelivery.ts:144 | public | bookCheckoutLimiter | public, ai_rate_limited |
| 225 | GET | /api/book/delivery/download/:assetId | server/routes/bookDelivery.ts:157 | public | bookCheckoutLimiter | public, ai_rate_limited |
| 226 | POST | /api/admin/book-delivery/entitlements/:entitlementId/resend | server/routes/bookDelivery.ts:231 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 227 | POST | /api/admin/book-delivery/entitlements/:entitlementId/reissue | server/routes/bookDelivery.ts:247 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 228 | POST | /api/admin/book-delivery/entitlements/:entitlementId/revoke | server/routes/bookDelivery.ts:263 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 229 | GET | /api/admin/book-operations/summary | server/routes/bookOperations.ts:280 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 230 | GET | /api/admin/book-operations/records | server/routes/bookOperations.ts:296 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 231 | GET | /api/admin/book-operations/records/:recordId | server/routes/bookOperations.ts:317 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 232 | GET | /api/admin/book-operations/exceptions | server/routes/bookOperations.ts:335 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 233 | GET | /api/admin/book-operations/health | server/routes/bookOperations.ts:351 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 234 | POST | /api/admin/book-operations/payment-events/:paymentEventId/retry | server/routes/bookOperations.ts:361 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 235 | POST | /api/admin/book-operations/outbox/:outboxId/replay | server/routes/bookOperations.ts:403 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 236 | GET | /api/booking/me/page | server/routes/booking.ts:477 | authenticated | isAuthenticated | authenticated |
| 237 | PUT | /api/booking/me/page | server/routes/booking.ts:529 | authenticated | isAuthenticated, writeLimiter | authenticated, ai_rate_limited |
| 238 | GET | /api/booking/me/availability | server/routes/booking.ts:583 | authenticated | isAuthenticated | authenticated |
| 239 | PUT | /api/booking/me/availability/rules | server/routes/booking.ts:612 | authenticated | isAuthenticated, writeLimiter | authenticated, ai_rate_limited |
| 240 | POST | /api/booking/me/availability/overrides | server/routes/booking.ts:639 | authenticated | isAuthenticated, writeLimiter | authenticated, ai_rate_limited |
| 241 | DELETE | /api/booking/me/availability/overrides/:id | server/routes/booking.ts:660 | authenticated | isAuthenticated, writeLimiter | authenticated, ai_rate_limited |
| 242 | GET | /api/booking/me/meeting-types | server/routes/booking.ts:698 | authenticated | isAuthenticated | authenticated |
| 243 | POST | /api/booking/me/meeting-types | server/routes/booking.ts:717 | authenticated | isAuthenticated, writeLimiter | authenticated, ai_rate_limited |
| 244 | PUT | /api/booking/me/meeting-types/:id | server/routes/booking.ts:757 | authenticated | isAuthenticated, writeLimiter | authenticated, ai_rate_limited |
| 245 | DELETE | /api/booking/me/meeting-types/:id | server/routes/booking.ts:801 | authenticated | isAuthenticated, writeLimiter | authenticated, ai_rate_limited |
| 246 | GET | /api/booking/me/meetings | server/routes/booking.ts:847 | authenticated | isAuthenticated | authenticated |
| 247 | GET | /api/booking/me/meetings/:id | server/routes/booking.ts:935 | authenticated | isAuthenticated | authenticated |
| 248 | POST | /api/booking/me/meetings/:id/cancel | server/routes/booking.ts:989 | authenticated | isAuthenticated, writeLimiter | authenticated, ai_rate_limited |
| 249 | GET | /api/integrations/google-calendar/status | server/routes/booking.ts:1011 | authenticated | isAuthenticated | authenticated |
| 250 | GET | /api/integrations/google-calendar/authorize | server/routes/booking.ts:1032 | authenticated | isAuthenticated | authenticated |
| 251 | GET | /api/integrations/google-calendar/callback | server/routes/booking.ts:1047 | public | none | public |
| 252 | POST | /api/integrations/google-calendar/disconnect | server/routes/booking.ts:1075 | authenticated | isAuthenticated, writeLimiter | authenticated, ai_rate_limited |
| 253 | GET | /api/booking/me/calendars | server/routes/booking.ts:1090 | authenticated | isAuthenticated | authenticated |
| 254 | PUT | /api/booking/me/calendar | server/routes/booking.ts:1111 | authenticated | isAuthenticated, writeLimiter | authenticated, ai_rate_limited |
| 255 | GET | /api/booking/me/readiness | server/routes/booking.ts:1154 | authenticated | isAuthenticated | authenticated |
| 256 | GET | /api/booking/me/slots-preview | server/routes/booking.ts:1276 | authenticated | isAuthenticated | authenticated |
| 257 | GET | /api/booking/me/zoom-host | server/routes/booking.ts:1493 | authenticated | isAuthenticated | authenticated |
| 258 | GET | /api/booking/me/zoom-account-users | server/routes/booking.ts:1510 | authenticated | isAuthenticated | authenticated |
| 259 | PUT | /api/booking/me/zoom-host | server/routes/booking.ts:1556 | authenticated | isAuthenticated, writeLimiter | authenticated, ai_rate_limited |
| 260 | DELETE | /api/booking/me/zoom-host | server/routes/booking.ts:1667 | authenticated | isAuthenticated, writeLimiter | authenticated, ai_rate_limited |
| 261 | POST | /api/booking/me/client-links | server/routes/booking.ts:1702 | authenticated | isAuthenticated, writeLimiter | authenticated, ai_rate_limited |
| 262 | GET | /api/booking/clients/:clientId/slots | server/routes/booking.ts:2279 | authenticated | isAuthenticated | authenticated |
| 263 | POST | /api/booking/clients/:clientId/book | server/routes/booking.ts:2433 | authenticated | isAuthenticated, writeLimiter | authenticated, ai_rate_limited |
| 264 | GET | /api/booking/clients/:clientId/meetings | server/routes/booking.ts:2587 | authenticated | isAuthenticated | authenticated |
| 265 | GET | /api/admin/booking/health | server/routes/booking.ts:2634 | authenticated | isAuthenticated | authenticated, admin_only |
| 266 | POST | /api/admin/booking/health/recheck | server/routes/booking.ts:2742 | authenticated | isAuthenticated | authenticated, admin_only |
| 267 | POST | /api/book/:slug/recurrence/preview-availability | server/routes/booking.ts:2923 | public | none | public |
| 268 | PATCH | /api/booking/:id | server/routes/booking.ts:3015 | authenticated | isAuthenticated, writeLimiter | authenticated, ai_rate_limited |
| 269 | DELETE | /api/booking/:id | server/routes/booking.ts:3153 | public | writeLimiter | public, ai_rate_limited |
| 270 | GET | /api/campaigns | server/routes/campaigns.ts:69 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 271 | POST | /api/campaigns | server/routes/campaigns.ts:84 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 272 | GET | /api/campaigns/:id | server/routes/campaigns.ts:117 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 273 | PATCH | /api/campaigns/:id | server/routes/campaigns.ts:138 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 274 | DELETE | /api/campaigns/:id | server/routes/campaigns.ts:173 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 275 | POST | /api/campaigns/:id/links | server/routes/campaigns.ts:190 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 276 | DELETE | /api/campaigns/:id/links/:linkId | server/routes/campaigns.ts:213 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 277 | GET | /api/attribution/report | server/routes/campaigns.ts:231 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 278 | POST | /api/ceo-tools/call-analysis | server/routes/ceoTools.ts:30 | requireCeoToolsAuth | requireCeoToolsAuth | token_auth |
| 279 | GET | /api/ceo-tools/call-analysis/failure-mix | server/routes/ceoTools.ts:81 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 280 | GET | /api/ceo-tools/call-analysis/failure-mix/jobs | server/routes/ceoTools.ts:170 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 281 | GET | /api/ceo-tools/call-analysis/failure-spike-config | server/routes/ceoTools.ts:259 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 282 | POST | /api/ceo-tools/call-analysis/failure-spike-config | server/routes/ceoTools.ts:274 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 283 | POST | /api/ceo-tools/call-analysis/failure-spike-check | server/routes/ceoTools.ts:379 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 284 | GET | /api/ceo-tools/call-analysis/:analysisId | server/routes/ceoTools.ts:397 | public | none | public |
| 285 | GET | /api/ceo-tools/call-analysis | server/routes/ceoTools.ts:434 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 286 | POST | /api/ceo-tools/call-analysis/failure-mix/bulk-rerun | server/routes/ceoTools.ts:474 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 287 | POST | /api/ceo-tools/call-analysis/:analysisId/rerun | server/routes/ceoTools.ts:529 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 288 | POST | /api/ceo-tools/call-analysis/backfill-duration | server/routes/ceoTools.ts:558 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 289 | GET | /api/churn/leaderboard | server/routes/churn.ts:82 | authenticated | isAuthenticated | authenticated |
| 290 | GET | /api/churn/rejudge-progress | server/routes/churn.ts:456 | authenticated | isAuthenticated | authenticated |
| 291 | POST | /api/churn/concern-intel | server/routes/churn.ts:474 | authenticated | isAuthenticated | authenticated |
| 292 | GET | /api/churn/going-quiet | server/routes/churn.ts:524 | authenticated | isAuthenticated | authenticated |
| 293 | GET | /api/churn/stability-triage | server/routes/churn.ts:670 | authenticated | isAuthenticated | authenticated |
| 294 | GET | /api/churn/open-asks | server/routes/churn.ts:762 | authenticated | isAuthenticated | authenticated |
| 295 | GET | /api/churn/team-trends | server/routes/churn.ts:815 | authenticated | isAuthenticated | authenticated |
| 296 | POST | /api/churn/coaching/runs | server/routes/churn.ts:838 | authenticated | isAuthenticated | authenticated |
| 297 | GET | /api/churn/coaching/runs | server/routes/churn.ts:865 | authenticated | isAuthenticated | authenticated |
| 298 | GET | /api/churn/coaching/runs/:runId | server/routes/churn.ts:905 | authenticated | isAuthenticated | authenticated |
| 299 | POST | /api/churn/radar/runs | server/routes/churn.ts:978 | authenticated | isAuthenticated | authenticated |
| 300 | GET | /api/churn/radar/runs | server/routes/churn.ts:1000 | authenticated | isAuthenticated | authenticated |
| 301 | GET | /api/churn/radar/runs/:id | server/routes/churn.ts:1030 | authenticated | isAuthenticated | authenticated |
| 302 | GET | /api/churn/radar/runs/:id/results | server/routes/churn.ts:1047 | authenticated | isAuthenticated | authenticated |
| 303 | GET | /api/admin/clerk/restrictions | server/routes/clerkAdmin.ts:48 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 304 | POST | /api/admin/clerk/enable-restricted-signup | server/routes/clerkAdmin.ts:78 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 305 | GET | /api/integrations/clickup/authorize | server/routes/clickup.ts:161 | authenticated | isAuthenticated | authenticated |
| 306 | GET | /api/integrations/clickup/callback | server/routes/clickup.ts:187 | public | none | public |
| 307 | POST | /api/integrations/clickup/disconnect | server/routes/clickup.ts:221 | authenticated | isAuthenticated | authenticated |
| 308 | GET | /api/integrations/clickup/status | server/routes/clickup.ts:238 | authenticated | isAuthenticated | authenticated |
| 309 | GET | /api/integrations/clickup/connected-users | server/routes/clickup.ts:256 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 310 | GET | /api/clickup/workspaces | server/routes/clickup.ts:283 | authenticated | isAuthenticated | authenticated |
| 311 | GET | /api/clickup/workspaces/:workspaceId/hierarchy | server/routes/clickup.ts:294 | authenticated | isAuthenticated | authenticated |
| 312 | GET | /api/clickup/workspaces/:workspaceId/spaces | server/routes/clickup.ts:327 | authenticated | isAuthenticated | authenticated |
| 313 | POST | /api/clickup/workspaces/:workspaceId/spaces | server/routes/clickup.ts:342 | authenticated | isAuthenticated | authenticated |
| 314 | PUT | /api/clickup/spaces/:spaceId | server/routes/clickup.ts:385 | authenticated | isAuthenticated | authenticated |
| 315 | DELETE | /api/clickup/spaces/:spaceId | server/routes/clickup.ts:406 | authenticated | isAuthenticated | authenticated |
| 316 | GET | /api/clickup/spaces/:spaceId/folders | server/routes/clickup.ts:425 | authenticated | isAuthenticated | authenticated |
| 317 | POST | /api/clickup/spaces/:spaceId/folders | server/routes/clickup.ts:436 | authenticated | isAuthenticated | authenticated |
| 318 | PUT | /api/clickup/folders/:folderId | server/routes/clickup.ts:474 | authenticated | isAuthenticated | authenticated |
| 319 | DELETE | /api/clickup/folders/:folderId | server/routes/clickup.ts:493 | authenticated | isAuthenticated | authenticated |
| 320 | GET | /api/clickup/spaces/:spaceId/lists | server/routes/clickup.ts:511 | authenticated | isAuthenticated | authenticated |
| 321 | GET | /api/clickup/folders/:folderId/lists | server/routes/clickup.ts:522 | authenticated | isAuthenticated | authenticated |
| 322 | POST | /api/clickup/spaces/:spaceId/lists | server/routes/clickup.ts:533 | authenticated | isAuthenticated | authenticated |
| 323 | POST | /api/clickup/folders/:folderId/lists | server/routes/clickup.ts:568 | authenticated | isAuthenticated | authenticated |
| 324 | PUT | /api/clickup/lists/:listId | server/routes/clickup.ts:603 | authenticated | isAuthenticated | authenticated |
| 325 | DELETE | /api/clickup/lists/:listId | server/routes/clickup.ts:625 | authenticated | isAuthenticated | authenticated |
| 326 | GET | /api/clickup/lists/:listId/custom-fields | server/routes/clickup.ts:643 | authenticated | isAuthenticated | authenticated |
| 327 | GET | /api/clickup/lists/:listId/tasks | server/routes/clickup.ts:656 | authenticated | isAuthenticated | authenticated |
| 328 | GET | /api/clickup/tasks/:taskId | server/routes/clickup.ts:682 | authenticated | isAuthenticated | authenticated |
| 329 | POST | /api/clickup/lists/:listId/tasks | server/routes/clickup.ts:693 | authenticated | isAuthenticated | authenticated |
| 330 | PUT | /api/clickup/tasks/:taskId | server/routes/clickup.ts:704 | authenticated | isAuthenticated | authenticated |
| 331 | DELETE | /api/clickup/tasks/:taskId | server/routes/clickup.ts:715 | authenticated | isAuthenticated | authenticated |
| 332 | POST | /api/clickup/tasks/:taskId/fields/:fieldId | server/routes/clickup.ts:726 | authenticated | isAuthenticated | authenticated |
| 333 | DELETE | /api/clickup/tasks/:taskId/fields/:fieldId | server/routes/clickup.ts:745 | authenticated | isAuthenticated | authenticated |
| 334 | GET | /api/clickup/workspaces/:workspaceId/custom-item-types | server/routes/clickup.ts:764 | authenticated | isAuthenticated | authenticated |
| 335 | GET | /api/clickup/folders/:folderId/custom-fields | server/routes/clickup.ts:783 | authenticated | isAuthenticated | authenticated |
| 336 | GET | /api/clickup/spaces/:spaceId/custom-fields | server/routes/clickup.ts:802 | authenticated | isAuthenticated | authenticated |
| 337 | GET | /api/clickup/workspaces/:workspaceId/custom-fields | server/routes/clickup.ts:821 | authenticated | isAuthenticated | authenticated |
| 338 | POST | /api/clickup/tasks/:taskId/checklists | server/routes/clickup.ts:838 | authenticated | isAuthenticated | authenticated |
| 339 | POST | /api/clickup/checklists/:checklistId/items | server/routes/clickup.ts:849 | authenticated | isAuthenticated | authenticated |
| 340 | PUT | /api/clickup/checklists/:checklistId/items/:itemId | server/routes/clickup.ts:864 | authenticated | isAuthenticated | authenticated |
| 341 | DELETE | /api/clickup/checklists/:checklistId | server/routes/clickup.ts:884 | authenticated | isAuthenticated | authenticated |
| 342 | GET | /api/clickup/tasks/:taskId/comments | server/routes/clickup.ts:917 | authenticated | isAuthenticated | authenticated |
| 343 | POST | /api/clickup/tasks/:taskId/comments | server/routes/clickup.ts:930 | authenticated | isAuthenticated | authenticated |
| 344 | GET | /api/clickup/comments/:commentId/replies | server/routes/clickup.ts:941 | authenticated | isAuthenticated | authenticated |
| 345 | POST | /api/clickup/comments/:commentId/replies | server/routes/clickup.ts:952 | authenticated | isAuthenticated | authenticated |
| 346 | PUT | /api/clickup/comments/:commentId | server/routes/clickup.ts:963 | authenticated | isAuthenticated | authenticated |
| 347 | DELETE | /api/clickup/comments/:commentId | server/routes/clickup.ts:974 | authenticated | isAuthenticated | authenticated |
| 348 | GET | /api/clickup/lists/:listId/comments | server/routes/clickup.ts:985 | authenticated | isAuthenticated | authenticated |
| 349 | POST | /api/clickup/lists/:listId/comments | server/routes/clickup.ts:998 | authenticated | isAuthenticated | authenticated |
| 350 | GET | /api/clickup/tasks/:taskId/attachments | server/routes/clickup.ts:1018 | authenticated | isAuthenticated | authenticated |
| 351 | POST | /api/clickup/tasks/:taskId/attachments | server/routes/clickup.ts:1033 | authenticated | isAuthenticated, upload.single | authenticated, upload |
| 352 | GET | /api/clickup/attachments/proxy | server/routes/clickup.ts:1061 | authenticated | isAuthenticated | authenticated |
| 353 | POST | /api/clickup/entity/:entityId/attachments | server/routes/clickup.ts:1106 | authenticated | isAuthenticated, upload.single | authenticated, upload |
| 354 | DELETE | /api/clickup/tasks/:taskId/attachments/:attachmentId | server/routes/clickup.ts:1133 | authenticated | isAuthenticated | authenticated |
| 355 | GET | /api/clickup/workspaces/:workspaceId/time-entries | server/routes/clickup.ts:1173 | authenticated | isAuthenticated | authenticated |
| 356 | POST | /api/clickup/workspaces/:workspaceId/time-entries | server/routes/clickup.ts:1201 | authenticated | isAuthenticated | authenticated |
| 357 | PUT | /api/clickup/workspaces/:workspaceId/time-entries/:entryId | server/routes/clickup.ts:1216 | authenticated | isAuthenticated | authenticated |
| 358 | DELETE | /api/clickup/workspaces/:workspaceId/time-entries/:entryId | server/routes/clickup.ts:1236 | authenticated | isAuthenticated | authenticated |
| 359 | POST | /api/clickup/workspaces/:workspaceId/timer/start | server/routes/clickup.ts:1251 | authenticated | isAuthenticated | authenticated |
| 360 | POST | /api/clickup/workspaces/:workspaceId/timer/stop | server/routes/clickup.ts:1271 | authenticated | isAuthenticated | authenticated |
| 361 | GET | /api/clickup/workspaces/:workspaceId/timer/current | server/routes/clickup.ts:1286 | authenticated | isAuthenticated | authenticated |
| 362 | GET | /api/clickup/workspaces/:workspaceId/time-entries/:entryId/history | server/routes/clickup.ts:1303 | authenticated | isAuthenticated | authenticated |
| 363 | GET | /api/clickup/workspaces/:workspaceId/time-entry-tags | server/routes/clickup.ts:1325 | authenticated | isAuthenticated | authenticated |
| 364 | POST | /api/clickup/workspaces/:workspaceId/time-entries/:entryId/tags | server/routes/clickup.ts:1341 | authenticated | isAuthenticated | authenticated |
| 365 | DELETE | /api/clickup/workspaces/:workspaceId/time-entries/:entryId/tags | server/routes/clickup.ts:1360 | authenticated | isAuthenticated | authenticated |
| 366 | PUT | /api/clickup/workspaces/:workspaceId/time-entry-tags/rename | server/routes/clickup.ts:1378 | authenticated | isAuthenticated | authenticated |
| 367 | PUT | /api/clickup/tasks/:taskId/time-estimates/user/:userId | server/routes/clickup.ts:1404 | authenticated | isAuthenticated | authenticated |
| 368 | GET | /api/clickup/tasks/:taskId/time-in-status | server/routes/clickup.ts:1430 | authenticated | isAuthenticated | authenticated |
| 369 | GET | /api/clickup/workspaces/:workspaceId/tasks/time-in-status | server/routes/clickup.ts:1451 | authenticated | isAuthenticated | authenticated |
| 370 | GET | /api/clickup/workspaces/:workspaceId/goals | server/routes/clickup.ts:1471 | authenticated | isAuthenticated | authenticated |
| 371 | GET | /api/clickup/goals/:goalId | server/routes/clickup.ts:1482 | authenticated | isAuthenticated | authenticated |
| 372 | POST | /api/clickup/workspaces/:workspaceId/goals | server/routes/clickup.ts:1493 | authenticated | isAuthenticated | authenticated |
| 373 | PUT | /api/clickup/goals/:goalId | server/routes/clickup.ts:1543 | authenticated | isAuthenticated | authenticated |
| 374 | DELETE | /api/clickup/goals/:goalId | server/routes/clickup.ts:1566 | authenticated | isAuthenticated | authenticated |
| 375 | POST | /api/clickup/goals/:goalId/key-results | server/routes/clickup.ts:1582 | authenticated | isAuthenticated | authenticated |
| 376 | PUT | /api/clickup/goals/:goalId/key-results/:krId | server/routes/clickup.ts:1623 | authenticated | isAuthenticated | authenticated |
| 377 | DELETE | /api/clickup/goals/:goalId/key-results/:krId | server/routes/clickup.ts:1656 | authenticated | isAuthenticated | authenticated |
| 378 | GET | /api/clickup/workspaces/:workspaceId/docs | server/routes/clickup.ts:1689 | authenticated | isAuthenticated | authenticated |
| 379 | POST | /api/clickup/workspaces/:workspaceId/docs | server/routes/clickup.ts:1702 | authenticated | isAuthenticated | authenticated |
| 380 | GET | /api/clickup/workspaces/:workspaceId/docs/:docId | server/routes/clickup.ts:1721 | authenticated | isAuthenticated | authenticated |
| 381 | GET | /api/clickup/workspaces/:workspaceId/docs/:docId/page-listing | server/routes/clickup.ts:1737 | authenticated | isAuthenticated | authenticated |
| 382 | GET | /api/clickup/workspaces/:workspaceId/docs/:docId/pages | server/routes/clickup.ts:1756 | authenticated | isAuthenticated | authenticated |
| 383 | POST | /api/clickup/workspaces/:workspaceId/docs/:docId/pages | server/routes/clickup.ts:1772 | authenticated | isAuthenticated | authenticated |
| 384 | GET | /api/clickup/workspaces/:workspaceId/docs/:docId/pages/:pageId | server/routes/clickup.ts:1794 | authenticated | isAuthenticated | authenticated |
| 385 | PUT | /api/clickup/workspaces/:workspaceId/docs/:docId/pages/:pageId | server/routes/clickup.ts:1814 | authenticated | isAuthenticated | authenticated |
| 386 | GET | /api/clickup/spaces/:spaceId/tags | server/routes/clickup.ts:1838 | authenticated | isAuthenticated | authenticated |
| 387 | POST | /api/clickup/spaces/:spaceId/tags | server/routes/clickup.ts:1849 | authenticated | isAuthenticated | authenticated |
| 388 | PUT | /api/clickup/spaces/:spaceId/tags/:tagName | server/routes/clickup.ts:1868 | authenticated | isAuthenticated | authenticated |
| 389 | DELETE | /api/clickup/spaces/:spaceId/tags/:tagName | server/routes/clickup.ts:1888 | authenticated | isAuthenticated | authenticated |
| 390 | POST | /api/clickup/tasks/:taskId/tags/:tagName | server/routes/clickup.ts:1905 | authenticated | isAuthenticated | authenticated |
| 391 | DELETE | /api/clickup/tasks/:taskId/tags/:tagName | server/routes/clickup.ts:1939 | authenticated | isAuthenticated | authenticated |
| 392 | GET | /api/clickup/workspaces/:workspaceId/webhooks | server/routes/clickup.ts:1973 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated, webhook |
| 393 | POST | /api/clickup/workspaces/:workspaceId/webhooks | server/routes/clickup.ts:1989 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated, webhook |
| 394 | DELETE | /api/clickup/webhooks/:webhookId | server/routes/clickup.ts:2025 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated, webhook |
| 395 | POST | /api/webhooks/clickup | server/routes/clickup.ts:2047 | public | none | public, webhook |
| 396 | GET | /api/clickup/workspaces/:workspaceId/facets | server/routes/clickup.ts:2099 | authenticated | isAuthenticated | authenticated |
| 397 | GET | /api/clickup/workspaces/:workspaceId/search | server/routes/clickup.ts:2190 | authenticated | isAuthenticated | authenticated |
| 398 | GET | /api/clickup/tasks/:taskId/full | server/routes/clickup.ts:2237 | authenticated | isAuthenticated | authenticated |
| 399 | GET | /api/clickup/filter-presets | server/routes/clickup.ts:2250 | authenticated | isAuthenticated | authenticated |
| 400 | POST | /api/clickup/tasks/:taskId/dependencies | server/routes/clickup.ts:2272 | authenticated | isAuthenticated | authenticated |
| 401 | POST | /api/clickup/filter-presets | server/routes/clickup.ts:2287 | authenticated | isAuthenticated | authenticated |
| 402 | DELETE | /api/clickup/filter-presets/:presetId | server/routes/clickup.ts:2308 | authenticated | isAuthenticated | authenticated |
| 403 | DELETE | /api/clickup/tasks/:taskId/dependencies | server/routes/clickup.ts:2329 | authenticated | isAuthenticated | authenticated |
| 404 | POST | /api/clickup/tasks/:taskId/links/:linksTo | server/routes/clickup.ts:2346 | authenticated | isAuthenticated | authenticated |
| 405 | DELETE | /api/clickup/tasks/:taskId/links/:linksTo | server/routes/clickup.ts:2361 | authenticated | isAuthenticated | authenticated |
| 406 | POST | /api/clickup/tasks/:taskId/merge | server/routes/clickup.ts:2377 | authenticated | isAuthenticated | authenticated |
| 407 | POST | /api/clickup/tasks/:taskId/watchers | server/routes/clickup.ts:2393 | authenticated | isAuthenticated | authenticated |
| 408 | DELETE | /api/clickup/tasks/:taskId/watchers/:userId | server/routes/clickup.ts:2407 | authenticated | isAuthenticated | authenticated |
| 409 | POST | /api/clickup/tasks/:taskId/move | server/routes/clickup.ts:2431 | authenticated | isAuthenticated | authenticated |
| 410 | POST | /api/clickup/tasks/:taskId/lists/:listId | server/routes/clickup.ts:2460 | authenticated | isAuthenticated | authenticated |
| 411 | DELETE | /api/clickup/tasks/:taskId/lists/:listId | server/routes/clickup.ts:2483 | authenticated | isAuthenticated | authenticated |
| 412 | GET | /api/clickup/workspaces/:workspaceId/views | server/routes/clickup.ts:2529 | authenticated | isAuthenticated | authenticated |
| 413 | POST | /api/clickup/workspaces/:workspaceId/views | server/routes/clickup.ts:2544 | authenticated | isAuthenticated | authenticated |
| 414 | GET | /api/clickup/spaces/:spaceId/views | server/routes/clickup.ts:2561 | authenticated | isAuthenticated | authenticated |
| 415 | POST | /api/clickup/spaces/:spaceId/views | server/routes/clickup.ts:2576 | authenticated | isAuthenticated | authenticated |
| 416 | GET | /api/clickup/folders/:folderId/views | server/routes/clickup.ts:2593 | authenticated | isAuthenticated | authenticated |
| 417 | POST | /api/clickup/folders/:folderId/views | server/routes/clickup.ts:2608 | authenticated | isAuthenticated | authenticated |
| 418 | GET | /api/clickup/lists/:listId/views | server/routes/clickup.ts:2625 | authenticated | isAuthenticated | authenticated |
| 419 | POST | /api/clickup/lists/:listId/views | server/routes/clickup.ts:2640 | authenticated | isAuthenticated | authenticated |
| 420 | GET | /api/clickup/views/:viewId | server/routes/clickup.ts:2657 | authenticated | isAuthenticated | authenticated |
| 421 | PUT | /api/clickup/views/:viewId | server/routes/clickup.ts:2668 | authenticated | isAuthenticated | authenticated |
| 422 | DELETE | /api/clickup/views/:viewId | server/routes/clickup.ts:2679 | authenticated | isAuthenticated | authenticated |
| 423 | GET | /api/clickup/views/:viewId/tasks | server/routes/clickup.ts:2690 | authenticated | isAuthenticated | authenticated |
| 424 | GET | /api/clickup/workspaces/:workspaceId/task-templates | server/routes/clickup.ts:2713 | authenticated | isAuthenticated | authenticated |
| 425 | GET | /api/clickup/workspaces/:workspaceId/list-templates | server/routes/clickup.ts:2728 | authenticated | isAuthenticated | authenticated |
| 426 | GET | /api/clickup/workspaces/:workspaceId/folder-templates | server/routes/clickup.ts:2743 | authenticated | isAuthenticated | authenticated |
| 427 | POST | /api/clickup/lists/:listId/tasks-from-template | server/routes/clickup.ts:2763 | authenticated | isAuthenticated | authenticated |
| 428 | POST | /api/clickup/folders/:folderId/lists-from-template | server/routes/clickup.ts:2799 | authenticated | isAuthenticated | authenticated |
| 429 | POST | /api/clickup/spaces/:spaceId/lists-from-template | server/routes/clickup.ts:2840 | authenticated | isAuthenticated | authenticated |
| 430 | POST | /api/clickup/spaces/:spaceId/folders-from-template | server/routes/clickup.ts:2881 | authenticated | isAuthenticated | authenticated |
| 431 | GET | /api/clickup/tasks/:taskId/members | server/routes/clickup.ts:2922 | authenticated | isAuthenticated | authenticated |
| 432 | GET | /api/clickup/lists/:listId/members | server/routes/clickup.ts:2938 | authenticated | isAuthenticated | authenticated |
| 433 | GET | /api/clickup/workspaces/:workspaceId/custom-roles | server/routes/clickup.ts:2956 | authenticated | isAuthenticated | authenticated |
| 434 | GET | /api/clickup/workspaces/:workspaceId/shared | server/routes/clickup.ts:2973 | authenticated | isAuthenticated | authenticated |
| 435 | GET | /api/clickup/workspaces/:workspaceId/groups | server/routes/clickup.ts:2990 | authenticated | isAuthenticated | authenticated |
| 436 | POST | /api/clickup/workspaces/:workspaceId/groups | server/routes/clickup.ts:3005 | authenticated | isAuthenticated | authenticated |
| 437 | PUT | /api/clickup/groups/:groupId | server/routes/clickup.ts:3030 | authenticated | isAuthenticated | authenticated |
| 438 | DELETE | /api/clickup/groups/:groupId | server/routes/clickup.ts:3049 | authenticated | isAuthenticated | authenticated |
| 439 | POST | /api/clickup/workspaces/:workspaceId/acl | server/routes/clickup.ts:3065 | authenticated | isAuthenticated | authenticated |
| 440 | GET | /api/clickup/workspaces/:workspaceId/seats | server/routes/clickup.ts:3085 | authenticated | isAuthenticated | authenticated |
| 441 | GET | /api/clickup/workspaces/:workspaceId/plan | server/routes/clickup.ts:3100 | authenticated | isAuthenticated | authenticated |
| 442 | GET | /api/clickup/workspaces/:workspaceId/chat/subtypes | server/routes/clickup.ts:3145 | authenticated | isAuthenticated | authenticated |
| 443 | GET | /api/clickup/workspaces/:workspaceId/chat/channels | server/routes/clickup.ts:3161 | authenticated | isAuthenticated | authenticated |
| 444 | POST | /api/clickup/workspaces/:workspaceId/chat/channels | server/routes/clickup.ts:3177 | authenticated | isAuthenticated | authenticated |
| 445 | POST | /api/clickup/workspaces/:workspaceId/chat/channels/location | server/routes/clickup.ts:3199 | authenticated | isAuthenticated | authenticated |
| 446 | POST | /api/clickup/workspaces/:workspaceId/chat/channels/dm | server/routes/clickup.ts:3223 | authenticated | isAuthenticated | authenticated |
| 447 | GET | /api/clickup/workspaces/:workspaceId/chat/channels/:channelId | server/routes/clickup.ts:3246 | authenticated | isAuthenticated | authenticated |
| 448 | PATCH | /api/clickup/workspaces/:workspaceId/chat/channels/:channelId | server/routes/clickup.ts:3262 | authenticated | isAuthenticated | authenticated |
| 449 | DELETE | /api/clickup/workspaces/:workspaceId/chat/channels/:channelId | server/routes/clickup.ts:3283 | authenticated | isAuthenticated | authenticated |
| 450 | GET | /api/clickup/workspaces/:workspaceId/chat/channels/:channelId/members | server/routes/clickup.ts:3299 | authenticated | isAuthenticated | authenticated |
| 451 | GET | /api/clickup/workspaces/:workspaceId/chat/channels/:channelId/messages | server/routes/clickup.ts:3315 | authenticated | isAuthenticated | authenticated |
| 452 | POST | /api/clickup/workspaces/:workspaceId/chat/channels/:channelId/messages | server/routes/clickup.ts:3338 | authenticated | isAuthenticated | authenticated |
| 453 | PATCH | /api/clickup/workspaces/:workspaceId/chat/channels/:channelId/messages/:messageId | server/routes/clickup.ts:3361 | authenticated | isAuthenticated | authenticated |
| 454 | DELETE | /api/clickup/workspaces/:workspaceId/chat/channels/:channelId/messages/:messageId | server/routes/clickup.ts:3385 | authenticated | isAuthenticated | authenticated |
| 455 | GET | /api/clickup/workspaces/:workspaceId/chat/channels/:channelId/messages/:messageId/replies | server/routes/clickup.ts:3406 | authenticated | isAuthenticated | authenticated |
| 456 | POST | /api/clickup/workspaces/:workspaceId/chat/channels/:channelId/messages/:messageId/replies | server/routes/clickup.ts:3429 | authenticated | isAuthenticated | authenticated |
| 457 | POST | /api/clickup/workspaces/:workspaceId/chat/channels/:channelId/messages/:messageId/reactions | server/routes/clickup.ts:3453 | authenticated | isAuthenticated | authenticated |
| 458 | DELETE | /api/clickup/workspaces/:workspaceId/chat/channels/:channelId/messages/:messageId/reactions | server/routes/clickup.ts:3477 | authenticated | isAuthenticated | authenticated |
| 459 | POST | /api/clickup/workspaces/:workspaceId/sync | server/routes/clickup.ts:3503 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 460 | GET | /api/integrations/clickup/company-token/status | server/routes/clickupCompanyToken.ts:95 | authenticated | isAuthenticated | authenticated |
| 461 | POST | /api/integrations/clickup/company-token/test | server/routes/clickupCompanyToken.ts:136 | authenticated | isAuthenticated | authenticated |
| 462 | POST | /api/integrations/clickup/company-token | server/routes/clickupCompanyToken.ts:165 | authenticated | isAuthenticated | authenticated |
| 463 | DELETE | /api/integrations/clickup/company-token | server/routes/clickupCompanyToken.ts:198 | authenticated | isAuthenticated | authenticated |
| 464 | GET | /share/file/:token | server/routes/clientFiles.ts:1057 | public | none | public |
| 465 | GET | /api/files | server/routes/clientFiles.ts:1133 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 466 | GET | /api/files/recent | server/routes/clientFiles.ts:1148 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 467 | GET | /api/files/usage | server/routes/clientFiles.ts:1177 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 468 | GET | /api/clients | server/routes/clients.ts:55 | authenticated | isAuthenticated | authenticated |
| 469 | GET | /api/clients/export.csv | server/routes/clients.ts:123 | authenticated | isAuthenticated | authenticated |
| 470 | GET | /api/dashboard/client-summaries | server/routes/clients.ts:129 | authenticated | isAuthenticated | authenticated |
| 471 | GET | /api/clients/:id | server/routes/clients.ts:338 | authenticated | isAuthenticated | authenticated |
| 472 | GET | /api/clients/:id/summary | server/routes/clients.ts:374 | authenticated | isAuthenticated | authenticated |
| 473 | GET | /api/clients/:id/reports | server/routes/clients.ts:406 | authenticated | isAuthenticated | authenticated |
| 474 | POST | /api/clients | server/routes/clients.ts:430 | authenticated | isAuthenticated | authenticated |
| 475 | PATCH | /api/clients/:id | server/routes/clients.ts:573 | authenticated | isAuthenticated | authenticated |
| 476 | POST | /api/clients/:id/offboarding | server/routes/clients.ts:821 | authenticated | isAuthenticated | authenticated |
| 477 | DELETE | /api/clients/:id/offboarding | server/routes/clients.ts:895 | authenticated | isAuthenticated | authenticated |
| 478 | DELETE | /api/clients/:id | server/routes/clients.ts:949 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 479 | GET | /api/clients/:clientId/locations | server/routes/clients.ts:1024 | authenticated | isAuthenticated | authenticated |
| 480 | POST | /api/clients/:clientId/locations | server/routes/clients.ts:1048 | authenticated | isAuthenticated | authenticated |
| 481 | PATCH | /api/clients/:clientId/locations/:locationId | server/routes/clients.ts:1115 | authenticated | isAuthenticated | authenticated |
| 482 | DELETE | /api/clients/:clientId/locations/:locationId | server/routes/clients.ts:1201 | authenticated | isAuthenticated | authenticated |
| 483 | GET | /api/clients/:clientId/data-access | server/routes/clients.ts:1232 | authenticated | isAuthenticated | authenticated |
| 484 | GET | /api/clients/:clientId/data-access/detection | server/routes/clients.ts:1258 | authenticated | isAuthenticated | authenticated |
| 485 | GET | /api/all-data-access | server/routes/clients.ts:1281 | authenticated | isAuthenticated | authenticated |
| 486 | GET | /api/admin/locations/ungeocoded | server/routes/clients.ts:1305 | authenticated | isAuthenticated | authenticated, admin_only |
| 487 | POST | /api/admin/locations/backfill-geocode | server/routes/clients.ts:1366 | authenticated | isAuthenticated | authenticated, admin_only |
| 488 | PUT | /api/clients/:clientId/data-access/:category | server/routes/clients.ts:1447 | authenticated | isAuthenticated | authenticated |
| 489 | GET | /api/admin/clients/invalid-products | server/routes/clients.ts:1479 | authenticated | isAuthenticated | authenticated, admin_only |
| 490 | POST | /api/admin/migrate-product-types | server/routes/clients.ts:1529 | authenticated | isAuthenticated | authenticated, admin_only |
| 491 | GET | /api/clients/:clientId/command-panel | server/routes/commandCenter.ts:202 | authenticated | isAuthenticated | authenticated |
| 492 | PUT | /api/clients/:clientId/command-panel | server/routes/commandCenter.ts:222 | authenticated | isAuthenticated | authenticated |
| 493 | POST | /api/clients/:clientId/command-panel/review | server/routes/commandCenter.ts:358 | authenticated | isAuthenticated | authenticated |
| 494 | GET | /api/clients/:clientId/command-panel/history | server/routes/commandCenter.ts:370 | authenticated | isAuthenticated | authenticated |
| 495 | GET | /api/clients/:clientId/command-panel/key-calls | server/routes/commandCenter.ts:411 | authenticated | isAuthenticated | authenticated |
| 496 | POST | /api/clients/:clientId/command-panel/key-calls | server/routes/commandCenter.ts:443 | authenticated | isAuthenticated | authenticated |
| 497 | DELETE | /api/clients/:clientId/command-panel/key-calls/:callType | server/routes/commandCenter.ts:485 | authenticated | isAuthenticated | authenticated |
| 498 | GET | /api/clients/:clientId/command-panel/rer-recordings | server/routes/commandCenter.ts:498 | authenticated | isAuthenticated | authenticated |
| 499 | POST | /api/clients/:clientId/command-panel/rer-recordings | server/routes/commandCenter.ts:528 | authenticated | isAuthenticated | authenticated |
| 500 | DELETE | /api/clients/:clientId/command-panel/rer-recordings/:id | server/routes/commandCenter.ts:565 | authenticated | isAuthenticated | authenticated |
| 501 | GET | /api/clients/:clientId/command-panel/unmatched-zoom | server/routes/commandCenter.ts:579 | authenticated | isAuthenticated | authenticated |
| 502 | POST | /api/ats/candidates/:id/final-decision/approve | server/routes/commandCenter.ts:671 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 503 | GET | /api/command-panel-summaries | server/routes/commandCenter.ts:696 | authenticated | isAuthenticated | authenticated |
| 504 | GET | /api/clients/:clientId/command-panel/versions | server/routes/commandCenter.ts:737 | requireCommandCenterAccess | isAuthenticated, requireCommandCenterAccess | authenticated |
| 505 | GET | /api/clients/:clientId/intelligence-feed | server/routes/commandCenter.ts:749 | requireCommandCenterAccess | isAuthenticated, requireCommandCenterAccess | authenticated |
| 506 | POST | /api/clients/:clientId/intelligence-feed | server/routes/commandCenter.ts:768 | requireCommandCenterAccess | isAuthenticated, requireCommandCenterAccess | authenticated |
| 507 | PATCH | /api/clients/:clientId/intelligence-feed/:id | server/routes/commandCenter.ts:806 | requireCommandCenterAccess | isAuthenticated, requireCommandCenterAccess | authenticated |
| 508 | PATCH | /api/clients/:clientId/intelligence-feed/:id/pin | server/routes/commandCenter.ts:824 | requireCommandCenterAccess | isAuthenticated, requireCommandCenterAccess | authenticated |
| 509 | PATCH | /api/clients/:clientId/intelligence-feed/:id/archive | server/routes/commandCenter.ts:839 | requireCommandCenterAccess | isAuthenticated, requireCommandCenterAccess | authenticated |
| 510 | GET | /api/dashboard/wins | server/routes/commandCenter.ts:859 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 511 | GET | /api/clients/:clientId/action-log | server/routes/commandCenter.ts:873 | requireCommandCenterAccess | isAuthenticated, requireCommandCenterAccess | authenticated |
| 512 | POST | /api/clients/:clientId/action-log | server/routes/commandCenter.ts:891 | requireCommandCenterAccess | isAuthenticated, requireCommandCenterAccess | authenticated |
| 513 | PATCH | /api/clients/:clientId/action-log/:id | server/routes/commandCenter.ts:913 | requireCommandCenterAccess | isAuthenticated, requireCommandCenterAccess | authenticated |
| 514 | GET | /api/comms/channels/:id/bookmarks | server/routes/comms/bookmarks.ts:63 | authenticated | isAuthenticated | authenticated |
| 515 | POST | /api/comms/channels/:id/bookmarks | server/routes/comms/bookmarks.ts:78 | authenticated | isAuthenticated, commsWriteLimiter | authenticated, ai_rate_limited |
| 516 | PATCH | /api/comms/channels/:id/bookmarks/:bId | server/routes/comms/bookmarks.ts:132 | authenticated | isAuthenticated, commsWriteLimiter | authenticated, ai_rate_limited |
| 517 | DELETE | /api/comms/channels/:id/bookmarks/:bId | server/routes/comms/bookmarks.ts:163 | authenticated | isAuthenticated, commsWriteLimiter | authenticated, ai_rate_limited |
| 518 | PUT | /api/comms/channels/:id/bookmarks/reorder | server/routes/comms/bookmarks.ts:201 | authenticated | isAuthenticated, commsWriteLimiter | authenticated, ai_rate_limited |
| 519 | POST | /api/comms/incoming/:token | server/routes/comms/bookmarks.ts:233 | public | none | public |
| 520 | POST | /api/comms/calls/token | server/routes/comms/calls.ts:22 | authenticated | isAuthenticated | authenticated |
| 521 | POST | /api/comms/channels/:id/calls | server/routes/comms/calls.ts:52 | authenticated | isAuthenticated | authenticated |
| 522 | PATCH | /api/comms/calls/:id | server/routes/comms/calls.ts:183 | authenticated | isAuthenticated | authenticated |
| 523 | GET | /api/comms/calls/:id/recording | server/routes/comms/calls.ts:219 | authenticated | isAuthenticated | authenticated |
| 524 | POST | /api/comms/webhook/livekit | server/routes/comms/calls.ts:269 | public | none | public, webhook |
| 525 | GET | /api/comms/channels | server/routes/comms/channels.ts:23 | authenticated | isAuthenticated | authenticated |
| 526 | GET | /api/comms/channels/public | server/routes/comms/channels.ts:104 | authenticated | isAuthenticated | authenticated |
| 527 | GET | /api/comms/default-channels | server/routes/comms/channels.ts:119 | authenticated | isAuthenticated | authenticated |
| 528 | PUT | /api/comms/default-channels | server/routes/comms/channels.ts:146 | authenticated | isAuthenticated, commsWriteLimiter | authenticated, ai_rate_limited |
| 529 | POST | /api/comms/default-channels/apply-existing | server/routes/comms/channels.ts:179 | authenticated | isAuthenticated, commsWriteLimiter | authenticated, ai_rate_limited |
| 530 | GET | /api/comms/default-channels/apply-runs | server/routes/comms/channels.ts:205 | authenticated | isAuthenticated | authenticated |
| 531 | POST | /api/comms/channels | server/routes/comms/channels.ts:249 | authenticated | isAuthenticated | authenticated |
| 532 | GET | /api/comms/channels/archived | server/routes/comms/channels.ts:280 | authenticated | isAuthenticated | authenticated |
| 533 | GET | /api/comms/channels/:id | server/routes/comms/channels.ts:291 | authenticated | isAuthenticated | authenticated |
| 534 | PATCH | /api/comms/channels/:id | server/routes/comms/channels.ts:317 | authenticated | isAuthenticated | authenticated |
| 535 | DELETE | /api/comms/channels/:id | server/routes/comms/channels.ts:410 | authenticated | isAuthenticated | authenticated |
| 536 | GET | /api/comms/channels/:id/stats | server/routes/comms/channels.ts:453 | authenticated | isAuthenticated | authenticated |
| 537 | POST | /api/comms/channels/:id/unarchive | server/routes/comms/channels.ts:470 | authenticated | isAuthenticated | authenticated |
| 538 | PATCH | /api/comms/channels/:id/privacy | server/routes/comms/channels.ts:544 | authenticated | isAuthenticated | authenticated |
| 539 | POST | /api/comms/channels/:id/join | server/routes/comms/channels.ts:597 | authenticated | isAuthenticated | authenticated |
| 540 | POST | /api/comms/channels/:id/leave | server/routes/comms/channels.ts:613 | authenticated | isAuthenticated | authenticated |
| 541 | GET | /api/comms/channels/:id/members | server/routes/comms/channels.ts:629 | authenticated | isAuthenticated | authenticated |
| 542 | POST | /api/comms/channels/:id/members | server/routes/comms/channels.ts:646 | authenticated | isAuthenticated | authenticated |
| 543 | PATCH | /api/comms/channels/:id/members/:uid/role | server/routes/comms/channels.ts:696 | authenticated | isAuthenticated | authenticated |
| 544 | DELETE | /api/comms/channels/:id/members/:uid | server/routes/comms/channels.ts:750 | authenticated | isAuthenticated | authenticated |
| 545 | GET | /api/clients/:id/comms-feed | server/routes/comms/clientAndAttachments.ts:33 | authenticated | isAuthenticated | authenticated |
| 546 | POST | /api/clients/:id/comms-channel | server/routes/comms/clientAndAttachments.ts:52 | authenticated | isAuthenticated | authenticated |
| 547 | POST | /api/comms/channels/:id/messages/upload | server/routes/comms/clientAndAttachments.ts:84 | authenticated | isAuthenticated | authenticated |
| 548 | PUT | /api/comms/channels/:id/draft | server/routes/comms/draftsScheduled.ts:28 | authenticated | isAuthenticated, commsWriteLimiter | authenticated, ai_rate_limited |
| 549 | GET | /api/comms/channels/:id/draft | server/routes/comms/draftsScheduled.ts:64 | authenticated | isAuthenticated | authenticated |
| 550 | DELETE | /api/comms/channels/:id/draft | server/routes/comms/draftsScheduled.ts:78 | authenticated | isAuthenticated | authenticated |
| 551 | GET | /api/comms/drafts | server/routes/comms/draftsScheduled.ts:99 | authenticated | isAuthenticated | authenticated |
| 552 | POST | /api/comms/channels/:id/draft/attachments | server/routes/comms/draftsScheduled.ts:114 | authenticated | isAuthenticated | authenticated |
| 553 | POST | /api/comms/channels/:id/scheduled-messages | server/routes/comms/draftsScheduled.ts:178 | authenticated | isAuthenticated, commsWriteLimiter | authenticated, ai_rate_limited |
| 554 | GET | /api/comms/channels/:id/scheduled-messages | server/routes/comms/draftsScheduled.ts:213 | authenticated | isAuthenticated | authenticated |
| 555 | GET | /api/comms/scheduled-messages | server/routes/comms/draftsScheduled.ts:226 | authenticated | isAuthenticated | authenticated |
| 556 | PATCH | /api/comms/scheduled-messages/:id | server/routes/comms/draftsScheduled.ts:238 | authenticated | isAuthenticated, commsWriteLimiter | authenticated, ai_rate_limited |
| 557 | DELETE | /api/comms/scheduled-messages/:id | server/routes/comms/draftsScheduled.ts:277 | authenticated | isAuthenticated, commsWriteLimiter | authenticated, ai_rate_limited |
| 558 | POST | /api/comms/messages/:id/reminders | server/routes/comms/interactions.ts:29 | authenticated | isAuthenticated, commsWriteLimiter | authenticated, ai_rate_limited |
| 559 | GET | /api/comms/reminders | server/routes/comms/interactions.ts:57 | authenticated | isAuthenticated | authenticated |
| 560 | DELETE | /api/comms/reminders/:id | server/routes/comms/interactions.ts:69 | authenticated | isAuthenticated, commsWriteLimiter | authenticated, ai_rate_limited |
| 561 | POST | /api/comms/messages/:id/forward | server/routes/comms/interactions.ts:91 | authenticated | isAuthenticated, commsWriteLimiter | authenticated, ai_rate_limited |
| 562 | POST | /api/comms/channels/:id/typing | server/routes/comms/interactions.ts:145 | authenticated | isAuthenticated, commsWriteLimiter | authenticated, ai_rate_limited |
| 563 | POST | /api/comms/messages/:id/reactions | server/routes/comms/interactions.ts:174 | authenticated | isAuthenticated, commsWriteLimiter | authenticated, ai_rate_limited |
| 564 | DELETE | /api/comms/messages/:id/reactions/:emoji | server/routes/comms/interactions.ts:208 | authenticated | isAuthenticated, commsWriteLimiter | authenticated, ai_rate_limited |
| 565 | GET | /api/comms/channels/:id/read-state | server/routes/comms/interactions.ts:247 | authenticated | isAuthenticated | authenticated |
| 566 | POST | /api/comms/channels/:id/read-state | server/routes/comms/interactions.ts:260 | authenticated | isAuthenticated | authenticated |
| 567 | POST | /api/comms/channels/:id/mark-unread | server/routes/comms/interactions.ts:285 | authenticated | isAuthenticated | authenticated |
| 568 | POST | /api/comms/read-all | server/routes/comms/interactions.ts:310 | authenticated | isAuthenticated | authenticated |
| 569 | POST | /api/comms/dms | server/routes/comms/interactions.ts:332 | authenticated | isAuthenticated | authenticated |
| 570 | GET | /api/comms/search | server/routes/comms/interactions.ts:351 | authenticated | isAuthenticated | authenticated |
| 571 | GET | /api/comms/search/files | server/routes/comms/interactions.ts:374 | authenticated | isAuthenticated | authenticated |
| 572 | GET | /api/comms/channels/:id/messages | server/routes/comms/messages.ts:28 | authenticated | isAuthenticated | authenticated |
| 573 | GET | /api/comms/link-preview-image | server/routes/comms/messages.ts:93 | authenticated | isAuthenticated | authenticated |
| 574 | POST | /api/comms/channels/:id/messages | server/routes/comms/messages.ts:126 | authenticated | isAuthenticated, commsWriteLimiter | authenticated, ai_rate_limited |
| 575 | GET | /api/comms/threads | server/routes/comms/messages.ts:306 | authenticated | isAuthenticated | authenticated |
| 576 | GET | /api/comms/threads/unread-summary | server/routes/comms/messages.ts:326 | authenticated | isAuthenticated | authenticated |
| 577 | POST | /api/comms/threads/:rootMessageId/follow | server/routes/comms/messages.ts:338 | authenticated | isAuthenticated | authenticated |
| 578 | DELETE | /api/comms/threads/:rootMessageId/follow | server/routes/comms/messages.ts:367 | authenticated | isAuthenticated | authenticated |
| 579 | POST | /api/comms/threads/:rootMessageId/read | server/routes/comms/messages.ts:388 | authenticated | isAuthenticated | authenticated |
| 580 | POST | /api/comms/threads/:rootMessageId/unread | server/routes/comms/messages.ts:412 | authenticated | isAuthenticated | authenticated |
| 581 | GET | /api/comms/threads/:rootMessageId/membership | server/routes/comms/messages.ts:441 | authenticated | isAuthenticated | authenticated |
| 582 | PATCH | /api/comms/messages/:id | server/routes/comms/messages.ts:453 | authenticated | isAuthenticated, commsWriteLimiter | authenticated, ai_rate_limited |
| 583 | DELETE | /api/comms/messages/:id | server/routes/comms/messages.ts:489 | authenticated | isAuthenticated, commsWriteLimiter | authenticated, ai_rate_limited |
| 584 | GET | /api/comms/messages/:id/edit-history | server/routes/comms/messages.ts:546 | authenticated | isAuthenticated | authenticated |
| 585 | POST | /api/comms/messages/:id/edit-history/:historyId/restore | server/routes/comms/messages.ts:564 | authenticated | isAuthenticated, commsWriteLimiter | authenticated, ai_rate_limited |
| 586 | GET | /api/comms/permalink | server/routes/comms/messages.ts:612 | authenticated | isAuthenticated | authenticated |
| 587 | GET | /api/comms/events | server/routes/comms/realtime.ts:33 | authenticated | isAuthenticated | authenticated |
| 588 | GET | /api/comms/events/catch-up | server/routes/comms/realtime.ts:111 | authenticated | isAuthenticated | authenticated |
| 589 | GET | /api/comms/users | server/routes/comms/realtime.ts:139 | authenticated | isAuthenticated | authenticated |
| 590 | GET | /api/comms/presence | server/routes/comms/realtime.ts:149 | authenticated | isAuthenticated | authenticated |
| 591 | POST | /api/comms/presence/heartbeat | server/routes/comms/realtime.ts:158 | authenticated | isAuthenticated, commsWriteLimiter | authenticated, ai_rate_limited |
| 592 | GET | /api/comms/status/me | server/routes/comms/realtime.ts:177 | authenticated | isAuthenticated | authenticated |
| 593 | PUT | /api/comms/status/me | server/routes/comms/realtime.ts:234 | authenticated | isAuthenticated, commsWriteLimiter | authenticated, ai_rate_limited |
| 594 | PUT | /api/comms/status/me/custom | server/routes/comms/realtime.ts:289 | authenticated | isAuthenticated, commsWriteLimiter | authenticated, ai_rate_limited |
| 595 | GET | /api/comms/status/bulk | server/routes/comms/realtime.ts:342 | authenticated | isAuthenticated | authenticated |
| 596 | GET | /api/comms/sidebar/categories | server/routes/comms/sidebarPrefs.ts:25 | authenticated | isAuthenticated | authenticated |
| 597 | POST | /api/comms/sidebar/categories | server/routes/comms/sidebarPrefs.ts:39 | authenticated | isAuthenticated | authenticated |
| 598 | PATCH | /api/comms/sidebar/categories/:id | server/routes/comms/sidebarPrefs.ts:63 | authenticated | isAuthenticated | authenticated |
| 599 | DELETE | /api/comms/sidebar/categories/:id | server/routes/comms/sidebarPrefs.ts:78 | authenticated | isAuthenticated | authenticated |
| 600 | PUT | /api/comms/sidebar/categories/order | server/routes/comms/sidebarPrefs.ts:93 | authenticated | isAuthenticated | authenticated |
| 601 | POST | /api/comms/sidebar/categories/:id/channels | server/routes/comms/sidebarPrefs.ts:109 | authenticated | isAuthenticated | authenticated |
| 602 | DELETE | /api/comms/sidebar/categories/:id/channels/:channelId | server/routes/comms/sidebarPrefs.ts:126 | authenticated | isAuthenticated | authenticated |
| 603 | PUT | /api/comms/sidebar/categories/:id/channels/order | server/routes/comms/sidebarPrefs.ts:144 | authenticated | isAuthenticated | authenticated |
| 604 | POST | /api/comms/sidebar/favorites/migrate | server/routes/comms/sidebarPrefs.ts:164 | authenticated | isAuthenticated | authenticated |
| 605 | POST | /api/comms/sidebar/favorites/:channelId | server/routes/comms/sidebarPrefs.ts:179 | authenticated | isAuthenticated | authenticated |
| 606 | GET | /api/comms/attachments/* | server/routes/comms/sidebarPrefs.ts:195 | authenticated | isAuthenticated | authenticated |
| 607 | GET | /api/comms/notification-settings | server/routes/comms/sidebarPrefs.ts:258 | authenticated | isAuthenticated | authenticated |
| 608 | PUT | /api/comms/notification-settings | server/routes/comms/sidebarPrefs.ts:291 | authenticated | isAuthenticated, commsWriteLimiter | authenticated, ai_rate_limited |
| 609 | GET | /api/comms/channels/:id/notification-pref | server/routes/comms/sidebarPrefs.ts:317 | authenticated | isAuthenticated | authenticated |
| 610 | PUT | /api/comms/channels/:id/notification-pref | server/routes/comms/sidebarPrefs.ts:330 | authenticated | isAuthenticated | authenticated |
| 611 | POST | /api/comms/messages/:id/pin | server/routes/comms/sidebarPrefs.ts:351 | authenticated | isAuthenticated | authenticated |
| 612 | DELETE | /api/comms/messages/:id/pin | server/routes/comms/sidebarPrefs.ts:379 | authenticated | isAuthenticated | authenticated |
| 613 | GET | /api/comms/channels/:id/pins | server/routes/comms/sidebarPrefs.ts:407 | authenticated | isAuthenticated | authenticated |
| 614 | POST | /api/comms/messages/:id/save | server/routes/comms/sidebarPrefs.ts:424 | authenticated | isAuthenticated | authenticated |
| 615 | DELETE | /api/comms/messages/:id/save | server/routes/comms/sidebarPrefs.ts:439 | authenticated | isAuthenticated | authenticated |
| 616 | GET | /api/comms/saved | server/routes/comms/sidebarPrefs.ts:450 | authenticated | isAuthenticated | authenticated |
| 617 | POST | /api/comms/webhooks | server/routes/comms/webhooksEmoji.ts:30 | authenticated | isAuthenticated | authenticated, webhook |
| 618 | GET | /api/comms/webhooks | server/routes/comms/webhooksEmoji.ts:79 | authenticated | isAuthenticated | authenticated, webhook |
| 619 | DELETE | /api/comms/webhooks/:id | server/routes/comms/webhooksEmoji.ts:97 | authenticated | isAuthenticated | authenticated, webhook |
| 620 | POST | /api/comms/channels/:id/slash | server/routes/comms/webhooksEmoji.ts:126 | authenticated | isAuthenticated | authenticated |
| 621 | GET | /api/comms/emoji/frequently-used | server/routes/comms/webhooksEmoji.ts:292 | authenticated | isAuthenticated | authenticated |
| 622 | GET | /api/comms/emoji/autocomplete | server/routes/comms/webhooksEmoji.ts:305 | authenticated | isAuthenticated | authenticated |
| 623 | POST | /api/comms/emoji/usage | server/routes/comms/webhooksEmoji.ts:342 | authenticated | isAuthenticated | authenticated |
| 624 | GET | /api/comms/emoji | server/routes/comms/webhooksEmoji.ts:358 | authenticated | isAuthenticated | authenticated |
| 625 | POST | /api/comms/emoji | server/routes/comms/webhooksEmoji.ts:395 | authenticated | isAuthenticated | authenticated |
| 626 | GET | /api/comms/emoji/:id/image | server/routes/comms/webhooksEmoji.ts:467 | authenticated | isAuthenticated | authenticated |
| 627 | DELETE | /api/comms/emoji/:id | server/routes/comms/webhooksEmoji.ts:489 | authenticated | isAuthenticated | authenticated |
| 628 | GET | /api/clients/:clientId/communications | server/routes/communications.ts:154 | requireCommandCenterAccess | isAuthenticated, requireCommandCenterAccess | authenticated |
| 629 | POST | /api/clients/:clientId/communications | server/routes/communications.ts:173 | requireCommandCenterAccess | isAuthenticated, requireCommandCenterAccess | authenticated |
| 630 | GET | /api/clients/:clientId/communications/:commId | server/routes/communications.ts:221 | requireCommandCenterAccess | isAuthenticated, requireCommandCenterAccess | authenticated |
| 631 | DELETE | /api/clients/:clientId/communications/:commId | server/routes/communications.ts:254 | requireCommandCenterAccess | isAuthenticated, requireCommandCenterAccess | authenticated |
| 632 | POST | /api/clients/:clientId/communications/:commId/analyze | server/routes/communications.ts:268 | requireCommandCenterAccess | isAuthenticated, requireCommandCenterAccess | authenticated |
| 633 | GET | /api/clients/:clientId/suggestions | server/routes/communications.ts:301 | requireCommandCenterAccess | isAuthenticated, requireCommandCenterAccess | authenticated |
| 634 | GET | /api/clients/:clientId/suggestions/count | server/routes/communications.ts:315 | requireCommandCenterAccess | isAuthenticated, requireCommandCenterAccess | authenticated |
| 635 | PATCH | /api/clients/:clientId/suggestions/:suggestionId | server/routes/communications.ts:324 | requireCommandCenterAccess | isAuthenticated, requireCommandCenterAccess | authenticated |
| 636 | GET | /api/integrations/front/status | server/routes/communications.ts:468 | authenticated | isAuthenticated | authenticated |
| 637 | GET | /api/integrations/front/authorize | server/routes/communications.ts:489 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 638 | GET | /api/integrations/front/callback | server/routes/communications.ts:499 | public | none | public |
| 639 | GET | /api/integrations/front/inboxes | server/routes/communications.ts:544 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 640 | GET | /api/integrations/front/tags | server/routes/communications.ts:555 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 641 | GET | /api/integrations/front/search | server/routes/communications.ts:566 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 642 | GET | /api/integrations/front/sync/status | server/routes/communications.ts:579 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 643 | GET | /api/integrations/front/client-suggestions | server/routes/communications.ts:595 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 644 | GET | /api/integrations/front/unmatched | server/routes/communications.ts:612 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 645 | GET | /api/integrations/front/unmatched/count | server/routes/communications.ts:621 | authenticated | isAuthenticated | authenticated |
| 646 | POST | /api/integrations/front/unmatched/:id/assign | server/routes/communications.ts:630 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 647 | POST | /api/integrations/front/unmatched/:id/dismiss | server/routes/communications.ts:653 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 648 | POST | /api/clients/:clientId/communications/ingest-front | server/routes/communications.ts:663 | requireCommandCenterAccess | isAuthenticated, requireCommandCenterAccess | authenticated |
| 649 | GET | /api/integrations/slack/status | server/routes/communications.ts:716 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 650 | POST | /api/integrations/slack/connect | server/routes/communications.ts:747 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 651 | POST | /api/integrations/slack/disconnect | server/routes/communications.ts:799 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 652 | POST | /api/integrations/slack/sync | server/routes/communications.ts:814 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 653 | POST | /api/integrations/slack/sync-profiles | server/routes/communications.ts:827 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 654 | GET | /api/integrations/slack/sync-history | server/routes/communications.ts:838 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 655 | GET | /api/integrations/slack/recent-messages | server/routes/communications.ts:848 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 656 | GET | /api/integrations/slack/messages | server/routes/communications.ts:870 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 657 | GET | /api/integrations/front/messages | server/routes/communications.ts:978 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 658 | PATCH | /api/integrations/slack/messages/:id/reassign | server/routes/communications.ts:1228 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 659 | GET | /api/integrations/zoom/messages | server/routes/communications.ts:1272 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 660 | PATCH | /api/integrations/zoom/messages/:id/reassign | server/routes/communications.ts:1402 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 661 | GET | /api/integrations/zoom/status | server/routes/communications.ts:1426 | authenticated | isAuthenticated | authenticated |
| 662 | GET | /api/integrations/zoom/authorize | server/routes/communications.ts:1450 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 663 | GET | /api/integrations/zoom/callback | server/routes/communications.ts:1460 | public | none | public |
| 664 | POST | /api/integrations/zoom/disconnect | server/routes/communications.ts:1501 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 665 | GET | /api/integrations/zoom/auth-mode | server/routes/communications.ts:1519 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 666 | GET | /api/integrations/zoom/s2s/preflight | server/routes/communications.ts:1530 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 667 | POST | /api/integrations/zoom/auth-mode | server/routes/communications.ts:1539 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 668 | GET | /api/integrations/zoom/recordings | server/routes/communications.ts:1572 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 669 | GET | /api/integrations/zoom/discover | server/routes/communications.ts:1585 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 670 | POST | /api/integrations/zoom/reprocess | server/routes/communications.ts:1598 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 671 | POST | /api/integrations/zoom/reprocess-matched | server/routes/communications.ts:1787 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 672 | POST | /api/integrations/zoom/backfill-reeval/dry-run | server/routes/communications.ts:2044 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 673 | POST | /api/integrations/zoom/backfill-reeval/apply | server/routes/communications.ts:2058 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 674 | GET | /api/integrations/zoom/backfill-reeval/verify/:recordId | server/routes/communications.ts:2077 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 675 | GET | /api/integrations/zoom/review-queue/backfill/count | server/routes/communications.ts:2100 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 676 | POST | /api/integrations/zoom/review-queue/backfill/dry-run | server/routes/communications.ts:2126 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 677 | POST | /api/integrations/zoom/review-queue/backfill/apply | server/routes/communications.ts:2141 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 678 | GET | /api/communications/:commId/client-links | server/routes/communications.ts:2170 | requireCommandCenterAccess | isAuthenticated, requireCommandCenterAccess | authenticated |
| 679 | PATCH | /api/communications/client-links/:linkId | server/routes/communications.ts:2185 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 680 | POST | /api/clients/:clientId/communications/ingest-zoom | server/routes/communications.ts:2199 | requireCommandCenterAccess | isAuthenticated, requireCommandCenterAccess | authenticated |
| 681 | GET | /api/clients/:clientId/conversation-summary | server/routes/communications.ts:2289 | requireCommandCenterAccess | isAuthenticated, requireCommandCenterAccess | authenticated |
| 682 | POST | /api/clients/:clientId/conversation-summary/regenerate | server/routes/communications.ts:2302 | requireCommandCenterAccess | isAuthenticated, requireCommandCenterAccess | authenticated |
| 683 | GET | /api/admin/conversation-dedupe-conflicts | server/routes/conversationDedupeConflicts.ts:25 | public | none | public, admin_only |
| 684 | POST | /api/admin/conversation-dedupe-conflicts/resolve | server/routes/conversationDedupeConflicts.ts:48 | public | none | public, admin_only |
| 685 | GET | /api/deal-automation/rules | server/routes/dealAutomation.ts:109 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 686 | POST | /api/deal-automation/rules | server/routes/dealAutomation.ts:128 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 687 | PATCH | /api/deal-automation/rules/:id | server/routes/dealAutomation.ts:162 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 688 | DELETE | /api/deal-automation/rules/:id | server/routes/dealAutomation.ts:194 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 689 | GET | /api/deal-automation/runs | server/routes/dealAutomation.ts:213 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 690 | GET | /api/deal-automation/status | server/routes/dealAutomation.ts:246 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 691 | POST | /api/deal-automation/kill-switch | server/routes/dealAutomation.ts:269 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 692 | GET | /api/deal-automation/triggers/config | server/routes/dealAutomation.ts:305 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 693 | PUT | /api/deal-automation/triggers/config | server/routes/dealAutomation.ts:320 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 694 | GET | /api/deal-automation/triggers/events | server/routes/dealAutomation.ts:343 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 695 | POST | /api/deal-automation/triggers/events/:id/reprocess | server/routes/dealAutomation.ts:375 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 696 | GET | /api/deal-automation/triggers/pandadoc/unlinked | server/routes/dealAutomation.ts:399 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 697 | POST | /api/deal-automation/triggers/pandadoc/:id/link-deal | server/routes/dealAutomation.ts:417 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 698 | POST | /api/deal-automation/events/requeue | server/routes/dealAutomation.ts:452 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 699 | GET | /api/deals/pipelines | server/routes/deals.ts:89 | authenticated | isAuthenticated | authenticated |
| 700 | POST | /api/deals/pipelines/:pipelineId/stages | server/routes/deals.ts:104 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 701 | PATCH | /api/deals/stages/:id | server/routes/deals.ts:137 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 702 | GET | /api/deals | server/routes/deals.ts:162 | authenticated | isAuthenticated | authenticated |
| 703 | POST | /api/deals | server/routes/deals.ts:197 | authenticated | isAuthenticated | authenticated |
| 704 | GET | /api/deals/:id | server/routes/deals.ts:270 | authenticated | isAuthenticated | authenticated |
| 705 | PATCH | /api/deals/:id | server/routes/deals.ts:291 | authenticated | isAuthenticated | authenticated |
| 706 | POST | /api/deals/:id/move | server/routes/deals.ts:342 | authenticated | isAuthenticated | authenticated |
| 707 | DELETE | /api/deals/:id | server/routes/deals.ts:389 | authenticated | isAuthenticated | authenticated |
| 708 | GET | /api/clients/:clientId/deals | server/routes/deals.ts:414 | authenticated | isAuthenticated | authenticated |
| 709 | GET | /api/docs/documents | server/routes/docs.ts:130 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 710 | POST | /api/docs/documents | server/routes/docs.ts:175 | requireAccountManager | isAuthenticated, requireAccountManager, writeLimiter | authenticated, ai_rate_limited |
| 711 | GET | /api/docs/documents/:id | server/routes/docs.ts:222 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 712 | PATCH | /api/docs/documents/:id | server/routes/docs.ts:261 | requireAccountManager | isAuthenticated, requireAccountManager, sheetsAutosaveLimiter | authenticated, ai_rate_limited |
| 713 | DELETE | /api/docs/documents/:id | server/routes/docs.ts:386 | requireAccountManager | isAuthenticated, requireAccountManager, writeLimiter | authenticated, ai_rate_limited |
| 714 | POST | /api/docs/documents/:id/lock | server/routes/docs.ts:417 | requireAccountManager | isAuthenticated, requireAccountManager, writeLimiter | authenticated, ai_rate_limited |
| 715 | POST | /api/docs/documents/:id/lock/heartbeat | server/routes/docs.ts:451 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 716 | DELETE | /api/docs/documents/:id/lock | server/routes/docs.ts:485 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 717 | GET | /api/docs/documents/:id/lock | server/routes/docs.ts:522 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 718 | GET | /api/docs/team-roster | server/routes/docs.ts:562 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 719 | GET | /api/docs/documents/:id/permissions | server/routes/docs.ts:587 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 720 | PUT | /api/docs/documents/:id/permissions | server/routes/docs.ts:613 | requireAccountManager | isAuthenticated, requireAccountManager, writeLimiter | authenticated, ai_rate_limited |
| 721 | DELETE | /api/docs/documents/:id/permissions/:userId | server/routes/docs.ts:666 | requireAccountManager | isAuthenticated, requireAccountManager, writeLimiter | authenticated, ai_rate_limited |
| 722 | GET | /api/docs/documents/:id/versions | server/routes/docs.ts:711 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 723 | GET | /api/docs/documents/:id/versions/:versionId | server/routes/docs.ts:737 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 724 | POST | /api/docs/documents/:id/versions | server/routes/docs.ts:766 | requireAccountManager | isAuthenticated, requireAccountManager, writeLimiter | authenticated, ai_rate_limited |
| 725 | POST | /api/docs/documents/:id/versions/:versionId/restore | server/routes/docs.ts:820 | requireAccountManager | isAuthenticated, requireAccountManager, writeLimiter | authenticated, ai_rate_limited |
| 726 | GET | /api/docs/documents/:id/activity | server/routes/docs.ts:864 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 727 | POST | /api/docs/documents/import | server/routes/docs.ts:905 | requireAccountManager | isAuthenticated, requireAccountManager, uploadLimiter | authenticated, ai_rate_limited |
| 728 | GET | /api/docs/documents/:id/export/docx | server/routes/docs.ts:996 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 729 | GET | /api/email-templates | server/routes/emailSequences.ts:193 | authenticated | isAuthenticated | authenticated |
| 730 | POST | /api/email-templates | server/routes/emailSequences.ts:209 | authenticated | isAuthenticated, writeLimiter | authenticated, ai_rate_limited |
| 731 | PATCH | /api/email-templates/:id | server/routes/emailSequences.ts:240 | authenticated | isAuthenticated, writeLimiter | authenticated, ai_rate_limited |
| 732 | POST | /api/email-templates/:id/preview | server/routes/emailSequences.ts:272 | authenticated | isAuthenticated, writeLimiter | authenticated, ai_rate_limited |
| 733 | GET | /api/email-sequences | server/routes/emailSequences.ts:313 | authenticated | isAuthenticated | authenticated |
| 734 | POST | /api/email-sequences | server/routes/emailSequences.ts:337 | authenticated | isAuthenticated, writeLimiter | authenticated, ai_rate_limited |
| 735 | GET | /api/email-sequences/settings | server/routes/emailSequences.ts:374 | authenticated | isAuthenticated | authenticated |
| 736 | POST | /api/email-sequences/settings | server/routes/emailSequences.ts:388 | requireCeo | isAuthenticated, writeLimiter, requireCeo | authenticated, admin_only, ai_rate_limited |
| 737 | GET | /api/email-sequences/approvals | server/routes/emailSequences.ts:412 | authenticated | isAuthenticated | authenticated |
| 738 | POST | /api/email-sequences/step-sends/:id/approve | server/routes/emailSequences.ts:433 | authenticated | isAuthenticated, writeLimiter | authenticated, ai_rate_limited |
| 739 | PATCH | /api/email-sequences/step-sends/:id | server/routes/emailSequences.ts:466 | authenticated | isAuthenticated, writeLimiter | authenticated, ai_rate_limited |
| 740 | POST | /api/email-sequences/step-sends/:id/reject | server/routes/emailSequences.ts:496 | authenticated | isAuthenticated, writeLimiter | authenticated, ai_rate_limited |
| 741 | POST | /api/email-sequences/enrollments/:enrollmentId/cancel | server/routes/emailSequences.ts:524 | authenticated | isAuthenticated, writeLimiter | authenticated, ai_rate_limited |
| 742 | GET | /api/email-sequences/:id | server/routes/emailSequences.ts:556 | authenticated | isAuthenticated | authenticated |
| 743 | PATCH | /api/email-sequences/:id | server/routes/emailSequences.ts:580 | authenticated | isAuthenticated, writeLimiter | authenticated, ai_rate_limited |
| 744 | PATCH | /api/email-sequences/:id/auto-send | server/routes/emailSequences.ts:610 | authenticated | isAuthenticated, writeLimiter | authenticated, ai_rate_limited |
| 745 | PUT | /api/email-sequences/:id/steps | server/routes/emailSequences.ts:640 | authenticated | isAuthenticated, writeLimiter | authenticated, ai_rate_limited |
| 746 | POST | /api/email-sequences/:id/enroll | server/routes/emailSequences.ts:671 | authenticated | isAuthenticated, writeLimiter | authenticated, ai_rate_limited |
| 747 | POST | /api/email-sequences/:id/enroll-segment | server/routes/emailSequences.ts:705 | authenticated | isAuthenticated, writeLimiter | authenticated, ai_rate_limited |
| 748 | GET | /api/email-sequences/:id/enrollments | server/routes/emailSequences.ts:732 | authenticated | isAuthenticated | authenticated |
| 749 | GET | /api/email-sequences/:id/analytics | server/routes/emailSequences.ts:750 | authenticated | isAuthenticated | authenticated |
| 750 | POST | /api/feedback/upload-url | server/routes/feedback.ts:253 | authenticated | isAuthenticated | authenticated |
| 751 | POST | /api/feedback | server/routes/feedback.ts:274 | authenticated | isAuthenticated | authenticated |
| 752 | POST | /api/feedback/:id/retry-slack | server/routes/feedback.ts:435 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 753 | POST | /api/feedback/:id/requeue-slack | server/routes/feedback.ts:484 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 754 | POST | /api/feedback/requeue-undeliverable | server/routes/feedback.ts:509 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 755 | GET | /api/feedback | server/routes/feedback.ts:522 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 756 | GET | /api/feedback/:id/attachment | server/routes/feedback.ts:545 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 757 | GET | /api/feedback/slack-retry/status | server/routes/feedbackSlackRetry.ts:33 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 758 | PUT | /api/feedback/slack-retry/config | server/routes/feedbackSlackRetry.ts:82 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 759 | POST | /api/feedback/slack-retry/run | server/routes/feedbackSlackRetry.ts:174 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 760 | POST | /api/integrations/ghl/marketplace-webhook | server/routes/ghlMarketplaceWebhook.ts:497 | public | none | public |
| 761 | GET | /api/integrations/google-ads/status | server/routes/googleAds.ts:35 | authenticated | isAuthenticated | authenticated |
| 762 | GET | /api/integrations/google-ads/customers | server/routes/googleAds.ts:74 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 763 | POST | /api/integrations/google-ads/customers/discover | server/routes/googleAds.ts:88 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 764 | PATCH | /api/integrations/google-ads/customers/:customerId | server/routes/googleAds.ts:108 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 765 | POST | /api/integrations/google-ads/sync-now | server/routes/googleAds.ts:134 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 766 | GET | /api/integrations/google-ads/sync-runs | server/routes/googleAds.ts:173 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 767 | GET | /api/admin/google-ads-audit/accounts | server/routes/googleAdsAudit.ts:27 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated, admin_only |
| 768 | POST | /api/admin/google-ads-audit/:customerId/run | server/routes/googleAdsAudit.ts:50 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 769 | GET | /api/admin/google-ads-audit/:customerId/runs | server/routes/googleAdsAudit.ts:76 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated, admin_only |
| 770 | GET | /api/admin/google-ads-audit/runs/:runId | server/routes/googleAdsAudit.ts:92 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated, admin_only |
| 771 | GET | /api/admin/google-ads-hygiene/:customerId/pacing | server/routes/googleAdsHygiene.ts:38 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated, admin_only |
| 772 | GET | /api/admin/google-ads-hygiene/:customerId/lsa | server/routes/googleAdsHygiene.ts:59 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated, admin_only |
| 773 | POST | /api/admin/google-ads-hygiene/:customerId/keyword-intel/run | server/routes/googleAdsHygiene.ts:78 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 774 | GET | /api/admin/google-ads-hygiene/:customerId/keyword-intel/results | server/routes/googleAdsHygiene.ts:99 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated, admin_only |
| 775 | GET | /api/admin/google-ads-hygiene/:customerId/alerts | server/routes/googleAdsHygiene.ts:120 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated, admin_only |
| 776 | POST | /api/admin/google-ads-hygiene/:customerId/alerts/compute | server/routes/googleAdsHygiene.ts:139 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 777 | POST | /api/admin/google-ads-hygiene/alerts/:alertId/resolve | server/routes/googleAdsHygiene.ts:160 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 778 | POST | /api/admin/google-ads-hygiene/alerts/:alertId/clickup | server/routes/googleAdsHygiene.ts:178 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 779 | POST | /api/admin/google-ads-hygiene/alerts/:alertId/clickup/refresh | server/routes/googleAdsHygiene.ts:234 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 780 | GET | /api/health | server/routes/health/core.ts:63 | public | none | public |
| 781 | GET | /api/health/history | server/routes/health/core.ts:309 | public | none | public |
| 782 | GET | /api/health/manual-reserve/by-worker/history | server/routes/health/core.ts:337 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 783 | GET | /api/health/manual-reserve/by-worker/history/export | server/routes/health/core.ts:365 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 784 | GET | /api/health/history/export | server/routes/health/core.ts:479 | public | none | public |
| 785 | GET | /api/health/thresholds | server/routes/health/core.ts:562 | authenticated | isAuthenticated | authenticated |
| 786 | PUT | /api/health/thresholds | server/routes/health/core.ts:566 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 787 | POST | /api/health/thresholds/reset | server/routes/health/core.ts:575 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 788 | GET | /api/health/manual-reserve-mute | server/routes/health/core.ts:579 | authenticated | isAuthenticated | authenticated |
| 789 | POST | /api/health/manual-reserve-mute | server/routes/health/core.ts:588 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 790 | DELETE | /api/health/manual-reserve-mute | server/routes/health/core.ts:606 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 791 | GET | /api/health/flush-status | server/routes/health/core.ts:644 | authenticated | isAuthenticated | authenticated |
| 792 | GET | /api/health/db-attribution | server/routes/health/core.ts:651 | authenticated | isAuthenticated | authenticated |
| 793 | GET | /api/_internal/db-metrics | server/routes/health/core.ts:720 | authenticated | isAuthenticated | authenticated |
| 794 | GET | /api/health/request-metrics | server/routes/health/core.ts:744 | authenticated | isAuthenticated | authenticated |
| 795 | GET | /api/_internal/obs-demo/slow | server/routes/health/core.ts:781 | authenticated | isAuthenticated | authenticated |
| 796 | GET | /api/_internal/obs-demo/error | server/routes/health/core.ts:790 | authenticated | isAuthenticated | authenticated |
| 797 | GET | /api/health/db/slow-queries | server/routes/health/diagnosticsAndDigests.ts:21 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 798 | GET | /api/health/db/locks | server/routes/health/diagnosticsAndDigests.ts:30 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 799 | GET | /api/health/db/table-health | server/routes/health/diagnosticsAndDigests.ts:39 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 800 | GET | /api/health/db/table-size-trend | server/routes/health/diagnosticsAndDigests.ts:50 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 801 | GET | /api/health/db/metric-availability | server/routes/health/diagnosticsAndDigests.ts:61 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 802 | GET | /api/health/report | server/routes/health/diagnosticsAndDigests.ts:71 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 803 | GET | /api/health/digest/config | server/routes/health/diagnosticsAndDigests.ts:87 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 804 | PUT | /api/health/digest/config | server/routes/health/diagnosticsAndDigests.ts:109 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 805 | POST | /api/health/digest/send-now | server/routes/health/diagnosticsAndDigests.ts:142 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 806 | GET | /api/health/manual-reserve-digest/config | server/routes/health/diagnosticsAndDigests.ts:153 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 807 | PUT | /api/health/manual-reserve-digest/config | server/routes/health/diagnosticsAndDigests.ts:174 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 808 | POST | /api/health/manual-reserve-digest/send-now | server/routes/health/diagnosticsAndDigests.ts:281 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 809 | GET | /api/health/manual-reserve-digest/preview | server/routes/health/diagnosticsAndDigests.ts:305 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 810 | GET | /api/health/manual-reserve-digest/history | server/routes/health/diagnosticsAndDigests.ts:335 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 811 | GET | /api/health/manual-reserve-alerts | server/routes/health/manualReserveAlertsAdmin.ts:75 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 812 | GET | /api/health/manual-reserve-alerts.csv | server/routes/health/manualReserveAlertsAdmin.ts:147 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 813 | POST | /api/health/manual-reserve-alerts/resend | server/routes/health/manualReserveAlertsAdmin.ts:222 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 814 | POST | /api/health/kill-switches | server/routes/health/opsAndIncidents.ts:26 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 815 | GET | /api/health/pool-epic-switches | server/routes/health/opsAndIncidents.ts:52 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 816 | POST | /api/health/pool-epic-switches | server/routes/health/opsAndIncidents.ts:62 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 817 | POST | /api/health/flush | server/routes/health/opsAndIncidents.ts:87 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 818 | GET | /api/health/overview | server/routes/health/opsAndIncidents.ts:100 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 819 | GET | /api/health/rollups | server/routes/health/opsAndIncidents.ts:111 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 820 | GET | /api/health/semrush-ghost-cleanup | server/routes/health/opsAndIncidents.ts:125 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 821 | PUT | /api/health/semrush-ghost-cleanup | server/routes/health/opsAndIncidents.ts:186 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 822 | GET | /api/health/import-ghosts-snapshot | server/routes/health/opsAndIncidents.ts:222 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 823 | GET | /api/health/freshness | server/routes/health/opsAndIncidents.ts:292 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 824 | GET | /api/health/pool-state | server/routes/health/opsAndIncidents.ts:302 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 825 | GET | /api/health/samplers | server/routes/health/opsAndIncidents.ts:321 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 826 | GET | /api/health/incidents | server/routes/health/opsAndIncidents.ts:335 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 827 | POST | /api/health/incidents/:id/ack | server/routes/health/opsAndIncidents.ts:350 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 828 | POST | /api/health/incidents/:id/snooze | server/routes/health/opsAndIncidents.ts:364 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 829 | POST | /api/health/incidents/:id/resolve | server/routes/health/opsAndIncidents.ts:380 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 830 | GET | /api/health/post-deploy-verification | server/routes/health/postDeployVerification.ts:21 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 831 | POST | /api/health/post-deploy-verification/baseline | server/routes/health/postDeployVerification.ts:44 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 832 | DELETE | /api/health/post-deploy-verification/baseline/:id | server/routes/health/postDeployVerification.ts:62 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 833 | POST | /api/health/post-deploy-verification/baseline/:id/restore | server/routes/health/postDeployVerification.ts:92 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 834 | POST | /api/health/post-deploy-verification/auto-baseline-setting | server/routes/health/postDeployVerification.ts:122 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 835 | POST | /api/health/post-deploy-verification/send-now | server/routes/health/postDeployVerification.ts:152 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 836 | POST | /api/health/post-deploy-verification/acknowledge | server/routes/health/postDeployVerification.ts:175 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 837 | DELETE | /api/health/post-deploy-verification/acknowledge | server/routes/health/postDeployVerification.ts:204 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 838 | POST | /api/health/post-deploy-verification/force-resolve-legacy | server/routes/health/postDeployVerification.ts:237 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 839 | GET | /api/public/heatmaps/:snapshotId/geojson | server/routes/heatmap.ts:39 | public | none | public |
| 840 | GET | /api/public/heatmaps/:snapshotId/meta | server/routes/heatmap.ts:65 | public | none | public |
| 841 | GET | /api/semrush/status | server/routes/heatmap.ts:98 | authenticated | isAuthenticated | authenticated |
| 842 | POST | /api/semrush/authorize | server/routes/heatmap.ts:189 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 843 | POST | /api/semrush/poll-token | server/routes/heatmap.ts:200 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 844 | POST | /api/semrush/disconnect | server/routes/heatmap.ts:211 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 845 | POST | /api/semrush/campaigns/clear-cache | server/routes/heatmap.ts:222 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 846 | POST | /api/semrush/campaigns/refresh | server/routes/heatmap.ts:237 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 847 | GET | /api/semrush/campaigns | server/routes/heatmap.ts:251 | authenticated | isAuthenticated | authenticated |
| 848 | GET | /api/semrush/campaigns/:campaignId | server/routes/heatmap.ts:268 | authenticated | isAuthenticated | authenticated |
| 849 | GET | /api/semrush/campaigns/:campaignId/keywords | server/routes/heatmap.ts:279 | authenticated | isAuthenticated | authenticated |
| 850 | POST | /api/semrush/campaigns/:campaignId/fetch-heatmap | server/routes/heatmap.ts:312 | authenticated | isAuthenticated | authenticated |
| 851 | POST | /api/semrush/campaigns/:campaignId/fetch-all-heatmaps | server/routes/heatmap.ts:479 | authenticated | isAuthenticated | authenticated |
| 852 | GET | /api/semrush/inventory/status | server/routes/heatmap.ts:634 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 853 | GET | /api/semrush/inventory/campaigns | server/routes/heatmap.ts:650 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 854 | POST | /api/semrush/inventory/sync | server/routes/heatmap.ts:666 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 855 | POST | /api/semrush/heatmaps/backfill | server/routes/heatmap.ts:689 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 856 | POST | /api/semrush/heatmaps/backfill/progress | server/routes/heatmap.ts:1026 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 857 | POST | /api/semrush/heatmaps/backfill/coverage | server/routes/heatmap.ts:1056 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 858 | GET | /api/semrush/heatmaps/backfill/runs | server/routes/heatmap.ts:1231 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 859 | GET | /api/semrush/heatmaps/backfill/runs/:jobId/progress | server/routes/heatmap.ts:1274 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 860 | POST | /api/semrush/campaigns/:campaignId/refresh | server/routes/heatmap.ts:1311 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 861 | GET | /api/clients/:clientId/semrush-integration | server/routes/heatmap.ts:1332 | authenticated | isAuthenticated | authenticated |
| 862 | PUT | /api/clients/:clientId/semrush-integration | server/routes/heatmap.ts:1345 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 863 | DELETE | /api/clients/:clientId/semrush-integration | server/routes/heatmap.ts:1397 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 864 | POST | /api/clients/:clientId/semrush-integration/sync | server/routes/heatmap.ts:1409 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 865 | GET | /api/clients/:clientId/semrush-integration/sync-state | server/routes/heatmap.ts:1480 | authenticated | isAuthenticated | authenticated |
| 866 | POST | /api/clients/:clientId/semrush-integration/locations/:locationId/retry | server/routes/heatmap.ts:1530 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 867 | GET | /api/clients/:clientId/semrush-integration/locations/:locationId/attempts | server/routes/heatmap.ts:1568 | authenticated | isAuthenticated | authenticated |
| 868 | GET | /api/backfill-jobs | server/routes/heatmap.ts:1588 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 869 | GET | /api/backfill-jobs/:jobId | server/routes/heatmap.ts:1611 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 870 | GET | /api/backfill-jobs/:jobId/coverage-gaps | server/routes/heatmap.ts:1625 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 871 | GET | /api/backfill-jobs/:jobId/coverage-check | server/routes/heatmap.ts:1706 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 872 | GET | /api/backfill-jobs/:jobId/coverage-check/report | server/routes/heatmap.ts:1742 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 873 | POST | /api/backfill-jobs/:jobId/coverage-check/rerun | server/routes/heatmap.ts:1785 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 874 | GET | /api/semrush/console/overview | server/routes/heatmap.ts:1843 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 875 | GET | /api/semrush/console/sync-state | server/routes/heatmap.ts:2014 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 876 | GET | /api/semrush/console/recent-jobs | server/routes/heatmap.ts:2115 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 877 | GET | /api/clients/:clientId/semrush-mapped-campaigns | server/routes/heatmap.ts:2167 | authenticated | isAuthenticated | authenticated |
| 878 | GET | /api/clients/:clientId/semrush-location-campaigns | server/routes/heatmap.ts:2240 | authenticated | isAuthenticated | authenticated |
| 879 | PUT | /api/clients/:clientId/semrush-location-campaigns | server/routes/heatmap.ts:2252 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 880 | POST | /api/clients/:clientId/semrush-location-campaigns/auto-match | server/routes/heatmap.ts:2340 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 881 | GET | /api/clients/:clientId/local-dominance | server/routes/heatmap.ts:2679 | requireCommandCenterAccess | isAuthenticated, requireCommandCenterAccess | authenticated |
| 882 | GET | /api/clients/:clientId/local-dominance/sov-history | server/routes/heatmap.ts:2691 | requireCommandCenterAccess | isAuthenticated, requireCommandCenterAccess | authenticated |
| 883 | GET | /api/clients/:clientId/local-dominance/competitors | server/routes/heatmap.ts:2704 | requireCommandCenterAccess | isAuthenticated, requireCommandCenterAccess | authenticated |
| 884 | GET | /api/clients/:clientId/local-dominance/distribution | server/routes/heatmap.ts:2731 | requireCommandCenterAccess | isAuthenticated, requireCommandCenterAccess | authenticated |
| 885 | GET | /api/clients/:clientId/local-dominance/location-snapshots | server/routes/heatmap.ts:2772 | requireCommandCenterAccess | isAuthenticated, requireCommandCenterAccess | authenticated |
| 886 | GET | /api/clients/:clientId/local-dominance/keywords | server/routes/heatmap.ts:2783 | requireCommandCenterAccess | isAuthenticated, requireCommandCenterAccess | authenticated |
| 887 | POST | /api/admin/local-dominance/sync-all | server/routes/heatmap.ts:2835 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 888 | GET | /api/heatmaps/search | server/routes/heatmap.ts:2849 | authenticated | isAuthenticated | authenticated |
| 889 | GET | /api/heatmaps/locations | server/routes/heatmap.ts:2862 | authenticated | isAuthenticated | authenticated |
| 890 | POST | /api/heatmaps/import | server/routes/heatmap.ts:2873 | authenticated | isAuthenticated | authenticated |
| 891 | POST | /api/heatmaps/import-batch | server/routes/heatmap.ts:2898 | authenticated | isAuthenticated | authenticated |
| 892 | GET | /api/heatmaps/location/:locationId/snapshots | server/routes/heatmap.ts:2937 | authenticated | isAuthenticated | authenticated |
| 893 | GET | /api/heatmaps/:snapshotId/geojson | server/routes/heatmap.ts:2948 | authenticated | isAuthenticated | authenticated |
| 894 | GET | /api/heatmaps/:snapshotId/meta | server/routes/heatmap.ts:2963 | authenticated | isAuthenticated | authenticated |
| 895 | POST | /api/heatmaps/backfill-bands | server/routes/heatmap.ts:2981 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 896 | GET | /api/clients/:clientId/heatmap-snapshots-for-month | server/routes/heatmap.ts:2991 | authenticated | isAuthenticated | authenticated |
| 897 | POST | /api/heatmaps/backfill-all | server/routes/heatmap.ts:3007 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 898 | GET | /api/import-suggestions | server/routes/importSuggestions.ts:82 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 899 | POST | /api/import-suggestions/:id/dismiss | server/routes/importSuggestions.ts:146 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 900 | POST | /api/import-suggestions/:id/approve | server/routes/importSuggestions.ts:172 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 901 | GET | /api/admin/front/analytics-coverage | server/routes/integrations/frontAnalyticsCoverage.ts:26 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated, admin_only |
| 902 | POST | /api/admin/front/analytics-coverage/refresh | server/routes/integrations/frontAnalyticsCoverage.ts:60 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 903 | POST | /api/admin/front/analytics-coverage/refresh-month | server/routes/integrations/frontAnalyticsCoverage.ts:91 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 904 | POST | /api/admin/front/analytics-coverage/reprobe-month | server/routes/integrations/frontAnalyticsCoverage.ts:176 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 905 | POST | /api/admin/front/analytics-coverage/recompute | server/routes/integrations/frontAnalyticsCoverage.ts:299 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 906 | POST | /api/admin/front/analytics-coverage/backfill-message-grain | server/routes/integrations/frontAnalyticsCoverage.ts:358 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 907 | POST | /api/admin/front/analytics-coverage/finish-message-grain | server/routes/integrations/frontAnalyticsCoverage.ts:413 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 908 | GET | /api/admin/front/analytics-coverage/finish-message-grain-status | server/routes/integrations/frontAnalyticsCoverage.ts:468 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 909 | POST | /api/admin/front/analytics-coverage/finish-message-grain-driver-run | server/routes/integrations/frontAnalyticsCoverage.ts:514 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 910 | GET | /api/admin/front/analytics-coverage/finish-message-grain-driver-status | server/routes/integrations/frontAnalyticsCoverage.ts:612 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 911 | POST | /api/admin/front/analytics-coverage/close-outbound-gap | server/routes/integrations/frontAnalyticsCoverage.ts:663 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 912 | GET | /api/admin/front/analytics-coverage/outbound-gap-status | server/routes/integrations/frontAnalyticsCoverage.ts:784 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 913 | POST | /api/admin/front/analytics-coverage/upgrade-message-grain | server/routes/integrations/frontAnalyticsCoverage.ts:880 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 914 | GET | /api/admin/front/analytics-coverage/message-grain-upgrade-status | server/routes/integrations/frontAnalyticsCoverage.ts:1032 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 915 | POST | /api/admin/front/analytics-coverage/backfill-outbound-gap | server/routes/integrations/frontAnalyticsCoverage.ts:1111 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 916 | GET | /api/admin/front/analytics-coverage/backfill-outbound-gap-status | server/routes/integrations/frontAnalyticsCoverage.ts:1216 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 917 | POST | /api/admin/front/analytics-coverage/unreadable-alert-config | server/routes/integrations/frontAnalyticsCoverage.ts:1277 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 918 | GET | /api/admin/front/analytics-coverage/alerts | server/routes/integrations/frontAnalyticsCoverage.ts:1331 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated, admin_only |
| 919 | PUT | /api/admin/front/analytics-coverage/alerts | server/routes/integrations/frontAnalyticsCoverage.ts:1435 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 920 | GET | /api/admin/front/auto-closure/status | server/routes/integrations/frontAutoClosure.ts:17 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated, admin_only |
| 921 | POST | /api/admin/front/auto-closure/unpark | server/routes/integrations/frontAutoClosure.ts:37 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 922 | POST | /api/admin/front/auto-closure/rearm | server/routes/integrations/frontAutoClosure.ts:67 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 923 | POST | /api/admin/front/auto-closure/rearm-one | server/routes/integrations/frontAutoClosure.ts:92 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 924 | GET | /api/admin/front/auto-closure/overnight | server/routes/integrations/frontAutoClosure.ts:119 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated, admin_only |
| 925 | PUT | /api/admin/front/auto-closure/overnight | server/routes/integrations/frontAutoClosure.ts:211 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 926 | GET | /api/admin/front/auto-closure/regression-alert-status | server/routes/integrations/frontAutoClosure.ts:313 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated, admin_only |
| 927 | POST | /api/admin/front/auto-closure/regression-alert-status/re-evaluate | server/routes/integrations/frontAutoClosure.ts:332 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 928 | POST | /api/integrations/front/webhook | server/routes/integrations/frontConnection.ts:22 | public | none | public, webhook |
| 929 | GET | /api/integrations/front/auth-history | server/routes/integrations/frontConnection.ts:116 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 930 | POST | /api/integrations/front/disconnect | server/routes/integrations/frontConnection.ts:132 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 931 | POST | /api/integrations/front/reset-sync | server/routes/integrations/frontConnection.ts:144 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 932 | POST | /api/integrations/front/reprocess-dismissed | server/routes/integrations/frontConsole.ts:18 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 933 | POST | /api/integrations/front/rematch-all | server/routes/integrations/frontConsole.ts:49 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 934 | GET | /api/integrations/front/rematch-all/status/:jobId | server/routes/integrations/frontConsole.ts:137 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 935 | GET | /api/integrations/front/rematch-all/running | server/routes/integrations/frontConsole.ts:144 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 936 | POST | /api/integrations/front/full-backfill | server/routes/integrations/frontConsole.ts:151 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 937 | GET | /api/integrations/front/full-backfill/status/:jobId | server/routes/integrations/frontConsole.ts:210 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 938 | POST | /api/integrations/front/bulk-action/preview | server/routes/integrations/frontConsole.ts:224 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 939 | POST | /api/integrations/front/bulk-action | server/routes/integrations/frontConsole.ts:240 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 940 | GET | /api/integrations/front/console/overview | server/routes/integrations/frontConsole.ts:271 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 941 | GET | /api/integrations/front/console/bring-to-100 | server/routes/integrations/frontConsole.ts:836 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 942 | GET | /api/integrations/front/console/bring-to-100/status | server/routes/integrations/frontConsole.ts:848 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 943 | POST | /api/integrations/front/console/bring-to-100 | server/routes/integrations/frontConsole.ts:869 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 944 | GET | /api/integrations/front/filter-rules | server/routes/integrations/frontFilterRules.ts:27 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 945 | POST | /api/integrations/front/filter-rules | server/routes/integrations/frontFilterRules.ts:39 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 946 | PATCH | /api/integrations/front/filter-rules/:id | server/routes/integrations/frontFilterRules.ts:56 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 947 | DELETE | /api/integrations/front/filter-rules/:id | server/routes/integrations/frontFilterRules.ts:71 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 948 | POST | /api/integrations/front/filter-rules/preview | server/routes/integrations/frontFilterRules.ts:85 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 949 | POST | /api/integrations/front/filter-rules/:id/apply | server/routes/integrations/frontFilterRules.ts:106 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 950 | GET | /api/integrations/front/filter-rules/apply-status/:jobId | server/routes/integrations/frontFilterRules.ts:120 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 951 | GET | /api/integrations/front/filter-rules/apply-jobs/:jobId/audit | server/routes/integrations/frontFilterRules.ts:138 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 952 | GET | /api/integrations/front/filter-rules/:id/hits | server/routes/integrations/frontFilterRules.ts:202 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 953 | GET | /api/integrations/front/filter-rules/apply-jobs/active | server/routes/integrations/frontFilterRules.ts:225 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 954 | GET | /api/integrations/front/historical-recovery/coverage | server/routes/integrations/frontHistoricalRecovery.ts:18 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 955 | POST | /api/integrations/front/historical-recovery/execute | server/routes/integrations/frontHistoricalRecovery.ts:29 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 956 | GET | /api/integrations/front/historical-recovery/status/:jobId | server/routes/integrations/frontHistoricalRecovery.ts:63 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 957 | GET | /api/integrations/front/historical-recovery/jobs | server/routes/integrations/frontHistoricalRecovery.ts:71 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 958 | POST | /api/integrations/front/historical-recovery/:jobId/resume | server/routes/integrations/frontHistoricalRecovery.ts:81 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 959 | DELETE | /api/integrations/front/historical-recovery/jobs/:jobId | server/routes/integrations/frontHistoricalRecovery.ts:126 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 960 | DELETE | /api/integrations/front/historical-recovery/jobs | server/routes/integrations/frontHistoricalRecovery.ts:158 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 961 | POST | /api/integrations/front/historical-recovery/jobs/:jobId/windows/:windowLabel/clear-alerts | server/routes/integrations/frontHistoricalRecovery.ts:195 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 962 | GET | /api/integrations/front/historical-recovery/sweep-status | server/routes/integrations/frontHistoricalRecovery.ts:243 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 963 | GET | /api/integrations/front/historical-recovery/manual-sweep-history | server/routes/integrations/frontHistoricalRecovery.ts:254 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 964 | POST | /api/integrations/front/historical-recovery/run-sweep | server/routes/integrations/frontHistoricalRecovery.ts:291 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 965 | GET | /api/integrations/front/historical-recovery/max-age | server/routes/integrations/frontHistoricalRecovery.ts:334 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 966 | PUT | /api/integrations/front/historical-recovery/max-age | server/routes/integrations/frontHistoricalRecovery.ts:363 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 967 | GET | /api/integrations/front/historical-recovery/prune-interval | server/routes/integrations/frontHistoricalRecovery.ts:421 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 968 | PUT | /api/integrations/front/historical-recovery/prune-interval | server/routes/integrations/frontHistoricalRecovery.ts:450 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 969 | GET | /api/integrations/front/historical-recovery/max-age/history | server/routes/integrations/frontHistoricalRecovery.ts:516 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 970 | GET | /api/integrations/front/historical-recovery/tuning | server/routes/integrations/frontHistoricalRecovery.ts:532 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 971 | PUT | /api/integrations/front/historical-recovery/tuning | server/routes/integrations/frontHistoricalRecovery.ts:585 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 972 | GET | /api/integrations/front/historical-recovery/materializer-budget | server/routes/integrations/frontHistoricalRecovery.ts:712 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 973 | PUT | /api/integrations/front/historical-recovery/materializer-budget | server/routes/integrations/frontHistoricalRecovery.ts:781 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 974 | GET | /api/integrations/front/historical-recovery/auto-continue-max-attempts | server/routes/integrations/frontHistoricalRecovery.ts:917 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 975 | PUT | /api/integrations/front/historical-recovery/auto-continue-max-attempts | server/routes/integrations/frontHistoricalRecovery.ts:945 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 976 | GET | /api/integrations/front/historical-recovery/auto-continue-max-attempts/history | server/routes/integrations/frontHistoricalRecovery.ts:999 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 977 | GET | /api/integrations/front/historical-recovery/prune-interval/history | server/routes/integrations/frontHistoricalRecovery.ts:1011 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 978 | GET | /api/integrations/front/historical-recovery/retry-alert | server/routes/integrations/frontHistoricalRecovery.ts:1024 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 979 | PUT | /api/integrations/front/historical-recovery/retry-alert | server/routes/integrations/frontHistoricalRecovery.ts:1098 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 980 | POST | /api/integrations/front/historical-backfill | server/routes/integrations/frontOps.ts:20 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 981 | GET | /api/integrations/front/historical-backfill/status/:runId | server/routes/integrations/frontOps.ts:71 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 982 | GET | /api/integrations/front/unmatched-diagnosis | server/routes/integrations/frontOps.ts:92 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 983 | POST | /api/integrations/front/attach-sender-to-client | server/routes/integrations/frontOps.ts:112 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 984 | POST | /api/integrations/front/attach-senders-to-client | server/routes/integrations/frontOps.ts:235 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 985 | GET | /api/integrations/front/match-stats | server/routes/integrations/frontOps.ts:354 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 986 | GET | /api/integrations/front/audit/:syncEmailId | server/routes/integrations/frontOps.ts:385 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 987 | POST | /api/integrations/front/backfill-867 | server/routes/integrations/frontOps.ts:403 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 988 | POST | /api/integrations/ghl/connect | server/routes/integrations/ghl.ts:7 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 989 | POST | /api/integrations/ghl/disconnect | server/routes/integrations/ghl.ts:41 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 990 | GET | /api/integrations/ghl/status | server/routes/integrations/ghl.ts:55 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 991 | GET | /api/integrations/all-status | server/routes/integrations/hub.ts:24 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 992 | GET | /api/integrations/front/credential-history | server/routes/integrations/hub.ts:540 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 993 | GET | /api/integrations/zoom/credential-history | server/routes/integrations/hub.ts:547 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 994 | GET | /api/integrations/slack/credential-history | server/routes/integrations/hub.ts:554 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 995 | GET | /api/integrations/pandadoc/credential-history | server/routes/integrations/hub.ts:566 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 996 | GET | /api/integrations/ghl/credential-history | server/routes/integrations/hub.ts:573 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 997 | GET | /api/integrations/semrush/credential-history | server/routes/integrations/hub.ts:580 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 998 | GET | /api/integrations/pipeline/health | server/routes/integrations/pipeline.ts:14 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 999 | GET | /api/integrations/front/pipeline-metrics | server/routes/integrations/pipeline.ts:32 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 1000 | GET | /api/integrations/pipeline/cutover-status | server/routes/integrations/pipeline.ts:44 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 1001 | GET | /api/integrations/semrush/mapping-inventory | server/routes/integrations/semrush.ts:56 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 1002 | GET | /api/integrations/semrush/mapping-suggestions | server/routes/integrations/semrush.ts:153 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 1003 | POST | /api/integrations/semrush/mapping-suggestions/:id/approve | server/routes/integrations/semrush.ts:349 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 1004 | POST | /api/integrations/semrush/mapping-suggestions/:id/reject | server/routes/integrations/semrush.ts:463 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 1005 | GET | /api/integrations/semrush/heatmap-coverage | server/routes/integrations/semrush.ts:510 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 1006 | GET | /api/integrations/semrush/heatmap-coverage/:clientId/:locationId | server/routes/integrations/semrush.ts:541 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 1007 | POST | /api/integrations/semrush/heatmap-coverage/campaign/:campaignId/refresh-metadata | server/routes/integrations/semrush.ts:577 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 1008 | POST | /api/integrations/semrush/heatmap-coverage/:clientId/:locationId/rerun | server/routes/integrations/semrush.ts:607 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 1009 | GET | /api/integrations/unmatched-feed | server/routes/integrations/unmatched.ts:32 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 1010 | POST | /api/integrations/unmatched/:source/:id/assign | server/routes/integrations/unmatched.ts:672 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 1011 | POST | /api/integrations/unmatched/undo-claim | server/routes/integrations/unmatched.ts:807 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 1012 | POST | /api/integrations/unmatched/:source/:id/dismiss | server/routes/integrations/unmatched.ts:921 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 1013 | POST | /api/integrations/unmatched/:source/:id/block | server/routes/integrations/unmatched.ts:968 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 1014 | POST | /api/integrations/unmatched/:source/:id/promote | server/routes/integrations/unmatched.ts:1004 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 1015 | GET | /api/integrations/unmatched-by-sender | server/routes/integrations/unmatched.ts:1076 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 1016 | GET | /api/integrations/count-by-sender | server/routes/integrations/unmatched.ts:1101 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 1017 | GET | /api/integrations/count-by-domain | server/routes/integrations/unmatched.ts:1118 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 1018 | GET | /api/integrations/count-by-channel | server/routes/integrations/unmatched.ts:1135 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 1019 | POST | /api/integrations/bulk-dismiss-by-sender | server/routes/integrations/unmatched.ts:1153 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 1020 | POST | /api/integrations/bulk-dismiss-by-domain | server/routes/integrations/unmatched.ts:1173 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 1021 | POST | /api/integrations/bulk-dismiss-by-channel | server/routes/integrations/unmatched.ts:1193 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 1022 | GET | /api/integrations/work-queue/dead-letter/queue-names | server/routes/integrations/workQueue.ts:20 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1023 | GET | /api/integrations/work-queue/dead-letter | server/routes/integrations/workQueue.ts:30 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1024 | POST | /api/integrations/work-queue/dead-letter/:id/replay | server/routes/integrations/workQueue.ts:43 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1025 | POST | /api/integrations/work-queue/dead-letter/replay-all | server/routes/integrations/workQueue.ts:63 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1026 | GET | /api/integrations/work-queue/stale-lease-thresholds | server/routes/integrations/workQueue.ts:96 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 1027 | GET | /api/integrations/work-queue/stale-lease-thresholds/history | server/routes/integrations/workQueue.ts:113 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 1028 | PUT | /api/integrations/work-queue/stale-lease-thresholds | server/routes/integrations/workQueue.ts:148 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1029 | GET | /api/integrations/work-queue/timings | server/routes/integrations/workQueue.ts:167 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 1030 | GET | /api/integrations/work-queue/timings/history | server/routes/integrations/workQueue.ts:177 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 1031 | PUT | /api/integrations/work-queue/timings | server/routes/integrations/workQueue.ts:237 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1032 | GET | /api/integrations/work-queue/audit-prune-events | server/routes/integrations/workQueue.ts:257 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 1033 | PUT | /api/integrations/work-queue/audit-prune-events/stale-lease-threshold-audit/retention | server/routes/integrations/workQueue.ts:339 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1034 | PUT | /api/integrations/work-queue/audit-prune-events/queue-timing-audit/retention | server/routes/integrations/workQueue.ts:357 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1035 | GET | /api/integrations/work-queue/audit-prune-events/stale-lease-threshold-audit/retention/history | server/routes/integrations/workQueue.ts:379 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 1036 | GET | /api/integrations/work-queue/audit-prune-events/queue-timing-audit/retention/history | server/routes/integrations/workQueue.ts:406 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 1037 | GET | /api/integrations/work-queue/audit-prune-events/preview | server/routes/integrations/workQueue.ts:439 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1038 | GET | /api/integrations/work-queue/status | server/routes/integrations/workQueue.ts:476 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 1039 | GET | /api/integrations/work-queue/stuck-processing | server/routes/integrations/workQueue.ts:563 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 1040 | POST | /api/integrations/work-queue/:id/reclaim | server/routes/integrations/workQueue.ts:685 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1041 | POST | /api/integrations/zoom/transcript-backfill | server/routes/integrations/zoom.ts:15 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1042 | POST | /api/integrations/zoom/webhook | server/routes/integrations/zoom.ts:34 | public | none | public, webhook |
| 1043 | GET | /api/internal-usage | server/routes/internalUsage.ts:24 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1044 | GET | /api/internal-usage/wins-weekly | server/routes/internalUsage.ts:46 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1045 | POST | /api/health/block-ip | server/routes/ipBlocking.ts:20 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1046 | PATCH | /api/health/blocked-ips/:ip/expiry | server/routes/ipBlocking.ts:78 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1047 | POST | /api/health/unblock-ip | server/routes/ipBlocking.ts:137 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1048 | GET | /api/health/blocked-ips/activity | server/routes/ipBlocking.ts:176 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1049 | GET | /api/health/blocked-ips/trim-notifications | server/routes/ipBlocking.ts:191 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1050 | GET | /api/leads | server/routes/leads.ts:68 | authenticated | isAuthenticated | authenticated |
| 1051 | GET | /api/leads/merge-candidates | server/routes/leads.ts:98 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 1052 | GET | /api/leads/:id | server/routes/leads.ts:126 | authenticated | isAuthenticated | authenticated |
| 1053 | POST | /api/leads/:id/lifecycle | server/routes/leads.ts:157 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 1054 | POST | /api/leads/:id/merge | server/routes/leads.ts:200 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 1055 | GET | /api/live-data/clients/:clientId | server/routes/liveData.ts:41 | authenticated | isAuthenticated | authenticated |
| 1056 | POST | /api/live-data/clients/:clientId/refresh | server/routes/liveData.ts:101 | authenticated | isAuthenticated | authenticated |
| 1057 | GET | /api/admin/match-settings | server/routes/matchSettings.ts:307 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1058 | PUT | /api/admin/match-settings | server/routes/matchSettings.ts:344 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1059 | GET | /api/admin/match-settings/common-first-names | server/routes/matchSettings.ts:502 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1060 | PUT | /api/admin/match-settings/common-first-names | server/routes/matchSettings.ts:521 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1061 | GET | /api/admin/match-settings/common-first-names/history | server/routes/matchSettings.ts:681 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1062 | GET | /api/admin/match-settings/impact | server/routes/matchSettings.ts:728 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1063 | POST | /api/admin/match-settings/history/:id/retry-alerts | server/routes/matchSettings.ts:1072 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1064 | POST | /api/admin/match-settings/common-first-names/history/:id/retry-alerts | server/routes/matchSettings.ts:1275 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1065 | POST | /api/admin/match-settings/common-first-names/history/retry-failed | server/routes/matchSettings.ts:1302 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1066 | POST | /api/admin/match-settings/history/retry-failed | server/routes/matchSettings.ts:1399 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1067 | GET | /api/admin/match-settings/history | server/routes/matchSettings.ts:1480 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1068 | GET | /api/mcu/practice-areas | server/routes/mcu.ts:12 | public | none | public |
| 1069 | POST | /api/mcu/evaluate | server/routes/mcu.ts:16 | public | none | public |
| 1070 | POST | /api/mcu/internal/evaluate | server/routes/mcu.ts:64 | requireInternal | isAuthenticated, requireInternal | authenticated |
| 1071 | GET | /api/mcu/internal/summary | server/routes/mcu.ts:98 | requireInternal | isAuthenticated, requireInternal | authenticated |
| 1072 | POST | /api/mcu/internal/summary/refresh | server/routes/mcu.ts:143 | requireInternal | isAuthenticated, requireInternal | authenticated |
| 1073 | GET | /api/mcu/internal/hex-grid | server/routes/mcu.ts:172 | requireInternal | isAuthenticated, requireInternal | authenticated |
| 1074 | GET | /api/config/maptiler-key | server/routes/mcu.ts:189 | authenticated | isAuthenticated | authenticated |
| 1075 | GET | /api/public/config/maptiler-key | server/routes/mcu.ts:197 | public | none | public |
| 1076 | GET | /api/mcu/internal/hex-grid-geojson | server/routes/mcu.ts:205 | requireInternal | isAuthenticated, requireInternal | authenticated |
| 1077 | GET | /api/mcu/internal/evaluations | server/routes/mcu.ts:283 | requireInternal | isAuthenticated, requireInternal | authenticated |
| 1078 | GET | /api/admin/notifications | server/routes/notifications.ts:91 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 1079 | GET | /api/admin/notifications/kill-switch | server/routes/notifications.ts:190 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 1080 | PUT | /api/admin/notifications/kill-switch | server/routes/notifications.ts:206 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 1081 | GET | /api/admin/notifications/categories | server/routes/notifications.ts:230 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 1082 | POST | /api/admin/notifications/retention/run | server/routes/notifications.ts:240 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 1083 | GET | /api/admin/notifications/call-archive-thresholds | server/routes/notifications.ts:296 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 1084 | PUT | /api/admin/notifications/call-archive-thresholds | server/routes/notifications.ts:309 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 1085 | GET | /api/admin/notifications/call-archive-thresholds/live-counts | server/routes/notifications.ts:370 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 1086 | GET | /api/admin/notifications/call-analysis-failure-spike-thresholds | server/routes/notifications.ts:399 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 1087 | PUT | /api/admin/notifications/call-analysis-failure-spike-thresholds | server/routes/notifications.ts:413 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 1088 | POST | /api/admin/notifications/call-analysis-failure-spike-thresholds/preview | server/routes/notifications.ts:519 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 1089 | PUT | /api/admin/notifications/:id | server/routes/notifications.ts:541 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 1090 | POST | /api/admin/notifications/:id/test | server/routes/notifications.ts:615 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 1091 | GET | /api/admin/notifications/:id/deliveries | server/routes/notifications.ts:680 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 1092 | GET | /api/onboarding/intake/slots | server/routes/onboardingIntake.ts:38 | authenticated | isAuthenticated | authenticated |
| 1093 | POST | /api/onboarding/intake | server/routes/onboardingIntake.ts:97 | authenticated | isAuthenticated, writeLimiter | authenticated, ai_rate_limited |
| 1094 | GET | /api/admin/onboarding/roster | server/routes/onboardingRosterAdmin.ts:23 | authenticated | isAuthenticated | authenticated, admin_only |
| 1095 | POST | /api/admin/onboarding/roster | server/routes/onboardingRosterAdmin.ts:34 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 1096 | PUT | /api/admin/onboarding/roster/:id | server/routes/onboardingRosterAdmin.ts:48 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 1097 | DELETE | /api/admin/onboarding/roster/:id | server/routes/onboardingRosterAdmin.ts:66 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 1098 | PUT | /api/admin/onboarding/default | server/routes/onboardingRosterAdmin.ts:80 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 1099 | GET | /api/admin/orphaned-user-heal/status | server/routes/orphanedUserHeal.ts:24 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 1100 | POST | /api/outbound-email/compose | server/routes/outboundEmail.ts:168 | authenticated | isAuthenticated, writeLimiter | authenticated, ai_rate_limited |
| 1101 | GET | /api/outbound-email/log | server/routes/outboundEmail.ts:210 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1102 | GET | /api/outbound-email/batches/:batchId | server/routes/outboundEmail.ts:218 | authenticated | isAuthenticated | authenticated |
| 1103 | GET | /api/outbound-email/counters | server/routes/outboundEmail.ts:233 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1104 | GET | /api/outbound-email/suppressions | server/routes/outboundEmail.ts:250 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1105 | POST | /api/outbound-email/suppressions | server/routes/outboundEmail.ts:259 | requireTeamLead | isAuthenticated, requireTeamLead, writeLimiter | authenticated, ai_rate_limited |
| 1106 | DELETE | /api/outbound-email/suppressions/:id | server/routes/outboundEmail.ts:283 | requireTeamLead | isAuthenticated, requireTeamLead, writeLimiter | authenticated, ai_rate_limited |
| 1107 | GET | /api/outbound-email/identities | server/routes/outboundEmail.ts:296 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1108 | GET | /api/outbound-email/front-channels | server/routes/outboundEmail.ts:301 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1109 | PUT | /api/outbound-email/identities/:userId | server/routes/outboundEmail.ts:321 | requireTeamLead | isAuthenticated, requireTeamLead, writeLimiter | authenticated, ai_rate_limited |
| 1110 | GET | /api/outbound-email/settings | server/routes/outboundEmail.ts:347 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1111 | PUT | /api/outbound-email/settings | server/routes/outboundEmail.ts:370 | requireCeo | isAuthenticated, requireCeo, writeLimiter | authenticated, admin_only, ai_rate_limited |
| 1112 | POST | /api/outbound-email/pause | server/routes/outboundEmail.ts:403 | requireTeamLead | isAuthenticated, requireTeamLead, writeLimiter | authenticated, ai_rate_limited |
| 1113 | POST | /api/outbound-email/verify-domain | server/routes/outboundEmail.ts:417 | requireCeo | isAuthenticated, requireCeo, writeLimiter | authenticated, admin_only, ai_rate_limited |
| 1114 | POST | /api/outbound-email/fallback-enabled | server/routes/outboundEmail.ts:432 | requireCeo | isAuthenticated, requireCeo, writeLimiter | authenticated, admin_only, ai_rate_limited |
| 1115 | GET | /api/email/unsubscribe | server/routes/outboundEmail.ts:455 | public | none | public |
| 1116 | POST | /api/email/unsubscribe | server/routes/outboundEmail.ts:475 | public | none | public |
| 1117 | POST | /api/webhooks/sendgrid-events | server/routes/outboundEmail.ts:506 | public | none | public, webhook |
| 1118 | GET | /api/admin/db-attribution/trends | server/routes/poolAuditTrends.ts:48 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 1119 | GET | /api/admin/prod-actions | server/routes/prodActions.ts:53 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1120 | GET | /api/admin/prod-actions/runs | server/routes/prodActions.ts:70 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1121 | POST | /api/admin/prod-actions/failure-alert-threshold | server/routes/prodActions.ts:108 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1122 | POST | /api/admin/prod-actions/apply | server/routes/prodActions.ts:140 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1123 | POST | /api/admin/prod-actions/:actionId/apply | server/routes/prodActions.ts:168 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1124 | GET | /api/admin/queue-control | server/routes/queueControl.ts:32 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 1125 | POST | /api/admin/queue-control/:queueName/pause | server/routes/queueControl.ts:48 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 1126 | POST | /api/admin/queue-control/:queueName/resume | server/routes/queueControl.ts:74 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 1127 | POST | /api/admin/queue-control/:queueName/rate-limit | server/routes/queueControl.ts:92 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 1128 | GET | /api/admin/queue-control/backlog-alerts | server/routes/queueControl.ts:128 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 1129 | POST | /api/admin/queue-control/backlog-alerts/config | server/routes/queueControl.ts:187 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 1130 | POST | /api/admin/queue-control/backlog-alerts/test | server/routes/queueControl.ts:272 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 1131 | GET | /api/admin/queue-control/starvation-alerts | server/routes/queueControl.ts:367 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 1132 | POST | /api/admin/queue-control/starvation-alerts/config | server/routes/queueControl.ts:433 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 1133 | GET | /api/admin/queue-control/retroactive-reprocess/pending-by-client | server/routes/queueControl.ts:540 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 1134 | GET | /api/admin/queue-control/history | server/routes/queueControl.ts:577 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 1135 | POST | /api/admin/queue-control/:queueName/cancel-pending | server/routes/queueControl.ts:622 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 1136 | GET | /api/health/rate-limits | server/routes/rateLimitAdmin.ts:69 | authenticated | isAuthenticated | authenticated |
| 1137 | POST | /api/health/rate-limits/reset | server/routes/rateLimitAdmin.ts:105 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1138 | GET | /api/health/rate-limits/suggestions | server/routes/rateLimitAdmin.ts:110 | authenticated | isAuthenticated | authenticated |
| 1139 | POST | /api/health/rate-limits/apply-suggestion | server/routes/rateLimitAdmin.ts:120 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1140 | GET | /api/health/rate-limits/auto-tune | server/routes/rateLimitAdmin.ts:134 | authenticated | isAuthenticated | authenticated |
| 1141 | PUT | /api/health/rate-limits/auto-tune | server/routes/rateLimitAdmin.ts:138 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1142 | POST | /api/health/rate-limits/auto-tune/run | server/routes/rateLimitAdmin.ts:147 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1143 | GET | /api/health/rate-limits/adjustments | server/routes/rateLimitAdmin.ts:157 | authenticated | isAuthenticated | authenticated |
| 1144 | GET | /api/health/rate-limits/by-user | server/routes/rateLimitAdmin.ts:161 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1145 | GET | /api/health/rate-limits/events | server/routes/rateLimitAdmin.ts:172 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1146 | GET | /api/health/rate-limits/events.csv | server/routes/rateLimitAdmin.ts:236 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1147 | GET | /api/health/rate-limits/by-user/:userId/timeseries | server/routes/rateLimitAdmin.ts:243 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1148 | GET | /api/health/rate-limits/by-user/:userId/events.csv | server/routes/rateLimitAdmin.ts:270 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1149 | GET | /api/health/rate-limits/by-ip/:ip/timeseries | server/routes/rateLimitAdmin.ts:277 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1150 | GET | /api/health/rate-limits/thresholds | server/routes/rateLimitAdmin.ts:304 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1151 | PUT | /api/health/rate-limits/thresholds | server/routes/rateLimitAdmin.ts:318 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1152 | DELETE | /api/health/rate-limits/thresholds | server/routes/rateLimitAdmin.ts:369 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1153 | DELETE | /api/health/rate-limits/thresholds/:category | server/routes/rateLimitAdmin.ts:424 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1154 | GET | /api/health/rate-limits/thresholds/history | server/routes/rateLimitAdmin.ts:458 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1155 | GET | /api/health/rate-limits/warning-percents | server/routes/rateLimitAdmin.ts:477 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1156 | PUT | /api/health/rate-limits/warning-percents | server/routes/rateLimitAdmin.ts:491 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1157 | GET | /api/health/rate-limits/warning-percents/history | server/routes/rateLimitAdmin.ts:541 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1158 | GET | /api/admin/rate-limit-multipliers | server/routes/rateLimitMultipliers.ts:35 | authenticated | isAuthenticated | authenticated, admin_only |
| 1159 | PUT | /api/admin/rate-limit-multipliers | server/routes/rateLimitMultipliers.ts:63 | authenticated | isAuthenticated | authenticated, admin_only |
| 1160 | POST | /api/admin/rate-limit-multipliers/reset | server/routes/rateLimitMultipliers.ts:130 | authenticated | isAuthenticated | authenticated, admin_only |
| 1161 | GET | /api/admin/rate-limit-multipliers/history | server/routes/rateLimitMultipliers.ts:183 | authenticated | isAuthenticated | authenticated, admin_only |
| 1162 | GET | /api/admin/route-limiters | server/routes/rateLimitMultipliers.ts:240 | authenticated | isAuthenticated | authenticated, admin_only |
| 1163 | GET | /api/health/blocked-ips | server/routes/rateLimitMultipliers.ts:317 | authenticated | isAuthenticated | authenticated |
| 1164 | GET | /api/health/rate-limits/default-block-duration | server/routes/rateLimitMultipliers.ts:365 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1165 | PUT | /api/health/rate-limits/default-block-duration | server/routes/rateLimitMultipliers.ts:377 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1166 | GET | /api/health/rate-limits/alerts | server/routes/rateLimitNotifications.ts:21 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1167 | POST | /api/health/rate-limits/alerts/clear | server/routes/rateLimitNotifications.ts:25 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1168 | GET | /api/health/rate-limits/notifications.csv | server/routes/rateLimitNotifications.ts:34 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1169 | GET | /api/health/rate-limits/notifications | server/routes/rateLimitNotifications.ts:170 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1170 | GET | /api/health/rate-limits/notify-config | server/routes/rateLimitNotifications.ts:287 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1171 | PUT | /api/health/rate-limits/notify-config | server/routes/rateLimitNotifications.ts:318 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1172 | GET | /api/health/rate-limits/notify-config/history | server/routes/rateLimitNotifications.ts:351 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1173 | POST | /api/health/rate-limits/notify-config/history/:id/resend | server/routes/rateLimitNotifications.ts:393 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1174 | GET | /api/health/rate-limits/digest-status | server/routes/rateLimitNotifications.ts:435 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1175 | POST | /api/health/rate-limits/digest-flush | server/routes/rateLimitNotifications.ts:445 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1176 | GET | /api/health/rate-limits/notifications/:id/chain | server/routes/rateLimitNotifications.ts:460 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1177 | POST | /api/health/rate-limits/notifications/:id/retry | server/routes/rateLimitNotifications.ts:500 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1178 | POST | /api/health/rate-limits/notifications/bulk-retry | server/routes/rateLimitNotifications.ts:528 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1179 | GET | /api/health/rate-limits/auto-retry-config | server/routes/rateLimitNotifications.ts:571 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1180 | PUT | /api/health/rate-limits/auto-retry-config | server/routes/rateLimitNotifications.ts:585 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1181 | POST | /api/health/rate-limits/auto-retry-run | server/routes/rateLimitNotifications.ts:610 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1182 | GET | /api/health/rate-limits/digest-growth | server/routes/rateLimitNotifications.ts:628 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1183 | GET | /api/health/rate-limits/digest-growth/history | server/routes/rateLimitNotifications.ts:644 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1184 | PUT | /api/health/rate-limits/digest-growth | server/routes/rateLimitNotifications.ts:658 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1185 | GET | /api/health/rate-limits/max-attempts-warning | server/routes/rateLimitNotifications.ts:685 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1186 | PUT | /api/health/rate-limits/max-attempts-warning | server/routes/rateLimitNotifications.ts:704 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1187 | GET | /api/health/rate-limits/last-test-alert | server/routes/rateLimitNotifications.ts:734 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1188 | POST | /api/health/rate-limits/test-alert | server/routes/rateLimitNotifications.ts:748 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1189 | GET | /api/health/rate-limits/notification-retention | server/routes/rateLimitRetention.ts:21 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1190 | PUT | /api/health/rate-limits/notification-retention | server/routes/rateLimitRetention.ts:103 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1191 | POST | /api/health/rate-limits/notification-retention/prune | server/routes/rateLimitRetention.ts:175 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1192 | GET | /api/health/rate-limits/notification-retention/history | server/routes/rateLimitRetention.ts:237 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1193 | GET | /api/health/rate-limits/pending-digest-retention | server/routes/rateLimitRetention.ts:300 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1194 | PUT | /api/health/rate-limits/pending-digest-retention | server/routes/rateLimitRetention.ts:381 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1195 | GET | /api/health/rate-limits/pending-digest-retention/history | server/routes/rateLimitRetention.ts:452 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1196 | POST | /api/health/rate-limits/pending-digest-retention/prune | server/routes/rateLimitRetention.ts:496 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1197 | GET | /api/all-report-sections | server/routes/reports.ts:284 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1198 | GET | /api/ceo-pulses | server/routes/reports.ts:322 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1199 | GET | /api/ceo-pulses/:id | server/routes/reports.ts:332 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1200 | GET | /api/ceo-pulses/month/:monthKey | server/routes/reports.ts:345 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1201 | POST | /api/ceo-pulses | server/routes/reports.ts:356 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1202 | PATCH | /api/ceo-pulses/:id | server/routes/reports.ts:378 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1203 | POST | /api/ceo-pulses/:id/analyze | server/routes/reports.ts:574 | requireCeo | isAuthenticated, requireCeo, aiLimiter | authenticated, admin_only, ai_rate_limited |
| 1204 | POST | /api/ceo-pulses/:id/refine | server/routes/reports.ts:897 | requireCeo | isAuthenticated, requireCeo, aiLimiter | authenticated, admin_only, ai_rate_limited |
| 1205 | POST | /api/ceo-pulses/:id/images | server/routes/reports.ts:1293 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1206 | PATCH | /api/ceo-pulses/:id/images | server/routes/reports.ts:1364 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1207 | DELETE | /api/ceo-pulses/:id/images/:slot | server/routes/reports.ts:1412 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1208 | POST | /api/ceo-pulses/:id/share | server/routes/reports.ts:1445 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1209 | POST | /api/ceo-pulses/:id/regenerate-charts | server/routes/reports.ts:1463 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1210 | GET | /api/ceo-pulse/share/:token | server/routes/reports.ts:1484 | public | none | public |
| 1211 | GET | /api/ceo-pulse-charts/:monthKey/chart-:index.png | server/routes/reports.ts:1531 | public | none | public |
| 1212 | GET | /api/ceo-pulse-charts/:monthKey/image-:slot | server/routes/reports.ts:1567 | public | none | public |
| 1213 | GET | /api/reports | server/routes/reports.ts:1623 | authenticated | isAuthenticated | authenticated |
| 1214 | GET | /api/reports/matrix | server/routes/reports.ts:1645 | authenticated | isAuthenticated | authenticated |
| 1215 | GET | /api/reports/:id | server/routes/reports.ts:1758 | authenticated | isAuthenticated | authenticated |
| 1216 | POST | /api/ai/format-issues | server/routes/reports.ts:1847 | authenticated | isAuthenticated, aiLimiter | authenticated, ai_rate_limited |
| 1217 | POST | /api/reports/import-pdf | server/routes/reports.ts:1911 | requireAccountManager | isAuthenticated, requireAccountManager, upload.single | authenticated, upload |
| 1218 | POST | /api/webhooks/report-import | server/routes/reports.ts:1983 | public | upload.single | public, webhook, upload |
| 1219 | GET | /api/webhook-import-logs | server/routes/reports.ts:3012 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only, webhook |
| 1220 | GET | /api/webhook-import-logs/:id/extracted-text | server/routes/reports.ts:3044 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only, webhook |
| 1221 | POST | /api/reports/:id/reimport | server/routes/reports.ts:3059 | requireAccountManager | isAuthenticated, requireAccountManager, upload.single | authenticated, upload |
| 1222 | POST | /api/reports | server/routes/reports.ts:3611 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 1223 | PATCH | /api/reports/:id | server/routes/reports.ts:3678 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 1224 | DELETE | /api/reports/:id | server/routes/reports.ts:3961 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1225 | POST | /api/reports/:id/duplicate | server/routes/reports.ts:3977 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 1226 | GET | /api/reports/:id/sections | server/routes/reports.ts:4074 | authenticated | isAuthenticated | authenticated |
| 1227 | PUT | /api/reports/:id/sections/:sectionKey | server/routes/reports.ts:4093 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 1228 | GET | /api/reports/:id/sections/:sectionKey/history | server/routes/reports.ts:4500 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1229 | POST | /api/reports/:id/verdicts/draft | server/routes/reports.ts:4531 | requireAccountManager | isAuthenticated, requireAccountManager, aiLimiter | authenticated, ai_rate_limited |
| 1230 | GET | /api/share/:token | server/routes/reports.ts:5270 | public | none | public |
| 1231 | GET | /api/preview/:reportId | server/routes/reports.ts:5297 | authenticated | isAuthenticated | authenticated |
| 1232 | GET | /api/admin/demo-report-setting | server/routes/reports.ts:5325 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1233 | POST | /api/admin/demo-report-setting | server/routes/reports.ts:5338 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1234 | GET | /api/demo-report | server/routes/reports.ts:5418 | public | none | public |
| 1235 | POST | /api/webhooks/rev-ai | server/routes/revAiWebhook.ts:42 | public | none | public, webhook |
| 1236 | GET | /api/ris/checks | server/routes/ris.ts:59 | authenticated | isAuthenticated | authenticated |
| 1237 | POST | /api/ris/checks | server/routes/ris.ts:76 | authenticated | isAuthenticated | authenticated |
| 1238 | PATCH | /api/ris/checks/:id | server/routes/ris.ts:99 | authenticated | isAuthenticated | authenticated |
| 1239 | POST | /api/ris/checks/reorder | server/routes/ris.ts:119 | authenticated | isAuthenticated | authenticated |
| 1240 | GET | /api/ris/portfolio | server/routes/ris.ts:139 | authenticated | isAuthenticated | authenticated |
| 1241 | GET | /api/ris/clients/:clientId | server/routes/ris.ts:157 | authenticated | isAuthenticated | authenticated |
| 1242 | GET | /api/ris/performance/portfolio | server/routes/ris.ts:184 | authenticated | isAuthenticated | authenticated |
| 1243 | GET | /api/ris/performance/clients/:clientId | server/routes/ris.ts:205 | authenticated | isAuthenticated | authenticated |
| 1244 | POST | /api/ris/clients/:clientId/results | server/routes/ris.ts:227 | authenticated | isAuthenticated | authenticated |
| 1245 | POST | /api/ris/refresh | server/routes/ris.ts:304 | authenticated | isAuthenticated | authenticated |
| 1246 | POST | /api/ris/results/:id/confirm | server/routes/ris.ts:331 | authenticated | isAuthenticated | authenticated |
| 1247 | GET | /api/ris/auto-mappings | server/routes/ris.ts:355 | authenticated | isAuthenticated | authenticated |
| 1248 | PUT | /api/ris/auto-mappings/:autoSource | server/routes/ris.ts:383 | authenticated | isAuthenticated | authenticated |
| 1249 | GET | /api/ris/client-bindings/:clientId | server/routes/ris.ts:420 | authenticated | isAuthenticated | authenticated |
| 1250 | PUT | /api/ris/client-bindings/:clientId/bigquery-key | server/routes/ris.ts:453 | authenticated | isAuthenticated | authenticated |
| 1251 | PUT | /api/ris/client-bindings/:clientId/overrides/:autoSource | server/routes/ris.ts:490 | authenticated | isAuthenticated | authenticated |
| 1252 | DELETE | /api/ris/client-bindings/:clientId/overrides/:autoSource | server/routes/ris.ts:525 | authenticated | isAuthenticated | authenticated |
| 1253 | GET | /api/public/roadmap | server/routes/roadmap.ts:197 | public | none | public |
| 1254 | GET | /api/roadmap/admin | server/routes/roadmap.ts:259 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1255 | POST | /api/roadmap/initiatives | server/routes/roadmap.ts:324 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1256 | PATCH | /api/roadmap/initiatives/:id | server/routes/roadmap.ts:379 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1257 | DELETE | /api/roadmap/initiatives/:id | server/routes/roadmap.ts:443 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1258 | POST | /api/roadmap/initiatives/reorder | server/routes/roadmap.ts:467 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1259 | POST | /api/roadmap/${kind} | server/routes/roadmap.ts:504 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1260 | PATCH | /api/roadmap/${kind}/:id | server/routes/roadmap.ts:534 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1261 | DELETE | /api/roadmap/${kind}/:id | server/routes/roadmap.ts:560 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1262 | GET | /api/clients/:clientId/save-plays | server/routes/savePlays.ts:94 | authenticated | isAuthenticated | authenticated |
| 1263 | GET | /api/clients/:clientId/save-plays/:playId | server/routes/savePlays.ts:108 | authenticated | isAuthenticated | authenticated |
| 1264 | POST | /api/clients/:clientId/save-plays | server/routes/savePlays.ts:123 | authenticated | isAuthenticated | authenticated |
| 1265 | PATCH | /api/clients/:clientId/save-plays/:playId | server/routes/savePlays.ts:161 | authenticated | isAuthenticated | authenticated |
| 1266 | DELETE | /api/clients/:clientId/save-plays/:playId | server/routes/savePlays.ts:205 | authenticated | isAuthenticated | authenticated |
| 1267 | GET | /api/churn/save-plays | server/routes/savePlays.ts:222 | authenticated | isAuthenticated | authenticated |
| 1268 | GET | /api/scoring/:entityType/config | server/routes/scoring.ts:79 | authenticated | isAuthenticated | authenticated |
| 1269 | PUT | /api/scoring/:entityType/config | server/routes/scoring.ts:118 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1270 | POST | /api/scoring/:entityType/rules | server/routes/scoring.ts:158 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1271 | PATCH | /api/scoring/rules/:id | server/routes/scoring.ts:212 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1272 | DELETE | /api/scoring/rules/:id | server/routes/scoring.ts:279 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1273 | POST | /api/scoring/:entityType/recompute | server/routes/scoring.ts:320 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1274 | POST | /api/scoring/preview | server/routes/scoring.ts:340 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1275 | GET | /api/admin/semrush/cadence | server/routes/semrushCadence.ts:30 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 1276 | POST | /api/admin/semrush/cadence/reset-cache | server/routes/semrushCadence.ts:202 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 1277 | POST | /api/service-desk/setup/import-departments | server/routes/serviceDesk/clickupImports.ts:30 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1278 | POST | /api/service-desk/setup/import-request-types | server/routes/serviceDesk/clickupImports.ts:198 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1279 | POST | /api/service-desk/setup/refresh-option-names | server/routes/serviceDesk/clickupImports.ts:382 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1280 | GET | /api/service-desk/config | server/routes/serviceDesk/configSetup.ts:22 | authenticated | isAuthenticated | authenticated |
| 1281 | PUT | /api/service-desk/config | server/routes/serviceDesk/configSetup.ts:31 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1282 | POST | /api/service-desk/setup/create-structure | server/routes/serviceDesk/configSetup.ts:121 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1283 | POST | /api/service-desk/setup/autofill-fields | server/routes/serviceDesk/configSetup.ts:215 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1284 | GET | /api/service-desk/setup/verify | server/routes/serviceDesk/configSetup.ts:309 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1285 | GET | /api/service-desk/client-options | server/routes/serviceDesk/departments.ts:217 | authenticated | isAuthenticated | authenticated |
| 1286 | GET | /api/service-desk/client-team-options | server/routes/serviceDesk/departments.ts:274 | authenticated | isAuthenticated | authenticated |
| 1287 | GET | /api/service-desk/departments | server/routes/serviceDesk/departments.ts:333 | authenticated | isAuthenticated | authenticated |
| 1288 | POST | /api/service-desk/departments | server/routes/serviceDesk/departments.ts:382 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1289 | PUT | /api/service-desk/departments/:id | server/routes/serviceDesk/departments.ts:418 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1290 | PUT | /api/service-desk/departments/:id/role-defaults | server/routes/serviceDesk/departments.ts:467 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1291 | GET | /api/service-desk/departments/:id/delete-impact | server/routes/serviceDesk/departments.ts:544 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1292 | DELETE | /api/service-desk/departments/:id | server/routes/serviceDesk/departments.ts:571 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1293 | GET | /api/service-desk/departments/:id/members | server/routes/serviceDesk/departments.ts:773 | authenticated | isAuthenticated | authenticated |
| 1294 | POST | /api/service-desk/departments/:id/members | server/routes/serviceDesk/departments.ts:794 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1295 | PUT | /api/service-desk/departments/:id/members/:memberId | server/routes/serviceDesk/departments.ts:845 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1296 | DELETE | /api/service-desk/departments/:id/members/:memberId | server/routes/serviceDesk/departments.ts:887 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1297 | GET | /api/service-desk/clients/:clientId/assignments | server/routes/serviceDesk/departments.ts:925 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1298 | PUT | /api/service-desk/clients/:clientId/assignments/:departmentId | server/routes/serviceDesk/departments.ts:980 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1299 | GET | /api/service-desk/coverage | server/routes/serviceDesk/departments.ts:1028 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1300 | POST | /api/service-desk/assignments/bulk | server/routes/serviceDesk/departments.ts:1046 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1301 | GET | /api/admin/role-assignments | server/routes/serviceDesk/departments.ts:1121 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 1302 | GET | /api/admin/role-assignments/clients/:clientId | server/routes/serviceDesk/departments.ts:1134 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 1303 | PUT | /api/admin/role-assignments/clients/:clientId/departments/:departmentId | server/routes/serviceDesk/departments.ts:1190 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 1304 | PUT | /api/admin/role-assignments/departments/:id | server/routes/serviceDesk/departments.ts:1234 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 1305 | POST | /api/admin/role-assignments/bulk | server/routes/serviceDesk/departments.ts:1289 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 1306 | GET | /api/admin/role-assignments/departments/:id/members | server/routes/serviceDesk/departments.ts:1353 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 1307 | POST | /api/admin/role-assignments/departments/:id/members | server/routes/serviceDesk/departments.ts:1374 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 1308 | DELETE | /api/admin/role-assignments/departments/:id/members/:memberId | server/routes/serviceDesk/departments.ts:1421 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 1309 | GET | /api/service-desk/role-projections/configuration | server/routes/serviceDesk/departments.ts:1463 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1310 | PUT | /api/service-desk/role-projections/destinations | server/routes/serviceDesk/departments.ts:1484 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1311 | GET | /api/service-desk/role-projections/client-list/configuration | server/routes/serviceDesk/departments.ts:1656 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1312 | GET | /api/service-desk/role-projections/client-list/preflight | server/routes/serviceDesk/departments.ts:1677 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1313 | PUT | /api/service-desk/role-projections/client-list/mappings | server/routes/serviceDesk/departments.ts:1705 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1314 | PUT | /api/service-desk/role-projections/targets | server/routes/serviceDesk/departments.ts:1749 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1315 | GET | /api/service-desk/role-projections/status | server/routes/serviceDesk/departments.ts:1778 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1316 | POST | /api/service-desk/role-projections/resync | server/routes/serviceDesk/departments.ts:1831 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1317 | GET | /api/service-desk/client-mirror/status | server/routes/serviceDesk/departments.ts:1868 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1318 | POST | /api/service-desk/client-mirror/:commandId/retry | server/routes/serviceDesk/departments.ts:1908 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1319 | GET | /api/service-desk/reports | server/routes/serviceDesk/reports.ts:351 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1320 | GET | /api/service-desk/reports/export | server/routes/serviceDesk/reports.ts:392 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1321 | GET | /api/service-desk/tickets/:taskId/allowed-transitions | server/routes/serviceDesk/reports.ts:482 | authenticated | isAuthenticated | authenticated |
| 1322 | GET | /api/service-desk/request-types | server/routes/serviceDesk/requestTypes.ts:25 | authenticated | isAuthenticated | authenticated |
| 1323 | POST | /api/service-desk/request-types | server/routes/serviceDesk/requestTypes.ts:50 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1324 | PUT | /api/service-desk/request-types/:id | server/routes/serviceDesk/requestTypes.ts:77 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1325 | DELETE | /api/service-desk/request-types/:id | server/routes/serviceDesk/requestTypes.ts:104 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1326 | POST | /api/service-desk/request-types/auto-match-departments | server/routes/serviceDesk/requestTypes.ts:140 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1327 | GET | /api/service-desk/setup/options | server/routes/serviceDesk/requestTypes.ts:233 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1328 | POST | /api/service-desk/setup/sync-client-options | server/routes/serviceDesk/requestTypes.ts:298 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1329 | POST | /api/service-desk/setup/accept-client-suggestions | server/routes/serviceDesk/requestTypes.ts:528 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1330 | GET | /api/service-desk/request-types/:id/questions | server/routes/serviceDesk/templates.ts:41 | authenticated | isAuthenticated | authenticated |
| 1331 | POST | /api/service-desk/request-types/:id/questions | server/routes/serviceDesk/templates.ts:58 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1332 | PUT | /api/service-desk/request-types/:id/questions/:qid | server/routes/serviceDesk/templates.ts:98 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1333 | DELETE | /api/service-desk/request-types/:id/questions/:qid | server/routes/serviceDesk/templates.ts:138 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1334 | GET | /api/service-desk/request-types/:id/checklist-steps | server/routes/serviceDesk/templates.ts:153 | authenticated | isAuthenticated | authenticated |
| 1335 | POST | /api/service-desk/request-types/:id/checklist-steps | server/routes/serviceDesk/templates.ts:170 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1336 | PUT | /api/service-desk/request-types/:id/checklist-steps/:sid | server/routes/serviceDesk/templates.ts:203 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1337 | DELETE | /api/service-desk/request-types/:id/checklist-steps/:sid | server/routes/serviceDesk/templates.ts:242 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1338 | POST | /api/service-desk/tickets/submit | server/routes/serviceDesk/templates.ts:261 | authenticated | isAuthenticated | authenticated |
| 1339 | POST | /api/service-desk/tickets/:taskId/transition | server/routes/serviceDesk/ticketActions.ts:33 | authenticated | isAuthenticated | authenticated |
| 1340 | POST | /api/service-desk/tickets/:taskId/reassign | server/routes/serviceDesk/ticketActions.ts:214 | authenticated | isAuthenticated | authenticated |
| 1341 | POST | /api/service-desk/tickets/:taskId/change-department | server/routes/serviceDesk/ticketActions.ts:341 | authenticated | isAuthenticated | authenticated |
| 1342 | POST | /api/service-desk/tickets/:taskId/committed-date | server/routes/serviceDesk/ticketActions.ts:456 | authenticated | isAuthenticated | authenticated |
| 1343 | POST | /api/service-desk/tickets/:taskId/confirm-complete | server/routes/serviceDesk/ticketActions.ts:553 | authenticated | isAuthenticated | authenticated |
| 1344 | POST | /api/service-desk/tickets/:taskId/reopen | server/routes/serviceDesk/ticketActions.ts:607 | authenticated | isAuthenticated | authenticated |
| 1345 | POST | /api/service-desk/tickets/:taskId/mark-duplicate | server/routes/serviceDesk/ticketActions.ts:669 | authenticated | isAuthenticated | authenticated |
| 1346 | GET | /api/service-desk/eligible-assignees | server/routes/serviceDesk/ticketsRead.ts:23 | authenticated | isAuthenticated | authenticated |
| 1347 | GET | /api/service-desk/eligibility/:departmentId | server/routes/serviceDesk/ticketsRead.ts:67 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1348 | GET | /api/service-desk/tickets/needs-mapping | server/routes/serviceDesk/ticketsRead.ts:93 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1349 | GET | /api/service-desk/views/counts | server/routes/serviceDesk/ticketsRead.ts:127 | authenticated | isAuthenticated | authenticated |
| 1350 | GET | /api/service-desk/tickets | server/routes/serviceDesk/ticketsRead.ts:154 | authenticated | isAuthenticated | authenticated |
| 1351 | GET | /api/service-desk/tickets/:taskId | server/routes/serviceDesk/ticketsRead.ts:178 | authenticated | isAuthenticated | authenticated |
| 1352 | POST | /api/service-desk/tickets/:taskId/mapping | server/routes/serviceDesk/ticketsRead.ts:193 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1353 | POST | /api/service-desk/tickets/:taskId/rerun-mapping | server/routes/serviceDesk/ticketsRead.ts:238 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1354 | POST | /api/service-desk/tickets/:taskId/dismiss-mapping | server/routes/serviceDesk/ticketsRead.ts:277 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1355 | GET | /api/service-desk/tickets/:taskId/events | server/routes/serviceDesk/ticketsRead.ts:319 | authenticated | isAuthenticated | authenticated |
| 1356 | GET | /api/monthly-review-stats | server/routes/settings.ts:19 | authenticated | isAuthenticated | authenticated |
| 1357 | POST | /api/monthly-review-notifications | server/routes/settings.ts:55 | authenticated | isAuthenticated | authenticated |
| 1358 | GET | /api/users | server/routes/settings.ts:115 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1359 | GET | /api/users/paged | server/routes/settings.ts:139 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1360 | POST | /api/users | server/routes/settings.ts:169 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1361 | PATCH | /api/users/:id/role | server/routes/settings.ts:228 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1362 | GET | /api/users/:id/delete-impact | server/routes/settings.ts:313 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1363 | POST | /api/users/:id/reassign | server/routes/settings.ts:336 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1364 | DELETE | /api/users/:id | server/routes/settings.ts:419 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1365 | GET | /api/users/deleted | server/routes/settings.ts:484 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1366 | GET | /api/users/delete-history | server/routes/settings.ts:498 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1367 | GET | /api/users/reassign-history | server/routes/settings.ts:525 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1368 | POST | /api/users/:id/restore | server/routes/settings.ts:561 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1369 | PATCH | /api/users/:id/email | server/routes/settings.ts:652 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1370 | GET | /api/users/restored-email-cleanup/preview | server/routes/settings.ts:740 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1371 | POST | /api/users/restored-email-cleanup/run | server/routes/settings.ts:772 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1372 | GET | /api/users/restored-email-cleanup/status | server/routes/settings.ts:857 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1373 | GET | /api/admin/role-permissions/status | server/routes/settings.ts:899 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 1374 | GET | /api/admin/role-backfill-banner | server/routes/settings.ts:916 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 1375 | POST | /api/admin/role-backfill-banner/dismiss | server/routes/settings.ts:924 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1376 | GET | /api/trends | server/routes/settings.ts:941 | authenticated | isAuthenticated | authenticated |
| 1377 | POST | /api/trends/practice-areas | server/routes/settings.ts:978 | authenticated | isAuthenticated | authenticated |
| 1378 | GET | /api/trends/practice-areas/list | server/routes/settings.ts:1016 | authenticated | isAuthenticated | authenticated |
| 1379 | GET | /api/admin/practice-area-settings | server/routes/settings.ts:1025 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1380 | POST | /api/admin/practice-area-settings | server/routes/settings.ts:1070 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1381 | DELETE | /api/admin/practice-area-settings/:id | server/routes/settings.ts:1102 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1382 | GET | /api/phase-settings | server/routes/settings.ts:1143 | public | none | public |
| 1383 | PUT | /api/admin/phase-settings | server/routes/settings.ts:1164 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1384 | GET | /api/sheets/folders | server/routes/sheets.ts:98 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 1385 | POST | /api/sheets/folders | server/routes/sheets.ts:114 | requireAccountManager | isAuthenticated, requireAccountManager, writeLimiter | authenticated, ai_rate_limited |
| 1386 | PATCH | /api/sheets/folders/:id | server/routes/sheets.ts:138 | requireAccountManager | isAuthenticated, requireAccountManager, writeLimiter | authenticated, ai_rate_limited |
| 1387 | DELETE | /api/sheets/folders/:id | server/routes/sheets.ts:166 | requireAccountManager | isAuthenticated, requireAccountManager, writeLimiter | authenticated, ai_rate_limited |
| 1388 | GET | /api/sheets/workbooks | server/routes/sheets.ts:215 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 1389 | GET | /api/sheets/workbooks/last-activity | server/routes/sheets.ts:257 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 1390 | GET | /api/sheets/workbooks/:id | server/routes/sheets.ts:281 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 1391 | POST | /api/sheets/workbooks | server/routes/sheets.ts:306 | requireAccountManager | isAuthenticated, requireAccountManager, writeLimiter | authenticated, ai_rate_limited |
| 1392 | PATCH | /api/sheets/workbooks/:id | server/routes/sheets.ts:353 | requireAccountManager | isAuthenticated, requireAccountManager, sheetsAutosaveLimiter | authenticated, ai_rate_limited |
| 1393 | DELETE | /api/sheets/workbooks/:id | server/routes/sheets.ts:471 | requireAccountManager | isAuthenticated, requireAccountManager, writeLimiter | authenticated, ai_rate_limited |
| 1394 | POST | /api/sheets/workbooks/:id/lock | server/routes/sheets.ts:511 | requireAccountManager | isAuthenticated, requireAccountManager, writeLimiter | authenticated, ai_rate_limited |
| 1395 | POST | /api/sheets/workbooks/:id/lock/heartbeat | server/routes/sheets.ts:551 | requireAccountManager | isAuthenticated, requireAccountManager, writeLimiter | authenticated, ai_rate_limited |
| 1396 | DELETE | /api/sheets/workbooks/:id/lock | server/routes/sheets.ts:584 | requireAccountManager | isAuthenticated, requireAccountManager, writeLimiter | authenticated, ai_rate_limited |
| 1397 | GET | /api/sheets/workbooks/:id/lock | server/routes/sheets.ts:629 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 1398 | GET | /api/sheets/workbooks/:id/permissions | server/routes/sheets.ts:667 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 1399 | PUT | /api/sheets/workbooks/:id/permissions | server/routes/sheets.ts:690 | requireAccountManager | isAuthenticated, requireAccountManager, writeLimiter | authenticated, ai_rate_limited |
| 1400 | DELETE | /api/sheets/workbooks/:id/permissions/:userId | server/routes/sheets.ts:735 | requireAccountManager | isAuthenticated, requireAccountManager, writeLimiter | authenticated, ai_rate_limited |
| 1401 | POST | /api/sheets/workbooks/import | server/routes/sheets.ts:789 | requireAccountManager | isAuthenticated, requireAccountManager, uploadLimiter | authenticated, ai_rate_limited |
| 1402 | GET | /api/sheets/workbooks/:id/export/xlsx | server/routes/sheets.ts:897 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 1403 | GET | /api/sheets/workbooks/:id/sheets/:sheetId/export/csv | server/routes/sheets.ts:951 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 1404 | GET | /api/sheets/connectors | server/routes/sheets.ts:999 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 1405 | GET | /api/sheets/workbooks/:id/versions | server/routes/sheets.ts:1028 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 1406 | GET | /api/sheets/workbooks/:id/versions/:versionId | server/routes/sheets.ts:1049 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 1407 | POST | /api/sheets/workbooks/:id/versions | server/routes/sheets.ts:1074 | requireAccountManager | isAuthenticated, requireAccountManager, writeLimiter | authenticated, ai_rate_limited |
| 1408 | POST | /api/sheets/workbooks/:id/versions/:versionId/restore | server/routes/sheets.ts:1122 | requireAccountManager | isAuthenticated, requireAccountManager, writeLimiter | authenticated, ai_rate_limited |
| 1409 | GET | /api/sheets/workbooks/:id/activity | server/routes/sheets.ts:1164 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 1410 | GET | /api/sheets/workbooks/:id/blocks | server/routes/sheets.ts:1189 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 1411 | GET | /api/sheets/workbooks/:id/role-grants | server/routes/sheets.ts:1216 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 1412 | POST | /api/sheets/workbooks/:id/blocks | server/routes/sheets.ts:1239 | requireAccountManager | isAuthenticated, requireAccountManager, writeLimiter | authenticated, ai_rate_limited |
| 1413 | PUT | /api/sheets/workbooks/:id/role-grants | server/routes/sheets.ts:1279 | requireAccountManager | isAuthenticated, requireAccountManager, writeLimiter | authenticated, ai_rate_limited |
| 1414 | PATCH | /api/sheets/workbooks/:wId/blocks/:bId | server/routes/sheets.ts:1314 | requireAccountManager | isAuthenticated, requireAccountManager, writeLimiter | authenticated, ai_rate_limited |
| 1415 | DELETE | /api/sheets/workbooks/:wId/blocks/:bId | server/routes/sheets.ts:1347 | requireAccountManager | isAuthenticated, requireAccountManager, writeLimiter | authenticated, ai_rate_limited |
| 1416 | DELETE | /api/sheets/workbooks/:id/role-grants/:role | server/routes/sheets.ts:1373 | requireAccountManager | isAuthenticated, requireAccountManager, writeLimiter | authenticated, ai_rate_limited |
| 1417 | POST | /api/sheets/workbooks/:id/duplicate | server/routes/sheets.ts:1403 | requireAccountManager | isAuthenticated, requireAccountManager, writeLimiter | authenticated, ai_rate_limited |
| 1418 | POST | /api/sheets/workbooks/:id/save-as-template | server/routes/sheets.ts:1454 | requireAccountManager | isAuthenticated, requireAccountManager, writeLimiter | authenticated, ai_rate_limited |
| 1419 | GET | /api/sheets/templates | server/routes/sheets.ts:1502 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 1420 | GET | /api/sheets/templates/:id | server/routes/sheets.ts:1521 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 1421 | PATCH | /api/sheets/templates/:id | server/routes/sheets.ts:1542 | requireAccountManager | isAuthenticated, requireAccountManager, writeLimiter | authenticated, ai_rate_limited |
| 1422 | DELETE | /api/sheets/templates/:id | server/routes/sheets.ts:1587 | requireAccountManager | isAuthenticated, requireAccountManager, writeLimiter | authenticated, ai_rate_limited |
| 1423 | POST | /api/sheets/templates/:id/workbook | server/routes/sheets.ts:1618 | requireAccountManager | isAuthenticated, requireAccountManager, writeLimiter | authenticated, ai_rate_limited |
| 1424 | GET | /api/sheets/workbooks/:id/tabs | server/routes/sheets.ts:1658 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 1425 | POST | /api/sheets/workbooks/:id/dashboard | server/routes/sheets.ts:1709 | requireAccountManager | isAuthenticated, requireAccountManager, writeLimiter | authenticated, ai_rate_limited |
| 1426 | DELETE | /api/sheets/workbooks/:id/dashboard | server/routes/sheets.ts:1746 | requireAccountManager | isAuthenticated, requireAccountManager, writeLimiter | authenticated, ai_rate_limited |
| 1427 | GET | /api/sheets/workbooks/:id/dashboard | server/routes/sheets.ts:1773 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 1428 | GET | /api/sheets/dashboards | server/routes/sheets.ts:1799 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 1429 | GET | /api/sheets/dashboards/:id | server/routes/sheets.ts:1821 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated |
| 1430 | POST | /api/sheets/workbooks/:wId/blocks/:bId/refresh | server/routes/sheets.ts:1852 | requireAccountManager | isAuthenticated, requireAccountManager, writeLimiter | authenticated, ai_rate_limited |
| 1431 | GET | /api/sms-consent/status | server/routes/smsConsent.ts:83 | requireTwilioAccess | isAuthenticated, requireTwilioAccess | authenticated |
| 1432 | POST | /api/sms-consent/status-batch | server/routes/smsConsent.ts:97 | requireTwilioAccess | isAuthenticated, requireTwilioAccess | authenticated |
| 1433 | GET | /api/admin/sms-consent/ledger | server/routes/smsConsent.ts:113 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 1434 | GET | /api/admin/sms-consent/events | server/routes/smsConsent.ts:136 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 1435 | GET | /api/admin/sms-consent/gate-audit | server/routes/smsConsent.ts:156 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 1436 | GET | /api/admin/sms-consent/settings | server/routes/smsConsent.ts:178 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 1437 | PUT | /api/admin/sms-consent/settings | server/routes/smsConsent.ts:195 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 1438 | POST | /api/admin/sms-consent/manual | server/routes/smsConsent.ts:240 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 1439 | GET | /api/tags | server/routes/tagsSegments.ts:116 | authenticated | isAuthenticated | authenticated |
| 1440 | POST | /api/tags | server/routes/tagsSegments.ts:150 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1441 | PATCH | /api/tags/:id | server/routes/tagsSegments.ts:193 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1442 | DELETE | /api/tags/:id | server/routes/tagsSegments.ts:230 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1443 | GET | /api/segments | server/routes/tagsSegments.ts:338 | authenticated | isAuthenticated | authenticated |
| 1444 | POST | /api/segments | server/routes/tagsSegments.ts:351 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1445 | PATCH | /api/segments/:id | server/routes/tagsSegments.ts:391 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1446 | DELETE | /api/segments/:id | server/routes/tagsSegments.ts:430 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1447 | GET | /api/segments/:id/members | server/routes/tagsSegments.ts:446 | authenticated | isAuthenticated | authenticated |
| 1448 | POST | /api/segments/:id/recompute | server/routes/tagsSegments.ts:467 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1449 | GET | /api/tags-segments/status | server/routes/tagsSegments.ts:486 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1450 | PATCH | /api/tags-segments/settings | server/routes/tagsSegments.ts:548 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1451 | POST | /api/tags-segments/sweep | server/routes/tagsSegments.ts:590 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1452 | GET | /api/clients/:clientId/timeline | server/routes/timeline.ts:163 | requireCommandCenterAccess | isAuthenticated, requireCommandCenterAccess | authenticated |
| 1453 | GET | /api/deals/:dealId/timeline | server/routes/timeline.ts:185 | authenticated | isAuthenticated | authenticated |
| 1454 | POST | /api/twilio/webhooks/sms | server/routes/twilio.ts:692 | validateTwilioWebhook | validateTwilioWebhook | webhook |
| 1455 | POST | /api/twilio/webhooks/sms-status | server/routes/twilio.ts:726 | validateTwilioWebhook | validateTwilioWebhook | webhook |
| 1456 | POST | /api/twilio/webhooks/call-status | server/routes/twilio.ts:758 | validateTwilioWebhook | validateTwilioWebhook | webhook |
| 1457 | POST | /api/twilio/webhooks/voice-twiml | server/routes/twilio.ts:786 | validateTwilioWebhook | validateTwilioWebhook | webhook |
| 1458 | POST | /api/twilio/webhooks/voice-routing-callback | server/routes/twilio.ts:856 | validateTwilioWebhook | validateTwilioWebhook | webhook |
| 1459 | POST | /api/twilio/webhooks/voice-ivr | server/routes/twilio.ts:930 | validateTwilioWebhook | validateTwilioWebhook | webhook |
| 1460 | POST | /api/twilio/webhooks/voice-twiml-outbound | server/routes/twilio.ts:972 | validateTwilioWebhook | validateTwilioWebhook | webhook |
| 1461 | POST | /api/twilio/webhooks/voice-twiml-forward-bridge | server/routes/twilio.ts:1004 | validateTwilioWebhook | validateTwilioWebhook | webhook |
| 1462 | POST | /api/twilio/webhooks/voice-twiml-browser | server/routes/twilio.ts:1039 | public | none | public, webhook |
| 1463 | POST | /api/twilio/webhooks/voice-whisper | server/routes/twilio.ts:1133 | public | none | public, webhook |
| 1464 | POST | /api/twilio/webhooks/recording-status | server/routes/twilio.ts:1175 | validateTwilioWebhook | validateTwilioWebhook | webhook |
| 1465 | POST | /api/twilio/webhooks/voicemail-recording-status | server/routes/twilio.ts:1262 | validateTwilioWebhook | validateTwilioWebhook | webhook |
| 1466 | POST | /api/twilio/webhooks/voicemail-transcription | server/routes/twilio.ts:1296 | validateTwilioWebhook | validateTwilioWebhook | webhook |
| 1467 | POST | /api/twilio/webhooks/voicemail-action | server/routes/twilio.ts:1354 | validateTwilioWebhook | validateTwilioWebhook | webhook |
| 1468 | POST | /api/twilio/webhooks/voice-twiml-browser-dial-status | server/routes/twilio.ts:1363 | validateTwilioWebhook | validateTwilioWebhook | webhook |
| 1469 | GET | /api/twilio/events | server/routes/twilio.ts:1408 | requireTwilioAccess | isAuthenticated, requireTwilioAccess | authenticated |
| 1470 | GET | /api/twilio/conversations | server/routes/twilio.ts:1456 | requireTwilioAccess | isAuthenticated, requireTwilioAccess | authenticated |
| 1471 | GET | /api/twilio/conversations/:id | server/routes/twilio.ts:1479 | requireTwilioAccess | isAuthenticated, requireTwilioAccess | authenticated |
| 1472 | GET | /api/twilio/conversations/:id/messages | server/routes/twilio.ts:1489 | requireTwilioAccess | isAuthenticated, requireTwilioAccess | authenticated |
| 1473 | POST | /api/twilio/conversations/:id/messages | server/routes/twilio.ts:1522 | requireTwilioAccess | isAuthenticated, requireTwilioAccess | authenticated |
| 1474 | GET | /api/twilio/client-suggestions | server/routes/twilio.ts:1662 | requireTwilioAccess | isAuthenticated, requireTwilioAccess | authenticated |
| 1475 | GET | /api/twilio/client-contacts/search | server/routes/twilio.ts:1675 | requireTwilioAccess | isAuthenticated, requireTwilioAccess | authenticated |
| 1476 | POST | /api/twilio/conversations/:id/read | server/routes/twilio.ts:1688 | requireTwilioAccess | isAuthenticated, requireTwilioAccess | authenticated |
| 1477 | GET | /api/twilio/threads/notes | server/routes/twilio.ts:1703 | requireTwilioAccess | isAuthenticated, requireTwilioAccess | authenticated |
| 1478 | GET | /api/twilio/threads/assignments | server/routes/twilio.ts:1731 | requireTwilioAccess | isAuthenticated, requireTwilioAccess | authenticated |
| 1479 | GET | /api/twilio/threads/:key/notes | server/routes/twilio.ts:1741 | requireTwilioAccess | isAuthenticated, requireTwilioAccess | authenticated |
| 1480 | POST | /api/twilio/threads/:key/notes | server/routes/twilio.ts:1755 | requireTwilioAccess | isAuthenticated, requireTwilioAccess | authenticated |
| 1481 | DELETE | /api/twilio/threads/notes/:id | server/routes/twilio.ts:1862 | requireTwilioAccess | isAuthenticated, requireTwilioAccess | authenticated |
| 1482 | GET | /api/twilio/threads/:key/assignment | server/routes/twilio.ts:1873 | requireTwilioAccess | isAuthenticated, requireTwilioAccess | authenticated |
| 1483 | GET | /api/twilio/threads/assignment-notifications | server/routes/twilio.ts:1917 | requireTwilioAccess | isAuthenticated, requireTwilioAccess | authenticated |
| 1484 | POST | /api/twilio/threads/assignment-notifications/mark-read | server/routes/twilio.ts:1936 | requireTwilioAccess | isAuthenticated, requireTwilioAccess | authenticated |
| 1485 | GET | /api/twilio/threads/read-states | server/routes/twilio.ts:1985 | requireTwilioAccess | isAuthenticated, requireTwilioAccess | authenticated |
| 1486 | PATCH | /api/twilio/threads/:key/read-state | server/routes/twilio.ts:2000 | requireTwilioAccess | isAuthenticated, requireTwilioAccess | authenticated |
| 1487 | GET | /api/twilio/threads/assignees | server/routes/twilio.ts:2090 | requireTwilioAccess | isAuthenticated, requireTwilioAccess | authenticated |
| 1488 | PATCH | /api/twilio/threads/:key/assignment | server/routes/twilio.ts:2118 | requireTwilioAccess | isAuthenticated, requireTwilioAccess | authenticated |
| 1489 | POST | /api/twilio/conversations | server/routes/twilio.ts:2193 | requireTwilioAccess | isAuthenticated, requireTwilioAccess | authenticated |
| 1490 | PATCH | /api/twilio/conversations/:id/client | server/routes/twilio.ts:2436 | requireTwilioAccess | isAuthenticated, requireTwilioAccess | authenticated |
| 1491 | PATCH | /api/twilio/conversations/:id/display-name | server/routes/twilio.ts:2546 | requireTwilioAccess | isAuthenticated, requireTwilioAccess | authenticated |
| 1492 | PATCH | /api/twilio/conversations/:id/participants | server/routes/twilio.ts:2564 | requireTwilioAccess | isAuthenticated, requireTwilioAccess | authenticated |
| 1493 | POST | /api/twilio/send-sms | server/routes/twilio.ts:2619 | requireTwilioAccess | isAuthenticated, requireTwilioAccess | authenticated |
| 1494 | POST | /api/twilio/initiate-call | server/routes/twilio.ts:2675 | requireTwilioAccess | isAuthenticated, requireTwilioAccess | authenticated |
| 1495 | POST | /api/twilio/voice-token | server/routes/twilio.ts:2753 | requireTwilioAccess | isAuthenticated, requireTwilioAccess | authenticated |
| 1496 | GET | /api/twilio/calls/:id/status | server/routes/twilio.ts:2824 | requireTwilioAccess | isAuthenticated, requireTwilioAccess | authenticated |
| 1497 | POST | /api/twilio/calls/:id/hangup | server/routes/twilio.ts:2865 | requireTwilioAccess | isAuthenticated, requireTwilioAccess | authenticated |
| 1498 | GET | /api/twilio/calls/:id/recording | server/routes/twilio.ts:2901 | requireTwilioAccess | isAuthenticated, requireTwilioAccess | authenticated |
| 1499 | GET | /api/twilio/calls/:id/voicemail-recording | server/routes/twilio.ts:2994 | requireTwilioAccess | isAuthenticated, requireTwilioAccess | authenticated |
| 1500 | POST | /api/twilio/calls/:id/voicemail/listened | server/routes/twilio.ts:3047 | requireTwilioAccess | isAuthenticated, requireTwilioAccess | authenticated |
| 1501 | GET | /api/twilio/calls | server/routes/twilio.ts:3067 | requireTwilioAccess | isAuthenticated, requireTwilioAccess | authenticated |
| 1502 | GET | /api/twilio/config | server/routes/twilio.ts:3086 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1503 | POST | /api/twilio/messaging-service/test | server/routes/twilio.ts:3175 | authenticated | isAuthenticated | authenticated |
| 1504 | PUT | /api/twilio/config | server/routes/twilio.ts:3211 | authenticated | isAuthenticated | authenticated |
| 1505 | PUT | /api/users/me/twilio-settings | server/routes/twilio.ts:3367 | authenticated | isAuthenticated | authenticated |
| 1506 | POST | /api/twilio/voice-presence | server/routes/twilio.ts:3409 | requireTwilioAccess | isAuthenticated, requireTwilioAccess | authenticated |
| 1507 | GET | /api/users/me/twilio-settings | server/routes/twilio.ts:3428 | authenticated | isAuthenticated | authenticated |
| 1508 | PUT | /api/users/me/profile | server/routes/twilio.ts:3445 | authenticated | isAuthenticated | authenticated |
| 1509 | POST | /api/users/me/profile-photo | server/routes/twilio.ts:3463 | authenticated | isAuthenticated | authenticated |
| 1510 | POST | /api/twilio/admin/backfill-statuses | server/routes/twilio.ts:3518 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1511 | POST | /api/admin/twilio/cleanup-duplicate-conversations | server/routes/twilio.ts:3667 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1512 | GET | /api/admin/twilio/call-archive | server/routes/twilio.ts:3703 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1513 | GET | /api/admin/twilio/call-archive/health | server/routes/twilio.ts:3790 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1514 | PUT | /api/admin/twilio/call-archive/alert-config | server/routes/twilio.ts:3933 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1515 | GET | /api/admin/twilio/call-archive/health/trend | server/routes/twilio.ts:4005 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1516 | POST | /api/admin/twilio/call-archive/:id/enqueue | server/routes/twilio.ts:4038 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1517 | POST | /api/admin/twilio/call-archive/enqueue-stuck | server/routes/twilio.ts:4062 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1518 | GET | /api/admin/twilio/call-archive/stuck-processing | server/routes/twilio.ts:4127 | requireAccountManager | isAuthenticated, requireAccountManager | authenticated, admin_only |
| 1519 | POST | /api/admin/twilio/call-archive/:id/force-release | server/routes/twilio.ts:4235 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1520 | GET | /api/admin/twilio/call-archive/requeue-audit | server/routes/twilio.ts:4295 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1521 | POST | /api/admin/twilio/call-archive/:id/requeue | server/routes/twilio.ts:4325 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1522 | POST | /api/admin/twilio/call-archive/requeue-bulk | server/routes/twilio.ts:4386 | requireCeo | isAuthenticated, requireCeo | authenticated, admin_only |
| 1523 | PUT | /api/users/me/timezone | server/routes/twilio.ts:4444 | authenticated | isAuthenticated | authenticated |
| 1524 | PUT | /api/users/me/theme | server/routes/twilio.ts:4470 | authenticated | isAuthenticated | authenticated |
| 1525 | GET | /api/notifications | server/routes/userNotifications.ts:120 | authenticated | isAuthenticated | authenticated |
| 1526 | GET | /api/notifications/system-bundled | server/routes/userNotifications.ts:158 | authenticated | isAuthenticated | authenticated |
| 1527 | PATCH | /api/notifications/mark-bundle-read | server/routes/userNotifications.ts:179 | authenticated | isAuthenticated | authenticated |
| 1528 | GET | /api/notifications/unread-count | server/routes/userNotifications.ts:197 | authenticated | isAuthenticated | authenticated |
| 1529 | GET | /api/notifications/events | server/routes/userNotifications.ts:215 | authenticated | isAuthenticated | authenticated |
| 1530 | PATCH | /api/notifications/:id/read | server/routes/userNotifications.ts:278 | authenticated | isAuthenticated | authenticated |
| 1531 | POST | /api/notifications/:id/read | server/routes/userNotifications.ts:283 | authenticated | isAuthenticated | authenticated |
| 1532 | PATCH | /api/notifications/:id/unread | server/routes/userNotifications.ts:306 | authenticated | isAuthenticated | authenticated |
| 1533 | PATCH | /api/notifications/mark-all-read | server/routes/userNotifications.ts:328 | authenticated | isAuthenticated | authenticated |
| 1534 | POST | /api/notifications/read-all | server/routes/userNotifications.ts:333 | authenticated | isAuthenticated | authenticated |
| 1535 | PATCH | /api/notifications/:id/archive | server/routes/userNotifications.ts:353 | authenticated | isAuthenticated | authenticated |
| 1536 | POST | /api/notifications/:id/archive | server/routes/userNotifications.ts:358 | authenticated | isAuthenticated | authenticated |
| 1537 | POST | /api/notifications/test | server/routes/userNotifications.ts:368 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated |
| 1538 | GET | /api/notifications/preferences | server/routes/userSlackPreferences.ts:83 | authenticated | isAuthenticated | authenticated |
| 1539 | PUT | /api/notifications/preferences | server/routes/userSlackPreferences.ts:107 | authenticated | isAuthenticated | authenticated |
| 1540 | GET | /api/notifications/slack-identity | server/routes/userSlackPreferences.ts:137 | authenticated | isAuthenticated | authenticated |
| 1541 | POST | /api/notifications/slack-identity/link | server/routes/userSlackPreferences.ts:158 | authenticated | isAuthenticated | authenticated |
| 1542 | DELETE | /api/notifications/slack-identity | server/routes/userSlackPreferences.ts:190 | authenticated | isAuthenticated | authenticated |
| 1543 | POST | /api/notifications/slack-identity/test | server/routes/userSlackPreferences.ts:208 | authenticated | isAuthenticated | authenticated |
| 1544 | GET | /api/admin/notifications/user-slack-identities | server/routes/userSlackPreferences.ts:233 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 1545 | DELETE | /api/admin/notifications/user-slack-identities/:userId | server/routes/userSlackPreferences.ts:250 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 1546 | GET | /api/admin/notifications/user-slack-dm-enabled | server/routes/userSlackPreferences.ts:269 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 1547 | PUT | /api/admin/notifications/user-slack-dm-enabled | server/routes/userSlackPreferences.ts:283 | requireTeamLead | isAuthenticated, requireTeamLead | authenticated, admin_only |
| 1548 | POST | /api/video-analysis/submit | server/routes/videoAnalysis.ts:29 | authenticated | isAuthenticated | authenticated |
| 1549 | GET | /api/video-analysis/status/:taskId | server/routes/videoAnalysis.ts:88 | authenticated | isAuthenticated | authenticated |
| 1550 | GET | /api/video-analysis/jobs | server/routes/videoAnalysis.ts:113 | authenticated | isAuthenticated | authenticated |
| 1551 | GET | /api/video-analysis/transcript/:taskId | server/routes/videoAnalysis.ts:125 | authenticated | isAuthenticated | authenticated |
| 1552 | POST | /api/video-analysis/analyze/:taskId | server/routes/videoAnalysis.ts:161 | authenticated | isAuthenticated | authenticated |
| 1553 | POST | /api/video-analysis/search/:taskId | server/routes/videoAnalysis.ts:198 | authenticated | isAuthenticated | authenticated |
| 1554 | GET | /api/video-analysis/full/:taskId | server/routes/videoAnalysis.ts:239 | authenticated | isAuthenticated | authenticated |
| 1555 | POST | /api/integrations/twelvelabs/webhook | server/routes/videoAnalysis.ts:285 | public | none | public, webhook |
| 1556 | GET | /api/video-analysis/frames/:taskId/:filename | server/routes/videoAnalysis.ts:361 | authenticated | isAuthenticated | authenticated |
| 1557 | GET | /api/website/inquiry/config | server/routes/website.ts:179 | public | none | public |
| 1558 | POST | /api/website/inquiry | server/routes/website.ts:188 | public | none | public |