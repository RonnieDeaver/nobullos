// Module-level dashboard cache: survives component unmount/remount (route
// changes) for the life of the app session, so navigating back to a dashboard
// shows the last data instantly while a quiet background revalidate runs.
// Keyed per dashboard + range (e.g. "combined:30:previous").
// Verbatim port of the bundle's frontend/src/dashCache.ts.
const store = new Map<string, unknown>();

export function readDashCache<T>(key: string): T | undefined {
  return store.get(key) as T | undefined;
}

export function writeDashCache<T>(key: string, value: T): void {
  store.set(key, value);
}
