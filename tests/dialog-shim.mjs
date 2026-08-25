// Test-only shim for `@radix-ui/react-dialog`.
//
// Radix Dialog renders its content through a Portal + Presence pair that
// only mounts after layout-effect-driven state transitions. Under the raw
// jsdom + react-dom/client harness these tests use (no @testing-library DOM
// environment), that portal never mounts even when the trigger reports
// `data-state="open"`, so the dialog's form + submit button are never
// queryable. That is a limitation of the third-party portal/animation
// machinery, not of the app code under test.
//
// This shim re-publishes the primitives `client/src/components/ui/dialog.tsx`
// imports (`import * as DialogPrimitive from "@radix-ui/react-dialog"`) as
// inline pass-throughs. Crucially it still honours the controlled `open`
// prop on `Root`: the content only renders while `open` is truthy, so a test
// can mount the page, click the edit button (which flips `isOpen`), and then
// find the dialog's form / submit button. Wired in via a resolve hook in the
// shared `tests/helpers/heavyClientLoader.mjs` (wired via
// `tests/client-edit-data-access-mock-setup.mjs` and `tests/command-panel-gbp-setup.mjs`).

import * as React from "react";

const DialogContext = React.createContext({ open: false, onOpenChange: () => {} });

export const Root = ({ open, defaultOpen, onOpenChange, children }) => {
  // ClientManagement drives the dialog as a controlled component
  // (`open={isOpen}`), so honour the `open` prop. Fall back to defaultOpen
  // for any uncontrolled usage.
  const value = { open: !!(open ?? defaultOpen), onOpenChange: onOpenChange ?? (() => {}) };
  return React.createElement(DialogContext.Provider, { value }, children);
};

export const Portal = ({ children }) => {
  const { open } = React.useContext(DialogContext);
  return open ? React.createElement(React.Fragment, null, children) : null;
};

export const Trigger = React.forwardRef(function Trigger({ asChild, children, ...rest }, ref) {
  const { open, onOpenChange } = React.useContext(DialogContext);
  const onClick = (e) => {
    if (rest.onClick) rest.onClick(e);
    onOpenChange(!open);
  };
  if (asChild && React.isValidElement(children)) {
    return React.cloneElement(children, { ref, ...rest, onClick });
  }
  return React.createElement("button", { ref, ...rest, onClick }, children);
});
Trigger.displayName = "DialogTrigger";

export const Close = React.forwardRef(function Close({ asChild, children, ...rest }, ref) {
  const { onOpenChange } = React.useContext(DialogContext);
  const onClick = (e) => {
    if (rest.onClick) rest.onClick(e);
    onOpenChange(false);
  };
  if (asChild && React.isValidElement(children)) {
    return React.cloneElement(children, { ref, ...rest, onClick });
  }
  return React.createElement("button", { ref, type: "button", ...rest, onClick }, children);
});
Close.displayName = "DialogClose";

export const Overlay = React.forwardRef(function Overlay({ children, ...rest }, ref) {
  return React.createElement("div", { ref, ...rest }, children);
});
Overlay.displayName = "DialogOverlay";

export const Content = React.forwardRef(function Content(
  // Strip Radix-only props so they don't land as unknown DOM attributes.
  { forceMount, onOpenAutoFocus, onCloseAutoFocus, onEscapeKeyDown, onPointerDownOutside, onInteractOutside, children, ...rest },
  ref,
) {
  return React.createElement("div", { ref, ...rest }, children);
});
Content.displayName = "DialogContent";

export const Title = React.forwardRef(function Title({ children, ...rest }, ref) {
  return React.createElement("h2", { ref, ...rest }, children);
});
Title.displayName = "DialogTitle";

export const Description = React.forwardRef(function Description({ children, ...rest }, ref) {
  return React.createElement("p", { ref, ...rest }, children);
});
Description.displayName = "DialogDescription";

export default { Root, Portal, Trigger, Close, Overlay, Content, Title, Description };
