"""Convert one Health Auto Export Version 2 workout object into the canonical model.

Required (per HAE docs): id, name, start, end, duration. Everything else is
optional and only populated when present. Unknown fields are not rejected:
  - {qty, units} objects        -> extra_metrics (converted to canonical units)
  - arrays of {date, qty|Avg}   -> time-series metrics
  - scalars (strokeStyle, ...)  -> extra_metrics as-is

Error messages name fields, never values, so they are safe to log and store.
"""
import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any

from .timeparse import offset_minutes, parse_timestamp
from .units import convert

SOURCE = "health_auto_export"

# Activity categories in match order; first keyword hit wins.
_CATEGORY_KEYWORDS: list[tuple[str, tuple[str, ...]]] = [
    ("run", ("run", "jog")),
    ("walk", ("walk",)),
    ("hike", ("hik",)),
    ("cycle", ("cycl", "bik")),
    ("swim", ("swim",)),
    ("row", ("row",)),
    ("strength", ("strength", "weight", "functional", "core training")),
    ("hiit", ("hiit", "interval", "cross training", "crossfit", "kickboxing", "boxing")),
    ("mobility", ("yoga", "pilates", "stretch", "flexibility", "mind", "cooldown", "barre", "tai chi")),
    ("cardio", ("elliptical", "stair", "step", "dance", "jump", "cardio")),
    ("sport", ("ball", "tennis", "golf", "hockey", "soccer", "rugby", "cricket", "squash", "badminton",
               "volleyball", "climb", "ski", "snowboard", "skat", "surf", "paddl", "martial")),
]

# Categories where distance, pace and speed are meaningful.
DISTANCE_CATEGORIES = frozenset({"run", "walk", "hike", "cycle", "swim", "row"})

_CORE_QTY = {
    "distance": ("distance_m", "m"),
    "activeEnergyBurned": ("active_energy_kcal", "kcal"),
    "totalEnergy": ("total_energy_kcal", "kcal"),
    "elevationUp": ("elevation_up_m", "m"),
    "elevationDown": ("elevation_down_m", "m"),
}

_SERIES_NAMES = {"heartRateData": "heart_rate", "heartRateRecovery": "heart_rate_recovery"}

_HANDLED_KEYS = {"id", "name", "start", "end", "duration", "location", "isIndoor", "heartRate",
                 "avgHeartRate", "maxHeartRate", "minHeartRate", "route", "metadata", "source", *_CORE_QTY}


class WorkoutValidationError(ValueError):
    def __init__(self, field_name: str, message: str):
        super().__init__(f"{field_name}: {message}")
        self.field = field_name
        self.message = message


@dataclass
class MetricSample:
    ts: datetime
    value: float
    unit: str
    value_min: float | None = None
    value_max: float | None = None
    source: str | None = None


@dataclass
class RoutePoint:
    ts: datetime
    latitude: float
    longitude: float
    altitude_m: float | None = None
    speed_mps: float | None = None
    course_deg: float | None = None
    h_acc_m: float | None = None
    v_acc_m: float | None = None


@dataclass
class NormalizedWorkout:
    source_workout_id: str
    activity_label: str
    activity_type: str
    activity_category: str
    start: datetime
    end: datetime
    duration_s: float
    summary: dict[str, float | None] = field(default_factory=dict)
    location: str | None = None
    is_indoor: bool | None = None
    source_app: str | None = None        # app that recorded it, e.g. "Fitbod"
    extra_metrics: dict[str, Any] = field(default_factory=dict)
    source_units: dict[str, str] = field(default_factory=dict)
    source_metadata: dict[str, Any] = field(default_factory=dict)
    metrics: dict[str, list[MetricSample]] = field(default_factory=dict)
    route: list[RoutePoint] = field(default_factory=list)
    flags: dict[str, Any] = field(default_factory=dict)

    @property
    def utc_offset_minutes(self) -> int:
        return offset_minutes(self.start)

    @property
    def start_local_date(self) -> str:
        return self.start.date().isoformat()


