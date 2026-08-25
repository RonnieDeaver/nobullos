// Test-only shim for `@radix-ui/react-dialog`, used by the SheetsLibrary
// rendered test (Task #2931).
//
// Radix Dialog renders through Portal + FocusScope + DismissableLayer which
// require MutationObserver + custom DOMEvents not available in the raw jsdom
// harness. This shim renders Dialog content inline (no portal, no focus trap)
// so the create-workbook form is queryable and submittable in tests.
//
// Wired in via `tests/client/sheets-library-loader.mjs`.

import * as React from "react";

const DialogCtx = React.createContext({ open: false, onOpenChange: () => {} });

// Root — controlled open state
export const Root = ({ open = false, onOpenChange, children, ...rest }) =>
  React.createElement(
    DialogCtx.Provider,
    { value: { open: !!open, onOpenChange: onOpenChange ?? (() => {}) } },
    children,
  );
Root.displayName = "Dialog";

// Trigger — just a button that calls onOpenChange(true)
export const Trigger = React.forwardRef(function Trigger({ asChild, children, ...rest }, ref) {
  const ctx = React.useContext(DialogCtx);
  const handleClick = (e) => {
    ctx.onOpenChange(true);
    rest.onClick?.(e);
  };
  if (asChild && React.isValidElement(children)) {
    return React.cloneElement(children, { ref, ...rest, onClick: handleClick });
  }
  return React.createElement("button", { ref, type: "button", ...rest, onClick: handleClick }, children);
});
Trigger.displayName = "DialogTrigger";

// Portal — render inline, no DOM portal
export const Portal = ({ children }) =>
  React.createElement(React.Fragment, null, children);
Portal.displayName = "DialogPortal";

// Overlay — only shown when open
export const Overlay = React.forwardRef(function Overlay({ children, ...rest }, ref) {
  const ctx = React.useContext(DialogCtx);
  if (!ctx.open) return null;
  return React.createElement("div", { ref, role: "none", ...rest }, children);
});
Overlay.displayName = "DialogOverlay";

// Content — renders children inline when open
export const Content = React.forwardRef(function Content({ children, ...rest }, ref) {
  const ctx = React.useContext(DialogCtx);
  if (!ctx.open) return null;
  return React.createElement("div", { ref, role: "dialog", "aria-modal": "true", ...rest }, children);
});
Content.displayName = "DialogContent";

// Close — calls onOpenChange(false)
export const Close = React.forwardRef(function Close({ asChild, children, onClick, ...rest }, ref) {
  const ctx = React.useContext(DialogCtx);
  const handleClick = (e) => {
    ctx.onOpenChange(false);
    onClick?.(e);
  };
  if (asChild && React.isValidElement(children)) {
    return React.cloneElement(children, { ref, ...rest, onClick: handleClick });
  }
  return React.createElement("button", { ref, type: "button", ...rest, onClick: handleClick }, children);
});
Close.displayName = "DialogClose";

// Title / Description — pass-through
export const Title = React.forwardRef(function Title({ children, ...rest }, ref) {
  return React.createElement("h2", { ref, ...rest }, children);
});
Title.displayName = "DialogTitle";

export const Description = React.forwardRef(function Description({ children, ...rest }, ref) {
  return React.createElement("p", { ref, ...rest }, children);
});
Description.displayName = "DialogDescription";

export default { Root, Trigger, Portal, Overlay, Content, Close, Title, Description };
