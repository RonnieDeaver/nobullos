-- Task 552: Normalize legacy historical-backfill explanation summaries to use
-- the new "[backfill]" prefix introduced by task #477. Rows written by the
-- task #451 backfill before the prefix existed start with
-- "Backfill: historical Zoom reprocess ..."; rewriting them lets us drop the
-- legacy substring fallback in zoomReviewQueue.ts and the client UI so future
-- callers only have to match a single tag.
UPDATE agent_match_decisions
SET explanation_summary = '[backfill]' || substring(explanation_summary FROM length('Backfill:') + 1)
WHERE source_type = 'zoom'
  AND explanation_summary LIKE 'Backfill: historical Zoom reprocess%';
