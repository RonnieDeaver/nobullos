/**
 * Dependency-light bookmark SSE cache invalidation.
 *
 * Kept separate from the BookmarksBar component so the MessagePane listener
 * and its unit coverage do not need to load the bookmark UI dependency graph.
 */

export interface BookmarkQueryInvalidator {
  invalidateQueries: (opts: { queryKey: unknown[] }) => unknown;
}

export interface BookmarkSseEvent {
  data: string;
}

/**
 * Builds the SSE listener that keeps a channel's bookmarks query live-synced.
 * Only bookmark events for the selected channel invalidate; malformed and
 * unrelated events are deliberately ignored.
 */
export function makeBookmarkSseHandler(
  qc: BookmarkQueryInvalidator,
  channelId: string,
): (event: BookmarkSseEvent) => void {
  return (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === "comms:bookmark" && data.channelId === channelId) {
        qc.invalidateQueries({
          queryKey: [`/api/comms/channels/${channelId}/bookmarks`],
        });
      }
    } catch {}
  };
}