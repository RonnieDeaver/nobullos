export const SEMRUSH_SYNC_POLL_INTERVAL_MS = 8000;
export const SEMRUSH_SYNC_MAX_POLLS = 120;

// Radix UI's <Select.Item> throws at render time when value="" (the empty
// string is reserved for "clear the selection and show the placeholder"), and
// because items render into a hidden tree even while the dropdown is closed,
// a single empty-string item crashes the whole page through the error
// boundary. Pages that keep "" in component state as the "no selection"
// sentinel must render their None/Clear option with this value instead and
// map "" <-> SELECT_NONE_VALUE at the <Select value/onValueChange> boundary,
// so save paths (`state || null`) keep working unchanged.
// Guarded by tests/select-item-empty-value-guard.test.ts.
export const SELECT_NONE_VALUE = "__none__";
