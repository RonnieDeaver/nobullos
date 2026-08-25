-- Task #848: Conversation Hub performance — indexed phone lookup + jsonb GIN.

-- 1. Normalized phone column on client_contacts (last-10-digits per phone).
ALTER TABLE client_contacts
  ADD COLUMN IF NOT EXISTS phones_normalized text[] DEFAULT '{}'::text[];

-- 2. Backfill phones_normalized from phones for any rows still empty.
UPDATE client_contacts
SET phones_normalized = COALESCE(
  (
    SELECT array_agg(stripped)
    FROM (
      SELECT RIGHT(REGEXP_REPLACE(p, '\D', '', 'g'), 10) AS stripped
      FROM unnest(phones) AS p
      WHERE REGEXP_REPLACE(p, '\D', '', 'g') <> ''
    ) s
    WHERE stripped <> ''
  ),
  ARRAY[]::text[]
)
WHERE phones IS NOT NULL
  AND (phones_normalized IS NULL OR cardinality(phones_normalized) = 0);

-- 3. GIN index for fast array containment lookups.
CREATE INDEX IF NOT EXISTS client_contacts_phones_normalized_idx
  ON client_contacts USING GIN (phones_normalized);

-- 4. GIN index on twilio_conversations.participants for jsonb @> lookups.
CREATE INDEX IF NOT EXISTS twilio_conv_participants_idx
  ON twilio_conversations USING GIN (participants jsonb_path_ops);
