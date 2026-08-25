/**
 * UniverDocEditor — React wrapper around the Univer document (word-processor)
 * engine. NoBull Docs' counterpart to sheets/UniverEditor.tsx.
 *
 * All Univer packages are imported dynamically so they land in their own
 * lazy chunk and never bloat the main bundle.  The component initialises
 * Univer in a `useEffect`, disposes it on unmount, and exposes a single
 * imperative handle — `getSnapshot()` — that the parent page calls on its
 * debounced-save timer.
 *
 * Edit detection: Univer docs routes typing through a hidden input mounted
 * OUTSIDE this container, so DOM key/pointer listeners on the wrapper never
 * see edits (QA-proven). Instead we subscribe to the Univer command stream
 * and forward every `doc.mutation.*` command (rich-text edits, formatting,
 * undo/redo) to `onContentChanged`.
 *
 * Read-only mode: the docs preset has no setReadOnly API (unlike sheets),
 * and key-swallowing on the wrapper is ineffective for the same hidden-input
 * reason. We instead auto-revert: any doc mutation that lands while
 * read-only is immediately undone (reentrancy-guarded so the undo's own
 * mutation doesn't loop). The lock/permission model is enforced server-side
 * regardless — this only keeps the local view honest.
 */

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

export interface UniverDocEditorHandle {
  /** Returns the current full-document snapshot (IDocumentData). */
  getSnapshot(): unknown;
}

interface Props {
  /** Stored IDocumentData JSON from the API; null = brand-new empty document. */
  initialData: unknown | null;
  /** Called once Univer is ready so the parent can begin tracking changes. */
  onReady?: () => void;
  /**
   * Fired on every document-mutating command once the editor is ready and
   * not read-only. The parent uses this to arm its debounced autosave.
   */
  onContentChanged?: () => void;
  /**
   * When true the parent treats the document as view-only: getSnapshot()
   * returns null, the parent never triggers saves, and local mutations are
   * auto-reverted.
   */
  readOnly?: boolean;
}

const UniverDocEditor = forwardRef<UniverDocEditorHandle, Props>(
  function UniverDocEditor(
    { initialData, onReady, onContentChanged, readOnly = false },
    ref,
  ) {
    const containerRef = useRef<HTMLDivElement>(null);
    const docRef = useRef<any>(null);
    const disposeRef = useRef<(() => void) | null>(null);
    // Latest-value refs so the (once-registered) command listener never goes
    // stale when the parent re-renders with new callbacks / lock state.
    const onContentChangedRef = useRef(onContentChanged);
    onContentChangedRef.current = onContentChanged;
    const readOnlyRef = useRef(readOnly);
    readOnlyRef.current = readOnly;

    useImperativeHandle(ref, () => ({
      getSnapshot() {
        if (readOnly) return null;
        return docRef.current?.getSnapshot?.() ?? null;
      },
    }));

    useEffect(() => {
      if (!containerRef.current) return;
      let disposed = false;

      async function init() {
        // @ts-ignore — dynamic package loaded at runtime; not in devDeps
        const { createUniver, LocaleType, mergeLocales } = await import("@univerjs/presets");
        // @ts-ignore
        const { UniverDocsCorePreset } = await import("@univerjs/preset-docs-core");
        // @ts-ignore
        const { UniverDocsDrawingPreset } = await import("@univerjs/preset-docs-drawing");
        // @ts-ignore
        const { default: docsCoreEnUS } = await import("@univerjs/preset-docs-core/locales/en-US");
        // @ts-ignore
        const { default: docsDrawingEnUS } = await import("@univerjs/preset-docs-drawing/locales/en-US");
        // CSS imports — bundler handles these at build time.
        await import("@univerjs/preset-docs-core/lib/index.css");
        await import("@univerjs/preset-docs-drawing/lib/index.css");

        if (disposed || !containerRef.current) return;

        // Minimal valid empty document (one empty paragraph + section break).
        const blankDocument = {
          id: "doc-new",
          body: {
            dataStream: "\r\n",
            textRuns: [],
            paragraphs: [{ startIndex: 0 }],
            sectionBreaks: [{ startIndex: 1 }],
          },
          documentStyle: {
            pageSize: { width: 595, height: 842 },
            marginTop: 50,
            marginBottom: 50,
            marginRight: 50,
            marginLeft: 50,
          },
        };

        const { univerAPI } = createUniver({
          locale: LocaleType.EN_US,
          locales: {
            [LocaleType.EN_US]: mergeLocales(docsCoreEnUS, docsDrawingEnUS),
          },
          presets: [
            UniverDocsCorePreset({ container: containerRef.current }),
            UniverDocsDrawingPreset(),
          ],
        });

        docRef.current = univerAPI.createUniverDoc(
          (initialData as any) ?? blankDocument,
        );

        // Defensive: the docs facade has no read-only toggle today, but pick
        // it up automatically if a future Univer version adds one.
        if (readOnly && docRef.current?.setReadOnly) {
          try {
            docRef.current.setReadOnly(true);
          } catch {
            // Silently ignore if unavailable in this Univer version.
          }
        }

        // Content-change detection via the command stream (see header note).
        // `doc.mutation.*` = document-content mutations; selection moves are
        // `doc.operation.*` and never match.
        let contentReady = false;
        let reverting = false;
        const commandDisposable = univerAPI.onCommandExecuted?.(
          (command: { id?: string }) => {
            if (!command?.id?.startsWith("doc.mutation.")) return;
            if (!contentReady || reverting) return;
            if (readOnlyRef.current) {
              // View-only: undo the local mutation. The undo emits the same
              // mutation id, so gate on `reverting` to avoid a loop.
              reverting = true;
              void Promise.resolve(docRef.current?.undo?.())
                .finally(() => {
                  reverting = false;
                })
                .catch(() => {
                  // Best-effort revert — server-side lock still rejects saves.
                });
              return;
            }
            onContentChangedRef.current?.();
          },
        );
        // Ignore the burst of mutations Univer fires while materialising the
        // initial snapshot — only user-driven changes should arm autosave.
        setTimeout(() => {
          contentReady = true;
        }, 0);

        disposeRef.current = () => {
          try {
            commandDisposable?.dispose?.();
          } catch {
            // dispose best-effort — univerAPI.dispose() tears down anyway.
          }
          univerAPI.dispose();
        };
        onReady?.();
      }

      init().catch((err) =>
        console.error("[UniverDocEditor] init failed:", err?.message ?? err),
      );

      return () => {
        disposed = true;
        disposeRef.current?.();
        disposeRef.current = null;
        docRef.current = null;
      };
      // initialData and readOnly intentionally not in deps — snapshot/mode is set once only.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return (
      <div
        ref={containerRef}
        style={{ width: "100%", height: "100%", minHeight: 0 }}
        data-testid="univer-doc-editor-container"
        aria-label={readOnly ? "Document (view only)" : "Document editor"}
      />
    );
  },
);

export default UniverDocEditor;
