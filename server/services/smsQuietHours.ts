/**
 * Task #4336 — recipient-local quiet-hours evaluation for automated SMS.
 *
 * TCPA safe-harbor practice: automated/marketing texts only between 8am and
 * 9pm in the RECIPIENT's local time (several states are stricter; the window
 * is configurable via the send-gate settings, defaults below).
 *
 * Timezone resolution policy (conservative by construction):
 *   1. Explicit per-number IANA override on the consent ledger row, when set.
 *   2. NANP area-code → IANA map below. Area codes whose territory
 *      meaningfully spans two zones list BOTH candidates.
 *   3. Unmapped/non-geographic (toll-free callers, international, malformed):
 *      the CONSERVATIVE_FALLBACK_TIMEZONES set — all four continental US
 *      zones. A send is allowed only when the window holds in EVERY candidate
 *      zone, so unknown numbers get the intersection (~11am–9pm ET), never a
 *      guess. (Alaska/Hawaii are not in the fallback: their area codes 907 /
 *      808 are mapped explicitly, so only a truly non-geographic number could
 *      belong to a resident there — an accepted edge documented in TWILIO.md.)
 *
 * The map records the DOMINANT zone(s) per area code. Sliver exceptions with
 * tiny populations (e.g. the Mountain-time corner of Kansas 785) are ignored
 * deliberately — a per-number ledger override exists for exactly those cases.
 */

const ET = "America/New_York";
const CT = "America/Chicago";
const MT = "America/Denver";
const AZ = "America/Phoenix"; // no DST
const PT = "America/Los_Angeles";
const AK = "America/Anchorage";
const HI = "Pacific/Honolulu";
const AT = "America/Halifax";
const NT = "America/St_Johns";
const SK = "America/Regina"; // Saskatchewan — no DST
const PR = "America/Puerto_Rico";

export const DEFAULT_SEND_WINDOW_START_HOUR_LOCAL = 8;
export const DEFAULT_SEND_WINDOW_END_HOUR_LOCAL = 21;

export const CONSERVATIVE_FALLBACK_TIMEZONES: readonly string[] = [ET, CT, MT, PT];

// [zone or candidate zones, area codes]
const AREA_CODE_GROUPS: Array<[string | string[], number[]]> = [
  // ── Eastern ──
  [ET, [203, 475, 860, 959]], // CT
  [ET, [202, 771]], // DC
  [ET, [302]], // DE
  [ET, [239, 305, 321, 352, 386, 407, 561, 656, 689, 727, 754, 772, 786, 813, 863, 904, 941, 954]], // FL
  [[ET, CT], [850, 448]], // FL panhandle (Tallahassee ET / Pensacola CT)
  [ET, [229, 404, 470, 478, 678, 706, 762, 770, 912, 943]], // GA
  [ET, [260, 317, 463, 574, 765, 930]], // IN (Eastern-observing)
  [CT, [219]], // IN — NW Indiana (Chicago metro)
  [[ET, CT], [812]], // IN — southern (Evansville CT pocket)
  [ET, [502, 606, 859]], // KY (eastern)
  [CT, [270, 364]], // KY (western)
  [ET, [339, 351, 413, 508, 617, 774, 781, 857, 978]], // MA
  [ET, [240, 301, 410, 443, 667]], // MD
  [ET, [207]], // ME
  [ET, [231, 248, 269, 313, 517, 586, 616, 734, 810, 947, 989]], // MI
  [[ET, CT], [906]], // MI — Upper Peninsula
  [ET, [252, 336, 704, 743, 828, 910, 919, 980, 984]], // NC
  [ET, [603]], // NH
  [ET, [201, 551, 609, 640, 732, 848, 856, 862, 908, 973]], // NJ
  [ET, [212, 315, 332, 347, 516, 518, 585, 607, 631, 646, 680, 716, 718, 838, 845, 914, 917, 929, 934]], // NY
  [ET, [216, 220, 234, 326, 330, 380, 419, 440, 513, 567, 614, 740, 937]], // OH
  [ET, [215, 223, 267, 272, 412, 445, 484, 570, 610, 717, 724, 814, 878]], // PA
  [ET, [401]], // RI
  [ET, [803, 839, 843, 854, 864]], // SC
  [ET, [423, 865]], // TN (east)
  [ET, [276, 434, 540, 571, 703, 757, 804]], // VA
  [ET, [802]], // VT
  [ET, [304, 681]], // WV
  // ── Central ──
  [CT, [205, 251, 256, 334, 659, 938]], // AL
  [CT, [479, 501, 870]], // AR
  [CT, [319, 515, 563, 641, 712]], // IA
  [CT, [217, 224, 309, 312, 331, 447, 618, 630, 708, 773, 779, 815, 847, 872]], // IL
  [CT, [316, 620, 785, 913]], // KS
  [CT, [225, 318, 337, 504, 985]], // LA
  [CT, [218, 320, 507, 612, 651, 763, 952]], // MN
  [CT, [314, 417, 573, 636, 660, 816]], // MO
  [CT, [228, 601, 662, 769]], // MS
  [[CT, MT], [701]], // ND
  [CT, [402, 531]], // NE (east)
  [[CT, MT], [308]], // NE (west)
  [CT, [405, 539, 580, 918]], // OK
  [[CT, MT], [605]], // SD
  [CT, [615, 629, 731, 901, 931]], // TN (middle/west)
  [CT, [210, 214, 254, 281, 325, 346, 361, 409, 430, 432, 469, 512, 682, 713, 726, 737, 806, 817, 830, 832, 903, 936, 940, 956, 972, 979]], // TX
  [MT, [915]], // TX — El Paso
  [CT, [262, 414, 534, 608, 715, 920]], // WI
  // ── Mountain ──
  [MT, [303, 719, 720, 970]], // CO
  [[MT, PT], [208, 986]], // ID (north ID is Pacific)
  [MT, [406]], // MT
  [MT, [505, 575]], // NM
  [MT, [307]], // WY
  [MT, [385, 435, 801]], // UT
  [AZ, [480, 520, 602, 623, 928]], // AZ (no DST)
  // ── Pacific ──
  [PT, [209, 213, 279, 310, 323, 341, 408, 415, 424, 442, 510, 530, 559, 562, 619, 626, 628, 650, 657, 661, 669, 707, 714, 747, 760, 805, 818, 820, 831, 840, 858, 909, 916, 925, 949, 951]], // CA
  [PT, [702, 725, 775]], // NV
  [PT, [458, 503, 541, 971]], // OR
  [PT, [206, 253, 360, 425, 509, 564]], // WA
  // ── Alaska / Hawaii ──
  [AK, [907]],
  [HI, [808]],
  // ── Canada ──
  [ET, [226, 249, 289, 343, 365, 416, 437, 519, 613, 647, 705, 905]], // ON
  [[ET, CT], [807]], // ON — northwest
  [ET, [367, 418, 438, 450, 514, 579, 581, 819, 873]], // QC
  [AT, [506, 782, 902]], // NB / NS / PEI
  [NT, [709]], // NL
  [CT, [204, 431]], // MB
  [SK, [306, 639]], // SK (no DST)
  [MT, [403, 587, 780, 825]], // AB
  [PT, [236, 250, 604, 672, 778]], // BC
  // ── Caribbean (US) ──
  [PR, [787, 939]], // Puerto Rico
];

