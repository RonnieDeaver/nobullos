import { 
  type User,
  type FrontPipelineState,
  type Client, type InsertClient,
  type ClientLocation, type InsertClientLocation,
  type ClientDataAccess, type InsertClientDataAccess,
  type CeoPulse, type InsertCeoPulse,
  type Report, type InsertReport,
  type ReportSection, type InsertReportSection,
  type PracticeAreaSetting, type InsertPracticeAreaSetting,
  type PhaseSetting, type InsertPhaseSetting,
  type SystemSetting,
  type StaleLeaseThresholdAudit,
  type InsertStaleLeaseThresholdAudit,
  type AdminSettingAudit,
  type InsertAdminSettingAudit,
  type QueueTimingAudit,
  type InsertQueueTimingAudit,
  type CommandPanel, type InsertCommandPanel,
  type CommandPanelKeyCall, type InsertCommandPanelKeyCall,
  type CommandPanelRerRecording, type InsertCommandPanelRerRecording,
  type CommandPanelVersion, type InsertCommandPanelVersion,
  type CommandPanelHistory, type InsertCommandPanelHistory,
  type IntelligenceFeedEntry, type InsertIntelligenceFeedEntry,
  type ActionLogEntry, type InsertActionLogEntry,
  type RawCommunicationRecord, type InsertRawCommunication,
  type AiSuggestion, type InsertAiSuggestion,
  type FrontSyncEmail, type InsertFrontSyncEmail,
  type SlackChannelMapping, type InsertSlackChannelMapping,
  type SlackSyncHistory, type InsertSlackSyncHistory,
  type ClientContact, type InsertClientContact,
  type ClientAgentMemory, type InsertClientAgentMemory,
  type AgentMatchDecision, type InsertAgentMatchDecision,
  type PandadocDocument, type InsertPandadocDocument,
  type ClientConversationSummary, type InsertClientConversationSummary,
  type ClientAgentChat, type InsertClientAgentChat,
  type ClientDailyJudgment, type InsertClientDailyJudgment,
  type ClientCommunicationInsight, type InsertClientCommunicationInsight,
  type ClientRelationshipSignal, type InsertClientRelationshipSignal,
  type ClientOpenAsk, type InsertClientOpenAsk,
  type ClientSavePlay, type InsertClientSavePlay,
  type ClientConcernIntel, type InsertClientConcernIntel,
  type AgentKnowledgeBase, type InsertAgentKnowledgeBase,
  type AgentFeedback, type InsertAgentFeedback,
  type OperationalFilterMemory, type InsertOperationalFilterMemory,
  type TwilioConversation, type InsertTwilioConversation,
  type TwilioMessage, type InsertTwilioMessage,
  type TwilioCall, type InsertTwilioCall,
  type CommunicationClientLink, type InsertCommunicationClientLink,
  type FrontHydrateSnapshot, type InsertFrontHydrateSnapshot,
  type AgentMatchSetting,
  type AgentMatchSettingHistory,
} from "@shared/schema";

import * as clientOps from "./storage/clientStorage";
import * as reportOps from "./storage/reportStorage";
import * as settingsOps from "./storage/settingsStorage";
import * as prodActionRunsOps from "./storage/prodActionRuns";
import * as backupRunsOps from "./storage/backupRuns";
import * as websiteInquiryOps from "./storage/websiteInquiryStorage";
import * as commandCenterOps from "./storage/commandCenterStorage";
import * as risOps from "./storage/risStorage";
import * as communicationOps from "./storage/communicationStorage";
import * as agentOps from "./storage/agentStorage";
import * as agentMatchSettingsOps from "./storage/agentMatchSettingsStorage";
import * as dailyJudgmentOps from "./storage/dailyJudgmentStorage";
import * as twilioOps from "./storage/twilioStorage";
import * as bookingOps from "./storage/bookingStorage";
import * as bookCommerceCoreOps from "./storage/bookCommerceStorage";
import * as bookCommerceEventOps from "./storage/bookCommerceEventStorage";
import * as bookCommerceEngagementOps from "./storage/bookCommerceEngagementStorage";

const bookCommerceOps = {
  ...bookCommerceCoreOps,
  ...bookCommerceEventOps,
  ...bookCommerceEngagementOps,
};
import * as sheetsOps from "./storage/sheetsStorage";
import * as docsOps from "./storage/docsStorage";

import type {
  BookingPage, InsertBookingPage,
  BookingAvailabilityRule, InsertBookingAvailabilityRule,
  BookingAvailabilityOverride, InsertBookingAvailabilityOverride,
  BookingMeetingType, InsertBookingMeetingType,
  ScheduledMeeting, InsertScheduledMeeting, ScheduledMeetingStatus,
  MeetingRecurrenceException, InsertMeetingRecurrenceException,
  GoogleCalendarCredential, InsertGoogleCalendarCredential,
  BookingClientToken, InsertBookingClientToken,
  RisCheck, InsertRisCheck, UpdateRisCheck,
  RisCheckResult, InsertRisCheckResult,
  RisAutoSourceMapping, UpsertRisAutoSourceMapping, UpdateRisAutoSourceMapping,
  RisClientAutoSourceOverride, UpsertRisClientAutoSourceOverride, UpdateRisClientAutoSourceOverride,
} from "@shared/schema";

export interface IStorage {
  getUser(id: string): Promise<User | undefined>;
  getUserIncludingDeleted(id: string): Promise<User | undefined>;
  isUserRevoked(id: string): Promise<boolean>;
  getAllUsers(): Promise<User[]>;
  listUsersPaged(opts: import("./storage/clientStorage").ListUsersPagedOpts): Promise<import("./storage/clientStorage").ListUsersPagedResult>;
  updateUserRole(id: string, role: string): Promise<User | undefined>;
  deleteUser(id: string): Promise<User | undefined>;
  getUserAssignmentImpact(id: string): Promise<import("./storage/clientStorage").UserAssignmentImpact>;
  reassignUserWork(
    fromUserId: string,
    toUserId: string,
    surfaces: import("./storage/clientStorage").ReassignUserWorkSurface[],
    actorUserId: string,
  ): Promise<import("./storage/clientStorage").ReassignUserWorkResult>;
  listDeletedUsers(): Promise<import("./storage/clientStorage").DeletedUserRow[]>;
  restoreUser(id: string): Promise<User | undefined>;
  updateUserEmail(id: string, email: string): Promise<User | undefined>;
  updateUserRoleProfile(
    id: string,
    args: { functions: string[]; authorityLevel: string },
  ): Promise<User | undefined>;
  // Task #4554 — closed admission: pre-create ("approve") a user by email
  // + role profile before their first sign-in. Sole runtime insert path
  // into `users`.
  createApprovedUser(args: {
    email: string;
    firstName?: string | null;
    lastName?: string | null;
    functions: string[];
    authorityLevel: string;
  }): Promise<User>;
  updateUserDisplayTimezone(id: string, timezone: string, source: "user" | "google_calendar"): Promise<User | undefined>;
  
  getClients(): Promise<Client[]>;
  // Task #4330 — prospect-INCLUSIVE enumeration for identity-matching
  // surfaces only (Front hard match). Operational lists use getClients.
  getClientsIncludingProspects(): Promise<Client[]>;
  getClientsPaginated(limit: number, offset: number): Promise<{ data: Client[]; total: number }>;
  getClient(id: string): Promise<Client | undefined>;
  getClientByCode(code: string): Promise<Client | undefined>;
  getClientsByOwner(ownerId: string): Promise<Client[]>;
  getClientsByOwnerPaginated(ownerId: string, limit: number, offset: number): Promise<{ data: Client[]; total: number }>;
  createClient(data: InsertClient): Promise<Client>;
  updateClient(id: string, data: import("@shared/schema").UpdateClient): Promise<Client | undefined>;
  deleteClient(id: string): Promise<void>;
  
  getClientLocations(clientId: string): Promise<ClientLocation[]>;
  getClientLocation(id: string): Promise<ClientLocation | undefined>;
  createClientLocation(data: InsertClientLocation, opts?: import("./storage/clientStorage").ClientLocationWriteOpts): Promise<ClientLocation>;
  updateClientLocation(id: string, data: import("@shared/schema").UpdateClientLocation, opts?: import("./storage/clientStorage").ClientLocationWriteOpts): Promise<ClientLocation | undefined>;
  deleteClientLocation(id: string, opts?: import("./storage/clientStorage").ClientLocationWriteOpts): Promise<void>;
  getLatestClientLocationAuditByClient(clientId: string): Promise<import("./storage/clientStorage").ClientLocationAuditSummary[]>;
  getClientLocationAuditHistory(locationId: string, clientId?: string): Promise<import("./storage/clientStorage").ClientLocationAuditEntry[]>;
  
  getClientDataAccess(clientId: string): Promise<ClientDataAccess[]>;
  getAllDataAccessForClients(clientIds: string[]): Promise<ClientDataAccess[]>;
  upsertClientDataAccess(data: InsertClientDataAccess): Promise<ClientDataAccess>;

  createImportEntitySuggestion(data: import("@shared/schema").InsertImportEntitySuggestion): Promise<import("@shared/schema").ImportEntitySuggestion>;
  listImportEntitySuggestions(opts?: { clientId?: string; surface?: string; entityKind?: string; status?: string; limit?: number; offset?: number }): Promise<import("@shared/schema").ImportEntitySuggestion[]>;
  countImportEntitySuggestions(opts?: { clientId?: string; surface?: string; entityKind?: string; status?: string }): Promise<number>;
  getImportEntitySuggestion(id: string): Promise<import("@shared/schema").ImportEntitySuggestion | undefined>;
  updateImportEntitySuggestion(
    id: string,
    patch: { status?: string; reviewedByUserId?: string | null; reviewedAt?: Date | null; promotedEntityId?: string | null },
  ): Promise<import("@shared/schema").ImportEntitySuggestion | undefined>;
  
  getCeoPulses(): Promise<CeoPulse[]>;
  getCeoPulse(id: string): Promise<CeoPulse | undefined>;
  getCeoPulseByMonth(monthKey: string): Promise<CeoPulse | undefined>;
  getCeoPulseByShareToken(token: string): Promise<CeoPulse | undefined>;
  createCeoPulse(data: InsertCeoPulse): Promise<CeoPulse>;
  updateCeoPulse(id: string, data: import("./storage/reportStorage").CeoPulseStoragePatch): Promise<CeoPulse | undefined>;
  // Task #4293 — the ONLY writers of ceo_pulses.supporting_images (column is
  // excluded from the generic insert/update schemas above).
  appendCeoPulseSupportingImage(id: string, ext: string, maxCount: number): Promise<{ slot: number; images: unknown } | null>;
  removeCeoPulseSupportingImage(id: string, slot: number): Promise<{ images: unknown } | null>;
  replaceCeoPulseSupportingImages(id: string, images: unknown[]): Promise<CeoPulse | undefined>;
  
  getReports(): Promise<Report[]>;
  getReportsPaginated(limit: number, offset: number): Promise<{ data: Report[]; total: number }>;
  getReport(id: string): Promise<Report | undefined>;
  getReportByShareToken(token: string): Promise<Report | undefined>;
  getReportsByClient(clientId: string): Promise<Report[]>;
  getReportsByClientIds(clientIds: string[]): Promise<Report[]>;
  createReport(data: InsertReport): Promise<Report>;
  updateReport(id: string, data: import("@shared/schema").UpdateReport): Promise<Report | undefined>;
  // Task #4537 — the ONLY writer of reports.presented_at/presented_by (the
  // columns are omitted from the generic insert/update schemas; the PATCH
  // route derives the stamp server-side from the authenticated actor).
  setReportPresented(id: string, stamp: { presentedAt: Date | null; presentedBy: string | null }): Promise<Report | undefined>;
  deleteReport(id: string): Promise<void>;
  
