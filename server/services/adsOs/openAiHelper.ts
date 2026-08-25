/**
 * Ads OS — OpenAI structured-output helper.
 *
 * Implements the spec's structured-outputs conventions (§6, §9):
 *   - Strict JSON schema (response_format: json_schema, strict: true).
 *   - temperature=0 by default; omitted for reasoning models (send reasoning_effort).
 *   - Strip-and-retry on parameter-rejection 400 (a pure env swap from gpt-4o to a
 *     reasoning model requires no code change — the retry handles the param mismatch).
 *   - Hard checks on finish_reason=length (truncation), refusal, and parse failure.
 *
 * Key sources:
 *   - Source bundle keyword_intel/suggest.py _create (lines 10774-10851)
 *   - Source bundle pyramid/ai.py _create (lines 13766-13815)
 *   - Memory note: gpt5-param-compatibility (GPT-5 rejects temperature; use
 *     max_completion_tokens; reasoning models need reasoning_effort=minimal).
 *
 * Uses chat.completions.create with response_format json_schema (strict),
 * then JSON.parses the content. Compatible with all OpenAI models that support
 * Structured Outputs (gpt-4o and later).
 */

import { createOpenAiClient, type OpenAiClient } from "../ai/openAiClient";
import { getOpenAiKey, getOpenAiBaseUrl, getOpenAiModel, getOpenAiReasoningEffort,
         isOpenAiConfigured } from "./config";

export class AdsOsOpenAiNotConfigured extends Error {
  constructor() {
    super("OpenAI API key not configured. Set OPENAI_API_KEY or AI_INTEGRATIONS_OPENAI_API_KEY.");
    this.name = "AdsOsOpenAiNotConfigured";
  }
}

export class AdsOsOpenAiError extends Error {
  constructor(msg: string) { super(msg); this.name = "AdsOsOpenAiError"; }
}

function makeClient(): OpenAiClient {
  const apiKey = getOpenAiKey();
  const baseURL = getOpenAiBaseUrl();
  return createOpenAiClient({ apiKey, ...(baseURL ? { baseURL } : {}) });
}

type Message = { role: "system" | "user" | "assistant"; content: string };

/** Plain JSON Schema object (draft-07 compatible). */
export type JsonSchema = Record<string, unknown>;

interface StructuredCallOpts {
  /** Override model (defaults to getOpenAiModel()). */
  model?: string;
  /** Override reasoning effort (defaults to getOpenAiReasoningEffort()). */
  reasoningEffort?: string;
  /** max_completion_tokens — for reasoning models with large outputs. */
  maxCompletionTokens?: number;
}

/**
 * One OpenAI structured-outputs round-trip via response_format: json_schema strict.
 * Returns the JSON-parsed output as T (caller is responsible for runtime validation).
 *
 * Throws:
 *   AdsOsOpenAiNotConfigured — key missing
 *   AdsOsOpenAiError — truncation / refusal / parse failure / API error
 */
export async function adsOsStructuredCall<T = unknown>(
  schema: JsonSchema,
  schemaName: string,
  messages: Message[],
  opts?: StructuredCallOpts,
): Promise<T> {
  if (!isOpenAiConfigured()) throw new AdsOsOpenAiNotConfigured();

  const client = makeClient();
  const model = opts?.model ?? getOpenAiModel();
  const effort = (opts?.reasoningEffort ?? getOpenAiReasoningEffort()).trim();

  const buildKwargs = (): Record<string, any> => {
    const kw: Record<string, any> = {
      model,
      messages,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: schemaName,
          strict: true,
          schema,
        },
      },
    };
    if (effort) {
      kw.reasoning_effort = effort; // reasoning tiers reject temperature≠1
    } else {
      kw.temperature = 0;
    }
    if (opts?.maxCompletionTokens) {
      kw.max_completion_tokens = opts.maxCompletionTokens;
    }
    return kw;
  };

  // Strip-and-retry: if the model rejects temperature or reasoning_effort as an
  // unsupported parameter (a 400 with those words in the message), strip the
  // offending knob and retry once. This lets a pure env swap (e.g. pointing
  // OPENAI_MODEL at a reasoning model) work without any code change.
  async function callOnce(kwargs: Record<string, any>) {
    try {
      return await client.chat.completions.create(kwargs as any);
    } catch (err: any) {
      const msg = String(err?.message ?? "").toLowerCase();
      let retried = false;
      const next = { ...kwargs };
      if (msg.includes("temperature") && "temperature" in next) {
        delete next.temperature; retried = true;
      }
      if (msg.includes("reasoning_effort") && "reasoning_effort" in next) {
        delete next.reasoning_effort; retried = true;
      }
      if (!retried) throw err;
      return await client.chat.completions.create(next as any);
    }
  }

  let completion: any;
  try {
    completion = await callOnce(buildKwargs());
  } catch (err: any) {
    throw new AdsOsOpenAiError(`OpenAI call failed: ${err?.message ?? err}`);
  }

  const choice = completion?.choices?.[0];
  if (!choice) throw new AdsOsOpenAiError("OpenAI returned no choices.");
  if (choice.finish_reason === "length") {
    throw new AdsOsOpenAiError(
      "OpenAI response was truncated (finish_reason=length). Reduce input or raise max_completion_tokens."
    );
  }
  const message = choice.message;
  if (message?.refusal) {
    throw new AdsOsOpenAiError(`OpenAI refused the request: ${message.refusal}`);
  }

  const content = message?.content;
  if (!content) {
    throw new AdsOsOpenAiError("OpenAI returned an empty message content.");
  }

  let parsed: T;
  try {
    parsed = JSON.parse(content) as T;
  } catch {
    throw new AdsOsOpenAiError(`OpenAI returned invalid JSON: ${String(content).slice(0, 200)}`);
  }

  return parsed;
}
