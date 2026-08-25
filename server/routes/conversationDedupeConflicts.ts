// Task #1285 — admin routes for the duplicate-thread conflict resolver.
// Listed and resolved by `server/services/conversationDedupe.ts`. The
// Slack alert fired when `mergeDirectConversationGroup` skips a group
// (`infra.conversation_dedupe.client_conflict`) links straight here.

import type { Express, RequestHandler } from "express";
import { z } from "zod";
import { isAuthenticated } from "../middlewares/requireAuth";
import { requireTeamLead } from "./middleware";
import {
  listOpenClientConflicts,
  resolveClientConflict,
} from "../services/conversationDedupe";
import { getClient } from "../storage/clientStorage";

const resolveBodySchema = z.object({
  key: z.string().min(1),
  survivorConversationId: z.string().min(1),
  targetClientId: z.string().min(1),
});

export function registerConversationDedupeConflictRoutes(app: Express): void {
  const guard: RequestHandler[] = [isAuthenticated, requireTeamLead];

  app.get(
    "/api/admin/conversation-dedupe-conflicts",
    ...guard,
    async (_req, res) => {
      try {
        const groups = await listOpenClientConflicts();
        const clientIds = new Set<string>();
        for (const g of groups) {
          for (const id of g.conflictingClientIds) clientIds.add(id);
        }
        const clients: Record<string, { id: string; firmName: string }> = {};
        for (const id of clientIds) {
          const c = await getClient(id);
          if (c) clients[id] = { id: c.id, firmName: c.firmName };
        }
        res.json({ groups, clients });
      } catch (err: any) {
        console.error("[conversation-dedupe-conflicts] list error:", err?.message ?? err);
        res.status(500).json({ error: "Failed to list conflicts" });
      }
    },
  );

  app.post(
    "/api/admin/conversation-dedupe-conflicts/resolve",
    ...guard,
    async (req: any, res) => {
      const parsed = resolveBodySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
        return;
      }
      const actorId =
        req.user?.claims?.sub ?? req.user?.id ?? "unknown";
      const actor = `user:${actorId} (conversation-dedupe-conflict-resolver)`;
      try {
        const result = await resolveClientConflict({
          key: parsed.data.key,
          survivorConversationId: parsed.data.survivorConversationId,
          targetClientId: parsed.data.targetClientId,
          actor,
        });
        res.json(result);
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        console.error("[conversation-dedupe-conflicts] resolve error:", msg);
        res.status(400).json({ error: msg });
      }
    },
  );
}
