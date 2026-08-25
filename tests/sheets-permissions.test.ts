/* test-registration
{
  "name": "NoBull Sheets — sharing & permissions: role grants, CEO bypass, access levels, list filtering (Task #2932)",
  "regression": true,
  "sweepOnlyReason": "Task #2932 — permission matrix for Sheets sharing: role grants, CEO bypass, access levels, list filtering; DB-heavy (runInIsolatedSchema), not a smoke-gate candidate.",
  "tier": "small"
}
test-registration */
/**
 * sheets-permissions.test.ts
 *
 * Permission matrix for the NoBull Sheets module.
 *
 * Covers:
 *  - CEO bypass: sees all workbooks regardless of ownership or grants.
 *  - Owner gets owner-level access to own workbook.
 *  - Explicit editor grant: can read + write, cannot manage permissions.
 *  - Explicit viewer grant: can read, cannot write.
 *  - User with no grant cannot access the workbook at all.
 *  - Role-grant viewer: user with matching role gets viewer access.
 *  - Role-grant editor: user with matching role can write.
 *  - Explicit user grant overrides a weaker role-grant.
 *  - List workbooks: CEO sees all; non-CEO sees only own + granted.
 *  - User permission upsert (upgrade) + revoke lifecycle.
 *  - Role grant upsert (upgrade) + revoke lifecycle.
 */

import assert from "node:assert/strict";
import { runInIsolatedSchema } from "./db-sandbox";
import {
  getWorkbookAccessLevel,
  canUserAccessWorkbook,
  canUserWriteWorkbook,
  listSheetWorkbooks,
  createSheetWorkbook,
  upsertSheetWorkbookPermission,
  upsertSheetWorkbookRoleGrant,
  deleteSheetWorkbookPermission,
  deleteSheetWorkbookRoleGrant,
  listSheetWorkbookPermissions,
  listSheetWorkbookRoleGrants,
} from "../server/storage/sheetsStorage";

const TABLES = [
  "sheet_workbooks",
  "sheet_workbook_permissions",
  "sheet_workbook_role_grants",
];

