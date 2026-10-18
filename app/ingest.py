"""Ingestion service: envelope validation, idempotent upserts, batch bookkeeping.

Idempotency rules
- Identity is (source, source_workout_id) where the id is HAE's HealthKit UUID.
- A workout whose raw payload hash matches the stored one is "unchanged" (no writes
  beyond last_batch_id), so retries and overlapping exports are cheap.
- A changed workout updates its summary. Fields absent from the new payload keep
  their stored value (absence never deletes data).
- For each metric type present in the new payload, that workout's series is
  replaced in full, so overlapping exports never duplicate samples. Metric types
  and routes absent from the new payload are left untouched.
- Each workout is processed inside its own savepoint: one bad workout is
  recorded in the batch errors without discarding the rest of the batch.
- Health metrics (data.metrics) are upserted per (metric, timestamp, source); see
  app/metrics.py. A malformed metric is recorded as an error; the rest still commit.

Cross-record de-duplication (one real session, several records)
- A new workout of the same activity category starting within SAME_SESSION_WINDOW of
  an existing one is the same session: e.g. Fitbod saving one workout to Apple Health
  twice, or a Fitbod CSV backfill overlapping synced workouts.
- Sources have a priority (Apple Health via HAE first). A new record that duplicates an
  equal- or higher-priority record is skipped ("duplicate"); a new higher-priority
  record replaces lower-priority copies ("replaced"), so live data always wins over
  one-off imports.
"""
import hashlib
import json
import logging
import sqlite3
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

from .metrics import MetricValidationError, normalize_metric, store_samples
from .normalize import SOURCE, NormalizedWorkout, WorkoutValidationError, normalize_workout
from .timeparse import to_utc_text

log = logging.getLogger("hae.ingest")

FITBOD_CSV_SOURCE = "fitbod_csv"
# Lower number wins when two sources describe the same session.
SOURCE_PRIORITY = {SOURCE: 0, FITBOD_CSV_SOURCE: 1}
SAME_SESSION_WINDOW = timedelta(minutes=2)


class EnvelopeError(ValueError):
    pass


@dataclass
class BatchResult:
    batch_id: int
    status: str
    received: int = 0
    inserted: int = 0
    updated: int = 0
    unchanged: int = 0
    duplicates: int = 0
    replaced: int = 0
    failed: int = 0
    metric_types: list[str] = field(default_factory=list)
    metric_samples_received: int = 0
    metric_samples_stored: int = 0
    metric_samples_skipped: int = 0
    metrics_failed: int = 0
    other_counts: dict[str, int] = field(default_factory=dict)
    errors: list[dict[str, Any]] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {
            "batch_id": self.batch_id,
            "status": self.status,
            "workouts": {
                "received": self.received,
                "inserted": self.inserted,
                "updated": self.updated,
                "unchanged": self.unchanged,
                "failed": self.failed,
            },
            "metrics": {
                "types": self.metric_types,
                "samples_received": self.metric_samples_received,
                "samples_stored": self.metric_samples_stored,
                "samples_skipped": self.metric_samples_skipped,
                "failed": self.metrics_failed,
            },
            "deduplication": {"skipped_duplicates": self.duplicates, "replaced_lower_priority": self.replaced},
            "ignored_data_types": self.other_counts,
            "errors": self.errors,
        }


def _now() -> str:
    return to_utc_text(datetime.now(timezone.utc))


def extract_envelope(payload: Any) -> tuple[list[Any], list[Any], dict[str, int]]:
    """Return the workouts and metrics arrays, plus counts of other (ignored) HAE data arrays."""
    if not isinstance(payload, dict):
        raise EnvelopeError("payload must be a JSON object")
    data = payload.get("data", payload)
    if not isinstance(data, dict):
        raise EnvelopeError("'data' must be an object")
    workouts = data.get("workouts", [])
    if not isinstance(workouts, list):
        raise EnvelopeError("'data.workouts' must be an array")
    metrics = data.get("metrics", [])
    if not isinstance(metrics, list):
        raise EnvelopeError("'data.metrics' must be an array")
    handled = {"workouts", "metrics"}
    others = {k: len(v) for k, v in data.items() if k not in handled and isinstance(v, list) and v}
    if not workouts and not metrics and not others and not handled & data.keys():
        raise EnvelopeError("no Health Auto Export data arrays found (expected data.workouts or data.metrics)")
    return workouts, metrics, others


def payload_hash(raw: Any) -> str:
    canonical = json.dumps(raw, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


_SUMMARY_COLUMNS = ("distance_m", "active_energy_kcal", "total_energy_kcal", "elevation_up_m",
                    "elevation_down_m", "hr_min_bpm", "hr_avg_bpm", "hr_max_bpm")


def _same_session(conn: sqlite3.Connection, w: NormalizedWorkout) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT id, source FROM workouts WHERE activity_category = ? AND start_utc BETWEEN ? AND ?",
        (w.activity_category, to_utc_text(w.start - SAME_SESSION_WINDOW), to_utc_text(w.start + SAME_SESSION_WINDOW)),
    ).fetchall()


