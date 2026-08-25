// Test-only shim for `@radix-ui/react-popover`, used by the Ads Hygiene
// reconnect-banner test.
//
// Task #3091 replaced the page's plain Radix Select account picker with a
// Popover + cmdk combobox. Radix Popover renders its content through a
// Portal + Presence pair that never mounts under the raw jsdom +
// react-dom/client harness (same failure mode as Radix Select — see
// .agents/memory/radix-portal-jsdom-tests.md). This shim renders the
// popover content INLINE and unconditionally (ignoring open state) so the
// cmdk CommandItem rows are queryable and clickable without simulating the
// portal/positioning machinery. cmdk itself renders inline and needs no shim.
//
// It re-publishes every primitive `client/src/components/ui/popover.tsx`
// references (Content is read for `.displayName` at module load, so it must
// be defined). Wired in via the resolve hook in
// `tests/client/ris-setup-bigquery-mock-loader.mjs`.

import * as React from "react";

export const Root = ({ children }) => React.createElement(React.Fragment, null, children);
Root.displayName = "Popover";

export const Anchor = React.forwardRef(function Anchor({ asChild, children, ...rest }, ref) {
  if (asChild && React.isValidElement(children)) {
    return React.cloneElement(children, { ref, ...rest });
  }
  return React.createElement("div", { ref, ...rest }, children);
});
Anchor.displayName = "PopoverAnchor";

export const Trigger = React.forwardRef(function Trigger({ asChild, children, ...rest }, ref) {
  if (asChild && React.isValidElement(children)) {
    return React.cloneElement(children, { ref, ...rest });
  }
  return React.createElement("button", { ref, type: "button", ...rest }, children);
});
Trigger.displayName = "PopoverTrigger";

// Render the portal's children inline so the content mounts and stays clickable.
export const Portal = ({ children }) => React.createElement(React.Fragment, null, children);
Portal.displayName = "PopoverPortal";

export const Content = React.forwardRef(function Content(
  { align, sideOffset, children, ...rest },
  ref,
) {
  return React.createElement("div", { ref, ...rest }, children);
});
Content.displayName = "PopoverContent";

export const Arrow = ({ children }) => React.createElement(React.Fragment, null, children);
Arrow.displayName = "PopoverArrow";

export const Close = React.forwardRef(function Close({ asChild, children, ...rest }, ref) {
  if (asChild && React.isValidElement(children)) {
    return React.cloneElement(children, { ref, ...rest });
  }
  return React.createElement("button", { ref, type: "button", ...rest }, children);
});
Close.displayName = "PopoverClose";

export default { Root, Anchor, Trigger, Portal, Content, Arrow, Close };
