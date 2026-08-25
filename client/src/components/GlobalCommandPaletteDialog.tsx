// -------------------------------------------------------------------------------------
// GlobalCommandPaletteDialog — lazy cmdk dialog for the app-wide ⌘K palette
// -------------------------------------------------------------------------------------
// Rendered (lazily) by GlobalCommandPalette. Type-ahead over the role-filtered
// quicklinks destinations passed in by GlobalAppNav — the SAME items the nav
// renders, so gating can't drift — plus client-name search that jumps into the
// client panel (/clients/:id).
//
// The client list rides the shared ["/api/clients"] query (default queryFn),
// fetched only once the palette opens. The endpoint is role-scoped
// server-side (sales sees own book only), so no extra client-side gating is
// needed. Load/error states are surfaced explicitly under the list — never a
// silent empty group.
//
// Task #4494 — an "Actions" group runs quick verbs. Actions are declared on
// their owning QUICKLINKS_MANIFEST item (paletteActions/paletteClientActions),
// so gating derives from the same role-filtered items as destinations.
// Side-effecting verbs declare `confirm` and get an explicit keyboard
// Confirm/Cancel step before running.
// -------------------------------------------------------------------------------------

import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Building2, CircleCheck, Undo2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  buildPaletteGroups,
  collectPaletteActions,
  collectPaletteClientActions,
  type PaletteActionDeps,
} from "@/components/globalPaletteCore";
import type { QuicklinkItem } from "@/components/QuicklinksBar";

/** Narrow slice of the /api/clients row the palette reads. */
interface PaletteClient {
  id: string;
  firmName: string;
  clientCode?: string | null;
}

const MAX_CLIENT_MATCHES = 12;

