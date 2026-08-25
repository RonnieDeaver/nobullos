export type PipelineEvent =
  | "event_received"
  | "duplicate_ignored"
  | "normalized"
  | "ready_to_apply"
  | "applied"
  | "no_op"
  | "failed"
  | "replayed"
  | "reconciled";

interface PipelineLogPayload {
  event: PipelineEvent;
  sourceSystem: string;
  sourceEventType: string;
  dedupeKey?: string;
  sourceEventId?: string;
  correlationId?: string;
  durationMs?: number;
  outcome?: string;
  errorCode?: string;
  errorMessage?: string;
  [key: string]: unknown;
}

export function pipelineLog(payload: PipelineLogPayload): void {
  const { event, sourceSystem, sourceEventType, errorMessage, ...rest } = payload;
  const ts = new Date().toISOString();
  const cleanRest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rest)) {
    if (v !== undefined) cleanRest[k] = v;
  }
  const extra = Object.keys(cleanRest).length > 0
    ? " " + JSON.stringify(cleanRest)
    : "";

  // Task #2100 — duplicate_ignored / no_op are benign, high-volume
  // steady-state pipeline outcomes (a webhook redelivery or an event
  // with nothing to apply). Logging them at warn floods production and
  // trips "[Error]"-style alerting. Only a genuine pipeline failure is
  // an error; everything benign is info.
  const level = event === "failed" ? "error"
    : "info";

  const msg = `[Pipeline] ${ts} ${event} source=${sourceSystem} type=${sourceEventType}${errorMessage ? ` error="${errorMessage}"` : ""}${extra}`;

  if (level === "error") {
    console.error(msg);
  } else {
    console.log(msg);
  }
}
