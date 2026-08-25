// Stub for `server/services/clickUpClient` used ONLY by the service-desk
// template-enforcement smoke test (Task #3395).
//
// Re-exports the real module verbatim (keeping every other binding intact for
// transitive consumers) and overrides ONLY the four functions the template
// enforcement block in tryCompleteSdTicketMapping calls, recording every call
// to a globalThis ledger the test asserts against. No real HTTP ever fires.

export * from "../server/services/clickUpClient";

function ledger() {
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

export async function createChecklist(token, taskId, name) {
  ledger().createChecklist.push({ token, taskId, name });
  return { checklist: { id: `stub-checklist-${ledger().createChecklist.length}` } };
}

export async function createChecklistItem(token, checklistId, body) {
  ledger().createChecklistItem.push({ token, checklistId, body });
  return { checklist: { id: checklistId } };
}

export async function createTaskComment(token, taskId, body) {
  ledger().createTaskComment.push({ token, taskId, body });
  return { id: `stub-comment-${ledger().createTaskComment.length}` };
}

export async function updateTask(token, taskId, body) {
  ledger().updateTask.push({ token, taskId, body });
  return { id: taskId };
}
