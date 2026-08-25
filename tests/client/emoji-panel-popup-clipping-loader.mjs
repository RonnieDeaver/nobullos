// Node ESM loader for the emoji-panel popup-clipping guard test.
//
// MessageItem statically imports useCommsContext from "@/contexts/CommsContext",
// which drags in the full CommsProvider graph (auth, SSE, wouter). The test
// only needs userStatuses, so redirect that one module to a tiny stub.
// Also map .css side-effect imports to empty modules defensively.

const STUB_CTX = "emoji-clip-stub:comms-context";
const STUB_CSS = "emoji-clip-stub:css";

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@/contexts/CommsContext") {
    return { url: STUB_CTX, shortCircuit: true, format: "module" };
  }
  if (specifier.endsWith(".css")) {
    return { url: STUB_CSS, shortCircuit: true, format: "module" };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url === STUB_CTX) {
    const source = `
const STATE = {
  userStatuses: new Map(),
  onlineUserIds: [],
  refetchDrafts: () => {},
  addSseListener: () => () => {},
};
export function useCommsContext() {
  return STATE;
}
// Narrow-slice hook added by the comms-store split: popup surfaces (e.g.
// MessageItem's author-status entry) subscribe via useCommsSelector(selector);
// the stub just applies the selector to the same static state object.
export function useCommsSelector(selector) {
  return selector(STATE);
}
export function CommsProvider({ children }) { return children; }
`;
    return { format: "module", source, shortCircuit: true };
  }
  if (url === STUB_CSS) {
    return { format: "module", source: "export default {};", shortCircuit: true };
  }
  return nextLoad(url, context);
}
