/**
 * NoBull Comms — storage layer (aggregator).
 * All channel, message, reaction, and read-state CRUD.
 *
 * Task #3787: the implementation is split into per-domain modules under
 * ./comms/ to keep merge surfaces small; this barrel preserves the original
 * import path and public surface (`import * as commsStorage` keeps working).
 * Add new storage functions to the matching domain module, not here.
 */
export * from "./comms/channels";
export * from "./comms/messages";
export * from "./comms/calls";
export * from "./comms/clientChannels";
export * from "./comms/attachments";
export * from "./comms/prefsPinsSaved";
export * from "./comms/searchAndLifecycle";
export * from "./comms/draftsScheduled";
export * from "./comms/userSettings";
export * from "./comms/webhooksThreads";
export * from "./comms/bookmarks";
export * from "./comms/sidebarCategories";
export * from "./comms/remindersForwarding";
export * from "./comms/previewsEmoji";