  getReportSections(reportId: string): Promise<ReportSection[]>;
  getReportSection(reportId: string, sectionKey: string): Promise<ReportSection | undefined>;
  upsertReportSection(
    data: InsertReportSection,
    attribution?: import("./storage/reportStorage").ReportSectionWriteAttribution,
  ): Promise<ReportSection>;
  purgeSlideVerdictKeys(
    reportId: string,
    sectionKey: string,
    clears: import("./storage/reportStorage").SlideVerdictKeyClear[],
    attribution?: Partial<import("./storage/reportStorage").ReportSectionWriteAttribution>,
  ): Promise<import("./storage/reportStorage").SlideVerdictPurgeWriteResult>;
  getReportSectionHistory(
    reportId: string,
    sectionKey?: string,
  ): Promise<import("@shared/schema").ReportSectionHistory[]>;
  
  getPracticeAreaSettings(): Promise<PracticeAreaSetting[]>;
  getPracticeAreaSetting(practiceArea: string): Promise<PracticeAreaSetting | undefined>;
  upsertPracticeAreaSetting(data: InsertPracticeAreaSetting): Promise<PracticeAreaSetting>;
  deletePracticeAreaSetting(id: string): Promise<void>;
  
  getPhaseSettings(): Promise<PhaseSetting[]>;
  upsertPhaseSetting(data: InsertPhaseSetting): Promise<PhaseSetting>;
  
  getSystemSetting(key: string): Promise<SystemSetting | undefined>;
  // Task #2412: authoritative, cache-bypassing read for confirm-before-trip
  // paths (rejects on read failure so callers can tell absent from unknown).
  getSystemSettingFresh(key: string): Promise<SystemSetting | undefined>;
  // Task #836 Phase 5: batched read for callers that need many keys.
  getSystemSettings(keys: string[]): Promise<Record<string, string>>;
  setSystemSetting(key: string, value: string, updatedBy?: string): Promise<SystemSetting>;
  deleteSystemSetting(key: string): Promise<void>;

  recordStaleLeaseThresholdChange(data: InsertStaleLeaseThresholdAudit): Promise<StaleLeaseThresholdAudit>;
  listStaleLeaseThresholdAudit(limit?: number): Promise<StaleLeaseThresholdAudit[]>;
  pruneStaleLeaseThresholdAudit(opts: { maxEntries?: number; maxAgeDays?: number }): Promise<number>;
  estimatePruneStaleLeaseThresholdAudit(opts: { maxEntries?: number; maxAgeDays?: number }): Promise<{ wouldRemove: number; total: number }>;

  recordAdminSettingChange(data: InsertAdminSettingAudit): Promise<AdminSettingAudit>;
  getAdminSettingAuditById(id: string): Promise<AdminSettingAudit | undefined>;
  listAdminSettingAudit(opts: { settingKey: string; scope?: string; changedByIn?: string[]; limit?: number }): Promise<AdminSettingAudit[]>;
  updateAdminSettingAuditDelivery(params: {
    id: string;
    slackStatus?: string | null;
    emailStatus?: string | null;
    slackFailureReason?: string | null;
    emailFailureReason?: string | null;
    lastResendAt?: Date | null;
    lastResendBy?: string | null;
    lastResendSource?: string | null;
  }): Promise<void>;
  pruneAdminSettingAuditPerScope(opts: { settingKey: string; maxEntriesPerScope: number; scope?: string }): Promise<number>;

  recordQueueTimingChange(data: InsertQueueTimingAudit): Promise<QueueTimingAudit>;
  listQueueTimingAudit(limit?: number): Promise<QueueTimingAudit[]>;
  pruneQueueTimingAudit(opts: { maxEntries?: number; maxAgeDays?: number }): Promise<number>;
  estimatePruneQueueTimingAudit(opts: { maxEntries?: number; maxAgeDays?: number }): Promise<{ wouldRemove: number; total: number }>;

  getCommandPanel(clientId: string): Promise<CommandPanel | undefined>;
  upsertCommandPanel(data: InsertCommandPanel, preserveLastUpdatedAt?: boolean): Promise<CommandPanel>;
  markCommandPanelReviewed(clientId: string, userId: string): Promise<CommandPanel | undefined>;
  getAllCommandPanelSummaries(): Promise<{ clientId: string; lastReviewedAt: Date | null; productTypes: string[] | null; lsaBudget: number | null; googleAdsBudget: number | null; webinarBudget: number | null }[]>;

  getKeyCallsForClient(clientId: string): Promise<CommandPanelKeyCall[]>;
  upsertKeyCall(data: InsertCommandPanelKeyCall): Promise<CommandPanelKeyCall>;
  deleteKeyCall(clientId: string, callType: string): Promise<void>;

  getRerRecordingsForClient(clientId: string): Promise<CommandPanelRerRecording[]>;
  createRerRecording(data: InsertCommandPanelRerRecording): Promise<{ recording: CommandPanelRerRecording; duplicate: boolean }>;
  deleteRerRecording(id: string, clientId?: string): Promise<void>;
  deleteKeyCallsByRawCommunication(rawCommunicationRecordId: string, clientId?: string): Promise<number>;
  deleteRerRecordingsByRawCommunication(rawCommunicationRecordId: string, clientId?: string): Promise<number>;

  getCommandPanelVersions(clientId: string): Promise<CommandPanelVersion[]>;
  createCommandPanelVersion(data: InsertCommandPanelVersion): Promise<CommandPanelVersion>;

  getCommandPanelHistory(clientId: string, filters?: {
    fieldName?: string;
    changedBy?: string;
    dateFrom?: Date;
    dateTo?: Date;
  }): Promise<CommandPanelHistory[]>;
  createCommandPanelHistory(data: InsertCommandPanelHistory): Promise<CommandPanelHistory>;

  createIntelligenceFeedEntry(data: InsertIntelligenceFeedEntry): Promise<IntelligenceFeedEntry>;
  getIntelligenceFeedEntry(id: string): Promise<IntelligenceFeedEntry | undefined>;
  updateIntelligenceFeedEntry(id: string, clientId: string, data: import("@shared/schema").UpdateIntelligenceFeedEntry): Promise<IntelligenceFeedEntry | undefined>;
  listIntelligenceFeedEntries(clientId: string, filters?: {
    type?: string;
    author?: string;
    dateFrom?: Date;
    dateTo?: Date;
    status?: string;
    pinned?: boolean;
    search?: string;
  }): Promise<IntelligenceFeedEntry[]>;
  listRecentWins(limit: number): Promise<import("./storage/commandCenterStorage").RecentWinRow[]>;

  createActionLogEntry(data: InsertActionLogEntry): Promise<ActionLogEntry>;
  getActionLogEntry(id: string): Promise<ActionLogEntry | undefined>;
  updateActionLogEntry(id: string, clientId: string, data: import("@shared/schema").UpdateActionLogEntry): Promise<ActionLogEntry | undefined>;
  listActionLogEntries(clientId: string, filters?: {
    actionType?: string;
    actor?: string;
    dateFrom?: Date;
    dateTo?: Date;
    impactedSystem?: string;
    search?: string;
  }): Promise<ActionLogEntry[]>;

  createRawCommunication(data: InsertRawCommunication, options?: { isTouchpoint?: boolean }): Promise<RawCommunicationRecord>;
  createRawCommunicationOnConflictSkip(data: InsertRawCommunication): Promise<RawCommunicationRecord | undefined>;
  getRawCommunication(id: string): Promise<RawCommunicationRecord | undefined>;
  getRawCommunicationsByIds(ids: string[]): Promise<RawCommunicationRecord[]>;
  updateRawCommunication(id: string, data: Omit<Partial<RawCommunicationRecord>, "isTouchpoint" | "id">): Promise<RawCommunicationRecord | undefined>;
  updateRawCommunicationsByThreadId(externalThreadId: string, data: Omit<Partial<RawCommunicationRecord>, "isTouchpoint" | "id">): Promise<number>;
  deleteRawCommunication(id: string): Promise<void>;
  listRawCommunications(clientId: string, filters?: {
    sourceType?: string;
    direction?: string;
    processingStatus?: string;
    reviewStatus?: string;
    dateFrom?: Date;
    dateTo?: Date;
    hasSuggestions?: boolean;
    search?: string;
    includeOrphaned?: boolean;
  }): Promise<RawCommunicationRecord[]>;
  countClientCommunicationsInRange(clientId: string, since: Date, until?: Date): Promise<number>;

  createCommunicationClientLink(data: InsertCommunicationClientLink): Promise<CommunicationClientLink>;
  listCommunicationClientLinks(recordId: string): Promise<CommunicationClientLink[]>;
  listClientLinksForClient(clientId: string): Promise<CommunicationClientLink[]>;
  updateCommunicationClientLink(id: string, data: import("@shared/schema").UpdateCommunicationClientLink): Promise<CommunicationClientLink | undefined>;
  deleteCommunicationClientLink(id: string): Promise<void>;

  createAiSuggestion(data: InsertAiSuggestion): Promise<AiSuggestion>;
  getAiSuggestion(id: string): Promise<AiSuggestion | undefined>;
  updateAiSuggestion(id: string, data: import("@shared/schema").UpdateAiSuggestion): Promise<AiSuggestion | undefined>;
  listAiSuggestions(clientId: string, filters?: {
    status?: string;
    destinationType?: string;
    rawCommunicationRecordId?: string;
  }): Promise<AiSuggestion[]>;
  countPendingSuggestions(clientId: string): Promise<number>;

  createFrontSyncEmail(data: InsertFrontSyncEmail): Promise<FrontSyncEmail>;
  getFrontSyncEmail(id: string): Promise<FrontSyncEmail | undefined>;
  getFrontSyncEmailByConversationId(conversationId: string): Promise<FrontSyncEmail | undefined>;
  getExistingConversationIds(conversationIds: string[]): Promise<Set<string>>;
  updateFrontSyncEmail(id: string, data: import("@shared/schema").UpdateFrontSyncEmail): Promise<FrontSyncEmail | undefined>;
  listFrontSyncEmails(filters?: { matchStatus?: string; matchStatuses?: string[]; limit?: number; offset?: number; afterCursor?: { createdAt: Date; id: string } }): Promise<FrontSyncEmail[]>;
  getFrontSyncEmailsByIds(ids: string[]): Promise<FrontSyncEmail[]>;
  countUnmatchedFrontSyncEmails(): Promise<number>;
  countFrontSyncEmailsByStatus(status: string): Promise<number>;
  getOldestUnmatchedFrontSyncTimestamp(): Promise<Date | null>;
  deleteAllFrontSyncEmails(): Promise<number>;
  transitionFrontSyncPipelineState(id: string, toState: FrontPipelineState, options?: { error?: string; force?: boolean }): Promise<FrontSyncEmail | undefined>;
  getExistingConversationVersionKeys(conversationIds: string[]): Promise<Map<string, { id: string; versionKey: string | null; pipelineState: string }>>;
  listFrontSyncEmailsByPipelineState(states: FrontPipelineState[], limit?: number): Promise<FrontSyncEmail[]>;

