export const d2 = () => 2;
export async function lazyBack(): Promise<string> {
  const mod = await import("./d1");
  return mod.d1Name;
}
