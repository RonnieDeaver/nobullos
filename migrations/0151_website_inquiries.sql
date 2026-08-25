-- Task #3740: website_inquiries — stores contact + unsubscribe submissions
-- from the public marketing website (nobullmarketing.com). Written by the
-- rate-limited public endpoint POST /api/website/inquiry.
CREATE TABLE IF NOT EXISTS "website_inquiries" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  "kind" varchar(20) NOT NULL,
  "full_name" text,
  "email" text NOT NULL,
  "phone" text,
  "message" text,
  "source_page" text,
  "source_host" text,
  "user_agent" text,
  "status" varchar(20) NOT NULL DEFAULT 'new',
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_website_inquiries_created_at"
  ON "website_inquiries" ("created_at");