  upsertFrontHydrateSnapshot(data: InsertFrontHydrateSnapshot): Promise<FrontHydrateSnapshot>;
  getFrontHydrateSnapshotByVersionKey(versionKey: string): Promise<FrontHydrateSnapshot | undefined>;
  getFrontHydrateSnapshotByConversationId(conversationId: string): Promise<FrontHydrateSnapshot | undefined>;
  deleteFrontHydrateSnapshot(id: string): Promise<void>;
  deleteExpiredFrontHydrateSnapshots(): Promise<number>;

  // Task #867 — Front hard-match audit log + dashboard tile aggregator.
  createFrontMatchAuditLog(data: import("@shared/schema").InsertFrontMatchAuditLog): Promise<import("@shared/schema").FrontMatchAuditLog>;
  listFrontMatchAuditLog(opts?: { syncEmailId?: string; conversationId?: string; limit?: number }): Promise<import("@shared/schema").FrontMatchAuditLog[]>;
  getFrontMatchStats(): Promise<{ byStatus: Record<string, number>; byMethod: Record<string, number>; total: number }>;

  createSlackChannelMapping(data: InsertSlackChannelMapping): Promise<SlackChannelMapping>;
  getSlackChannelMapping(id: string): Promise<SlackChannelMapping | undefined>;
  getSlackChannelMappingByChannelId(channelId: string): Promise<SlackChannelMapping | undefined>;
  updateSlackChannelMapping(id: string, data: import("@shared/schema").UpdateSlackChannelMapping): Promise<SlackChannelMapping | undefined>;
  deleteSlackChannelMapping(id: string): Promise<void>;
  listSlackChannelMappings(filters?: { isActive?: boolean }): Promise<SlackChannelMapping[]>;

  createSlackSyncHistory(data: InsertSlackSyncHistory): Promise<SlackSyncHistory>;
  updateSlackSyncHistory(id: string, data: import("@shared/schema").UpdateSlackSyncHistory): Promise<SlackSyncHistory | undefined>;
  listSlackSyncHistory(limit?: number): Promise<SlackSyncHistory[]>;

  findRawCommunicationByExternalSourceId(externalSourceId: string): Promise<RawCommunicationRecord | undefined>;
  listEmailMessageSiblingsByThreadId(externalThreadId: string, clientId: string): Promise<RawCommunicationRecord[]>;

  getClientContacts(clientId: string): Promise<ClientContact[]>;
  // Task #813: batched contact-count map keyed by clientId. Returns only
  // entries that have at least one contact row. Used by periodic sweeps to
  // avoid N+1 fan-out on the API pool.
  getClientContactCounts(clientIds: string[]): Promise<Map<string, number>>;
  // Task #818 Phase 3: batched contacts-by-client map for callers that
  // previously walked one-getClientContacts-per-client (e.g. the Zoom
  // participant matcher). Single round-trip instead of N.
  getClientContactsForClients(clientIds: string[]): Promise<Map<string, ClientContact[]>>;
  getClientContact(id: string): Promise<ClientContact | undefined>;
  createClientContact(data: InsertClientContact, opts?: import("./storage/clientStorage").ClientContactWriteOpts): Promise<ClientContact>;
  updateClientContact(id: string, data: import("@shared/schema").UpdateClientContact, opts?: import("./storage/clientStorage").ClientContactWriteOpts): Promise<ClientContact | undefined>;
  deleteClientContact(id: string, opts?: import("./storage/clientStorage").ClientContactWriteOpts): Promise<void>;
  // Task #991: surface "who last edited this contact" in the UI without
  // making each row issue its own audit query.
  getLatestClientContactAuditByClient(clientId: string): Promise<import("./storage/clientStorage").ClientContactAuditSummary[]>;
  getClientContactAuditHistory(contactId: string, clientId?: string): Promise<import("./storage/clientStorage").ClientContactAuditEntry[]>;

  getClientAgentMemory(clientId: string): Promise<ClientAgentMemory[]>;
  getClientAgentMemoryByType(clientId: string, identifierType: string): Promise<ClientAgentMemory[]>;
  createClientAgentMemory(data: InsertClientAgentMemory): Promise<ClientAgentMemory>;
  upsertClientAgentMemory(data: InsertClientAgentMemory): Promise<ClientAgentMemory>;
  updateClientAgentMemory(id: string, data: import("./storage/agentStorage").ClientAgentMemoryStoragePatch): Promise<ClientAgentMemory | undefined>;
  deleteClientAgentMemory(id: string): Promise<void>;
  getAllAgentMemories(): Promise<ClientAgentMemory[]>;
  penalizeAgentMemoryWeight(id: string, factor: number, minWeight: number): Promise<ClientAgentMemory | undefined>;
  boostAgentMemoryWeight(id: string, factor: number, maxWeight: number): Promise<ClientAgentMemory | undefined>;

  getAgentKnowledgeByClient(clientId: string, filters?: { category?: string; isActive?: boolean }): Promise<AgentKnowledgeBase[]>;
  getAgentKnowledgeEntry(id: string): Promise<AgentKnowledgeBase | undefined>;
  createAgentKnowledgeEntry(data: InsertAgentKnowledgeBase): Promise<AgentKnowledgeBase>;
  upsertAgentKnowledgeEntry(data: InsertAgentKnowledgeBase): Promise<AgentKnowledgeBase>;
  updateAgentKnowledgeEntry(id: string, data: import("@shared/schema").UpdateAgentKnowledgeEntry): Promise<AgentKnowledgeBase | undefined>;
  deleteAgentKnowledgeEntry(id: string): Promise<void>;
  bulkUpsertAgentKnowledge(entries: InsertAgentKnowledgeBase[]): Promise<AgentKnowledgeBase[]>;

  createAgentFeedback(data: InsertAgentFeedback): Promise<AgentFeedback>;
  getAgentFeedbackByTarget(targetRecordId: string, targetRecordType: string): Promise<AgentFeedback[]>;
  getAgentFeedbackByClient(clientId: string, limit?: number): Promise<AgentFeedback[]>;
  listAgentFeedback(filters?: { agentType?: string; feedbackType?: string; clientId?: string; limit?: number }): Promise<AgentFeedback[]>;

  createAgentMatchDecision(data: InsertAgentMatchDecision): Promise<AgentMatchDecision>;
  getAgentMatchDecision(id: string): Promise<AgentMatchDecision | undefined>;
  updateAgentMatchDecision(id: string, data: import("@shared/schema").UpdateAgentMatchDecision): Promise<AgentMatchDecision | undefined>;
  listAgentMatchDecisions(filters?: {
    clientId?: string;
    communicationId?: string;
    status?: string;
    sourceType?: string;
    unresolvedOnly?: boolean;
    reviewResolution?: string;
    dismissReason?: string;
    since?: Date;
    limit?: number;
    explanationSummaryLikeAny?: string[];
    explanationSummaryNotLikeAny?: string[];
  }): Promise<AgentMatchDecision[]>;
  getAgentMatchDecisionStatsInWindow(filters: {
    sourceType?: string;
    since: Date;
    until: Date;
  }): Promise<{
    total: number;
    claimed: number;
    reviewRequired: number;
    ambiguous: number;
    notClaimed: number;
    corrected: number;
  }>;
  getAgentMatchStats(clientId: string): Promise<{
    totalDecisions: number;
    claimedCount: number;
    correctedCount: number;
    avgConfidence: number;
  }>;

  listUnmatchedFrontSyncEmails(limit?: number): Promise<FrontSyncEmail[]>;
  listUnmatchedFrontSyncEmailsByParticipant(target: { email?: string; domain?: string }, limit?: number): Promise<FrontSyncEmail[]>;
  listUnmatchedRawCommunications(filters?: { sourceType?: string; limit?: number; includeOrphaned?: boolean }): Promise<RawCommunicationRecord[]>;
  listUnmatchedSlackMessages(limit?: number, options?: { includeOrphaned?: boolean }): Promise<RawCommunicationRecord[]>;

  upsertOperationalFilterMemory(data: InsertOperationalFilterMemory): Promise<OperationalFilterMemory>;
  getOperationalFilterMemoryBySignals(signals: Array<{ type: string; value: string }>): Promise<OperationalFilterMemory[]>;
  getAllOperationalFilterMemories(): Promise<OperationalFilterMemory[]>;
  penalizeOperationalFilterMemory(id: string, factor: number, minWeight: number): Promise<OperationalFilterMemory | undefined>;
  deleteOperationalFilterMemory(id: string): Promise<void>;

  createPandadocDocument(data: InsertPandadocDocument): Promise<PandadocDocument>;
  getPandadocDocument(id: string): Promise<PandadocDocument | undefined>;
  getPandadocDocumentByDocumentId(documentId: string): Promise<PandadocDocument | undefined>;
  updatePandadocDocument(id: string, data: import("@shared/schema").UpdatePandadocDocument): Promise<PandadocDocument | undefined>;
  listPandadocDocuments(filters?: { linkedClientId?: string; search?: string }): Promise<PandadocDocument[]>;
  linkPandadocDocumentToClient(id: string, clientId: string | null): Promise<PandadocDocument | undefined>;
  getPandadocDocumentsByClient(clientId: string): Promise<PandadocDocument[]>;

  getClientConversationSummary(clientId: string): Promise<ClientConversationSummary | undefined>;
  upsertClientConversationSummary(data: InsertClientConversationSummary): Promise<ClientConversationSummary>;

  getClientAgentChatMessages(clientId: string): Promise<ClientAgentChat[]>;
  createClientAgentChatMessage(data: InsertClientAgentChat): Promise<ClientAgentChat>;
  deleteClientAgentChatMessages(clientId: string): Promise<void>;

  createClientDailyJudgment(data: InsertClientDailyJudgment): Promise<ClientDailyJudgment>;
  getClientDailyJudgment(id: string): Promise<ClientDailyJudgment | undefined>;
  getClientDailyJudgmentByDate(clientId: string, judgmentDate: string): Promise<ClientDailyJudgment | undefined>;
  getClientDailyJudgments(clientId: string, limit?: number): Promise<ClientDailyJudgment[]>;
  upsertClientDailyJudgment(data: InsertClientDailyJudgment): Promise<ClientDailyJudgment>;
  listClientDailyJudgments(clientId: string, filters?: {
    dateFrom?: Date;
    dateTo?: Date;
    status?: string;
    hasUnresolvedAsks?: boolean;
    negativeRelationship?: boolean;
  }): Promise<ClientDailyJudgment[]>;

  createClientCommunicationInsight(data: InsertClientCommunicationInsight): Promise<ClientCommunicationInsight>;
  getClientCommunicationInsightByCommId(rawCommunicationRecordId: string): Promise<ClientCommunicationInsight | undefined>;
  listClientCommunicationInsights(clientId: string, filters?: {
    dateFrom?: Date;
    dateTo?: Date;
  }): Promise<ClientCommunicationInsight[]>;

  createClientRelationshipSignal(data: InsertClientRelationshipSignal): Promise<ClientRelationshipSignal>;
  getClientRelationshipSignals(clientId: string, limit?: number): Promise<ClientRelationshipSignal[]>;
  upsertClientRelationshipSignal(data: InsertClientRelationshipSignal): Promise<ClientRelationshipSignal>;
  listClientRelationshipSignals(clientId: string, filters?: {
    dateFrom?: Date;
    dateTo?: Date;
  }): Promise<ClientRelationshipSignal[]>;

