// @db-pool-intent: ambient
  //
  // Task #1721 Phase 2.1 / Task #1723: this file calls `getDb()`. The
  // intent above declares which pool every `getDb()` call in this
  // module is expected to land on. See `scripts/lint-db-pool-tenancy.ts`
  // for the contract and `server/db.ts` for the routing.

  import {
  type CommandPanel, type InsertCommandPanel, commandPanels,
  type CommandPanelKeyCall, type InsertCommandPanelKeyCall, commandPanelKeyCalls,
  type CommandPanelRerRecording, type InsertCommandPanelRerRecording, commandPanelRerRecordings,
  type CommandPanelVersion, type InsertCommandPanelVersion, commandPanelVersions,
  type CommandPanelHistory, type InsertCommandPanelHistory, commandPanelHistory,
  type IntelligenceFeedEntry, type InsertIntelligenceFeedEntry, intelligenceFeedEntries,
  type UpdateIntelligenceFeedEntry, updateIntelligenceFeedEntrySchema,
  type ActionLogEntry, type InsertActionLogEntry, actionLogEntries,
  type UpdateActionLogEntry, updateActionLogEntrySchema,
  clients,
  users,
} from "@shared/schema";
import { getDb, withDbAttribution } from "../db";
import { desc, eq, and, gte, lte, ilike, isNull, ne, or, sql } from "drizzle-orm";
import { normalizeProductList } from "../utils/productResolution";

export function getMonthStart(date: Date = new Date()): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

export function getCurrentMonthKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

export function isReviewedThisMonth(lastReviewedAt: Date | string | null): boolean {
  if (!lastReviewedAt) return false;
  const reviewed = new Date(lastReviewedAt);
  if (isNaN(reviewed.getTime())) return false;
  return reviewed >= getMonthStart();
}

export async function getCommandPanel(clientId: string): Promise<CommandPanel | undefined> {
  const [panel] = await getDb().select().from(commandPanels).where(eq(commandPanels.clientId, clientId));
  return panel;
}

export async function upsertCommandPanel(data: InsertCommandPanel, preserveLastUpdatedAt?: boolean): Promise<CommandPanel> {
  const setData = preserveLastUpdatedAt ? data : { ...data, lastUpdatedAt: new Date() };
  const [panel] = await getDb().insert(commandPanels)
    .values(data)
    .onConflictDoUpdate({
      target: [commandPanels.clientId],
      set: setData,
    })
    .returning();
  return panel;
}

export async function markCommandPanelReviewed(clientId: string, userId: string): Promise<CommandPanel | undefined> {
  const existing = await getCommandPanel(clientId);
  if (!existing) {
    const [client] = await getDb().select({ products: clients.products }).from(clients).where(eq(clients.id, clientId));
    const productTypes = client?.products ? normalizeProductList(client.products) : [];
    const [panel] = await getDb().insert(commandPanels).values({
      clientId,
      productTypes: productTypes.length > 0 ? productTypes : undefined,
      lastReviewedAt: new Date(),
      lastReviewedBy: userId,
    }).returning();
    return panel;
  }
  const [updated] = await getDb().update(commandPanels)
    .set({ lastReviewedAt: new Date(), lastReviewedBy: userId, lastUpdatedAt: new Date() })
    .where(eq(commandPanels.clientId, clientId))
    .returning();
  return updated;
}

// Task #4038: summaries also carry the product/budget columns so the client
// list can flag "product selected but budget NULL" gaps without opening each
// panel. The missing-budget derivation itself lives in the route.
export async function getAllCommandPanelSummaries(): Promise<{
  clientId: string;
  lastReviewedAt: Date | null;
  productTypes: string[] | null;
  lsaBudget: number | null;
  googleAdsBudget: number | null;
  webinarBudget: number | null;
}[]> {
  return getDb().select({
    clientId: commandPanels.clientId,
    lastReviewedAt: commandPanels.lastReviewedAt,
    productTypes: commandPanels.productTypes,
    lsaBudget: commandPanels.lsaBudget,
    googleAdsBudget: commandPanels.googleAdsBudget,
    webinarBudget: commandPanels.webinarBudget,
  }).from(commandPanels);
}

export async function getKeyCallsForClient(clientId: string): Promise<CommandPanelKeyCall[]> {
  return getDb().select().from(commandPanelKeyCalls)
    .where(eq(commandPanelKeyCalls.clientId, clientId));
}

