/**
 * Central OpenAI model configuration.
 *
 * Every chat/text call in the app resolves its model from one of the two tiers
 * below so future model upgrades are a one-line change. The retired GPT-4 /
 * o-series family (`gpt-4o`, `gpt-4o-mini`, `gpt-4.1`, `gpt-4.1-mini`) has been
 * replaced by the current GPT-5 line.
 *
 * GPT-5 parameter notes (verified against OpenAI docs 2026-06-16):
 *  - The GPT-5 family does NOT accept `temperature` (or top_p / penalties) on
 *    chat.completions — only the default is allowed, so callers must omit it.
 *  - `max_tokens` is replaced by `max_completion_tokens`.
 *  - Reasoning tokens count against `max_completion_tokens`. `gpt-5.1` defaults
 *    to `reasoning_effort: "none"` (behaves like the old non-reasoning models),
 *    so the quality tier keeps its existing token budgets. The cheap tier
 *    (`gpt-5-mini`) is a reasoning model that defaults to medium effort, so it
 *    is pinned to `"minimal"` and given a generous completion budget to keep
 *    reasoning tokens from starving the visible output.
 */

/** Quality tier — analysis, scoring, enrichment, judgment, summaries. */
export const QUALITY_MODEL = "gpt-5.1";

/** Cheap/high-volume tier — classifiers, matching, formatters, calibration. */
export const CHEAP_MODEL = "gpt-5-mini";

/** Audio transcription model (unchanged, still current). */
export const TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";

/** Image generation model (unchanged, still current). */
export const IMAGE_MODEL = "gpt-image-1";

/**
 * Reasoning effort to use for a given model. The cheap reasoning model is
 * pinned to "minimal"; the quality model keeps its own default ("none") so we
 * return undefined and let the call omit the parameter.
 */
export function reasoningEffortFor(model: string): "minimal" | undefined {
  return model === CHEAP_MODEL ? "minimal" : undefined;
}
