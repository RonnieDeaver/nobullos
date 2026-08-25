-- Task #3728: company roadmap with public embed.
-- Native roadmap module — THIS app's DB is the system of record (not ClickUp).
-- Departments and types are manageable value sets (admin CRUD), so they are
-- rows, not hard-coded enums; initiatives reference them by FK and the public
-- filter params key on their stable slugs (renaming keeps embeds working).
-- internal_notes is deliberately a separate column from public_description:
-- the public JSON must only ever expose public-facing fields of PUBLISHED
-- rows, and having a private field in the table lets tests prove the filter.

CREATE TABLE IF NOT EXISTS roadmap_departments (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug varchar(80) NOT NULL,
  display_order integer NOT NULL DEFAULT 0,
  created_at timestamp DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS roadmap_departments_slug_idx
  ON roadmap_departments (slug);

CREATE TABLE IF NOT EXISTS roadmap_types (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug varchar(80) NOT NULL,
  display_order integer NOT NULL DEFAULT 0,
  created_at timestamp DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS roadmap_types_slug_idx
  ON roadmap_types (slug);

-- status: planned | in_progress | shipped (shared/models/roadmap.ts owns the
-- canonical list; kept a varchar so adding a lane later is a data change).
CREATE TABLE IF NOT EXISTS roadmap_initiatives (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  public_description text NOT NULL DEFAULT '',
  internal_notes text,
  department_id varchar NOT NULL REFERENCES roadmap_departments(id),
  type_id varchar NOT NULL REFERENCES roadmap_types(id),
  status varchar(24) NOT NULL DEFAULT 'planned',
  timeframe varchar(80),
  display_order integer NOT NULL DEFAULT 0,
  published boolean NOT NULL DEFAULT false,
  created_at timestamp DEFAULT now(),
  updated_at timestamp DEFAULT now()
);

CREATE INDEX IF NOT EXISTS roadmap_initiatives_published_status_idx
  ON roadmap_initiatives (published, status);

CREATE INDEX IF NOT EXISTS roadmap_initiatives_department_idx
  ON roadmap_initiatives (department_id);

CREATE INDEX IF NOT EXISTS roadmap_initiatives_type_idx
  ON roadmap_initiatives (type_id);

-- Starter value sets so the module is usable on first open; these are data,
-- not code — admins can rename or delete them freely. Idempotent via slug.
INSERT INTO roadmap_departments (name, slug, display_order) VALUES
  ('Marketing', 'marketing', 10),
  ('Sales', 'sales', 20),
  ('Operations', 'operations', 30),
  ('Client Success', 'client-success', 40),
  ('Product & Engineering', 'product-engineering', 50)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO roadmap_types (name, slug, display_order) VALUES
  ('New Capability', 'new-capability', 10),
  ('Improvement', 'improvement', 20),
  ('Internal Tooling', 'internal-tooling', 30),
  ('Process', 'process', 40)
ON CONFLICT (slug) DO NOTHING;
