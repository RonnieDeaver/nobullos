// @db-pool-intent: api — routes call this module directly from request
// handlers (no runWithWorkerDb wrapper anywhere in its call graph), so
// getDb() always resolves to the API pool.
/**
 * Onboarding roster (Task #5295) — stage 1 of the New Client Onboarding epic.
 *
 * Company-wide list of users who handle new-client onboarding calls, plus
 * which single one is the default (first-choice) assignee. No per-client
 * scoping, no ClickUp identity resolution, no assignment/booking logic — that
 * is stage 2+. This module owns exactly: list the roster, add/reactivate a
 * member, toggle active, remove a member, and atomically change the default.
 */
import { and, asc, eq, sql } from "drizzle-orm";
import { getDb, withDbAttribution } from "../db";
import { sdDepartmentMembers, sdDepartments } from "@shared/schema";
import {
  deleteDepartmentMember,
  setDepartmentRoleAssignments,
  updateDepartmentMember,
  upsertDepartmentMember,
} from "./sdRoleResolution";

export const ONBOARDING_DEPARTMENT_NAME = "Onboarding";

export type OnboardingAssignee = {
  id: string;
  userId: string;
  active: boolean;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
};

type OnboardingDepartment = typeof sdDepartments.$inferSelect;

export class OnboardingDepartmentConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OnboardingDepartmentConfigurationError";
  }
}

async function getOnboardingDepartment(): Promise<OnboardingDepartment> {
  return withDbAttribution("onboarding:department:resolve", async () => {
    const rows = await getDb()
      .select()
      .from(sdDepartments)
      .where(
        and(
          eq(sdDepartments.active, true),
          eq(sdDepartments.assignmentScope, "company"),
          sql`lower(trim(${sdDepartments.name})) = lower(${ONBOARDING_DEPARTMENT_NAME})`,
        ),
      )
      .limit(2);
    if (rows.length !== 1) {
      throw new OnboardingDepartmentConfigurationError(
        rows.length === 0
          ? 'Create one active company-scoped "Onboarding" department in Role Assignments before booking onboarding calls.'
          : 'More than one active company-scoped "Onboarding" department exists. Keep exactly one in Role Assignments.',
      );
    }
    return rows[0];
  });
}

export async function listOnboardingRoster(): Promise<OnboardingAssignee[]> {
  return withDbAttribution("onboarding:roster:list", async () => {
    const department = await getOnboardingDepartment();
    const members = await getDb()
      .select()
      .from(sdDepartmentMembers)
      .where(eq(sdDepartmentMembers.departmentId, department.id))
      .orderBy(asc(sdDepartmentMembers.createdAt));
    return members.map((member) => ({
      id: member.id,
      userId: member.userId,
      active: member.active,
      isDefault: member.active && member.userId === department.defaultPrimaryUserId,
      createdAt: member.createdAt,
      updatedAt: member.updatedAt,
    }));
  });
}

/**
 * Add a user to the roster, or reactivate them if they were previously
 * removed-by-deactivation. Re-adding never resurrects a stale default — the
 * row always comes back with is_default = false; the default must be set
 * explicitly via setOnboardingDefault.
 */
export async function upsertOnboardingAssignee(userId: string): Promise<OnboardingAssignee> {
  const department = await getOnboardingDepartment();
  const member = await upsertDepartmentMember({
    departmentId: department.id,
    userId,
    clickupUserId: null,
  });
  return {
    id: member.id,
    userId: member.userId,
    active: member.active,
    isDefault: member.userId === department.defaultPrimaryUserId,
    createdAt: member.createdAt,
    updatedAt: member.updatedAt,
  };
}

export type SetActiveResult = {
  member: OnboardingAssignee;
  clearedDefault: boolean;
} | null;

/**
 * Toggle a roster row's active flag. Deactivating a row that currently holds
 * the default clears the default in the same transaction — a stale default
 * must never linger after its holder is deactivated (Task #5295 "Done looks
 * like").
 */
export async function setOnboardingAssigneeActive(
  id: string,
  active: boolean,
): Promise<SetActiveResult> {
  const department = await getOnboardingDepartment();
  const existing = (await listOnboardingRoster()).find((member) => member.id === id);
  if (!existing) return null;
  const result = await updateDepartmentMember({ memberId: id, active });
  if (!result || result.member.departmentId !== department.id) return null;
  return {
    member: {
      id: result.member.id,
      userId: result.member.userId,
      active: result.member.active,
      isDefault: false,
      createdAt: result.member.createdAt,
      updatedAt: result.member.updatedAt,
    },
    clearedDefault: !active && existing.isDefault,
  };
}

export type DeleteResult = { member: OnboardingAssignee; wasDefault: boolean } | null;

/** Permanently remove a roster row (the "remove" half of add/remove). */
export async function deleteOnboardingAssignee(id: string): Promise<DeleteResult> {
  const existing = (await listOnboardingRoster()).find((member) => member.id === id);
  if (!existing) return null;
  const result = await deleteDepartmentMember(id);
  if (!result) return null;
  return { member: existing, wasDefault: existing.isDefault };
}

export type SetDefaultResult =
  | { ok: true; roster: OnboardingAssignee[] }
  | { ok: false; kind: "not_found" | "inactive" };

/**
 * Atomically change (or clear, when userId is null) the default onboarding
 * assignee. The target must be an active roster member — you cannot default
 * to someone who isn't currently eligible. Runs as clear-all-else then
 * set-target inside one advisory-locked transaction so the swap is atomic:
 * never two defaults, and the old default is only cleared once the new one
 * is confirmed eligible.
 */
export async function setOnboardingDefault(userId: string | null): Promise<SetDefaultResult> {
  const department = await getOnboardingDepartment();
  if (userId) {
    const target = (await listOnboardingRoster()).find((member) => member.userId === userId);
    if (!target) return { ok: false, kind: "not_found" };
    if (!target.active) return { ok: false, kind: "inactive" };
  }
  const result = await setDepartmentRoleAssignments({
    departmentId: department.id,
    patch: { primaryUserId: userId },
  });
  if (!result.ok) {
    return {
      ok: false,
      kind: result.kind === "ineligible" ? "inactive" : "not_found",
    };
  }
  return { ok: true, roster: await listOnboardingRoster() };
}
