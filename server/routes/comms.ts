/**
 * NoBull Comms — internal team communication system.
 *
 * Task #3787: the implementation is split into per-feature modules under
 * ./comms/ to keep merge surfaces small; this aggregator preserves the
 * original import path, the public export surface, and the exact route
 * registration order (each register function registers its routes in the
 * original statement order, and they are invoked here in the original
 * sequence). Add new routes to the matching feature module, not here.
 */
import type { Express } from "express";
import { registerCommsRealtimeRoutes } from "./comms/realtime";
import { registerCommsChannelRoutes } from "./comms/channels";
import { registerCommsMessageRoutes } from "./comms/messages";
import { registerCommsInteractionRoutes } from "./comms/interactions";
import { registerCommsCallRoutes } from "./comms/calls";
import { registerCommsClientAndAttachmentRoutes } from "./comms/clientAndAttachments";
import { registerCommsSidebarPrefRoutes } from "./comms/sidebarPrefs";
import { registerCommsDraftScheduledRoutes } from "./comms/draftsScheduled";
import { registerCommsBookmarkRoutes } from "./comms/bookmarks";
import { registerCommsWebhookEmojiRoutes } from "./comms/webhooksEmoji";

export function registerCommsRoutes(app: Express) {
  registerCommsRealtimeRoutes(app);
  registerCommsChannelRoutes(app);
  registerCommsMessageRoutes(app);
  registerCommsInteractionRoutes(app);
  registerCommsCallRoutes(app);
  registerCommsClientAndAttachmentRoutes(app);
  registerCommsSidebarPrefRoutes(app);
  registerCommsDraftScheduledRoutes(app);
  registerCommsBookmarkRoutes(app);
  registerCommsWebhookEmojiRoutes(app);
}
