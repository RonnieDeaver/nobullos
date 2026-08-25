// Task #4023 — client-side row shapes for the client file manager.
// These mirror the server JSON (timestamps arrive as ISO strings, so the
// drizzle $inferSelect types — which use Date — are deliberately not used).

export interface FileRow {
  id: string;
  clientId: string;
  folderId: string | null;
  name: string;
  mimeType: string;
  sizeBytes: number;
  objectKey: string;
  uploadedBy: string | null;
  trashedAt: string | null;
  trashedBy: string | null;
  trashedFromFolderId: string | null;
  createdAt: string;
  contentUpdatedAt: string;
  updatedAt: string;
}

export interface FolderRow {
  id: string;
  parentId: string | null;
  name: string;
}

export interface Breadcrumb {
  id: string;
  name: string;
}

export interface BrowseResponse {
  folders: FolderRow[];
  files: FileRow[];
  breadcrumbs: Breadcrumb[];
}

export interface VersionRow {
  id: string;
  fileId: string;
  clientId: string;
  versionNumber: number;
  mimeType: string;
  sizeBytes: number;
  objectKey: string;
  uploadedBy: string | null;
  uploadedAt: string;
  supersededAt: string;
}

export interface ActivityRow {
  id: string;
  clientId: string;
  fileId: string | null;
  folderId: string | null;
  action: string;
  actorId: string | null;
  actorName: string;
  detail: Record<string, unknown> | null;
  createdAt: string;
}

export interface FileDetailResponse {
  file: FileRow;
  versions: VersionRow[];
  activity: ActivityRow[];
}

export interface SearchRow extends FileRow {
  folderName: string | null;
  firmName: string;
}

export interface SearchResponse {
  files: SearchRow[];
  total: number;
}

export interface UsageResponse {
  liveCount: number;
  liveBytes: number;
  versionCount: number;
  versionBytes: number;
  trashCount: number;
  trashBytes: number;
  totalBytes: number;
}

export interface PerClientUsageRow {
  clientId: string;
  firmName: string;
  liveCount: number;
  liveBytes: number;
  versionBytes: number;
  trashBytes: number;
  totalBytes: number;
}

export interface AllUsageResponse {
  clients: PerClientUsageRow[];
  totals: { clients: number; liveCount: number; totalBytes: number };
}

// Task #4028 — external share links.
export interface ShareLinkRow {
  id: string;
  clientId: string;
  fileId: string;
  createdBy: string | null;
  createdByName: string;
  expiresAt: string;
  revokedAt: string | null;
  revokedBy: string | null;
  accessCount: number;
  lastAccessedAt: string | null;
  createdAt: string;
}

export interface ShareListResponse {
  shares: ShareLinkRow[];
}

export function filesBase(clientId: string): string {
  return `/api/clients/${clientId}/files`;
}

export function downloadUrl(
  clientId: string,
  fileId: string,
  disposition?: "inline",
): string {
  return `${filesBase(clientId)}/${fileId}/download${disposition ? "?disposition=inline" : ""}`;
}

export function versionDownloadUrl(
  clientId: string,
  fileId: string,
  versionId: string,
): string {
  return `${filesBase(clientId)}/${fileId}/versions/${versionId}/download`;
}

/** Human "Aug 7, 2026, 3:12 PM" for ISO timestamps. */
export function formatWhen(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export const ACTIVITY_LABELS: Record<string, string> = {
  uploaded: "uploaded",
  version_uploaded: "uploaded a new version of",
  version_restored: "restored a version of",
  renamed: "renamed",
  moved: "moved",
  trashed: "trashed",
  restored: "restored",
  purged: "permanently deleted",
  downloaded: "downloaded",
  shared: "created a share link for",
  share_replaced: "replaced a share link for",
  share_revoked: "revoked a share link for",
  folder_created: "created folder",
  folder_renamed: "renamed folder",
  folder_moved: "moved folder",
  folder_deleted: "deleted folder",
};

export function describeActivity(a: ActivityRow): string {
  const label = ACTIVITY_LABELS[a.action] ?? a.action;
  const name =
    (a.detail && typeof a.detail.name === "string" && a.detail.name) || "";
  return `${a.actorName || "Someone"} ${label}${name ? ` “${name}”` : ""}`;
}
