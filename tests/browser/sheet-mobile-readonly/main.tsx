/**
 * Harness for tests/sheet-mobile-readonly-browser.test.ts.
 *
 * Mounts the REAL UniverEditor component full-viewport.
 *   ?readonly=1 — mounts read-only (the SheetEditor phone view mount)
 *   ?readonly=0 — mounts editable (control run proving the edit gesture)
 * Either way the mode can be flipped afterwards without remounting via
 * window.__setReadOnly(bool) — mirroring SheetEditor's desktop
 * pending-lock → lock-won transition, where readOnly starts true and flips
 * to false on the already-mounted editor.
 *
 * Exposes for the test:
 *   window.__ready               — set true by onReady
 *   window.__setReadOnly(bool)   — flips the readOnly prop in place
 *   window.__getSnapshot()       — production getSnapshot() (null when readOnly)
 *   window.__getSnapshotUnsafe() — document-model snapshot regardless of mode
 */
import React, { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import UniverEditor, {
  type UniverEditorHandle,
} from "../../../client/src/components/sheets/UniverEditor";

const initialReadOnly =
  new URLSearchParams(window.location.search).get("readonly") === "1";

const initialData = {
  id: "wb-mobile-readonly-4610",
  locale: "enUS",
  name: "Mobile readonly harness",
  sheetOrder: ["s1"],
  sheets: {
    s1: {
      id: "s1",
      name: "Sheet1",
      rowCount: 30,
      columnCount: 8,
      cellData: { 0: { 0: { v: "Hello" } } },
    },
  },
};

function App() {
  const ref = useRef<UniverEditorHandle>(null);
  const [readOnly, setReadOnly] = useState(initialReadOnly);
  (window as any).__setReadOnly = (v: boolean) => setReadOnly(v);
  (window as any).__getSnapshot = () => ref.current?.getSnapshot() ?? null;
  (window as any).__getSnapshotUnsafe = () => ref.current?.getSnapshotUnsafe() ?? null;
  return (
    <div style={{ position: "fixed", inset: 0 }}>
      <UniverEditor
        ref={ref}
        initialData={initialData}
        readOnly={readOnly}
        onReady={() => {
          (window as any).__ready = true;
        }}
      />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
