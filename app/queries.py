"""Read-side queries. Results are shaped for the API, independent of table layout."""
import json
import sqlite3
from typing import Any

from .normalize import DISTANCE_CATEGORIES

SORTS = {
    "start": "start_utc ASC",
    "-start": "start_utc DESC",
    "duration": "duration_s ASC",
    "-duration": "duration_s DESC",
    "distance": "distance_m ASC",
    "-distance": "distance_m DESC",
}


def _round(value: float | None, digits: int = 1) -> float | None:
    return None if value is None else round(value, digits)


def serialize_workout(row: sqlite3.Row) -> dict[str, Any]:
    has_distance = row["activity_category"] in DISTANCE_CATEGORIES and bool(row["distance_m"])
    pace = speed = None
    if has_distance and row["duration_s"]:
        pace = row["duration_s"] / (row["distance_m"] / 1000)
        speed = (row["distance_m"] / 1000) / (row["duration_s"] / 3600)
    hr = {"min": _round(row["hr_min_bpm"], 0), "avg": _round(row["hr_avg_bpm"], 0), "max": _round(row["hr_max_bpm"], 0)}
    return {
        "id": row["id"],
        "activity": {"type": row["activity_type"], "label": row["activity_label"], "category": row["activity_category"]},
        "start": row["start_utc"],
        "end": row["end_utc"],
        "utc_offset_minutes": row["utc_offset_minutes"],
        "local_date": row["start_local_date"],
        "duration_s": _round(row["duration_s"]),
        "distance_m": _round(row["distance_m"]) if has_distance else None,
        "avg_pace_s_per_km": _round(pace),
        "avg_speed_kmh": _round(speed, 2),
        "active_energy_kcal": _round(row["active_energy_kcal"]),
        "total_energy_kcal": _round(row["total_energy_kcal"]),
        "elevation_up_m": _round(row["elevation_up_m"]),
        "elevation_down_m": _round(row["elevation_down_m"]),
        "heart_rate_bpm": hr if any(v is not None for v in hr.values()) else None,
        "location": row["location"],
        "is_indoor": None if row["is_indoor"] is None else bool(row["is_indoor"]),
        "source_app": row["source_app"],
        "flags": json.loads(row["flags"]),
    }


def list_workouts(conn: sqlite3.Connection, *, date_from: str | None, date_to: str | None,
                  activity_type: str | None, category: str | None, sort: str, limit: int,
                  offset: int) -> dict[str, Any]:
    where, params = [], []
    if date_from:
        where.append("start_local_date >= ?")
        params.append(date_from)
    if date_to:
        where.append("start_local_date < ?")
        params.append(date_to)
    if activity_type:
        where.append("activity_type = ?")
        params.append(activity_type)
    if category:
        where.append("activity_category = ?")
        params.append(category)
    clause = f"WHERE {' AND '.join(where)}" if where else ""
    total = conn.execute(f"SELECT COUNT(*) FROM workouts {clause}", params).fetchone()[0]
    rows = conn.execute(
        f"SELECT * FROM workouts {clause} ORDER BY {SORTS[sort]}, id LIMIT ? OFFSET ?",
        (*params, limit, offset),
    ).fetchall()
    return {"items": [serialize_workout(r) for r in rows], "total": total, "limit": limit, "offset": offset}


def get_workout(conn: sqlite3.Connection, workout_id: int) -> dict[str, Any] | None:
    row = conn.execute("SELECT * FROM workouts WHERE id = ?", (workout_id,)).fetchone()
    if row is None:
        return None
    result = serialize_workout(row)
    result["extra_metrics"] = json.loads(row["extra_metrics"])
    result["source_units"] = json.loads(row["source_units"])
    result["metrics_available"] = {
        r["metric_type"]: {"samples": r["n"], "unit": r["unit"]}
        for r in conn.execute(
            "SELECT metric_type, COUNT(*) AS n, MIN(unit) AS unit FROM workout_metrics "
            "WHERE workout_id = ? GROUP BY metric_type ORDER BY metric_type", (workout_id,))
    }
    result["route_points"] = conn.execute(
        "SELECT COUNT(*) FROM workout_route_points WHERE workout_id = ?", (workout_id,)).fetchone()[0]
    return result


def get_metrics(conn: sqlite3.Connection, workout_id: int, metric_type: str | None) -> dict[str, Any]:
    sql = "SELECT metric_type, ts_utc, value, value_min, value_max, unit FROM workout_metrics WHERE workout_id = ?"
    params: list[Any] = [workout_id]
    if metric_type:
        sql += " AND metric_type = ?"
        params.append(metric_type)
    series: dict[str, dict[str, Any]] = {}
    for r in conn.execute(sql + " ORDER BY metric_type, ts_utc", params):
        entry = series.setdefault(r["metric_type"], {"unit": r["unit"], "samples": []})
        sample = {"t": r["ts_utc"], "v": r["value"]}
        if r["value_min"] is not None:
            sample["min"] = r["value_min"]
        if r["value_max"] is not None:
            sample["max"] = r["value_max"]
        entry["samples"].append(sample)
    return {"workout_id": workout_id, "series": series}


def get_route(conn: sqlite3.Connection, workout_id: int) -> dict[str, Any]:
    rows = conn.execute(
        "SELECT ts_utc, latitude, longitude, altitude_m, speed_mps FROM workout_route_points "
        "WHERE workout_id = ? ORDER BY ts_utc", (workout_id,)).fetchall()
    return {
        "workout_id": workout_id,
        "points": [{"t": r["ts_utc"], "lat": r["latitude"], "lon": r["longitude"],
                    "alt_m": r["altitude_m"], "speed_mps": r["speed_mps"]} for r in rows],
    }


def delete_workout(conn: sqlite3.Connection, workout_id: int) -> bool:
    return conn.execute("DELETE FROM workouts WHERE id = ?", (workout_id,)).rowcount > 0


def status(conn: sqlite3.Connection) -> dict[str, Any]:
    counts = conn.execute(
        "SELECT COUNT(*) AS n, MIN(start_local_date) AS first, MAX(start_local_date) AS last FROM workouts").fetchone()
    last_batch = conn.execute("SELECT * FROM ingestion_batches ORDER BY id DESC LIMIT 1").fetchone()
    last_ok = conn.execute(
        "SELECT finished_at FROM ingestion_batches WHERE status IN ('succeeded', 'partial', 'empty') "
        "ORDER BY id DESC LIMIT 1").fetchone()
    return {
        "workouts": counts["n"],
        "first_workout_date": counts["first"],
        "last_workout_date": counts["last"],
        "last_successful_sync": last_ok["finished_at"] if last_ok else None,
        "last_batch": None if last_batch is None else {
            "id": last_batch["id"],
            "channel": last_batch["channel"],
            "received_at": last_batch["received_at"],
            "status": last_batch["status"],
            "workouts_received": last_batch["workouts_received"],
            "inserted": last_batch["inserted"],
            "updated": last_batch["updated"],
            "unchanged": last_batch["unchanged"],
            "failed": last_batch["failed"],
            "metric_samples_stored": last_batch["metric_samples_stored"],
            "errors": json.loads(last_batch["errors"]),
        },
    }
