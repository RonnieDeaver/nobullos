// Task #4023 — destination picker for moving files or a folder. Renders the
// client's folder tree (built from the flat /tree list) with the root as an
// always-available destination. When moving a folder, that folder and its
// entire subtree are excluded (the server also rejects cycles).
import { useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Folder, FolderOpen, Home } from "lucide-react";
import type { FolderRow } from "./types";

interface TreeNode extends FolderRow {
  children: TreeNode[];
}

function buildTree(folders: FolderRow[]): TreeNode[] {
  const byId = new Map<string, TreeNode>();
  for (const f of folders) byId.set(f.id, { ...f, children: [] });
  const roots: TreeNode[] = [];
  for (const node of byId.values()) {
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

function subtreeIds(folders: FolderRow[], rootId: string): Set<string> {
  const childrenOf = new Map<string | null, FolderRow[]>();
  for (const f of folders) {
    const list = childrenOf.get(f.parentId) ?? [];
    list.push(f);
    childrenOf.set(f.parentId, list);
  }
  const out = new Set<string>([rootId]);
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    for (const child of childrenOf.get(id) ?? []) {
      if (!out.has(child.id)) {
        out.add(child.id);
        stack.push(child.id);
      }
    }
  }
  return out;
}

function TreeRow({
  node,
  depth,
  selected,
  excluded,
  onSelect,
}: {
  node: TreeNode;
  depth: number;
  selected: string | null;
  excluded: Set<string>;
  onSelect: (id: string) => void;
}) {
  if (excluded.has(node.id)) return null;
  const isSelected = selected === node.id;
  return (
    <>
      <button
        type="button"
        onClick={() => onSelect(node.id)}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        className={`w-full flex items-center gap-2 py-1.5 pr-2 rounded-md text-sm text-left transition-colors ${
          isSelected
            ? "bg-primary text-primary-foreground"
            : "hover:bg-primary/5 text-slate-700"
        }`}
        data-testid={`move-dest-${node.id}`}
      >
        {isSelected ? (
          <FolderOpen className="w-4 h-4 shrink-0" />
        ) : (
          <Folder className="w-4 h-4 shrink-0 text-primary/50" />
        )}
        <span className="truncate">{node.name}</span>
      </button>
      {node.children.map((child) => (
        <TreeRow
          key={child.id}
          node={child}
          depth={depth + 1}
          selected={selected}
          excluded={excluded}
          onSelect={onSelect}
        />
      ))}
    </>
  );
}

export function MoveFolderDialog({
  title,
  description,
  folders,
  excludeSubtreeOf,
  currentFolderId,
  busy,
  onMove,
  onClose,
}: {
  title: string;
  description: string;
  folders: FolderRow[];
  /** When moving a folder: exclude it and its descendants as destinations. */
  excludeSubtreeOf?: string;
  /** Highlighted as the starting selection (null = root). */
  currentFolderId: string | null;
  busy?: boolean;
  onMove: (destinationFolderId: string | null) => void;
  onClose: () => void;
}) {
  // Sentinel "" = client root (null destination).
  const [selected, setSelected] = useState<string>(currentFolderId ?? "");
  const tree = useMemo(() => buildTree(folders), [folders]);
  const excluded = useMemo(
    () =>
      excludeSubtreeOf ? subtreeIds(folders, excludeSubtreeOf) : new Set<string>(),
    [folders, excludeSubtreeOf],
  );

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md" data-testid="dialog-move">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="border border-slate-200 rounded-md max-h-72 overflow-y-auto p-1">
          <button
            type="button"
            onClick={() => setSelected("")}
            className={`w-full flex items-center gap-2 py-1.5 px-2 rounded-md text-sm text-left transition-colors ${
              selected === ""
                ? "bg-primary text-primary-foreground"
                : "hover:bg-primary/5 text-slate-700"
            }`}
            data-testid="move-dest-root"
          >
            <Home className="w-4 h-4 shrink-0" />
            <span>All files (root)</span>
          </button>
          {tree.map((node) => (
            <TreeRow
              key={node.id}
              node={node}
              depth={1}
              selected={selected || null}
              excluded={excluded}
              onSelect={setSelected}
            />
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={() => onMove(selected === "" ? null : selected)}
            disabled={busy}
            className="bg-primary hover:bg-primary/90 text-primary-foreground"
            data-testid="button-move-confirm"
          >
            Move here
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
