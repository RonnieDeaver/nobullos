import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, Plus, Trash2, Copy, Check, Webhook } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { PageHeader } from "@/components/admin/PageHeader";

interface CommsChannel {
  id: string;
  name: string | null;
  slug: string | null;
  type: string;
}

interface CommsWebhook {
  id: string;
  channelId: string;
  name: string;
  enabled: boolean;
  lastUsedAt: string | null;
  createdAt: string;
  channelName?: string | null;
  createdByName?: string | null;
}

interface CreateWebhookResponse {
  webhook: CommsWebhook;
  token: string;
}

export default function CommsWebhooks() {
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newChannelId, setNewChannelId] = useState("");
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [revokeId, setRevokeId] = useState<string | null>(null);

  const { data: webhooks = [], isLoading } = useQuery<CommsWebhook[]>({
    queryKey: ["/api/comms/webhooks"],
    queryFn: () => apiRequest("GET", "/api/comms/webhooks").then((r) => r.json()),
  });

  const { data: channels = [] } = useQuery<CommsChannel[]>({
    queryKey: ["/api/comms/channels/public"],
    queryFn: () => apiRequest("GET", "/api/comms/channels/public").then((r) => r.json()),
  });

  const createMutation = useMutation({
    mutationFn: () =>
      apiRequest("POST", "/api/comms/webhooks", {
        name: newName.trim() || "Incoming Webhook",
        channelId: newChannelId,
      }).then((r) => r.json() as Promise<CreateWebhookResponse>),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: ["/api/comms/webhooks"] }); // fire-and-forget: cache refresh only
      setCreatedToken(data.token);
      setNewName("");
      setNewChannelId("");
      setShowCreate(false);
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (id: string) =>
      apiRequest("DELETE", `/api/comms/webhooks/${id}`).then((r) => r.json()),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["/api/comms/webhooks"] }); // fire-and-forget: cache refresh only
      setRevokeId(null);
    },
  });

  const copyToken = async (token: string) => {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  };

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <PageHeader
        title="Comms Incoming Webhooks"
        icon={Webhook}
        backHref="/admin/integrations"
        actions={
          <Button onClick={() => setShowCreate(true)} data-testid="create-webhook-btn">
            <Plus className="h-4 w-4 mr-2" />
            New Webhook
          </Button>
        }
      />

      <p className="text-sm text-muted-foreground">
        Incoming webhooks let external tools post structured messages into Comms channels.
        Each webhook is a token-authenticated URL — share only with trusted services.
      </p>

      {isLoading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : webhooks.length === 0 ? (
        <div className="border border-dashed rounded-lg p-10 text-center text-muted-foreground text-sm">
          No webhooks created yet. Create one to let external tools post into Comms.
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Channel</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Last used</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="w-16" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {webhooks.map((wh) => (
              <TableRow key={wh.id} data-testid={`webhook-row-${wh.id}`}>
                <TableCell className="font-medium">{wh.name}</TableCell>
                <TableCell className="text-muted-foreground">{wh.channelName ?? wh.channelId.slice(0, 8)}</TableCell>
                <TableCell>
                  <Badge variant={wh.enabled ? "default" : "secondary"}>
                    {wh.enabled ? "Active" : "Revoked"}
                  </Badge>
                </TableCell>
                <TableCell className="text-muted-foreground text-sm">
                  {wh.lastUsedAt
                    ? formatDistanceToNow(new Date(wh.lastUsedAt), { addSuffix: true })
                    : "Never"}
                </TableCell>
                <TableCell className="text-muted-foreground text-sm">
                  {formatDistanceToNow(new Date(wh.createdAt), { addSuffix: true })}
                </TableCell>
                <TableCell>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setRevokeId(wh.id)}
                    disabled={!wh.enabled}
                    data-testid={`revoke-webhook-${wh.id}`}
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {/* Create dialog */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Incoming Webhook</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1">
              <label className="text-sm font-medium">Webhook name</label>
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. CI/CD Alerts, Backup Notifier"
                data-testid="webhook-name-input"
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">Channel</label>
              <Select value={newChannelId} onValueChange={setNewChannelId}>
                <SelectTrigger data-testid="webhook-channel-select">
                  <SelectValue placeholder="Select a channel…" />
                </SelectTrigger>
                <SelectContent>
                  {channels.map((ch) => (
                    <SelectItem key={ch.id} value={ch.id}>
                      #{ch.slug ?? ch.name ?? ch.id.slice(0, 8)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button
              onClick={() => createMutation.mutate()}
              disabled={!newChannelId || createMutation.isPending}
              data-testid="create-webhook-submit"
            >
              {createMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Token reveal dialog — shown once after creation */}
      <Dialog open={!!createdToken} onOpenChange={() => { setCreatedToken(null); setCopied(false); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Webhook Created — Copy Your Token Now</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <p className="text-sm text-muted-foreground">
              This token will <strong>never be shown again</strong>. Copy it now and store it
              somewhere safe. Anyone with this token can post messages to the channel.
            </p>
            <div className="flex items-center gap-2 bg-muted rounded-md px-3 py-2 font-mono text-xs break-all">
              <span className="flex-1 select-all">{createdToken}</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => createdToken && copyToken(createdToken)}
                data-testid="copy-token-btn"
              >
                {copied ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              POST JSON to:{" "}
              <code className="bg-muted px-1 rounded">{`/api/comms/incoming/${createdToken?.slice(0, 8)}…`}</code>
            </p>
          </div>
          <DialogFooter>
            <Button onClick={() => { setCreatedToken(null); setCopied(false); }} data-testid="close-token-dialog">
              I've saved the token
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Revoke confirm dialog */}
      <Dialog open={!!revokeId} onOpenChange={() => setRevokeId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke Webhook?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground py-2">
            This will permanently disable the webhook. Any external tool using it will stop
            being able to post messages. This cannot be undone.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRevokeId(null)}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={() => revokeId && revokeMutation.mutate(revokeId)}
              disabled={revokeMutation.isPending}
              data-testid="confirm-revoke-btn"
            >
              {revokeMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Revoke
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
