import { useAuth } from "@/hooks/use-auth";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/kit/EmptyState";
import { Link } from "wouter";
import { PageHeader } from "@/components/admin/PageHeader";
import { Webhook, RefreshCw, FileText, AlertTriangle, CheckCircle2, XCircle, Clock } from "lucide-react";
import type { WebhookImportLog } from "@shared/schema";

export default function WebhookImportLogs() {
  const { user, isLoading: authLoading } = useAuth();

  const { data: logs = [], isLoading } = useQuery<WebhookImportLog[]>({
    queryKey: ["/api/webhook-import-logs"],
    refetchInterval: 10000,
  });

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "success":
        return <Badge className="bg-green-500" data-testid="badge-success"><CheckCircle2 className="w-3 h-3 mr-1" />Success</Badge>;
      case "error":
        return <Badge variant="destructive" data-testid="badge-error"><XCircle className="w-3 h-3 mr-1" />Error</Badge>;
      case "auth_failed":
        return <Badge variant="destructive" data-testid="badge-auth-failed"><XCircle className="w-3 h-3 mr-1" />Auth Failed</Badge>;
      case "validation_error":
        return <Badge className="bg-amber-500" data-testid="badge-validation"><AlertTriangle className="w-3 h-3 mr-1" />Validation</Badge>;
      case "client_not_found":
        return <Badge className="bg-amber-500" data-testid="badge-not-found"><AlertTriangle className="w-3 h-3 mr-1" />Not Found</Badge>;
      case "duplicate":
        return <Badge variant="secondary" data-testid="badge-duplicate"><Clock className="w-3 h-3 mr-1" />Duplicate</Badge>;
      case "pending":
        return <Badge variant="outline" data-testid="badge-pending"><Clock className="w-3 h-3 mr-1" />Pending</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  const successCount = logs.filter(l => l.status === "success").length;
  const errorCount = logs.filter(l => ["error", "auth_failed", "validation_error", "client_not_found"].includes(l.status)).length;
  const duplicateCount = logs.filter(l => l.status === "duplicate").length;

  if (authLoading) {
    return (
      <div className="flex items-center justify-center min-h-[calc(100dvh-var(--nav-height))]">
        <RefreshCw className="w-8 h-8 animate-spin text-gray-400" />
      </div>
    );
  }

  if (!user || user.role !== "ceo") {
    return (
      <div className="flex items-center justify-center min-h-[calc(100dvh-var(--nav-height))]">
        <p className="text-gray-500">Access denied. CEO role required.</p>
      </div>
    );
  }

  return (
    <div className="min-h-[calc(100dvh-var(--nav-height))] bg-surface-warm-1">
      <PageHeader
        title="Webhook Import Logs"
        backHref="/"
        backLabel="Dashboard"
        sticky
        className="px-3 sm:px-4 py-3 sm:py-4"
      />

      <main className="max-w-7xl mx-auto px-3 sm:px-4 py-4 sm:py-6 space-y-4">
        <div className="grid grid-cols-3 gap-2 sm:gap-4">
          <Card data-testid="card-success-count">
            <CardContent className="pt-4 pb-3 flex items-center gap-3">
              <CheckCircle2 className="w-8 h-8 text-green-500" />
              <div>
                <p className="text-2xl font-bold" data-testid="text-success-count">{successCount}</p>
                <p className="text-xs text-gray-500">Successful Imports</p>
              </div>
            </CardContent>
          </Card>
          <Card data-testid="card-error-count">
            <CardContent className="pt-4 pb-3 flex items-center gap-3">
              <XCircle className="w-8 h-8 text-red-500" />
              <div>
                <p className="text-2xl font-bold" data-testid="text-error-count">{errorCount}</p>
                <p className="text-xs text-gray-500">Failed Imports</p>
              </div>
            </CardContent>
          </Card>
          <Card data-testid="card-duplicate-count">
            <CardContent className="pt-4 pb-3 flex items-center gap-3">
              <Clock className="w-8 h-8 text-gray-400" />
              <div>
                <p className="text-2xl font-bold" data-testid="text-duplicate-count">{duplicateCount}</p>
                <p className="text-xs text-gray-500">Duplicates Skipped</p>
              </div>
            </CardContent>
          </Card>
        </div>

        <Card data-testid="card-webhook-logs">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Webhook className="w-5 h-5 text-primary" />
              Import Attempts
            </CardTitle>
            <CardDescription>
              Track automated report imports via webhook ({logs.length} total)
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="flex items-center justify-center py-8" data-testid="loading-webhook-logs">
                <RefreshCw className="w-6 h-6 animate-spin text-gray-400" />
              </div>
            ) : logs.length === 0 ? (
              <EmptyState
                testId="empty-webhook-logs"
                icon={<Webhook />}
                title="No webhook import attempts yet"
                description="Imports are triggered via POST /api/webhooks/report-import"
              />
            ) : (
              <div className="overflow-x-auto" data-testid="table-webhook-logs">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b">
                      <th className="text-left py-2 px-2 font-medium">Client</th>
                      <th className="text-center py-2 px-2 font-medium">Month</th>
                      <th className="text-center py-2 px-2 font-medium">Status</th>
                      <th className="text-left py-2 px-2 font-medium">PDF File</th>
                      <th className="text-center py-2 px-2 font-medium">Size</th>
                      <th className="text-center py-2 px-2 font-medium">Duration</th>
                      <th className="text-center py-2 px-2 font-medium">Sections</th>
                      <th className="text-left py-2 px-2 font-medium">Error</th>
                      <th className="text-left py-2 px-2 font-medium">Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {logs.map((log) => (
                      <tr key={log.id} className="border-b hover:bg-gray-50" data-testid={`row-webhook-log-${log.id}`}>
                        <td className="py-2 px-2" data-testid={`text-client-${log.id}`}>
                          <div className="font-medium truncate max-w-[160px]">{log.clientName || "-"}</div>
                          {log.clientId && (
                            <div className="text-xs text-gray-400 font-mono truncate max-w-[160px]">{log.clientId}</div>
                          )}
                        </td>
                        <td className="text-center py-2 px-2 font-mono text-xs" data-testid={`text-month-${log.id}`}>
                          {log.reportMonth || "-"}
                        </td>
                        <td className="text-center py-2 px-2" data-testid={`status-webhook-${log.id}`}>
                          {getStatusBadge(log.status)}
                        </td>
                        <td className="py-2 px-2 text-xs truncate max-w-[140px]" data-testid={`text-filename-${log.id}`}>
                          {log.pdfFileName || "-"}
                        </td>
                        <td className="text-center py-2 px-2 text-xs text-gray-500" data-testid={`text-size-${log.id}`}>
                          {log.pdfSizeBytes ? `${(log.pdfSizeBytes / 1024).toFixed(0)}KB` : "-"}
                        </td>
                        <td className="text-center py-2 px-2 text-xs text-gray-500" data-testid={`text-duration-${log.id}`}>
                          {log.durationMs ? `${(log.durationMs / 1000).toFixed(1)}s` : "-"}
                        </td>
                        <td className="text-center py-2 px-2" data-testid={`text-sections-${log.id}`}>
                          {log.sectionsCreated ? (
                            <div className="flex items-center justify-center gap-1">
                              <FileText className="w-3 h-3 text-green-500" />
                              <span className="text-xs">{(log.sectionsCreated as string[]).length}</span>
                            </div>
                          ) : "-"}
                        </td>
                        <td className="py-2 px-2 text-xs text-red-600 max-w-[200px] truncate" data-testid={`text-error-${log.id}`} title={log.errorMessage || undefined}>
                          {log.errorMessage || "-"}
                        </td>
                        <td className="py-2 px-2 text-gray-500 text-xs whitespace-nowrap" data-testid={`text-created-${log.id}`}>
                          {log.createdAt
                            ? new Date(log.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
                            : "-"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="mt-6 p-4 bg-gray-50 space-y-4">
              <h4 className="font-medium">Webhook API</h4>
              <div>
                <p className="text-sm text-gray-600 mb-2">Endpoint:</p>
                <code className="block bg-gray-100 p-2 rounded text-xs">POST /api/webhooks/report-import</code>
              </div>
              <div>
                <p className="text-sm text-gray-600 mb-2">Headers:</p>
                <code className="block bg-gray-100 p-2 rounded text-xs">Authorization: Bearer &lt;CEO_TOOLS_API_TOKEN&gt;</code>
              </div>
              <div>
                <p className="text-sm text-gray-600 mb-2">Form Data (multipart):</p>
                <pre className="bg-gray-100 p-3 rounded text-xs overflow-x-auto">
{`clientId: "client-uuid"
reportMonth: "2025-01"
pdf: <file>`}
                </pre>
              </div>
            </div>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
