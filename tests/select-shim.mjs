// Test-only shim for `@radix-ui/react-select`.
//
// Radix Select renders its listbox content through a Portal + Presence pair
// that never mounts under the raw jsdom + react-dom/client harness these
// tests use. The ClientManagement edit form has a Data Access <Select> per
// category; this test doesn't need to open those popups (the values are
// loaded via fetch and re-submitted on save), it only needs the page to
// render without exploding on the unmountable Radix portal.
//
// This shim re-publishes every primitive `client/src/components/ui/select.tsx`
// references (each is read for `.displayName` at module load, so all must be
// defined). The trigger renders inline so its `data-testid` is queryable; the
// listbox `Portal` renders nothing. Wired in via a resolve hook in the shared
// `tests/helpers/heavyClientLoader.mjs` (wired via
// `tests/client-edit-data-access-mock-setup.mjs` and `tests/command-panel-gbp-setup.mjs`).

import * as React from "react";

function passthrough(tag, displayName) {
  const Comp = React.forwardRef(function Comp({ children, ...rest }, ref) {
    return React.createElement(tag, { ref, ...rest }, children);
  });
  Comp.displayName = displayName;
  return Comp;
}

export const Root = ({ value, defaultValue, onValueChange, open, onOpenChange, children, ...rest }) =>
  React.createElement(React.Fragment, null, children);

export const Group = passthrough("div", "SelectGroup");
export const Value = ({ placeholder, children }) =>
  React.createElement("span", null, children ?? placeholder ?? null);
Value.displayName = "SelectValue";

export const Trigger = React.forwardRef(function Trigger({ asChild, children, ...rest }, ref) {
  if (asChild && React.isValidElement(children)) {
    return React.cloneElement(children, { ref, ...rest });
  }
  return React.createElement("button", { ref, type: "button", ...rest }, children);
});
Trigger.displayName = "SelectTrigger";

export const Icon = ({ asChild, children }) => React.createElement(React.Fragment, null, children);
Icon.displayName = "SelectIcon";

// The listbox is portaled in real Radix; render nothing here so the items
// (and their unmountable machinery) stay out of the jsdom tree.
export const Portal = () => null;
Portal.displayName = "SelectPortal";

export const Content = passthrough("div", "SelectContent");
export const Viewport = passthrough("div", "SelectViewport");
export const Label = passthrough("div", "SelectLabel");
export const Item = passthrough("div", "SelectItem");
export const ItemText = ({ children }) => React.createElement(React.Fragment, null, children);
ItemText.displayName = "SelectItemText";
export const ItemIndicator = ({ children }) => React.createElement(React.Fragment, null, children);
ItemIndicator.displayName = "SelectItemIndicator";
export const ScrollUpButton = passthrough("div", "SelectScrollUpButton");
export const ScrollDownButton = passthrough("div", "SelectScrollDownButton");
export const Separator = passthrough("div", "SelectSeparator");

export default {
  Root,
  Group,
  Value,
  Trigger,
  Icon,
  Portal,
  Content,
  Viewport,
  Label,
  Item,
  ItemText,
  ItemIndicator,
  ScrollUpButton,
  ScrollDownButton,
  Separator,
};
