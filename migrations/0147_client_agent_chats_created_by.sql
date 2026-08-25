-- Task #3721: internal tool-usage tracker — attribute agent chat messages
-- to the team member who sent them. The chat write route stamps the
-- authenticated user on new user-role rows; assistant rows and all
-- historical rows stay NULL (unattributed) and the usage tracker counts
-- them per client only. Idempotent per project convention.

ALTER TABLE client_agent_chats
  ADD COLUMN IF NOT EXISTS created_by_user_id varchar REFERENCES users(id);

CREATE INDEX IF NOT EXISTS client_agent_chats_created_by_idx
  ON client_agent_chats (created_by_user_id);
