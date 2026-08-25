// Test-only shim for `@radix-ui/react-popover`.
//
// Radix Popover renders its content through a Portal + Presence pair that
// only mounts after layout-effect-driven state transitions. Under the raw
// jsdom + react-dom/client harness these tests use (no @testing-library
// DOM environment), that portal never mounts even when the trigger reports
// `data-state="open"`, so the popover content is never queryable. That is a
// limitation of the third-party portal/animation machinery, not of the
// app code under test.
//
// This shim re-publishes the primitives `client/src/components/ui/popover.tsx`
// imports (`import * as PopoverPrimitive from "@radix-ui/react-popover"`) as
// inline pass-throughs: the content always renders next to the trigger,
// preserving every prop (`data-testid`, `className`, children) so the test
// can assert on the real ReassignEventCard / section markup. Wired in via a
// resolve hook in the shared `tests/helpers/heavyClientLoader.mjs`
// (wired via `tests/popover-mock-setup.mjs`).

import * as React from "react";

export const Root = ({ children }) => React.createElement(React.Fragment, null, children);
export const Anchor = ({ children }) => React.createElement(React.Fragment, null, children);
export const Portal = ({ children }) => React.createElement(React.Fragment, null, children);

export const Trigger = React.forwardRef(function Trigger({ asChild, children, ...rest }, ref) {
  if (asChild && React.isValidElement(children)) {
    return React.cloneElement(children, { ref, ...rest });
  }
  return React.createElement("button", { ref, ...rest }, children);
});
Trigger.displayName = "PopoverTrigger";

export const Content = React.forwardRef(function Content(
  // Strip Radix-only positioning props so they don't land as unknown
  // attributes on the plain <div>.
  { align, sideOffset, side, alignOffset, avoidCollisions, collisionPadding, children, ...rest },
  ref,
) {
  return React.createElement("div", { ref, ...rest }, children);
});
Content.displayName = "PopoverContent";

export default { Root, Anchor, Portal, Trigger, Content };