def slugify(label: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", label.lower()).strip("_") or "unknown"


def snake_case(key: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", "_", key).lower()


def categorize(label: str) -> str:
    lowered = label.lower()
    for category, keywords in _CATEGORY_KEYWORDS:
        if any(k in lowered for k in keywords):
            return category
    return "other"


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def _quantity(obj: Any) -> tuple[float, str | None, str | None] | None:
    """Return (canonical value, canonical unit, source unit) for a {qty, units} object."""
    if not isinstance(obj, dict):
        return None
    qty = _number(obj.get("qty"))
    if qty is None:
        return None
    source_unit = obj.get("units") if isinstance(obj.get("units"), str) else None
    value, unit = convert(qty, source_unit)
    return value, unit, source_unit


def _is_series(value: Any) -> bool:
    return isinstance(value, list) and bool(value) and all(isinstance(v, dict) and "date" in v for v in value)


def _parse_series(samples: list[dict]) -> tuple[list[MetricSample], int]:
    parsed: list[MetricSample] = []
    skipped = 0
    for sample in samples:
        value = _number(sample.get("qty"))
        if value is None:
            value = _number(sample.get("Avg"))
        try:
            ts = parse_timestamp(sample.get("date"))
        except ValueError:
            ts = None
        if value is None or ts is None:
            skipped += 1
            continue
        raw_unit = sample.get("units") if isinstance(sample.get("units"), str) else None
        value, unit = convert(value, raw_unit)
        vmin, vmax = _number(sample.get("Min")), _number(sample.get("Max"))
        if vmin is not None:
            vmin = convert(vmin, raw_unit)[0]
        if vmax is not None:
            vmax = convert(vmax, raw_unit)[0]
        source = sample.get("source") if isinstance(sample.get("source"), str) else None
        parsed.append(MetricSample(ts=ts, value=value, unit=unit or "unknown",
                                   value_min=vmin, value_max=vmax, source=source))
    return parsed, skipped


def _parse_route(points: Any) -> tuple[list[RoutePoint], int]:
    if not isinstance(points, list):
        return [], 0
    parsed: list[RoutePoint] = []
    skipped = 0
    for p in points:
        if not isinstance(p, dict):
            skipped += 1
            continue
        lat, lon = _number(p.get("latitude")), _number(p.get("longitude"))
        try:
            ts = parse_timestamp(p.get("timestamp"))
        except ValueError:
            ts = None
        if lat is None or lon is None or ts is None or not (-90 <= lat <= 90 and -180 <= lon <= 180):
            skipped += 1
            continue
        parsed.append(RoutePoint(
            ts=ts, latitude=lat, longitude=lon,
            altitude_m=_number(p.get("altitude")),
            speed_mps=_number(p.get("speed")),
            course_deg=_number(p.get("course")),
            h_acc_m=_number(p.get("horizontalAccuracy")),
            v_acc_m=_number(p.get("verticalAccuracy")),
        ))
    return parsed, skipped


def normalize_workout(raw: Any) -> NormalizedWorkout:
    if not isinstance(raw, dict):
        raise WorkoutValidationError("workout", "expected an object")

    workout_id = raw.get("id")
    if not isinstance(workout_id, str) or not workout_id.strip():
        raise WorkoutValidationError("id", "missing; Health Auto Export 'Export Version 2' is required")
    label = raw.get("name")
    if not isinstance(label, str) or not label.strip():
        raise WorkoutValidationError("name", "missing or not a string")
    try:
        start = parse_timestamp(raw.get("start"))
    except ValueError as exc:
        raise WorkoutValidationError("start", str(exc)) from None
    try:
        end = parse_timestamp(raw.get("end"))
    except ValueError as exc:
        raise WorkoutValidationError("end", str(exc)) from None
    if end < start:
        raise WorkoutValidationError("end", "is before start")

    flags: dict[str, Any] = {}
    duration = _number(raw.get("duration"))
    if duration is None:
        duration = (end - start).total_seconds()
        flags["duration_derived_from_timestamps"] = True
    elif duration < 0:
        raise WorkoutValidationError("duration", "is negative")

    label = label.strip()
    w = NormalizedWorkout(
        source_workout_id=workout_id.strip(),
        activity_label=label,
        activity_type=slugify(label),
        activity_category=categorize(label),
        start=start,
        end=end,
        duration_s=duration,
        flags=flags,
    )

    for key, (column, _) in _CORE_QTY.items():
        q = _quantity(raw.get(key))
        w.summary[column] = q[0] if q else None
        if q and q[2]:
            w.source_units[key] = q[2]

    hr = raw.get("heartRate") if isinstance(raw.get("heartRate"), dict) else {}
    for stat, fallback_key in (("min", "minHeartRate"), ("avg", "avgHeartRate"), ("max", "maxHeartRate")):
        q = _quantity(hr.get(stat)) or _quantity(raw.get(fallback_key))
        w.summary[f"hr_{stat}_bpm"] = q[0] if q else None

    if isinstance(raw.get("location"), str):
        w.location = raw["location"]
    if isinstance(raw.get("isIndoor"), bool):
        w.is_indoor = raw["isIndoor"]
    elif w.location:
        w.is_indoor = w.location in ("Indoor", "Pool")
    src = raw.get("source")
    if isinstance(src, dict) and isinstance(src.get("name"), str) and src["name"].strip():
        w.source_app = src["name"].strip()
    elif isinstance(src, str) and src.strip():
        w.source_app = src.strip()
    if isinstance(raw.get("metadata"), dict):
        w.source_metadata = raw["metadata"]

    skipped_samples = 0
    for key, value in raw.items():
        if key in _HANDLED_KEYS:
            continue
        if _is_series(value):
            samples, skipped = _parse_series(value)
            skipped_samples += skipped
            if samples:
                w.metrics[_SERIES_NAMES.get(key, snake_case(key))] = samples
        elif isinstance(value, dict) and "qty" in value:
            q = _quantity(value)
            if q:
                w.extra_metrics[snake_case(key)] = {"value": q[0], "unit": q[1]}
                if q[2]:
                    w.source_units[key] = q[2]
        elif isinstance(value, (str, int, float, bool)):
            w.extra_metrics[snake_case(key)] = {"value": value}

    route, skipped_points = _parse_route(raw.get("route"))
    w.route = route
    if skipped_samples:
        w.flags["skipped_metric_samples"] = skipped_samples
    if skipped_points:
        w.flags["skipped_route_points"] = skipped_points

    # Known HAE issue: heartRateData sometimes holds the post-workout recovery
    # series instead of the in-workout trace. If every sample is at/after the
    # workout end, store it as recovery data and flag the workout.
    hr_series = w.metrics.get("heart_rate")
    if hr_series and min(s.ts for s in hr_series) >= end - timedelta(seconds=1):
        recovery = w.metrics.pop("heart_rate")
        w.metrics.setdefault("heart_rate_recovery", recovery)
        w.flags["heart_rate_data_was_recovery"] = True

    return w
