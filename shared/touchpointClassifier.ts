import type { CallClassification } from "./models/ceoTools";

const TOUCHPOINT_CALL_CLASSIFICATIONS: Set<string> = new Set(["human", "system_message_then_human"]);

export type TouchpointClassificationInput = {
  sourceType: string;
  callClassification?: CallClassification | string | null;
  hasTranscript?: boolean;
  participantCount?: number;
};

export function classifyTouchpoint(input: TouchpointClassificationInput): boolean {
  if (input.sourceType === "twilio_call") {
    if (!input.callClassification) return false;
    return TOUCHPOINT_CALL_CLASSIFICATIONS.has(input.callClassification);
  }

  if (input.sourceType === "zoom") {
    if (input.hasTranscript) return true;
    if (input.participantCount != null && input.participantCount >= 2) return true;
    return false;
  }

  return false;
}
