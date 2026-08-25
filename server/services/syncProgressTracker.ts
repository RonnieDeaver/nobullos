export interface SyncProgress {
  isRunning: boolean;
  currentPage: number;
  conversationsScanned: number;
  conversationsKept: number;
  conversationsFiltered: number;
  startedAt: string | null;
}

export interface SyncCycleSummary {
  matched: number;
  unmatched: number;
  skipped: number;
  total: number;
  completedAt: string;
}

export interface IntegrationSyncState {
  progress: SyncProgress;
  lastCycle: SyncCycleSummary | null;
}

const defaultProgress = (): SyncProgress => ({
  isRunning: false,
  currentPage: 0,
  conversationsScanned: 0,
  conversationsKept: 0,
  conversationsFiltered: 0,
  startedAt: null,
});

const syncStates: Record<string, IntegrationSyncState> = {
  front: { progress: defaultProgress(), lastCycle: null },
  zoom: { progress: defaultProgress(), lastCycle: null },
  slack: { progress: defaultProgress(), lastCycle: null },
};

export function startSyncProgress(integration: string): void {
  syncStates[integration] = {
    ...syncStates[integration],
    progress: {
      isRunning: true,
      currentPage: 0,
      conversationsScanned: 0,
      conversationsKept: 0,
      conversationsFiltered: 0,
      startedAt: new Date().toISOString(),
    },
  };
}

export function updateSyncProgress(integration: string, update: Partial<SyncProgress>): void {
  if (!syncStates[integration]) return;
  syncStates[integration].progress = {
    ...syncStates[integration].progress,
    ...update,
  };
}

export function completeSyncCycle(integration: string, summary: Omit<SyncCycleSummary, "completedAt">): void {
  syncStates[integration] = {
    progress: defaultProgress(),
    lastCycle: {
      ...summary,
      completedAt: new Date().toISOString(),
    },
  };
}

export function getSyncState(integration: string): IntegrationSyncState {
  return syncStates[integration] || { progress: defaultProgress(), lastCycle: null };
}

export function getAllSyncStates(): Record<string, IntegrationSyncState> {
  return { ...syncStates };
}
