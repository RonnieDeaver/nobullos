import type { Express } from "express";
import { isAuthenticated } from "../middlewares/requireAuth";
import { requireCeo } from "./middleware";
import { storage } from "../storage";
import {
  MATCH_SETTING_DESCRIPTORS,
  MATCH_SETTING_KEYS,
  MATCH_SETTING_SOURCES,
  clearPersistedMatchSetting,
  evaluateZoomGuardrailWarningsForProposedChange,
  isAgentMatchSettingKey,
  isAgentMatchSettingSource,
  listEffectiveMatchSettings,
  setPersistedMatchSetting,
} from "../services/matchSettings";
import {
  getCommonFirstNamesConfig,
  setCommonFirstNamesConfig,
} from "../services/zoomGuardrailConfig";
import { insertActivityLogs } from "../storage/activityStorage";
import {
  broadcastMatchSettingChange,
  matchSettingAlertChannelStatus,
} from "../services/matchSettingsAlerts";
import { attemptResend } from "../services/alertResendGuard";
import { MAX_ATTEMPTS as MATCH_SETTING_ALERT_MAX_AUTO_RETRIES } from "../services/matchSettingsAlertAutoRetry";
import type { AgentMatchSettingKey, AgentMatchSettingSource } from "@shared/schema";

const SCOPE_LABEL: Record<AgentMatchSettingSource, string> = {
  default: "Default (all sources)",
  zoom: "Zoom override",
};

const COMMON_FIRST_NAMES_AUDIT_KEY = "zoom_common_first_names";
const COMMON_FIRST_NAMES_SETTING_LABEL = "Common First Names";
const COMMON_FIRST_NAMES_SCOPE_LABEL = "Zoom Guardrail";

function formatNameCount(count: number, isOverride: boolean): string {
  if (!isOverride) return "default";
  return `${count} name${count === 1 ? "" : "s"}`;
}

function diffNameLists(oldList: string[], newList: string[]): { added: string[]; removed: string[] } {
  const oldSet = new Set(oldList);
  const newSet = new Set(newList);
  const added = newList.filter(n => !oldSet.has(n)).sort();
  const removed = oldList.filter(n => !newSet.has(n)).sort();
  return { added, removed };
}

function formatThresholdValue(n: number | null | undefined): string {
  if (n === null || n === undefined) return "unset";
  return Number(n).toFixed(3);
}

function formatActor(
  user: { firstName?: string | null; lastName?: string | null; email?: string | null } | null,
  fallbackId: string | null,
): string {
  if (!user) return fallbackId || "system";
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
  return name || user.email || fallbackId || "system";
}

export async function notifyCommonFirstNamesChange(params: {
  oldCount: number;
  newCount: number;
  oldIsOverride: boolean;
  newIsOverride: boolean;
  action: "updated" | "cleared";
  actorId: string | null;
  historyId: string | null;
}): Promise<void> {
  try {
    const allUsers = await storage.getAllUsers();
    const actor = params.actorId ? allUsers.find(u => u.id === params.actorId) ?? null : null;
    const recipients = allUsers.filter(u => u.role === "ceo" && u.id !== params.actorId);

    const actorName = formatActor(actor, params.actorId);
    const oldStr = formatNameCount(params.oldCount, params.oldIsOverride);
    const newStr = formatNameCount(params.newCount, params.newIsOverride);

    if (recipients.length === 0) {
      if (params.historyId) {
        try {
          await storage.updateAdminSettingAuditDelivery({
            id: params.historyId,
            slackStatus: "skipped",
            emailStatus: "skipped",
          });
        } catch (updateErr) {
          console.warn(
            "[match-settings] failed to mark common-first-names alert delivery as skipped",
            updateErr,
          );
        }
      }
      return;
    }

    const message =
      params.action === "cleared"
        ? `${actorName} cleared the Zoom Guardrail Common First Names override (${COMMON_FIRST_NAMES_AUDIT_KEY}) on ${COMMON_FIRST_NAMES_SCOPE_LABEL}: ${params.oldCount} → default`
        : `${actorName} updated the Zoom Guardrail Common First Names list (${COMMON_FIRST_NAMES_AUDIT_KEY}) on ${COMMON_FIRST_NAMES_SCOPE_LABEL}: ${params.oldCount} → ${params.newCount} names`;

    const notificationMetadata = {
      actorId: params.actorId ?? null,
      actorName: actor ? actorName : null,
      actorEmail: actor?.email ?? null,
    };

    // Task #1713 — Stage B: per-user inbox via notifyUser(). Dedupe by
    // (historyId, recipient) so a retry of the same audit row doesn't
    // re-bell every CEO; falls back to the audit key when no history
    // row id is provided.
    const { notifyUser } = await import("../services/notifications/userInbox");
    const dedupeAnchor = params.historyId ?? `cfn:${Date.now()}`;
    await Promise.all(
      recipients.map(r =>
        notifyUser(r.id, {
          category: "system",
          title: "Common First Names list changed",
          body: message,
          deepLink: "/admin/match-settings",
          dedupeKey: `match:setting_change:${dedupeAnchor}:${r.id}`,
          metadata: notificationMetadata,
        }),
      ),
    );

    const recipientEmails = recipients
      .map(r => r.email)
      .filter((e): e is string => typeof e === "string" && e.length > 0);

    broadcastMatchSettingChange({
      scope: "zoom",
      scopeLabel: COMMON_FIRST_NAMES_SCOPE_LABEL,
      settingKey: COMMON_FIRST_NAMES_AUDIT_KEY,
      settingLabel: COMMON_FIRST_NAMES_SETTING_LABEL,
      oldValue: oldStr,
      newValue: newStr,
      action: params.action,
      actorName,
      recipientEmails,
    })
      .then(async (delivery) => {
        if (!params.historyId) return;
        try {
          await storage.updateAdminSettingAuditDelivery({
            id: params.historyId,
            slackStatus: delivery.slack.status,
            emailStatus: delivery.email.status,
            slackFailureReason:
              delivery.slack.status === "failed" ? delivery.slack.failureReason ?? null : null,
            emailFailureReason:
              delivery.email.status === "failed" ? delivery.email.failureReason ?? null : null,
          });
        } catch (updateErr) {
          console.warn(
            "[match-settings] failed to record common-first-names alert delivery status",
            updateErr,
          );
        }
      })
      .catch((err) => {
        console.warn(
          "[match-settings] common-first-names external alert fan-out failed",
          err,
        );
        if (params.historyId) {
          const reason = err?.message
            ? `Alert fan-out exception: ${String(err.message).slice(0, 180)}`
            : "Alert fan-out exception";
          storage
            .updateAdminSettingAuditDelivery({
              id: params.historyId,
              slackStatus: "failed",
              emailStatus: "failed",
              slackFailureReason: reason,
              emailFailureReason: reason,
            })
            .catch(() => undefined);
        }
      });
  } catch (err) {
    console.error("[match-settings] failed to send common-first-names change notifications", err);
  }
}

