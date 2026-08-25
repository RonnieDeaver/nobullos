export type Participant = {
  phone: string;
  name?: string;
  contactId?: string;
};

export type RawConversation = {
  id: string;
  clientId: string | null;
  clientContactId: string | null;
  contactPhone: string;
  contactName: string | null;
  displayName: string | null;
  twilioPhoneNumber: string;
  status: string;
  conversationType: string;
  participants: Participant[] | null;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  unreadCount: number | null;
  clientName?: string;
};

export type RawMessage = {
  id: string;
  conversationId: string;
  twilioSid: string | null;
  direction: string;
  fromNumber: string;
  toNumber: string;
  body: string;
  status: string;
  // Task #875: Twilio's diagnostic info on failed/undelivered outbound
  // SMS. The thread view renders these as a tooltip on the badge.
  errorCode?: string | null;
  errorMessage?: string | null;
  // Task #883: transport actually used for the outbound message.
  // Non-null = sent via Messaging Service (RCS-capable Sender Pool);
  // null on outbound = legacy single-`from` path. Always null inbound.
  messagingServiceSid?: string | null;
  sentByUserId: string | null;
  createdAt: string;
  // Task #875: see CachedMessage.updatedAt — server bumps this on every
  // status-callback write so the thread view's incremental poll picks
  // up in-place status mutations (queued → sent → delivered) that
  // wouldn't otherwise change createdAt. Optional for legacy responses.
  updatedAt?: string;
};

export type RawCall = {
  id: string;
  clientId: string | null;
  clientContactId: string | null;
  twilioSid: string | null;
  direction: string;
  fromNumber: string;
  toNumber: string;
  status: string;
  duration: number | null;
  initiatedByUserId: string | null;
  routedToUserId: string | null;
  routingTier: number | null;
  answeredAt: string | null;
  createdAt: string;
  clientName?: string;
  initiatedByUserName?: string;
  routedToUserName?: string;
  accountManagerUserId?: string;
  accountManagerName?: string;
  recordingSid?: string | null;
  recordingUrl?: string | null;
  recordingDuration?: number | null;
  recordingStatus?: string | null;
  recordingChannels?: number | null;
  // Archive pipeline (migration 0041) — used by the Hub to render the
  // collapsible transcript alongside the audio player.
  transcriptText?: string | null;
  transcriptCompletedAt?: string | null;
  archiveStatus?: string | null;
  // Voicemail (migration 0055): populated by the
  // /webhooks/voicemail-recording-status and
  // /webhooks/voicemail-transcription handlers when an inbound call
  // falls through to <Record>. voicemailListenedAt is set the first
  // time a user opens the voicemail card.
  voicemailRecordingUrl?: string | null;
  voicemailRecordingDuration?: number | null;
  voicemailTranscriptionText?: string | null;
  voicemailTranscriptionStatus?: string | null;
  voicemailListenedAt?: string | null;
};

export type SmsEvent = {
  kind: "sms";
  id: string;
  conversationId: string;
  ts: Date;
  direction: "inbound" | "outbound";
  body: string;
  status: string;
  // Task #875: Twilio diagnostic info shown as a tooltip on the
  // badge when status is `failed` / `undelivered`.
  errorCode?: string | null;
  errorMessage?: string | null;
  // Task #883: see RawMessage.messagingServiceSid.
  messagingServiceSid?: string | null;
  fromNumber: string;
  toNumber: string;
  sentByUserId: string | null;
};

