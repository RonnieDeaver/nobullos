import { ExternalLink } from "lucide-react";
import { parseTwilioError } from "@/lib/twilioError";

// Task #862: Toast description body for failed Twilio operations. Shows
// the human-readable reason, the Twilio error code (when present) and a
// "Learn more" link to the Twilio docs page for that code. Degrades to
// plain text for non-Twilio errors.
export function TwilioErrorToast({ error }: { error: string | null | undefined }) {
  const parsed = parseTwilioError(error);
  const hasMeta = parsed.code !== undefined || parsed.status !== undefined || !!parsed.moreInfo;

  return (
    <div className="space-y-1" data-testid="toast-twilio-error">
      <div data-testid="text-twilio-error-message">{parsed.message}</div>
      {hasMeta && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs opacity-90">
          {parsed.code !== undefined && (
            <span data-testid="text-twilio-error-code">Twilio code {parsed.code}</span>
          )}
          {parsed.status !== undefined && (
            <span data-testid="text-twilio-error-status">HTTP {parsed.status}</span>
          )}
          {parsed.moreInfo && (
            <a
              href={parsed.moreInfo}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 underline hover:no-underline"
              data-testid="link-twilio-error-docs"
            >
              Learn more
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
      )}
    </div>
  );
}
