// Inline test shim for `cmdk` (jsdom harness). The real cmdk relies on
// pointer/keyboard machinery that doesn't fire under synthetic jsdom clicks;
// this shim renders plain elements and fires `onSelect(value)` on click so
// combobox option tests work (see .agents/memory/radix-portal-jsdom-tests.md).
import React from "react";

const div = (displayName, role) => {
  const C = React.forwardRef((props, ref) => {
    const { children, heading, shouldFilter, loop, value, onValueChange, ...rest } = props;
    return React.createElement("div", { ref, role, ...rest }, children);
  });
  C.displayName = displayName;
  return C;
};

export const Command = div("CommandShim");

Command.Input = React.forwardRef((props, ref) => {
  const { onValueChange, value, ...rest } = props;
  return React.createElement("input", {
    ref,
    value: value ?? undefined,
    onChange: (e) => onValueChange && onValueChange(e.target.value),
    ...rest,
  });
});
Command.Input.displayName = "CommandInputShim";

Command.List = div("CommandListShim", "listbox");
Command.Group = div("CommandGroupShim", "group");
Command.Empty = div("CommandEmptyShim");
Command.Separator = div("CommandSeparatorShim", "separator");
Command.Loading = div("CommandLoadingShim");

Command.Item = React.forwardRef((props, ref) => {
  const { children, onSelect, value, disabled, forceMount, keywords, ...rest } = props;
  return React.createElement(
    "div",
    {
      ref,
      role: "option",
      "aria-disabled": disabled || undefined,
      onClick: () => { if (!disabled && onSelect) onSelect(value); },
      ...rest,
    },
    children,
  );
});
Command.Item.displayName = "CommandItemShim";

export const CommandInput = Command.Input;
export const CommandList = Command.List;
export const CommandGroup = Command.Group;
export const CommandEmpty = Command.Empty;
export const CommandItem = Command.Item;
export const CommandSeparator = Command.Separator;
export const CommandLoading = Command.Loading;
export const useCommandState = () => "";
export default Command;