function uid(prefix = "u") {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

async function main() {
  let passed = 0;
  let failed = 0;

  async function run(name: string, fn: () => Promise<void>) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (err: any) {
      console.error(`  ✗ ${name}: ${err?.message ?? err}`);
      failed++;
    }
  }

  await runInIsolatedSchema(
    async () => {
      // ── 1. CEO bypass ────────────────────────────────────────────────────────
      await run("CEO bypass → owner access level", async () => {
        const ownerId = uid("owner");
        const ceoId = uid("ceo");
        const wb = await createSheetWorkbook({
          name: "ceo-bypass-wb",
          ownerId,
          snapshot: null,
          folderId: null,
        });
        const level = await getWorkbookAccessLevel(wb.id, ceoId, "ceo");
        assert.equal(level, "owner", "CEO should get owner access to any workbook");
        assert.equal(
          await canUserWriteWorkbook(wb.id, ceoId, "ceo"),
          true,
          "CEO can write any workbook",
        );
      });

      // ── 2. Owner access level ────────────────────────────────────────────────
      await run("Owner → owner access level on own workbook", async () => {
        const ownerId = uid("owner");
        const wb = await createSheetWorkbook({
          name: "owner-wb",
          ownerId,
          snapshot: null,
          folderId: null,
        });
        const level = await getWorkbookAccessLevel(wb.id, ownerId, "account_manager");
        assert.equal(level, "owner");
        assert.equal(await canUserWriteWorkbook(wb.id, ownerId, "account_manager"), true);
      });

      // ── 3. Explicit editor grant ─────────────────────────────────────────────
      await run("Explicit editor grant → can read + write", async () => {
        const ownerId = uid("owner");
        const editorId = uid("editor");
        const wb = await createSheetWorkbook({
          name: "editor-wb",
          ownerId,
          snapshot: null,
          folderId: null,
        });
        await upsertSheetWorkbookPermission({
          workbookId: wb.id,
          userId: editorId,
          role: "editor",
          grantedBy: ownerId,
        });
        const level = await getWorkbookAccessLevel(wb.id, editorId, "account_manager");
        assert.equal(level, "editor");
        assert.equal(await canUserAccessWorkbook(wb.id, editorId, "account_manager"), true);
        assert.equal(await canUserWriteWorkbook(wb.id, editorId, "account_manager"), true);
      });

      // ── 4. Explicit viewer grant ─────────────────────────────────────────────
      await run("Explicit viewer grant → can read, cannot write", async () => {
        const ownerId = uid("owner");
        const viewerId = uid("viewer");
        const wb = await createSheetWorkbook({
          name: "viewer-wb",
          ownerId,
          snapshot: null,
          folderId: null,
        });
        await upsertSheetWorkbookPermission({
          workbookId: wb.id,
          userId: viewerId,
          role: "viewer",
          grantedBy: ownerId,
        });
        const level = await getWorkbookAccessLevel(wb.id, viewerId, "account_manager");
        assert.equal(level, "viewer");
        assert.equal(await canUserAccessWorkbook(wb.id, viewerId, "account_manager"), true);
        assert.equal(
          await canUserWriteWorkbook(wb.id, viewerId, "account_manager"),
          false,
          "Viewer must not write",
        );
      });

      // ── 5. No grant → null ───────────────────────────────────────────────────
      await run("No grant → null access level + cannot access", async () => {
        const ownerId = uid("owner");
        const strangerId = uid("stranger");
        const wb = await createSheetWorkbook({
          name: "no-grant-wb",
          ownerId,
          snapshot: null,
          folderId: null,
        });
        const level = await getWorkbookAccessLevel(wb.id, strangerId, "account_manager");
        assert.equal(level, null, "Stranger gets null");
        assert.equal(
          await canUserAccessWorkbook(wb.id, strangerId, "account_manager"),
          false,
        );
      });

      // ── 6. Role-grant viewer ─────────────────────────────────────────────────
      await run("Role-grant viewer → user with matching role can read, not write", async () => {
        const ownerId = uid("owner");
        const userId = uid("am");
        const wb = await createSheetWorkbook({
          name: "role-viewer-wb",
          ownerId,
          snapshot: null,
          folderId: null,
        });
        await upsertSheetWorkbookRoleGrant({
          workbookId: wb.id,
          role: "account_manager",
          accessLevel: "viewer",
          grantedBy: ownerId,
        });
        const level = await getWorkbookAccessLevel(wb.id, userId, "account_manager");
        assert.equal(level, "viewer");
        assert.equal(await canUserAccessWorkbook(wb.id, userId, "account_manager"), true);
        assert.equal(await canUserWriteWorkbook(wb.id, userId, "account_manager"), false);
      });

      // ── 7. Role-grant editor ─────────────────────────────────────────────────
      await run("Role-grant editor → user with matching role can write", async () => {
        const ownerId = uid("owner");
        const userId = uid("tl");
        const wb = await createSheetWorkbook({
          name: "role-editor-wb",
          ownerId,
          snapshot: null,
          folderId: null,
        });
        await upsertSheetWorkbookRoleGrant({
          workbookId: wb.id,
          role: "team_lead",
          accessLevel: "editor",
          grantedBy: ownerId,
        });
        const level = await getWorkbookAccessLevel(wb.id, userId, "team_lead");
        assert.equal(level, "editor");
        assert.equal(await canUserWriteWorkbook(wb.id, userId, "team_lead"), true);
      });

      // ── 8. Explicit user grant overrides weaker role-grant ───────────────────
      await run("Explicit user grant overrides role-grant", async () => {
        const ownerId = uid("owner");
        const userId = uid("u");
        const wb = await createSheetWorkbook({
          name: "override-wb",
          ownerId,
          snapshot: null,
          folderId: null,
        });
        // Role says viewer; explicit grant says owner.
        await upsertSheetWorkbookRoleGrant({
          workbookId: wb.id,
          role: "account_manager",
          accessLevel: "viewer",
          grantedBy: ownerId,
        });
        await upsertSheetWorkbookPermission({
          workbookId: wb.id,
          userId,
          role: "owner",
          grantedBy: ownerId,
        });
        const level = await getWorkbookAccessLevel(wb.id, userId, "account_manager");
        assert.equal(level, "owner", "Explicit grant must win over role-grant");
      });

      // ── 9. List: CEO sees all ────────────────────────────────────────────────
      await run("listSheetWorkbooks: CEO sees all workbooks", async () => {
        const ownerId = uid("owner");
        const ceoId = uid("ceo");
        const wb1 = await createSheetWorkbook({
          name: "ceo-list-a",
          ownerId,
          snapshot: null,
          folderId: null,
        });
        const wb2 = await createSheetWorkbook({
          name: "ceo-list-b",
          ownerId,
          snapshot: null,
          folderId: null,
        });
        const list = await listSheetWorkbooks({ userId: ceoId, userRole: "ceo" });
        const ids = list.map((w) => w.id);
        assert.ok(ids.includes(wb1.id), "CEO sees wb1");
        assert.ok(ids.includes(wb2.id), "CEO sees wb2");
      });

      // ── 10. List: non-CEO filtered ──────────────────────────────────────────
      await run(
        "listSheetWorkbooks: non-CEO sees only own + granted workbooks",
        async () => {
          const ownerId = uid("owner");
          const userId = uid("u");
          const granted = await createSheetWorkbook({
            name: "list-granted",
            ownerId,
            snapshot: null,
            folderId: null,
          });
          const hidden = await createSheetWorkbook({
            name: "list-hidden",
            ownerId,
            snapshot: null,
            folderId: null,
          });
          const own = await createSheetWorkbook({
            name: "list-own",
            ownerId: userId,
            snapshot: null,
            folderId: null,
          });
          await upsertSheetWorkbookPermission({
            workbookId: granted.id,
            userId,
            role: "viewer",
            grantedBy: ownerId,
          });
          const list = await listSheetWorkbooks({ userId, userRole: "account_manager" });
          const ids = list.map((w) => w.id);
          assert.ok(ids.includes(own.id), "User's own workbook appears");
          assert.ok(ids.includes(granted.id), "Granted workbook appears");
          assert.ok(!ids.includes(hidden.id), "Ungranted workbook hidden");
        },
      );

      // ── 11. User permission upsert + revoke lifecycle ───────────────────────
      await run("User permission: upsert upgrade + revoke lifecycle", async () => {
        const ownerId = uid("owner");
        const userId = uid("u");
        const wb = await createSheetWorkbook({
          name: "perm-lifecycle",
          ownerId,
          snapshot: null,
          folderId: null,
        });

        // Grant viewer.
        await upsertSheetWorkbookPermission({
          workbookId: wb.id,
          userId,
          role: "viewer",
          grantedBy: ownerId,
        });
        let perms = await listSheetWorkbookPermissions(wb.id);
        assert.equal(perms.length, 1);
        assert.equal(perms[0].role, "viewer");

        // Upgrade to editor — no duplicate.
        await upsertSheetWorkbookPermission({
          workbookId: wb.id,
          userId,
          role: "editor",
          grantedBy: ownerId,
        });
        perms = await listSheetWorkbookPermissions(wb.id);
        assert.equal(perms.length, 1, "Upsert must not duplicate");
        assert.equal(perms[0].role, "editor");

        // Revoke.
        await deleteSheetWorkbookPermission(wb.id, userId);
        perms = await listSheetWorkbookPermissions(wb.id);
        assert.equal(perms.length, 0, "Permission must be gone after revoke");
        assert.equal(await canUserAccessWorkbook(wb.id, userId), false);
      });

      // ── 12. Role grant upsert + revoke lifecycle ────────────────────────────
      await run("Role grant: upsert upgrade + revoke lifecycle", async () => {
        const ownerId = uid("owner");
        const wb = await createSheetWorkbook({
          name: "role-lifecycle",
          ownerId,
          snapshot: null,
          folderId: null,
        });

        await upsertSheetWorkbookRoleGrant({
          workbookId: wb.id,
          role: "account_manager",
          accessLevel: "viewer",
          grantedBy: ownerId,
        });
        let grants = await listSheetWorkbookRoleGrants(wb.id);
        assert.equal(grants.length, 1);
        assert.equal(grants[0].accessLevel, "viewer");

        // Upgrade.
        await upsertSheetWorkbookRoleGrant({
          workbookId: wb.id,
          role: "account_manager",
          accessLevel: "editor",
          grantedBy: ownerId,
        });
        grants = await listSheetWorkbookRoleGrants(wb.id);
        assert.equal(grants.length, 1, "Upsert must not duplicate role grant");
        assert.equal(grants[0].accessLevel, "editor");

        // Revoke.
        await deleteSheetWorkbookRoleGrant(wb.id, "account_manager");
        grants = await listSheetWorkbookRoleGrants(wb.id);
        assert.equal(grants.length, 0);

        const someUser = uid("u");
        assert.equal(
          await canUserAccessWorkbook(wb.id, someUser, "account_manager"),
          false,
          "After revoke, role-matched user loses access",
        );
      });
    },
    { tables: TABLES },
  );

  console.log(`\nsheets-permissions: ${passed}/12 passed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("sheets-permissions test runner failed:", err);
  process.exit(1);
});