  createClientOpenAsk(data: InsertClientOpenAsk): Promise<ClientOpenAsk>;
  getClientOpenAsk(id: string): Promise<ClientOpenAsk | undefined>;
  updateClientOpenAsk(id: string, data: import("@shared/schema").UpdateClientOpenAsk): Promise<ClientOpenAsk | undefined>;
  getClientOpenAsks(clientId: string, filters?: { status?: string }): Promise<ClientOpenAsk[]>;
  listClientOpenAsks(clientId: string, filters?: {
    status?: string;
    askType?: string;
  }): Promise<ClientOpenAsk[]>;

  createClientSavePlay(data: InsertClientSavePlay): Promise<ClientSavePlay>;
  getClientSavePlay(id: string): Promise<ClientSavePlay | undefined>;
  listClientSavePlays(clientId: string, filters?: { status?: string }): Promise<ClientSavePlay[]>;
  updateClientSavePlay(id: string, data: import("@shared/schema").UpdateClientSavePlay): Promise<ClientSavePlay | undefined>;
  deleteClientSavePlay(id: string): Promise<void>;

  createClientConcernIntel(data: InsertClientConcernIntel): Promise<ClientConcernIntel>;
  listRecentConcernIntel(clientId: string, since: Date, limit?: number): Promise<ClientConcernIntel[]>;

  getActiveClients(): Promise<Client[]>;

  createTwilioConversation(data: InsertTwilioConversation): Promise<TwilioConversation>;
  getTwilioConversation(id: string): Promise<TwilioConversation | undefined>;
  getTwilioConversationByPhone(contactPhone: string, twilioPhoneNumber: string): Promise<TwilioConversation | undefined>;
  updateTwilioConversation(id: string, data: import("@shared/schema").UpdateTwilioConversation): Promise<TwilioConversation | undefined>;
  listTwilioConversations(filters?: { clientId?: string; status?: string; search?: string }): Promise<TwilioConversation[]>;
  markTwilioConversationRead(id: string): Promise<TwilioConversation | undefined>;

  createTwilioMessage(data: InsertTwilioMessage): Promise<TwilioMessage>;
  getTwilioMessage(id: string): Promise<TwilioMessage | undefined>;
  listTwilioMessages(conversationId: string, limit?: number): Promise<TwilioMessage[]>;
  updateTwilioMessage(id: string, data: import("@shared/schema").UpdateTwilioMessage): Promise<TwilioMessage | undefined>;

  createTwilioCall(data: InsertTwilioCall): Promise<TwilioCall>;
  getTwilioCall(id: string): Promise<TwilioCall | undefined>;
  getTwilioCallByTwilioSid(sid: string): Promise<TwilioCall | undefined>;
  updateTwilioCall(id: string, data: import("@shared/schema").UpdateTwilioCall): Promise<TwilioCall | undefined>;
  listTwilioCalls(filters?: { clientId?: string; limit?: number }): Promise<TwilioCall[]>;
  findClientByPhone(phone: string): Promise<{ clientId: string; contactId: string; contactName: string } | null>;
  searchClientContactsByPhone(phone: string, limit?: number): Promise<Array<{ clientId: string; firmName: string; contactId: string; contactName: string; phone: string }>>;
  getClientSuggestionsForPhone(phone: string, limit?: number): Promise<Array<{ clientId: string; firmName: string; score: number; reasons: string[] }>>;

  listAgentMatchSettings(): Promise<AgentMatchSetting[]>;
  upsertAgentMatchSetting(params: {
    source: string;
    settingKey: string;
    value: number;
    updatedBy?: string | null;
    restoreFromHistoryId?: string | null;
    restoreFromChangedAt?: Date | null;
  }): Promise<{ row: AgentMatchSetting; previousValue: number | null; historyId: string }>;
  deleteAgentMatchSetting(params: {
    source: string;
    settingKey: string;
    changedBy?: string | null;
    restoreFromHistoryId?: string | null;
    restoreFromChangedAt?: Date | null;
  }): Promise<{ previousValue: number; historyId: string } | null>;
  recordAgentMatchSettingHistory(params: {
    source: string;
    settingKey: string;
    oldValue: number | null;
    newValue: number | null;
    changedBy?: string | null;
  }): Promise<AgentMatchSettingHistory>;
  listAgentMatchSettingHistory(filters?: {
    source?: string;
    settingKey?: string;
    limit?: number;
  }): Promise<AgentMatchSettingHistory[]>;
  updateAgentMatchSettingHistoryDelivery(params: {
    id: string;
    slackStatus?: string | null;
    emailStatus?: string | null;
    slackFailureReason?: string | null;
    emailFailureReason?: string | null;
    lastResendAt?: Date | null;
    lastResendBy?: string | null;
    lastResendSource?: string | null;
    slackAttemptCount?: number | null;
    emailAttemptCount?: number | null;
    lastAutoRetryAt?: Date | null;
    autoRetryGiveupNotifiedAt?: Date | null;
  }): Promise<void>;
  getAgentMatchSettingHistoryById(id: string): Promise<AgentMatchSettingHistory | undefined>;

  // ---- Booking tool (Task #840) ----
  getBookingPageById(id: string): Promise<BookingPage | undefined>;
  getBookingPageBySlug(slug: string): Promise<BookingPage | undefined>;
  getBookingPageByUserId(userId: string): Promise<BookingPage | undefined>;
  listBookingPages(filters?: { active?: boolean }): Promise<BookingPage[]>;
  createBookingPage(data: InsertBookingPage): Promise<BookingPage>;
  updateBookingPage(id: string, data: import("@shared/schema").UpdateBookingPage): Promise<BookingPage | undefined>;
  deleteBookingPage(id: string): Promise<void>;

  listAvailabilityRules(bookingPageId: string): Promise<BookingAvailabilityRule[]>;
  createAvailabilityRule(data: InsertBookingAvailabilityRule): Promise<BookingAvailabilityRule>;
  deleteAvailabilityRule(id: string): Promise<void>;
  replaceAvailabilityRules(bookingPageId: string, rules: InsertBookingAvailabilityRule[]): Promise<BookingAvailabilityRule[]>;

  listAvailabilityOverrides(bookingPageId: string, fromDateLocal?: string, toDateLocal?: string): Promise<BookingAvailabilityOverride[]>;
  upsertAvailabilityOverride(data: InsertBookingAvailabilityOverride): Promise<BookingAvailabilityOverride>;
  getAvailabilityOverride(id: string): Promise<BookingAvailabilityOverride | undefined>;
  deleteAvailabilityOverride(id: string): Promise<void>;

  listBookingMeetingTypes(accountManagerUserId: string): Promise<BookingMeetingType[]>;
  getBookingMeetingType(id: string): Promise<BookingMeetingType | undefined>;
  createBookingMeetingType(data: InsertBookingMeetingType): Promise<BookingMeetingType>;
  updateBookingMeetingType(id: string, data: import("@shared/schema").UpdateBookingMeetingType): Promise<BookingMeetingType | undefined>;
  deleteBookingMeetingType(id: string): Promise<void>;

  getScheduledMeetingById(id: string): Promise<ScheduledMeeting | undefined>;
  getScheduledMeetingByIdempotencyKey(key: string): Promise<ScheduledMeeting | undefined>;
  createScheduledMeeting(data: InsertScheduledMeeting): Promise<ScheduledMeeting>;
  updateScheduledMeeting(id: string, data: import("./storage/bookingStorage").ScheduledMeetingStoragePatch): Promise<ScheduledMeeting | undefined>;
  listScheduledMeetingsForAm(accountManagerUserId: string, filters?: { status?: ScheduledMeetingStatus[]; from?: Date; to?: Date }): Promise<ScheduledMeeting[]>;
  listScheduledMeetingsForUser(userId: string, filters: bookingOps.ListUserMeetingsFilters): Promise<bookingOps.ListUserMeetingsPage>;
  listScheduledMeetingsForClient(clientId: string): Promise<ScheduledMeeting[]>;
  listOverlappingScheduledMeetingsForAm(accountManagerUserId: string, startUtc: Date, endUtc: Date): Promise<ScheduledMeeting[]>;
  findScheduledMeetingByZoomIds(zoomMeetingId: string | number | null | undefined, zoomMeetingUuid: string | null | undefined): Promise<ScheduledMeeting | undefined>;
  getScheduledMeetingMatchStats(sinceDays?: number): Promise<{
    totalLast30Days: number;
    byStatus: { status: string; count: number }[];
    bySource: { source: string; count: number }[];
    byMatchMethod: { matchMethod: string | null; count: number }[];
  }>;

  createMeetingRecurrenceException(data: InsertMeetingRecurrenceException): Promise<MeetingRecurrenceException>;
  upsertMeetingRecurrenceException(data: InsertMeetingRecurrenceException): Promise<MeetingRecurrenceException>;
  listMeetingRecurrenceExceptionsForMaster(seriesMasterId: string): Promise<MeetingRecurrenceException[]>;
  getMeetingRecurrenceException(seriesMasterId: string, originalStartTime: Date): Promise<MeetingRecurrenceException | undefined>;

  getGoogleCalendarCredential(userId: string): Promise<GoogleCalendarCredential | undefined>;
  listGoogleCalendarCredentials(): Promise<GoogleCalendarCredential[]>;
  upsertGoogleCalendarCredential(data: InsertGoogleCalendarCredential): Promise<GoogleCalendarCredential>;
  updateGoogleCalendarCredential(userId: string, data: import("./storage/bookingStorage").GoogleCalendarCredentialStoragePatch): Promise<GoogleCalendarCredential | undefined>;
  deleteGoogleCalendarCredential(userId: string): Promise<void>;

  createBookingClientToken(data: InsertBookingClientToken): Promise<BookingClientToken>;
  findBookingClientTokenByHash(tokenHash: string): Promise<BookingClientToken | undefined>;
  markBookingClientTokenUsed(id: string): Promise<BookingClientToken | undefined>;
  listBookingClientTokensForClient(clientId: string): Promise<BookingClientToken[]>;

  // Task #5096 — Book commerce (finalized public boundaries only).
  // Internal transaction/key helpers and generic financial/event/outbox
  // writers are deliberately NOT exposed here.
  upsertBookContact: typeof bookCommerceOps.upsertBookContact;
  createBookCheckoutSession: typeof bookCommerceOps.createBookCheckoutSession;
  createBookOrder: typeof bookCommerceOps.createBookOrder;
  insertBookPaymentEvent: typeof bookCommerceOps.insertBookPaymentEvent;
  setPaymentEventRetention: typeof bookCommerceOps.setPaymentEventRetention;
  transitionBookOrderStatus: typeof bookCommerceOps.transitionBookOrderStatus;
  grantBookEntitlement: typeof bookCommerceOps.grantBookEntitlement;
  revokeBookEntitlement: typeof bookCommerceOps.revokeBookEntitlement;
  createBookAuditApplication: typeof bookCommerceOps.createBookAuditApplication;
  transitionBookAuditApplication: typeof bookCommerceOps.transitionBookAuditApplication;
  upsertBookAppointment: typeof bookCommerceOps.upsertBookAppointment;
  transitionBookAppointment: typeof bookCommerceOps.transitionBookAppointment;
  insertBookProviderCorrelation: typeof bookCommerceOps.insertBookProviderCorrelation;

