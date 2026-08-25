import { isCompanyEmail, isCompanyDomain, extractDomain } from "./companyIdentity";
import { getMatchSettingValue } from "./matchSettings";

export type MatchSource = "zoom" | "front_email" | "twilio_sms" | "slack" | "default";

export type SourcePolicy = {
  source: MatchSource;
  filterInternalParticipantSeeds: boolean;
  routeSoloInternalToReview: boolean;
  routeWeakSignalToReview: boolean;
  routeContactNameOnlyToReview: boolean;
};

const DEFAULT_POLICY: SourcePolicy = {
  source: "default",
  filterInternalParticipantSeeds: false,
  routeSoloInternalToReview: false,
  routeWeakSignalToReview: false,
  routeContactNameOnlyToReview: false,
};

const ZOOM_POLICY: SourcePolicy = {
  source: "zoom",
  filterInternalParticipantSeeds: true,
  routeSoloInternalToReview: true,
  routeWeakSignalToReview: true,
  routeContactNameOnlyToReview: true,
};

export function getSourcePolicy(source?: MatchSource | string | null): SourcePolicy {
  if (source === "zoom") return ZOOM_POLICY;
  return DEFAULT_POLICY;
}

function shortTokenMaxLen(): number {
  return Math.floor(getMatchSettingValue("ZOOM_SHORT_TOKEN_MAX_LEN", "zoom"));
}

const DEFAULT_COMMON_FIRST_NAMES: ReadonlySet<string> = new Set([
  "aaron", "abby", "abigail", "adam", "adrian", "alan", "alex", "alexa", "alexander",
  "alexis", "alice", "alicia", "allen", "allison", "alyssa", "amanda", "amber", "amy",
  "andrea", "andrew", "andy", "angela", "anna", "anne", "anthony", "april", "arthur",
  "ashley", "audrey", "austin", "ava", "barbara", "becca", "becky", "ben", "benjamin",
  "beth", "bethany", "betty", "beverly", "bill", "billy", "bob", "bobby", "brad",
  "bradley", "brandon", "brenda", "brett", "brian", "bridget", "brittany", "brooke",
  "bruce", "bryan", "caleb", "cameron", "carl", "carla", "carlos", "carol", "caroline",
  "carrie", "casey", "catherine", "cathy", "chad", "charles", "charlie", "charlotte",
  "chase", "chelsea", "cheryl", "chris", "christian", "christina", "christine",
  "christopher", "cindy", "claire", "clara", "clark", "claudia", "cody", "colin",
  "colleen", "connor", "courtney", "craig", "crystal", "curtis", "cynthia", "dale",
  "dan", "dana", "daniel", "danielle", "danny", "darrell", "darren", "dave", "david",
  "dawn", "dean", "deb", "debbie", "deborah", "debra", "denise", "dennis", "derek",
  "diana", "diane", "dominic", "don", "donald", "donna", "doug", "douglas", "drew",
  "dustin", "dylan", "ed", "eddie", "edgar", "edward", "edwin", "elaine", "eli",
  "elijah", "elizabeth", "ellen", "emily", "emma", "eric", "erica", "erik", "erin",
  "ethan", "eugene", "evan", "eve", "evelyn", "felix", "fiona", "frances", "francis",
  "frank", "fred", "gabe", "gabriel", "gail", "gary", "gavin", "gene", "george",
  "gerald", "gina", "glen", "glenn", "gloria", "grace", "grant", "greg", "gregory",
  "hailey", "hannah", "harold", "harry", "heather", "helen", "henry", "holly",
  "howard", "hunter", "ian", "irene", "isaac", "isabella", "ivan", "jack", "jackie",
  "jackson", "jacob", "jaime", "jake", "james", "jamie", "jane", "janet", "janice",
  "jared", "jason", "jay", "jean", "jeff", "jeffrey", "jen", "jenna", "jennifer",
  "jeremy", "jerry", "jesse", "jessica", "jill", "jim", "jimmy", "joan", "joann",
  "joanne", "jodi", "joe", "joel", "john", "johnny", "jon", "jonathan", "jordan",
  "jose", "joseph", "josh", "joshua", "joy", "joyce", "juan", "judith", "judy",
  "julia", "julian", "julie", "june", "justin", "kaitlyn", "karen", "karl", "kate",
  "katherine", "kathleen", "kathryn", "kathy", "katie", "kayla", "keith", "kelly",
  "kelsey", "ken", "kenneth", "kerry", "kevin", "kim", "kimberly", "kris", "kristen",
  "kristin", "kristina", "kyle", "lance", "larry", "laura", "lauren", "laurie",
  "lawrence", "lee", "leo", "leon", "leonard", "leslie", "liam", "linda", "lindsay",
  "lindsey", "lisa", "liz", "logan", "lori", "louis", "lucas", "lucy", "luis", "luke",
  "lynn", "madison", "marc", "marcus", "margaret", "maria", "marie", "marilyn",
  "mario", "marissa", "mark", "marsha", "martha", "martin", "marty", "marvin", "mary",
  "mason", "matt", "matthew", "max", "maya", "meg", "megan", "melanie", "melinda",
  "melissa", "michael", "michele", "michelle", "mike", "miranda", "mitchell", "molly",
  "monica", "morgan", "nancy", "naomi", "natalie", "nate", "nathan", "neil", "nicholas",
  "nick", "nicole", "noah", "nora", "norman", "olivia", "oscar", "owen", "pam",
  "pamela", "pat", "patricia", "patrick", "paul", "paula", "pauline", "peggy", "peter",
  "phil", "philip", "phillip", "phyllis", "rachel", "ralph", "randy", "ray", "raymond",
  "rebecca", "regina", "renee", "rich", "richard", "rick", "rickey", "ricky", "riley",
  "rita", "rob", "robert", "roberta", "robin", "rodney", "roger", "ron", "ronald",
  "ronnie", "rosa", "rose", "rosemary", "roy", "russell", "ruth", "ryan", "sally",
  "sam", "samantha", "samuel", "sandra", "sandy", "sara", "sarah", "scott", "sean",
  "sebastian", "shane", "shannon", "sharon", "shawn", "sheila", "shelby", "sheri",
  "sherri", "sherry", "shirley", "sophia", "sophie", "stacey", "stacy", "stanley",
  "stella", "stephanie", "stephen", "steve", "steven", "stewart", "stuart", "sue",
  "susan", "suzanne", "sylvia", "tammy", "tanya", "tara", "taylor", "ted", "teresa",
  "terry", "thomas", "tiffany", "tim", "timothy", "tina", "todd", "tom", "tommy",
  "tony", "tracey", "tracy", "travis", "trevor", "tyler", "valerie", "vanessa",
  "veronica", "vicki", "vickie", "vicky", "victor", "victoria", "vincent", "virginia",
  "walt", "walter", "wanda", "warren", "wayne", "wendy", "wesley", "william", "willie",
  "yolanda", "zach", "zachary",
]);