def _upsert_workout(conn: sqlite3.Connection, w: NormalizedWorkout, raw: Any, batch_id: int,
                    store_raw: bool, source: str = SOURCE) -> tuple[str, int]:
    """Insert or update one workout. Returns (outcome, number of lower-priority copies replaced)."""
    sha = payload_hash(raw)
    existing = conn.execute(
        "SELECT id, payload_sha256, extra_metrics, source_units, source_metadata FROM workouts "
        "WHERE source = ? AND source_workout_id = ?",
        (source, w.source_workout_id),
    ).fetchone()
    now = _now()

    if existing and existing["payload_sha256"] == sha:
        conn.execute("UPDATE workouts SET last_batch_id = ? WHERE id = ?", (batch_id, existing["id"]))
        return "unchanged", 0

    replaced = 0
    if existing is None:
        mine = SOURCE_PRIORITY.get(source, len(SOURCE_PRIORITY))
        others = _same_session(conn, w)
        if any(SOURCE_PRIORITY.get(o["source"], len(SOURCE_PRIORITY)) <= mine for o in others):
            return "duplicate", 0
        for o in others:  # all lower priority: the new record supersedes them
            conn.execute("DELETE FROM workouts WHERE id = ?", (o["id"],))
            replaced += 1

    core = {
        "activity_type": w.activity_type,
        "activity_label": w.activity_label,
        "activity_category": w.activity_category,
        "start_utc": to_utc_text(w.start),
        "end_utc": to_utc_text(w.end),
        "utc_offset_minutes": w.utc_offset_minutes,
        "start_local_date": w.start_local_date,
        "duration_s": w.duration_s,
        "flags": json.dumps(w.flags),
        "payload_sha256": sha,
        "last_batch_id": batch_id,
        "updated_at": now,
    }
    optional = {col: w.summary.get(col) for col in _SUMMARY_COLUMNS}
    optional["location"] = w.location
    optional["is_indoor"] = None if w.is_indoor is None else int(w.is_indoor)

    if existing is None:
        values = {
            **core, **optional,
            "source": source,
            "source_workout_id": w.source_workout_id,
            "extra_metrics": json.dumps(w.extra_metrics),
            "source_units": json.dumps(w.source_units),
            "source_metadata": json.dumps(w.source_metadata),
            "first_batch_id": batch_id,
            "created_at": now,
        }
        cols = ", ".join(values)
        marks = ", ".join("?" for _ in values)
        cur = conn.execute(f"INSERT INTO workouts ({cols}) VALUES ({marks})", tuple(values.values()))
        workout_id = cur.lastrowid
        outcome = "inserted"
    else:
        workout_id = existing["id"]
        merged = {
            "extra_metrics": json.dumps({**json.loads(existing["extra_metrics"]), **w.extra_metrics}),
            "source_units": json.dumps({**json.loads(existing["source_units"]), **w.source_units}),
            "source_metadata": json.dumps({**json.loads(existing["source_metadata"]), **w.source_metadata}),
        }
        sets = [f"{c} = ?" for c in core] + [f"{c} = COALESCE(?, {c})" for c in optional] + [f"{c} = ?" for c in merged]
        params = (*core.values(), *optional.values(), *merged.values(), workout_id)
        conn.execute(f"UPDATE workouts SET {', '.join(sets)} WHERE id = ?", params)
        outcome = "updated"

    for metric_type, samples in w.metrics.items():
        conn.execute("DELETE FROM workout_metrics WHERE workout_id = ? AND metric_type = ?", (workout_id, metric_type))
        conn.executemany(
            "INSERT OR IGNORE INTO workout_metrics "
            "(workout_id, metric_type, ts_utc, value, value_min, value_max, unit, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [(workout_id, metric_type, to_utc_text(s.ts), s.value, s.value_min, s.value_max, s.unit, s.source)
             for s in samples],
        )

    if w.route:
        conn.execute("DELETE FROM workout_route_points WHERE workout_id = ?", (workout_id,))
        conn.executemany(
            "INSERT OR IGNORE INTO workout_route_points "
            "(workout_id, ts_utc, latitude, longitude, altitude_m, speed_mps, course_deg, h_acc_m, v_acc_m) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [(workout_id, to_utc_text(p.ts), p.latitude, p.longitude, p.altitude_m, p.speed_mps,
              p.course_deg, p.h_acc_m, p.v_acc_m) for p in w.route],
        )

    if store_raw:
        conn.execute(
            "INSERT INTO raw_workout_payloads (workout_id, batch_id, sha256, payload, stored_at) VALUES (?, ?, ?, ?, ?) "
            "ON CONFLICT(workout_id) DO UPDATE SET batch_id = excluded.batch_id, sha256 = excluded.sha256, "
            "payload = excluded.payload, stored_at = excluded.stored_at",
            (workout_id, batch_id, sha, json.dumps(raw, ensure_ascii=False), now),
        )
    return outcome, replaced