export async function notifyMatchSettingChange(params: {
  scope: AgentMatchSettingSource;
  key: AgentMatchSettingKey;
  oldValue: number | null;
  newValue: number | null;
  action: "updated" | "cleared";
  actorId: string | null;
  historyId: string | null;
}): Promise<void> {
  try {
    const descriptor = MATCH_SETTING_DESCRIPTORS[params.key];
    const allUsers = await storage.getAllUsers();
    const actor = params.actorId ? allUsers.find(u => u.id === params.actorId) ?? null : null;
    const recipients = allUsers.filter(u => u.role === "ceo" && u.id !== params.actorId);
    if (recipients.length === 0) {
      if (params.historyId) {
        try {
          await storage.updateAgentMatchSettingHistoryDelivery({
            id: params.historyId,
            slackStatus: "skipped",
            emailStatus: "skipped",
          });
        } catch (updateErr) {
          console.warn("[match-settings] failed to mark alert delivery as skipped", updateErr);
        }
      }
      return;
    }

    const actorName = formatActor(actor, params.actorId);
    const scopeLabel = SCOPE_LABEL[params.scope];
    const verb = params.action === "cleared" ? "cleared override for" : "changed";
    const oldStr = formatThresholdValue(params.oldValue);
    const newStr = formatThresholdValue(params.newValue);
    const message =
      `${actorName} ${verb} "${descriptor.label}" (${descriptor.key}) on ${scopeLabel}: ` +
      `${oldStr} → ${newStr}`;

    const notificationMetadata = {
      actorId: params.actorId ?? null,
      actorName: actor ? actorName : null,
      actorEmail: actor?.email ?? null,
    };

    // Task #1713 — Stage B: per-user inbox via notifyUser(). Dedupe by
    // (historyId, recipient) so a retry of the same setting change
    // collapses to a single inbox row per CEO.
    const { notifyUser } = await import("../services/notifications/userInbox");
    const dedupeAnchor =
      params.historyId ?? `${params.scope}:${descriptor.key}:${Date.now()}`;
    await Promise.all(
      recipients.map(r =>
        notifyUser(r.id, {
          category: "system",
          title: `Match setting changed: ${descriptor.label}`,
          body: message,
          deepLink: "/admin/match-settings",
          dedupeKey: `match:setting_change:${dedupeAnchor}:${r.id}`,
          metadata: notificationMetadata,
        }),
      ),
    );

    const recipientEmails = recipients
      .map(r => r.email)
      .filter((e): e is string => typeof e === "string" && e.length > 0);

    broadcastMatchSettingChange({
      scope: params.scope,
      scopeLabel,
      settingKey: descriptor.key,
      settingLabel: descriptor.label,
      oldValue: oldStr,
      newValue: newStr,
      action: params.action,
      actorName,
      recipientEmails,
    })
      .then(async (delivery) => {
        if (!params.historyId) return;
        try {
          await storage.updateAgentMatchSettingHistoryDelivery({
            id: params.historyId,
            slackStatus: delivery.slack.status,
            emailStatus: delivery.email.status,
            slackFailureReason:
              delivery.slack.status === "failed" ? delivery.slack.failureReason ?? null : null,
            emailFailureReason:
              delivery.email.status === "failed" ? delivery.email.failureReason ?? null : null,
          });
        } catch (updateErr) {
          console.warn("[match-settings] failed to record alert delivery status", updateErr);
        }
      })
      .catch(err => {
        console.warn("[match-settings] external alert fan-out failed", err);
        if (params.historyId) {
          const reason =
            err?.message ? `Alert fan-out exception: ${String(err.message).slice(0, 180)}`
            : "Alert fan-out exception";
          storage
            .updateAgentMatchSettingHistoryDelivery({
              id: params.historyId,
              slackStatus: "failed",
              emailStatus: "failed",
              slackFailureReason: reason,
              emailFailureReason: reason,
            })
            .catch(() => undefined);
        }
      });
  } catch (err) {
    console.error("[match-settings] failed to send change notifications", err);
  }
}

