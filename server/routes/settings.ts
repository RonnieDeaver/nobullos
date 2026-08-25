import type { Express } from "express";
import { z } from "zod";
  import { storage } from "../storage";
  import { isAuthenticated } from "../middlewares/requireAuth";
  import { requireCeo, requireTeamLead, requireAccountManager, openai } from "./middleware";
  import { classifyPhases } from "./helpers";
  import { generatePracticeAreaTrendAiAnalysis } from "../services/practiceAreaTrendAnalysis";
  import { PRACTICE_AREA_OPTIONS, DEFAULT_SEARCH_TERMS } from "@shared/practiceAreas";
  import { computePracticeAreaTrendData, practiceAreaTrends } from "../services/practiceAreaTrendData";
  
  export function registerSettingsRoutes(app: Express) {
    // Task #1715 — Stage E removed the legacy `/api/legacy-notifications`
    // shim routes (read list + mark-read). Stages B–D migrated every
    // writer and reader off the legacy `notifications` table; the
    // per-user bell at `/api/notifications` (registered by
    // `registerUserNotificationRoutes`) is the sole reader. Stage G
    // will drop the legacy table itself.

  app.get("/api/monthly-review-stats", isAuthenticated, async (req: any, res) => {
    try {
      const { isReviewedThisMonth } = await import("../storage/commandCenterStorage");
      const summaries = await storage.getAllCommandPanelSummaries();
      const userId = req.user?.claims?.sub;
      const user = await storage.getUser(userId);
      const allClients = await storage.getClients();
      const activeClients = allClients.filter(c => !c.isArchived && !c.isDemo);

      const isTeamLead = user?.role === "team_lead" || user?.role === "ceo";
      const isAccountManager = user?.role === "account_manager";
      const relevantClients = (isTeamLead || isAccountManager)
        ? activeClients
        : activeClients.filter(c => c.ownerId === userId);

      const panelMap = new Map(summaries.map(s => [s.clientId, s.lastReviewedAt]));
      let reviewed = 0;
      let needsReview = 0;
      const pendingClients: Array<{ clientId: string; firmName: string }> = [];

      for (const client of relevantClients) {
        if (isReviewedThisMonth(panelMap.get(client.id) ?? null)) {
          reviewed++;
        } else {
          needsReview++;
          pendingClients.push({ clientId: client.id, firmName: client.firmName });
        }
      }

      res.json({ reviewed, needsReview, total: relevantClients.length, pendingClients });
    } catch (error) {
      console.error("Error fetching monthly review stats:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  app.post("/api/monthly-review-notifications", isAuthenticated, async (req: any, res) => {
    try {
      const { isReviewedThisMonth, getCurrentMonthKey } = await import("../storage/commandCenterStorage");
      const userId = req.user?.claims?.sub;
      const user = await storage.getUser(userId);
      const allClients = await storage.getClients();
      const activeClients = allClients.filter(c => !c.isArchived && !c.isDemo);
      const summaries = await storage.getAllCommandPanelSummaries();
      const panelMap = new Map(summaries.map(s => [s.clientId, s.lastReviewedAt]));
      const monthKey = getCurrentMonthKey();

      const isTeamLead = user?.role === "team_lead" || user?.role === "ceo";
      const isAccountManager = user?.role === "account_manager";

      const clientsToNotify = (isTeamLead || isAccountManager)
        ? activeClients.filter(c => !isReviewedThisMonth(panelMap.get(c.id) ?? null))
        : activeClients.filter(c => c.ownerId === userId && !isReviewedThisMonth(panelMap.get(c.id) ?? null));

      if (clientsToNotify.length === 0) {
        return res.json({ created: 0 });
      }

      const targetUserIds = new Set<string>();
      if (isTeamLead || isAccountManager) {
        for (const c of clientsToNotify) {
          if (c.ownerId) targetUserIds.add(c.ownerId);
        }
        if (isAccountManager) targetUserIds.add(userId);
      } else {
        targetUserIds.add(userId);
      }

      // Task #1713 — Stage B: per-user inbox via notifyMonthlyReviewReminder().
      const { notifyMonthlyReviewReminder } = await import(
        "../services/notifications/monthlyReview"
      );
      let created = 0;
      for (const targetUserId of targetUserIds) {
        const userClients = clientsToNotify.filter(c => c.ownerId === targetUserId);
        for (const client of userClients) {
          const wrote = await notifyMonthlyReviewReminder({
            userId: targetUserId,
            clientId: client.id,
            firmName: client.firmName,
            monthKey,
          });
          if (wrote) created++;
        }
      }

      res.json({ created });
    } catch (error) {
      console.error("Error creating monthly review notifications:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  // ============================================
  // USERS API - Team Lead+ for viewing, CEO for role changes
  // ============================================
  app.get("/api/users", isAuthenticated, requireTeamLead, async (_req, res) => {
    try {
      const users = await storage.getAllUsers();
      res.json(users);
    } catch (error) {
      console.error("Error fetching users:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  // Task #4348 — server-paged user listing for the virtualized User
  // Management table. Bare /api/users (above) keeps its full-array shape
  // for its many existing consumers; this endpoint serves one bounded
  // page plus global chip counts. Filter semantics live in
  // storage.listUsersPaged (mirrors the legacy client-side filters).
  const pagedUsersQuerySchema = z.object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(50),
    search: z.string().trim().max(200).optional(),
    facet: z.enum(["revenue", "fulfillment", "both", "unassigned"]).optional(),
    fn: z.string().max(64).optional(),
    authority: z.string().max(32).optional(),
    unable: z.enum(["1"]).optional(),
  });
  app.get("/api/users/paged", isAuthenticated, requireTeamLead, async (req, res) => {
    try {
      const parsed = pagedUsersQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid query", details: parsed.error.flatten() });
      }
      const q = parsed.data;
      const result = await storage.listUsersPaged({
        page: q.page,
        pageSize: q.pageSize,
        search: q.search || undefined,
        facet: q.facet,
        fn: q.fn,
        authority: q.authority,
        unableOnly: q.unable === "1",
      });
      res.json(result);
    } catch (error) {
      console.error("Error fetching paged users:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  // Task #4554 — closed admission: admins APPROVE a person by pre-creating
  // their users row (email + role profile) BEFORE that person's first
  // sign-in; the auth middleware only admits new Clerk identities whose
  // verified email matches such a row. Team-lead+ deliberately (matches the
  // Users-page view gate; the task wants leads to approve) — approval only
  // CREATES a row with a derived default role; editing an existing user's
  // role stays CEO-only via PATCH /:id/role below.
  app.post("/api/users", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const { approveUserSchema } = await import("@shared/schema");
      const parsed = approveUserSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
      }
      // Dedupe + sort functions server-side (stable audit log), like the
      // role-profile PATCH does.
      const functions = Array.from(new Set(parsed.data.functions)).sort();
      let user;
      try {
        user = await storage.createApprovedUser({
          email: parsed.data.email,
          firstName: parsed.data.firstName || null,
          lastName: parsed.data.lastName || null,
          functions,
          authorityLevel: parsed.data.authorityLevel,
        });
      } catch (err) {
        const { DuplicateApprovedEmailError } = await import("../storage/clientStorage");
        if (err instanceof DuplicateApprovedEmailError) {
          return res.status(409).json({ error: "A user with this email already exists" });
        }
        throw err;
      }
      try {
        const { insertActivityLogs } = await import("../storage/activityStorage");
        await insertActivityLogs([{
          userId: req.user?.claims?.sub ?? null,
          actionType: "user_approved",
          route: "/admin/users",
          actionDetail: `Approved ${user.email} for sign-in`,
          metadata: {
            targetUserId: user.id,
            email: user.email,
            functions,
            authorityLevel: parsed.data.authorityLevel,
            role: user.role ?? null,
          },
          sessionId: null,
          duration: null,
          timestamp: new Date(),
        }]);
      } catch (logErr: any) {
        console.error("[UserApprove] Audit log failed:", logErr?.message);
      }
      res.status(201).json(user);
    } catch (error) {
      console.error("Error approving user:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  // Task #1758: accepts either the legacy `{ role }` body (back-compat
  // for callers we haven't migrated yet) or the new
  // `{ functions, authorityLevel }` body from the function + authority
  // User Management UI. Either path persists the legacy `users.role`
  // bridge so legacy read-side code keeps working.
  app.patch("/api/users/:id/role", isAuthenticated, requireCeo, async (req: any, res) => {
    try {
      const { updateUserRoleProfileSchema } = await import("@shared/schema");
      const parsed = updateUserRoleProfileSchema.safeParse(req.body);
      const previousUser = await storage.getUser(req.params.id);
      if (!previousUser) return res.status(404).json({ error: "User not found" });
      const oldRole = previousUser.role ?? null;
      const oldFunctions = (previousUser.functions ?? []) as string[];
      const oldAuthority = previousUser.authorityLevel ?? "core";

      let user;
      let newSummary: { functions: string[]; authorityLevel: string; role: string };
      if (parsed.success) {
        // New profile-shaped body. Functions are deduped + sorted server-side
        // so the audit log is stable across clients.
        const functions = Array.from(new Set(parsed.data.functions)).sort();
        user = await storage.updateUserRoleProfile(req.params.id, {
          functions,
          authorityLevel: parsed.data.authorityLevel,
        });
        if (!user) return res.status(404).json({ error: "User not found" });
        newSummary = {
          functions,
          authorityLevel: parsed.data.authorityLevel,
          role: user.role ?? "",
        };
      } else {
        // Legacy `{ role }` body.
        const { role } = req.body ?? {};
        if (!["ceo", "team_lead", "account_manager"].includes(role)) {
          return res.status(400).json({ error: "Invalid role" });
        }
        user = await storage.updateUserRole(req.params.id, role);
        if (!user) return res.status(404).json({ error: "User not found" });
        newSummary = {
          functions: (user.functions ?? []) as string[],
          authorityLevel: user.authorityLevel ?? "core",
          role,
        };
      }
      const changed =
        oldRole !== newSummary.role ||
        oldAuthority !== newSummary.authorityLevel ||
        JSON.stringify(oldFunctions.slice().sort()) !==
          JSON.stringify(newSummary.functions.slice().sort());
      if (changed) {
        try {
          const { insertActivityLogs } = await import("../storage/activityStorage");
          const targetName =
            [user.firstName, user.lastName].filter(Boolean).join(" ") ||
            user.email ||
            user.id;
          await insertActivityLogs([{
            userId: req.user?.claims?.sub ?? null,
            actionType: "user_role_updated",
            route: "/admin/users",
            actionDetail: `Updated role profile for ${targetName}`,
            metadata: {
              targetUserId: user.id,
              targetUserName: targetName,
              oldValues: { role: oldRole, functions: oldFunctions, authorityLevel: oldAuthority },
              newValues: newSummary,
            },
            sessionId: null,
            duration: null,
            timestamp: new Date(),
          }]);
        } catch (logErr: any) {
          console.error("[UserRole] Audit log failed:", logErr?.message);
        }
      }
      res.json(user);
    } catch (error) {
      console.error("Error updating user role:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  // Task #1866 — soft-delete a user. CEO-only (matches role-edit
  // gating). Refuses self-delete. The storage layer marks the row
  // `deleted_at` (preserving every FK reference for audit) and purges
  // their session rows so any live tab 401s on its next request.
  // Task #1909 — preflight: lets the User Management UI fetch the
  // impact summary without triggering the 409 / no-op DELETE round-trip.
  // Same auth / self-check shape as the DELETE handler below.
  app.get("/api/users/:id/delete-impact", isAuthenticated, requireCeo, async (req: any, res) => {
    try {
      const targetId = req.params.id;
      const actorId = req.user?.claims?.sub;
      if (!targetId) return res.status(400).json({ error: "Missing user id" });
      if (targetId === actorId) {
        return res.status(400).json({ error: "You cannot delete your own account" });
      }
      const target = await storage.getUser(targetId);
      if (!target) return res.status(404).json({ error: "User not found" });
      const impact = await storage.getUserAssignmentImpact(targetId);
      res.json({ impact });
    } catch (error: any) {
      console.error("Error computing user delete impact:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  // Task #1934 — bulk-reassign the work the soon-to-be-deleted user
  // still owns (clients, open threads, upcoming bookings) to a single
  // new owner from inside the delete dialog, then return the refreshed
  // impact summary so the UI can flip "Delete anyway" → "Delete user"
  // once everything is zero.
  app.post("/api/users/:id/reassign", isAuthenticated, requireCeo, async (req: any, res) => {
    try {
      const fromUserId = req.params.id;
      const actorId = req.user?.claims?.sub;
      if (!fromUserId) return res.status(400).json({ error: "Missing user id" });
      if (!actorId) return res.status(401).json({ error: "Not authenticated" });

      const body = req.body ?? {};
      const toUserId = typeof body.targetUserId === "string" ? body.targetUserId.trim() : "";
      if (!toUserId) return res.status(400).json({ error: "Missing targetUserId" });
      if (toUserId === fromUserId) {
        return res.status(400).json({ error: "Cannot reassign work to the same user" });
      }

      const ALL_SURFACES = ["clients", "threads", "bookings"] as const;
      type Surface = (typeof ALL_SURFACES)[number];
      const requested = Array.isArray(body.surfaces) && body.surfaces.length > 0
        ? body.surfaces
        : ALL_SURFACES;
      const surfaces: Surface[] = [];
      for (const s of requested) {
        if (ALL_SURFACES.includes(s)) surfaces.push(s);
      }
      if (surfaces.length === 0) {
        return res.status(400).json({ error: "No valid surfaces requested" });
      }

      const [fromUser, toUser] = await Promise.all([
        storage.getUser(fromUserId),
        storage.getUser(toUserId),
      ]);
      if (!fromUser) return res.status(404).json({ error: "Source user not found" });
      if (!toUser) return res.status(404).json({ error: "Target user not found" });

      const result = await storage.reassignUserWork(
        fromUserId,
        toUserId,
        surfaces,
        actorId,
      );
      const impact = await storage.getUserAssignmentImpact(fromUserId);

      try {
        const { insertActivityLogs } = await import("../storage/activityStorage");
        const nameOf = (u: typeof fromUser) =>
          [u.firstName, u.lastName].filter(Boolean).join(" ") || u.email || u.id;
        // Task #1950 — persist the per-surface items (client ids+names,
        // thread keys, meeting ids+labels) so a future CEO can answer
        // "which clients did Alex end up owning after I deleted Sam?"
        // directly from the audit trail.
        await insertActivityLogs([{
          userId: actorId,
          actionType: "user_work_reassigned",
          route: "/admin/users",
          actionDetail: `Reassigned ${result.clients + result.threads + result.bookings} item(s) from ${nameOf(fromUser)} to ${nameOf(toUser)}`,
          metadata: {
            fromUserId,
            fromUserName: nameOf(fromUser),
            toUserId,
            toUserName: nameOf(toUser),
            surfaces,
            counts: {
              clients: result.clients,
              threads: result.threads,
              bookings: result.bookings,
            },
            items: result.items,
          },
          sessionId: null,
          duration: null,
          timestamp: new Date(),
        }]);
      } catch (logErr: any) {
        console.error("[UserReassign] Audit log failed:", logErr?.message);
      }

      res.json({ result, impact });
    } catch (error: any) {
      console.error("Error reassigning user work:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  app.delete("/api/users/:id", isAuthenticated, requireCeo, async (req: any, res) => {
    try {
      const targetId = req.params.id;
      const actorId = req.user?.claims?.sub;
      if (!targetId) return res.status(400).json({ error: "Missing user id" });
      if (targetId === actorId) {
        return res.status(400).json({ error: "You cannot delete your own account" });
      }
      const target = await storage.getUser(targetId);
      if (!target) return res.status(404).json({ error: "User not found" });

      // Task #1909 — refuse to soft-delete a user who is the sole
      // assignee on active work unless the caller explicitly opts in
      // with `?force=true`. The UI uses the returned impact summary to
      // prompt the CEO to reassign first.
      const force = req.query?.force === "true" || req.query?.force === true;
      if (!force) {
        const impact = await storage.getUserAssignmentImpact(targetId);
        if (impact.hasImpact) {
          return res.status(409).json({
            error: "User is the sole assignee on active work",
            code: "user_delete_requires_force",
            impact,
          });
        }
      }

      const deleted = await storage.deleteUser(targetId);
      if (!deleted) return res.status(404).json({ error: "User not found" });

      try {
        const { insertActivityLogs } = await import("../storage/activityStorage");
        const targetName =
          [target.firstName, target.lastName].filter(Boolean).join(" ") ||
          target.email ||
          target.id;
        await insertActivityLogs([{
          userId: actorId ?? null,
          actionType: "user_deleted",
          route: "/admin/users",
          actionDetail: `Deleted user ${targetName}`,
          metadata: {
            targetUserId: target.id,
            targetUserName: targetName,
            targetUserEmail: target.email,
            targetUserRole: target.role,
            targetUserFunctions: target.functions ?? [],
            targetUserAuthorityLevel: target.authorityLevel ?? "core",
          },
          sessionId: null,
          duration: null,
          timestamp: new Date(),
        }]);
      } catch (logErr: any) {
        console.error("[UserDelete] Audit log failed:", logErr?.message);
      }

      res.json({ ok: true, id: target.id });
    } catch (error: any) {
      console.error("Error deleting user:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  // Task #1870 — CEO-only list of soft-deleted users for the restore UI.
  app.get("/api/users/deleted", isAuthenticated, requireCeo, async (_req, res) => {
    try {
      const rows = await storage.listDeletedUsers();
      res.json(rows);
    } catch (error: any) {
      console.error("Error listing deleted users:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  // Task #1912 — CEO-only delete/restore audit timeline keyed by target
  // user id. Accepts `ids` as a comma-separated query param, or returns
  // history for every active+deleted user when omitted. Each value is the
  // list of events (newest first) for that target.
  app.get("/api/users/delete-history", isAuthenticated, requireCeo, async (req, res) => {
    try {
      const { getUserDeleteRestoreHistory } = await import("../storage/activityStorage");
      const raw = typeof req.query.ids === "string" ? req.query.ids : "";
      let ids = raw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (ids.length === 0) {
        const [active, deleted] = await Promise.all([
          storage.getAllUsers(),
          storage.listDeletedUsers(),
        ]);
        ids = [...active.map((u: any) => u.id), ...deleted.map((u: any) => u.id)];
      }
      const history = await getUserDeleteRestoreHistory(ids);
      res.json(history);
    } catch (error: any) {
      console.error("Error fetching user delete/restore history:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  // Task #1950 — Reassignment history keyed by the *source* user id, so
  // the deleted-users panel can answer "Sam's clients moved to whom?"
  // Accepts `ids` as a comma-separated query param; omitted = every
  // active + deleted user.
  app.get("/api/users/reassign-history", isAuthenticated, requireCeo, async (req, res) => {
    try {
      const { getUserReassignmentHistory, getUserInboundReassignmentHistory } = await import(
        "../storage/activityStorage"
      );
      // Task #1981 — `direction=in` keys the same audit by destination user
      // (what each user inherited); the default `out` keys by source user
      // (what each user shed). Both feed the active-user Reassignments panel.
      const direction = req.query.direction === "in" ? "in" : "out";
      const raw = typeof req.query.ids === "string" ? req.query.ids : "";
      let ids = raw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (ids.length === 0) {
        const [active, deleted] = await Promise.all([
          storage.getAllUsers(),
          storage.listDeletedUsers(),
        ]);
        ids = [...active.map((u: any) => u.id), ...deleted.map((u: any) => u.id)];
      }
      const history =
        direction === "in"
          ? await getUserInboundReassignmentHistory(ids)
          : await getUserReassignmentHistory(ids);
      res.json(history);
    } catch (error: any) {
      console.error("Error fetching user reassignment history:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  // Task #1870 — CEO-only restore of a soft-deleted user. Mirror of the
  // DELETE handler above: clears `deleted_at`, strips the `.deleted.<ts>`
  // email suffix (so OIDC verify will admit the user on next login), and
  // writes a `user_restored` activity log entry.
  app.post("/api/users/:id/restore", isAuthenticated, requireCeo, async (req: any, res) => {
    try {
      const targetId = req.params.id;
      const actorId = req.user?.claims?.sub;
      if (!targetId) return res.status(400).json({ error: "Missing user id" });

      const target = await storage.getUserIncludingDeleted(targetId);
      if (!target) return res.status(404).json({ error: "User not found" });
      if (!target.deletedAt) {
        return res.status(400).json({ error: "User is not deleted" });
      }

      // Optional fallback: when the CEO explicitly opts in, restore
      // the row with a `<original>.restored.<ts>` email instead of
      // failing on a collision. This lets them recover the row
      // without first touching the colliding account.
      const rawStrategy = req.body?.emailConflictStrategy ?? req.query?.emailConflictStrategy;
      const emailConflictStrategy: "strict" | "suffix" =
        rawStrategy === "suffix" ? "suffix" : "strict";

      let restored;
      try {
        restored = await storage.restoreUser(targetId, { emailConflictStrategy });
      } catch (err: any) {
        const { RestoreEmailConflictError } = await import("../storage/clientStorage");
        if (err instanceof RestoreEmailConflictError) {
          const collider = err.collider;
          const collidingName =
            [collider.firstName, collider.lastName].filter(Boolean).join(" ") ||
            collider.email ||
            collider.id;
          const fallbackEmail = `${err.email}.restored.<timestamp>`;
          return res.status(409).json({
            error: `Cannot restore: another active user (${collidingName}) already uses ${err.email}.`,
            code: "EMAIL_CONFLICT",
            email: err.email,
            collidingUser: {
              id: collider.id,
              email: collider.email,
              firstName: collider.firstName,
              lastName: collider.lastName,
              displayName: collidingName,
            },
            fallback: {
              strategy: "suffix",
              previewEmail: fallbackEmail,
            },
          });
        }
        throw err;
      }
      if (!restored) return res.status(404).json({ error: "User not found" });

      try {
        const { insertActivityLogs } = await import("../storage/activityStorage");
        const targetName =
          [restored.firstName, restored.lastName].filter(Boolean).join(" ") ||
          restored.email ||
          restored.id;
        await insertActivityLogs([{
          userId: actorId ?? null,
          actionType: "user_restored",
          route: "/admin/users",
          actionDetail: `Restored user ${targetName}`,
          metadata: {
            targetUserId: restored.id,
            targetUserName: targetName,
            targetUserEmail: restored.email,
            priorDeletedAt: target.deletedAt,
            priorEmail: target.email,
          },
          sessionId: null,
          duration: null,
          timestamp: new Date(),
        }]);
      } catch (logErr: any) {
        console.error("[UserRestore] Audit log failed:", logErr?.message);
      }

      res.json({ ok: true, id: restored.id, user: restored });
    } catch (error: any) {
      console.error("Error restoring user:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  // Task #1933 — CEO-only inline email edit from User Management. Primary
  // motivator: cleaning up the synthetic `<original>.restored.<ts>`
  // address left behind by the suffix-fallback restore path (Task #1910)
  // once the colliding active account has been reassigned or removed.
  // Mirrors the restore handler's uniqueness check + 409 shape.
  app.patch("/api/users/:id/email", isAuthenticated, requireCeo, async (req: any, res) => {
    try {
      const targetId = req.params.id;
      if (!targetId) return res.status(400).json({ error: "Missing user id" });

      const rawEmail = typeof req.body?.email === "string" ? req.body.email : "";
      const email = rawEmail.trim();
      if (!email) return res.status(400).json({ error: "Email is required" });
      // Minimal sanity check — full RFC compliance isn't worth the
      // false negatives; the unique index is the real authority.
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: "Enter a valid email address" });
      }

      const target = await storage.getUserIncludingDeleted(targetId);
      if (!target) return res.status(404).json({ error: "User not found" });

      const priorEmail = target.email;
      let updated;
      try {
        updated = await storage.updateUserEmail(targetId, email);
      } catch (err: any) {
        const { RestoreEmailConflictError } = await import("../storage/clientStorage");
        if (err instanceof RestoreEmailConflictError) {
          const collider = err.collider;
          const collidingName =
            [collider.firstName, collider.lastName].filter(Boolean).join(" ") ||
            collider.email ||
            collider.id;
          return res.status(409).json({
            error: `Another active user (${collidingName}) already uses ${err.email}.`,
            code: "EMAIL_CONFLICT",
            email: err.email,
            collidingUser: {
              id: collider.id,
              email: collider.email,
              firstName: collider.firstName,
              lastName: collider.lastName,
              displayName: collidingName,
            },
          });
        }
        throw err;
      }
      if (!updated) return res.status(404).json({ error: "User not found" });

      if (priorEmail !== updated.email) {
        try {
          const { insertActivityLogs } = await import("../storage/activityStorage");
          const targetName =
            [updated.firstName, updated.lastName].filter(Boolean).join(" ") ||
            updated.email ||
            updated.id;
          await insertActivityLogs([{
            userId: req.user?.claims?.sub ?? null,
            actionType: "user_email_updated",
            route: "/admin/users",
            actionDetail: `Updated email for ${targetName}`,
            metadata: {
              targetUserId: updated.id,
              targetUserName: targetName,
              priorEmail,
              newEmail: updated.email,
            },
            sessionId: null,
            duration: null,
            timestamp: new Date(),
          }]);
        } catch (logErr: any) {
          console.error("[UserEmail] Audit log failed:", logErr?.message);
        }
      }

      res.json(updated);
    } catch (error: any) {
      console.error("Error updating user email:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  // Task #2043 — dry-run preview of the restored-fallback email cleanup
  // (Task #2029). Read-only: lists every active user on a synthetic
  // `<original>.restored.<ts>` address, the original address each would be
  // restored to, and whether a run would repair it ("restorable") or
  // leave it for manual cleanup because another active user still owns the
  // original ("collision"). Surfaces the pause / kill-switch gates so an
  // operator knows whether a real run would actually proceed. CEO-only to
  // match the adjacent manual restore/edit-email actions.
  app.get(
    "/api/users/restored-email-cleanup/preview",
    isAuthenticated,
    requireCeo,
    async (_req: any, res) => {
      try {
        const { previewRestoredEmailCleanup } = await import(
          "../services/restoredEmailCleanup"
        );
        const preview = await previewRestoredEmailCleanup();
        res.json(preview);
      } catch (err: any) {
        console.error(
          "[RestoredEmailCleanup] preview failed:",
          err?.message,
        );
        res
          .status(500)
          .json({ error: "Failed to load restored-email cleanup preview" });
      }
    },
  );

  // Task #2043 — operator-triggered, on-demand restored-fallback email
  // cleanup. Enqueues a single `restored_email_cleanup` worker job (the
  // same queue the scheduler uses) with `force: true` so the tick runs
  // even when the `restored_email_cleanup_enabled` master switch is off —
  // operators can run a sweep without flipping the persistent setting. The
  // queue-drain pause and KILL_SWITCH_NON_CRITICAL_SWEEPS gates are still
  // honored and surface as calm 503 reasons. The per-minute dedupe key
  // collapses repeated presses to one job. CEO-only to match the adjacent
  // manual restore/edit-email actions.
  app.post(
    "/api/users/restored-email-cleanup/run",
    isAuthenticated,
    requireCeo,
    async (req: any, res) => {
      try {
        const { QUEUE_NAME } = await import(
          "../services/restoredEmailCleanup"
        );
        const { isQueuePaused } = await import(
          "../services/queueDrainControl"
        );
        const { PERF } = await import("../perfConfig");

        if (isQueuePaused(QUEUE_NAME)) {
          return res.status(503).json({
            error: "queue paused via queue_drain_state",
            reason: `The "${QUEUE_NAME}" queue is paused, so nothing was run. Resume it in queue-drain controls and try again.`,
          });
        }
        if (PERF.KILL_SWITCH_NON_CRITICAL_SWEEPS) {
          return res.status(503).json({
            error: "KILL_SWITCH_NON_CRITICAL_SWEEPS=true",
            reason:
              "Non-critical sweeps are paused by a kill switch, so nothing was run. Turn the KILL_SWITCH_NON_CRITICAL_SWEEPS kill switch off and try again.",
          });
        }

        const { enqueueJob } = await import("../services/workScheduler");
        const actorId = req.user?.claims?.sub ?? null;
        const bucket = Math.floor(Date.now() / 60_000);
        const jobId = await enqueueJob({
          queueName: QUEUE_NAME,
          workloadClass: "maintenance",
          priority: 150,
          payload: { trigger: "operator", force: true, userId: actorId },
          dedupeKey: `${QUEUE_NAME}:operator:${bucket}`,
          maxAttempts: 2,
        });

        try {
          const { insertActivityLogs } = await import(
            "../storage/activityStorage"
          );
          await insertActivityLogs([
            {
              userId: actorId,
              actionType: "restored_email_cleanup_triggered",
              route: "/api/users/restored-email-cleanup/run",
              actionDetail: `Enqueued restored-email cleanup job ${jobId}`,
              metadata: { jobId },
              sessionId: null,
              duration: null,
              timestamp: new Date(),
            },
          ]);
        } catch (logErr: any) {
          console.error(
            "[RestoredEmailCleanup] trigger audit log failed:",
            logErr?.message,
          );
        }

        return res.status(202).json({ status: "enqueued", jobId });
      } catch (err: any) {
        console.error(
          "[RestoredEmailCleanup] trigger failed:",
          err?.message,
        );
        res
          .status(500)
          .json({ error: "Failed to enqueue restored-email cleanup" });
      }
    },
  );

  // Task #2246 — read-only operator status for the restored-fallback email
  // auto-cleanup (Task #2029). Unlike the other four maintenance jobs this
  // one had no consuming route, so operators couldn't see when it last ran
  // or whether its last-run record is even readable. Returns the live config
  // (master switch + bounding knobs), the caps each knob is bounded by, and
  // the persisted last-run summary classified as ok / never_run / unreadable
  // (with a plain-English reason when unreadable) — mirroring the
  // feedback→Slack retry status route. CEO-only to match the adjacent
  // restored-email-cleanup preview/run actions.
  app.get(
    "/api/users/restored-email-cleanup/status",
    isAuthenticated,
    requireCeo,
    async (_req: any, res) => {
      try {
        const {
          readLastRestoredEmailCleanupRun,
          getRestoredEmailCleanupConfig,
          MAX_PER_TICK_CAP,
          COLLISION_ALERT_THRESHOLD_CAP,
          COLLISION_STUCK_HOURS_CAP,
        } = await import("../services/restoredEmailCleanup");
        const [lastRunRead, config] = await Promise.all([
          readLastRestoredEmailCleanupRun(),
          getRestoredEmailCleanupConfig(),
        ]);
        res.json({
          config,
          caps: {
            maxPerTick: MAX_PER_TICK_CAP,
            collisionAlertThreshold: COLLISION_ALERT_THRESHOLD_CAP,
            collisionStuckHours: COLLISION_STUCK_HOURS_CAP,
          },
          lastRun: lastRunRead.lastRun,
          lastRunStatus: lastRunRead.status,
          ...(lastRunRead.error ? { lastRunError: lastRunRead.error } : {}),
        });
      } catch (err: any) {
        console.error(
          "[RestoredEmailCleanup] status endpoint failed:",
          err?.message ?? err,
        );
        res
          .status(500)
          .json({ error: "Failed to fetch restored-email cleanup status" });
      }
    },
  );

  // Task #1758: read-only status surface for the User Management header
  // (Permission Mode + Effective Access readout).
  app.get("/api/admin/role-permissions/status", isAuthenticated, requireTeamLead, async (_req, res) => {
    try {
      const { isPermissiveModeEnabled } = await import("../auth/permissions");
      const permissive = await isPermissiveModeEnabled();
      res.json({
        permissive,
        effectiveAccessLabel: permissive
          ? "All Functions + Team-Lead-Level Permissions"
          : "Function-Gated + Authority-Gated",
      });
    } catch (e: any) {
      console.error("[role-permissions/status]", e?.message);
      res.json({ permissive: true, effectiveAccessLabel: "All Functions + Team-Lead-Level Permissions" });
    }
  });

  // Backfill review banner — read + dismiss (Task #1758).
  app.get("/api/admin/role-backfill-banner", isAuthenticated, requireTeamLead, async (_req, res) => {
    try {
      const v = await storage.getSystemSetting("role_backfill_review_banner_dismissed");
      res.json({ dismissed: v?.value === "true" });
    } catch {
      res.json({ dismissed: false });
    }
  });
  app.post("/api/admin/role-backfill-banner/dismiss", isAuthenticated, requireCeo, async (_req, res) => {
    try {
      await storage.setSystemSetting("role_backfill_review_banner_dismissed", "true");
      res.json({ dismissed: true });
    } catch (e: any) {
      console.error("[role-backfill-banner/dismiss]", e?.message);
      res.status(500).json({ error: "Failed to dismiss banner" });
    }
  });

  // ============================================
  // LEGACY TRENDS API
  // ============================================
  // Task #4192 audit: no client/website caller and zero prod requests over the
  // observed metrics window (2026-08-06→2026-08-10) — the "embedded in
  // shared/public report views" claim was stale (public reports use
  // POST /api/trends/practice-areas). Auth-gated; returns hardcoded seasonal index.
  app.get("/api/trends", isAuthenticated, (_req, res) => {
    try {
      const currentDate = new Date();
      const currentMonthIndex = currentDate.getMonth();
      
      const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const fiveYearAverage = [100, 92, 88, 82, 75, 70, 68, 78, 72, 65, 55, 52];
      const phases = classifyPhases(fiveYearAverage);
      
      const averagedData = monthNames.map((month, index) => ({
        month,
        value: fiveYearAverage[index],
        isCurrent: index === currentMonthIndex,
        phase: phases[index],
      }));
      
      res.json({ 
        averagedData,
        currentMonth: monthNames[currentMonthIndex],
        source: "Google Trends - 5-Year Average (2020-2024)"
      });
    } catch (error) {
      console.error("Error generating trends data:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  // ============================================
  // PRACTICE AREA TRENDS API
  // ============================================
  // Task #4210: the deterministic seasonal-trend computation (hardcoded
  // 5-year-average patterns + DB custom settings + combined average) moved
  // verbatim to server/services/practiceAreaTrendData.ts so the public
  // share-report payload (buildReportResponse) can embed the SAME real data
  // for anonymous viewers. This route layers the OpenAI analysis on top.

  // Get trends data for specific practice areas (authenticated: invokes OpenAI)
  app.post("/api/trends/practice-areas", isAuthenticated, async (req, res) => {
    try {
      const { practiceAreas } = req.body;
      
      if (!practiceAreas || !Array.isArray(practiceAreas) || practiceAreas.length === 0) {
        return res.status(400).json({ error: "practiceAreas array is required" });
      }

      const trendData = await computePracticeAreaTrendData(practiceAreas);
      const results = trendData.practiceAreas;
      const combined = trendData.combined;
      const { currentMonth, currentMonthIndex } = trendData;

      // Task #4240: prompt construction + OpenAI call moved verbatim to
      // server/services/practiceAreaTrendAnalysis.ts so report finalize can
      // generate and cache the SAME analysis for anonymous share viewers.
      // This route keeps its live per-request behavior (client injected —
      // the confined adapter from ./middleware).
      const aiAnalysis = await generatePracticeAreaTrendAiAnalysis(trendData, openai);

      res.json({
        practiceAreas: results,
        combined,
        currentMonth,
        currentMonthIndex,
        aiAnalysis,
        source: "Google Trends - 5-Year Average Seasonal Patterns",
      });
    } catch (error) {
      console.error("Error fetching practice area trends:", error);
      res.status(500).json({ error: "Server error" });
    }
  });


  // Get list of available practice areas
  // Task #4192 audit: no caller anywhere (client, website, server) and zero
  // prod requests in the observed metrics window — auth-gated.
  app.get("/api/trends/practice-areas/list", isAuthenticated, (_req, res) => {
    res.json({
      practiceAreas: Object.keys(practiceAreaTrends),
    });
  });

  // ===== PRACTICE AREA SETTINGS ADMIN ENDPOINTS =====
  
  // Get all practice area settings (CEO only)
  app.get("/api/admin/practice-area-settings", isAuthenticated, requireCeo, async (req: any, res) => {
    try {
      
      const settings = await storage.getPracticeAreaSettings();
      
      // Get all practice areas from shared module and mark custom vs default
      const dbSettingsMap = new Map(settings.map(s => [s.practiceArea.toLowerCase(), s]));
      
      const allPracticeAreas = PRACTICE_AREA_OPTIONS.map(area => {
        const dbSetting = dbSettingsMap.get(area.toLowerCase());
        if (dbSetting) {
          return {
            id: dbSetting.id,
            practiceArea: area,
            searchTerm: dbSetting.searchTerm,
            monthlyData: dbSetting.monthlyData,
            isActive: dbSetting.isActive ?? true,
            isDefault: false,
          };
        }
        return {
          id: null,
          practiceArea: area,
          searchTerm: DEFAULT_SEARCH_TERMS[area] || `${area} lawyer near me`,
          monthlyData: null,
          isActive: true,
          isDefault: true,
        };
      });
      
      // Separate into custom settings and defaults for the response
      const customSettings = allPracticeAreas.filter(s => !s.isDefault);
      const defaults = allPracticeAreas.filter(s => s.isDefault);
      
      res.json({
        settings: customSettings,
        defaults,
      });
    } catch (error) {
      console.error("Error fetching practice area settings:", error);
      res.status(500).json({ error: "Server error" });
    }
  });
  
  // Create or update practice area setting (CEO only)
  app.post("/api/admin/practice-area-settings", isAuthenticated, requireCeo, async (req: any, res) => {
    try {
      
      const { practiceArea, searchTerm, monthlyData, isActive } = req.body;
      
      if (!practiceArea || !searchTerm) {
        return res.status(400).json({ error: "practiceArea and searchTerm are required" });
      }
      
      // Normalize practiceArea: trim and preserve original casing for display
      // But we need consistent matching, so also validate
      const normalizedArea = practiceArea.toString().trim();
      
      if (!normalizedArea) {
        return res.status(400).json({ error: "practiceArea cannot be empty" });
      }
      
      const setting = await storage.upsertPracticeAreaSetting({
        practiceArea: normalizedArea,
        searchTerm: searchTerm.toString().trim(),
        monthlyData: monthlyData || null,
        isActive: isActive !== false,
      });
      
      res.json(setting);
    } catch (error) {
      console.error("Error saving practice area setting:", error);
      res.status(500).json({ error: "Server error" });
    }
  });
  
  // Delete practice area setting (CEO only)
  app.delete("/api/admin/practice-area-settings/:id", isAuthenticated, requireCeo, async (req: any, res) => {
    try {
      
      await storage.deletePracticeAreaSetting(req.params.id);
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting practice area setting:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  // ============================================
  // Phase Settings API - Admin configurable phase actions
  // ============================================
  
  const DEFAULT_PHASE_ACTIONS: Record<string, string[]> = {
    Peak: [
      "**Hold Steady:** Things are working. Enjoy the increased demand and let the system print money",
      "**Fix the Bottleneck:** If you can't take more leads or spend more, intake or sales is the limiter"
    ],
    Hold: [
      "**Stay the Course:** Keep doing what's working while demand stays strong",
      "**Go Wider:** Open new GBP locations to turn steady demand into more total volume"
    ],
    Taper: [
      "**Hold the Line:** Keep ad spend steady and avoid losing momentum",
      "**Strengthen the Engine:** Use this window to improve intake or sales so each lead is worth more"
    ],
    Soft: [
      "**Buy Market Share:** Keep spending while competitors pull back",
      "**Build While It's Quiet:** Fix intake, fix sales, or open new locations so growth isn't capped later"
    ],
    Rebuild: [
      "**Turn It Back Up:** Demand is returning, now is the time to spend more",
      "**Expand Faster:** Add locations and scale what you already know works"
    ],
  };
  
  // GET phase settings
  // PUBLIC: phase definitions are generic content used in publicly-shared report views;
  // no client-specific or internal data is exposed. Writes (PUT below) are CEO-only.
  app.get("/api/phase-settings", async (req, res) => {
    try {
      const settings = await storage.getPhaseSettings();
      const settingsMap = new Map(settings.map(s => [s.phase, s.actions]));
      
      // Merge with defaults for any missing phases
      const allPhases = ["Peak", "Hold", "Taper", "Soft", "Rebuild"];
      const result = allPhases.map(phase => ({
        phase,
        actions: settingsMap.get(phase) || DEFAULT_PHASE_ACTIONS[phase] || [],
        isCustom: settingsMap.has(phase),
      }));
      
      res.json(result);
    } catch (error) {
      console.error("Error fetching phase settings:", error);
      res.status(500).json({ error: "Server error" });
    }
  });
  
  // PUT phase settings (CEO only)
  app.put("/api/admin/phase-settings", isAuthenticated, requireCeo, async (req: any, res) => {
    try {
      const userId = req.user?.claims?.sub;
      const { phase, actions } = req.body;
      
      if (!phase || !Array.isArray(actions)) {
        return res.status(400).json({ error: "phase (string) and actions (array) are required" });
      }
      
      const validPhases = ["Peak", "Hold", "Taper", "Soft", "Rebuild"];
      if (!validPhases.includes(phase)) {
        return res.status(400).json({ error: `Invalid phase. Must be one of: ${validPhases.join(", ")}` });
      }
      
      const setting = await storage.upsertPhaseSetting({
        phase,
        actions,
        updatedBy: userId,
      });
      
      res.json(setting);
    } catch (error) {
      console.error("Error updating phase setting:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  }
  