export type CallEvent = {
  kind: "call";
  id: string;
  ts: Date;
  direction: "inbound" | "outbound";
  rawStatus: string;
  status: CallDisplayStatus;
  durationSeconds: number | null;
  routingTier: number | null;
  callbackPhone: string;
  fromNumber: string;
  toNumber: string;
  initiatedByUserName?: string;
  routedToUserName?: string;
  accountManagerName?: string;
  twilioSid: string | null;
  // Recording metadata. recordingStatus mirrors Twilio's value
  // (completed | failed | absent | in-progress | null). The Hub renders
  // a player only when status === "completed" and recordingUrl is set.
  recordingStatus: string | null;
  recordingUrl: string | null;
  recordingDurationSeconds: number | null;
  // Transcript text from the archive pipeline. May lag the recording by
  // a minute or two; null while still queued / in-flight.
  transcriptText: string | null;
  archiveStatus: string | null;
  // Voicemail (Task #852). voicemailRecordingUrl is non-null iff the
  // call fell through to the <Record> verb. The Hub renders a dedicated
  // voicemail card (audio + transcript + "mark as listened") instead of
  // the standard Dial-recording UI when this is set.
  voicemailRecordingUrl: string | null;
  voicemailRecordingDurationSeconds: number | null;
  voicemailTranscriptionText: string | null;
  voicemailTranscriptionStatus: string | null;
  voicemailListenedAt: Date | null;
};

// Task #850: notes appear inline in the timeline as standalone events.
// `body` is the note text; `createdByName` is resolved server-side from
// the user table so the bubble can render an attribution line without
// the client having to join a /api/users response.
export type NoteEvent = {
  kind: "note";
  id: string;
  threadKey: string;
  ts: Date;
  body: string;
  createdByUserId: string | null;
  createdByName: string | null;
};

export type ConversationEvent = SmsEvent | CallEvent | NoteEvent;

// Task #850: server shape for GET /api/twilio/threads/:key/notes (and the
// bulk variant). Mirrors the storage row + the joined author display name.
export type RawThreadNote = {
  id: string;
  threadKey: string;
  body: string;
  createdByUserId: string | null;
  createdByName: string | null;
  createdAt: string;
};

// Task #850: server shape for GET /api/twilio/threads/:key/assignment
// and the bulk listing endpoint. `status` defaults to "open" server-side
// so unassigned threads still serialize cleanly.
export type RawThreadAssignment = {
  threadKey: string;
  assignedToUserId: string | null;
  status: ThreadStatus;
  updatedByUserId: string | null;
  updatedAt: string | null;
};

export type ThreadStatus = "open" | "needs_follow_up" | "resolved";

// Task #1685: server shape for GET /api/twilio/threads/read-states and
// the PATCH response. Global per-thread flag — see the route handler
// comment in `server/routes/twilio.ts` for the rationale.
export type RawThreadReadState = {
  threadKey: string;
  manuallyUnread: boolean;
  updatedByUserId: string | null;
  updatedAt: string | null;
};

export type CallDisplayStatus =
  | "completed"
  | "missed"
  | "no-answer"
  | "busy"
  | "failed"
  | "canceled"
  | "voicemail"
  | "in-progress"
  | "ringing"
  | "initiated";

export type SmsAvailabilityState = {
  available: boolean;
  reason?: string;
};

export type UnifiedThread = {
  key: string;
  contactName: string | null;
  contactPhone: string | null;
  contactId: string | null;
  clientId: string | null;
  clientName: string | null;
  isGroup: boolean;
  groupDisplayName: string | null;
  groupParticipants: Participant[];
  smsConversationIds: string[];
  primarySmsConversationId: string | null;
  twilioPhoneNumber: string | null;
  callIds: string[];
  lastActivityAt: Date | null;
  lastActivityPreview: string;
  lastActivityKind: "sms" | "call";
  lastActivityDirection: "inbound" | "outbound";
  unreadSmsCount: number;
  hasMissedCall: boolean;
  hasVoicemail: boolean;
  // Task #852: count of voicemails on this thread that have not yet
  // been opened (voicemail_listened_at IS NULL). Drives the "VM N"
  // inbox badge and the "Voicemails" filter chip.
  unheardVoicemailCount: number;
  needsReply: boolean;
  myConversation: boolean;
  smsAvailability: SmsAvailabilityState;
  displayName: string;
  callablePhones: string[];
  // Task #850: notes + assignment + status overlay. Populated by the
  // hub after `buildUnifiedConversationList` via `attachThreadOverlays`.
  noteCount: number;
  assignedToUserId: string | null;
  threadStatus: ThreadStatus;
  // Task #1685: operator pressed "Mark as unread" on this thread. Lives
  // alongside `unreadSmsCount` rather than replacing it because the
  // server-side row in `thread_read_states` is independent of the SMS
  // conversation's `unread_count` column — see the route handler for
  // the global-source-of-truth rationale.
  manuallyUnread: boolean;
};

