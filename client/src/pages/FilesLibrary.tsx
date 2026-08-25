/**
 * FilesLibrary — Task #4023. Global cross-client file library: search every
 * client's files by name with type filters, see recent uploads, jump into a
 * client's Files tab, preview/download inline, and (team leads+) review
 * per-client storage usage.
 */
import { useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { usePageTitle } from "@/hooks/use-page-title";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Clock,
  Download,
  ExternalLink,
  FolderOpen,
  HardDrive,
  Loader2,
  Search,
  X,
} from "lucide-react";
import {
  CLIENT_FILE_KIND_LABELS,
  CLIENT_FILE_KINDS,
  formatByteSize,
  type ClientFileKind,
} from "@shared/clientFiles";
import { FileKindIcon } from "@/components/clientFiles/fileKind";
import { FilePreviewDialog } from "@/components/clientFiles/FilePreviewDialog";
import {
  downloadUrl,
  formatWhen,
  type AllUsageResponse,
  type SearchResponse,
  type SearchRow,
} from "@/components/clientFiles/types";
import {
  OsTable,
  type OsTableColumn,
  type OsTableSort,
} from "@/components/ui/os-table";

export default function FilesLibrary() {
  usePageTitle("Files");
  const { user } = useAuth();
  const [, navigate] = useLocation();
  const [searchInput, setSearchInput] = useState("");
  const [kind, setKind] = useState<string>("all");
  const [previewRow, setPreviewRow] = useState<SearchRow | null>(null);
  const [usageOpen, setUsageOpen] = useState(false);

  // Task #4371 — bounded results table (audit §7.3): client pagination +
  // controlled sort on the shared OsTable primitive.
  const [fileSort, setFileSort] = useState<OsTableSort | null>({
    key: "modified",
    direction: "desc",
  });
  const [filePage, setFilePage] = useState(1);
  const [filePageSize, setFilePageSize] = useState(25);

  const role = (user as any)?.role as string | undefined;
  const isTeamLead = role === "team_lead" || role === "ceo";

  const q = searchInput.trim();
  const filtering = q.length >= 2 || kind !== "all";

  // ── Server mode (Task #4488): search, sort AND pagination run on the
  // server — the browser only ever downloads the current page.
  const pageParams = useMemo(() => {
    const params = new URLSearchParams();
    if (fileSort) {
      params.set("sort", fileSort.key);
      params.set("dir", fileSort.direction);
    }
    params.set("limit", String(filePageSize));
    params.set("offset", String((filePage - 1) * filePageSize));
    return params;
  }, [fileSort, filePage, filePageSize]);

  const searchUrl = useMemo(() => {
    const params = new URLSearchParams(pageParams);
    if (q.length >= 2) params.set("q", q);
    if (kind !== "all") params.set("kind", kind);
    return `/api/files?${params.toString()}`;
  }, [q, kind, pageParams]);

  const recentUrl = useMemo(
    () => `/api/files/recent?${pageParams.toString()}`,
    [pageParams],
  );

  const { data: results, isLoading: searchLoading } = useQuery<SearchResponse>({
    queryKey: [searchUrl],
    enabled: filtering,
  });
  const { data: recent, isLoading: recentLoading } = useQuery<SearchResponse>({
    queryKey: [recentUrl],
    enabled: !filtering,
  });
  const { data: usage } = useQuery<AllUsageResponse>({
    queryKey: ["/api/files/usage"],
    enabled: isTeamLead && usageOpen,
  });

  const activeData = filtering ? results : recent;
  const rows = activeData?.files ?? [];
  const fileTotal = activeData?.total ?? rows.length;
  const loading = filtering ? searchLoading : recentLoading;

  const filePageCount = Math.max(1, Math.ceil(fileTotal / filePageSize));
  const fileSafePage = Math.min(filePage, filePageCount);
  const pagedRows = rows;

  const fileColumns: Array<OsTableColumn<SearchRow>> = [
    {
      key: "name",
      header: "Name",
      sortable: true,
      cell: (file) => (
        <button
          type="button"
          className="group flex min-w-0 max-w-full items-center gap-2 text-left"
          onClick={(e) => {
            e.stopPropagation();
            setPreviewRow(file);
          }}
          data-testid={`global-file-name-${file.id}`}
        >
          <FileKindIcon mimeType={file.mimeType} fileName={file.name} />
          <span className="truncate text-foreground group-hover:text-primary-ink group-hover:underline">
            {file.name}
          </span>
          {file.trashedAt && (
            <Badge
              variant="outline"
              className="shrink-0 border-red-200 text-red-500"
            >
              Trash
            </Badge>
          )}
        </button>
      ),
    },
    {
      key: "client",
      header: "Client",
      sortable: true,
      width: 170,
      cell: (file) => (
        <Link
          href={`/clients/${file.clientId}?tab=files`}
          className="text-primary-ink/80 hover:text-primary-ink hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          {file.firmName}
        </Link>
      ),
    },
    {
      key: "folder",
      header: "Folder",
      sortable: true,
      width: 140,
      cell: (file) => (
        <span className="text-muted-foreground">
          {file.trashedAt ? "Trash" : (file.folderName ?? "Files")}
        </span>
      ),
    },
    {
      key: "size",
      header: "Size",
      sortable: true,
      width: 96,
      cell: (file) => (
        <span className="whitespace-nowrap text-muted-foreground">
          {formatByteSize(file.sizeBytes)}
        </span>
      ),
    },
    {
      key: "modified",
      header: "Modified",
      sortable: true,
      width: 150,
      cell: (file) => (
        <span className="whitespace-nowrap text-muted-foreground">
          {formatWhen(file.contentUpdatedAt)}
        </span>
      ),
    },
    {
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      align: "right",
      width: 88,
      cell: (file) => (
        <div className="flex items-center justify-end gap-0.5">
          <Button
            asChild
            size="icon"
            variant="ghost"
            className="h-7 w-7 text-muted-foreground hover:text-primary-ink"
            title="Download"
          >
            <a
              href={downloadUrl(file.clientId, file.id)}
              aria-label={`Download ${file.name}`}
              onClick={(e) => e.stopPropagation()}
              data-testid={`button-global-download-${file.id}`}
            >
              <Download className="w-3.5 h-3.5" />
            </a>
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7 text-muted-foreground hover:text-primary-ink"
            title="Open in client"
            aria-label={`Open ${file.name} in its client's Files tab`}
            onClick={(e) => {
              e.stopPropagation();
              navigate(`/clients/${file.clientId}?tab=files`);
            }}
            data-testid={`button-global-open-${file.id}`}
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div className="min-h-[calc(100dvh-var(--nav-height))] bg-surface-warm-2">
      <div className="max-w-6xl mx-auto px-4 py-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
              <FolderOpen className="w-6 h-6" />
              Files
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Every client's files, stored in the app. Open a client's Files
              tab to upload or organize.
            </p>
          </div>
          {isTeamLead && (
            <Button
              variant="outline"
              onClick={() => setUsageOpen((v) => !v)}
              data-testid="button-toggle-usage"
            >
              <HardDrive className="w-4 h-4 mr-1.5" />
              Storage usage
            </Button>
          )}
        </div>

        {isTeamLead && usageOpen && (
          <div className="border border-[#E8DED5] rounded-xl bg-card p-4" data-testid="usage-panel">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-foreground">
                Storage usage by client
              </h2>
              {usage && (
                <p className="text-xs text-muted-foreground">
                  {usage.totals.clients} client{usage.totals.clients === 1 ? "" : "s"} ·{" "}
                  {usage.totals.liveCount} live file{usage.totals.liveCount === 1 ? "" : "s"} ·{" "}
                  {formatByteSize(usage.totals.totalBytes)} total
                </p>
              )}
            </div>
            {!usage ? (
              <div className="flex justify-center py-6">
                <Loader2 className="w-5 h-5 animate-spin text-primary/40" />
              </div>
            ) : usage.clients.length === 0 ? (
              <p className="text-sm text-muted-foreground">No files stored yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-muted-foreground text-left border-b border-border">
                      <th className="py-1.5 pr-2 font-medium">Client</th>
                      <th className="py-1.5 px-2 font-medium text-right">Files</th>
                      <th className="py-1.5 px-2 font-medium text-right">Live</th>
                      <th className="py-1.5 px-2 font-medium text-right">Versions</th>
                      <th className="py-1.5 px-2 font-medium text-right">Trash</th>
                      <th className="py-1.5 pl-2 font-medium text-right">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {usage.clients.map((row) => (
                      <tr key={row.clientId} className="border-b border-slate-50 last:border-0" data-testid={`usage-row-${row.clientId}`}>
                        <td className="py-1.5 pr-2">
                          <Link
                            href={`/clients/${row.clientId}?tab=files`}
                            className="text-primary-ink hover:underline"
                          >
                            {row.firmName}
                          </Link>
                        </td>
                        <td className="py-1.5 px-2 text-right text-muted-foreground">{row.liveCount}</td>
                        <td className="py-1.5 px-2 text-right text-muted-foreground">{formatByteSize(row.liveBytes)}</td>
                        <td className="py-1.5 px-2 text-right text-muted-foreground">{formatByteSize(row.versionBytes)}</td>
                        <td className="py-1.5 px-2 text-right text-muted-foreground">{formatByteSize(row.trashBytes)}</td>
                        <td className="py-1.5 pl-2 text-right font-medium text-foreground">{formatByteSize(row.totalBytes)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[220px] max-w-md">
            <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchInput}
              onChange={(e) => {
                setSearchInput(e.target.value);
                setFilePage(1);
              }}
              placeholder="Search all client files…"
              className="pl-8"
              data-testid="input-global-file-search"
            />
            {searchInput && (
              <button
                type="button"
                onClick={() => {
                  setSearchInput("");
                  setFilePage(1);
                }}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-muted-foreground"
                aria-label="Clear search"
                data-testid="button-clear-file-search"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
          <Select
            value={kind}
            onValueChange={(v) => {
              setKind(v);
              setFilePage(1);
            }}
          >
            <SelectTrigger className="w-[150px]" data-testid="select-kind-filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All types</SelectItem>
              {CLIENT_FILE_KINDS.map((k: ClientFileKind) => (
                <SelectItem key={k} value={k}>
                  {CLIENT_FILE_KIND_LABELS[k]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {!filtering && (
          <p className="text-sm text-muted-foreground flex items-center gap-1.5">
            <Clock className="w-4 h-4" />
            Recently updated
          </p>
        )}

        {loading ? (
          <div className="flex justify-center py-16">
            <Loader2 className="w-6 h-6 animate-spin text-primary/40" />
          </div>
        ) : rows.length === 0 ? (
          <div className="text-center py-16 text-muted-foreground border border-dashed border-border rounded-xl bg-muted/60">
            <FolderOpen className="w-10 h-10 mx-auto mb-3 opacity-40" />
            <p className="text-sm">
              {filtering
                ? "No files match your search."
                : "No files yet — open a client's Files tab to upload."}
            </p>
          </div>
        ) : (
          <OsTable
            data-testid="files-results-table"
            rows={pagedRows}
            rowKey={(file) => file.id}
            columns={fileColumns}
            sort={fileSort}
            onSortChange={(s) => {
              setFileSort(s);
              setFilePage(1);
            }}
            onRowClick={(file) => setPreviewRow(file)}
            stickyFirstColumn={false}
            pagination={{
              page: fileSafePage,
              pageSize: filePageSize,
              total: fileTotal,
              onPageChange: setFilePage,
              onPageSizeChange: (size) => {
                setFilePageSize(size);
                setFilePage(1);
              },
              pageSizeOptions: [25, 50, 100],
            }}
          />
        )}
      </div>

      {previewRow && (
        <FilePreviewDialog
          clientId={previewRow.clientId}
          file={previewRow}
          onClose={() => setPreviewRow(null)}
        />
      )}
    </div>
  );
}
