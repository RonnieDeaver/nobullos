// In-memory stub for `server/services/clickUpClient` used by
// tests/sd-transition-waiting-fields.test.ts. Re-exports the REAL module
// (so unrelated import chains keep working) and overrides only the
// functions the transition route drives, recording every call on
// globalThis.__sdCuCalls so the test can assert exactly which ClickUp
// writes happened.
export * from "../../server/services/clickUpClient";

globalThis.__sdCuCalls = globalThis.__sdCuCalls ?? [];

function record(fn, args) {
  globalThis.__sdCuCalls.push({ fn, args });
}

export async function setCustomFieldValue(token, taskId, fieldId, value) {
  record("setCustomFieldValue", { token, taskId, fieldId, value });
}

export async function updateTask(token, taskId, patch) {
  record("updateTask", { token, taskId, patch });
  return { id: taskId, ...patch };
}

export async function createTaskComment(token, taskId, body) {
  record("createTaskComment", { token, taskId, body });
  return { id: "stub-comment" };
}

export async function addTaskLink(token, taskId, linkedTaskId) {
  record("addTaskLink", { token, taskId, linkedTaskId });
}

// Setup-time field validation (Task #3176): the verify checklist and the
// config PUT cross-check bound waiting-on UUIDs against the List's real
// fields. Tests control the "real" field list via globalThis.__sdCuFields.
export async function getList(token, listId) {
  record("getList", { token, listId });
  return { id: listId, name: "All Service Requests", statuses: [] };
}

export async function getCustomFields(token, listId) {
  record("getCustomFields", { token, listId });
  return globalThis.__sdCuFields ?? [];
}
