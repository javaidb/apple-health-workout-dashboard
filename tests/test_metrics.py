import json

import pytest

from app.metrics import MetricValidationError, aggregation_for, metric_slug, normalize_metric

INGEST = "/api/v1/ingest/health-auto-export"


def post(client, payload, auth):
    return client.post(INGEST, content=json.dumps(payload), headers={**auth, "Content-Type": "application/json"})


def metrics_payload(*metrics):
    return {"data": {"metrics": list(metrics)}}


STEPS = {"name": "step_count", "units": "count", "data": [
    {"date": "2026-10-15 00:00:00 -0400", "qty": 9120, "source": "iPhone|Apple Watch"},
    {"date": "2026-10-16 00:00:00 -0400", "qty": 11450, "source": "iPhone|Apple Watch"},
]}
DISTANCE = {"name": "walking_running_distance", "units": "km", "data": [
    {"date": "2026-10-16 00:00:00 -0400", "qty": 8.2, "source": "iPhone|Apple Watch"},
]}
WEIGHT = {"name": "weight_&_body_mass", "units": "lb", "data": [
    {"date": "2026-10-16 07:10:00 -0400", "qty": 181.0, "source": "Scale"},
    {"date": "2026-10-16 21:30:00 -0400", "qty": 182.4, "source": "Scale"},
]}


# ---- normalization -------------------------------------------------------

def test_metric_slug_and_aggregation():
    assert metric_slug("weight_&_body_mass") == "weight_body_mass"
    assert aggregation_for("step_count") == "sum"
    assert aggregation_for("weight_body_mass") == "latest"
    assert aggregation_for("resting_heart_rate") == "avg"


def test_normalize_converts_units_and_keeps_source_unit():
    name, samples, skipped = normalize_metric(WEIGHT)
    assert name == "weight_body_mass" and skipped == 0
    assert samples[0].value == pytest.approx(181.0 * 0.45359237)
    assert (samples[0].unit, samples[0].source_unit) == ("kg", "lb")


def test_normalize_skips_bad_samples_and_reads_avg():
    raw = {"name": "heart_rate", "units": "count/min", "data": [
        {"date": "2026-10-16 08:00:00 -0400", "Min": 60, "Avg": 72, "Max": 90},
        {"date": "not a date", "qty": 1},
        {"date": "2026-10-16 09:00:00 -0400"},
    ]}
    name, samples, skipped = normalize_metric(raw)
    assert len(samples) == 1 and skipped == 2
    assert (samples[0].value, samples[0].value_min, samples[0].value_max) == (72, 60, 90)
    assert samples[0].source == ""


@pytest.mark.parametrize("raw, field", [({"units": "count", "data": []}, "name"), ({"name": "step_count"}, "data")])
def test_normalize_rejects_malformed_metric(raw, field):
    with pytest.raises(MetricValidationError) as exc:
        normalize_metric(raw)
    assert exc.value.field == field


# ---- ingestion -----------------------------------------------------------

def test_metrics_only_payload_is_stored(client, auth):
    r = post(client, metrics_payload(STEPS, DISTANCE, WEIGHT), auth)
    body = r.json()
    assert r.status_code == 200 and body["status"] == "succeeded"
    assert body["metrics"]["types"] == ["step_count", "walking_running_distance", "weight_body_mass"]
    assert body["metrics"]["samples_stored"] == 5
    assert body["workouts"]["received"] == 0


def test_metric_reimport_updates_instead_of_duplicating(client, auth):
    post(client, metrics_payload(STEPS), auth)
    revised = json.loads(json.dumps(STEPS))
    revised["data"][1]["qty"] = 12000  # day total grew since the last sync
    post(client, metrics_payload(revised), auth)
    d = client.get("/api/v1/metrics/daily", params={"names": "step_count", "from": "2026-10-01", "to": "2026-11-01"}).json()
    assert d["metrics"]["step_count"]["days"] == [{"date": "2026-10-15", "value": 9120}, {"date": "2026-10-16", "value": 12000}]


def test_malformed_metric_does_not_block_others(client, auth):
    r = post(client, metrics_payload(STEPS, {"name": "broken"}), auth)
    body = r.json()
    assert body["status"] == "partial"
    assert body["metrics"]["failed"] == 1 and body["metrics"]["samples_stored"] == 2


# ---- daily aggregation API -----------------------------------------------

def test_daily_sum_latest_and_units(client, auth):
    raw_steps = {"name": "step_count", "units": "count", "data": [
        {"date": "2026-10-16 08:00:00 -0400", "qty": 500, "source": "iPhone"},
        {"date": "2026-10-16 18:00:00 -0400", "qty": 700, "source": "iPhone"},
        {"date": "2026-10-16 23:30:00 -0400", "qty": 100, "source": "iPhone"},  # still the 16th locally
    ]}
    post(client, metrics_payload(raw_steps, DISTANCE, WEIGHT), auth)
    d = client.get("/api/v1/metrics/daily",
                   params={"names": "step_count,walking_running_distance,weight_body_mass",
                           "from": "2026-10-16", "to": "2026-10-17"}).json()["metrics"]
    assert d["step_count"]["days"] == [{"date": "2026-10-16", "value": 1300}]
    assert d["walking_running_distance"]["days"][0]["value"] == 8200
    assert d["walking_running_distance"]["unit"] == "m"
    w = d["weight_body_mass"]
    assert w["aggregation"] == "latest" and w["source_unit"] == "lb"
    assert w["days"][0]["value"] == pytest.approx(182.4 * 0.45359237, abs=1e-3)


def test_daily_unknown_metric_is_empty(client):
    d = client.get("/api/v1/metrics/daily", params={"names": "vo2_max", "from": "2026-10-01", "to": "2026-11-01"}).json()
    assert d["metrics"]["vo2_max"]["days"] == []


def test_daily_validates_params(client):
    assert client.get("/api/v1/metrics/daily", params={"names": "", "from": "2026-10-01", "to": "2026-11-01"}).status_code == 422
    assert client.get("/api/v1/metrics/daily", params={"names": "step_count", "from": "Oct 1", "to": "2026-11-01"}).status_code == 422


def test_metrics_listing(client, auth):
    post(client, metrics_payload(STEPS, WEIGHT), auth)
    listing = client.get("/api/v1/metrics").json()["metrics"]
    assert [m["metric"] for m in listing] == ["step_count", "weight_body_mass"]
    assert listing[0] == {"metric": "step_count", "samples": 2, "first_date": "2026-10-15", "last_date": "2026-10-16",
                          "unit": "count", "aggregation": "sum"}


def test_dashboard_metric_endpoints_are_local_only(tmp_path):
    from fastapi.testclient import TestClient

    from app.config import Settings
    from app.main import create_app
    remote = TestClient(create_app(Settings(data_dir=tmp_path, ingest_token="t", local_clients=frozenset({"127.0.0.1"}))))
    assert remote.get("/api/v1/metrics").status_code == 403
