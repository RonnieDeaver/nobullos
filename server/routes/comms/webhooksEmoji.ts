// @db-pool-intent: api (request-scoped reads/writes)
/**
 * NoBull Comms routes — webhooks, slash commands & custom emoji.
 * Extracted verbatim from server/routes/comms.ts (Task #3787 split);
 * sections: Incoming webhooks, Webhook management, Slash commands, Custom emoji.
 * Mounted by registerCommsRoutes in ../comms.ts — route order is
 * preserved by the aggregator's call sequence.
 */

import { type Express } from "express";
import { Readable } from "node:stream";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { z } from "zod";
import { isAuthenticated } from "../../middlewares/requireAuth";
import multer from "multer";
import { broadcastTwilioEvent } from "../../services/twilioEvents";
import * as commsStorage from "../../storage/commsStorage";
import { getUser } from "../../storage/clientStorage";
import { db } from "../../db";
import { inArray } from "drizzle-orm";
import { isTeamLead, getUserId, STANDARD_EMOJI_LIST, maybeResizeEmojiBuffer, objectStorage } from "./shared";

export function registerCommsWebhookEmojiRoutes(app: Express): void {
  // ──────────────────────────────────────────────────────────────────────────
  // Webhook management (team-lead+)
  // ──────────────────────────────────────────────────────────────────────────

  // POST /api/comms/webhooks — create a webhook (team-lead+ only)
  // Returns the webhook record + raw token (shown once, never stored).
  app.post("/api/comms/webhooks", isAuthenticated, async (req: any, res) => {
    if (!isTeamLead(req)) {
      res.status(403).json({ error: "Requires team lead or CEO role" });
      return;
    }

    const { channelId, name } = req.body ?? {};
    if (!channelId || typeof channelId !== "string") {
      res.status(400).json({ error: "channelId is required" });
      return;
    }

    let channel;
    try {
      channel = await commsStorage.getChannelById(channelId);
    } catch (err: any) {
      console.error("[Comms] Webhook create - channel lookup error:", err.message);
      res.status(500).json({ error: "Internal error" });
      return;
    }

    if (!channel || channel.archivedAt) {
      res.status(404).json({ error: "Channel not found or archived" });
      return;
    }

    // Generate a secure random token; only the hash goes in the DB.
    const rawToken = randomBytes(32).toString("hex");
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");

    try {
      const wh = await commsStorage.createWebhook({
        channelId,
        name: (typeof name === "string" && name.trim()) ? name.trim() : "Incoming Webhook",
        tokenHash,
        createdBy: getUserId(req),
        enabled: true,
      });

      // Strip the hash from the response — it must never be returned.
      const { tokenHash: _hidden, ...safe } = wh;
      res.status(201).json({ webhook: safe, token: rawToken });
    } catch (err: any) {
      console.error("[Comms] Webhook create error:", err.message);
      res.status(500).json({ error: "Failed to create webhook" });
    }
  });

  // GET /api/comms/webhooks — list all webhooks (team-lead+)
  app.get("/api/comms/webhooks", isAuthenticated, async (req: any, res) => {
    if (!isTeamLead(req)) {
      res.status(403).json({ error: "Requires team lead or CEO role" });
      return;
    }
    try {
      const webhooks = await commsStorage.listAllWebhooks();
      // Strip token hashes from all records.
      const safe = webhooks.map(({ tokenHash: _hidden, ...rest }) => rest);
      res.json(safe);
    } catch (err: any) {
      console.error("[Comms] List webhooks error:", err.message);
      res.status(500).json({ error: "Failed to list webhooks" });
    }
  });

  // DELETE /api/comms/webhooks/:id — revoke a webhook (team-lead+)
  // Sets enabled=false; the token hash remains in the DB for audit purposes.
  app.delete("/api/comms/webhooks/:id", isAuthenticated, async (req: any, res) => {
    if (!isTeamLead(req)) {
      res.status(403).json({ error: "Requires team lead or CEO role" });
      return;
    }
    try {
      const wh = await commsStorage.revokeWebhook(req.params.id);
      if (!wh) {
        res.status(404).json({ error: "Webhook not found" });
        return;
      }
      res.json({ ok: true });
    } catch (err: any) {
      console.error("[Comms] Revoke webhook error:", err.message);
      res.status(500).json({ error: "Failed to revoke webhook" });
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Slash command dispatch
  // POST /api/comms/channels/:id/slash  { command, args }
  // Returns { ok: true } or { ephemeral: true, text } for user-only errors.
  // ──────────────────────────────────────────────────────────────────────────

  const slashValidSchema = z.object({
    command: z.string().min(1).max(64),
    args: z.string().max(4000).default(""),
  });

  app.post("/api/comms/channels/:id/slash", isAuthenticated, async (req: any, res) => {
    const userId = getUserId(req);
    const channelId = req.params.id;

    let channel;
    try {
      channel = await commsStorage.getChannelById(channelId);
    } catch (err: any) {
      console.error("[Comms] Slash - channel lookup error:", err.message);
      res.status(500).json({ error: "Internal error" });
      return;
    }

    if (!channel || channel.archivedAt) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }

    const isMember = await commsStorage.isChannelMember(channelId, userId).catch(() => false);
    if (!isMember) {
      res.status(403).json({ error: "Not a member of this channel" });
      return;
    }

    const parsed = slashValidSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid command payload" });
      return;
    }

    const { command, args } = parsed.data;

    const ephemeral = (text: string) => res.json({ ephemeral: true, text });

    try {
      if (command === "/shrug") {
        const prefix = args.trim() ? `${args.trim()} ` : "";
        await commsStorage.createMessage({
          channelId,
          userId,
          content: `${prefix}¯\\_(ツ)_/¯`,
          contentType: "text",
        });
        res.json({ ok: true });
        return;
      }

      if (command === "/me") {
        if (!args.trim()) {
          ephemeral("Usage: /me [action]");
          return;
        }
        await commsStorage.createMessage({
          channelId,
          userId,
          content: `_${args.trim()}_`,
          contentType: "text",
        });
        res.json({ ok: true });
        return;
      }

      if (command === "/status" || command === "/online" || command === "/away" || command === "/dnd" || command === "/offline") {
        const statusMap: Record<string, string> = {
          "/online": "online",
          "/away": "away",
          "/dnd": "dnd",
          "/offline": "offline",
        };
        let newStatus: string;
        if (command === "/status") {
          newStatus = args.trim() || "online";
        } else {
          newStatus = statusMap[command];
        }
        const valid = ["online", "away", "dnd", "offline"];
        if (!valid.includes(newStatus)) {
          ephemeral(`Unknown status "${newStatus}". Valid values: online, away, dnd, offline`);
          return;
        }
        await commsStorage.setUserManualStatus(userId, newStatus as any);
        broadcastTwilioEvent({
          type: "comms:user_status",
          userId,
          effectiveStatus: newStatus as "online" | "away" | "dnd" | "offline",
          manualStatus: newStatus,
          customEmoji: null,
          customText: null,
          customExpiresAt: null,
          dndExpiresAt: null,
        });
        res.json({ ok: true, status: newStatus });
        return;
      }

      if (command === "/mute") {
        await commsStorage.setNotificationPref(channelId, userId, "muted");
        const chanName = channel.name ?? channel.slug ?? channelId;
        ephemeral(`You muted #${chanName}. Use /unmute to restore notifications.`);
        return;
      }

      if (command === "/unmute") {
        await commsStorage.setNotificationPref(channelId, userId, "all");
        const chanName = channel.name ?? channel.slug ?? channelId;
        ephemeral(`Notifications restored for #${chanName}.`);
        return;
      }

      if (command === "/leave") {
        if ((channel as any).type === "dm") {
          ephemeral("You cannot leave a DM channel.");
          return;
        }
        await commsStorage.removeChannelMember(channelId, userId);
        const actor = await getUser(userId).catch(() => null);
        const actorName = actor ? [actor.firstName, actor.lastName].filter(Boolean).join(" ") : "Someone";
        await commsStorage.createMessage({
          channelId,
          userId: null,
          content: `${actorName} left the channel`,
          contentType: "system",
        });
        res.json({ ok: true, left: true });
        return;
      }

      if (command === "/help") {
        ephemeral(
          "Available commands: /status [online|away|dnd|offline], /dnd, /away, /online, /shrug [msg], /me [action], /mute, /unmute, /leave",
        );
        return;
      }

      ephemeral(`Unknown command: ${command}. Type /help for a list of available commands.`);
    } catch (err: any) {
      console.error("[Comms] Slash command error:", err.message);
      res.status(500).json({ error: "Command failed" });
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Custom emoji
  // ──────────────────────────────────────────────────────────────────────────
  //
  // Route registration order matters: literal paths MUST be registered before
  // parameterised :id paths to prevent Express param collision.
  //  /api/comms/emoji/frequently-used  ← literal, registered first
  //  /api/comms/emoji/autocomplete     ← literal, registered second
  //  /api/comms/emoji                  ← GET list, POST create
  //  /api/comms/emoji/:id/image        ← parameterised, registered last
  //  /api/comms/emoji/:id              ← DELETE

  const EMOJI_NAME_RE = /^[a-zA-Z0-9_-]{2,64}$/;
  const ALLOWED_EMOJI_MIME = new Set([
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
  ]);
  const emojiUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 256 * 1024 },
  });

  // GET /api/comms/emoji/frequently-used — top emoji for the authenticated user
  app.get("/api/comms/emoji/frequently-used", isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const limit = Math.min(Number(req.query.limit ?? 24), 48);
      const rows = await commsStorage.getFrequentlyUsedEmoji(userId, limit);
      res.json(rows.map((r) => ({ emoji: r.emoji, useCount: r.useCount })));
    } catch (err: any) {
      console.error("[Comms] Frequently-used emoji error:", err.message);
      res.status(500).json({ error: "Failed to fetch frequently-used emoji" });
    }
  });

  // GET /api/comms/emoji/autocomplete?q=foo&limit=12 — search standard + custom emoji names
  app.get("/api/comms/emoji/autocomplete", isAuthenticated, async (req: any, res) => {
    try {
      const q = ((req.query.q as string | undefined) ?? "").toLowerCase();
      const limit = Math.min(Number(req.query.limit ?? 12), 24);
      if (q.length < 1) return res.json([]);
      const [custom, standardMatches] = await Promise.all([
        commsStorage.searchCustomEmoji(q, limit),
        Promise.resolve(
          STANDARD_EMOJI_LIST.filter((e) => e.name.includes(q)).slice(0, limit),
        ),
      ]);
      const customResults = custom.map((e) => ({
        type: "custom" as const,
        name: e.name,
        id: e.id,
        imageUrl: `/api/comms/emoji/${e.id}/image`,
      }));
      const standardResults = standardMatches.map((e) => ({
        type: "standard" as const,
        name: e.name,
        char: e.char,
      }));
      // Custom emoji take priority; fill remaining slots with standard
      const combined = [
        ...customResults,
        ...standardResults.filter(
          (s) => !customResults.some((c) => c.name === s.name),
        ),
      ].slice(0, limit);
      res.json(combined);
    } catch (err: any) {
      console.error("[Comms] Emoji autocomplete error:", err.message);
      res.status(500).json({ error: "Failed to autocomplete emoji" });
    }
  });

  // POST /api/comms/emoji/usage — record one emoji use for the authenticated user
  app.post("/api/comms/emoji/usage", isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const { emoji } = req.body ?? {};
      if (!emoji || typeof emoji !== "string" || emoji.length > 64) {
        return res.status(400).json({ error: "emoji is required (max 64 chars)" });
      }
      await commsStorage.trackEmojiUsage(userId, emoji);
      res.json({ ok: true });
    } catch (err: any) {
      console.error("[Comms] Track emoji usage error:", err.message);
      res.status(500).json({ error: "Failed to track emoji usage" });
    }
  });

  // GET /api/comms/emoji — list all custom emoji with uploader display names (authenticated)
  app.get("/api/comms/emoji", isAuthenticated, async (_req, res) => {
    try {
      const list = await commsStorage.listCustomEmoji();
      // Batch-fetch uploader display names
      const uploaderIds = [...new Set(list.map((e) => e.createdBy).filter((id): id is string => Boolean(id)))];
      const uploaderMap: Record<string, string> = {};
      if (uploaderIds.length > 0) {
        const rows = await db.query.users.findMany({
          where: (u, { inArray: ina }) => ina(u.id, uploaderIds),
          columns: { id: true, firstName: true, lastName: true, email: true },
        });
        for (const u of rows) {
          const displayName = [u.firstName, u.lastName].filter(Boolean).join(" ") || u.email || u.id;
          uploaderMap[u.id] = displayName;
        }
      }
      res.json(
        list.map((e) => ({
          id: e.id,
          name: e.name,
          contentType: e.contentType,
          sizeBytes: e.sizeBytes,
          createdBy: e.createdBy,
          createdByName: e.createdBy ? (uploaderMap[e.createdBy] ?? null) : null,
          createdAt: e.createdAt,
          imageUrl: `/api/comms/emoji/${e.id}/image`,
        })),
      );
    } catch (err: any) {
      console.error("[Comms] List custom emoji error:", err.message);
      res.status(500).json({ error: "Failed to list custom emoji" });
    }
  });

  // POST /api/comms/emoji — upload a new custom emoji (team_lead or ceo only,
  // matching the UI gate on the custom-emoji manager).
  // Body: multipart/form-data with field `name` (string) + `image` (image file).
  app.post(
    "/api/comms/emoji",
    isAuthenticated,
    emojiUpload.single("image"),
    async (req: any, res) => {
      try {
        if (!isTeamLead(req)) {
          return res
            .status(403)
            .json({ error: "Only team leads or CEOs may upload custom emoji" });
        }
        const userId = getUserId(req);
        const name = (req.body?.name ?? "").trim().toLowerCase();
        if (!EMOJI_NAME_RE.test(name)) {
          return res
            .status(400)
            .json({ error: "name must be 2–64 chars [a-zA-Z0-9_-]" });
        }
        if (!req.file) return res.status(400).json({ error: "No file provided" });
        if (!ALLOWED_EMOJI_MIME.has(req.file.mimetype)) {
          return res
            .status(400)
            .json({ error: "Only PNG, JPEG, GIF, or WebP images are accepted" });
        }

        // Reject if name already taken
        const existing = await commsStorage.getCustomEmojiByName(name);
        if (existing) {
          return res
            .status(409)
            .json({ error: `An emoji named :${name}: already exists` });
        }

        // Resize non-GIF/non-WebP images to ≤128 px (preserves GIF animation)
        const resizedBuf = await maybeResizeEmojiBuffer(req.file.buffer, req.file.mimetype);
        const ext =
          req.file.mimetype === "image/gif"
            ? "gif"
            : req.file.mimetype === "image/webp"
            ? "webp"
            : req.file.mimetype === "image/png"
            ? "png"
            : "jpg";
        const objectKey = `comms-emoji/${randomUUID()}.${ext}`;
        const stream = Readable.from(resizedBuf);
        await objectStorage.streamUploadToPrivateKey(objectKey, stream, req.file.mimetype);

        const emoji = await commsStorage.createCustomEmoji({
          name,
          objectKey,
          contentType: req.file.mimetype,
          sizeBytes: resizedBuf.length,
          createdBy: userId,
        });

        res.status(201).json({
          id: emoji.id,
          name: emoji.name,
          contentType: emoji.contentType,
          sizeBytes: emoji.sizeBytes,
          createdBy: emoji.createdBy,
          createdAt: emoji.createdAt,
          imageUrl: `/api/comms/emoji/${emoji.id}/image`,
        });
      } catch (err: any) {
        console.error("[Comms] Upload custom emoji error:", err.message);
        res.status(500).json({ error: "Failed to upload custom emoji" });
      }
    },
  );

  // GET /api/comms/emoji/:id/image — serve the raw emoji image (authenticated, immutable)
  app.get("/api/comms/emoji/:id/image", isAuthenticated, async (req: any, res) => {
    try {
      const emoji = await commsStorage.getCustomEmojiById(req.params.id);
      if (!emoji) return res.status(404).json({ error: "Emoji not found" });
      let file: any;
      try {
        file = await objectStorage.getPrivateObjectFileByKey(emoji.objectKey);
      } catch {
        return res.status(404).json({ error: "Emoji image not found in storage" });
      }
      // Key is UUID-scoped; safe to cache immutably. Private because auth is required.
      res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
      res.setHeader("Content-Type", emoji.contentType);
      await objectStorage.downloadObject(file, res, 31536000);
    } catch (err: any) {
      console.error("[Comms] Serve emoji image error:", err.message);
      res.status(500).json({ error: "Failed to serve emoji image" });
    }
  });

  // DELETE /api/comms/emoji/:id — delete a custom emoji
  // Allowed: the uploader, any team_lead, or ceo.
  app.delete("/api/comms/emoji/:id", isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req);
      const emoji = await commsStorage.getCustomEmojiById(req.params.id);
      if (!emoji) return res.status(404).json({ error: "Emoji not found" });

      const role: string = req.user?.claims?.role ?? "";
      const isPrivileged = role === "team_lead" || role === "ceo";
      if (emoji.createdBy !== userId && !isPrivileged) {
        return res.status(403).json({ error: "Only the uploader or a team lead may delete this emoji" });
      }

      await commsStorage.deleteCustomEmoji(emoji.id);
      res.json({ ok: true });
    } catch (err: any) {
      console.error("[Comms] Delete custom emoji error:", err.message);
      res.status(500).json({ error: "Failed to delete custom emoji" });
    }
  });
}
