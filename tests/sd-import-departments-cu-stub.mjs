// Stub for `server/services/clickUpClient` used ONLY by the service-desk
// import-departments route test (Task #3540, extended Task #3543).
//
// Re-exports the real module verbatim and overrides the four custom-field
// hierarchy-level functions so the test can simulate inherited fields at
// any level without real HTTP.  Each override reads from a globalThis key:
//   __sdImportDeptCuFields          → list-level (GET /v2/list/{id}/field)
//   __sdImportDeptCuFolderFields    → folder-level (GET /v2/folder/{id}/field)
//   __sdImportDeptCuSpaceFields     → space-level (GET /v2/space/{id}/field)
//   __sdImportDeptCuWorkspaceFields → workspace-level (GET /v2/team/{id}/field)
// When a key is undefined the stub returns [] (no fields at that level).
// No real HTTP ever fires.

export * from "../server/services/clickUpClient";

export async function getCustomFields(_token, _listId) {
  return globalThis.__sdImportDeptCuFields ?? [];
}

export async function getCustomFieldsForFolder(_token, _folderId) {
  return globalThis.__sdImportDeptCuFolderFields ?? [];
}

export async function getCustomFieldsForSpace(_token, _spaceId) {
  return globalThis.__sdImportDeptCuSpaceFields ?? [];
}

export async function getCustomFieldsForWorkspace(_token, _workspaceId) {
  return globalThis.__sdImportDeptCuWorkspaceFields ?? [];
}
