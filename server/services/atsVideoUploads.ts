// Task #3964 (audit A-006) — candidate-bound upload namespace for ATS portal
// video responses.
//
// The portal previously minted into the GENERIC `/objects/uploads/<uuid>`
// namespace shared by every presigned-upload flow, so any unclaimed object
// whose path a candidate learned (minted by any other flow) could be
// submitted as their "video response". Binding the namespace to the candidate
// closes that: mint places objects under `ats-<candidateId>/` (a single
// sanitize-safe key segment) and submit accepts ONLY that candidate's exact
// prefix — generic uploads, other candidates' objects, and multi-segment
// paths are all rejected before any storage probe.
//
// Pure string logic (no db/storage imports) so the DB-free constraint suite
// can pin the accept/reject table as a regression test.

/** ats_candidates.id is a lowercase pg UUID; refuse anything else outright. */
const ATS_CANDIDATE_ID_RE = /^[a-z0-9-]{1,36}$/;

/** Object key tail minted by getObjectEntityUploadURL: uuid + optional ext. */
const ATS_VIDEO_OBJECT_TAIL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * The mint-time `prefix` for this candidate's video uploads, or null when the
 * candidate id cannot form a safe single key segment. Callers must treat null
 * as an error — never fall back to the generic `uploads` namespace, or the
 * candidate binding silently disappears. "ats-" + a 36-char UUID is exactly
 * 40 chars, the cap sanitizeObjectKeyPrefix enforces on mint.
 */
export function atsCandidateVideoUploadPrefix(candidateId: string): string | null {
  if (typeof candidateId !== "string" || !ATS_CANDIDATE_ID_RE.test(candidateId)) {
    return null;
  }
  return `ats-${candidateId}`;
}

/**
 * True only for `/objects/ats-<candidateId>/<objectId>` — the exact shape the
 * portal mints for THIS candidate. Everything else (generic
 * `/objects/uploads/…`, another candidate's namespace, extra path segments,
 * traversal-ish tails) is rejected.
 */
export function isAtsCandidateVideoObjectPath(
  objectPath: unknown,
  candidateId: string,
): boolean {
  const prefix = atsCandidateVideoUploadPrefix(candidateId);
  if (!prefix || typeof objectPath !== "string") return false;
  const head = `/objects/${prefix}/`;
  if (!objectPath.startsWith(head)) return false;
  return ATS_VIDEO_OBJECT_TAIL_RE.test(objectPath.slice(head.length));
}
