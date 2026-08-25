// Stub for `server/services/clickUpClient` used ONLY by the service-desk
// submit status-fallback test (Task #3569).
//
// Re-exports the real module verbatim and overrides:
//   getList      — returns globalThis.__sdSubmitGetListResult
//   createTask   — records call payload in globalThis.__sdSubmitCreateTaskCalls,
//                  throws globalThis.__sdSubmitCreateTaskError if set,
//                  otherwise returns globalThis.__sdSubmitCreateTaskResult
//
// All other real ClickUp client functions pass through untouched.

export * from "../server/services/clickUpClient";

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

// Task #3618: record watcher/assignee updates (checker-watcher wiring).
export async function updateTask(_token, taskId, body) {
  if (!Array.isArray(globalThis.__sdSubmitUpdateTaskCalls)) {
    globalThis.__sdSubmitUpdateTaskCalls = [];
  }
  globalThis.__sdSubmitUpdateTaskCalls.push({ taskId, body: { ...body } });
  return {};
}

// Task #3656: record checklist creation + per-item assignee payloads.
export async function createChecklist(_token, taskId, name) {
  if (!Array.isArray(globalThis.__sdSubmitCreateChecklistCalls)) {
    globalThis.__sdSubmitCreateChecklistCalls = [];
  }
  globalThis.__sdSubmitCreateChecklistCalls.push({ taskId, name });
  return { checklist: { id: `stub-checklist-${globalThis.__sdSubmitCreateChecklistCalls.length}` } };
}

export async function createChecklistItem(_token, checklistId, body) {
  if (!Array.isArray(globalThis.__sdSubmitCreateChecklistItemCalls)) {
    globalThis.__sdSubmitCreateChecklistItemCalls = [];
  }
  globalThis.__sdSubmitCreateChecklistItemCalls.push({ checklistId, body: { ...body } });
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
