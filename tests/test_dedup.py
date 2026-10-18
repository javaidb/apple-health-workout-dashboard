"""Same-session de-duplication: one real workout must never be counted twice."""
import json
import sqlite3

from app.db import connect, migrate
from app.ingest import FITBOD_CSV_SOURCE, ingest_payload

INGEST = "/api/v1/ingest/health-auto-export"


def hae_workout(wid, start="2026-10-06 20:56:18 -0400", end="2026-10-06 21:25:27 -0400", name="Functional Strength Training"):
    return {"id": wid, "name": name, "start": start, "end": end, "duration": 1749,
            "activeEnergyBurned": {"qty": 467.7, "units": "kJ"}}


def post(client, workouts, auth):
    return client.post(INGEST, content=json.dumps({"data": {"workouts": workouts}}),
                       headers={**auth, "Content-Type": "application/json"}).json()


def rows(settings):
    conn = sqlite3.connect(settings.db_path)
    try:
        return conn.execute("SELECT source, source_workout_id FROM workouts ORDER BY id").fetchall()
    finally:
        conn.close()


def import_fitbod(settings, workouts):
    conn = connect(settings.db_path)
    try:
        return ingest_payload(conn, {"data": {"workouts": workouts}}, 1, "fitbod_csv", store_raw=False,
                              source=FITBOD_CSV_SOURCE, extra_flags={"duration_estimated": True}).as_dict()
    finally:
        conn.close()


# ---- same session written twice to Apple Health ---------------------------

def test_second_health_record_of_same_session_is_skipped(client, auth, settings):
    post(client, [hae_workout("A")], auth)
    body = post(client, [hae_workout("B", end="2026-10-06 21:24:00 -0400")], auth)
    assert body["deduplication"]["skipped_duplicates"] == 1
    assert rows(settings) == [("health_auto_export", "A")]


def test_different_activity_at_same_time_is_kept(client, auth, settings):
    post(client, [hae_workout("A"), hae_workout("B", name="Outdoor Walk")], auth)
    assert len(rows(settings)) == 2


def test_sessions_more_than_two_minutes_apart_are_kept(client, auth, settings):
    post(client, [hae_workout("A"), hae_workout("B", start="2026-10-06 21:01:18 -0400")], auth)
    assert len(rows(settings)) == 2


def test_migration_removes_existing_duplicates(tmp_path):
    db = tmp_path / "w.db"
    conn = connect(db)
    conn.execute("PRAGMA user_version = 0")
    from app.db import MIGRATIONS
    for script in MIGRATIONS[:2]:
        for stmt in script.split(";"):
            if stmt.strip():
                conn.execute(stmt)
    conn.execute("PRAGMA user_version = 2")
    for wid in ("A", "B"):
        conn.execute(
            "INSERT INTO workouts (source, source_workout_id, activity_type, activity_label, activity_category, start_utc,"
            " end_utc, utc_offset_minutes, start_local_date, duration_s, payload_sha256, created_at, updated_at) VALUES"
            " ('health_auto_export', ?, 'functional_strength_training', 'F', 'strength', '2026-10-07T00:56:18.000Z',"
            " '2026-10-07T01:25:00.000Z', -240, '2026-10-06', 1749, 'x', 'n', 'n')", (wid,))
    migrate(conn)
    assert [r[0] for r in conn.execute("SELECT source_workout_id FROM workouts")] == ["A"]
    conn.close()


# ---- Fitbod CSV backfill vs Apple Health ----------------------------------

def test_fitbod_import_skips_sessions_already_in_health(client, auth, settings):
    post(client, [hae_workout("A")], auth)
    r = import_fitbod(settings, [hae_workout("fitbod-1"), hae_workout("fitbod-2", start="2025-03-01 18:00:00 -0500",
                                                                         end="2025-03-01 18:30:00 -0500")])
    assert r["workouts"]["inserted"] == 1 and r["deduplication"]["skipped_duplicates"] == 1
    assert rows(settings) == [("health_auto_export", "A"), (FITBOD_CSV_SOURCE, "fitbod-2")]


def test_health_record_replaces_earlier_fitbod_import(client, auth, settings):
    import_fitbod(settings, [hae_workout("fitbod-1")])
    body = post(client, [hae_workout("A")], auth)
    assert body["deduplication"]["replaced_lower_priority"] == 1
    assert rows(settings) == [("health_auto_export", "A")]


def test_fitbod_reimport_is_unchanged(settings, client):
    first = import_fitbod(settings, [hae_workout("fitbod-1")])
    again = import_fitbod(settings, [hae_workout("fitbod-1")])
    assert first["workouts"]["inserted"] == 1 and again["workouts"]["unchanged"] == 1
    assert len(rows(settings)) == 1


def test_imported_workouts_are_flagged(settings, client):
    import_fitbod(settings, [hae_workout("fitbod-1")])
    w = client.get("/api/v1/workouts").json()["items"][0]
    assert w["flags"]["duration_estimated"] is True
