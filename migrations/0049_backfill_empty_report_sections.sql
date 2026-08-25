-- Task: backfill empty report_sections rows for the 4 canonical section keys
-- so the report editor never sees a "no row at all" state for an existing
-- report. Going forward, POST /api/reports seeds these rows at create time;
-- this migration patches every historical report that pre-dates that fix.
--
-- Idempotent: ON CONFLICT (report_id, section_key) DO NOTHING. Empty {} data
-- renders identically to a missing row in the editor (all defaults), but
-- gives the section-load + client-config seeding effects a stable foundation.
INSERT INTO report_sections (report_id, section_key, data, last_edited_by, last_edit_source, last_edit_at, updated_at)
SELECT r.id, k.section_key, '{}'::jsonb,
       'system:backfill_empty_sections', 'migration_seed', NOW(), NOW()
FROM reports r
CROSS JOIN (VALUES ('intake'),('sales'),('marketing'),('nextActions')) AS k(section_key)
LEFT JOIN report_sections rs ON rs.report_id = r.id AND rs.section_key = k.section_key
WHERE rs.id IS NULL
ON CONFLICT (report_id, section_key) DO NOTHING;
