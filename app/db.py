"""SQLite connection handling and schema migrations.

Migrations are an ordered list applied against PRAGMA user_version. Append new
entries; never edit one that has shipped.

Conventions:
- Timestamps are UTC text, fixed width: YYYY-MM-DDTHH:MM:SS.mmmZ (sorts correctly).
- The workout's original UTC offset is kept in utc_offset_minutes, and
  start_local_date is the calendar date in that offset.
- NULL means "not present in the export"; 0 is a real measured zero.
- Summary quantities are stored in canonical units (m, s, kcal, bpm, m/s, degC);
  the original units are recorded in source_units.
"""
import sqlite3
from pathlib import Path

MIGRATIONS: list[str] = [
    # 1 — initial schema
    """
    CREATE TABLE ingestion_batches (
        id                INTEGER PRIMARY KEY,
        received_at       TEXT NOT NULL,
        finished_at       TEXT,
        channel           TEXT NOT NULL,              -- 'rest' | 'manual'
        status            TEXT NOT NULL,              -- processing | succeeded | partial | failed | empty
        payload_bytes     INTEGER NOT NULL,
        workouts_received INTEGER NOT NULL DEFAULT 0,
        inserted          INTEGER NOT NULL DEFAULT 0,
        updated           INTEGER NOT NULL DEFAULT 0,
        unchanged         INTEGER NOT NULL DEFAULT 0,
        failed            INTEGER NOT NULL DEFAULT 0,
        other_counts      TEXT NOT NULL DEFAULT '{}', -- other HAE data arrays received (ignored)
        errors            TEXT NOT NULL DEFAULT '[]'  -- field paths and messages only, never values
    );

    CREATE TABLE workouts (
        id                  INTEGER PRIMARY KEY,
        source              TEXT NOT NULL,
        source_workout_id   TEXT NOT NULL,
        activity_type       TEXT NOT NULL,            -- normalized slug, e.g. outdoor_run
        activity_label      TEXT NOT NULL,            -- original label, e.g. "Outdoor Run"
        activity_category   TEXT NOT NULL,            -- run | walk | cycle | swim | strength | ...
        start_utc           TEXT NOT NULL,
        end_utc             TEXT NOT NULL,
        utc_offset_minutes  INTEGER NOT NULL,
        start_local_date    TEXT NOT NULL,
        duration_s          REAL NOT NULL,
        distance_m          REAL,
        active_energy_kcal  REAL,
        total_energy_kcal   REAL,
        elevation_up_m      REAL,
        elevation_down_m    REAL,
        hr_min_bpm          REAL,
        hr_avg_bpm          REAL,
        hr_max_bpm          REAL,
        location            TEXT,
        is_indoor           INTEGER,
        extra_metrics       TEXT NOT NULL DEFAULT '{}',
        source_units        TEXT NOT NULL DEFAULT '{}',
        source_metadata     TEXT NOT NULL DEFAULT '{}',
        flags               TEXT NOT NULL DEFAULT '{}',
        payload_sha256      TEXT NOT NULL,
        first_batch_id      INTEGER REFERENCES ingestion_batches(id),
        last_batch_id       INTEGER REFERENCES ingestion_batches(id),
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL,
        UNIQUE (source, source_workout_id)
    );
    CREATE INDEX ix_workouts_start_utc ON workouts(start_utc);
    CREATE INDEX ix_workouts_local_date ON workouts(start_local_date);
    CREATE INDEX ix_workouts_activity ON workouts(activity_type, start_utc);

    CREATE TABLE workout_metrics (
        id          INTEGER PRIMARY KEY,
        workout_id  INTEGER NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
        metric_type TEXT NOT NULL,
        ts_utc      TEXT NOT NULL,
        value       REAL NOT NULL,
        value_min   REAL,
        value_max   REAL,
        unit        TEXT NOT NULL,
        source      TEXT,
        UNIQUE (workout_id, metric_type, ts_utc)
    );

    CREATE TABLE workout_route_points (
        id          INTEGER PRIMARY KEY,
        workout_id  INTEGER NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
        ts_utc      TEXT NOT NULL,
        latitude    REAL NOT NULL,
        longitude   REAL NOT NULL,
        altitude_m  REAL,
        speed_mps   REAL,
        course_deg  REAL,
        h_acc_m     REAL,
        v_acc_m     REAL,
        UNIQUE (workout_id, ts_utc)
    );

    CREATE TABLE raw_workout_payloads (
        workout_id  INTEGER PRIMARY KEY REFERENCES workouts(id) ON DELETE CASCADE,
        batch_id    INTEGER REFERENCES ingestion_batches(id),
        sha256      TEXT NOT NULL,
        payload     TEXT NOT NULL,
        stored_at   TEXT NOT NULL
    );
    """,
    # 2 — health metrics (steps, distance, energy, weight, ...)
    """
    CREATE TABLE health_metric_samples (
        id            INTEGER PRIMARY KEY,
        metric        TEXT NOT NULL,             -- slug, e.g. step_count, weight_body_mass
        ts_utc        TEXT NOT NULL,
        local_date    TEXT NOT NULL,             -- date in the sample's own UTC offset
        value         REAL NOT NULL,             -- canonical unit
        value_min     REAL,
        value_max     REAL,
        unit          TEXT NOT NULL,
        source_unit   TEXT,                      -- unit as exported (e.g. lb), for display
        source        TEXT NOT NULL DEFAULT '',  -- '' when HAE omits it, so UNIQUE still applies
        last_batch_id INTEGER REFERENCES ingestion_batches(id),
        updated_at    TEXT NOT NULL,
        UNIQUE (metric, ts_utc, source)
    );
    CREATE INDEX ix_metric_samples_day ON health_metric_samples(metric, local_date);
    ALTER TABLE ingestion_batches ADD COLUMN metric_samples_received INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE ingestion_batches ADD COLUMN metric_samples_stored INTEGER NOT NULL DEFAULT 0;
    """,
]


def connect(db_path: Path) -> sqlite3.Connection:
    """Open a connection in autocommit mode; callers manage transactions explicitly."""
    conn = sqlite3.connect(db_path, isolation_level=None, timeout=30, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA busy_timeout = 30000")
    return conn


def migrate(conn: sqlite3.Connection) -> int:
    current = conn.execute("PRAGMA user_version").fetchone()[0]
    for version, script in enumerate(MIGRATIONS, start=1):
        if version <= current:
            continue
        conn.execute("BEGIN IMMEDIATE")
        try:
            for statement in script.split(";"):
                if statement.strip():
                    conn.execute(statement)
            conn.execute(f"PRAGMA user_version = {version}")
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise
    return len(MIGRATIONS)
