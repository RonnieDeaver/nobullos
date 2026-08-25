// Test-only shim for `@radix-ui/react-alert-dialog`.
//
// Radix AlertDialog renders its content through a Portal + Presence pair
// that only mounts after layout-effect-driven state transitions. Under the
// raw jsdom + react-dom/client harness these tests use (no @testing-library
// DOM environment), that portal never mounts even when the trigger reports
// `data-state="open"`, so the dialog's confirm button is never queryable.
// That is a limitation of the third-party portal/animation machinery, not
// of the app code under test.
//
// This shim re-publishes the primitives `client/src/components/ui/alert-dialog.tsx`
// imports (`import * as AlertDialogPrimitive from "@radix-ui/react-alert-dialog"`)
// as inline pass-throughs: the content always renders next to the trigger,
// preserving every prop (`data-testid`, `className`, `onClick`, children) so
// a test can click `button-prod-actions-confirm` and exercise the real
// apply mutation. Wired in via a resolve hook in the shared
// `tests/helpers/heavyClientLoader.mjs` (wired via
// `tests/alert-dialog-mock-setup.mjs`).

import * as React from "react";

export const Root = ({ children }) => React.createElement(React.Fragment, null, children);
export const Portal = ({ children }) => React.createElement(React.Fragment, null, children);

export const Trigger = React.forwardRef(function Trigger({ asChild, children, ...rest }, ref) {
  if (asChild && React.isValidElement(children)) {
    return React.cloneElement(children, { ref, ...rest });
  }
  return React.createElement("button", { ref, ...rest }, children);
});
Trigger.displayName = "AlertDialogTrigger";

export const Overlay = React.forwardRef(function Overlay({ children, ...rest }, ref) {
  return React.createElement("div", { ref, ...rest }, children);
});
Overlay.displayName = "AlertDialogOverlay";

export const Content = React.forwardRef(function Content(
  // Strip Radix-only props so they don't land as unknown DOM attributes.
  { forceMount, onOpenAutoFocus, onCloseAutoFocus, onEscapeKeyDown, children, ...rest },
  ref,
) {
  return React.createElement("div", { ref, ...rest }, children);
});
Content.displayName = "AlertDialogContent";

export const Title = React.forwardRef(function Title({ children, ...rest }, ref) {
  return React.createElement("h2", { ref, ...rest }, children);
});
Title.displayName = "AlertDialogTitle";

export const Description = React.forwardRef(function Description({ children, ...rest }, ref) {
  return React.createElement("p", { ref, ...rest }, children);
});
Description.displayName = "AlertDialogDescription";

export const Action = React.forwardRef(function Action({ asChild, children, ...rest }, ref) {
  if (asChild && React.isValidElement(children)) {
    return React.cloneElement(children, { ref, ...rest });
  }
  return React.createElement("button", { ref, type: "button", ...rest }, children);
});
Action.displayName = "AlertDialogAction";

export const Cancel = React.forwardRef(function Cancel({ asChild, children, ...rest }, ref) {
  if (asChild && React.isValidElement(children)) {
    return React.cloneElement(children, { ref, ...rest });
  }
  return React.createElement("button", { ref, type: "button", ...rest }, children);
});
Cancel.displayName = "AlertDialogCancel";

export default { Root, Portal, Trigger, Overlay, Content, Title, Description, Action, Cancel };