export function normalizePhoneKey(phone: string | null | undefined): string {
  if (!phone) return "";
  return phone.replace(/\D/g, "").slice(-10);
}

export function formatPhone(phone: string | null | undefined): string {
  if (!phone) return "";
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) {
    return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return phone;
}

export function getInitials(name: string | null | undefined, fallback?: string | null): string {
  const trimmed = (name || "").trim();
  if (trimmed) {
    const parts = trimmed.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return parts[0].slice(0, 2).toUpperCase();
  }
  if (fallback) {
    const digits = fallback.replace(/\D/g, "");
    if (digits.length >= 2) return digits.slice(-2);
  }
  return "??";
}

export function isMissedCallStatus(status: string): boolean {
  return ["no-answer", "busy", "failed", "canceled"].includes(status);
}

export function formatCallStatus(status: string, direction: "inbound" | "outbound"): {
  label: string;
  display: CallDisplayStatus;
  tone: "success" | "warning" | "danger" | "muted";
} {
  if (status === "completed") return { label: "Completed", display: "completed", tone: "success" };
  if (status === "in-progress") return { label: "In progress", display: "in-progress", tone: "muted" };
  if (status === "ringing") return { label: "Ringing", display: "ringing", tone: "muted" };
  if (status === "initiated") return { label: "Calling", display: "initiated", tone: "muted" };
  if (status === "no-answer") {
    return { label: direction === "inbound" ? "Missed" : "No answer", display: "no-answer", tone: "danger" };
  }
  if (status === "busy") return { label: "Busy", display: "busy", tone: "warning" };
  if (status === "failed") return { label: "Failed", display: "failed", tone: "danger" };
  if (status === "canceled") return { label: "Canceled", display: "canceled", tone: "muted" };
  return { label: status, display: status as CallDisplayStatus, tone: "muted" };
}

export function getSmsAvailabilityState(thread: Pick<UnifiedThread, "contactPhone" | "callablePhones" | "isGroup">): SmsAvailabilityState {
  if (thread.isGroup) {
    if (!thread.callablePhones || thread.callablePhones.length === 0) {
      return { available: false, reason: "No participant phone numbers" };
    }
    return { available: true };
  }
  const phone = thread.contactPhone || thread.callablePhones[0] || "";
  if (!phone) return { available: false, reason: "Missing phone number" };
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 10) return { available: false, reason: "Invalid phone number" };
  return { available: true };
}

export function resolveThreadKey(opts: {
  isGroup?: boolean;
  convId?: string;
  contactId?: string | null;
  clientId?: string | null;
  phone?: string | null;
}): string {
  if (opts.isGroup && opts.convId) return `group:${opts.convId}`;
  if (opts.contactId) return `contact:${opts.contactId}`;
  const phoneNorm = normalizePhoneKey(opts.phone || "");
  if (opts.clientId && phoneNorm) return `client-phone:${opts.clientId}:${phoneNorm}`;
  if (phoneNorm) return `phone:${phoneNorm}`;
  return `unknown:${opts.convId || phoneNorm || Math.random().toString(36).slice(2)}`;
}

