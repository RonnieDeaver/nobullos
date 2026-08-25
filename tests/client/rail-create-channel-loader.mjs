// Node ESM loader for tests/client/rail-create-channel.test.tsx (Task #3235).
//
// The comms-store split gave NewChatPopover a narrow presence subscription
// (useCommsSelector((s) => s.onlineUserIds)) via "@/contexts/CommsContext".
// The real hook requires the CommsProvider store; this test mounts the
// popover standalone with stubbed fetch, so redirect the context module to a
// tiny static stub — the test asserts create-channel behavior, not presence.

const STUB_CTX = "rail-create-channel-stub:comms-context";

export async function resolve(specifier, context, nextResolve) {
  if (/contexts\/CommsContext(\.tsx?)?$/.test(specifier)) {
    return { url: STUB_CTX, shortCircuit: true, format: "module" };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url === STUB_CTX) {
    const source = `
const STATE = {
  userStatuses: new Map(),
  // string[] like CommsContextValue.onlineUserIds — NewChatPopover calls
  // .includes(u.id) on it, so a Set would TypeError once users are listed.
  onlineUserIds: [],
  refetchDrafts: () => {},
  addSseListener: () => () => {},
};
export function useCommsContext() { return STATE; }
export function useCommsSelector(selector) { return selector(STATE); }
export function CommsProvider({ children }) { return children; }
`;
    return { format: "module", source, shortCircuit: true };
  }
  return nextLoad(url, context);
}
