import { sql } from "drizzle-orm";
import { db } from "../db";

/**
 * Status of a single DB-level guard the booking system depends on.
 * `installed` means the constraint is present in pg_constraint after
 * the bootstrap step ran. `error` carries the underlying message when
 * we couldn't install or verify it (typically because the migration
 * has not yet been applied OR the deployment environment forbids the
 * required extension/DDL).
 */
export interface BookingDbConstraintStatus {
  scheduledMeetingsNoOverlap: { installed: boolean; error?: string };
  bookingPagesAccountManagerUnique: { installed: boolean; error?: string };
  btreeGistExtension: { installed: boolean; error?: string };
  /**
   * Convenience aggregate: true iff every required guard is `installed`.
   * `/api/admin/booking/health` exposes this so an admin sees a single
   * green/red signal, and the boot sequence logs a loud warning when
   * this is false (so a failed bootstrap can't slip past silently).
   */
  ready: boolean;
}

/**
 * Module-level cache of the most recent bootstrap result. The admin
 * health endpoint reads this so it can surface installation failures
 * without re-running the (possibly expensive) DDL check on every poll.
 */
let lastConstraintStatus: BookingDbConstraintStatus = {
  scheduledMeetingsNoOverlap: {
    installed: false,
    error: "Bootstrap has not run yet",
  },
  bookingPagesAccountManagerUnique: {
    installed: false,
    error: "Bootstrap has not run yet",
  },
  btreeGistExtension: {
    installed: false,
    error: "Bootstrap has not run yet",
  },
  ready: false,
};

/**
 * Returns the most recent bootstrap result without re-running it. Used
 * by `/api/admin/booking/health` to expose constraint status to ops.
 */
export function getBookingDbConstraintStatus(): BookingDbConstraintStatus {
  return lastConstraintStatus;
}

/**
 * Idempotent post-migration step that installs DB-level guards which Drizzle's
 * push pipeline can't express directly:
 *
 *   1. `btree_gist` extension — required for the EXCLUDE constraint below.
 *   2. `scheduled_meetings_no_overlap` EXCLUDE constraint — guarantees that
 *      no two ACTIVE (creating | confirmed) scheduled meetings for the same
 *      account manager can ever overlap, even if the application-level
 *      advisory lock + recompute path were to race or be bypassed. The
 *      `[)` interval semantics make a meeting that *ends* exactly when the
 *      next one starts non-overlapping, matching the booking saga's logic.
 *   3. `booking_pages_account_manager_user_id_unique` UNIQUE — exactly one
 *      booking page per AM. Spec invariant.
 *
 * Called once at server boot. Safe to re-run — both statements are wrapped
 * in IF NOT EXISTS / DO NOTHING checks so they no-op on subsequent boots.
 *
 * Returns a `BookingDbConstraintStatus` describing which guards are now
 * present. `/api/admin/booking/health` surfaces this so a failed install
 * (e.g. `btree_gist` blocked by hosting policy) is visible to ops rather
 * than silently leaving us with only the application-level advisory lock.
 */
