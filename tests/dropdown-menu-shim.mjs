// Test-only shim for `@radix-ui/react-dropdown-menu`.
//
// Radix DropdownMenu renders its content through a Portal + Presence pair that
// only mounts after layout-effect-driven state transitions. Under the raw
// jsdom + react-dom/client harness these tests use, that portal never mounts
// even when the trigger reports `data-state="open"`, so the menu content is
// never queryable (same limitation as the Popover/Dialog/Select shims — see
// `tests/popover-shim.mjs`).
//
// This shim re-publishes the primitives `client/src/components/ui/dropdown-menu.tsx`
// imports (`import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu"`)
// as inline pass-throughs: content always renders next to the trigger,
// preserving every prop (`data-testid`, `className`, `data-active`, children)
// so tests can assert on the real menu markup and DOM ordering. Wired in via
// the shared `tests/helpers/heavyClientLoader.mjs` (`radix: ["dropdown-menu"]`).

import * as React from "react";

// Radix-only props that must not land on plain DOM nodes.
const RADIX_ONLY_PROPS = [
  "align",
  "alignOffset",
  "side",
  "sideOffset",
  "avoidCollisions",
  "collisionPadding",
  "onSelect",
  "onCloseAutoFocus",
  "onEscapeKeyDown",
  "onPointerDownOutside",
  "onFocusOutside",
  "onInteractOutside",
  "loop",
  "forceMount",
  "sticky",
  "hideWhenDetached",
  "textValue",
  "inset",
];

function stripRadixProps(props) {
  const rest = { ...props };
  for (const key of RADIX_ONLY_PROPS) delete rest[key];
  return rest;
}

function passthrough(displayName, tag = "div") {
  const Comp = React.forwardRef(function Passthrough(props, ref) {
    const { asChild, children, ...raw } = props;
    const rest = stripRadixProps(raw);
    if (asChild && React.isValidElement(children)) {
      return React.cloneElement(children, { ref, ...rest });
    }
    return React.createElement(tag, { ref, ...rest }, children);
  });
  Comp.displayName = displayName;
  return Comp;
}

const fragment = (displayName) => {
  const Comp = ({ children }) => React.createElement(React.Fragment, null, children);
  Comp.displayName = displayName;
  return Comp;
};

export const Root = fragment("DropdownMenuRoot");
export const Portal = fragment("DropdownMenuPortal");
export const Group = fragment("DropdownMenuGroup");
export const Sub = fragment("DropdownMenuSub");
export const RadioGroup = fragment("DropdownMenuRadioGroup");
export const ItemIndicator = fragment("DropdownMenuItemIndicator");

export const Trigger = passthrough("DropdownMenuTrigger", "button");
export const Content = passthrough("DropdownMenuContent");
export const SubContent = passthrough("DropdownMenuSubContent");
export const SubTrigger = passthrough("DropdownMenuSubTrigger");
export const Item = passthrough("DropdownMenuItem");
export const CheckboxItem = passthrough("DropdownMenuCheckboxItem");
export const RadioItem = passthrough("DropdownMenuRadioItem");
export const Label = passthrough("DropdownMenuLabel");
export const Separator = passthrough("DropdownMenuSeparator");

export default {
  Root,
  Portal,
  Group,
  Sub,
  RadioGroup,
  ItemIndicator,
  Trigger,
  Content,
  SubContent,
  SubTrigger,
  Item,
  CheckboxItem,
  RadioItem,
  Label,
  Separator,
};
