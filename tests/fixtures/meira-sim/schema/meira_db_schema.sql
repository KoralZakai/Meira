-- =====================================================================
-- meira_db — SQLite schema for Meira (formerly Lumi)
-- Conventions:
--   * IDs            : TEXT (UUID v4), matches the string ids the app already uses
--   * Instants       : TEXT ISO-8601 UTC, e.g. '2026-09-24T07:30:00Z'
--   * Local dates    : TEXT 'YYYY-MM-DD' in the USER's timezone (users.timezone)
--   * Local times    : TEXT 'HH:MM' (24h) for recurring/preference times only
--   * Durations      : INTEGER minutes
--   * Booleans       : INTEGER 0/1
-- Run with: PRAGMA foreign_keys = ON;  (SQLite has FKs OFF by default)
-- =====================================================================
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------
-- 1. USERS
-- ---------------------------------------------------------------------
CREATE TABLE users (
    id                       TEXT PRIMARY KEY,
    name                     TEXT NOT NULL,
    email                    TEXT UNIQUE,
    phone                    TEXT,                          -- E.164, used for WhatsApp/Twilio
    language                 TEXT NOT NULL DEFAULT 'he'  CHECK (language IN ('en','he')),
    theme                    TEXT NOT NULL DEFAULT 'light' CHECK (theme IN ('light','dark')),
    timezone                 TEXT NOT NULL DEFAULT 'Asia/Jerusalem',
    morning_routine_minutes  INTEGER NOT NULL DEFAULT 45 CHECK (morning_routine_minutes BETWEEN 0 AND 240),
    wake_buffer_minutes      INTEGER NOT NULL DEFAULT 15 CHECK (wake_buffer_minutes BETWEEN 0 AND 120),
    buffer_minutes           INTEGER NOT NULL DEFAULT 10 CHECK (buffer_minutes BETWEEN 0 AND 120),  -- safety margin per transition
    earliest_wake_time       TEXT NOT NULL DEFAULT '05:30',   -- hard floor for the wake-time check
    default_wake_time        TEXT NOT NULL DEFAULT '07:00',
    sleep_time               TEXT NOT NULL DEFAULT '23:00',
    checkin_morning_time     TEXT NOT NULL DEFAULT '08:00',
    checkin_afternoon_time   TEXT NOT NULL DEFAULT '14:00',
    checkin_evening_time     TEXT NOT NULL DEFAULT '20:00',
    google_connected         INTEGER NOT NULL DEFAULT 0 CHECK (google_connected IN (0,1)),
    avg_lateness_minutes     REAL    NOT NULL DEFAULT 0,  -- written by nightly Nebius Job
    created_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    updated_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    CHECK (default_wake_time      GLOB '[0-2][0-9]:[0-5][0-9]'),
    CHECK (earliest_wake_time     GLOB '[0-2][0-9]:[0-5][0-9]'),
    CHECK (sleep_time             GLOB '[0-2][0-9]:[0-5][0-9]'),
    CHECK (checkin_morning_time   GLOB '[0-2][0-9]:[0-5][0-9]'),
    CHECK (checkin_afternoon_time GLOB '[0-2][0-9]:[0-5][0-9]'),
    CHECK (checkin_evening_time   GLOB '[0-2][0-9]:[0-5][0-9]')
);

-- transportation_type as a collection -> junction table (1 row per mode)
CREATE TABLE user_transport_types (
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    transport_type  TEXT NOT NULL CHECK (transport_type IN ('bus','train','car','walk','bike','scooter','taxi')),
    is_primary      INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1)),
    PRIMARY KEY (user_id, transport_type)
);
-- at most ONE primary mode per user
CREATE UNIQUE INDEX ux_transport_primary ON user_transport_types(user_id) WHERE is_primary = 1;