export async function ensureBookingDbConstraints(): Promise<BookingDbConstraintStatus> {
  const status: BookingDbConstraintStatus = {
    scheduledMeetingsNoOverlap: { installed: false },
    bookingPagesAccountManagerUnique: { installed: false },
    btreeGistExtension: { installed: false },
    ready: false,
  };

  try {
    await db.execute(sql`CREATE EXTENSION IF NOT EXISTS btree_gist`);
    status.btreeGistExtension.installed = true;
  } catch (err: any) {
    const msg = err?.message || String(err);
    status.btreeGistExtension.error = msg;
    console.warn(
      "[Booking] Could not create btree_gist extension (DB overlap guard will be skipped):",
      msg,
    );
    // We can't install the EXCLUDE constraint without btree_gist, but
    // we still want to attempt the UNIQUE constraint and verify what
    // is actually in pg_constraint, so don't return — just skip
    // straight to the verification step.
  }

  try {
    if (status.btreeGistExtension.installed) {
      await db.execute(sql`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'scheduled_meetings_no_overlap'
        ) THEN
          -- Note: start_time_utc / end_time_utc are stored as
          -- "timestamp WITHOUT time zone" (the value is already UTC). We
          -- use tsrange (not tstzrange) here because tstzrange on naive
          -- timestamps depends on the session TIME ZONE setting and is
          -- therefore non-IMMUTABLE — Postgres rejects it inside an index
          -- expression.
          ALTER TABLE scheduled_meetings
          ADD CONSTRAINT scheduled_meetings_no_overlap
          EXCLUDE USING gist (
            account_manager_user_id WITH =,
            tsrange(start_time_utc, end_time_utc) WITH &&
          )
          WHERE (status IN ('creating', 'confirmed'));
        END IF;
      END$$;
    `);
    } else {
      // btree_gist install failed above; record the cascading reason.
      status.scheduledMeetingsNoOverlap.error =
        "btree_gist extension is not available — overlap EXCLUDE constraint cannot be installed";
    }
  } catch (err: any) {
    const msg = err?.message || String(err);
    status.scheduledMeetingsNoOverlap.error = msg;
    console.warn(
      "[Booking] Could not install scheduled_meetings_no_overlap constraint:",
      msg,
    );
  }

  // 3. UNIQUE(account_manager_user_id) on booking_pages — the spec says
  // exactly one booking page per AM. The Drizzle column declares `.unique()`
  // but that wasn't part of the legacy 0034 migration, so we install it
  // here. Before adding the constraint we deterministically dedupe any
  // existing duplicates: keep the OLDEST row (by created_at, then id) and
  // detach all related rows (availability rules, overrides, scheduled
  // meetings, audit log) to the surviving page so we don't lose history.
  try {
    await db.execute(sql`
      DO $$
      DECLARE
        dup record;
        keeper_id varchar;
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'booking_pages_account_manager_user_id_unique'
        ) THEN
          FOR dup IN
            SELECT account_manager_user_id
            FROM booking_pages
            GROUP BY account_manager_user_id
            HAVING COUNT(*) > 1
          LOOP
            SELECT id INTO keeper_id
            FROM booking_pages
            WHERE account_manager_user_id = dup.account_manager_user_id
            ORDER BY created_at NULLS LAST, id
            LIMIT 1;

            -- Re-point children at the keeper, then drop the duplicates.
            UPDATE booking_availability_rules
            SET booking_page_id = keeper_id
            WHERE booking_page_id IN (
              SELECT id FROM booking_pages
              WHERE account_manager_user_id = dup.account_manager_user_id
                AND id <> keeper_id
            );

            -- Best-effort: only re-point if the table exists in this
            -- environment (some installs may be lagging on some children).
            BEGIN
              UPDATE booking_availability_overrides
              SET booking_page_id = keeper_id
              WHERE booking_page_id IN (
                SELECT id FROM booking_pages
                WHERE account_manager_user_id = dup.account_manager_user_id
                  AND id <> keeper_id
              );
            EXCEPTION WHEN undefined_table THEN
              NULL;
            END;

            BEGIN
              UPDATE scheduled_meetings
              SET booking_page_id = keeper_id
              WHERE booking_page_id IN (
                SELECT id FROM booking_pages
                WHERE account_manager_user_id = dup.account_manager_user_id
                  AND id <> keeper_id
              );
            EXCEPTION WHEN undefined_table OR undefined_column THEN
              NULL;
            END;

            BEGIN
              UPDATE booking_audit_log
              SET booking_page_id = keeper_id
              WHERE booking_page_id IN (
                SELECT id FROM booking_pages
                WHERE account_manager_user_id = dup.account_manager_user_id
                  AND id <> keeper_id
              );
            EXCEPTION WHEN undefined_table OR undefined_column THEN
              NULL;
            END;

            DELETE FROM booking_pages
            WHERE account_manager_user_id = dup.account_manager_user_id
              AND id <> keeper_id;
          END LOOP;

          ALTER TABLE booking_pages
          ADD CONSTRAINT booking_pages_account_manager_user_id_unique
          UNIQUE (account_manager_user_id);
        END IF;
      END$$;
    `);
  } catch (err: any) {
    const msg = err?.message || String(err);
    status.bookingPagesAccountManagerUnique.error = msg;
    console.warn(
      "[Booking] Could not install booking_pages_account_manager_user_id_unique constraint:",
      msg,
    );
  }

  // Verification — re-read pg_constraint and trust the database, not the
  // best-effort install flow above. This catches cases where the migration
  // already added the constraint (so the install no-ops) AND cases where
  // the install path silently no-ops on a non-superuser role.
  try {
    const result: any = await db.execute(sql`
      SELECT conname FROM pg_constraint
      WHERE conname IN (
        'scheduled_meetings_no_overlap',
        'booking_pages_account_manager_user_id_unique'
      )
    `);
    const rows: Array<{ conname: string }> = Array.isArray(result)
      ? result
      : (result as any).rows ?? [];
    const present = new Set(rows.map((r) => r.conname));
    if (present.has("scheduled_meetings_no_overlap")) {
      status.scheduledMeetingsNoOverlap.installed = true;
      status.scheduledMeetingsNoOverlap.error = undefined;
    }
    if (present.has("booking_pages_account_manager_user_id_unique")) {
      status.bookingPagesAccountManagerUnique.installed = true;
      status.bookingPagesAccountManagerUnique.error = undefined;
    }
    // Cross-check the extension too — `CREATE EXTENSION IF NOT EXISTS`
    // can silently no-op on a non-superuser role, but if the constraint
    // is present then btree_gist must be present too.
    if (status.scheduledMeetingsNoOverlap.installed) {
      status.btreeGistExtension.installed = true;
      status.btreeGistExtension.error = undefined;
    }
  } catch (err: any) {
    // If we couldn't even SELECT from pg_constraint, leave the optimistic
    // install flags as set — the underlying DDL above either succeeded
    // or already-warned. Don't promote a verification failure into a
    // false negative.
    console.warn(
      "[Booking] Constraint verification probe failed; trusting install-flow flags:",
      err?.message || err,
    );
  }

  status.ready =
    status.scheduledMeetingsNoOverlap.installed &&
    status.bookingPagesAccountManagerUnique.installed &&
    status.btreeGistExtension.installed;

  // Loud, structured boot-time signal — turns "silent reliability gap"
  // into an actionable line in production logs. The admin health
  // endpoint also surfaces this so ops doesn't need shell access.
  if (status.ready) {
    console.log(
      "[Booking] DB-level guards installed: scheduled_meetings_no_overlap=ok, booking_pages_account_manager_user_id_unique=ok, btree_gist=ok",
    );
  } else {
    const failures: string[] = [];
    if (!status.btreeGistExtension.installed) {
      failures.push(
        `btree_gist extension: ${status.btreeGistExtension.error || "not installed"}`,
      );
    }
    if (!status.scheduledMeetingsNoOverlap.installed) {
      failures.push(
        `scheduled_meetings_no_overlap: ${status.scheduledMeetingsNoOverlap.error || "not installed"}`,
      );
    }
    if (!status.bookingPagesAccountManagerUnique.installed) {
      failures.push(
        `booking_pages_account_manager_user_id_unique: ${status.bookingPagesAccountManagerUnique.error || "not installed"}`,
      );
    }
    console.error(
      "[Booking] CRITICAL — booking DB-level guards are NOT fully installed; the booking saga is now relying on app-level concurrency only. Failures: " +
        failures.join("; "),
    );
  }

  lastConstraintStatus = status;
  return status;
}