export function buildUnifiedConversationList(
  conversations: RawConversation[],
  calls: RawCall[],
  currentUserId: string | null,
): UnifiedThread[] {
  const threads = new Map<string, UnifiedThread>();

  const ensureThread = (key: string, init: () => UnifiedThread): UnifiedThread => {
    let t = threads.get(key);
    if (!t) {
      t = init();
      threads.set(key, t);
    }
    return t;
  };

  for (const conv of conversations) {
    const isGroup = conv.conversationType === "group";
    const participants = (conv.participants || []) as Participant[];

    const key = resolveThreadKey({
      isGroup,
      convId: conv.id,
      contactId: conv.clientContactId,
      clientId: conv.clientId,
      phone: conv.contactPhone,
    });

    const t = ensureThread(key, () => {
      const callablePhones = isGroup
        ? participants.map((p) => p.phone).filter(Boolean)
        : [conv.contactPhone].filter(Boolean);
      return {
        key,
        contactName: conv.contactName,
        contactPhone: isGroup ? null : conv.contactPhone,
        contactId: conv.clientContactId,
        clientId: conv.clientId,
        clientName: conv.clientName || null,
        isGroup,
        groupDisplayName: null,
        groupParticipants: isGroup ? participants : [],
        smsConversationIds: [],
        primarySmsConversationId: null,
        twilioPhoneNumber: conv.twilioPhoneNumber || null,
        callIds: [],
        lastActivityAt: null,
        lastActivityPreview: "",
        lastActivityKind: "sms" as const,
        lastActivityDirection: "outbound" as const,
        unreadSmsCount: 0,
        hasMissedCall: false,
        hasVoicemail: false,
        unheardVoicemailCount: 0,
        needsReply: false,
        myConversation: false,
        smsAvailability: { available: true },
        displayName: "",
        callablePhones,
        noteCount: 0,
        assignedToUserId: null,
        threadStatus: "open",
        manuallyUnread: false,
      };
    });

    t.smsConversationIds.push(conv.id);
    const convTs = conv.lastMessageAt ? new Date(conv.lastMessageAt).getTime() : 0;
    const currentPrimary = t.primarySmsConversationId
      ? conversations.find((c) => c.id === t.primarySmsConversationId)
      : null;
    const currentPrimaryTs = currentPrimary?.lastMessageAt ? new Date(currentPrimary.lastMessageAt).getTime() : 0;
    if (!t.primarySmsConversationId || convTs > currentPrimaryTs) {
      t.primarySmsConversationId = conv.id;
    }
    t.unreadSmsCount += conv.unreadCount || 0;
    if (conv.clientId && !t.clientId) t.clientId = conv.clientId;
    if (conv.clientName && !t.clientName) t.clientName = conv.clientName;
    if (conv.contactName && !t.contactName) t.contactName = conv.contactName;
    if (!t.twilioPhoneNumber && conv.twilioPhoneNumber) t.twilioPhoneNumber = conv.twilioPhoneNumber;
    if (conv.displayName && !t.groupDisplayName) t.groupDisplayName = conv.displayName;

    const ts = conv.lastMessageAt ? new Date(conv.lastMessageAt) : null;
    if (ts && (!t.lastActivityAt || ts > t.lastActivityAt)) {
      t.lastActivityAt = ts;
      t.lastActivityPreview = conv.lastMessagePreview || "";
      t.lastActivityKind = "sms";
      t.lastActivityDirection = (conv.unreadCount || 0) > 0 ? "inbound" : "outbound";
    }
  }

  for (const call of calls) {
    const direction = (call.direction === "inbound" ? "inbound" : "outbound") as "inbound" | "outbound";
    const otherPhone = direction === "inbound" ? call.fromNumber : call.toNumber;
    const key = resolveThreadKey({
      contactId: call.clientContactId,
      clientId: call.clientId,
      phone: otherPhone,
    });

    const t = ensureThread(key, () => ({
      key,
      contactName: null,
      contactPhone: otherPhone,
      contactId: call.clientContactId,
      clientId: call.clientId,
      clientName: call.clientName || null,
      isGroup: false,
      groupDisplayName: null,
      groupParticipants: [],
      smsConversationIds: [],
      primarySmsConversationId: null,
      twilioPhoneNumber: null,
      callIds: [],
      lastActivityAt: null,
      lastActivityPreview: "",
      lastActivityKind: "call" as const,
      lastActivityDirection: direction,
      unreadSmsCount: 0,
      hasMissedCall: false,
      hasVoicemail: false,
      unheardVoicemailCount: 0,
      needsReply: false,
      myConversation: false,
      smsAvailability: { available: true },
      displayName: "",
      callablePhones: [otherPhone].filter(Boolean),
      noteCount: 0,
      assignedToUserId: null,
      threadStatus: "open",
      manuallyUnread: false,
    }));

    t.callIds.push(call.id);
    if (call.clientId && !t.clientId) t.clientId = call.clientId;
    if (call.clientName && !t.clientName) t.clientName = call.clientName;
    if (call.clientContactId && !t.contactId) t.contactId = call.clientContactId;
    if (!t.contactPhone && otherPhone) t.contactPhone = otherPhone;
    if (otherPhone && !t.callablePhones.includes(otherPhone)) t.callablePhones.push(otherPhone);

    if (isMissedCallStatus(call.status) && direction === "inbound") {
      t.hasMissedCall = true;
      t.needsReply = true;
    }

    // Task #852: thread has a voicemail iff any inbound call has a
    // voicemail recording URL. "Unheard" is the subset where
    // voicemail_listened_at is still NULL.
    if (direction === "inbound" && call.voicemailRecordingUrl) {
      t.hasVoicemail = true;
      if (!call.voicemailListenedAt) {
        t.unheardVoicemailCount += 1;
        t.needsReply = true;
      }
    }

    const myCall =
      (currentUserId && call.routedToUserId === currentUserId) ||
      (currentUserId && call.initiatedByUserId === currentUserId);
    if (myCall) t.myConversation = true;

    const ts = call.createdAt ? new Date(call.createdAt) : null;
    if (ts && (!t.lastActivityAt || ts > t.lastActivityAt)) {
      t.lastActivityAt = ts;
      const status = formatCallStatus(call.status, direction);
      t.lastActivityPreview =
        direction === "inbound"
          ? isMissedCallStatus(call.status)
            ? "Missed call"
            : "Inbound call"
          : status.label === "No answer"
            ? "Outbound call · no answer"
            : "Outbound call";
      t.lastActivityKind = "call";
      t.lastActivityDirection = direction;
    }
  }

  for (const t of threads.values()) {
    if (t.isGroup) {
      t.displayName =
        t.groupDisplayName ||
        t.contactName ||
        t.groupParticipants.map((p) => p.name || p.phone).filter(Boolean).join(", ") ||
        "Group conversation";
    } else {
      t.displayName = t.contactName || formatPhone(t.contactPhone) || t.contactPhone || "Unknown";
    }
    t.smsAvailability = getSmsAvailabilityState({
      contactPhone: t.contactPhone,
      callablePhones: t.callablePhones,
      isGroup: t.isGroup,
    });
    if (t.unreadSmsCount > 0) t.needsReply = true;
  }

  return Array.from(threads.values()).sort((a, b) => {
    const at = a.lastActivityAt?.getTime() || 0;
    const bt = b.lastActivityAt?.getTime() || 0;
    return bt - at;
  });
}

