/**
 * Owner-approved department role capability contract.
 *
 * Department identity is stable; display names are not. New or renamed
 * departments therefore default to Doer-only until their UUID is explicitly
 * approved here.
 *
 * Runtime responsibilities are limited to Doer and approved Checker.
 */
export const PAID_SEARCH_DEPARTMENT_ID =
  "d04fc82e-a7c4-48ad-9e22-1d51830f6479";
export const GBP_LOCAL_SEO_DEPARTMENT_ID =
  "4d2e06d4-b935-468b-a204-630964e151bc";

export const CHECKER_CAPABLE_DEPARTMENT_IDS = new Set<string>([
  PAID_SEARCH_DEPARTMENT_ID,
  GBP_LOCAL_SEO_DEPARTMENT_ID,
]);

export type DepartmentRoleCapabilities = {
  doer: true;
  checker: boolean;
};

export function getDepartmentRoleCapabilities(
  departmentId: string,
): DepartmentRoleCapabilities {
  return {
    doer: true,
    checker: CHECKER_CAPABLE_DEPARTMENT_IDS.has(departmentId),
  };
}

export function departmentSupportsChecker(departmentId: string): boolean {
  return CHECKER_CAPABLE_DEPARTMENT_IDS.has(departmentId);
}