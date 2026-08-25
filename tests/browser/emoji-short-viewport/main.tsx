/**
 * Task #3372 — real-browser harness page for the emoji-panel short-viewport
 * test (tests/emoji-panel-short-viewport-browser.test.ts).
 *
 * Mounts the REAL MessageItem (which owns the emoji trigger + the portaled
 * AnchoredPortalPanel quick/full emoji panels) inside a 300px overflow-hidden
 * container mimicking a comms popup window, with the app's real Tailwind CSS,
 * so the rendered layout/scroll behavior is the production one. All network
 * is stubbed; selections are recorded on window.__reactions for the driver.
 */
import "./harness.css";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import { MessageItem } from "@/components/comms/MessageItem";

declare global {
  interface Window {
    __reactions: Array<{ id: string; emoji: string }>;
    __harnessReady: boolean;
  }
}

// Stub every API call the picker makes (custom emoji, frequently-used, usage).
const realFetch = window.fetch.bind(window);
window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith("/api/")) {
    return Promise.resolve(
      new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } }),
    );
  }
  return realFetch(input as any, init);
}) as typeof window.fetch;

window.__reactions = [];

const MSG_ID = "msg-short-vp-3372";

const msg = {
  id: MSG_ID,
  channelId: "ch-1",
  userId: "user-2",
  parentId: null,
  content: "hello from a short phone screen",
  contentType: "text" as const,
  editedAt: null,
  deletedAt: null,
  metadata: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  user: { id: "user-2", firstName: "Short", lastName: "Screen", profileImageUrl: null },
  reactionCounts: {},
  replyCount: 0,
};

const qc = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: Infinity } },
});

const root = createRoot(document.getElementById("root")!);
root.render(
  <QueryClientProvider client={qc}>
    <TooltipProvider>
      {/* Mimic the 300px comms popup window pinned to the bottom-right, the
          placement that originally clipped the panels. */}
      <div
        data-testid="narrow-popup"
        style={{
          width: 300,
          height: 200,
          overflow: "hidden",
          position: "fixed",
          right: 8,
          bottom: 8,
          border: "1px solid #ccc",
          background: "#fff",
        }}
      >
        <MessageItem
          msg={msg as any}
          currentUserId="user-1"
          onReact={(id: string, emoji: string) => window.__reactions.push({ id, emoji })}
          onEdit={() => {}}
          onDelete={() => {}}
        />
      </div>
    </TooltipProvider>
  </QueryClientProvider>,
);

window.__harnessReady = true;
