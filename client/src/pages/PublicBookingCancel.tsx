import { useMemo, useState } from "react";
import { useRoute, useSearch } from "wouter";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  RadioGroup,
  RadioGroupItem,
} from "@/components/ui/radio-group";
import { AlertCircle, CheckCircle, Loader2 } from "lucide-react";

/**
 * Public cancel page for a confirmed booking. The signed cancel link
 * mints a `cancelToken` via `signHmacPayload("booking_cancel", meetingId)`
 * server-side; we forward that token unchanged to
 * `DELETE /api/booking/:id`. Per the epic's public scope policy
 * (#1032H), recurring meetings expose only `this_event` and
 * `entire_series` — `this_and_following` is staff-only.
 *
 * Whether the meeting is recurring is signalled by the `?recurring=1`
 * query param appended to the URL by whoever minted the link
 * (#1032E / future email pipeline). When absent we render the
 * one-off cancel UI unchanged.
 *
 * URL shape: `/book/cancel/:meetingId?token=…&recurring=1`
 */
export default function PublicBookingCancel() {
  const [, params] = useRoute<{ meetingId: string }>("/book/cancel/:meetingId");
  const search = useSearch();
  const meetingId = params?.meetingId || "";

  const query = useMemo(() => new URLSearchParams(search), [search]);
  const cancelToken = query.get("token") || query.get("cancelToken") || "";
  const isRecurring = query.get("recurring") === "1";

  const [scope, setScope] = useState<"this_event" | "entire_series">(
    "this_event",
  );
  const [reason, setReason] = useState("");

  const cancel = useMutation<
    { status: string; meetingId: string },
    Error & { code?: string }
  >({
    mutationFn: async () => {
      if (!meetingId || !cancelToken) {
        throw new Error("This cancel link is missing required information.");
      }
      const body: Record<string, unknown> = {
        cancelToken,
        reason: reason || undefined,
      };
      if (isRecurring) body.scope = scope;
      const res = await fetch(`/api/booking/${meetingId}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res
        .json()
        .catch(() => ({} as Record<string, unknown>));
      if (!res.ok) {
        const code = (json as { code?: string }).code;
        const msg =
          (json as { error?: string }).error ||
          "We couldn't cancel this meeting.";
        const err = new Error(msg) as Error & { code?: string };
        err.code = code;
        throw err;
      }
      return json as { status: string; meetingId: string };
    },
  });

  if (!meetingId || !cancelToken) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <Card className="max-w-md w-full" data-testid="card-cancel-link-invalid">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-status-critical">
              <AlertCircle className="w-5 h-5" /> Invalid cancel link
            </CardTitle>
            <CardDescription>
              This cancel link is missing required information. Please use the
              link from your confirmation email or contact your host.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  if (cancel.isSuccess) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <Card className="max-w-md w-full" data-testid="card-cancel-success">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-status-ok">
              <CheckCircle className="w-5 h-5" /> Meeting canceled
            </CardTitle>
            <CardDescription>
              {isRecurring && scope === "entire_series"
                ? "The entire series has been canceled and all attendees have been notified."
                : "This meeting has been canceled and all attendees have been notified."}
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 py-10 px-4 flex items-center justify-center">
      <Card className="max-w-md w-full" data-testid="page-public-cancel">
        <CardHeader>
          <CardTitle>Cancel this meeting?</CardTitle>
          <CardDescription>
            {isRecurring
              ? "Choose whether to cancel just this one occurrence or the entire series."
              : "Let your host know you can no longer make it."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {isRecurring && (
            <div className="space-y-2" data-testid="section-cancel-scope">
              <Label id="cancel-scope-label">Cancel</Label>
              <RadioGroup
                value={scope}
                onValueChange={(v) =>
                  setScope(v as "this_event" | "entire_series")
                }
                aria-labelledby="cancel-scope-label"
                data-testid="radio-cancel-scope"
              >
                <div className="flex items-center gap-2">
                  <RadioGroupItem
                    value="this_event"
                    id="scope-this-event"
                    data-testid="radio-scope-this-event"
                  />
                  <Label htmlFor="scope-this-event">This event only</Label>
                </div>
                <div className="flex items-center gap-2">
                  <RadioGroupItem
                    value="entire_series"
                    id="scope-entire-series"
                    data-testid="radio-scope-entire-series"
                  />
                  <Label htmlFor="scope-entire-series">Entire series</Label>
                </div>
              </RadioGroup>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="cancel-reason">Reason (optional)</Label>
            <Textarea
              id="cancel-reason"
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Let your host know what came up."
              data-testid="input-cancel-reason"
            />
          </div>

          {cancel.error && (
            <div
              className="rounded border border-status-critical/30 bg-status-critical/10 px-3 py-2 text-sm text-status-critical"
              role="alert"
              data-testid="text-cancel-error"
            >
              {cancel.error.message}
            </div>
          )}

          <Button
            type="button"
            onClick={() => cancel.mutate()}
            disabled={cancel.isPending}
            className="w-full bg-primary hover:bg-primary/90"
            data-testid="button-confirm-cancel"
          >
            {cancel.isPending ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Canceling…
              </>
            ) : isRecurring && scope === "entire_series" ? (
              "Cancel entire series"
            ) : (
              "Cancel meeting"
            )}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
