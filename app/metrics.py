"""Health Auto Export health metrics: normalization, storage and daily aggregation.

HAE sends `data.metrics` as a list of {name, units, data: [{date, qty|Avg, Min, Max, source}]}.
Samples are stored as received (canonical units) and aggregated per local day on read:
- cumulative metrics (steps, distance, energy, flights, ...) are summed,
- body measurements (weight, body fat, ...) use the day's latest reading,
- everything else is averaged.

Deduplication: one row per (metric, timestamp, source). Re-sent samples update the
stored value, so overlapping exports never double-count.

Use "Summarize Data: On, Time Grouping: Day" in HAE. Summarized values come from
HealthKit statistics, which already de-duplicate overlapping iPhone/Watch samples;
raw (unsummarized) samples from several devices can overlap and inflate daily sums.
"""
import re
import sqlite3
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from .timeparse import parse_timestamp, to_utc_text
from .units import convert

CUMULATIVE = frozenset({
    "step_count", "walking_running_distance", "active_energy", "basal_energy_burned", "flights_climbed",
    "apple_exercise_time", "apple_stand_time", "apple_stand_hour", "cycling_distance", "swimming_distance",
    "swimming_stroke_count", "distance_downhill_snow_sports", "push_count", "wheelchair_distance",
    "time_in_daylight", "dietary_energy", "dietary_water",
})
LATEST = frozenset({
    "weight_body_mass", "body_fat_percentage", "body_mass_index", "lean_body_mass", "height", "vo2_max",
    "waist_circumference",
})


class MetricValidationError(ValueError):
    def __init__(self, field_name: str, message: str):
        super().__init__(f"{field_name}: {message}")
        self.field = field_name
        self.message = message


@dataclass
class HealthSample:
    ts: datetime
    value: float
    unit: str
    source_unit: str | None
    value_min: float | None = None
    value_max: float | None = None
    source: str = ""


def metric_slug(name: str) -> str:
    """'weight_&_body_mass' -> 'weight_body_mass'; 'Step Count' -> 'step_count'."""
    return re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")


def aggregation_for(metric: str) -> str:
    if metric in CUMULATIVE:
        return "sum"
    if metric in LATEST:
        return "latest"
    return "avg"


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def normalize_metric(raw: Any) -> tuple[str, list[HealthSample], int]:
    """Return (metric slug, samples, skipped sample count)."""
    if not isinstance(raw, dict):
        raise MetricValidationError("metric", "expected an object")
    name = raw.get("name")
    if not isinstance(name, str) or not metric_slug(name):
        raise MetricValidationError("name", "missing or not a string")
    data = raw.get("data")
    if not isinstance(data, list):
        raise MetricValidationError("data", "missing or not an array")
    metric_unit = raw.get("units") if isinstance(raw.get("units"), str) else None

    samples: list[HealthSample] = []
    skipped = 0
    for s in data:
        if not isinstance(s, dict):
            skipped += 1
            continue
        value = _number(s.get("qty"))
        if value is None:
            value = _number(s.get("Avg"))
        try:
            ts = parse_timestamp(s.get("date"))
        except ValueError:
            ts = None
        if value is None or ts is None:
            skipped += 1
            continue
        source_unit = s.get("units") if isinstance(s.get("units"), str) else metric_unit
        value, unit = convert(value, source_unit)
        vmin, vmax = _number(s.get("Min")), _number(s.get("Max"))
        samples.append(HealthSample(
            ts=ts, value=value, unit=unit or "unknown", source_unit=source_unit,
            value_min=None if vmin is None else convert(vmin, source_unit)[0],
            value_max=None if vmax is None else convert(vmax, source_unit)[0],
            source=s.get("source") if isinstance(s.get("source"), str) else "",
        ))
    return metric_slug(name), samples, skipped


def store_samples(conn: sqlite3.Connection, metric: str, samples: list[HealthSample], batch_id: int, now: str) -> int:
    conn.executemany(
        "INSERT INTO health_metric_samples (metric, ts_utc, local_date, value, value_min, value_max, unit, "
        "source_unit, source, last_batch_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
        "ON CONFLICT(metric, ts_utc, source) DO UPDATE SET value = excluded.value, value_min = excluded.value_min, "
        "value_max = excluded.value_max, unit = excluded.unit, source_unit = excluded.source_unit, "
        "local_date = excluded.local_date, last_batch_id = excluded.last_batch_id, updated_at = excluded.updated_at",
        [(metric, to_utc_text(s.ts), s.ts.date().isoformat(), s.value, s.value_min, s.value_max, s.unit,
          s.source_unit, s.source, batch_id, now) for s in samples],
    )
    return len(samples)


# ---- read side --------------------------------------------------------------

def available(conn: sqlite3.Connection) -> dict[str, Any]:
    rows = conn.execute(
        "SELECT metric, COUNT(*) AS n, MIN(local_date) AS first, MAX(local_date) AS last, MIN(unit) AS unit "
        "FROM health_metric_samples GROUP BY metric ORDER BY metric").fetchall()
    return {"metrics": [{"metric": r["metric"], "samples": r["n"], "first_date": r["first"], "last_date": r["last"],
                         "unit": r["unit"], "aggregation": aggregation_for(r["metric"])} for r in rows]}


def daily(conn: sqlite3.Connection, metrics: list[str], date_from: str, date_to: str) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for metric in metrics:
        agg = aggregation_for(metric)
        if agg == "latest":
            sql = ("SELECT local_date AS d, value AS v, unit FROM health_metric_samples s "
                   "WHERE metric = ? AND local_date >= ? AND local_date < ? AND ts_utc = ("
                   "  SELECT MAX(ts_utc) FROM health_metric_samples WHERE metric = s.metric AND local_date = s.local_date) "
                   "GROUP BY local_date ORDER BY local_date")
        else:
            fn = "SUM" if agg == "sum" else "AVG"
            sql = (f"SELECT local_date AS d, {fn}(value) AS v, MIN(unit) AS unit FROM health_metric_samples "
                   "WHERE metric = ? AND local_date >= ? AND local_date < ? GROUP BY local_date ORDER BY local_date")
        rows = conn.execute(sql, (metric, date_from, date_to)).fetchall()
        source_unit = conn.execute(
            "SELECT source_unit FROM health_metric_samples WHERE metric = ? ORDER BY ts_utc DESC LIMIT 1",
            (metric,)).fetchone()
        result[metric] = {
            "aggregation": agg,
            "unit": rows[0]["unit"] if rows else None,
            "source_unit": source_unit[0] if source_unit else None,
            "days": [{"date": r["d"], "value": round(r["v"], 3)} for r in rows],
        }
    return {"from": date_from, "to": date_to, "metrics": result}
