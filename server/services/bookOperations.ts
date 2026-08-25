/**
 * Book Operations service — barrel re-export.
 *
 * Implements the local-DB-only bounded read-model surface for the book
 * commerce operations UI (server/routes/bookOperations.ts).
 *
 * Sub-modules:
 *   masking.ts    — pure privacy-masking helpers (exported for unit tests)
 *   types.ts      — shared TypeScript interfaces
 *   summary.ts    — getBookOperationsSummary
 *   records.ts    — listBookOperationRecords
 *   detail.ts     — getBookOperationRecord
 *   exceptions.ts — listBookOperationExceptions
 *   replay.ts     — replayBookOutboxEntry
 *
 * The five function exports below are the exact names imported by
 * server/routes/bookOperations.ts.  Do not rename or remove them.
 */

export { maskEmail, maskName, maskPhone } from "./bookOperations/masking";

export type {
  BookOperationsSummary,
  BookOperationsSummaryFunnelStage,
  BookOperationsSummaryConversionRate,
  BookOperationsSummarySlice,
  BookOperationsSummaryFinancials,
  BookOperationsSummaryMarginInputs,
  BookOperationListItem,
  BookOperationListResult,
  BookOperationDetail,
  BookOperationEntitlement,
  BookOperationEntitlementDeliveryAuditEntry,
  BookOperationPaymentEventRef,
  BookOperationLifecycleEntry,
  BookOperationProviderCorrelation,
  BookOperationOutboxState,
  BookOperationAttributionDelivery,
  BookOperationExceptionKind,
  BookOperationException,
  BookOperationExceptionsResult,
  ReplayBookOutboxEntryInput,
  ReplayBookOutboxEntryResult,
} from "./bookOperations/types";

export {
  OutboxReplayNotFoundError,
  OutboxReplayNotEligibleError,
} from "./bookOperations/replay";

export { getBookOperationsSummary }    from "./bookOperations/summary";
export { listBookOperationRecords }    from "./bookOperations/records";
export { getBookOperationRecord }      from "./bookOperations/detail";
export { listBookOperationExceptions } from "./bookOperations/exceptions";
export { replayBookOutboxEntry }       from "./bookOperations/replay";
