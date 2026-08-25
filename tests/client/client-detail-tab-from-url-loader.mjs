// Node ESM module loader hook for the ClientDetail "?tab=" routing DOM test.
//
// `ClientDetail.tsx` statically imports a large set of heavy feature panels
// (CommandPanel, LocalDominanceDashboard, IntelligenceFeed, the booking
// scheduling panel, etc.). Several of those transitively pull in browser-only
// dependencies (`maplibre-gl` WebGL, `@uppy/*`, `react-pdf`, `.css`
// side-effects) that the bare tsx/jsdom harness can't evaluate at module load.
//
// The behavior under test is purely ClientDetail's own `TAB_MAP` / `tabFromUrl`
// logic — which tab the Radix <Tabs> activates from the `?tab=` query param —
// so none of those panels' internals matter. We redirect each heavy component
// specifier to a tiny stub that renders nothing, and map any `.css` side-effect
// import to an empty module as a defensive catch-all.

const STUB_COMPONENT = "client-detail-stub:component";
const STUB_CSS = "client-detail-stub:css";
const STUB_CLERK = "client-detail-stub:clerk-react";

const STUBBED_COMPONENTS = new Set([
  "@/components/booking/ClientSchedulingPanel",
  "@/components/IntelligenceFeed",
  "@/components/ActionLog",
  "@/components/CommandPanel",
  "@/components/RawCommunicationLog",
  "@/components/LocalDominanceDashboard",
  "@/components/AgentProfile",
  "@/components/MatchDecisionAudit",
  "@/components/ClientAgentChat",
  "@/components/DailyJudgmentStream",
  "@/components/AgentKnowledgePanel",
  "@/components/BillingSection",
  "@/components/ClientMessaging",
]);

export async function resolve(specifier, context, nextResolve) {
  // Task #4349 — the Clerk auth migration rewired `@/hooks/use-auth` through
  // `@clerk/react`, whose hooks throw outside a live <ClerkProvider>. This
  // harness authenticates via the /api/auth/user fetch stub, so present a
  // loaded, signed-in Clerk session and let the REAL use-auth hook fetch the
  // DB user through the stub (role gating etc. stays genuine).
  if (specifier === "@clerk/react") {
    return { url: STUB_CLERK, shortCircuit: true, format: "module" };
  }
  if (STUBBED_COMPONENTS.has(specifier)) {
    return { url: STUB_COMPONENT, shortCircuit: true, format: "module" };
  }
  if (specifier.endsWith(".css")) {
    return { url: STUB_CSS, shortCircuit: true, format: "module" };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url === STUB_COMPONENT) {
    // Export a default no-op React component; that's the import shape every
    // stubbed panel uses in ClientDetail.
    const source = `
const Stub = () => null;
export default Stub;
`;
    return { format: "module", source, shortCircuit: true };
  }
  if (url === STUB_CSS) {
    return { format: "module", source: "export default {};", shortCircuit: true };
  }
  if (url === STUB_CLERK) {
    // Union of every export client/src imports from @clerk/react, so this
    // stub keeps working if other Clerk-consuming components join the
    // ClientDetail closure (see memory: test-stub-export-fanout).
    const source = `
export const useAuth = () => ({ isLoaded: true, isSignedIn: true });
export const useClerk = () => ({ signOut: async () => {} });
export const ClerkProvider = ({ children }) => children;
export const SignIn = () => null;
export const SignUp = () => null;
`;
    return { format: "module", source, shortCircuit: true };
  }
  return nextLoad(url, context);
}
