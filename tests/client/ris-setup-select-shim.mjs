// Test-only shim for `@radix-ui/react-select`, used by the RIS Setup
// BigQuery-binding component test.
//
// Radix Select renders its listbox through a Portal + Presence pair that
// never mounts under the raw jsdom + react-dom/client harness these tests
// use. Unlike `tests/select-shim.mjs` (which renders the listbox as nothing
// because that test only re-submits pre-loaded values), this shim renders the
// items inline AND wires `onValueChange` through a context so a test can
// actually drive a selection — the RIS Setup panel only renders the
// per-client binding controls once a client is picked from the <Select>.
//
// It re-publishes every primitive `client/src/components/ui/select.tsx`
// references (each is read for `.displayName` at module load, so all must be
// defined). Wired in via a resolve hook in
// `tests/client/ris-setup-bigquery-mock-loader.mjs`.

import * as React from "react";

const SelectCtx = React.createContext({ onValueChange: () => {}, value: undefined });

function passthrough(tag, displayName) {
  const Comp = React.forwardRef(function Comp({ children, ...rest }, ref) {
    return React.createElement(tag, { ref, ...rest }, children);
  });
  Comp.displayName = displayName;
  return Comp;
}

export const Root = ({ value, onValueChange, children }) =>
  React.createElement(
    SelectCtx.Provider,
    { value: { onValueChange: onValueChange ?? (() => {}), value } },
    children,
  );

export const Group = passthrough("div", "SelectGroup");

export const Value = ({ placeholder, children }) => {
  const ctx = React.useContext(SelectCtx);
  return React.createElement("span", null, children ?? ctx.value ?? placeholder ?? null);
};
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

// Render the portal's children inline so the items mount and stay clickable.
export const Portal = ({ children }) => React.createElement(React.Fragment, null, children);
Portal.displayName = "SelectPortal";

export const Content = passthrough("div", "SelectContent");
export const Viewport = passthrough("div", "SelectViewport");
export const Label = passthrough("div", "SelectLabel");

export const Item = React.forwardRef(function Item({ value, children, ...rest }, ref) {
  const ctx = React.useContext(SelectCtx);
  return React.createElement(
    "div",
    {
      ref,
      role: "option",
      "data-select-value": value,
      onClick: () => ctx.onValueChange(value),
      ...rest,
    },
    children,
  );
});
Item.displayName = "SelectItem";

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
