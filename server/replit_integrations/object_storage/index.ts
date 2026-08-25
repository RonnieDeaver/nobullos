export {
  ObjectStorageService,
  ObjectNotFoundError,
  objectStorageClient,
  BACKUP_KEY_PREFIX,
} from "./objectStorage";

export type { BackupSourceObject } from "./objectStorage";

export type {
  ObjectAclPolicy,
  ObjectAccessGroup,
  ObjectAccessGroupType,
  ObjectAclRule,
} from "./objectAcl";

export {
  canAccessObject,
  getObjectAclPolicy,
  setObjectAclPolicy,
} from "./objectAcl";

export { registerObjectStorageRoutes } from "./routes";

// Task #3964 (audit A-006) — post-upload content verification for
// unconstrained presigned uploads.
export {
  evaluateUploadContent,
  sniffUploadFormat,
  verifyUploadObjectContent,
  UPLOAD_SNIFF_HEAD_BYTES,
} from "./uploadContentVerification";
export type {
  UploadKind,
  SniffedUploadFormat,
  UploadContentConstraints,
  UploadContentVerdict,
  UploadContentRejectionReason,
  UploadObjectReader,
  UploadContentVerifyingStorage,
} from "./uploadContentVerification";