export default function GlobalCommandPaletteDialog({
  open,
  onOpenChange,
  items,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: QuicklinkItem[];
}) {
  const [, setLocation] = useLocation();
  const [search, setSearch] = useState("");
  const { toast } = useToast();

  // Task #4494 — action awaiting its explicit keyboard confirm step. While
  // set, the list shows ONLY Confirm/Cancel so Enter can't hit anything else.
  const [pendingConfirm, setPendingConfirm] = useState<{
    label: string;
    confirm: string;
    execute: () => void | Promise<void>;
  } | null>(null);

  // Fresh slate every time the palette reopens.
  useEffect(() => {
    if (!open) {
      setSearch("");
      setPendingConfirm(null);
    }
  }, [open]);

  const groups = useMemo(() => buildPaletteGroups(items), [items]);
  const globalActions = useMemo(() => collectPaletteActions(items), [items]);
  const clientActionTemplates = useMemo(() => collectPaletteClientActions(items), [items]);

  const clientsQuery = useQuery<PaletteClient[]>({
    queryKey: ["/api/clients"],
    enabled: open,
    staleTime: 60_000,
    // Errors render inline below the list; the global request-failed toast
    // would double-report them.
    meta: { silent: true },
  });

  const q = search.trim().toLowerCase();
  const clientMatches = useMemo(() => {
    if (!q || !Array.isArray(clientsQuery.data)) return [];
    return clientsQuery.data
      .filter(
        (c) =>
          (c.firmName ?? "").toLowerCase().includes(q) ||
          (c.clientCode ?? "").toLowerCase().includes(q),
      )
      .sort((a, b) => (a.firmName ?? "").localeCompare(b.firmName ?? ""))
      .slice(0, MAX_CLIENT_MATCHES);
  }, [q, clientsQuery.data]);

  const go = (href: string) => {
    onOpenChange(false);
    setLocation(href);
  };

  // Deps handed to action `run`s — the palette closes first so navigation or
  // toasts land on a clean surface; async work continues fire-and-forget.
  const actionDeps: PaletteActionDeps = {
    navigate: setLocation,
    toast: (opts) => toast(opts),
  };

  const runAction = (execute: () => void | Promise<void>) => {
    onOpenChange(false);
    void execute();
  };

  /** Runs immediately, or arms the explicit confirm step for verbs that
   *  declare one (destructive / side-effecting actions). */
  const selectAction = (
    label: string,
    confirm: string | undefined,
    execute: () => void | Promise<void>,
  ) => {
    if (confirm) {
      // Clear the query so cmdk's filter can't hide the Confirm/Cancel rows.
      setSearch("");
      setPendingConfirm({ label, confirm, execute });
      return;
    }
    runAction(execute);
  };

  // Client-scoped actions instantiate against the TOP client match while the
  // user is searching (labels carry the firm name, so there's no ambiguity).
  const topClient = clientMatches[0];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="overflow-hidden p-0" data-testid="global-command-palette">
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <DialogDescription className="sr-only">
          Search pages, clients, and actions, then press Enter to jump or run.
        </DialogDescription>
        <Command
          onKeyDown={(e) => {
            // A second ⌘K/Ctrl+K closes the palette even while focus sits in
            // its own input. Without this, cmdk's built-in Ctrl+K vim-binding
            // (select previous item) preventDefaults the event, and the
            // window-level toggle listener in GlobalCommandPalette skips
            // defaultPrevented events — so Ctrl+K would move the selection
            // instead of closing. cmdk runs this handler first and skips its
            // own bindings once we preventDefault.
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
              e.preventDefault();
              onOpenChange(false);
            }
          }}
          className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0 [&_[cmdk-group]]:px-2 [&_[cmdk-input-wrapper]_svg]:h-5 [&_[cmdk-input-wrapper]_svg]:w-5 [&_[cmdk-input]]:h-12 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-3 [&_[cmdk-item]_svg]:h-5 [&_[cmdk-item]_svg]:w-5"
        >
          <CommandInput
            placeholder="Jump to a page or client, or run an action…"
            value={search}
            onValueChange={setSearch}
            data-testid="input-global-palette-search"
          />
          <CommandList data-testid="list-global-palette">
            {pendingConfirm ? (
              <CommandGroup heading={pendingConfirm.confirm}>
                <CommandItem
                  value="confirm"
                  onSelect={() => {
                    const { execute } = pendingConfirm;
                    setPendingConfirm(null);
                    runAction(execute);
                  }}
                  data-testid="palette-action-confirm"
                >
                  <CircleCheck aria-hidden="true" />
                  <span>Yes — {pendingConfirm.label}</span>
                </CommandItem>
                <CommandItem
                  value="cancel"
                  onSelect={() => setPendingConfirm(null)}
                  data-testid="palette-action-cancel"
                >
                  <Undo2 aria-hidden="true" />
                  <span>Cancel</span>
                </CommandItem>
              </CommandGroup>
            ) : (
              <>
            <CommandEmpty>No matches.</CommandEmpty>
            {groups.map((group) => (
              <CommandGroup key={group.heading} heading={group.heading}>
                {group.destinations.map((dest) => {
                  const Icon = dest.icon;
                  return (
                    <CommandItem
                      key={dest.id}
                      value={`${dest.label} ${dest.id}`}
                      keywords={[group.heading]}
                      onSelect={() => go(dest.href)}
                      data-testid={`palette-dest-${dest.id}`}
                    >
                      <Icon aria-hidden="true" />
                      <span>{dest.label}</span>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            ))}
            {(globalActions.length > 0 || (topClient && clientActionTemplates.length > 0)) && (
              <CommandGroup heading="Actions">
                {topClient &&
                  clientActionTemplates.map((tpl) => {
                    const Icon = tpl.icon;
                    const label = tpl.label(topClient);
                    return (
                      <CommandItem
                        key={`${tpl.id}-${topClient.id}`}
                        value={`${label} ${tpl.id}`}
                        keywords={["Actions"]}
                        onSelect={() =>
                          selectAction(label, tpl.confirm?.(topClient), () =>
                            tpl.run(topClient, actionDeps),
                          )
                        }
                        data-testid={`palette-action-client-${tpl.id}`}
                      >
                        <Icon aria-hidden="true" />
                        <span>{label}</span>
                      </CommandItem>
                    );
                  })}
                {globalActions.map((action) => {
                  const Icon = action.icon;
                  return (
                    <CommandItem
                      key={action.id}
                      value={`${action.label} ${action.id}`}
                      keywords={["Actions"]}
                      onSelect={() =>
                        selectAction(action.label, action.confirm, () => action.run(actionDeps))
                      }
                      data-testid={`palette-action-${action.id}`}
                    >
                      <Icon aria-hidden="true" />
                      <span>{action.label}</span>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            )}
            {clientMatches.length > 0 && (
              <CommandGroup heading="Clients">
                {clientMatches.map((client) => (
                  <CommandItem
                    key={client.id}
                    value={`${client.firmName} ${client.clientCode ?? ""} ${client.id}`}
                    onSelect={() => go(`/clients/${client.id}`)}
                    data-testid={`palette-client-${client.id}`}
                  >
                    <Building2 aria-hidden="true" />
                    <span>{client.firmName}</span>
                    {client.clientCode && (
                      <span className="ml-auto text-caption text-muted-foreground">
                        {client.clientCode}
                      </span>
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
              </>
            )}
          </CommandList>
          {q.length > 0 && clientsQuery.isLoading && (
            <div
              className="border-t px-3 py-2 text-caption text-muted-foreground"
              data-testid="text-palette-clients-loading"
            >
              Loading clients…
            </div>
          )}
          {q.length > 0 && clientsQuery.isError && (
            <div
              className="border-t px-3 py-2 text-caption text-destructive"
              data-testid="text-palette-clients-error"
            >
              Couldn't load clients — check your connection and try again.
            </div>
          )}
        </Command>
      </DialogContent>
    </Dialog>
  );
}
