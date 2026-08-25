/**
 * Task #4305 — canonical builder for Conversation Hub deep links.
 * Task #4373 (audit §8.4-b): the Conversation Hub converged into /comms as
 * its "clients" view, so built links target `/comms?view=clients&…` and
 * legacy `/conversations?…` URLs redirect through
 * `legacyConversationsUrlToComms` below.
 *
 * The hub view (client/src/pages/ConversationHub.tsx, embedded by
 * client/src/pages/Comms.tsx) consumes these query params: `threadKey`,
 * `convId`, `phone`, `contactName`, `clientId`, `intent` ("message" |
 * "call"). It matches an existing thread by phone when one exists, otherwise
 * pre-fills the composer (message) or dialer (call) — all message/call
 * traffic then flows through the existing Twilio paths. After consumption
 * the hub strips only its own params (DEEP_LINK_PARAM_KEYS), so
 * `view=clients` survives and the URL stays on the clients view.
 *
 * This module is the ONE place profile surfaces build those links from
 * (client profile header quick actions, Command Panel client-info phone,
 * contact rows, Comms tab) so there is a single comms flow, not two. It is
 * deliberately dependency-free so tests can exercise it as a pure function.
 */

export function buildContactHubUrl(params: Record<string, string>): string {
  const sp = new URLSearchParams();
  // `view` first so links read as "the clients view of /comms"; the loop
  // skips any stray `view` key so the target view can't be overridden.
  sp.set("view", "clients");
  for (const [k, v] of Object.entries(params)) if (v && k !== "view") sp.set(k, v);
  return `/comms?${sp.toString()}`;
}

/**
 * Task #4373: map a legacy `/conversations` URL search string onto the
 * converged `/comms` clients view, preserving every deep-link param
 * (threadKey/convId/phone/contactName/clientId/intent — and anything else,
 * unrecognized params were always ignored). Any stale `view` param in the
 * legacy URL is dropped: it belonged to no contract on /conversations and
 * must not steer the comms view. Pure so the redirect is unit-testable.
 */
export function legacyConversationsUrlToComms(search: string): string {
  const sp = new URLSearchParams(search);
  sp.delete("view");
  const rest = sp.toString();
  return rest ? `/comms?view=clients&${rest}` : "/comms?view=clients";
}

export interface ClientPhoneOption {
  /** The phone exactly as stored — passed through to the hub deep link. */
  phone: string;
  /** Person the number belongs to (used for compose/dialer pre-fill). */
  contactName: string;
  /** Human label for pickers, e.g. "Jane Roe — (555) 123-4567". */
  label: string;
}

/**
 * Normalization key used ONLY for de-duplication, mirroring how the
 * Conversation Hub matches threads by phone (last 10 digits). "+1 (555)
 * 123-4567" and "5551234567" are the same number and must not appear twice
 * in a picker.
 */
export function phoneDedupeKey(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.slice(-10) || phone.trim();
}

/**
 * Collect every known phone number for a client into picker options:
 *   1. the client's primary contact phone (clients.contact_phone), first;
 *   2. contact-record phones (client_contacts.phones), primary contacts
 *      before the rest, preserving stored order otherwise.
 * Blank entries are dropped; duplicates (per phoneDedupeKey) keep the first
 * occurrence, so the client-level number wins the label.
 */
export function collectClientPhoneOptions(input: {
  contactName?: string | null;
  contactPhone?: string | null;
  contacts?: Array<{
    name: string;
    phones?: string[] | null;
    isPrimary?: boolean | null;
  }> | null;
}): ClientPhoneOption[] {
  const out: ClientPhoneOption[] = [];
  const seen = new Set<string>();

  const push = (rawPhone: string | null | undefined, contactName: string) => {
    const phone = (rawPhone ?? "").trim();
    if (!phone) return;
    const key = phoneDedupeKey(phone);
    if (seen.has(key)) return;
    seen.add(key);
    const name = contactName.trim();
    out.push({
      phone,
      contactName: name,
      label: name ? `${name} — ${phone}` : phone,
    });
  };

  push(input.contactPhone, input.contactName?.trim() || "Primary contact");

  // Stable sort: primary contacts first, otherwise stored order.
  const contacts = [...(input.contacts ?? [])].sort(
    (a, b) => Number(!!b.isPrimary) - Number(!!a.isPrimary),
  );
  for (const c of contacts) {
    for (const p of c.phones ?? []) push(p, c.name);
  }

  return out;
}
