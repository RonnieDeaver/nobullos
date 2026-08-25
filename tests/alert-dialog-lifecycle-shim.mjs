// Test-only LIFECYCLE shim for `@radix-ui/react-alert-dialog`.
//
// The plain `tests/alert-dialog-shim.mjs` renders dialog content inline and
// UNCONDITIONALLY: its Root ignores `open`, its Cancel/Action buttons are
// inert pass-throughs that never call `onOpenChange(false)`. That is enough
// for suites that only need the confirm button queryable, but it cannot
// verify the dialog LIFECYCLE — that cancel actually closes the dialog (and,
// for controlled ConfirmActionDialog surfaces, clears the caller's pending
// target), and that confirming requires the dialog to be open at all.
//
// This shim models the real Radix state machine faithfully enough for the
// Task #4757 confirm-dialog suites, while still rendering inline (no
// Portal/Presence, which never mount in the raw jsdom harness):
//   - Root supports BOTH controlled (`open`/`onOpenChange`) and uncontrolled
//     (Trigger-opened) usage, like Radix.
//   - Trigger opens on click (after the wrapped child's own onClick, skipped
//     when the event was defaultPrevented — Radix composeEventHandlers
//     semantics).
//   - Overlay/Content render ONLY while open.
//   - Cancel closes (user onClick first, then `onOpenChange(false)`).
//   - Action runs the user onClick (the confirm mutation) first, then closes
//     — exactly Radix's close-after-action order.
//
// So a test can assert: confirm button absent while closed → trigger opens →
// cancel closes AND (controlled mode) clears the pending target so the
// confirm button is gone until reopened → reopen → confirm fires the real
// mutation once and the dialog closes again. Wired in via
// `tests/helpers/heavyClientLoader.mjs` (`radix: ["alert-dialog-lifecycle"]`).

import * as React from "react";

const OpenCtx = React.createContext({ open: false, setOpen: () => {} });

export const Root = ({ open, defaultOpen, onOpenChange, children }) => {
  const controlled = open !== undefined;
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(!!defaultOpen);
  const actualOpen = controlled ? !!open : uncontrolledOpen;
  const setOpen = React.useCallback(
    (next) => {
      if (!controlled) setUncontrolledOpen(next);
      if (onOpenChange) onOpenChange(next);
    },
    [controlled, onOpenChange],
  );
  const value = React.useMemo(() => ({ open: actualOpen, setOpen }), [actualOpen, setOpen]);
  return React.createElement(OpenCtx.Provider, { value }, children);
};

export const Portal = ({ children }) => React.createElement(React.Fragment, null, children);

function composeClickThen(userOnClick, then) {
  return (event) => {
    if (userOnClick) userOnClick(event);
    if (event && event.defaultPrevented) return;
    then(event);
  };
}

export const Trigger = React.forwardRef(function Trigger({ asChild, children, onClick, ...rest }, ref) {
  const { setOpen } = React.useContext(OpenCtx);
  if (asChild && React.isValidElement(children)) {
    return React.cloneElement(children, {
      ref,
      ...rest,
      onClick: composeClickThen(children.props.onClick, () => setOpen(true)),
    });
  }
  return React.createElement(
    "button",
    { ref, type: "button", ...rest, onClick: composeClickThen(onClick, () => setOpen(true)) },
    children,
  );
});
Trigger.displayName = "AlertDialogTrigger";

export const Overlay = React.forwardRef(function Overlay({ children, ...rest }, ref) {
  const { open } = React.useContext(OpenCtx);
  if (!open) return null;
  return React.createElement("div", { ref, ...rest }, children);
});
Overlay.displayName = "AlertDialogOverlay";

export const Content = React.forwardRef(function Content(
  // Strip Radix-only props so they don't land as unknown DOM attributes.
  { forceMount, onOpenAutoFocus, onCloseAutoFocus, onEscapeKeyDown, children, ...rest },
  ref,
) {
  const { open } = React.useContext(OpenCtx);
  if (!open) return null;
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

export const Action = React.forwardRef(function Action({ asChild, children, onClick, ...rest }, ref) {
  const { setOpen } = React.useContext(OpenCtx);
  if (asChild && React.isValidElement(children)) {
    return React.cloneElement(children, {
      ref,
      ...rest,
      onClick: composeClickThen(children.props.onClick, () => setOpen(false)),
    });
  }
  return React.createElement(
    "button",
    { ref, type: "button", ...rest, onClick: composeClickThen(onClick, () => setOpen(false)) },
    children,
  );
});
Action.displayName = "AlertDialogAction";

export const Cancel = React.forwardRef(function Cancel({ asChild, children, onClick, ...rest }, ref) {
  const { setOpen } = React.useContext(OpenCtx);
  if (asChild && React.isValidElement(children)) {
    return React.cloneElement(children, {
      ref,
      ...rest,
      onClick: composeClickThen(children.props.onClick, () => setOpen(false)),
    });
  }
  return React.createElement(
    "button",
    { ref, type: "button", ...rest, onClick: composeClickThen(onClick, () => setOpen(false)) },
    children,
  );
});
Cancel.displayName = "AlertDialogCancel";

export default { Root, Portal, Trigger, Overlay, Content, Title, Description, Action, Cancel };
