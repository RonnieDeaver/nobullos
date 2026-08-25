// ClickUp admin — shared ClickUp API types.
// Extracted VERBATIM from the former 10.8k-line ClickUpModule.tsx monolith
// (house aggregator pattern, cf. Task #3787). The page composition root is
// client/src/pages/admin/ClickUpModule.tsx — its size is capped by
// scripts/lint-monolith-aggregator-size.ts, so new ClickUp feature code
// belongs here (or in a new sibling module), never in the aggregator.



// ─── Types ────────────────────────────────────────────────────────────────────

export type ClickUpStatus = {
  connected: boolean;
  user: { username: string; email: string; profilePicture: string | null } | null;
  workspaces: Array<{ id: string; name: string; color: string | null }>;
  error?: string;
};

export type Workspace = { id: string; name: string };
export type Space = {
  id: string;
  name: string;
  color?: string | null;
  archived?: boolean;
  features?: Record<string, any>;
};
export type Folder = { id: string; name: string; hidden?: boolean; archived?: boolean };
export type CUTemplate = { id: string; name: string; content?: string };

export type CUList = {
  id: string;
  name: string;
  task_count?: number;
  status?: { status: string };
  content?: string | null;
  priority?: { id: string; priority: string } | null;
  due_date?: string | null;
  assignee?: { username: string } | null;
};
export type Watcher = { id: number | string; username: string; profilePicture?: string | null; color?: string };
export type TaskDependency = { task_id: string; depends_on: string; type?: string };
export type LinkedTask = { task_id: string; link_id: string; task_id_b?: string };

export type CustomFieldOption = { id: string; name: string; color?: string; orderindex?: number };
export type CustomField = {
  id: string;
  name: string;
  type: string;
  type_config?: {
    options?: CustomFieldOption[];
    count?: number;
    precision?: number;
    currency_type?: string;
    default?: number;
  };
  value?: any;
  required?: boolean;
  hide_from_guests?: boolean;
  applied_objects?: Array<{ object_type: number; object_id: string }>;
};

export type Task = {
  id: string;
  name: string;
  status?: { status: string; color?: string; type?: string };
  priority?: { id: string; priority: string } | null;
  assignees?: Array<{ username: string; profilePicture?: string }>;
  due_date?: string | null;
  time_estimate?: number | null;
  time_spent?: number | null;
  description?: string | null;
  url?: string;
  tags?: Array<{ name: string; tag_fg?: string; tag_bg?: string }>;
  parent?: string | null;
  subtasks?: Task[];
  dependencies?: TaskDependency[];
  linked_tasks?: LinkedTask[];
  watchers?: Watcher[];
  space?: { id: string; name: string };
  custom_fields?: CustomField[];
  custom_item_id?: string | null;
  /** Home list — present on all tasks returned by ClickUp API */
  list?: { id: string; name: string; access?: boolean };
  /** Secondary-list memberships (Tasks in Multiple Lists / TIML ClickApp).
   *  ClickUp surfaces these when include_timl=true is added to the task fetch. */
  additional_lists?: Array<{ id: string; name: string }>;
};

export type SpaceTag = { name: string; tag_fg: string; tag_bg: string };
export type CommentBlock = {
  text: string;
  attributes?: {
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    strikethrough?: boolean;
    code?: boolean;
    link?: string;
    mention?: { user: { id: string | number; username: string } };
  };
};

export type Comment = {
  id: string;
  comment: CommentBlock[];
  comment_text: string;
  user: { id: string | number; username: string; profilePicture?: string | null };
  date: string;
  resolved: boolean;
  assignee?: { id: string | number; username: string } | null;
  reply_count?: number;
};

export type TimeEntryTag = { name: string; tag_fg?: string; tag_bg?: string };
export type TimeEntry = {
  id: string;
  description: string;
  duration: number;
  start: number;
  end: number;
  user: { id?: string; username: string };
  tags?: TimeEntryTag[];
  task?: { id: string; name: string } | null;
  task_location?: { list_id?: string; folder_id?: string; space_id?: string } | null;
};
export type TimeInStatusEntry = {
  status: string;
  color: string;
  type?: string;
  total_time: { by_minute: number; since: string };
};
export type PlanLimitedResponse = { plan_limited: true; message: string };
export type Attachment = {
  id: string;
  name: string;
  url: string;
  url_w_query?: string;
  mimetype: string;
  size: number;
  date: string;
  extension?: string;
  thumbnail_small?: string;
  thumbnail_medium?: string;
  thumbnail_large?: string;
};
export type GoalOwner = { id: number | string; username: string; profilePicture?: string | null; color?: string };
export type KeyResult = {
  id: string;
  goal_id?: string;
  name: string;
  type: "number" | "currency" | "boolean" | "percentage" | "automatic";
  steps_start?: number;
  steps_end?: number;
  steps_current?: number;
  unit?: string;
  percent_completed?: number;
  task_ids?: string[];
  note?: string;
  owners?: GoalOwner[];
};
export type Goal = {
  id: string;
  name: string;
  description?: string;
  percent_completed?: number;
  color?: string;
  due_date?: string | null;
  owners?: GoalOwner[];
  key_results?: KeyResult[];
  completed?: boolean;
  pretty_id?: string;
};
export type Doc = { id: string; name: string; date_created?: string; date_updated?: string };
export type SearchResult = { id: string; name: string; status?: { status: string }; list?: { name: string } };