const AREA_CODE_TIMEZONES: ReadonlyMap<string, readonly string[]> = (() => {
  const map = new Map<string, readonly string[]>();
  for (const [zones, codes] of AREA_CODE_GROUPS) {
    const list = Array.isArray(zones) ? zones : [zones];
    for (const code of codes) {
      map.set(String(code), list);
    }
  }
  return map;
})();

export function isValidIanaTimezone(tz: string): boolean {
  if (!tz || typeof tz !== "string") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export type TimezoneResolutionSource = "override" | "area_code" | "conservative_fallback";

export interface ResolvedTimezones {
  timezones: readonly string[];
  source: TimezoneResolutionSource;
  areaCode: string | null;
}

/**
 * Resolve the candidate IANA zones for a phone number. `overrideTimezone`
 * (the ledger row's optional column) wins when valid; otherwise the NANP
 * area code decides; otherwise the conservative fallback set.
 */
export function resolveCandidateTimezones(
  phoneE164: string,
  overrideTimezone?: string | null,
): ResolvedTimezones {
  const digits = (phoneE164 ?? "").replace(/\D/g, "");
  const national = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  const areaCode = national.length === 10 ? national.slice(0, 3) : null;

  if (overrideTimezone && isValidIanaTimezone(overrideTimezone)) {
    return { timezones: [overrideTimezone], source: "override", areaCode };
  }
  if (areaCode !== null) {
    const mapped = AREA_CODE_TIMEZONES.get(areaCode);
    if (mapped !== undefined) {
      return { timezones: mapped, source: "area_code", areaCode };
    }
  }
  return {
    timezones: CONSERVATIVE_FALLBACK_TIMEZONES,
    source: "conservative_fallback",
    areaCode,
  };
}

/** 0–23 local hour of `now` in `timeZone`. */
export function getLocalHour(now: Date, timeZone: string): number {
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    hour: "2-digit",
  }).format(now);
  // Some ICU builds render midnight as "24" under hour12:false.
  return Number(formatted) % 24;
}

export interface QuietHoursEvaluation {
  withinSendWindow: boolean;
  timezones: readonly string[];
  timezoneSource: TimezoneResolutionSource;
  /** tz → local hour at evaluation time (for audit detail / tests). */
  localHours: Record<string, number>;
  /** Zones (if any) whose local time fell outside the allowed window. */
  blockedZones: string[];
}

/**
 * A send is allowed only when the local hour is inside
 * [startHourLocal, endHourLocal) in EVERY candidate zone. `start === end`
 * means an empty window (always quiet — safe default for a misconfigured
 * pair); `start > end` is an overnight window (supported for completeness).
 */
export function evaluateQuietHours(params: {
  now: Date;
  phoneE164: string;
  overrideTimezone?: string | null;
  startHourLocal: number;
  endHourLocal: number;
}): QuietHoursEvaluation {
  const { now, phoneE164, overrideTimezone, startHourLocal, endHourLocal } = params;
  const resolved = resolveCandidateTimezones(phoneE164, overrideTimezone);
  const localHours: Record<string, number> = {};
  const blockedZones: string[] = [];
  for (const tz of resolved.timezones) {
    const hour = getLocalHour(now, tz);
    localHours[tz] = hour;
    const inWindow =
      startHourLocal < endHourLocal
        ? hour >= startHourLocal && hour < endHourLocal
        : startHourLocal > endHourLocal
          ? hour >= startHourLocal || hour < endHourLocal
          : false; // start === end — empty window, always quiet
    if (!inWindow) blockedZones.push(tz);
  }
  return {
    withinSendWindow: blockedZones.length === 0,
    timezones: resolved.timezones,
    timezoneSource: resolved.source,
    localHours,
    blockedZones,
  };
}