  // Task #2367 — RIS QA Layer.
  listRisChecks(filters?: risOps.ListRisChecksFilters): Promise<RisCheck[]>;
  getRisCheck(id: string): Promise<RisCheck | undefined>;
  getRisCheckByKey(key: string): Promise<RisCheck | undefined>;
  createRisCheck(data: InsertRisCheck): Promise<RisCheck>;
  updateRisCheck(id: string, patch: UpdateRisCheck): Promise<RisCheck | undefined>;
  reorderRisChecks(orderedIds: string[]): Promise<void>;
  getRisResultsForClient(clientId: string, periods: string[]): Promise<RisCheckResult[]>;
  getRisResultsForPeriods(periods: string[]): Promise<RisCheckResult[]>;
  getRisResultById(id: string): Promise<RisCheckResult | undefined>;
  setRisCheckResult(input: risOps.SetRisResultInput, actorId: string | null): Promise<risOps.SetRisResultOutcome>;
  // Task #2368 — RIS BigQuery auto-pull.
  setRisAutoResult(input: risOps.SetRisAutoResultInput): Promise<risOps.SetRisAutoResultOutcome>;
  confirmRisResult(id: string, actorId: string | null): Promise<RisCheckResult | undefined>;
  listRisAutoSourceMappings(): Promise<RisAutoSourceMapping[]>;
  getRisAutoSourceMapping(autoSource: string): Promise<RisAutoSourceMapping | undefined>;
  upsertRisAutoSourceMapping(data: UpsertRisAutoSourceMapping): Promise<RisAutoSourceMapping>;
  updateRisAutoSourceMapping(autoSource: string, patch: UpdateRisAutoSourceMapping): Promise<RisAutoSourceMapping | undefined>;
  ensureRisAutoSourceMapping(data: UpsertRisAutoSourceMapping): Promise<void>;
  listRisClientAutoSourceOverrides(clientId?: string): Promise<RisClientAutoSourceOverride[]>;
  upsertRisClientAutoSourceOverride(data: UpsertRisClientAutoSourceOverride): Promise<RisClientAutoSourceOverride>;
  updateRisClientAutoSourceOverride(clientId: string, autoSource: string, patch: UpdateRisClientAutoSourceOverride): Promise<RisClientAutoSourceOverride | undefined>;
  deleteRisClientAutoSourceOverride(clientId: string, autoSource: string): Promise<void>;

  // ---- NoBull Sheets ----
  getSheetFolder(id: string): Promise<import("@shared/schema").SheetFolder | undefined>;
  listSheetFolders(ownerId: string): Promise<import("@shared/schema").SheetFolder[]>;
  createSheetFolder(data: import("@shared/schema").InsertSheetFolder): Promise<import("@shared/schema").SheetFolder>;
  updateSheetFolder(id: string, data: Partial<Pick<import("@shared/schema").InsertSheetFolder, "name">>): Promise<import("@shared/schema").SheetFolder | undefined>;
  deleteSheetFolder(id: string): Promise<void>;

  getSheetWorkbook(id: string): Promise<import("@shared/schema").SheetWorkbook | undefined>;
  listSheetWorkbooks(filters: import("./storage/sheetsStorage").ListSheetWorkbooksFilters): Promise<import("./storage/sheetsStorage").SheetWorkbookMeta[]>;
  listSheetWorkbooksPage(filters: import("./storage/sheetsStorage").ListSheetWorkbooksFilters): Promise<{ workbooks: import("./storage/sheetsStorage").SheetWorkbookMeta[]; total: number }>;
  createSheetWorkbook(data: import("@shared/schema").InsertSheetWorkbook): Promise<import("@shared/schema").SheetWorkbook>;
  updateSheetWorkbook(id: string, data: Partial<Pick<import("@shared/schema").InsertSheetWorkbook, "name" | "folderId" | "snapshot">>): Promise<import("@shared/schema").SheetWorkbook | undefined>;
  saveSheetWorkbookSnapshot(
    id: string,
    snapshot: unknown,
    expectedRevision: number,
  ): Promise<
    | { ok: true; workbook: import("@shared/schema").SheetWorkbook }
    | { ok: false; conflict: true; currentRevision: number }
  >;
  deleteSheetWorkbook(id: string): Promise<void>;

  listSheetWorkbookPermissions(workbookId: string): Promise<import("@shared/schema").SheetWorkbookPermission[]>;
  getSheetWorkbookPermission(workbookId: string, userId: string): Promise<import("@shared/schema").SheetWorkbookPermission | undefined>;
  upsertSheetWorkbookPermission(data: import("@shared/schema").InsertSheetWorkbookPermission): Promise<import("@shared/schema").SheetWorkbookPermission>;
  deleteSheetWorkbookPermission(workbookId: string, userId: string): Promise<void>;
  listSheetWorkbookRoleGrants(workbookId: string): Promise<import("@shared/schema").SheetWorkbookRoleGrant[]>;
  getSheetWorkbookRoleGrant(workbookId: string, role: string): Promise<import("@shared/schema").SheetWorkbookRoleGrant | undefined>;
  upsertSheetWorkbookRoleGrant(data: import("@shared/schema").InsertSheetWorkbookRoleGrant): Promise<import("@shared/schema").SheetWorkbookRoleGrant>;
  deleteSheetWorkbookRoleGrant(workbookId: string, role: string): Promise<void>;

  getWorkbookAccessLevel(workbookId: string, userId: string, userRole?: string): Promise<"owner" | "editor" | "viewer" | null>;
  canUserAccessWorkbook(workbookId: string, userId: string, userRole?: string): Promise<boolean>;
  canUserWriteWorkbook(workbookId: string, userId: string, userRole?: string): Promise<boolean>;

  acquireWorkbookLock(
    workbookId: string,
    holderUserId: string,
    holderName: string,
  ): Promise<
    | { acquired: true; lock: import("@shared/schema").SheetWorkbookLock }
    | { acquired: false; lock: import("@shared/schema").SheetWorkbookLock }
  >;
  heartbeatWorkbookLock(workbookId: string, holderUserId: string): Promise<import("@shared/schema").SheetWorkbookLock | null>;
  releaseWorkbookLock(workbookId: string, holderUserId: string): Promise<void>;
  getWorkbookLock(workbookId: string): Promise<import("@shared/schema").SheetWorkbookLock | null>;
  pruneExpiredWorkbookLocks(): Promise<number>;

  // ---- NoBull Sheets data blocks ----
  createSheetDataBlock(data: import("@shared/schema").InsertSheetDataBlock): Promise<import("@shared/schema").SheetDataBlock>;
  getSheetDataBlock(id: string): Promise<import("@shared/schema").SheetDataBlock | undefined>;
  listSheetDataBlocks(workbookId: string): Promise<import("@shared/schema").SheetDataBlock[]>;
  listSheetDataBlocksForAutoRefresh(): Promise<import("@shared/schema").SheetDataBlock[]>;
  updateSheetDataBlock(id: string, data: Partial<Pick<import("@shared/schema").SheetDataBlock, "label" | "autoRefresh" | "rowCount" | "colCount" | "lastRefreshedAt">>): Promise<import("@shared/schema").SheetDataBlock | undefined>;
  deleteSheetDataBlock(id: string): Promise<void>;

  // ---- NoBull Sheets — duplicate & templates ----
  duplicateWorkbook(
    sourceId: string,
    newOwnerId: string,
    newName: string,
    folderId?: string | null,
  ): Promise<{ workbook: import("@shared/schema").SheetWorkbook; blockCount: number }>;

  createSheetTemplate(data: import("@shared/schema").InsertSheetTemplate): Promise<import("@shared/schema").SheetTemplate>;
  getSheetTemplate(id: string): Promise<import("@shared/schema").SheetTemplate | undefined>;
  listSheetTemplates(filters?: { includeArchived?: boolean }): Promise<import("@shared/schema").SheetTemplate[]>;
  updateSheetTemplate(
    id: string,
    patch: Partial<Pick<import("@shared/schema").InsertSheetTemplate, "name" | "description" | "snapshot" | "dataBlockDefs" | "sourceWorkbookId" | "archivedAt">>,
  ): Promise<import("@shared/schema").SheetTemplate | undefined>;
  deleteSheetTemplate(id: string): Promise<void>;
  createWorkbookFromTemplate(
    templateId: string,
    ownerId: string,
    name: string,
    folderId?: string | null,
  ): Promise<{ workbook: import("@shared/schema").SheetWorkbook; blockCount: number }>;
  saveWorkbookAsTemplate(
    workbookId: string,
    createdBy: string,
    templateName: string,
    description: string,
    existingTemplateId?: string,
  ): Promise<import("@shared/schema").SheetTemplate>;

  // ---- NoBull Sheets — version history & restore ----
  getSheetWorkbookVersion(id: string): Promise<import("@shared/schema").SheetWorkbookVersion | undefined>;
  listSheetWorkbookVersions(workbookId: string): Promise<import("@shared/schema").SheetWorkbookVersionMeta[]>;
  captureAutoVersion(params: {
    workbookId: string;
    snapshot: unknown;
    createdBy: string | undefined;
  }): Promise<import("@shared/schema").SheetWorkbookVersion | null>;
  saveManualVersion(params: {
    workbookId: string;
    snapshot: unknown;
    createdBy: string | undefined;
    label?: string | null;
  }): Promise<import("@shared/schema").SheetWorkbookVersion>;
  restoreSheetWorkbookVersion(params: {
    versionId: string;
    workbookId: string;
    restoredBy: string | undefined;
  }): Promise<import("@shared/schema").SheetWorkbook>;

  // ---- NoBull Sheets — published dashboards ----
  getWorkbookDashboard(workbookId: string): Promise<import("./storage/sheetsStorage").WorkbookDashboard | undefined>;
  publishWorkbookAsDashboard(
    workbookId: string,
    publishedBy: string,
    config: {
      title: string;
      tabs: import("./storage/sheetsStorage").DashboardTab[];
      audienceUserIds: string[];
      audienceRoles: string[];
    },
  ): Promise<import("./storage/sheetsStorage").WorkbookDashboard>;
  unpublishWorkbookDashboard(workbookId: string): Promise<void>;
  listPublishedDashboards(
    userId: string,
    userRole?: string,
  ): Promise<Array<import("./storage/sheetsStorage").WorkbookDashboard & { workbookName: string }>>;
  canUserViewDashboard(workbookId: string, userId: string, userRole?: string): Promise<boolean>;

  // ---- NoBull Sheets — activity trail ----
  logSheetActivity(params: {
    workbookId: string;
    actorId: string | null | undefined;
    actorName: string;
    action: import("@shared/schema").SheetActivityAction;
    detail?: Record<string, unknown> | null;
  }): Promise<import("@shared/schema").SheetWorkbookActivity>;
  listSheetWorkbookActivity(workbookId: string, limit?: number): Promise<import("@shared/schema").SheetWorkbookActivity[]>;
  getSheetWorkbookLastActivityMap(workbookIds: string[]): Promise<Map<string, Date>>;
}

