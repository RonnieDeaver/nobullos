// Type declarations for scripts/contract-table-classifiers.mjs (Task #4105).
export interface ClassifiableRoute {
  path: string;
  middleware?: string[];
}
export function authClass(route: ClassifiableRoute): string;
export function roleClass(route: ClassifiableRoute): string;
export function trackDClass(route: ClassifiableRoute): string;
