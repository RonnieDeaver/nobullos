// Marker-div stub for Profile.tsx's heavy feature panels (Task #3105).
// The loader resolves each stubbed panel specifier to this file with a
// `?testid=` query param, so one shim serves all panels while each import
// gets its own module instance and marker testid.
import React from "react";

const testid =
  new URL(import.meta.url).searchParams.get("testid") ?? "stub-panel";

const Stub = () => React.createElement("div", { "data-testid": testid });
export default Stub;
