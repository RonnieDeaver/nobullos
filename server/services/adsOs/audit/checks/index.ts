/**
 * Check registry (port of audit/checks/__init__.py).
 *
 * Each check is an isolated function `run(ctx) -> CheckResult`. Adding a check =
 * add a module + register it here + add its config entry in checksConfig.ts.
 * No core changes.
 */

import type { CheckResult } from "../models";
import type { AuditContext } from "../context";
import { ads01, ads02, ads05, ads07 } from "./ads";
import { ast01, ast02, ast03, ast04, ast05, ast06 } from "./ast";
import { bid01, bid02, bid03, bid04, bid05 } from "./bid";
import { geo01, geo02, geo04 } from "./geo";
import { kws01, kws02, kws03, kws06, kws08 } from "./kws";
import { opt01 } from "./opt";
import { str01 } from "./str";

export type CheckFn = (ctx: AuditContext) => CheckResult;

// All active check functions, grouped by category for readability.
// Removed per team review: GEO-03, KWS-04/05/07, BID-06/07, ADS-03/04/06, AST-08,
// STR-02/03/04/05, OPT-02/03, and the whole POL category (POL-01/03/04/05 — now
// handled by the Account Alerts engine; POL-02/06/07 were never exposed).
export const ALL_CHECKS: Array<[string, CheckFn]> = [
  // GEO
  ["GEO-01", geo01],
  ["GEO-02", geo02],
  ["GEO-04", geo04],
  // KWS
  ["KWS-01", kws01],
  ["KWS-02", kws02],
  ["KWS-03", kws03],
  ["KWS-06", kws06],
  ["KWS-08", kws08],
  // BID
  ["BID-01", bid01],
  ["BID-02", bid02],
  ["BID-03", bid03],
  ["BID-04", bid04],
  ["BID-05", bid05],
  // ADS
  ["ADS-01", ads01],
  ["ADS-02", ads02],
  ["ADS-05", ads05],
  ["ADS-07", ads07],
  // AST
  ["AST-01", ast01],
  ["AST-02", ast02],
  ["AST-03", ast03],
  ["AST-04", ast04],
  ["AST-05", ast05],
  ["AST-06", ast06],
  // OPT
  ["OPT-01", opt01],
  // STR
  ["STR-01", str01],
];