export async function upsertKeyCall(data: InsertCommandPanelKeyCall): Promise<CommandPanelKeyCall> {
  const [row] = await getDb()
    .insert(commandPanelKeyCalls)
    .values(data)
    .onConflictDoUpdate({
      target: [commandPanelKeyCalls.commandPanelId, commandPanelKeyCalls.callType],
      set: {
        rawCommunicationRecordId: data.rawCommunicationRecordId,
        assignedBy: data.assignedBy,
        assignedAt: new Date(),
      },
    })
    .returning();
  return row;
}

export async function deleteKeyCall(clientId: string, callType: string): Promise<void> {
  await getDb().delete(commandPanelKeyCalls)
    .where(and(
      eq(commandPanelKeyCalls.clientId, clientId),
      eq(commandPanelKeyCalls.callType, callType),
    ));
}

export async function getRerRecordingsForClient(clientId: string): Promise<CommandPanelRerRecording[]> {
  return getDb().select().from(commandPanelRerRecordings)
    .where(eq(commandPanelRerRecordings.clientId, clientId))
    .orderBy(desc(commandPanelRerRecordings.reportingMonth));
}

export async function createRerRecording(
  data: InsertCommandPanelRerRecording,
): Promise<{ recording: CommandPanelRerRecording; duplicate: boolean }> {
  const inserted = await getDb()
    .insert(commandPanelRerRecordings)
    .values(data)
    .onConflictDoNothing({
      target: [
        commandPanelRerRecordings.clientId,
        commandPanelRerRecordings.rawCommunicationRecordId,
        commandPanelRerRecordings.reportingMonth,
      ],
    })
    .returning();
  if (inserted.length > 0) {
    return { recording: inserted[0], duplicate: false };
  }
  const [existing] = await getDb()
    .select()
    .from(commandPanelRerRecordings)
    .where(and(
      eq(commandPanelRerRecordings.clientId, data.clientId),
      eq(commandPanelRerRecordings.rawCommunicationRecordId, data.rawCommunicationRecordId),
      eq(commandPanelRerRecordings.reportingMonth, data.reportingMonth),
    ));
  if (!existing) {
    throw new Error("Failed to create or fetch RER recording after unique-constraint conflict");
  }
  return { recording: existing, duplicate: true };
}

export async function deleteRerRecording(id: string, clientId?: string): Promise<void> {
  const conditions = [eq(commandPanelRerRecordings.id, id)];
  if (clientId) {
    conditions.push(eq(commandPanelRerRecordings.clientId, clientId));
  }
  await getDb().delete(commandPanelRerRecordings)
    .where(and(...conditions));
}

// #662: Bulk-delete the key-call rows that reference a given raw communication
// (optionally scoped to a single client). Used by the Command-Panel undo-claim
// path so that reverting a claim also removes the key-call entry it created.
export async function deleteKeyCallsByRawCommunication(
  rawCommunicationRecordId: string,
  clientId?: string,
): Promise<number> {
  const conditions = [eq(commandPanelKeyCalls.rawCommunicationRecordId, rawCommunicationRecordId)];
  if (clientId) {
    conditions.push(eq(commandPanelKeyCalls.clientId, clientId));
  }
  const deleted = await getDb().delete(commandPanelKeyCalls)
    .where(and(...conditions))
    .returning({ id: commandPanelKeyCalls.id });
  return deleted.length;
}

// #662: Bulk-delete the RER recording rows that reference a given raw
// communication (optionally scoped to a single client). Used by the
// Command-Panel undo-claim path.
export async function deleteRerRecordingsByRawCommunication(
  rawCommunicationRecordId: string,
  clientId?: string,
): Promise<number> {
  const conditions = [eq(commandPanelRerRecordings.rawCommunicationRecordId, rawCommunicationRecordId)];
  if (clientId) {
    conditions.push(eq(commandPanelRerRecordings.clientId, clientId));
  }
  const deleted = await getDb().delete(commandPanelRerRecordings)
    .where(and(...conditions))
    .returning({ id: commandPanelRerRecordings.id });
  return deleted.length;
}

export async function getCommandPanelVersions(clientId: string): Promise<CommandPanelVersion[]> {
  return getDb().select().from(commandPanelVersions)
    .where(eq(commandPanelVersions.clientId, clientId))
    .orderBy(desc(commandPanelVersions.changedAt));
}