export class DatabaseStorage implements IStorage {
  getUser = clientOps.getUser;
  getUserIncludingDeleted = clientOps.getUserIncludingDeleted;
  isUserRevoked = clientOps.isUserRevoked;
  getAllUsers = clientOps.getAllUsers;
  listUsersPaged = clientOps.listUsersPaged;
  updateUserRole = clientOps.updateUserRole;
  deleteUser = clientOps.deleteUser;
  getUserAssignmentImpact = clientOps.getUserAssignmentImpact;
  reassignUserWork = clientOps.reassignUserWork;
  listDeletedUsers = clientOps.listDeletedUsers;
  restoreUser = clientOps.restoreUser;
  updateUserEmail = clientOps.updateUserEmail;
  updateUserRoleProfile = clientOps.updateUserRoleProfile;
  createApprovedUser = clientOps.createApprovedUser;
  updateUserDisplayTimezone = clientOps.updateUserDisplayTimezone;
  getClients = clientOps.getClients;
  getClientsIncludingProspects = clientOps.getClientsIncludingProspects;
  getClientsPaginated = clientOps.getClientsPaginated;
  getClient = clientOps.getClient;
  getClientByCode = clientOps.getClientByCode;
  getClientsByOwner = clientOps.getClientsByOwner;
  getClientsByOwnerPaginated = clientOps.getClientsByOwnerPaginated;
  createClient = clientOps.createClient;
  updateClient = clientOps.updateClient;
  deleteClient = clientOps.deleteClient;
  getClientLocations = clientOps.getClientLocations;
  getClientLocation = clientOps.getClientLocation;
  createClientLocation = clientOps.createClientLocation;
  updateClientLocation = clientOps.updateClientLocation;
  deleteClientLocation = clientOps.deleteClientLocation;
  getLatestClientLocationAuditByClient = clientOps.getLatestClientLocationAuditByClient;
  getClientLocationAuditHistory = clientOps.getClientLocationAuditHistory;
  getClientDataAccess = clientOps.getClientDataAccess;
  getAllDataAccessForClients = clientOps.getAllDataAccessForClients;
  upsertClientDataAccess = clientOps.upsertClientDataAccess;
  createImportEntitySuggestion = clientOps.createImportEntitySuggestion;
  listImportEntitySuggestions = clientOps.listImportEntitySuggestions;
  countImportEntitySuggestions = clientOps.countImportEntitySuggestions;
  getImportEntitySuggestion = clientOps.getImportEntitySuggestion;
  updateImportEntitySuggestion = clientOps.updateImportEntitySuggestion;
  getClientContacts = clientOps.getClientContacts;
  getClientContactCounts = clientOps.getClientContactCounts;
  getClientContactsForClients = clientOps.getClientContactsForClients;
  getClientContact = clientOps.getClientContact;
  createClientContact = clientOps.createClientContact;
  updateClientContact = clientOps.updateClientContact;
  deleteClientContact = clientOps.deleteClientContact;
  getLatestClientContactAuditByClient = clientOps.getLatestClientContactAuditByClient;
  getClientContactAuditHistory = clientOps.getClientContactAuditHistory;
  getActiveClients = clientOps.getActiveClients;

  getCeoPulses = reportOps.getCeoPulses;
  getCeoPulse = reportOps.getCeoPulse;
  getCeoPulseByMonth = reportOps.getCeoPulseByMonth;
  getCeoPulseByShareToken = reportOps.getCeoPulseByShareToken;
  createCeoPulse = reportOps.createCeoPulse;
  updateCeoPulse = reportOps.updateCeoPulse;
  appendCeoPulseSupportingImage = reportOps.appendCeoPulseSupportingImage;
  removeCeoPulseSupportingImage = reportOps.removeCeoPulseSupportingImage;
  replaceCeoPulseSupportingImages = reportOps.replaceCeoPulseSupportingImages;
  getReports = reportOps.getReports;
  getReportsPaginated = reportOps.getReportsPaginated;
  getReport = reportOps.getReport;
  getReportByShareToken = reportOps.getReportByShareToken;
  getReportsByClient = reportOps.getReportsByClient;
  getReportsByClientIds = reportOps.getReportsByClientIds;
  createReport = reportOps.createReport;
  updateReport = reportOps.updateReport;
  setReportPresented = reportOps.setReportPresented;
  deleteReport = reportOps.deleteReport;
  getReportSections = reportOps.getReportSections;
  getReportSection = reportOps.getReportSection;
  upsertReportSection = reportOps.upsertReportSection;
  purgeSlideVerdictKeys = reportOps.purgeSlideVerdictKeys;
  getReportSectionHistory = reportOps.getReportSectionHistory;

  getPracticeAreaSettings = settingsOps.getPracticeAreaSettings;
  getPracticeAreaSetting = settingsOps.getPracticeAreaSetting;
  upsertPracticeAreaSetting = settingsOps.upsertPracticeAreaSetting;
  deletePracticeAreaSetting = settingsOps.deletePracticeAreaSetting;
  getPhaseSettings = settingsOps.getPhaseSettings;
  upsertPhaseSetting = settingsOps.upsertPhaseSetting;
  getSystemSetting = settingsOps.getSystemSetting;
  getSystemSettingFresh = settingsOps.getSystemSettingFresh;
  getSystemSettings = settingsOps.getSystemSettings;
  setSystemSetting = settingsOps.setSystemSetting;
  deleteSystemSetting = settingsOps.deleteSystemSetting;
  recordStaleLeaseThresholdChange = settingsOps.recordStaleLeaseThresholdChange;
  listStaleLeaseThresholdAudit = settingsOps.listStaleLeaseThresholdAudit;
  pruneStaleLeaseThresholdAudit = settingsOps.pruneStaleLeaseThresholdAudit;
  estimatePruneStaleLeaseThresholdAudit = settingsOps.estimatePruneStaleLeaseThresholdAudit;
  recordAdminSettingChange = settingsOps.recordAdminSettingChange;
  getAdminSettingAuditById = settingsOps.getAdminSettingAuditById;
  listAdminSettingAudit = settingsOps.listAdminSettingAudit;
  updateAdminSettingAuditDelivery = settingsOps.updateAdminSettingAuditDelivery;
  pruneAdminSettingAuditPerScope = settingsOps.pruneAdminSettingAuditPerScope;
  recordQueueTimingChange = settingsOps.recordQueueTimingChange;
  listQueueTimingAudit = settingsOps.listQueueTimingAudit;
  pruneQueueTimingAudit = settingsOps.pruneQueueTimingAudit;
  estimatePruneQueueTimingAudit = settingsOps.estimatePruneQueueTimingAudit;

  recordProdActionRun = prodActionRunsOps.recordProdActionRun;
  listProdActionRuns = prodActionRunsOps.listProdActionRuns;
  getLastSuccessfulProdActionRun = prodActionRunsOps.getLastSuccessfulProdActionRun;
  ensureProdActionRunsTable = prodActionRunsOps.ensureProdActionRunsTable;

  ensureAppBackupRunsTable = backupRunsOps.ensureAppBackupRunsTable;
  createAppBackupRun = backupRunsOps.createAppBackupRun;
  updateAppBackupRun = backupRunsOps.updateAppBackupRun;
  listAppBackupRuns = backupRunsOps.listAppBackupRuns;
  getAppBackupRun = backupRunsOps.getAppBackupRun;
  failStaleInProgressBackupRuns = backupRunsOps.failStaleInProgressRuns;

  createWebsiteInquiry = websiteInquiryOps.createWebsiteInquiry;
  listWebsiteInquiries = websiteInquiryOps.listWebsiteInquiries;

  getCommandPanel = commandCenterOps.getCommandPanel;
  upsertCommandPanel = commandCenterOps.upsertCommandPanel;
  markCommandPanelReviewed = commandCenterOps.markCommandPanelReviewed;
  getAllCommandPanelSummaries = commandCenterOps.getAllCommandPanelSummaries;
  getKeyCallsForClient = commandCenterOps.getKeyCallsForClient;
  upsertKeyCall = commandCenterOps.upsertKeyCall;
  deleteKeyCall = commandCenterOps.deleteKeyCall;
  getRerRecordingsForClient = commandCenterOps.getRerRecordingsForClient;
  createRerRecording = commandCenterOps.createRerRecording;
  deleteRerRecording = commandCenterOps.deleteRerRecording;
  deleteKeyCallsByRawCommunication = commandCenterOps.deleteKeyCallsByRawCommunication;
  deleteRerRecordingsByRawCommunication = commandCenterOps.deleteRerRecordingsByRawCommunication;
  getCommandPanelVersions = commandCenterOps.getCommandPanelVersions;
  createCommandPanelVersion = commandCenterOps.createCommandPanelVersion;
  getCommandPanelHistory = commandCenterOps.getCommandPanelHistory;
  createCommandPanelHistory = commandCenterOps.createCommandPanelHistory;
  createIntelligenceFeedEntry = commandCenterOps.createIntelligenceFeedEntry;
  getIntelligenceFeedEntry = commandCenterOps.getIntelligenceFeedEntry;
  updateIntelligenceFeedEntry = commandCenterOps.updateIntelligenceFeedEntry;
  listIntelligenceFeedEntries = commandCenterOps.listIntelligenceFeedEntries;
  listRecentWins = commandCenterOps.listRecentWins;
  createActionLogEntry = commandCenterOps.createActionLogEntry;
  getActionLogEntry = commandCenterOps.getActionLogEntry;
  updateActionLogEntry = commandCenterOps.updateActionLogEntry;
  listActionLogEntries = commandCenterOps.listActionLogEntries;

  // Task #2367 — RIS QA Layer.
  listRisChecks = risOps.listRisChecks;
  getRisCheck = risOps.getRisCheck;
  getRisCheckByKey = risOps.getRisCheckByKey;
  createRisCheck = risOps.createRisCheck;
  updateRisCheck = risOps.updateRisCheck;
  reorderRisChecks = risOps.reorderRisChecks;
  getRisResultsForClient = risOps.getRisResultsForClient;
  getRisResultsForPeriods = risOps.getRisResultsForPeriods;
  getRisResultById = risOps.getRisResultById;
  setRisCheckResult = risOps.setRisCheckResult;
  setRisAutoResult = risOps.setRisAutoResult;
  confirmRisResult = risOps.confirmRisResult;
  listRisAutoSourceMappings = risOps.listRisAutoSourceMappings;
  getRisAutoSourceMapping = risOps.getRisAutoSourceMapping;
  upsertRisAutoSourceMapping = risOps.upsertRisAutoSourceMapping;
  updateRisAutoSourceMapping = risOps.updateRisAutoSourceMapping;
  ensureRisAutoSourceMapping = risOps.ensureRisAutoSourceMapping;
  listRisClientAutoSourceOverrides = risOps.listRisClientAutoSourceOverrides;
  upsertRisClientAutoSourceOverride = risOps.upsertRisClientAutoSourceOverride;
  updateRisClientAutoSourceOverride = risOps.updateRisClientAutoSourceOverride;
  deleteRisClientAutoSourceOverride = risOps.deleteRisClientAutoSourceOverride;

