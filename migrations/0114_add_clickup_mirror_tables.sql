-- Task #2927 ClickUp in-app module — local mirror tables.
-- These pgTables shipped in shared/models/clickup.ts without a migration file,
-- so drizzle-kit push prompted create-vs-rename in the non-interactive
-- post-merge run and timed it out. Fully idempotent; safe to re-apply.

CREATE TABLE IF NOT EXISTS clickup_user_tokens (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id varchar NOT NULL UNIQUE,
  access_token_encrypted text NOT NULL,
  clickup_user_id varchar,
  clickup_username varchar,
  clickup_email varchar,
  workspace_id varchar,
  status varchar NOT NULL DEFAULT 'connected',
  last_refresh_at timestamp,
  last_error text,
  connected_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS clickup_user_tokens_user_id_idx ON clickup_user_tokens (user_id);

CREATE TABLE IF NOT EXISTS clickup_workspaces (
  id varchar PRIMARY KEY,
  name text NOT NULL,
  color varchar,
  avatar text,
  members jsonb,
  plan varchar,
  synced_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS clickup_spaces (
  id varchar PRIMARY KEY,
  workspace_id varchar NOT NULL,
  name text NOT NULL,
  color varchar,
  private boolean DEFAULT false,
  statuses jsonb,
  features jsonb,
  archived boolean DEFAULT false,
  synced_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS clickup_spaces_workspace_idx ON clickup_spaces (workspace_id);

CREATE TABLE IF NOT EXISTS clickup_folders (
  id varchar PRIMARY KEY,
  space_id varchar NOT NULL,
  name text NOT NULL,
  order_index double precision,
  override_statuses boolean,
  hidden boolean DEFAULT false,
  archived boolean DEFAULT false,
  synced_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS clickup_folders_space_idx ON clickup_folders (space_id);

CREATE TABLE IF NOT EXISTS clickup_lists (
  id varchar PRIMARY KEY,
  folder_id varchar,
  space_id varchar NOT NULL,
  name text NOT NULL,
  order_index double precision,
  content text,
  status varchar,
  priority integer,
  assignee jsonb,
  task_count integer,
  due_date varchar,
  start_date varchar,
  space jsonb,
  archived boolean DEFAULT false,
  override_statuses boolean,
  statuses jsonb,
  permission_level varchar,
  synced_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS clickup_lists_space_idx ON clickup_lists (space_id);
CREATE INDEX IF NOT EXISTS clickup_lists_folder_idx ON clickup_lists (folder_id);

CREATE TABLE IF NOT EXISTS clickup_custom_fields (
  id varchar PRIMARY KEY,
  list_id varchar NOT NULL,
  name text NOT NULL,
  type varchar NOT NULL,
  type_config jsonb,
  date_created varchar,
  hide_from_guests boolean DEFAULT false,
  required boolean DEFAULT false,
  synced_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS clickup_custom_fields_list_idx ON clickup_custom_fields (list_id);

CREATE TABLE IF NOT EXISTS clickup_tasks (
  id varchar PRIMARY KEY,
  list_id varchar NOT NULL,
  folder_id varchar,
  space_id varchar,
  workspace_id varchar,
  parent_id varchar,
  name text NOT NULL,
  description text,
  status varchar,
  status_color varchar,
  status_type varchar,
  order_index double precision,
  date_created varchar,
  date_updated varchar,
  date_done varchar,
  due_date varchar,
  start_date varchar,
  priority integer,
  priority_name varchar,
  time_estimate integer,
  time_spent integer,
  creator jsonb,
  assignees jsonb,
  watchers jsonb,
  tags jsonb,
  custom_fields jsonb,
  custom_type varchar,
  url text,
  archived boolean DEFAULT false,
  synced_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS clickup_tasks_list_idx ON clickup_tasks (list_id);
CREATE INDEX IF NOT EXISTS clickup_tasks_space_idx ON clickup_tasks (space_id);
CREATE INDEX IF NOT EXISTS clickup_tasks_parent_idx ON clickup_tasks (parent_id);
CREATE INDEX IF NOT EXISTS clickup_tasks_workspace_idx ON clickup_tasks (workspace_id);
CREATE INDEX IF NOT EXISTS clickup_tasks_date_updated_idx ON clickup_tasks (date_updated);

CREATE TABLE IF NOT EXISTS clickup_checklists (
  id varchar PRIMARY KEY,
  task_id varchar NOT NULL,
  name text NOT NULL,
  order_index integer,
  resolved integer DEFAULT 0,
  unresolved integer DEFAULT 0,
  items jsonb,
  synced_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS clickup_checklists_task_idx ON clickup_checklists (task_id);

CREATE TABLE IF NOT EXISTS clickup_comments (
  id varchar PRIMARY KEY,
  task_id varchar,
  list_id varchar,
  parent_comment_id varchar,
  comment jsonb,
  comment_text text,
  "user" jsonb,
  assignee jsonb,
  assigned_by jsonb,
  resolved boolean DEFAULT false,
  date varchar,
  synced_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS clickup_comments_task_idx ON clickup_comments (task_id);
CREATE INDEX IF NOT EXISTS clickup_comments_list_idx ON clickup_comments (list_id);

CREATE TABLE IF NOT EXISTS clickup_time_entries (
  id varchar PRIMARY KEY,
  workspace_id varchar NOT NULL,
  task_id varchar,
  user_id varchar,
  "user" jsonb,
  billable boolean DEFAULT false,
  start varchar,
  "end" varchar,
  duration integer,
  description text,
  tags jsonb,
  at varchar,
  is_running boolean DEFAULT false,
  synced_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS clickup_time_entries_workspace_idx ON clickup_time_entries (workspace_id);
CREATE INDEX IF NOT EXISTS clickup_time_entries_task_idx ON clickup_time_entries (task_id);
CREATE INDEX IF NOT EXISTS clickup_time_entries_user_idx ON clickup_time_entries (user_id);

CREATE TABLE IF NOT EXISTS clickup_goals (
  id varchar PRIMARY KEY,
  workspace_id varchar NOT NULL,
  name text NOT NULL,
  due_date varchar,
  description text,
  multiple_owners boolean DEFAULT false,
  owners jsonb,
  color varchar,
  date_created varchar,
  start_date varchar,
  key_results jsonb,
  full_name text,
  percent_completed double precision,
  completed boolean DEFAULT false,
  created_by jsonb,
  pretty_id varchar,
  synced_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS clickup_goals_workspace_idx ON clickup_goals (workspace_id);

CREATE TABLE IF NOT EXISTS clickup_docs (
  id varchar PRIMARY KEY,
  workspace_id varchar NOT NULL,
  parent_id varchar,
  title text,
  visibility varchar,
  creator integer,
  date_created varchar,
  date_updated varchar,
  parent jsonb,
  type integer,
  synced_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS clickup_docs_workspace_idx ON clickup_docs (workspace_id);

CREATE TABLE IF NOT EXISTS clickup_webhooks (
  id varchar PRIMARY KEY,
  workspace_id varchar NOT NULL,
  user_id varchar NOT NULL,
  endpoint text NOT NULL,
  client_id varchar,
  secret_encrypted text,
  events jsonb,
  location_id varchar,
  health jsonb,
  status varchar NOT NULL DEFAULT 'active',
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS clickup_webhooks_workspace_idx ON clickup_webhooks (workspace_id);
CREATE INDEX IF NOT EXISTS clickup_webhooks_user_idx ON clickup_webhooks (user_id);
