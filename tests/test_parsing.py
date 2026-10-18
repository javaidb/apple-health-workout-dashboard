from datetime import timedelta

import pytest

from app.normalize import WorkoutValidationError, categorize, normalize_workout, slugify
from app.timeparse import offset_minutes, parse_timestamp, to_utc_text
from app.units import convert


# ---- timestamps ----------------------------------------------------------

@pytest.mark.parametrize("text, utc, offset", [
    ("2026-10-14 07:02:11 -0400", "2026-10-14T11:02:11.000Z", -240),
    ("2024-02-06 07:00:00 -0800", "2024-02-06T15:00:00.000Z", -480),
    ("2026-03-29 01:30:00 +0100", "2026-03-29T00:30:00.000Z", 60),
    ("2026-10-14T07:02:11-04:00", "2026-10-14T11:02:11.000Z", -240),
    ("2026-10-14T11:02:11.250Z", "2026-10-14T11:02:11.250Z", 0),
    ("2026-10-14 05:45:00 +0545", "2026-10-14T00:00:00.000Z", 345),
])
def test_parse_timestamp_formats(text, utc, offset):
    dt = parse_timestamp(text)
    assert to_utc_text(dt) == utc
    assert offset_minutes(dt) == offset


@pytest.mark.parametrize("bad", ["2026-10-14 07:02:11", "yesterday", "", None, 1697270531])
def test_parse_timestamp_rejects_naive_or_garbage(bad):
    with pytest.raises(ValueError):
        parse_timestamp(bad)


def test_utc_text_sorts_chronologically():
    a = to_utc_text(parse_timestamp("2026-10-14T11:02:11Z"))
    b = to_utc_text(parse_timestamp("2026-10-14T11:02:11.500Z"))
    assert a < b


# ---- units ---------------------------------------------------------------

@pytest.mark.parametrize("qty, unit, expected, canonical", [
    (1, "mi", 1609.344, "m"),
    (8.42, "km", 8420, "m"),
    (100, "ft", 30.48, "m"),
    (500, "yd", 457.2, "m"),
    (10, "mph", 4.4704, "m/s"),
    (36, "kmph", 10, "m/s"),
    (418.4, "kJ", 100, "kcal"),
    (212, "degF", 100, "degC"),
    (152, "bpm", 152, "bpm"),
    (9.8, "MET", 9.8, "MET"),
])
def test_convert(qty, unit, expected, canonical):
    value, unit_out = convert(qty, unit)
    assert value == pytest.approx(expected)
    assert unit_out == canonical


# ---- normalization -------------------------------------------------------

def test_normalize_full_run(batch):
    w = normalize_workout(batch["data"]["workouts"][0])
    assert w.activity_type == "outdoor_run"
    assert w.activity_category == "run"
    assert w.duration_s == 2790
    assert w.summary["distance_m"] == pytest.approx(8420)
    assert w.summary["elevation_down_m"] == 0  # real zero, not missing
    assert w.summary["hr_avg_bpm"] == 152
    assert w.is_indoor is False
    assert w.extra_metrics["temperature"] == {"value": 9, "unit": "degC"}
    assert w.extra_metrics["intensity"] == {"value": 9.8, "unit": "MET"}
    assert w.source_units["distance"] == "km"
    assert set(w.metrics) == {"heart_rate", "heart_rate_recovery", "step_count", "walking_and_running_distance"}
    hr = w.metrics["heart_rate"][0]
    assert (hr.value, hr.value_min, hr.value_max, hr.unit) == (121, 98, 134, "bpm")
    assert w.metrics["walking_and_running_distance"][0].value == pytest.approx(180)
    assert len(w.route) == 3 and w.route[0].speed_mps == 2.9
    assert w.flags == {}


def test_normalize_minimal_workout_missing_fields_are_none(batch):
    w = normalize_workout(batch["data"]["workouts"][1])
    assert w.activity_category == "strength"
    assert w.summary["distance_m"] is None
    assert w.summary["total_energy_kcal"] is None
    assert w.route == []
    assert w.is_indoor is True  # derived from location "Indoor"


def test_normalize_imperial_units_and_local_date(batch):
    w = normalize_workout(batch["data"]["workouts"][2])
    assert w.summary["distance_m"] == pytest.approx(1.9 * 1609.344)
    assert w.summary["elevation_up_m"] == pytest.approx(9.144)
    assert w.start_local_date == "2026-10-15"  # 23:30 local, already the 16th in UTC
    assert to_utc_text(w.start).startswith("2026-10-16")