  createRawCommunication = communicationOps.createRawCommunication;
  createRawCommunicationOnConflictSkip = communicationOps.createRawCommunicationOnConflictSkip;
  getRawCommunication = communicationOps.getRawCommunication;
  getRawCommunicationsByIds = communicationOps.getRawCommunicationsByIds;
  updateRawCommunication = communicationOps.updateRawCommunication;
  updateRawCommunicationsByThreadId = communicationOps.updateRawCommunicationsByThreadId;
  deleteRawCommunication = communicationOps.deleteRawCommunication;
  listRawCommunications = communicationOps.listRawCommunications;
  countClientCommunicationsInRange = communicationOps.countClientCommunicationsInRange;
  createCommunicationClientLink = communicationOps.createCommunicationClientLink;
  listCommunicationClientLinks = communicationOps.listCommunicationClientLinks;
  listClientLinksForClient = communicationOps.listClientLinksForClient;
  updateCommunicationClientLink = communicationOps.updateCommunicationClientLink;
  deleteCommunicationClientLink = communicationOps.deleteCommunicationClientLink;
  createAiSuggestion = communicationOps.createAiSuggestion;
  getAiSuggestion = communicationOps.getAiSuggestion;
  updateAiSuggestion = communicationOps.updateAiSuggestion;
  listAiSuggestions = communicationOps.listAiSuggestions;
  countPendingSuggestions = communicationOps.countPendingSuggestions;
  createFrontSyncEmail = communicationOps.createFrontSyncEmail;
  getFrontSyncEmail = communicationOps.getFrontSyncEmail;
  getFrontSyncEmailByConversationId = communicationOps.getFrontSyncEmailByConversationId;
  getExistingConversationIds = communicationOps.getExistingConversationIds;
  updateFrontSyncEmail = communicationOps.updateFrontSyncEmail;
  listFrontSyncEmails = communicationOps.listFrontSyncEmails;
  getFrontSyncEmailsByIds = communicationOps.getFrontSyncEmailsByIds;
  countUnmatchedFrontSyncEmails = communicationOps.countUnmatchedFrontSyncEmails;
  countFrontSyncEmailsByStatus = communicationOps.countFrontSyncEmailsByStatus;
  getOldestUnmatchedFrontSyncTimestamp = communicationOps.getOldestUnmatchedFrontSyncTimestamp;
  deleteAllFrontSyncEmails = communicationOps.deleteAllFrontSyncEmails;
  transitionFrontSyncPipelineState = communicationOps.transitionFrontSyncPipelineState;
  getExistingConversationVersionKeys = communicationOps.getExistingConversationVersionKeys;
  listFrontSyncEmailsByPipelineState = communicationOps.listFrontSyncEmailsByPipelineState;
  upsertFrontHydrateSnapshot = communicationOps.upsertFrontHydrateSnapshot;
  getFrontHydrateSnapshotByVersionKey = communicationOps.getFrontHydrateSnapshotByVersionKey;
  getFrontHydrateSnapshotByConversationId = communicationOps.getFrontHydrateSnapshotByConversationId;
  deleteFrontHydrateSnapshot = communicationOps.deleteFrontHydrateSnapshot;
  deleteExpiredFrontHydrateSnapshots = communicationOps.deleteExpiredFrontHydrateSnapshots;
  // Task #867 — Front hard-match audit + dashboard tile aggregator.
  createFrontMatchAuditLog = communicationOps.createFrontMatchAuditLog;
  listFrontMatchAuditLog = communicationOps.listFrontMatchAuditLog;
  getFrontMatchStats = communicationOps.getFrontMatchStats;

  createSlackChannelMapping = communicationOps.createSlackChannelMapping;
  getSlackChannelMapping = communicationOps.getSlackChannelMapping;
  getSlackChannelMappingByChannelId = communicationOps.getSlackChannelMappingByChannelId;
  updateSlackChannelMapping = communicationOps.updateSlackChannelMapping;
  deleteSlackChannelMapping = communicationOps.deleteSlackChannelMapping;
  listSlackChannelMappings = communicationOps.listSlackChannelMappings;
  createSlackSyncHistory = communicationOps.createSlackSyncHistory;
  updateSlackSyncHistory = communicationOps.updateSlackSyncHistory;
  listSlackSyncHistory = communicationOps.listSlackSyncHistory;
  findRawCommunicationByExternalSourceId = communicationOps.findRawCommunicationByExternalSourceId;
  listEmailMessageSiblingsByThreadId = communicationOps.listEmailMessageSiblingsByThreadId;
  listUnmatchedFrontSyncEmails = communicationOps.listUnmatchedFrontSyncEmails;
  listUnmatchedFrontSyncEmailsByParticipant = communicationOps.listUnmatchedFrontSyncEmailsByParticipant;
  listUnmatchedRawCommunications = communicationOps.listUnmatchedRawCommunications;
  listUnmatchedSlackMessages = communicationOps.listUnmatchedSlackMessages;
  createPandadocDocument = communicationOps.createPandadocDocument;
  getPandadocDocument = communicationOps.getPandadocDocument;
  getPandadocDocumentByDocumentId = communicationOps.getPandadocDocumentByDocumentId;
  updatePandadocDocument = communicationOps.updatePandadocDocument;
  listPandadocDocuments = communicationOps.listPandadocDocuments;
  linkPandadocDocumentToClient = communicationOps.linkPandadocDocumentToClient;
  getPandadocDocumentsByClient = communicationOps.getPandadocDocumentsByClient;
  getClientConversationSummary = communicationOps.getClientConversationSummary;
  upsertClientConversationSummary = communicationOps.upsertClientConversationSummary;

  getClientAgentMemory = agentOps.getClientAgentMemory;
  getClientAgentMemoryByType = agentOps.getClientAgentMemoryByType;
  createClientAgentMemory = agentOps.createClientAgentMemory;
  upsertClientAgentMemory = agentOps.upsertClientAgentMemory;
  updateClientAgentMemory = agentOps.updateClientAgentMemory;
  deleteClientAgentMemory = agentOps.deleteClientAgentMemory;
  getAllAgentMemories = agentOps.getAllAgentMemories;
  penalizeAgentMemoryWeight = agentOps.penalizeAgentMemoryWeight;
  boostAgentMemoryWeight = agentOps.boostAgentMemoryWeight;
  getAgentKnowledgeByClient = agentOps.getAgentKnowledgeByClient;
  getAgentKnowledgeEntry = agentOps.getAgentKnowledgeEntry;
  createAgentKnowledgeEntry = agentOps.createAgentKnowledgeEntry;
  upsertAgentKnowledgeEntry = agentOps.upsertAgentKnowledgeEntry;
  updateAgentKnowledgeEntry = agentOps.updateAgentKnowledgeEntry;
  deleteAgentKnowledgeEntry = agentOps.deleteAgentKnowledgeEntry;
  bulkUpsertAgentKnowledge = agentOps.bulkUpsertAgentKnowledge;
  createAgentFeedback = agentOps.createAgentFeedback;
  getAgentFeedbackByTarget = agentOps.getAgentFeedbackByTarget;
  getAgentFeedbackByClient = agentOps.getAgentFeedbackByClient;
  listAgentFeedback = agentOps.listAgentFeedback;
  createAgentMatchDecision = agentOps.createAgentMatchDecision;
  getAgentMatchDecision = agentOps.getAgentMatchDecision;
  updateAgentMatchDecision = agentOps.updateAgentMatchDecision;
  listAgentMatchDecisions = agentOps.listAgentMatchDecisions;
  getAgentMatchDecisionStatsInWindow = agentOps.getAgentMatchDecisionStatsInWindow;
  getAgentMatchStats = agentOps.getAgentMatchStats;
  getClientAgentChatMessages = agentOps.getClientAgentChatMessages;
  createClientAgentChatMessage = agentOps.createClientAgentChatMessage;
  deleteClientAgentChatMessages = agentOps.deleteClientAgentChatMessages;

  upsertOperationalFilterMemory = agentOps.upsertOperationalFilterMemory;
  getOperationalFilterMemoryBySignals = agentOps.getOperationalFilterMemoryBySignals;
  getAllOperationalFilterMemories = agentOps.getAllOperationalFilterMemories;
  penalizeOperationalFilterMemory = agentOps.penalizeOperationalFilterMemory;
  deleteOperationalFilterMemory = agentOps.deleteOperationalFilterMemory;

  createClientDailyJudgment = dailyJudgmentOps.createClientDailyJudgment;
  getClientDailyJudgment = dailyJudgmentOps.getClientDailyJudgment;
  getClientDailyJudgmentByDate = dailyJudgmentOps.getClientDailyJudgmentByDate;
  getClientDailyJudgments = dailyJudgmentOps.getClientDailyJudgments;
  upsertClientDailyJudgment = dailyJudgmentOps.upsertClientDailyJudgment;
  listClientDailyJudgments = dailyJudgmentOps.listClientDailyJudgments;
  createClientCommunicationInsight = dailyJudgmentOps.createClientCommunicationInsight;
  getClientCommunicationInsightByCommId = dailyJudgmentOps.getClientCommunicationInsightByCommId;
  listClientCommunicationInsights = dailyJudgmentOps.listClientCommunicationInsights;
  createClientRelationshipSignal = dailyJudgmentOps.createClientRelationshipSignal;
  getClientRelationshipSignals = dailyJudgmentOps.getClientRelationshipSignals;
  upsertClientRelationshipSignal = dailyJudgmentOps.upsertClientRelationshipSignal;
  listClientRelationshipSignals = dailyJudgmentOps.listClientRelationshipSignals;
  getClientOpenAsks = dailyJudgmentOps.getClientOpenAsks;
  createClientOpenAsk = dailyJudgmentOps.createClientOpenAsk;
  getClientOpenAsk = dailyJudgmentOps.getClientOpenAsk;
  updateClientOpenAsk = dailyJudgmentOps.updateClientOpenAsk;
  listClientOpenAsks = dailyJudgmentOps.listClientOpenAsks;
  createClientSavePlay = dailyJudgmentOps.createClientSavePlay;
  getClientSavePlay = dailyJudgmentOps.getClientSavePlay;
  listClientSavePlays = dailyJudgmentOps.listClientSavePlays;
  updateClientSavePlay = dailyJudgmentOps.updateClientSavePlay;
  deleteClientSavePlay = dailyJudgmentOps.deleteClientSavePlay;
  createClientConcernIntel = dailyJudgmentOps.createClientConcernIntel;
  listRecentConcernIntel = dailyJudgmentOps.listRecentConcernIntel;

  createTwilioConversation = twilioOps.createTwilioConversation;
  getTwilioConversation = twilioOps.getTwilioConversation;
  getTwilioConversationByPhone = twilioOps.getTwilioConversationByPhone;
  updateTwilioConversation = twilioOps.updateTwilioConversation;
  listTwilioConversations = twilioOps.listTwilioConversations;
  markTwilioConversationRead = twilioOps.markTwilioConversationRead;
  createTwilioMessage = twilioOps.createTwilioMessage;
  getTwilioMessage = twilioOps.getTwilioMessage;
  listTwilioMessages = twilioOps.listTwilioMessages;
  updateTwilioMessage = twilioOps.updateTwilioMessage;
  createTwilioCall = twilioOps.createTwilioCall;
  getTwilioCall = twilioOps.getTwilioCall;
  getTwilioCallByTwilioSid = twilioOps.getTwilioCallByTwilioSid;
  updateTwilioCall = twilioOps.updateTwilioCall;
  listTwilioCalls = twilioOps.listTwilioCalls;
  findClientByPhone = twilioOps.findClientByPhone;
  searchClientContactsByPhone = twilioOps.searchClientContactsByPhone;
  getClientSuggestionsForPhone = twilioOps.getClientSuggestionsForPhone;

  listAgentMatchSettings = agentMatchSettingsOps.listAgentMatchSettings;
  upsertAgentMatchSetting = agentMatchSettingsOps.upsertAgentMatchSetting;
  deleteAgentMatchSetting = agentMatchSettingsOps.deleteAgentMatchSetting;
  recordAgentMatchSettingHistory = agentMatchSettingsOps.recordAgentMatchSettingHistory;
  listAgentMatchSettingHistory = agentMatchSettingsOps.listAgentMatchSettingHistory;
  updateAgentMatchSettingHistoryDelivery = agentMatchSettingsOps.updateAgentMatchSettingHistoryDelivery;
  getAgentMatchSettingHistoryById = agentMatchSettingsOps.getAgentMatchSettingHistoryById;

