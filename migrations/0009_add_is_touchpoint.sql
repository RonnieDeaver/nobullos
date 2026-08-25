ALTER TABLE raw_communication_records ADD COLUMN IF NOT EXISTS is_touchpoint boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS raw_comm_is_touchpoint_idx ON raw_communication_records (is_touchpoint);
CREATE INDEX IF NOT EXISTS raw_comm_client_touchpoint_idx ON raw_communication_records (client_id, is_touchpoint, timestamp);

UPDATE raw_communication_records rcr
SET is_touchpoint = true
FROM call_analysis_jobs caj
WHERE rcr.source_type = 'twilio_call'
  AND rcr.external_source_id = caj.external_id
  AND caj.status = 'complete'
  AND caj.result_json IS NOT NULL
  AND (caj.result_json->>'finalClassification') IN ('human', 'system_message_then_human');

UPDATE raw_communication_records
SET is_touchpoint = true
WHERE source_type = 'zoom'
  AND (
    source_subtype = 'zoom_transcript'
    OR (participants_json IS NOT NULL AND jsonb_array_length(participants_json) >= 2)
  );