def test_version1_payload_rejected_with_clear_error():
    v1 = {"name": "Running", "start": "2026-10-14 07:00:00 -0400", "end": "2026-10-14 07:30:00 -0400"}
    with pytest.raises(WorkoutValidationError) as exc:
        normalize_workout(v1)
    assert exc.value.field == "id"
    assert "Version 2" in exc.value.message


@pytest.mark.parametrize("field, value", [("start", "not a date"), ("end", "2026-10-14 06:00:00 -0400"),
                                          ("duration", -5), ("name", None)])
def test_invalid_required_fields(batch, field, value):
    raw = batch["data"]["workouts"][1]
    raw[field] = value
    with pytest.raises(WorkoutValidationError) as exc:
        normalize_workout(raw)
    assert exc.value.field == field


def test_error_messages_do_not_leak_values(batch):
    raw = batch["data"]["workouts"][1]
    raw["start"] = "SECRET-VALUE"
    with pytest.raises(WorkoutValidationError) as exc:
        normalize_workout(raw)
    assert "SECRET-VALUE" not in str(exc.value)


def test_missing_duration_is_derived_and_flagged(batch):
    raw = batch["data"]["workouts"][1]
    del raw["duration"]
    w = normalize_workout(raw)
    assert w.duration_s == 52 * 60
    assert w.flags["duration_derived_from_timestamps"] is True


def test_heart_rate_data_that_is_actually_recovery_is_reclassified(batch):
    raw = batch["data"]["workouts"][1]
    end = parse_timestamp(raw["end"])
    raw["heartRateData"] = [
        {"date": (end + timedelta(seconds=s)).strftime("%Y-%m-%d %H:%M:%S %z"), "Avg": 140 - s // 10, "units": "bpm"}
        for s in (0, 30, 60)
    ]
    w = normalize_workout(raw)
    assert "heart_rate" not in w.metrics
    assert len(w.metrics["heart_rate_recovery"]) == 3
    assert w.flags["heart_rate_data_was_recovery"] is True


def test_bad_samples_and_points_are_skipped_not_fatal(batch):
    raw = batch["data"]["workouts"][0]
    raw["stepCount"].append({"date": "garbage", "qty": 10, "units": "count"})
    raw["route"].append({"latitude": 999, "longitude": 0, "timestamp": "2026-10-14 07:03:00 -0400"})
    w = normalize_workout(raw)
    assert len(w.metrics["step_count"]) == 2
    assert len(w.route) == 3
    assert w.flags == {"skipped_metric_samples": 1, "skipped_route_points": 1}


def test_unknown_fields_are_kept_generically(batch):
    raw = batch["data"]["workouts"][0]
    raw["cyclingPower"] = [{"date": "2026-10-14 07:03:00 -0400", "qty": 210, "units": "W"}]
    raw["strokeStyle"] = "Freestyle"
    raw["swimCadence"] = {"qty": 28, "units": "spm"}
    w = normalize_workout(raw)
    assert w.metrics["cycling_power"][0].unit == "W"
    assert w.extra_metrics["stroke_style"] == {"value": "Freestyle"}
    assert w.extra_metrics["swim_cadence"] == {"value": 28, "unit": "spm"}


@pytest.mark.parametrize("label, category", [
    ("Outdoor Run", "run"), ("Indoor Cycling", "cycle"), ("Pool Swim", "swim"), ("Hiking", "hike"),
    ("Functional Strength Training", "strength"), ("High Intensity Interval Training", "hiit"),
    ("Yoga", "mobility"), ("Rowing", "row"), ("Elliptical", "cardio"), ("Pickleball", "sport"),
    ("Something New", "other"),
])
def test_categorize(label, category):
    assert categorize(label) == category


def test_slugify():
    assert slugify("Traditional Strength Training") == "traditional_strength_training"
    assert slugify("Mind & Body") == "mind_body"


def test_source_app_is_captured(batch):
    raw = batch["data"]["workouts"][1]
    raw["source"] = {"name": "Fitbod", "identifier": "com.fitbod"}
    assert normalize_workout(raw).source_app == "Fitbod"
    del raw["source"]
    assert normalize_workout(raw).source_app is None
