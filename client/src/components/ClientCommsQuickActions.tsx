/**
 * Task #4305 — one-click Text / Call actions for the client profile.
 *
 * Both components deep-link into the Conversation Hub via the shared
 * buildContactHubUrl helper (client/src/lib/contactHubUrl.ts) — the SAME
 * canonical path the contact-row icons already use — so profile surfaces
 * never grow a second comms flow. No native tel:/sms: links: the hub routes
 * through the app's own Twilio browser/forward call + SMS flows.
 *
 *  - <ClientCommsQuickActions> — prominent header buttons. Resolves the
 *    target number from the client's primary contact phone, falling back to
 *    contact-record phones; shows a picker when several distinct numbers are
 *    known and a disabled hint when none are.
 *  - <PhoneHubIconActions> — the small message/call icon pair used beside a
 *    specific phone number (contact rows, Command Panel client info).
 */
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MessageSquare, Phone } from "lucide-react";
import {
  buildContactHubUrl,
  collectClientPhoneOptions,
  type ClientPhoneOption,
} from "@/lib/contactHubUrl";

type HubIntent = "message" | "call";

function openHub(clientId: string, intent: HubIntent, opt: ClientPhoneOption): void {
  window.open(
    buildContactHubUrl({
      phone: opt.phone,
      contactName: opt.contactName,
      ...(clientId ? { clientId } : {}),
      intent,
    }),
    "_blank",
  );
}

const NO_PHONE_HINT =
  "No phone number on file — add one via Edit or the Command Panel contacts";

interface ClientCommsQuickActionsProps {
  clientId: string;
  contactName?: string | null;
  contactPhone?: string | null;
  contacts?: Array<{
    name: string;
    phones?: string[] | null;
    isPrimary?: boolean | null;
  }> | null;
}

const QUICK_ACTION_DEFS: Array<{
  intent: HubIntent;
  label: string;
  Icon: typeof MessageSquare;
  testId: string;
}> = [
  { intent: "message", label: "Text", Icon: MessageSquare, testId: "button-quick-text" },
  { intent: "call", label: "Call", Icon: Phone, testId: "button-quick-call" },
];

const HEADER_BUTTON_CLASSES =
  "border-primary/15 text-primary-ink hover:bg-primary/5 hover:border-primary/25 transition-colors";

export function ClientCommsQuickActions({
  clientId,
  contactName,
  contactPhone,
  contacts,
}: ClientCommsQuickActionsProps) {
  const options = collectClientPhoneOptions({ contactName, contactPhone, contacts });

  return (
    <>
      {QUICK_ACTION_DEFS.map(({ intent, label, Icon, testId }) => {
        const button = (
          <Button
            variant="outline"
            size="sm"
            disabled={options.length === 0}
            onClick={
              options.length === 1
                ? () => openHub(clientId, intent, options[0])
                : undefined
            }
            className={HEADER_BUTTON_CLASSES}
            aria-label={`${label} client in Conversation Hub`}
            data-testid={testId}
          >
            <Icon className="w-3.5 h-3.5 sm:mr-1.5" />
            <span className="hidden sm:inline">{label}</span>
          </Button>
        );

        if (options.length === 0) {
          // Disabled buttons swallow pointer events, so the hint lives on a
          // wrapping span (title + testid) instead of the button itself.
          return (
            <span
              key={intent}
              title={NO_PHONE_HINT}
              className="inline-flex"
              data-testid={`${testId}-no-phone`}
            >
              {button}
            </span>
          );
        }

        if (options.length === 1) {
          return <span key={intent} className="inline-flex">{button}</span>;
        }

        // Multiple known numbers — let the user pick which one to use.
        return (
          <DropdownMenu key={intent}>
            <DropdownMenuTrigger asChild>{button}</DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {options.map((opt, i) => (
                <DropdownMenuItem
                  key={`${opt.phone}-${i}`}
                  onClick={() => openHub(clientId, intent, opt)}
                  data-testid={`menuitem-quick-${intent}-${i}`}
                >
                  {opt.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        );
      })}
    </>
  );
}

interface PhoneHubIconActionsProps {
  phone: string;
  contactName?: string | null;
  clientId: string;
  messageTestId: string;
  callTestId: string;
}

/**
 * The small message/call icon pair rendered beside a phone number. Markup
 * and styling match the original contact-row buttons exactly (they now
 * render through this component too).
 */
export function PhoneHubIconActions({
  phone,
  contactName,
  clientId,
  messageTestId,
  callTestId,
}: PhoneHubIconActionsProps) {
  const opt: ClientPhoneOption = {
    phone,
    contactName: contactName ?? "",
    label: phone,
  };
  return (
    <>
      <button
        title="Message in Conversation Hub"
        onClick={() => openHub(clientId, "message", opt)}
        className="ml-0.5 p-0.5 rounded hover:bg-primary/10 text-primary-ink/50 hover:text-primary-ink transition-colors"
        data-testid={messageTestId}
      >
        <MessageSquare className="w-3 h-3" />
      </button>
      <button
        title="Call in Conversation Hub"
        onClick={() => openHub(clientId, "call", opt)}
        className="p-0.5 rounded hover:bg-primary/10 text-primary-ink/50 hover:text-primary-ink transition-colors"
        data-testid={callTestId}
      >
        <Phone className="w-3 h-3" />
      </button>
    </>
  );
}
