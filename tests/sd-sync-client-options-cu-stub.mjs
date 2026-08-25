// Stub for `server/services/clickUpClient` used by the sync-client-options
// route test (Task #3571).
// Reads list-level fields from globalThis.__sdSyncCuFields (default []).

export * from "../server/services/clickUpClient";

export async function getCustomFields(_token, _listId) {
  return globalThis.__sdSyncCuFields ?? [];
}

export async function getCustomFieldsForFolder(_token, _folderId) {
  return [];
}

export async function getCustomFieldsForSpace(_token, _spaceId) {
  return [];
}

export async function getCustomFieldsForWorkspace(_token, _workspaceId) {
  return [];
}
