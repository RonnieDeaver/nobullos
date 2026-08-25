import { storage } from "../storage";
import {
  setCommonFirstNamesOverride,
  getDefaultCommonFirstNames,
  getEffectiveCommonFirstNames,
} from "./matchPolicy";

export const ZOOM_COMMON_FIRST_NAMES_KEY = "ZOOM_COMMON_FIRST_NAMES";

function parseList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[,\n]/)
    .map(s => s.trim().toLowerCase())
    .filter(s => s.length > 0);
}

let initialLoadDone = false;
let inFlightLoad: Promise<void> | null = null;

export async function loadCommonFirstNamesFromStorage(): Promise<void> {
  if (inFlightLoad) {
    await inFlightLoad;
    return;
  }
  inFlightLoad = (async () => {
    try {
      const row = await storage.getSystemSetting(ZOOM_COMMON_FIRST_NAMES_KEY);
      const list = parseList(row?.value);
      setCommonFirstNamesOverride(list.length > 0 ? list : null);
      initialLoadDone = true;
    } catch (err) {
      console.error(
        "[zoomGuardrailConfig] Failed to load common first names override; will retry on next read.",
        err,
      );
    } finally {
      inFlightLoad = null;
    }
  })();
  await inFlightLoad;
}

export async function ensureCommonFirstNamesLoaded(): Promise<void> {
  if (initialLoadDone) return;
  await loadCommonFirstNamesFromStorage();
}

export async function getCommonFirstNamesConfig(): Promise<{
  effective: string[];
  override: string[] | null;
  defaults: string[];
  isOverridden: boolean;
}> {
  await ensureCommonFirstNamesLoaded();
  const row = await storage.getSystemSetting(ZOOM_COMMON_FIRST_NAMES_KEY);
  const override = row?.value ? parseList(row.value) : null;
  const isOverridden = !!(override && override.length > 0);
  const effective = Array.from(getEffectiveCommonFirstNames()).sort();
  const defaults = Array.from(getDefaultCommonFirstNames()).sort();
  return {
    effective,
    override: isOverridden ? override : null,
    defaults,
    isOverridden,
  };
}

export async function setCommonFirstNamesConfig(params: {
  names: string[] | null;
  updatedBy?: string | null;
}): Promise<void> {
  await ensureCommonFirstNamesLoaded();
  if (!params.names || params.names.length === 0) {
    await storage.deleteSystemSetting(ZOOM_COMMON_FIRST_NAMES_KEY);
    setCommonFirstNamesOverride(null);
    initialLoadDone = true;
    return;
  }
  const cleaned = parseList(params.names.join(","));
  if (cleaned.length === 0) {
    await storage.deleteSystemSetting(ZOOM_COMMON_FIRST_NAMES_KEY);
    setCommonFirstNamesOverride(null);
    return;
  }
  const stored = Array.from(new Set(cleaned)).sort().join(",");
  await storage.setSystemSetting(
    ZOOM_COMMON_FIRST_NAMES_KEY,
    stored,
    params.updatedBy ?? undefined,
  );
  setCommonFirstNamesOverride(cleaned);
  initialLoadDone = true;
}

void loadCommonFirstNamesFromStorage();