export function buildConversationTimelineEvents(
  messages: RawMessage[],
  calls: RawCall[],
): ConversationEvent[] {
  const events: ConversationEvent[] = [];

  for (const m of messages) {
    events.push({
      kind: "sms",
      id: m.id,
      conversationId: m.conversationId,
      ts: new Date(m.createdAt),
      direction: m.direction === "outbound" ? "outbound" : "inbound",
      body: m.body,
      status: m.status,
      errorCode: m.errorCode ?? null,
      errorMessage: m.errorMessage ?? null,
      messagingServiceSid: m.messagingServiceSid ?? null,
      fromNumber: m.fromNumber,
      toNumber: m.toNumber,
      sentByUserId: m.sentByUserId,
    });
  }

  for (const c of calls) {
    const direction = (c.direction === "inbound" ? "inbound" : "outbound") as "inbound" | "outbound";
    const status = formatCallStatus(c.status, direction);
    events.push({
      kind: "call",
      id: c.id,
      ts: new Date(c.createdAt),
      direction,
      rawStatus: c.status,
      status: status.display,
      durationSeconds: c.duration,
      routingTier: c.routingTier,
      callbackPhone: direction === "inbound" ? c.fromNumber : c.toNumber,
      fromNumber: c.fromNumber,
      toNumber: c.toNumber,
      initiatedByUserName: c.initiatedByUserName,
      routedToUserName: c.routedToUserName,
      accountManagerName: c.accountManagerName,
      twilioSid: c.twilioSid,
      recordingStatus: c.recordingStatus ?? null,
      recordingUrl: c.recordingUrl ?? null,
      recordingDurationSeconds: c.recordingDuration ?? null,
      transcriptText: c.transcriptText ?? null,
      archiveStatus: c.archiveStatus ?? null,
      voicemailRecordingUrl: c.voicemailRecordingUrl ?? null,
      voicemailRecordingDurationSeconds: c.voicemailRecordingDuration ?? null,
      voicemailTranscriptionText: c.voicemailTranscriptionText ?? null,
      voicemailTranscriptionStatus: c.voicemailTranscriptionStatus ?? null,
      voicemailListenedAt: c.voicemailListenedAt ? new Date(c.voicemailListenedAt) : null,
    });
  }

  return events.sort((a, b) => a.ts.getTime() - b.ts.getTime());
}