def ingest_payload(conn: sqlite3.Connection, payload: Any, payload_bytes: int, channel: str,
                   store_raw: bool = True, source: str = SOURCE,
                   extra_flags: dict[str, Any] | None = None) -> BatchResult:
    """Ingest one HAE-format envelope. Raises EnvelopeError if the envelope itself is invalid.

    `source` and `extra_flags` let one-off importers (e.g. the Fitbod CSV backfill) reuse
    the same pipeline while keeping their records distinguishable and lower priority.
    """
    cur = conn.execute(
        "INSERT INTO ingestion_batches (received_at, channel, status, payload_bytes) VALUES (?, ?, 'processing', ?)",
        (_now(), channel, payload_bytes),
    )
    result = BatchResult(batch_id=cur.lastrowid, status="processing")

    try:
        workouts, metrics, result.other_counts = extract_envelope(payload)
    except EnvelopeError as exc:
        result.status = "failed"
        result.errors.append({"field": "envelope", "message": str(exc)})
        _finish_batch(conn, result)
        raise

    result.received = len(workouts)
    conn.execute("BEGIN IMMEDIATE")
    try:
        for index, raw in enumerate(workouts):
            source_id = raw.get("id") if isinstance(raw, dict) and isinstance(raw.get("id"), str) else None
            try:
                normalized = normalize_workout(raw)
                if extra_flags:
                    normalized.flags.update(extra_flags)
            except WorkoutValidationError as exc:
                result.failed += 1
                result.errors.append({"index": index, "workout_id": source_id, "field": exc.field, "message": exc.message})
                continue
            conn.execute("SAVEPOINT workout")
            try:
                outcome, replaced = _upsert_workout(conn, normalized, raw, result.batch_id, store_raw, source)
                conn.execute("RELEASE workout")
            except sqlite3.Error as exc:
                conn.execute("ROLLBACK TO workout")
                conn.execute("RELEASE workout")
                result.failed += 1
                result.errors.append({"index": index, "workout_id": source_id, "field": "database",
                                      "message": type(exc).__name__})
                continue
            if outcome == "duplicate":
                result.duplicates += 1
            else:
                setattr(result, outcome, getattr(result, outcome) + 1)
            result.replaced += replaced
        _ingest_metrics(conn, metrics, result)
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        result.status = "failed"
        result.failed = result.received
        result.inserted = result.updated = result.unchanged = 0
        result.errors.append({"field": "batch", "message": "unexpected error; batch rolled back"})
        _finish_batch(conn, result)
        raise

    units_in = result.received + len(metrics)
    units_failed = result.failed + result.metrics_failed
    if units_in == 0:
        result.status = "empty"
    elif units_failed == 0:
        result.status = "succeeded"
    elif units_failed == units_in:
        result.status = "failed"
    else:
        result.status = "partial"
    _finish_batch(conn, result)
    log.info("batch %s (%s): %s workouts received=%d inserted=%d updated=%d unchanged=%d failed=%d "
             "metrics types=%d samples=%d stored=%d failed=%d bytes=%d",
             result.batch_id, channel, result.status, result.received, result.inserted, result.updated,
             result.unchanged, result.failed, len(metrics), result.metric_samples_received,
             result.metric_samples_stored, result.metrics_failed, payload_bytes)
    return result


def _ingest_metrics(conn: sqlite3.Connection, metrics: list[Any], result: BatchResult) -> None:
    now = _now()
    for index, raw in enumerate(metrics):
        try:
            name, samples, skipped = normalize_metric(raw)
        except MetricValidationError as exc:
            result.metrics_failed += 1
            result.errors.append({"index": index, "field": f"metrics.{exc.field}", "message": exc.message})
            continue
        result.metric_samples_received += len(samples) + skipped
        result.metric_samples_skipped += skipped
        if name not in result.metric_types:
            result.metric_types.append(name)
        conn.execute("SAVEPOINT metric")
        try:
            result.metric_samples_stored += store_samples(conn, name, samples, result.batch_id, now)
            conn.execute("RELEASE metric")
        except sqlite3.Error as exc:
            conn.execute("ROLLBACK TO metric")
            conn.execute("RELEASE metric")
            result.metrics_failed += 1
            result.errors.append({"index": index, "metric": name, "field": "database",
                                  "message": type(exc).__name__})


def _finish_batch(conn: sqlite3.Connection, r: BatchResult) -> None:
    conn.execute(
        "UPDATE ingestion_batches SET finished_at = ?, status = ?, workouts_received = ?, inserted = ?, updated = ?, "
        "unchanged = ?, failed = ?, metric_samples_received = ?, metric_samples_stored = ?, other_counts = ?, "
        "errors = ? WHERE id = ?",
        (_now(), r.status, r.received, r.inserted, r.updated, r.unchanged, r.failed, r.metric_samples_received,
         r.metric_samples_stored, json.dumps(r.other_counts), json.dumps(r.errors[:100]), r.batch_id),
    )
