/**
 * Task #4363 — pure partition behind the global "hide demo/test accounts"
 * toggle (design audit P3-4, §3.1-P3, §3.6-P3). Splits any list whose rows
 * carry the `clients.isDemo` marker (the same flag behind the in-app
 * "Demo Account" badge) into the rows a surface should render plus the
 * count its active-filter indicator reports. Display filtering only —
 * callers never mutate or reclassify rows.
 */
export type DemoFlaggedRow = { isDemo?: boolean | null };

export function partitionDemoAccounts<T extends DemoFlaggedRow>(
  rows: readonly T[],
  hideDemo: boolean,
): { visible: T[]; hiddenDemoCount: number } {
  if (!hideDemo) return { visible: [...rows], hiddenDemoCount: 0 };
  const visible = rows.filter((r) => !r.isDemo);
  return { visible, hiddenDemoCount: rows.length - visible.length };
}
