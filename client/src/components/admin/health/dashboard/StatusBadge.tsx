// Extracted verbatim from HealthDashboardSection.tsx (F11D decomposition, task #4160).
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, CheckCircle, XCircle } from "lucide-react";

export function StatusBadge({ status }: { status: string }) {
  if (status === "ok") {
    return (
      <Badge className="bg-green-100 text-green-700 hover:bg-green-100" data-testid="badge-status-ok">
        <CheckCircle className="w-3 h-3 mr-1" />
        Healthy
      </Badge>
    );
  }
  if (status === "degraded") {
    return (
      <Badge className="bg-amber-100 text-amber-700 hover:bg-amber-100" data-testid="badge-status-degraded">
        <AlertTriangle className="w-3 h-3 mr-1" />
        Degraded
      </Badge>
    );
  }
  // Task #992 — distinguish "writer is silent" (unknown) from a real DB
  // outage (error). `unknown` is rendered grey/neutral so operators do
  // not page on a sampler stall as if the DB itself were unhealthy.
  if (status === "unknown") {
    return (
      <Badge className="bg-gray-100 text-gray-700 hover:bg-gray-100" data-testid="badge-status-unknown">
        <AlertTriangle className="w-3 h-3 mr-1" />
        Unknown
      </Badge>
    );
  }
  return (
    <Badge className="bg-red-100 text-red-700 hover:bg-red-100" data-testid="badge-status-error">
      <XCircle className="w-3 h-3 mr-1" />
      Error
    </Badge>
  );
}