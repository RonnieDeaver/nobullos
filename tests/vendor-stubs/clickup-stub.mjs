// Shared ClickUp vendor test stub for `server/services/clickUpClient`
// (Task #5313 — shared vendor test stubs instead of one-off).
//
// This module is a faithful superset of four originally independent
// one-off ClickUp stubs, consolidated here so any suite needing ClickUp
// coverage can import ONE working mock instead of authoring a new one.
// See TESTING.md, "Shared vendor test stubs", for the convention and for
// how a suite's resolve-hook loader wires this in.
//
// Consuming suites (each configures behavior through its own globalThis
// keys, documented per function below — no suite's keys collide with
// another's, so they compose safely in one module):
//   - service-desk-import-departments-route.test.ts (Task #3540/#3543/#5232)
//   - service-desk-submit-status-fallback.test.ts (Task #3569/#3618/#3656)
//   - service-desk-sync-client-options-route.test.ts (Task #3571)
//   - sd-template-enforcement.test.ts (Task #3395)
//
// Re-exports the real module verbatim and overrides only the functions
// below; every other real ClickUp client function passes through
// untouched. No real HTTP ever fires from an overridden function.
//
// `createChecklist`, `createChecklistItem`, and `updateTask` are each
// called by TWO different consumers (submit-status-fallback and
// template-enforcement) with different recording ledgers and return
// shapes. Each consuming suite's loader picks its behavior by appending a
// `?stubMode=...` query to the URL it redirects to (see
// sd-submit-status-fallback-loader.mjs / sd-template-enforcement-loader.mjs)
// — NOT a globalThis flag set from the loader file, because Node's
// `module.register()` customization hooks run in a separate hooks thread
// with its own realm, so a `globalThis` write there is invisible to this
// module's `globalThis` (module.register hooks vs. main-thread realm). The
// query string travels with the resolved URL itself, so it survives the
// thread boundary; a distinct URL per mode also gives each mode its own
// module instance, which is harmless here since only one mode is ever
// active per test process.

export * from "../../server/services/clickUpClient";

function stubMode() {
  const match = /[?&]stubMode=([^&]+)/.exec(import.meta.url);
  return match ? decodeURIComponent(match[1]) : undefined;
}

// ---- custom-field hierarchy reads ---------------------------------------
// Used by:
//   - import-departments: all four levels, keyed by
//     __sdImportDeptCuFields / __sdImportDeptCuFolderFields /
//     __sdImportDeptCuSpaceFields / __sdImportDeptCuWorkspaceFields.
//   - sync-client-options: list level only (__sdSyncCuFields); the other
//     three levels are never configured by that suite and correctly fall
//     through to their empty default below.
export async function getCustomFields(_token, _listId) {
  return globalThis.__sdImportDeptCuFields ?? globalThis.__sdSyncCuFields ?? [];
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

// ---- submit-status-fallback path -----------------------------------------
export async function getList(_token, _listId) {
  const err = globalThis.__sdSubmitGetListError;
  if (err) throw err;
  return globalThis.__sdSubmitGetListResult ?? { statuses: [] };
}

export async function getWorkspaceMembers(_token, _workspaceId) {
  return globalThis.__sdSubmitWorkspaceMembers ?? [];
}

export async function setCustomFieldValue(_token, taskId, fieldId, value) {
  if (!Array.isArray(globalThis.__sdSubmitSetFieldCalls)) {
    globalThis.__sdSubmitSetFieldCalls = [];
  }
  globalThis.__sdSubmitSetFieldCalls.push({ taskId, fieldId, value });
  return {};
}

export async function createTask(_token, _listId, body) {
  if (!Array.isArray(globalThis.__sdSubmitCreateTaskCalls)) {
    globalThis.__sdSubmitCreateTaskCalls = [];
  }
  globalThis.__sdSubmitCreateTaskCalls.push({ body: { ...body } });
  const err = globalThis.__sdSubmitCreateTaskError;
  if (err) throw err;
  return globalThis.__sdSubmitCreateTaskResult ?? {
    id: "task-stub-3569",
    url: "https://app.clickup.com/t/task-stub-3569",
    status: { status: "stub-default" },
  };
}

// ---- template-enforcement path ---------------------------------------
function templateLedger() {
  return (
    globalThis.__sdTemplateCuCalls ??
    (globalThis.__sdTemplateCuCalls = {
      createChecklist: [],
      createChecklistItem: [],
      createTaskComment: [],
      updateTask: [],
    })
  );
}

export async function createTaskComment(token, taskId, body) {
  const ledger = templateLedger();
  ledger.createTaskComment.push({ token, taskId, body });
  return { id: `stub-comment-${ledger.createTaskComment.length}` };
}

// ---- shared between submit-status-fallback and template-enforcement -----
// (each keeps its own recording ledger + return shape; dispatched by the
// consuming suite's declared __sdVendorClickUpStubMode).
export async function createChecklist(token, taskId, name) {
  if (stubMode() === "template-enforcement") {
    const ledger = templateLedger();
    ledger.createChecklist.push({ token, taskId, name });
    return { checklist: { id: `stub-checklist-${ledger.createChecklist.length}` } };
  }
  if (!Array.isArray(globalThis.__sdSubmitCreateChecklistCalls)) {
    globalThis.__sdSubmitCreateChecklistCalls = [];
  }
  globalThis.__sdSubmitCreateChecklistCalls.push({ taskId, name });
  return {
    checklist: { id: `stub-checklist-${globalThis.__sdSubmitCreateChecklistCalls.length}` },
  };
}

export async function createChecklistItem(token, checklistId, body) {
  if (stubMode() === "template-enforcement") {
    const ledger = templateLedger();
    ledger.createChecklistItem.push({ token, checklistId, body });
    return { checklist: { id: checklistId } };
  }
  if (!Array.isArray(globalThis.__sdSubmitCreateChecklistItemCalls)) {
    globalThis.__sdSubmitCreateChecklistItemCalls = [];
  }
  globalThis.__sdSubmitCreateChecklistItemCalls.push({ checklistId, body: { ...body } });
  return {};
}

export async function updateTask(token, taskId, body) {
  if (stubMode() === "template-enforcement") {
    const ledger = templateLedger();
    ledger.updateTask.push({ token, taskId, body });
    return { id: taskId };
  }
  if (!Array.isArray(globalThis.__sdSubmitUpdateTaskCalls)) {
    globalThis.__sdSubmitUpdateTaskCalls = [];
  }
  globalThis.__sdSubmitUpdateTaskCalls.push({ taskId, body: { ...body } });
  return {};
}
