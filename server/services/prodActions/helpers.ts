/**
 * Prod-action definition helpers (F7, Task #4154): the kill-switch and
 * system-setting action factories, relocated verbatim from
 * server/services/prodActionsRegistry.ts and exported so domain modules can
 * keep building their entries exactly as before.
 */

import { storage } from "../../storage";
import {
  setPoolEpicSwitch,
  isPoolEpicSwitchEnabled,
  ensurePoolEpicSwitchesLoaded,
  type PoolEpicSwitchName,
} from "../poolEpicKillSwitches";
import { type ProdAction } from "./kernel";


// ─── Action helpers ──────────────────────────────────────────────────

export function killSwitchAction(args: {
  id: string;
  switchName: PoolEpicSwitchName;
  targetValue: boolean;
  title: string;
  description: string;
  /**
   * Task #4762 — override for the default drain declaration. Kill-switch
   * flips default to a human gate (enabling/disabling a subsystem is a
   * policy decision an operator makes deliberately, exactly once — never
   * auto-fired); pass a more specific reason when the generic wording
   * undersells the stakes.
   */
  humanGate?: { reason: string };
}): ProdAction {
  const target = args.targetValue;
  const changeStr = `Set ${args.switchName} = ${target ? "true" : "false"}`;
  return {
    id: args.id,
    title: args.title,
    description: args.description,
    change: changeStr,
    // Kill-switch flips are write-through one-shots: once the switch holds
    // the target value the action stays not-needed forever.
    convergence: { kind: "converging" },
    humanGate: args.humanGate ?? {
      reason:
        `Deliberate operator switch-flip: turning ${args.switchName} ${target ? "on" : "off"} changes live subsystem behavior — a policy decision made once, by a human, never auto-fired.`,
    },
    async status() {
      await ensurePoolEpicSwitchesLoaded();
      const current = isPoolEpicSwitchEnabled(args.switchName);
      if (current === target) {
        return { state: "not-needed", detail: `Already ${current ? "enabled" : "disabled"}.` };
      }
      return {
        state: "pending",
        detail: `Currently ${current ? "enabled" : "disabled"}; will flip to ${target ? "enabled" : "disabled"}.`,
      };
    },
    async apply(actorId) {
      await ensurePoolEpicSwitchesLoaded();
      const current = isPoolEpicSwitchEnabled(args.switchName);
      if (current === target) {
        return { state: "not-needed", detail: `Already ${current ? "enabled" : "disabled"}.` };
      }
      await setPoolEpicSwitch(args.switchName, target, actorId ?? undefined);
      return {
        state: "applied",
        detail: `Flipped ${args.switchName} → ${target ? "true" : "false"}.`,
      };
    },
  };
}


export function systemSettingAction(args: {
  id: string;
  key: string;
  targetValue: string;
  title: string;
  description: string;
  /**
   * Ramp-up semantics. When true, the target is treated as a numeric
   * FLOOR rather than an exact value: the action reports `not-needed`
   * whenever the current value is already >= the target. This keeps
   * lower rungs of a ramp ladder one-and-done — once a higher rung (or
   * the force-ramp) has overshot the target, the lower rung must NOT
   * perpetually report `pending` and must NEVER downgrade the live
   * value back to its (smaller) target on "Apply all".
   */
  satisfiedWhenAtLeast?: boolean;
  /**
   * Task #4762 — override for the default drain declaration. Setting
   * flips and ramp rungs default to a human gate (retuning a live
   * production value is a deliberate operator decision); pass a more
   * specific reason when the generic wording undersells the stakes.
   */
  humanGate?: { reason: string };
}): ProdAction {
  const floorMode = args.satisfiedWhenAtLeast === true;
  const isSatisfied = (current: string | null): boolean => {
    if (current === args.targetValue) return true;
    if (!floorMode) return false;
    const cur = Number(current);
    const target = Number(args.targetValue);
    return Number.isFinite(cur) && Number.isFinite(target) && cur >= target;
  };
  return {
    id: args.id,
    title: args.title,
    description: args.description,
    change: floorMode
      ? `Set ${args.key} >= ${args.targetValue} (no-op if already at or above ${args.targetValue})`
      : `Set ${args.key} = ${args.targetValue}`,
    // Setting flips (including ramp floors) settle permanently once the
    // stored value satisfies the target.
    convergence: { kind: "converging" },
    humanGate: args.humanGate ?? {
      reason: floorMode
        ? `Deliberate operator ramp step: raising ${args.key} to ${args.targetValue} changes live concurrency/pressure — each rung is a human judgment call on observed headroom, never auto-fired.`
        : `Deliberate operator setting change: ${args.key} → ${args.targetValue} retunes live production behavior — a policy decision made once, by a human, never auto-fired.`,
    },
    async status() {
      const row = await storage.getSystemSetting(args.key);
      const current = row?.value ?? null;
      if (isSatisfied(current)) {
        return {
          state: "not-needed",
          detail: floorMode
            ? `Already at ${current ?? "<unset>"} (>= target ${args.targetValue}).`
            : `Already set to ${args.targetValue}.`,
        };
      }
      return {
        state: "pending",
        detail: `Currently ${current ?? "<unset>"}; will set to ${args.targetValue}.`,
      };
    },
    async apply(actorId) {
      const row = await storage.getSystemSetting(args.key);
      const current = row?.value ?? null;
      if (isSatisfied(current)) {
        return {
          state: "not-needed",
          detail: floorMode
            ? `Already at ${current ?? "<unset>"} (>= target ${args.targetValue}).`
            : `Already set to ${args.targetValue}.`,
        };
      }
      await storage.setSystemSetting(args.key, args.targetValue, actorId ?? undefined);
      return {
        state: "applied",
        detail: `Set ${args.key} = ${args.targetValue} (was ${current ?? "<unset>"}).`,
      };
    },
  };
}