export async function createCommandPanelVersion(data: InsertCommandPanelVersion): Promise<CommandPanelVersion> {
  const [version] = await getDb().insert(commandPanelVersions).values(data).returning();
  return version;
}

export async function getCommandPanelHistory(clientId: string, filters?: {
  fieldName?: string;
  changedBy?: string;
  dateFrom?: Date;
  dateTo?: Date;
}): Promise<CommandPanelHistory[]> {
  const conditions = [eq(commandPanelHistory.clientId, clientId)];

  if (filters?.fieldName) {
    conditions.push(eq(commandPanelHistory.fieldName, filters.fieldName));
  }
  if (filters?.changedBy) {
    conditions.push(eq(commandPanelHistory.changedBy, filters.changedBy));
  }
  if (filters?.dateFrom) {
    conditions.push(gte(commandPanelHistory.createdAt, filters.dateFrom));
  }
  if (filters?.dateTo) {
    conditions.push(lte(commandPanelHistory.createdAt, filters.dateTo));
  }

  return getDb().select().from(commandPanelHistory)
    .where(and(...conditions))
    .orderBy(desc(commandPanelHistory.createdAt));
}

export async function createCommandPanelHistory(data: InsertCommandPanelHistory): Promise<CommandPanelHistory> {
  const [entry] = await getDb().insert(commandPanelHistory).values(data).returning();
  return entry;
}

export async function createIntelligenceFeedEntry(data: InsertIntelligenceFeedEntry): Promise<IntelligenceFeedEntry> {
  const [entry] = await getDb().insert(intelligenceFeedEntries).values(data).returning();
  return entry;
}

export async function getIntelligenceFeedEntry(id: string): Promise<IntelligenceFeedEntry | undefined> {
  const [entry] = await getDb().select().from(intelligenceFeedEntries).where(eq(intelligenceFeedEntries.id, id));
  return entry;
}

export async function updateIntelligenceFeedEntry(id: string, clientId: string, data: UpdateIntelligenceFeedEntry): Promise<IntelligenceFeedEntry | undefined> {
  // Task #4380 (F8): runtime parse — clientId/createdBy stay out; unknown keys strip.
  const parsed = updateIntelligenceFeedEntrySchema.parse(data);
  const [entry] = await getDb().update(intelligenceFeedEntries)
    .set({ ...parsed, updatedAt: new Date() })
    .where(and(eq(intelligenceFeedEntries.id, id), eq(intelligenceFeedEntries.clientId, clientId)))
    .returning();
  return entry;
}

export async function listIntelligenceFeedEntries(clientId: string, filters?: {
  type?: string;
  author?: string;
  dateFrom?: Date;
  dateTo?: Date;
  status?: string;
  pinned?: boolean;
  search?: string;
}): Promise<IntelligenceFeedEntry[]> {
  const conditions = [eq(intelligenceFeedEntries.clientId, clientId)];

  if (filters?.type) {
    conditions.push(eq(intelligenceFeedEntries.entryType, filters.type));
  }
  if (filters?.author) {
    conditions.push(eq(intelligenceFeedEntries.createdBy, filters.author));
  }
  if (filters?.dateFrom) {
    conditions.push(gte(intelligenceFeedEntries.createdAt, filters.dateFrom));
  }
  if (filters?.dateTo) {
    conditions.push(lte(intelligenceFeedEntries.createdAt, filters.dateTo));
  }
  if (filters?.status) {
    conditions.push(eq(intelligenceFeedEntries.status, filters.status));
  }
  if (filters?.pinned !== undefined) {
    conditions.push(eq(intelligenceFeedEntries.pinned, filters.pinned));
  }
  if (filters?.search) {
    const searchPattern = `%${filters.search}%`;
    conditions.push(
      or(
        ilike(intelligenceFeedEntries.title, searchPattern),
        ilike(intelligenceFeedEntries.body, searchPattern),
      )!
    );
  }

  return getDb().select().from(intelligenceFeedEntries)
    .where(and(...conditions))
    .orderBy(desc(intelligenceFeedEntries.createdAt));
}

export async function createActionLogEntry(data: InsertActionLogEntry): Promise<ActionLogEntry> {
  const [entry] = await getDb().insert(actionLogEntries).values(data).returning();
  return entry;
}

