// Interactive test-only shim for `@radix-ui/react-select`, used by
// tests/doc-share-dialog.test.ts. Unlike the shared tests/select-shim.mjs
// (which renders the listbox Portal as null because that test only needs the
// page to mount), this test must actually PICK a teammate in the Share
// dialog, so:
//   - Root provides {value,onValueChange} via context,
//   - Portal/Content render children inline (always mounted),
//   - Item fires onValueChange(value) on a plain synthetic click.
// Every primitive `client/src/components/ui/select.tsx` reads for
// `.displayName` must be defined.

import * as React from "react";

const Ctx = React.createContext({ value: undefined, onValueChange: () => {} });

export const Root = ({ value, defaultValue, onValueChange, open, onOpenChange, children }) =>
  React.createElement(
    Ctx.Provider,
    { value: { value: value ?? defaultValue, onValueChange: onValueChange ?? (() => {}) } },
    children,
  );

function passthrough(tag, displayName) {
  const Comp = React.forwardRef(function Comp({ children, ...rest }, ref) {
    return React.createElement(tag, { ref, ...rest }, children);
  });
  Comp.displayName = displayName;
  return Comp;
}

export const Group = passthrough("div", "SelectGroup");

export const Value = ({ placeholder, children }) => {
  const { value } = React.useContext(Ctx);
  return React.createElement("span", null, children ?? value ?? placeholder ?? null);
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

export const Portal = ({ children }) => React.createElement(React.Fragment, null, children);
Portal.displayName = "SelectPortal";

export const Content = React.forwardRef(function Content(
  { position, side, sideOffset, align, alignOffset, avoidCollisions, collisionPadding, children, ...rest },
  ref,
) {
  return React.createElement("div", { ref, role: "listbox", ...rest }, children);
});
Content.displayName = "SelectContent";

export const Viewport = passthrough("div", "SelectViewport");
export const Label = passthrough("div", "SelectLabel");

export const Item = React.forwardRef(function Item({ value, textValue, children, ...rest }, ref) {
  const { onValueChange } = React.useContext(Ctx);
  return React.createElement(
    "div",
    {
      ref,
      role: "option",
      "data-select-item-value": value,
      onClick: () => onValueChange(value),
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