  // ---- Booking tool (Task #840) ----
  getBookingPageById = bookingOps.getBookingPageById;
  getBookingPageBySlug = bookingOps.getBookingPageBySlug;
  getBookingPageByUserId = bookingOps.getBookingPageByUserId;
  listBookingPages = bookingOps.listBookingPages;
  createBookingPage = bookingOps.createBookingPage;
  updateBookingPage = bookingOps.updateBookingPage;
  deleteBookingPage = bookingOps.deleteBookingPage;
  listAvailabilityRules = bookingOps.listAvailabilityRules;
  createAvailabilityRule = bookingOps.createAvailabilityRule;
  deleteAvailabilityRule = bookingOps.deleteAvailabilityRule;
  replaceAvailabilityRules = bookingOps.replaceAvailabilityRules;
  listAvailabilityOverrides = bookingOps.listAvailabilityOverrides;
  upsertAvailabilityOverride = bookingOps.upsertAvailabilityOverride;
  getAvailabilityOverride = bookingOps.getAvailabilityOverride;
  deleteAvailabilityOverride = bookingOps.deleteAvailabilityOverride;
  listBookingMeetingTypes = bookingOps.listBookingMeetingTypes;
  getBookingMeetingType = bookingOps.getBookingMeetingType;
  createBookingMeetingType = bookingOps.createBookingMeetingType;
  updateBookingMeetingType = bookingOps.updateBookingMeetingType;
  deleteBookingMeetingType = bookingOps.deleteBookingMeetingType;
  getScheduledMeetingById = bookingOps.getScheduledMeetingById;
  getScheduledMeetingByIdempotencyKey = bookingOps.getScheduledMeetingByIdempotencyKey;
  createScheduledMeeting = bookingOps.createScheduledMeeting;
  updateScheduledMeeting = bookingOps.updateScheduledMeeting;
  listScheduledMeetingsForAm = bookingOps.listScheduledMeetingsForAm;
  listScheduledMeetingsForUser = bookingOps.listScheduledMeetingsForUser;
  listScheduledMeetingsForClient = bookingOps.listScheduledMeetingsForClient;
  listOverlappingScheduledMeetingsForAm = bookingOps.listOverlappingScheduledMeetingsForAm;
  findScheduledMeetingByZoomIds = bookingOps.findScheduledMeetingByZoomIds;
  getScheduledMeetingMatchStats = bookingOps.getScheduledMeetingMatchStats;
  createMeetingRecurrenceException = bookingOps.createMeetingRecurrenceException;
  upsertMeetingRecurrenceException = bookingOps.upsertMeetingRecurrenceException;
  listMeetingRecurrenceExceptionsForMaster = bookingOps.listMeetingRecurrenceExceptionsForMaster;
  getMeetingRecurrenceException = bookingOps.getMeetingRecurrenceException;
  getGoogleCalendarCredential = bookingOps.getGoogleCalendarCredential;
  listGoogleCalendarCredentials = bookingOps.listGoogleCalendarCredentials;
  upsertGoogleCalendarCredential = bookingOps.upsertGoogleCalendarCredential;
  updateGoogleCalendarCredential = bookingOps.updateGoogleCalendarCredential;
  deleteGoogleCalendarCredential = bookingOps.deleteGoogleCalendarCredential;
  createBookingClientToken = bookingOps.createBookingClientToken;
  findBookingClientTokenByHash = bookingOps.findBookingClientTokenByHash;
  markBookingClientTokenUsed = bookingOps.markBookingClientTokenUsed;
  listBookingClientTokensForClient = bookingOps.listBookingClientTokensForClient;

  // ---- Book commerce (Task #5096) ----
  upsertBookContact = bookCommerceOps.upsertBookContact;
  createBookCheckoutSession = bookCommerceOps.createBookCheckoutSession;
  createBookOrder = bookCommerceOps.createBookOrder;
  insertBookPaymentEvent = bookCommerceOps.insertBookPaymentEvent;
  setPaymentEventRetention = bookCommerceOps.setPaymentEventRetention;
  transitionBookOrderStatus = bookCommerceOps.transitionBookOrderStatus;
  grantBookEntitlement = bookCommerceOps.grantBookEntitlement;
  revokeBookEntitlement = bookCommerceOps.revokeBookEntitlement;
  createBookAuditApplication = bookCommerceOps.createBookAuditApplication;
  transitionBookAuditApplication = bookCommerceOps.transitionBookAuditApplication;
  upsertBookAppointment = bookCommerceOps.upsertBookAppointment;
  transitionBookAppointment = bookCommerceOps.transitionBookAppointment;
  insertBookProviderCorrelation = bookCommerceOps.insertBookProviderCorrelation;

  // ---- NoBull Sheets ----
  getSheetFolder = sheetsOps.getSheetFolder;
  listSheetFolders = sheetsOps.listSheetFolders;
  createSheetFolder = sheetsOps.createSheetFolder;
  updateSheetFolder = sheetsOps.updateSheetFolder;
  deleteSheetFolder = sheetsOps.deleteSheetFolder;

  getSheetWorkbook = sheetsOps.getSheetWorkbook;
  listSheetWorkbooks = sheetsOps.listSheetWorkbooks;
  listSheetWorkbooksPage = sheetsOps.listSheetWorkbooksPage;
  createSheetWorkbook = sheetsOps.createSheetWorkbook;
  updateSheetWorkbook = sheetsOps.updateSheetWorkbook;
  saveSheetWorkbookSnapshot = sheetsOps.saveSheetWorkbookSnapshot;
  deleteSheetWorkbook = sheetsOps.deleteSheetWorkbook;

  listSheetWorkbookPermissions = sheetsOps.listSheetWorkbookPermissions;
  getSheetWorkbookPermission = sheetsOps.getSheetWorkbookPermission;
  upsertSheetWorkbookPermission = sheetsOps.upsertSheetWorkbookPermission;
  deleteSheetWorkbookPermission = sheetsOps.deleteSheetWorkbookPermission;

  listSheetWorkbookRoleGrants = sheetsOps.listSheetWorkbookRoleGrants;
  getSheetWorkbookRoleGrant = sheetsOps.getSheetWorkbookRoleGrant;
  upsertSheetWorkbookRoleGrant = sheetsOps.upsertSheetWorkbookRoleGrant;
  deleteSheetWorkbookRoleGrant = sheetsOps.deleteSheetWorkbookRoleGrant;

  getWorkbookAccessLevel = sheetsOps.getWorkbookAccessLevel;
  canUserAccessWorkbook = sheetsOps.canUserAccessWorkbook;
  canUserWriteWorkbook = sheetsOps.canUserWriteWorkbook;
  acquireWorkbookLock = sheetsOps.acquireWorkbookLock;
  heartbeatWorkbookLock = sheetsOps.heartbeatWorkbookLock;
  releaseWorkbookLock = sheetsOps.releaseWorkbookLock;
  getWorkbookLock = sheetsOps.getWorkbookLock;
  pruneExpiredWorkbookLocks = sheetsOps.pruneExpiredWorkbookLocks;

  // ---- NoBull Sheets data blocks ----
  createSheetDataBlock = sheetsOps.createSheetDataBlock;
  getSheetDataBlock = sheetsOps.getSheetDataBlock;
  listSheetDataBlocks = sheetsOps.listSheetDataBlocks;
  listSheetDataBlocksForAutoRefresh = sheetsOps.listSheetDataBlocksForAutoRefresh;
  updateSheetDataBlock = sheetsOps.updateSheetDataBlock;
  deleteSheetDataBlock = sheetsOps.deleteSheetDataBlock;

  // ---- NoBull Sheets — duplicate & templates ----
  duplicateWorkbook = sheetsOps.duplicateWorkbook;
  createSheetTemplate = sheetsOps.createSheetTemplate;
  getSheetTemplate = sheetsOps.getSheetTemplate;
  listSheetTemplates = sheetsOps.listSheetTemplates;
  updateSheetTemplate = sheetsOps.updateSheetTemplate;
  deleteSheetTemplate = sheetsOps.deleteSheetTemplate;
  createWorkbookFromTemplate = sheetsOps.createWorkbookFromTemplate;
  saveWorkbookAsTemplate = sheetsOps.saveWorkbookAsTemplate;

  // ---- NoBull Sheets — version history & restore ----
  getSheetWorkbookVersion = sheetsOps.getSheetWorkbookVersion;
  listSheetWorkbookVersions = sheetsOps.listSheetWorkbookVersions;
  captureAutoVersion = sheetsOps.captureAutoVersion;
  saveManualVersion = sheetsOps.saveManualVersion;
  restoreSheetWorkbookVersion = sheetsOps.restoreSheetWorkbookVersion;

  // ---- NoBull Sheets — published dashboards ----
  getWorkbookDashboard = sheetsOps.getWorkbookDashboard;
  publishWorkbookAsDashboard = sheetsOps.publishWorkbookAsDashboard;
  unpublishWorkbookDashboard = sheetsOps.unpublishWorkbookDashboard;
  listPublishedDashboards = sheetsOps.listPublishedDashboards;
  canUserViewDashboard = sheetsOps.canUserViewDashboard;

  // ---- NoBull Sheets — activity trail ----
  logSheetActivity = sheetsOps.logSheetActivity;
  listSheetWorkbookActivity = sheetsOps.listSheetWorkbookActivity;
  getSheetWorkbookLastActivityMap = sheetsOps.getSheetWorkbookLastActivityMap;

  // ---- NoBull Docs (Task #4024) ----
  getDocDocument = docsOps.getDocDocument;
  listDocDocuments = docsOps.listDocDocuments;
  listDocDocumentsPage = docsOps.listDocDocumentsPage;
  listDocDocumentsByClient = docsOps.listDocDocumentsByClient;
  createDocDocument = docsOps.createDocDocument;
  updateDocDocument = docsOps.updateDocDocument;
  saveDocDocumentSnapshot = docsOps.saveDocDocumentSnapshot;
  deleteDocDocument = docsOps.deleteDocDocument;

  listDocDocumentPermissions = docsOps.listDocDocumentPermissions;
  getDocDocumentPermission = docsOps.getDocDocumentPermission;
  upsertDocDocumentPermission = docsOps.upsertDocDocumentPermission;
  deleteDocDocumentPermission = docsOps.deleteDocDocumentPermission;
  getDocAccessLevel = docsOps.getDocAccessLevel;

  acquireDocumentLock = docsOps.acquireDocumentLock;
  heartbeatDocumentLock = docsOps.heartbeatDocumentLock;
  releaseDocumentLock = docsOps.releaseDocumentLock;
  getDocumentLock = docsOps.getDocumentLock;
  pruneExpiredDocumentLocks = docsOps.pruneExpiredDocumentLocks;

  getDocDocumentVersion = docsOps.getDocDocumentVersion;
  listDocDocumentVersions = docsOps.listDocDocumentVersions;
  captureDocAutoVersion = docsOps.captureDocAutoVersion;
  saveDocManualVersion = docsOps.saveDocManualVersion;
  restoreDocDocumentVersion = docsOps.restoreDocDocumentVersion;

  logDocActivity = docsOps.logDocActivity;
  listDocDocumentActivity = docsOps.listDocDocumentActivity;
}

export const storage = new DatabaseStorage();
