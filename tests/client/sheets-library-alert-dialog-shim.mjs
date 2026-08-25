// Test-only shim for `@radix-ui/react-alert-dialog`, used by the SheetsLibrary
// rendered test (Task #2931).
//
// Same rationale as the Dialog shim — renders content inline to avoid Radix
// Portal + FocusScope issues in jsdom.

import * as React from "react";

const AlertCtx = React.createContext({ open: false, onOpenChange: () => {} });

export const Root = ({ open = false, onOpenChange, children }) =>
  React.createElement(
    AlertCtx.Provider,
    { value: { open: !!open, onOpenChange: onOpenChange ?? (() => {}) } },
    children,
  );
Root.displayName = "AlertDialog";

export const Trigger = React.forwardRef(function Trigger({ asChild, children, ...rest }, ref) {
  const ctx = React.useContext(AlertCtx);
  const handleClick = (e) => {
    ctx.onOpenChange(true);
    rest.onClick?.(e);
  };
  if (asChild && React.isValidElement(children)) {
    return React.cloneElement(children, { ref, ...rest, onClick: handleClick });
  }
  return React.createElement("button", { ref, type: "button", ...rest, onClick: handleClick }, children);
});
Trigger.displayName = "AlertDialogTrigger";

export const Portal = ({ children }) =>
  React.createElement(React.Fragment, null, children);
Portal.displayName = "AlertDialogPortal";

export const Overlay = React.forwardRef(function Overlay({ children, ...rest }, ref) {
  const ctx = React.useContext(AlertCtx);
  if (!ctx.open) return null;
  return React.createElement("div", { ref, role: "none", ...rest }, children);
});
Overlay.displayName = "AlertDialogOverlay";

export const Content = React.forwardRef(function Content({ children, ...rest }, ref) {
  const ctx = React.useContext(AlertCtx);
  if (!ctx.open) return null;
  return React.createElement("div", { ref, role: "alertdialog", "aria-modal": "true", ...rest }, children);
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

// Action / Cancel — just buttons; no close-on-click magic needed for test flow
export const Action = React.forwardRef(function Action({ children, ...rest }, ref) {
  return React.createElement("button", { ref, type: "button", ...rest }, children);
});
Action.displayName = "AlertDialogAction";

export const Cancel = React.forwardRef(function Cancel({ children, ...rest }, ref) {
  const ctx = React.useContext(AlertCtx);
  const handleClick = (e) => {
    ctx.onOpenChange(false);
    rest.onClick?.(e);
  };
  return React.createElement("button", { ref, type: "button", ...rest, onClick: handleClick }, children);
});
Cancel.displayName = "AlertDialogCancel";

export default { Root, Trigger, Portal, Overlay, Content, Title, Description, Action, Cancel };
