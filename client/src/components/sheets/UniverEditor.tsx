/**
 * UniverEditor — React wrapper around the Univer spreadsheet engine.
 *
 * All Univer packages are imported dynamically so they land in their own
 * lazy chunk and never bloat the main bundle.  The component initialises
 * Univer in a `useEffect`, disposes it on unmount, and exposes a single
 * imperative handle — `getSnapshot()` — that the parent page calls on
 * its debounced-save timer.
 *
 * When `readOnly` is true the spreadsheet is initialised in Univer's
 * read-only mode so no cell edits, formula-bar changes, or menu writes
 * can reach the data.
 */

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

export interface UniverEditorHandle {
  /** Returns the current full-workbook snapshot (IWorkbookData). */
  getSnapshot(): unknown;
  /**
   * Diagnostic/test seam: returns the snapshot even in read-only mode.
   * Production save paths use getSnapshot() (null when read-only) — this
   * exists so the phone read-only browser test can prove attempted edits
   * never reach the document model.
   */
  getSnapshotUnsafe(): unknown;
}

interface Props {
  /** Stored IWorkbookData JSON from the API; null = brand-new empty workbook. */
  initialData: unknown | null;
  /** Called once Univer is ready so the parent can begin tracking changes. */
  onReady?: () => void;
  /**
   * When true the spreadsheet is opened in Univer read-only mode.
   * The save handler in the parent is also disabled when this is true.
   */
  readOnly?: boolean;
  /**
   * Called if the Univer engine fails to initialise. Lets the parent chrome
   * surface a visible error card (the init throw is otherwise only logged,
   * leaving the editor blank).
   */
  onError?: (message: string) => void;
}

const UniverEditor = forwardRef<UniverEditorHandle, Props>(
  function UniverEditor({ initialData, onReady, onError, readOnly = false }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const workbookRef = useRef<any>(null);
    const disposeRef = useRef<(() => void) | null>(null);
    // Live mirror of the readOnly prop: SheetEditor mounts the desktop
    // editor read-only while lock acquisition is pending and flips the prop
    // once the lock is won, without remounting — editability must follow.
    const readOnlyRef = useRef(readOnly);
    readOnlyRef.current = readOnly;

    const applyEditabilityRef = useRef<(() => void) | null>(null);

    // Re-apply editability whenever the readOnly prop changes after init
    // (e.g. SheetEditor wins the edit lock and flips readOnly=false on the
    // already-mounted editor).
    useEffect(() => {
      applyEditabilityRef.current?.();
    }, [readOnly]);

    useImperativeHandle(ref, () => ({
      getSnapshot() {
        if (readOnly) return null;
        return workbookRef.current?.save?.() ?? null;
      },
      getSnapshotUnsafe() {
        return workbookRef.current?.save?.() ?? null;
      },
    }));

    useEffect(() => {
      if (!containerRef.current) return;
      let disposed = false;

      async function init() {
        // @ts-ignore — dynamic package loaded at runtime; not in devDeps
        const { createUniver, LocaleType, mergeLocales } = await import("@univerjs/presets");
        // @ts-ignore
        const { UniverSheetsCorePreset } = await import("@univerjs/preset-sheets-core");
        // @ts-ignore
        const { default: enUS } = await import("@univerjs/preset-sheets-core/locales/en-US");
        // CSS import — bundler handles this at build time.
        await import("@univerjs/preset-sheets-core/lib/index.css");

        if (disposed || !containerRef.current) return;

        const blankWorkbook = {
          id: "wb-new",
          locale: LocaleType.EN_US,
          name: "Untitled",
          sheetOrder: ["sheet-1"],
          sheets: {
            "sheet-1": {
              id: "sheet-1",
              name: "Sheet1",
              rowCount: 100,
              columnCount: 26,
            },
          },
        };

        const { univerAPI } = createUniver({
          locale: LocaleType.EN_US,
          locales: {
            [LocaleType.EN_US]: mergeLocales(enUS),
          },
          presets: [
            UniverSheetsCorePreset({ container: containerRef.current }),
          ],
        });

        workbookRef.current = univerAPI.createWorkbook(
          (initialData as any) ?? blankWorkbook,
        );

        // Editability tracks the readOnly prop via the workbook-permission
        // API: FWorkbook.setEditable(). (There is no FWorkbook.setReadOnly
        // in Univer 0.25 — the old optional call to it silently no-op'd and
        // left the sheet locally editable.)
        //
        // Two timing subtleties, both covered by
        // tests/sheet-mobile-readonly-browser.test.ts (real Chromium):
        //   - The permission point set here can be re-registered by the
        //     unit's async render/lifecycle init, which would re-enable
        //     editing — so re-apply the CURRENT mode on every
        //     lifecycle-stage change (no command-stream throwing; read-only
        //     interaction never floods window.onerror).
        //   - The parent flips readOnly without remounting (desktop
        //     pending-lock → lock-won transition), so the mode is read live
        //     from readOnlyRef here and re-applied by the prop-change
        //     effect below.
        const applyEditability = () => {
          try {
            workbookRef.current?.setEditable?.(!readOnlyRef.current);
          } catch {
            // Permission service not ready yet — a later lifecycle
            // re-apply covers it.
          }
        };
        applyEditabilityRef.current = applyEditability;
        applyEditability();
        const lifeCycleEvent = (univerAPI as any).Event?.LifeCycleChanged;
        if (lifeCycleEvent) {
          univerAPI.addEvent(lifeCycleEvent, () => applyEditability());
        }

        disposeRef.current = () => univerAPI.dispose();
        onReady?.();
      }

      init().catch((err) => {
        console.error("[UniverEditor] init failed:", err?.message ?? err);
        if (!disposed) onError?.(err?.message ?? String(err));
      });

      return () => {
        disposed = true;
        disposeRef.current?.();
        disposeRef.current = null;
        workbookRef.current = null;
      };
      // initialData and readOnly intentionally not in deps — snapshot/mode is set once only.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return (
      <div
        ref={containerRef}
        style={{ width: "100%", height: "100%", minHeight: 0 }}
        data-testid="univer-editor-container"
        aria-label={readOnly ? "Spreadsheet (view only)" : "Spreadsheet editor"}
      />
    );
  },
);

export default UniverEditor;