export function registerMatchSettingsRoutes(app: Express): void {
  app.get("/api/admin/match-settings", isAuthenticated, requireCeo, async (_req: any, res) => {
    try {
      const data = await listEffectiveMatchSettings();
      const persistedRows = await storage.listAgentMatchSettings();
      const persistedByKey = new Map<string, { updatedAt: Date | null; updatedBy: string | null }>();
      for (const r of persistedRows) {
        persistedByKey.set(`${r.source}::${r.settingKey}`, {
          updatedAt: r.updatedAt ?? null,
          updatedBy: r.updatedBy ?? null,
        });
      }
      const { resolveLastEditedUsers, buildLastEdited } = await import("./lastEditedHelper");
      const userMap = await resolveLastEditedUsers(
        Array.from(persistedByKey.values()).map(v => v.updatedBy),
      );
      const enrichedRows = data.rows.map(r => {
        const persisted = persistedByKey.get(`${r.scope}::${r.key}`);
        return {
          ...r,
          lastEdited: persisted
            ? buildLastEdited(persisted.updatedAt, persisted.updatedBy, userMap)
            : null,
        };
      });
      res.json({
        scopes: data.scopes,
        keys: data.keys,
        descriptors: MATCH_SETTING_KEYS.map(k => MATCH_SETTING_DESCRIPTORS[k]),
        rows: enrichedRows,
        envFallbackUsed: data.envFallbackUsed,
      });
    } catch (err: any) {
      console.error("[match-settings] list failed", err);
      res.status(500).json({ error: err?.message || "Failed to load match settings" });
    }
  });

  app.put("/api/admin/match-settings", isAuthenticated, requireCeo, async (req: any, res) => {
    try {
      const { source, key, value, restoreFromHistoryId } = req.body || {};
      if (typeof source !== "string" || !isAgentMatchSettingSource(source)) {
        return res.status(400).json({ error: `Invalid source. Allowed: ${MATCH_SETTING_SOURCES.join(", ")}` });
      }
      if (typeof key !== "string" || !isAgentMatchSettingKey(key)) {
        return res.status(400).json({ error: `Invalid setting key. Allowed: ${MATCH_SETTING_KEYS.join(", ")}` });
      }

      const userId = req.user?.claims?.sub ?? null;
      const acknowledgeWarnings = req.body?.acknowledgeWarnings === true;

      let restoreMeta: { restoreFromHistoryId: string; restoreFromChangedAt: Date | null } | null = null;
      if (restoreFromHistoryId !== undefined && restoreFromHistoryId !== null) {
        if (typeof restoreFromHistoryId !== "string" || restoreFromHistoryId.length === 0) {
          return res.status(400).json({ error: "restoreFromHistoryId must be a non-empty string." });
        }
        const sourceRow = await storage.getAgentMatchSettingHistoryById(restoreFromHistoryId);
        if (!sourceRow || sourceRow.source !== source || sourceRow.settingKey !== key) {
          return res.status(400).json({
            error: "restoreFromHistoryId does not refer to a known history entry for this scope/key.",
          });
        }
        restoreMeta = {
          restoreFromHistoryId,
          restoreFromChangedAt: sourceRow.changedAt
            ? sourceRow.changedAt instanceof Date
              ? sourceRow.changedAt
              : new Date(sourceRow.changedAt)
            : null,
        };
      }

      const descriptor = MATCH_SETTING_DESCRIPTORS[key];

      const isClear = value === null || value === undefined || value === "";
      const proposedValue: number | null = isClear
        ? null
        : (typeof value === "number" ? value : Number(value));
      if (!isClear && !Number.isFinite(proposedValue as number)) {
        return res.status(400).json({ error: "Value must be a finite number." });
      }

      const warnings = evaluateZoomGuardrailWarningsForProposedChange({
        source,
        key,
        value: proposedValue,
      });
      if (warnings.length > 0 && !acknowledgeWarnings) {
        return res.status(400).json({
          error: "This change would create a degenerate guardrail combination.",
          requiresAcknowledgement: true,
          warnings,
        });
      }

      if (isClear) {
        const result = await clearPersistedMatchSetting({
          source,
          key,
          updatedBy: userId,
          restoreFromHistoryId: restoreMeta?.restoreFromHistoryId ?? null,
          restoreFromChangedAt: restoreMeta?.restoreFromChangedAt ?? null,
        });
        if (result.previousValue !== null) {
          await notifyMatchSettingChange({
            scope: source,
            key,
            oldValue: result.previousValue,
            newValue: null,
            action: "cleared",
            actorId: userId,
            historyId: result.historyId,
          });
          try {
            await insertActivityLogs([{
              userId,
              actionType: "match_setting_updated",
              route: "/api/admin/match-settings",
              actionDetail: `Cleared ${SCOPE_LABEL[source]} override for "${descriptor.label}" (${key}): ${formatThresholdValue(result.previousValue)} → unset${restoreMeta ? ` (restored from ${restoreMeta.restoreFromChangedAt ? restoreMeta.restoreFromChangedAt.toISOString() : restoreMeta.restoreFromHistoryId})` : ""}`,
              metadata: {
                scope: source,
                settingKey: key,
                action: "cleared",
                oldValues: { [key]: result.previousValue },
                newValues: { [key]: null },
                restoreFromHistoryId: restoreMeta?.restoreFromHistoryId,
                restoreFromChangedAt: restoreMeta?.restoreFromChangedAt
                  ? restoreMeta.restoreFromChangedAt.toISOString()
                  : undefined,
              },
              sessionId: null,
              duration: null,
              timestamp: new Date(),
            }]);
          } catch (logErr: any) {
            console.error("[match-settings] audit log failed", logErr?.message);
          }
        }
        return res.json({ resolved: result.resolved, previousValue: result.previousValue, action: "cleared" });
      }

      const numeric = proposedValue as number;
      const ackSuffix = warnings.length > 0 ? ` [warnings acknowledged: ${warnings.map(w => w.code).join(", ")}]` : "";

      const result = await setPersistedMatchSetting({
        source,
        key,
        value: numeric,
        updatedBy: userId,
        restoreFromHistoryId: restoreMeta?.restoreFromHistoryId ?? null,
        restoreFromChangedAt: restoreMeta?.restoreFromChangedAt ?? null,
      });
      if (result.previousValue !== numeric) {
        await notifyMatchSettingChange({
          scope: source,
          key,
          oldValue: result.previousValue,
          newValue: numeric,
          action: "updated",
          actorId: userId,
          historyId: result.historyId,
        });
        try {
          await insertActivityLogs([{
            userId,
            actionType: "match_setting_updated",
            route: "/api/admin/match-settings",
            actionDetail: `Updated ${SCOPE_LABEL[source]} "${descriptor.label}" (${key}): ${formatThresholdValue(result.previousValue)} → ${formatThresholdValue(numeric)}${ackSuffix}${restoreMeta ? ` (restored from ${restoreMeta.restoreFromChangedAt ? restoreMeta.restoreFromChangedAt.toISOString() : restoreMeta.restoreFromHistoryId})` : ""}`,
            metadata: {
              scope: source,
              settingKey: key,
              action: "updated",
              oldValues: { [key]: result.previousValue },
              newValues: { [key]: numeric },
              acknowledgedWarnings: warnings.length > 0 ? warnings.map(w => ({ code: w.code, message: w.message })) : undefined,
              restoreFromHistoryId: restoreMeta?.restoreFromHistoryId,
              restoreFromChangedAt: restoreMeta?.restoreFromChangedAt
                ? restoreMeta.restoreFromChangedAt.toISOString()
                : undefined,
            },
            sessionId: null,
            duration: null,
            timestamp: new Date(),
          }]);
        } catch (logErr: any) {
          console.error("[match-settings] audit log failed", logErr?.message);
        }
      }
      res.json({ resolved: result.resolved, previousValue: result.previousValue, action: "updated", warnings });
    } catch (err: any) {
      const status = /out of bounds|finite/.test(err?.message || "") ? 400 : 500;
      console.error("[match-settings] update failed", err);
      res.status(status).json({ error: err?.message || "Failed to update setting" });
    }
  });

  app.get("/api/admin/match-settings/common-first-names", isAuthenticated, requireCeo, async (_req: any, res) => {
    try {
      const data = await getCommonFirstNamesConfig();
      const { ZOOM_COMMON_FIRST_NAMES_KEY } = await import("../services/zoomGuardrailConfig");
      const setting = await storage.getSystemSetting(ZOOM_COMMON_FIRST_NAMES_KEY);
      const { resolveLastEditedUsers, buildLastEdited } = await import("./lastEditedHelper");
      const userMap = await resolveLastEditedUsers([setting?.updatedBy]);
      res.json({
        ...data,
        lastEdited: setting
          ? buildLastEdited(setting.updatedAt, setting.updatedBy, userMap)
          : null,
      });
    } catch (err: any) {
      console.error("[match-settings] common-first-names list failed", err);
      res.status(500).json({ error: err?.message || "Failed to load common first names" });
    }
  });

  app.put("/api/admin/match-settings/common-first-names", isAuthenticated, requireCeo, async (req: any, res) => {
    try {
      const { names, restoreFromAuditId } = req.body || {};
      const userId = req.user?.claims?.sub ?? null;

      let restoreMeta:
        | { restoreFromAuditId: string; restoreFromChangedAt: string | null }
        | null = null;
      if (restoreFromAuditId !== undefined && restoreFromAuditId !== null) {
        if (typeof restoreFromAuditId !== "string" || restoreFromAuditId.length === 0) {
          return res.status(400).json({ error: "restoreFromAuditId must be a non-empty string." });
        }
        const sourceAudit = await storage.getAdminSettingAuditById(restoreFromAuditId);
        if (!sourceAudit || sourceAudit.settingKey !== COMMON_FIRST_NAMES_AUDIT_KEY) {
          return res.status(400).json({ error: "restoreFromAuditId does not refer to a known history entry." });
        }
        restoreMeta = {
          restoreFromAuditId,
          restoreFromChangedAt: sourceAudit.changedAt
            ? new Date(sourceAudit.changedAt).toISOString()
            : null,
        };
      }

      const before = await getCommonFirstNamesConfig();
      const summarize = (list: string[] | null | undefined): string => {
        if (!list || list.length === 0) return "(default)";
        return list.slice().sort().join(", ");
      };

      if (names === null || names === undefined) {
        await setCommonFirstNamesConfig({ names: null, updatedBy: userId });
        const data = await getCommonFirstNamesConfig();
        const oldList = before.override ?? [];
        let auditId: string | null = null;
        if (oldList.length > 0) {
          try {
            const auditRow = await storage.recordAdminSettingChange({
              settingKey: COMMON_FIRST_NAMES_AUDIT_KEY,
              scope: null,
              changedBy: userId,
              oldValues: {
                names: oldList.slice().sort(),
                count: oldList.length,
              },
              newValues: {
                names: [],
                count: 0,
                action: "reset_to_default",
                ...(restoreMeta ?? {}),
              },
            });
            auditId = auditRow?.id ?? null;
          } catch (auditErr: any) {
            console.error("[match-settings] common-first-names setting audit failed", auditErr?.message);
          }
          try {
            await insertActivityLogs([{
              userId,
              actionType: "zoom_common_first_names_updated",
              route: "/api/admin/match-settings/common-first-names",
              actionDetail: `Cleared Zoom common-first-names override (was ${oldList.length} names; reverted to defaults)`,
              metadata: {
                action: "cleared",
                oldCount: oldList.length,
                newCount: 0,
                oldValues: { commonFirstNames: summarize(oldList), count: oldList.length },
                newValues: { commonFirstNames: summarize(null), count: 0 },
              },
              sessionId: null,
              duration: null,
              timestamp: new Date(),
            }]);
          } catch (logErr: any) {
            console.error("[match-settings] common-first-names audit log failed", logErr?.message);
          }
          await notifyCommonFirstNamesChange({
            oldCount: oldList.length,
            newCount: 0,
            oldIsOverride: true,
            newIsOverride: false,
            action: "cleared",
            actorId: userId,
            historyId: auditId,
          });
        }
        return res.json({ action: "cleared", auditId, ...data });
      }

      if (!Array.isArray(names) || names.some(n => typeof n !== "string")) {
        return res.status(400).json({ error: "names must be an array of strings or null." });
      }

      await setCommonFirstNamesConfig({ names, updatedBy: userId });
      const data = await getCommonFirstNamesConfig();
      const oldList = before.override ?? [];
      const newList = data.override ?? [];
      const oldSummary = summarize(oldList);
      const newSummary = summarize(newList);
      let auditId: string | null = null;
      if (oldSummary !== newSummary) {
        const { added, removed } = diffNameLists(oldList, newList);
        try {
          const auditRow = await storage.recordAdminSettingChange({
            settingKey: COMMON_FIRST_NAMES_AUDIT_KEY,
            scope: null,
            changedBy: userId,
            oldValues: {
              names: oldList.slice().sort(),
              count: oldList.length,
            },
            newValues: {
              names: newList.slice().sort(),
              count: newList.length,
              added,
              removed,
              ...(restoreMeta ?? {}),
            },
          });
          auditId = auditRow?.id ?? null;
        } catch (auditErr: any) {
          console.error("[match-settings] common-first-names setting audit failed", auditErr?.message);
        }
        try {
          await insertActivityLogs([{
            userId,
            actionType: "zoom_common_first_names_updated",
            route: "/api/admin/match-settings/common-first-names",
            actionDetail: `Updated Zoom common-first-names override (${oldList.length} → ${newList.length} names)`,
            metadata: {
              action: "updated",
              oldCount: oldList.length,
              newCount: newList.length,
              oldValues: { commonFirstNames: oldSummary, count: oldList.length },
              newValues: { commonFirstNames: newSummary, count: newList.length },
            },
            sessionId: null,
            duration: null,
            timestamp: new Date(),
          }]);
        } catch (logErr: any) {
          console.error("[match-settings] common-first-names audit log failed", logErr?.message);
        }
        await notifyCommonFirstNamesChange({
          oldCount: oldList.length,
          newCount: newList.length,
          oldIsOverride: (before.override ?? null) !== null,
          newIsOverride: true,
          action: "updated",
          actorId: userId,
          historyId: auditId,
        });
      }
      res.json({ action: "updated", auditId, ...data });
    } catch (err: any) {
      console.error("[match-settings] common-first-names update failed", err);
      res.status(500).json({ error: err?.message || "Failed to update common first names" });
    }
  });

  app.get(
    "/api/admin/match-settings/common-first-names/history",
    isAuthenticated,
    requireCeo,
    async (req: any, res) => {
      try {
        const limit = Math.max(1, Math.min(Number(req.query.limit) || 25, 100));
        const entries = await storage.listAdminSettingAudit({
          settingKey: COMMON_FIRST_NAMES_AUDIT_KEY,
          limit,
        });

        const userIds = Array.from(
          new Set(
            entries
              .flatMap(e => [e.changedBy, e.lastResendBy])
              .filter((v): v is string => !!v),
          ),
        );
        const userMap = new Map<
          string,
          { firstName?: string | null; lastName?: string | null; email?: string | null }
        >();
        if (userIds.length > 0) {
          const users = await storage.getAllUsers();
          for (const u of users) {
            if (userIds.includes(u.id)) {
              userMap.set(u.id, { firstName: u.firstName, lastName: u.lastName, email: u.email });
            }
          }
        }

        res.json({
          rows: entries.map(e => ({
            ...e,
            changedByUser: e.changedBy ? userMap.get(e.changedBy) ?? null : null,
            lastResendByUser: e.lastResendBy ? userMap.get(e.lastResendBy) ?? null : null,
          })),
          channels: await matchSettingAlertChannelStatus(),
        });
      } catch (err: any) {
        console.error("[match-settings] common-first-names history failed", err);
        res.status(500).json({ error: err?.message || "Failed to load history" });
      }
    },
  );

  app.get("/api/admin/match-settings/impact", isAuthenticated, requireCeo, async (req: any, res) => {
    try {
      type ImpactScope = "default" | "zoom";
      type WindowStats = {
        total: number;
        claimed: number;
        reviewRequired: number;
        ambiguous: number;
        notClaimed: number;
        corrected: number;
        ambiguityRate: number | null;
        falsePositiveRate: number | null;
      };
      type KeyImpact = {
        settingKey: string;
        changedAt: string;
        windowMs: number;
        lastChange: { settingKey: string; oldValue: number | null; newValue: number | null };
        after: WindowStats;
        before: WindowStats;
      };
      type ScopeImpact =
        | { hasChange: false; perKey: KeyImpact[] }
        | {
            hasChange: true;
            changedAt: string;
            windowMs: number;
            windowMode: "since-change" | "custom";
            lastChange: { settingKey: string; oldValue: number | null; newValue: number | null };
            after: WindowStats;
            before: WindowStats;
            perKey: KeyImpact[];
          };

      const MIN_WINDOW_MS = 60 * 60 * 1000; // 1 hour
      const MAX_WINDOW_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
      const rawWindow = req.query.windowMs;
      let requestedWindowMs: number | null = null;
      if (rawWindow !== undefined && rawWindow !== "" && rawWindow !== null) {
        const parsed = Number(rawWindow);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          return res.status(400).json({ error: "windowMs must be a positive finite number." });
        }
        requestedWindowMs = Math.min(MAX_WINDOW_MS, Math.max(MIN_WINDOW_MS, Math.floor(parsed)));
      }

      const scopes: ImpactScope[] = ["default", "zoom"];
      const now = new Date();
      const out: Record<ImpactScope, ScopeImpact> = {
        default: { hasChange: false, perKey: [] },
        zoom: { hasChange: false, perKey: [] },
      };

      const rate = (num: number, den: number): number | null => (den > 0 ? num / den : null);

      const computeWindow = async (scope: ImpactScope, changedAt: Date): Promise<{ windowMs: number; after: WindowStats; before: WindowStats } | null> => {
        const sinceMs = now.getTime() - changedAt.getTime();
        if (sinceMs <= 0) return null;
        const windowMs = requestedWindowMs !== null ? Math.min(requestedWindowMs, sinceMs) : sinceMs;
        const afterStart = changedAt;
        const afterEnd = new Date(changedAt.getTime() + windowMs);
        const beforeStart = new Date(changedAt.getTime() - windowMs);
        const beforeEnd = changedAt;
        const sourceFilter = scope === "zoom" ? "zoom" : undefined;
        const [afterRaw, priorRaw] = await Promise.all([
          storage.getAgentMatchDecisionStatsInWindow({ sourceType: sourceFilter, since: afterStart, until: afterEnd }),
          storage.getAgentMatchDecisionStatsInWindow({ sourceType: sourceFilter, since: beforeStart, until: beforeEnd }),
        ]);
        return {
          windowMs,
          after: {
            ...afterRaw,
            ambiguityRate: rate(afterRaw.ambiguous + afterRaw.reviewRequired, afterRaw.total),
            falsePositiveRate: rate(afterRaw.corrected, afterRaw.claimed),
          },
          before: {
            ...priorRaw,
            ambiguityRate: rate(priorRaw.ambiguous + priorRaw.reviewRequired, priorRaw.total),
            falsePositiveRate: rate(priorRaw.corrected, priorRaw.claimed),
          },
        };
      };

      for (const scope of scopes) {
        const history = await storage.listAgentMatchSettingHistory({ source: scope, limit: 500 });
        if (history.length === 0) continue;

        const latestByKey = new Map<string, typeof history[number]>();
        for (const h of history) {
          if (!latestByKey.has(h.settingKey)) latestByKey.set(h.settingKey, h);
        }

        const perKey: KeyImpact[] = [];
        for (const [, h] of latestByKey) {
          if (!h.changedAt) continue;
          const changedAt = h.changedAt instanceof Date ? h.changedAt : new Date(h.changedAt);
          const win = await computeWindow(scope, changedAt);
          if (!win) continue;
          perKey.push({
            settingKey: h.settingKey,
            changedAt: changedAt.toISOString(),
            windowMs: win.windowMs,
            lastChange: { settingKey: h.settingKey, oldValue: h.oldValue, newValue: h.newValue },
            after: win.after,
            before: win.before,
          });
        }
        perKey.sort((a, b) => (a.changedAt < b.changedAt ? 1 : -1));

        const latest = history[0];
        if (latest && latest.changedAt) {
          const changedAt = latest.changedAt instanceof Date ? latest.changedAt : new Date(latest.changedAt);
          const win = await computeWindow(scope, changedAt);
          if (win) {
            out[scope] = {
              hasChange: true,
              changedAt: changedAt.toISOString(),
              windowMs: win.windowMs,
              windowMode: requestedWindowMs !== null ? "custom" : "since-change",
              lastChange: {
                settingKey: latest.settingKey,
                oldValue: latest.oldValue,
                newValue: latest.newValue,
              },
              after: win.after,
              before: win.before,
              perKey,
            };
            continue;
          }
        }
        out[scope] = { hasChange: false, perKey };
      }

      res.json({
        scopes: out,
        requestedWindowMs,
        bounds: { minWindowMs: MIN_WINDOW_MS, maxWindowMs: MAX_WINDOW_MS },
      });
    } catch (err: any) {
      console.error("[match-settings] impact failed", err);
      res.status(500).json({ error: err?.message || "Failed to load impact" });
    }
  });

  type RetryRowOutcome =
    | {
        status: "ok";
        body: {
          id: string;
          slackStatus: string | null;
          emailStatus: string | null;
          slackFailureReason: string | null;
          emailFailureReason: string | null;
          retried: { slack: boolean; email: boolean };
          resend: { triggeredBy: string | null; triggerSource: string; triggeredAt: number };
        };
      }
    | {
        status: "error";
        httpStatus: number;
        body: Record<string, unknown> & { error: string };
      };

  async function retryAlertsForHistoryRow(params: {
    rowId: string;
    triggerActorId: string | null;
    allUsers?: Awaited<ReturnType<typeof storage.getAllUsers>>;
  }): Promise<RetryRowOutcome> {
    const { rowId, triggerActorId } = params;
    if (!rowId) {
      return { status: "error", httpStatus: 400, body: { error: "Missing history id." } };
    }

    const row = await storage.getAgentMatchSettingHistoryById(rowId);
    if (!row) {
      return { status: "error", httpStatus: 404, body: { error: "History entry not found." } };
    }

    if (row.slackStatus !== "failed" && row.emailStatus !== "failed") {
      return {
        status: "error",
        httpStatus: 400,
        body: {
          error: "Only failed alerts can be retried.",
          slackStatus: row.slackStatus,
          emailStatus: row.emailStatus,
        },
      };
    }

    if (!isAgentMatchSettingSource(row.source) || !isAgentMatchSettingKey(row.settingKey)) {
      return {
        status: "error",
        httpStatus: 400,
        body: { error: "History entry references an unknown setting." },
      };
    }

    const descriptor = MATCH_SETTING_DESCRIPTORS[row.settingKey];
    const scopeLabel = SCOPE_LABEL[row.source];
    const action: "updated" | "cleared" = row.newValue === null ? "cleared" : "updated";

    const allUsers = params.allUsers ?? (await storage.getAllUsers());
    const actor = row.changedBy ? allUsers.find(u => u.id === row.changedBy) ?? null : null;
    const recipients = allUsers.filter(u => u.role === "ceo" && u.id !== row.changedBy);
    const recipientEmails = recipients
      .map(r => r.email)
      .filter((e): e is string => typeof e === "string" && e.length > 0);
    const actorName = formatActor(actor, row.changedBy);

    const retrySlack = row.slackStatus === "failed";
    const retryEmail = row.emailStatus === "failed";

    const destinations: string[] = [];
    if (retrySlack) destinations.push("slack");
    if (retryEmail) destinations.push("email");

    const guardOutcome = await attemptResend({
      alertType: "match_settings_change",
      alertId: row.id,
      destinations,
      actor: { userId: triggerActorId, source: "admin_ui" },
      execute: async () => {
        const delivery = await broadcastMatchSettingChange({
          scope: row.source as AgentMatchSettingSource,
          scopeLabel,
          settingKey: descriptor.key,
          settingLabel: descriptor.label,
          oldValue: formatThresholdValue(row.oldValue),
          newValue: formatThresholdValue(row.newValue),
          action,
          actorName,
          recipientEmails,
        });
        const channels = [];
        if (retrySlack) {
          channels.push({
            destination: "slack",
            status: delivery.slack.status === "delivered" ? "sent" as const
              : delivery.slack.status === "skipped" ? "skipped" as const
              : "failed" as const,
            failureReason: delivery.slack.failureReason ?? null,
          });
        }
        if (retryEmail) {
          channels.push({
            destination: "email",
            status: delivery.email.status === "delivered" ? "sent" as const
              : delivery.email.status === "skipped" ? "skipped" as const
              : "failed" as const,
            failureReason: delivery.email.failureReason ?? null,
          });
        }
        return { delivery, channels };
      },
    });

    if (guardOutcome.status === "cooldown") {
      return {
        status: "error",
        httpStatus: 429,
        body: {
          error: "Resend is cooling down. Please wait before retrying.",
          cooldownRemainingMs: guardOutcome.cooldownRemainingMs,
          lastAttemptAt: guardOutcome.lastAttemptAt,
          blockedDestinations: guardOutcome.blockedDestinations,
        },
      };
    }
    if (guardOutcome.status === "in_flight") {
      return {
        status: "error",
        httpStatus: 409,
        body: { error: "A resend for this alert is already in progress." },
      };
    }
    if (guardOutcome.status === "error") {
      return {
        status: "error",
        httpStatus: 502,
        body: { error: guardOutcome.error || "Broadcast failed" },
      };
    }

    const delivery = guardOutcome.result.delivery;
    const nextSlackStatus = retrySlack ? delivery.slack.status : row.slackStatus;
    const nextEmailStatus = retryEmail ? delivery.email.status : row.emailStatus;
    const nextSlackReason = retrySlack
      ? delivery.slack.status === "failed"
        ? delivery.slack.failureReason ?? null
        : null
      : row.slackFailureReason ?? null;
    const nextEmailReason = retryEmail
      ? delivery.email.status === "failed"
        ? delivery.email.failureReason ?? null
        : null
      : row.emailFailureReason ?? null;

    await storage.updateAgentMatchSettingHistoryDelivery({
      id: row.id,
      slackStatus: retrySlack ? delivery.slack.status : undefined,
      emailStatus: retryEmail ? delivery.email.status : undefined,
      slackFailureReason: retrySlack
        ? delivery.slack.status === "failed"
          ? delivery.slack.failureReason ?? null
          : null
        : undefined,
      emailFailureReason: retryEmail
        ? delivery.email.status === "failed"
          ? delivery.email.failureReason ?? null
          : null
        : undefined,
      lastResendAt: new Date(guardOutcome.executedAt),
      lastResendBy: triggerActorId,
      lastResendSource: "admin_ui",
      // Task #672 — a manual UI retry resets the per-channel auto-retry
      // budget so the background loop will pick the row up again if the
      // newly-attempted channel keeps failing. We also clear
      // `lastAutoRetryAt` so the row's next auto-retry isn't blocked by
      // the long backoff window from a prior auto-attempt.
      slackAttemptCount: retrySlack ? 0 : undefined,
      emailAttemptCount: retryEmail ? 0 : undefined,
      lastAutoRetryAt: retrySlack || retryEmail ? null : undefined,
    });

    return {
      status: "ok",
      body: {
        id: row.id,
        slackStatus: nextSlackStatus,
        emailStatus: nextEmailStatus,
        slackFailureReason: nextSlackReason,
        emailFailureReason: nextEmailReason,
        retried: { slack: retrySlack, email: retryEmail },
        resend: {
          triggeredBy: triggerActorId,
          triggerSource: "admin_ui",
          triggeredAt: guardOutcome.executedAt,
        },
      },
    };
  }

  app.post(
    "/api/admin/match-settings/history/:id/retry-alerts",
    isAuthenticated,
    requireCeo,
    async (req: any, res) => {
      try {
        const triggerActorId = req.user?.claims?.sub ?? null;
        const outcome = await retryAlertsForHistoryRow({
          rowId: String(req.params.id || ""),
          triggerActorId,
        });
        if (outcome.status === "error") {
          return res.status(outcome.httpStatus).json(outcome.body);
        }
        res.json(outcome.body);
      } catch (err: any) {
        console.error("[match-settings] retry alerts failed", err);
        res.status(500).json({ error: err?.message || "Failed to retry alerts" });
      }
    },
  );

  async function retryAlertsForCommonFirstNamesRow(params: {
    rowId: string;
    triggerActorId: string | null;
    allUsers?: Awaited<ReturnType<typeof storage.getAllUsers>>;
  }): Promise<RetryRowOutcome> {
    const { rowId, triggerActorId } = params;
    if (!rowId) {
      return { status: "error", httpStatus: 400, body: { error: "Missing history id." } };
    }

    const row = await storage.getAdminSettingAuditById(rowId);
    if (!row || row.settingKey !== COMMON_FIRST_NAMES_AUDIT_KEY) {
      return { status: "error", httpStatus: 404, body: { error: "History entry not found." } };
    }

    if (row.slackStatus !== "failed" && row.emailStatus !== "failed") {
      return {
        status: "error",
        httpStatus: 400,
        body: {
          error: "Only failed alerts can be retried.",
          slackStatus: row.slackStatus,
          emailStatus: row.emailStatus,
        },
      };
    }

    const oldValues = (row.oldValues ?? {}) as { count?: number };
    const newValues = (row.newValues ?? {}) as { count?: number; action?: string };
    const oldCount = typeof oldValues.count === "number" ? oldValues.count : 0;
    const newCount = typeof newValues.count === "number" ? newValues.count : 0;
    const action: "updated" | "cleared" =
      newValues.action === "reset_to_default" ? "cleared" : "updated";
    const oldIsOverride = oldCount > 0;
    const newIsOverride = action !== "cleared";

    const allUsers = params.allUsers ?? (await storage.getAllUsers());
    const actor = row.changedBy
      ? allUsers.find(u => u.id === row.changedBy) ?? null
      : null;
    const recipients = allUsers.filter(
      u => u.role === "ceo" && u.id !== row.changedBy,
    );
    const recipientEmails = recipients
      .map(r => r.email)
      .filter((e): e is string => typeof e === "string" && e.length > 0);
    const actorName = formatActor(actor, row.changedBy);

    const retrySlack = row.slackStatus === "failed";
    const retryEmail = row.emailStatus === "failed";
    const destinations: string[] = [];
    if (retrySlack) destinations.push("slack");
    if (retryEmail) destinations.push("email");

    const guardOutcome = await attemptResend({
      alertType: "match_settings_change",
      alertId: row.id,
      destinations,
      actor: { userId: triggerActorId, source: "admin_ui" },
      execute: async () => {
        const delivery = await broadcastMatchSettingChange(
          {
            scope: "zoom",
            scopeLabel: COMMON_FIRST_NAMES_SCOPE_LABEL,
            settingKey: COMMON_FIRST_NAMES_AUDIT_KEY,
            settingLabel: COMMON_FIRST_NAMES_SETTING_LABEL,
            oldValue: formatNameCount(oldCount, oldIsOverride),
            newValue: formatNameCount(newCount, newIsOverride),
            action,
            actorName,
            recipientEmails,
          },
          { channels: { slack: retrySlack, email: retryEmail } },
        );
        const channels = [];
        if (retrySlack) {
          channels.push({
            destination: "slack",
            status:
              delivery.slack.status === "delivered"
                ? ("sent" as const)
                : delivery.slack.status === "skipped"
                  ? ("skipped" as const)
                  : ("failed" as const),
            failureReason: delivery.slack.failureReason ?? null,
          });
        }
        if (retryEmail) {
          channels.push({
            destination: "email",
            status:
              delivery.email.status === "delivered"
                ? ("sent" as const)
                : delivery.email.status === "skipped"
                  ? ("skipped" as const)
                  : ("failed" as const),
            failureReason: delivery.email.failureReason ?? null,
          });
        }
        return { delivery, channels };
      },
    });

    if (guardOutcome.status === "cooldown") {
      return {
        status: "error",
        httpStatus: 429,
        body: {
          error: "Resend is cooling down. Please wait before retrying.",
          cooldownRemainingMs: guardOutcome.cooldownRemainingMs,
          lastAttemptAt: guardOutcome.lastAttemptAt,
          blockedDestinations: guardOutcome.blockedDestinations,
        },
      };
    }
    if (guardOutcome.status === "in_flight") {
      return {
        status: "error",
        httpStatus: 409,
        body: { error: "A resend for this alert is already in progress." },
      };
    }
    if (guardOutcome.status === "error") {
      return {
        status: "error",
        httpStatus: 502,
        body: { error: guardOutcome.error || "Broadcast failed" },
      };
    }

    const delivery = guardOutcome.result.delivery;
    const nextSlackStatus = retrySlack ? delivery.slack.status : row.slackStatus;
    const nextEmailStatus = retryEmail ? delivery.email.status : row.emailStatus;
    const nextSlackReason = retrySlack
      ? delivery.slack.status === "failed"
        ? delivery.slack.failureReason ?? null
        : null
      : row.slackFailureReason ?? null;
    const nextEmailReason = retryEmail
      ? delivery.email.status === "failed"
        ? delivery.email.failureReason ?? null
        : null
      : row.emailFailureReason ?? null;

    await storage.updateAdminSettingAuditDelivery({
      id: row.id,
      slackStatus: retrySlack ? delivery.slack.status : undefined,
      emailStatus: retryEmail ? delivery.email.status : undefined,
      slackFailureReason: retrySlack
        ? delivery.slack.status === "failed"
          ? delivery.slack.failureReason ?? null
          : null
        : undefined,
      emailFailureReason: retryEmail
        ? delivery.email.status === "failed"
          ? delivery.email.failureReason ?? null
          : null
        : undefined,
      lastResendAt: new Date(guardOutcome.executedAt),
      lastResendBy: triggerActorId,
      lastResendSource: "admin_ui",
    });

    return {
      status: "ok",
      body: {
        id: row.id,
        slackStatus: nextSlackStatus,
        emailStatus: nextEmailStatus,
        slackFailureReason: nextSlackReason,
        emailFailureReason: nextEmailReason,
        retried: { slack: retrySlack, email: retryEmail },
        resend: {
          triggeredBy: triggerActorId,
          triggerSource: "admin_ui",
          triggeredAt: guardOutcome.executedAt,
        },
      },
    };
  }

  app.post(
    "/api/admin/match-settings/common-first-names/history/:id/retry-alerts",
    isAuthenticated,
    requireCeo,
    async (req: any, res) => {
      try {
        const triggerActorId = req.user?.claims?.sub ?? null;
        const outcome = await retryAlertsForCommonFirstNamesRow({
          rowId: String(req.params.id || ""),
          triggerActorId,
        });
        if (outcome.status === "error") {
          return res.status(outcome.httpStatus).json(outcome.body);
        }
        res.json(outcome.body);
      } catch (err: any) {
        console.error(
          "[match-settings] common-first-names retry alerts failed",
          err,
        );
        res
          .status(500)
          .json({ error: err?.message || "Failed to retry alerts" });
      }
    },
  );

  app.post(
    "/api/admin/match-settings/common-first-names/history/retry-failed",
    isAuthenticated,
    requireCeo,
    async (req: any, res) => {
      try {
        const triggerActorId = req.user?.claims?.sub ?? null;
        const rawIds = Array.isArray(req.body?.ids) ? req.body.ids : null;
        if (!rawIds || rawIds.length === 0) {
          return res
            .status(400)
            .json({ error: "Provide an `ids` array of history row ids." });
        }
        const ids = Array.from(
          new Set(
            rawIds
              .map((v: unknown) => (typeof v === "string" ? v.trim() : ""))
              .filter((v: string) => v.length > 0),
          ),
        ) as string[];
        if (ids.length === 0) {
          return res
            .status(400)
            .json({ error: "Provide an `ids` array of history row ids." });
        }
        if (ids.length > 100) {
          return res
            .status(400)
            .json({ error: "Too many ids; retry up to 100 rows at a time." });
        }

        const allUsers = await storage.getAllUsers();

        const results = await Promise.all(
          ids.map(async (id) => {
            try {
              const outcome = await retryAlertsForCommonFirstNamesRow({
                rowId: id,
                triggerActorId,
                allUsers,
              });
              if (outcome.status === "ok") {
                const stillFailed =
                  outcome.body.slackStatus === "failed" ||
                  outcome.body.emailStatus === "failed";
                return {
                  id,
                  status: stillFailed ? ("failed" as const) : ("succeeded" as const),
                  result: outcome.body,
                };
              }
              return {
                id,
                status: "error" as const,
                httpStatus: outcome.httpStatus,
                error: outcome.body.error,
                detail: outcome.body,
              };
            } catch (err: any) {
              console.error(
                "[match-settings] common-first-names bulk retry row failed",
                id,
                err,
              );
              return {
                id,
                status: "error" as const,
                httpStatus: 500,
                error: err?.message || "Failed to retry alerts",
              };
            }
          }),
        );

        const succeededCount = results.filter(r => r.status === "succeeded").length;
        const failedCount = results.filter(r => r.status === "failed").length;
        const errorCount = results.filter(r => r.status === "error").length;

        res.json({
          requested: ids.length,
          succeededCount,
          failedCount,
          errorCount,
          results,
        });
      } catch (err: any) {
        console.error(
          "[match-settings] common-first-names bulk retry failed",
          err,
        );
        res
          .status(500)
          .json({ error: err?.message || "Failed to bulk retry alerts" });
      }
    },
  );

  app.post(
    "/api/admin/match-settings/history/retry-failed",
    isAuthenticated,
    requireCeo,
    async (req: any, res) => {
      try {
        const triggerActorId = req.user?.claims?.sub ?? null;
        const rawIds = Array.isArray(req.body?.ids) ? req.body.ids : null;
        if (!rawIds || rawIds.length === 0) {
          return res.status(400).json({ error: "Provide an `ids` array of history row ids." });
        }
        const ids = Array.from(
          new Set(
            rawIds
              .map((v: unknown) => (typeof v === "string" ? v.trim() : ""))
              .filter((v: string) => v.length > 0),
          ),
        ) as string[];
        if (ids.length === 0) {
          return res.status(400).json({ error: "Provide an `ids` array of history row ids." });
        }
        if (ids.length > 100) {
          return res.status(400).json({ error: "Too many ids; retry up to 100 rows at a time." });
        }

        const allUsers = await storage.getAllUsers();

        const results = await Promise.all(
          ids.map(async (id) => {
            try {
              const outcome = await retryAlertsForHistoryRow({
                rowId: id,
                triggerActorId,
                allUsers,
              });
              if (outcome.status === "ok") {
                const stillFailed =
                  outcome.body.slackStatus === "failed" || outcome.body.emailStatus === "failed";
                return {
                  id,
                  status: stillFailed ? ("failed" as const) : ("succeeded" as const),
                  result: outcome.body,
                };
              }
              return {
                id,
                status: "error" as const,
                httpStatus: outcome.httpStatus,
                error: outcome.body.error,
                detail: outcome.body,
              };
            } catch (err: any) {
              console.error("[match-settings] bulk retry row failed", id, err);
              return {
                id,
                status: "error" as const,
                httpStatus: 500,
                error: err?.message || "Failed to retry alerts",
              };
            }
          }),
        );

        const succeededCount = results.filter(r => r.status === "succeeded").length;
        const failedCount = results.filter(r => r.status === "failed").length;
        const errorCount = results.filter(r => r.status === "error").length;

        res.json({
          requested: ids.length,
          succeededCount,
          failedCount,
          errorCount,
          results,
        });
      } catch (err: any) {
        console.error("[match-settings] bulk retry failed", err);
        res.status(500).json({ error: err?.message || "Failed to bulk retry alerts" });
      }
    },
  );

  app.get("/api/admin/match-settings/history", isAuthenticated, requireCeo, async (req: any, res) => {
    try {
      const sourceParam = typeof req.query.source === "string" ? req.query.source : undefined;
      const keyParam = typeof req.query.key === "string" ? req.query.key : undefined;
      const limitParam = req.query.limit ? Math.min(500, Math.max(1, Number(req.query.limit) || 100)) : 100;

      if (sourceParam && !isAgentMatchSettingSource(sourceParam)) {
        return res.status(400).json({ error: "Invalid source filter." });
      }
      if (keyParam && !isAgentMatchSettingKey(keyParam)) {
        return res.status(400).json({ error: "Invalid key filter." });
      }

      const rows = await storage.listAgentMatchSettingHistory({
        source: sourceParam,
        settingKey: keyParam,
        limit: limitParam,
      });

      const userIds = Array.from(
        new Set(
          rows
            .flatMap(r => [r.changedBy, r.lastResendBy])
            .filter((v): v is string => !!v),
        ),
      );
      const userMap = new Map<string, { firstName?: string | null; lastName?: string | null; email?: string | null }>();
      if (userIds.length > 0) {
        const users = await storage.getAllUsers();
        for (const u of users) {
          if (userIds.includes(u.id)) {
            userMap.set(u.id, { firstName: u.firstName, lastName: u.lastName, email: u.email });
          }
        }
      }

      res.json({
        rows: rows.map(r => ({
          ...r,
          changedByUser: r.changedBy ? userMap.get(r.changedBy) ?? null : null,
          lastResendByUser: r.lastResendBy ? userMap.get(r.lastResendBy) ?? null : null,
        })),
        channels: await matchSettingAlertChannelStatus(),
        autoRetry: { maxAttempts: MATCH_SETTING_ALERT_MAX_AUTO_RETRIES },
      });
    } catch (err: any) {
      console.error("[match-settings] history failed", err);
      res.status(500).json({ error: err?.message || "Failed to load history" });
    }
  });
}