let commonFirstNamesOverride: ReadonlySet<string> | null = null;

export function setCommonFirstNamesOverride(names: readonly string[] | null): void {
  if (!names || names.length === 0) {
    commonFirstNamesOverride = null;
    return;
  }
  const cleaned = names
    .map(n => (n || "").toLowerCase().trim())
    .filter(n => n.length > 0);
  commonFirstNamesOverride = cleaned.length > 0 ? new Set(cleaned) : null;
}

export function getEffectiveCommonFirstNames(): ReadonlySet<string> {
  return commonFirstNamesOverride ?? DEFAULT_COMMON_FIRST_NAMES;
}

export function getDefaultCommonFirstNames(): ReadonlySet<string> {
  return DEFAULT_COMMON_FIRST_NAMES;
}

export function isCommonFirstName(token: string): boolean {
  if (!token) return false;
  return getEffectiveCommonFirstNames().has(token.toLowerCase().trim());
}

export function isShortToken(token: string): boolean {
  return !token || token.trim().length <= shortTokenMaxLen();
}

export function isWeakContactNameToken(token: string): boolean {
  if (!token) return true;
  const t = token.toLowerCase().trim();
  if (t.length <= shortTokenMaxLen()) return true;
  if (isCommonFirstName(t)) return true;
  return false;
}

export function isWeakContactNameValue(value: string): boolean {
  if (!value) return true;
  const tokens = value.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  return tokens.every(t => isWeakContactNameToken(t));
}

export function isInternalParticipantEmail(email?: string | null): boolean {
  if (!email) return false;
  if (isCompanyEmail(email)) return true;
  const domain = extractDomain(email);
  return !!domain && isCompanyDomain(domain);
}

export function hasOnlyInternalParticipants(participantEmails: readonly string[]): boolean {
  if (!participantEmails || participantEmails.length === 0) return true;
  return participantEmails.every(e => isInternalParticipantEmail(e));
}

export function filterParticipantSeedsForPolicy(
  policy: SourcePolicy,
  participantEmails: readonly string[],
): { seedEmails: string[]; droppedInternal: string[] } {
  if (!policy.filterInternalParticipantSeeds) {
    return { seedEmails: [...participantEmails], droppedInternal: [] };
  }
  const seedEmails: string[] = [];
  const droppedInternal: string[] = [];
  for (const e of participantEmails) {
    if (isInternalParticipantEmail(e)) {
      droppedInternal.push(e);
    } else {
      seedEmails.push(e);
    }
  }
  return { seedEmails, droppedInternal };
}