export type TimelineGroup = {
  label: string;
  date: string;
  events: ConversationEvent[];
};

// Task #2778: generic day-grouping used by both the Conversation Hub
// timeline (via groupTimelineByDate below) and the client-page texting
// panel (ClientMessaging.tsx). Labels are "Today" / "Yesterday" /
// a localized date for older days; `month` picks the month style.
export type DayGroup<T> = {
  label: string;
  date: string; // yyyy-mm-dd key, sorted ascending
  items: T[];
};

export function groupItemsByDay<T>(
  items: T[],
  getTs: (item: T) => Date,
  opts?: { month?: "long" | "short" },
): DayGroup<T>[] {
  const month = opts?.month ?? "long";
  const groups = new Map<string, DayGroup<T>>();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);

  for (const item of items) {
    const d = new Date(getTs(item));
    d.setHours(0, 0, 0, 0);
    const key = d.toISOString().slice(0, 10);
    let label: string;
    if (d.getTime() === today.getTime()) label = "Today";
    else if (d.getTime() === yesterday.getTime()) label = "Yesterday";
    else label = d.toLocaleDateString(undefined, { month, day: "numeric", year: "numeric" });

    let g = groups.get(key);
    if (!g) {
      g = { label, date: key, items: [] };
      groups.set(key, g);
    }
    g.items.push(item);
  }

  return Array.from(groups.values()).sort((a, b) => a.date.localeCompare(b.date));
}

export function groupTimelineByDate(events: ConversationEvent[]): TimelineGroup[] {
  return groupItemsByDay(events, (e) => e.ts, { month: "long" }).map((g) => ({
    label: g.label,
    date: g.date,
    events: g.items,
  }));
}

export function formatCallDuration(seconds: number | null): string {
  if (!seconds || seconds <= 0) return "—";
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins === 0) return `${secs}s`;
  return `${mins}m ${secs}s`;
}

export type InboxFilter =
  | "all"
  | "unread"
  | "needs_reply"
  | "missed_calls"
  | "voicemails"
  | "mine"
  | "needs_follow_up"
  | "resolved";
export type ActivityFilter = "all" | "messages" | "calls";

