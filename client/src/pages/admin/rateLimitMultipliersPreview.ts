export type EffectiveLimitCategoryInfo = {
  base: number;
  windowMs: number;
  roleAware: boolean;
  perRole: Record<string, number>;
};

export type EffectiveLimitsData = {
  roles: string[];
  multipliers: Record<string, number>;
  categories: Record<string, EffectiveLimitCategoryInfo>;
};

export type PreviewCell = {
  role: string;
  savedVal: number | null;
  previewVal: number;
  isPreview: boolean;
};

export type PreviewRow = {
  category: string;
  base: number;
  windowMs: number;
  roleAware: boolean;
  cells: PreviewCell[];
};

export type PreviewRoleHeader = {
  role: string;
  isNew: boolean;
};

export type EffectivePreview = {
  allRoles: PreviewRoleHeader[];
  rows: PreviewRow[];
};

export const MULTIPLIER_MIN = 0.1;
export const MULTIPLIER_MAX = 100;

export function isValidMultiplierString(str: string): boolean {
  const num = parseFloat(str);
  return !isNaN(num) && num >= MULTIPLIER_MIN && num <= MULTIPLIER_MAX;
}

export function validateMultiplierString(str: string): string | null {
  const trimmed = str.trim();
  if (trimmed === "") return "Enter a multiplier";
  const num = parseFloat(trimmed);
  if (isNaN(num)) return "Must be a number";
  if (num < MULTIPLIER_MIN || num > MULTIPLIER_MAX) {
    return `Must be between ${MULTIPLIER_MIN} and ${MULTIPLIER_MAX}`;
  }
  return null;
}

export type LimiterConfigInfo = {
  windowMs: number;
  max: number;
  roleAware: boolean;
};

export function buildFallbackEffectiveLimits(
  effective: Record<string, number> | undefined | null,
  limiterConfigs?: Record<string, LimiterConfigInfo> | null,
): EffectiveLimitsData {
  const multipliers: Record<string, number> = {};
  if (effective) {
    for (const [role, val] of Object.entries(effective)) {
      if (typeof val === "number" && !isNaN(val)) {
        multipliers[role] = val;
      }
    }
  }
  const roles = Object.keys(multipliers);
  const categories: EffectiveLimitsData["categories"] = {};
  if (limiterConfigs) {
    for (const [category, config] of Object.entries(limiterConfigs)) {
      const perRole: Record<string, number> = { default: config.max };
      if (config.roleAware) {
        for (const role of roles) {
          perRole[role] = Math.ceil(config.max * (multipliers[role] ?? 1));
        }
      } else {
        for (const role of roles) {
          perRole[role] = config.max;
        }
      }
      categories[category] = {
        base: config.max,
        windowMs: config.windowMs,
        roleAware: config.roleAware,
        perRole,
      };
    }
  }
  return { roles, multipliers, categories };
}

export function parsePreviewMultipliers(
  editValues: Record<string, string>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [role, str] of Object.entries(editValues)) {
    if (isValidMultiplierString(str)) {
      out[role] = parseFloat(str);
    }
  }
  return out;
}

export function getInvalidMultiplierRoles(
  editValues: Record<string, string>,
): string[] {
  return Object.entries(editValues)
    .filter(([, str]) => validateMultiplierString(str) !== null)
    .map(([role]) => role);
}

export function buildEffectivePreview(
  savedLimits: EffectiveLimitsData,
  editValues: Record<string, string>,
): EffectivePreview {
  const previewMultipliers = parsePreviewMultipliers(editValues);
  const previewRoles = Object.keys(previewMultipliers);
  const allRoles: PreviewRoleHeader[] = Array.from(
    new Set([...savedLimits.roles, ...previewRoles]),
  ).map((role) => ({ role, isNew: !savedLimits.roles.includes(role) }));

  const rows: PreviewRow[] = Object.entries(savedLimits.categories)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([category, info]) => {
      const cells: PreviewCell[] = allRoles.map(({ role }) => {
        const savedVal = savedLimits.roles.includes(role)
          ? (info.perRole[role] ?? info.base)
          : null;
        const previewVal = !info.roleAware
          ? info.base
          : previewMultipliers[role] === undefined
            ? (info.perRole[role] ?? info.base)
            : Math.ceil(info.base * previewMultipliers[role]);
        const isPreview = savedVal === null || previewVal !== savedVal;
        return { role, savedVal, previewVal, isPreview };
      });
      return {
        category,
        base: info.base,
        windowMs: info.windowMs,
        roleAware: info.roleAware,
        cells,
      };
    });

  return { allRoles, rows };
}

export function previewHasVisibleChanges(preview: EffectivePreview): boolean {
  if (preview.allRoles.some((r) => r.isNew)) return true;
  return preview.rows.some((row) => row.cells.some((c) => c.isPreview));
}