export async function getActionLogEntry(id: string): Promise<ActionLogEntry | undefined> {
  const [entry] = await getDb().select().from(actionLogEntries).where(eq(actionLogEntries.id, id));
  return entry;
}

export async function updateActionLogEntry(id: string, clientId: string, data: UpdateActionLogEntry): Promise<ActionLogEntry | undefined> {
  // Task #4380 (F8): runtime parse — clientId/createdBy stay out; unknown keys strip.
  const parsed = updateActionLogEntrySchema.parse(data);
  const [entry] = await getDb().update(actionLogEntries)
    .set({ ...parsed, updatedAt: new Date() })
    .where(and(eq(actionLogEntries.id, id), eq(actionLogEntries.clientId, clientId)))
    .returning();
  return entry;
}

export async function listActionLogEntries(clientId: string, filters?: {
  actionType?: string;
  actor?: string;
  dateFrom?: Date;
  dateTo?: Date;
  impactedSystem?: string;
  search?: string;
}): Promise<ActionLogEntry[]> {
  const conditions = [eq(actionLogEntries.clientId, clientId)];

  if (filters?.actionType) {
    conditions.push(eq(actionLogEntries.actionType, filters.actionType));
  }
  if (filters?.actor) {
    conditions.push(eq(actionLogEntries.createdBy, filters.actor));
  }
  if (filters?.dateFrom) {
    conditions.push(gte(actionLogEntries.createdAt, filters.dateFrom));
  }
  if (filters?.dateTo) {
    conditions.push(lte(actionLogEntries.createdAt, filters.dateTo));
  }
  if (filters?.impactedSystem) {
    conditions.push(sql`${filters.impactedSystem} = ANY(${actionLogEntries.impactedSystems})`);
  }
  if (filters?.search) {
    const searchPattern = `%${filters.search}%`;
    conditions.push(
      or(
        ilike(actionLogEntries.title, searchPattern),
        ilike(actionLogEntries.whatChanged, searchPattern),
        ilike(actionLogEntries.whyChanged, searchPattern),
      )!
    );
  }

  return getDb().select().from(actionLogEntries)
    .where(and(...conditions))
    .orderBy(desc(actionLogEntries.createdAt));
}

// ── Task #4874: cross-client Win Feed ────────────────────────────────────────
// Team-wide read of recent `win_progress` intel entries for the OS dashboard.
// Published entries only (status != 'archived' — archived means retracted),
// archived clients excluded (NULL-safe: legacy rows may carry is_archived
// NULL). The demo flag is returned raw so the client can apply the global
// hide-demo toggle; the weekly win tracker (internalUsageStorage) excludes
// demo wins server-side instead because there it is target math, not a
// display preference.
export interface RecentWinRow {
  id: string;
  clientId: string;
  clientFirmName: string;
  clientIsDemo: boolean;
  title: string;
  body: string | null;
  createdAt: Date | null;
  createdBy: string;
  authorFirstName: string | null;
  authorLastName: string | null;
  authorEmail: string | null;
}

export async function listRecentWins(limit: number): Promise<RecentWinRow[]> {
  return withDbAttribution("commandCenter:listRecentWins", async () => {
    const rows = await getDb()
      .select({
        id: intelligenceFeedEntries.id,
        clientId: intelligenceFeedEntries.clientId,
        clientFirmName: clients.firmName,
        clientIsDemo: clients.isDemo,
        title: intelligenceFeedEntries.title,
        body: intelligenceFeedEntries.body,
        createdAt: intelligenceFeedEntries.createdAt,
        createdBy: intelligenceFeedEntries.createdBy,
        authorFirstName: users.firstName,
        authorLastName: users.lastName,
        authorEmail: users.email,
      })
      .from(intelligenceFeedEntries)
      .innerJoin(clients, eq(intelligenceFeedEntries.clientId, clients.id))
      .leftJoin(users, eq(intelligenceFeedEntries.createdBy, users.id))
      .where(and(
        eq(intelligenceFeedEntries.entryType, "win_progress"),
        ne(intelligenceFeedEntries.status, "archived"),
        or(eq(clients.isArchived, false), isNull(clients.isArchived)),
      ))
      .orderBy(desc(intelligenceFeedEntries.createdAt))
      .limit(limit);
    return rows.map((r) => ({ ...r, clientIsDemo: r.clientIsDemo === true }));
  });
}