-- ---------------------------------------------------------------------
-- 2. PLACES (home, work, gym... geocoded once, reused by meetings/tasks)
-- ---------------------------------------------------------------------
CREATE TABLE places (
    id          TEXT PRIMARY KEY,
    user_id     TEXT REFERENCES users(id) ON DELETE CASCADE,   -- NULL = shared place (company, station)
    label       TEXT NOT NULL,                  -- 'Home', 'Space Gym', 'Ichilov'
    kind        TEXT NOT NULL DEFAULT 'other'
                CHECK (kind IN ('home','work','gym','school','clinic','cafe','station','other')),
    address     TEXT NOT NULL,
    lat         REAL NOT NULL CHECK (lat BETWEEN -90 AND 90),
    lng         REAL NOT NULL CHECK (lng BETWEEN -180 AND 180),
    google_place_id TEXT,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
-- exactly one home per user (at most one; app enforces "at least")
CREATE UNIQUE INDEX ux_places_one_home ON places(user_id) WHERE kind = 'home' AND user_id IS NOT NULL;

-- ---------------------------------------------------------------------
-- 3. CONTACTS
-- ---------------------------------------------------------------------
CREATE TABLE contacts (
    id                 TEXT PRIMARY KEY,
    user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name               TEXT NOT NULL,
    name_variants      TEXT,          -- JSON array: ["דני","Danny","Daniel"]
    phone              TEXT,
    email              TEXT,
    device_contact_id  TEXT,
    UNIQUE (user_id, device_contact_id)
);

-- ---------------------------------------------------------------------
-- 4. GOALS (progress is DERIVED via view, not stored)
-- ---------------------------------------------------------------------
CREATE TABLE goals (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    text         TEXT NOT NULL,
    category     TEXT NOT NULL,
    type         TEXT NOT NULL CHECK (type IN ('project','aspiration')),
    target_date  TEXT,
    status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','achieved','paused')),
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    achieved_at  TEXT,
    CHECK ((status = 'achieved') = (achieved_at IS NOT NULL))
);

-- ---------------------------------------------------------------------
-- 5. MEETINGS (fixed-time calendar events — the "hard" blocks of a day)
-- ---------------------------------------------------------------------
CREATE TABLE meetings (
    id                   TEXT PRIMARY KEY,
    user_id              TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title                TEXT NOT NULL,
    category             TEXT NOT NULL DEFAULT 'meeting' CHECK (category IN
                         ('interview','course','conference','class','work','meeting','call',
                          'doctor','gym','aspiration','leisure','general','zoom','hobby_class')),
    start_at             TEXT NOT NULL,             -- UTC instant
    end_at               TEXT NOT NULL,             -- UTC instant
    all_day              INTEGER NOT NULL DEFAULT 0 CHECK (all_day IN (0,1)),
    -- location: either a saved place, free text, or online
    place_id             TEXT REFERENCES places(id) ON DELETE SET NULL,
    location_text        TEXT,                      -- raw text as spoken / from Google
    is_online            INTEGER NOT NULL DEFAULT 0 CHECK (is_online IN (0,1)),
    meeting_url          TEXT,
    source               TEXT NOT NULL DEFAULT 'voice' CHECK (source IN ('voice','google_calendar','manual')),
    google_event_id      TEXT,
    status               TEXT NOT NULL DEFAULT 'scheduled'
                         CHECK (status IN ('scheduled','completed','missed','cancelled')),
    verified_arrival_at  TEXT,                      -- geofence confirmation
    lateness_minutes     INTEGER,                   -- NULL = unknown, <0 = early
    notes                TEXT,
    created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    CHECK (end_at > start_at),
    CHECK (is_online = 0 OR place_id IS NULL),       -- online meeting has no physical place
    UNIQUE (user_id, google_event_id)                -- idempotent calendar sync
);
CREATE INDEX ix_meetings_user_start ON meetings(user_id, start_at);

CREATE TABLE meeting_attendees (
    meeting_id  TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    contact_id  TEXT REFERENCES contacts(id) ON DELETE SET NULL,
    name        TEXT NOT NULL,
    email       TEXT,
    PRIMARY KEY (meeting_id, name)
);

-- ---------------------------------------------------------------------
-- 6. TASKS (flexible work; is_fixed is DERIVED: meeting_id IS NOT NULL)
-- ---------------------------------------------------------------------
CREATE TABLE tasks (
    id                 TEXT PRIMARY KEY,
    user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    meeting_id         TEXT REFERENCES meetings(id) ON DELETE SET NULL,  -- prep/attend task for a meeting
    goal_id            TEXT REFERENCES goals(id)    ON DELETE SET NULL,
    place_id           TEXT REFERENCES places(id)   ON DELETE SET NULL,
    contact_id         TEXT REFERENCES contacts(id) ON DELETE SET NULL,
    text               TEXT NOT NULL,
    category           TEXT NOT NULL DEFAULT 'general' CHECK (category IN
                       ('interview','course','conference','class','work','meeting','call',
                        'doctor','gym','aspiration','leisure','general','zoom','hobby_class')),
    priority           TEXT NOT NULL DEFAULT 'need_to'
                       CHECK (priority IN ('must','have_to','need_to','nice_to_do')),
    status             TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','partial','complete','missed','moved')),
    task_date          TEXT NOT NULL,              -- local date the task is planned for
    scheduled_start_at TEXT,                       -- UTC instant, set by scheduler
    estimated_minutes  INTEGER NOT NULL DEFAULT 30 CHECK (estimated_minutes > 0),
    actual_minutes     INTEGER CHECK (actual_minutes IS NULL OR actual_minutes >= 0),
    deadline_at        TEXT,                       -- UTC instant
    latest_start_at    TEXT,                       -- derived from deadline - estimate - buffer
    progress_note      TEXT,
    moved_from_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,  -- lineage, not a copy
    gmail_thread_id    TEXT,
    completed_at       TEXT,
    created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    CHECK ((status = 'complete') = (completed_at IS NOT NULL)),
    CHECK (latest_start_at IS NULL OR deadline_at IS NOT NULL)
);
CREATE INDEX ix_tasks_user_date   ON tasks(user_id, task_date);
CREATE INDEX ix_tasks_user_status ON tasks(user_id, status);

CREATE TABLE subtasks (
    id                 TEXT PRIMARY KEY,
    task_id            TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    text               TEXT NOT NULL,
    status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','complete')),
    estimated_minutes  INTEGER NOT NULL DEFAULT 15 CHECK (estimated_minutes > 0),
    position           INTEGER NOT NULL,
    UNIQUE (task_id, position)
);

-- ---------------------------------------------------------------------
-- 7. TRANSIT (a plan is always tied to a real meeting — no orphan plans)
-- ---------------------------------------------------------------------
CREATE TABLE transit_plans (
    id                    TEXT PRIMARY KEY,
    meeting_id            TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    origin_place_id       TEXT REFERENCES places(id) ON DELETE SET NULL,
    transport_type        TEXT NOT NULL,
    wake_up_at            TEXT NOT NULL,
    leave_home_at         TEXT NOT NULL,
    arrive_at             TEXT NOT NULL,
    total_minutes         INTEGER NOT NULL CHECK (total_minutes >= 0),
    walk_to_stop_minutes  INTEGER NOT NULL DEFAULT 0,
    source                TEXT NOT NULL CHECK (source IN ('google','manual','estimate')),
    fetched_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    is_current            INTEGER NOT NULL DEFAULT 1 CHECK (is_current IN (0,1)),
    CHECK (wake_up_at <= leave_home_at AND leave_home_at < arrive_at)
);
-- one active plan per meeting; re-checks insert a new row and retire the old one
CREATE UNIQUE INDEX ux_transit_current ON transit_plans(meeting_id) WHERE is_current = 1;

CREATE TABLE transit_legs (
    plan_id       TEXT NOT NULL REFERENCES transit_plans(id) ON DELETE CASCADE,
    seq           INTEGER NOT NULL,
    leg_type      TEXT NOT NULL CHECK (leg_type IN ('walk','bus','train','light_rail','car','bike')),
    from_name     TEXT NOT NULL,
    to_name       TEXT NOT NULL,
    depart_at     TEXT NOT NULL,
    arrive_at     TEXT NOT NULL,
    line_number   TEXT,
    stop_lat      REAL,
    stop_lng      REAL,
    PRIMARY KEY (plan_id, seq),
    CHECK (arrive_at >= depart_at)
);

-- ---------------------------------------------------------------------
-- 8. NOTIFICATIONS (every non-checkin notification MUST reference a real
--    task or meeting -> a phantom notification cannot be inserted)
-- ---------------------------------------------------------------------
CREATE TABLE notifications (
    id                      TEXT PRIMARY KEY,
    user_id                 TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    task_id                 TEXT REFERENCES tasks(id)    ON DELETE CASCADE,
    meeting_id              TEXT REFERENCES meetings(id) ON DELETE CASCADE,
    type                    TEXT NOT NULL CHECK (type IN
                            ('checkin','wake_up','leave_home','re_check','missed_bus',
                             'deadline_reminder','deadline_today','latest_start')),
    fire_at                 TEXT NOT NULL,
    device_notification_id  TEXT,              -- id returned by expo-notifications
    status                  TEXT NOT NULL DEFAULT 'scheduled'
                            CHECK (status IN ('scheduled','fired','cancelled')),
    created_by              TEXT NOT NULL DEFAULT 'app' CHECK (created_by IN ('app','agent','job')),
    created_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    CHECK (type = 'checkin' OR task_id IS NOT NULL OR meeting_id IS NOT NULL),
    CHECK (type NOT IN ('wake_up','leave_home','re_check','missed_bus') OR meeting_id IS NOT NULL),
    CHECK (type NOT IN ('deadline_reminder','deadline_today','latest_start') OR task_id IS NOT NULL)
);
-- no duplicate notification of the same type for the same target at the same time
CREATE UNIQUE INDEX ux_notif_dedupe
    ON notifications(user_id, type, COALESCE(task_id,''), COALESCE(meeting_id,''), fire_at);

-- ---------------------------------------------------------------------
-- 9. LEARNING — append-only event log + nightly-job outputs
-- ---------------------------------------------------------------------
CREATE TABLE task_events (
    id                 TEXT PRIMARY KEY,
    user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    task_id            TEXT REFERENCES tasks(id)    ON DELETE SET NULL,
    meeting_id         TEXT REFERENCES meetings(id) ON DELETE SET NULL,
    event_type         TEXT NOT NULL CHECK (event_type IN
                       ('created','started','completed','partial','missed','moved',
                        'arrived','left_home','duration_verified')),
    category           TEXT,                      -- denormalized: survives task deletion
    estimated_minutes  INTEGER,
    actual_minutes     INTEGER,
    lateness_minutes   INTEGER,
    occurred_at        TEXT NOT NULL,
    payload            TEXT                       -- JSON, free-form extras
);
CREATE INDEX ix_events_user_time ON task_events(user_id, occurred_at);

CREATE TABLE learned_durations (
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    category      TEXT NOT NULL,
    avg_minutes   REAL NOT NULL CHECK (avg_minutes > 0),
    sample_count  INTEGER NOT NULL DEFAULT 0,
    updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    PRIMARY KEY (user_id, category)
);

-- ---------------------------------------------------------------------
-- 10. DAILY LOG & REWARDS
-- ---------------------------------------------------------------------
CREATE TABLE daily_logs (
    user_id                TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    log_date               TEXT NOT NULL,
    morning_done           INTEGER NOT NULL DEFAULT 0 CHECK (morning_done   IN (0,1)),
    afternoon_done         INTEGER NOT NULL DEFAULT 0 CHECK (afternoon_done IN (0,1)),
    evening_done           INTEGER NOT NULL DEFAULT 0 CHECK (evening_done   IN (0,1)),
    wake_up_time           TEXT,
    schedule_generated_at  TEXT,
    summary_en             TEXT,
    summary_he             TEXT,
    PRIMARY KEY (user_id, log_date)
);

-- ledger: points are summed, never stored as a mutable total
CREATE TABLE reward_events (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type        TEXT NOT NULL CHECK (type IN
                ('task_complete','on_time','arrival','streak','perfect_day','level_up',
                 'goal_achieved','time_estimate_accurate')),
    points      INTEGER NOT NULL,
    task_id     TEXT REFERENCES tasks(id)    ON DELETE SET NULL,
    meeting_id  TEXT REFERENCES meetings(id) ON DELETE SET NULL,
    message_en  TEXT,
    message_he  TEXT,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX ix_rewards_user ON reward_events(user_id, created_at);

-- ---------------------------------------------------------------------
-- 11. DERIVED VIEWS (replace stored counters that can drift)
-- ---------------------------------------------------------------------
CREATE VIEW v_user_points AS
SELECT u.id AS user_id,
       COALESCE(SUM(r.points), 0) AS total_points
FROM users u LEFT JOIN reward_events r ON r.user_id = u.id
GROUP BY u.id;

CREATE VIEW v_goal_progress AS
SELECT g.id AS goal_id,
       COUNT(t.id)                                          AS total_tasks,
       SUM(CASE WHEN t.status = 'complete' THEN 1 ELSE 0 END) AS completed_tasks,
       CASE WHEN COUNT(t.id) = 0 THEN 0
            ELSE ROUND(100.0 * SUM(CASE WHEN t.status = 'complete' THEN 1 ELSE 0 END) / COUNT(t.id), 1)
       END                                                  AS progress_percent
FROM goals g LEFT JOIN tasks t ON t.goal_id = g.id
GROUP BY g.id;

CREATE VIEW v_task_estimate_error AS          -- the "before/after accuracy" chart source
SELECT user_id, category,
       date(occurred_at) AS day,
       AVG(ABS(actual_minutes - estimated_minutes)) AS mae_minutes,
       COUNT(*) AS n
FROM task_events
WHERE event_type = 'completed' AND actual_minutes IS NOT NULL AND estimated_minutes IS NOT NULL
GROUP BY user_id, category, date(occurred_at);