// Task #850: layer notes + assignment + status onto threads built by
// `buildUnifiedConversationList`. Done as a separate pass so the
// existing builder stays a pure function of conversation/call data.
export function attachThreadOverlays(
  threads: UnifiedThread[],
  notes: RawThreadNote[],
  assignments: RawThreadAssignment[],
  readStates: RawThreadReadState[] = [],
): UnifiedThread[] {
  const noteCounts = new Map<string, number>();
  for (const n of notes) noteCounts.set(n.threadKey, (noteCounts.get(n.threadKey) || 0) + 1);
  const asnByKey = new Map<string, RawThreadAssignment>();
  for (const a of assignments) asnByKey.set(a.threadKey, a);
  const readByKey = new Map<string, RawThreadReadState>();
  for (const r of readStates) readByKey.set(r.threadKey, r);
  return threads.map((t) => {
    const a = asnByKey.get(t.key);
    const r = readByKey.get(t.key);
    return {
      ...t,
      noteCount: noteCounts.get(t.key) || 0,
      assignedToUserId: a?.assignedToUserId ?? null,
      threadStatus: (a?.status as ThreadStatus) || "open",
      manuallyUnread: r?.manuallyUnread === true,
    };
  });
}

// Task #850: produce note timeline events for a single thread.
export function buildNoteTimelineEvents(notes: RawThreadNote[]): NoteEvent[] {
  return notes.map((n) => ({
    kind: "note" as const,
    id: n.id,
    threadKey: n.threadKey,
    ts: new Date(n.createdAt),
    body: n.body,
    createdByUserId: n.createdByUserId,
    createdByName: n.createdByName,
  }));
}

export function filterThreadsByInbox(threads: UnifiedThread[], filter: InboxFilter, currentUserId: string | null): UnifiedThread[] {
  switch (filter) {
    case "unread":
      // Task #1685: an operator-set manual unread flag counts the same
      // as a real `unread_count > 0` so the chip badge and row badge
      // stay in lockstep with whatever a teammate just marked.
      return threads.filter((t) => t.unreadSmsCount > 0 || t.manuallyUnread);
    case "needs_reply":
      return threads.filter((t) => t.needsReply);
    case "missed_calls":
      return threads.filter((t) => t.hasMissedCall);
    case "voicemails":
      // Task #852: only threads with at least one *unheard* voicemail.
      // Once an operator opens every voicemail card on a thread it
      // disappears from this filter (matches the badge semantics).
      return threads.filter((t) => t.unheardVoicemailCount > 0);
    case "mine":
      // Task #850: "Mine" combines explicit assignment with the existing
      // call-routing heuristic so a thread you're working but haven't
      // claimed still shows up.
      return threads.filter(
        (t) => t.myConversation || (currentUserId !== null && t.assignedToUserId === currentUserId),
      );
    case "needs_follow_up":
      return threads.filter((t) => t.threadStatus === "needs_follow_up");
    case "resolved":
      return threads.filter((t) => t.threadStatus === "resolved");
    default:
      // Hide resolved threads from the default "All" inbox so they don't
      // crowd out active work; they're still reachable via the Resolved chip.
      return threads.filter((t) => t.threadStatus !== "resolved");
  }
}

export function filterThreadsByActivity(threads: UnifiedThread[], filter: ActivityFilter): UnifiedThread[] {
  switch (filter) {
    case "messages":
      return threads.filter((t) => t.smsConversationIds.length > 0);
    case "calls":
      return threads.filter((t) => t.callIds.length > 0);
    default:
      return threads;
  }
}

export function filterEventsByActivity(events: ConversationEvent[], filter: ActivityFilter): ConversationEvent[] {
  switch (filter) {
    case "messages":
      return events.filter((e) => e.kind === "sms");
    case "calls":
      return events.filter((e) => e.kind === "call");
    default:
      return events;
  }
}

export function searchThreads(threads: UnifiedThread[], query: string): UnifiedThread[] {
  const q = query.trim().toLowerCase();
  if (!q) return threads;
  return threads.filter((t) => {
    if (t.displayName.toLowerCase().includes(q)) return true;
    if (t.contactName && t.contactName.toLowerCase().includes(q)) return true;
    if (t.clientName && t.clientName.toLowerCase().includes(q)) return true;
    if (t.contactPhone && t.contactPhone.includes(q)) return true;
    if (t.lastActivityPreview && t.lastActivityPreview.toLowerCase().includes(q)) return true;
    if (t.groupParticipants.some((p) => (p.name || "").toLowerCase().includes(q) || p.phone.includes(q))) return true;
    return false;
  });
}
