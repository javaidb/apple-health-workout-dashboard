import copy
import json
import sqlite3

from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app

INGEST = "/api/v1/ingest/health-auto-export"


def post(client, payload, headers):
    return client.post(INGEST, content=json.dumps(payload), headers={**headers, "Content-Type": "application/json"})


def db(settings) -> sqlite3.Connection:
    conn = sqlite3.connect(settings.db_path)
    conn.row_factory = sqlite3.Row
    return conn


def count(settings, table, where="1=1", params=()):
    with db(settings) as conn:
        return conn.execute(f"SELECT COUNT(*) FROM {table} WHERE {where}", params).fetchone()[0]


# ---- security and request validation ------------------------------------

def test_ingest_requires_token(client, batch):
    assert post(client, batch, {}).status_code == 401
    r = post(client, batch, {"Authorization": "Bearer wrong"})
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "unauthorized"


def test_repeated_bad_tokens_are_locked_out(client, batch, auth):
    for _ in range(10):
        post(client, batch, {"Authorization": "Bearer wrong"})
    assert post(client, batch, {"Authorization": "Bearer wrong"}).status_code == 429
    assert post(client, batch, auth).status_code == 429


def test_ingest_rejects_wrong_content_type(client, auth):
    r = client.post(INGEST, content="a,b,c", headers={**auth, "Content-Type": "text/csv"})
    assert r.status_code == 415


def test_ingest_rejects_oversized_payload(tmp_path, batch, auth):
    small = Settings(data_dir=tmp_path, ingest_token="test-token-123", max_body_bytes=1024,
                     local_clients=frozenset({"testclient"}))
    r = post(TestClient(create_app(small)), batch, auth)
    assert r.status_code == 413


def test_ingest_rejects_invalid_json_and_envelope(client, auth, settings):
    r = client.post(INGEST, content="{not json", headers={**auth, "Content-Type": "application/json"})
    assert r.status_code == 400
    r = post(client, {"hello": "world"}, auth)
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "invalid_envelope"
    assert count(settings, "ingestion_batches", "status = 'failed'") == 1


def test_dashboard_api_is_local_only(tmp_path, batch, auth):
    remote = TestClient(create_app(Settings(data_dir=tmp_path, ingest_token="test-token-123",
                                            local_clients=frozenset({"127.0.0.1"}))))
    assert remote.get("/api/v1/workouts").status_code == 403
    assert remote.get("/api/v1/workouts", headers=auth).status_code == 200
    assert post(remote, batch, auth).status_code == 200  # phone can still push


# ---- ingestion and idempotency -------------------------------------------

def test_ingest_batch(client, batch, auth, settings):
    r = post(client, batch, auth)
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "succeeded"
    assert body["workouts"] == {"received": 3, "inserted": 3, "updated": 0, "unchanged": 0, "failed": 0}
    assert body["metrics"]["types"] == ["step_count"] and body["metrics"]["samples_stored"] == 1
    assert body["ignored_data_types"] == {}
    assert count(settings, "workouts") == 3
    assert count(settings, "workout_metrics") == 3 + 2 + 2 + 2 + 2
    assert count(settings, "workout_route_points") == 3
    assert count(settings, "raw_workout_payloads") == 3


def test_reimport_is_idempotent(client, batch, auth, settings):
    post(client, batch, auth)
    r = post(client, batch, auth)
    assert r.json()["workouts"]["unchanged"] == 3
    assert count(settings, "workouts") == 3
    assert count(settings, "workout_metrics") == 11
    assert count(settings, "workout_route_points") == 3


def test_changed_workout_updates_and_replaces_series_without_duplicates(client, batch, auth, settings):
    post(client, batch, auth)
    changed = copy.deepcopy(batch)
    run = changed["data"]["workouts"][0]
    run["activeEnergyBurned"]["qty"] = 620.0
    run["heartRateData"] = run["heartRateData"][:2] + [
        {"date": "2026-10-14 07:06:00 -0400", "Min": 150, "Avg": 155, "Max": 160, "units": "bpm"},
        {"date": "2026-10-14 07:07:00 -0400", "Min": 152, "Avg": 157, "Max": 163, "units": "bpm"},
    ]
    del run["route"]          # export without route data must not delete stored route
    del run["totalEnergy"]    # absent summary field keeps stored value
    r = post(client, changed, auth)
    assert r.json()["workouts"] == {"received": 3, "inserted": 0, "updated": 1, "unchanged": 2, "failed": 0}
    with db(settings) as conn:
        w = conn.execute("SELECT * FROM workouts WHERE activity_type = 'outdoor_run'").fetchone()
        assert w["active_energy_kcal"] == 620.0
        assert w["total_energy_kcal"] == 701.9
        assert w["first_batch_id"] == 1 and w["last_batch_id"] == 2
    assert count(settings, "workout_metrics", "metric_type = 'heart_rate' AND workout_id = 1") == 4
    assert count(settings, "workout_route_points") == 3


def test_partial_batch_keeps_valid_workouts(client, batch, auth, settings):
    batch["data"]["workouts"][1]["start"] = "bogus"
    batch["data"]["workouts"].append("not an object")
    r = post(client, batch, auth)
    body = r.json()
    assert r.status_code == 200
    assert body["status"] == "partial"
    assert body["workouts"]["inserted"] == 2 and body["workouts"]["failed"] == 2
    assert {e["field"] for e in body["errors"]} == {"start", "workout"}
    assert "bogus" not in json.dumps(body)
    assert count(settings, "workouts") == 2


def test_all_failed_batch_returns_422(client, auth):
    r = post(client, {"data": {"workouts": [{"name": "Running"}]}}, auth)
    assert r.status_code == 422
    assert r.json()["status"] == "failed"


def test_empty_workouts_array_is_ok(client, auth):
    r = post(client, {"data": {"workouts": []}}, auth)
    assert r.status_code == 200
    assert r.json()["status"] == "empty"


def test_manual_import_endpoint(client, batch):
    r = client.post("/api/v1/import", content=json.dumps(batch), headers={"Content-Type": "application/json"})
    assert r.status_code == 200
    assert r.json()["workouts"]["inserted"] == 3


# ---- query API -----------------------------------------------------------

def test_list_workouts_by_local_date_range(client, batch, auth):
    post(client, batch, auth)
    r = client.get("/api/v1/workouts", params={"from": "2026-10-15", "to": "2026-10-16", "sort": "start"})
    body = r.json()
    assert body["total"] == 2  # late-night walk counts on the 15th (local), not the 16th (UTC)
    assert [w["activity"]["type"] for w in body["items"]] == ["traditional_strength_training", "outdoor_walk"]


def test_list_workouts_filters_sort_and_paginate(client, batch, auth):
    post(client, batch, auth)
    r = client.get("/api/v1/workouts", params={"sort": "-duration", "limit": 1})
    body = r.json()
    assert body["total"] == 3 and len(body["items"]) == 1
    assert body["items"][0]["activity"]["type"] == "traditional_strength_training"
    r = client.get("/api/v1/workouts", params={"category": "run"})
    assert r.json()["total"] == 1
    assert client.get("/api/v1/workouts", params={"from": "10/14/2026"}).status_code == 422
    assert client.get("/api/v1/workouts", params={"limit": 5000}).status_code == 422


def test_workout_detail_metrics_route(client, batch, auth):
    post(client, batch, auth)
    run = client.get("/api/v1/workouts", params={"category": "run"}).json()["items"][0]
    assert run["distance_m"] == 8420.0
    assert run["avg_pace_s_per_km"] == round(2790 / 8.42, 1)
    assert run["heart_rate_bpm"] == {"min": 98, "avg": 152, "max": 176}

    detail = client.get(f"/api/v1/workouts/{run['id']}").json()
    assert detail["metrics_available"]["heart_rate"] == {"samples": 3, "unit": "bpm"}
    assert detail["route_points"] == 3
    assert detail["extra_metrics"]["humidity"] == {"value": 71, "unit": "%"}
    assert "payload" not in json.dumps(detail).lower()

    metrics = client.get(f"/api/v1/workouts/{run['id']}/metrics", params={"type": "heart_rate"}).json()
    assert list(metrics["series"]) == ["heart_rate"]
    assert metrics["series"]["heart_rate"]["samples"][0] == {"t": "2026-10-14T11:03:00.000Z", "v": 121, "min": 98, "max": 134}

    route = client.get(f"/api/v1/workouts/{run['id']}/route").json()
    assert len(route["points"]) == 3

    assert client.get("/api/v1/workouts/999").status_code == 404


def test_strength_workout_hides_distance_metrics(client, batch, auth):
    post(client, batch, auth)
    w = client.get("/api/v1/workouts", params={"category": "strength"}).json()["items"][0]
    assert w["distance_m"] is None and w["avg_pace_s_per_km"] is None


def test_delete_workout_cascades(client, batch, auth, settings):
    post(client, batch, auth)
    assert client.delete("/api/v1/workouts/1").status_code == 204
    assert count(settings, "workout_metrics", "workout_id = 1") == 0
    assert count(settings, "workout_route_points") == 0
    assert count(settings, "raw_workout_payloads", "workout_id = 1") == 0
    assert client.delete("/api/v1/workouts/1").status_code == 404


def test_status_reports_freshness(client, batch, auth):
    assert client.get("/api/v1/status").json()["workouts"] == 0
    post(client, batch, auth)
    s = client.get("/api/v1/status").json()
    assert s["workouts"] == 3
    assert s["first_workout_date"] == "2026-10-14" and s["last_workout_date"] == "2026-10-15"
    assert s["last_successful_sync"] is not None
    assert s["last_batch"]["inserted"] == 3


def test_dashboard_files_are_revalidated_not_cached(client):
    for path in ("/", "/app.js", "/style.css"):
        assert client.get(path).headers["cache-control"] == "no-cache"
    assert "no-cache" not in client.get("/api/v1/health").headers.get("cache-control", "")


def test_source_app_is_returned(client, batch, auth):
    batch["data"]["workouts"][1]["source"] = {"name": "Fitbod", "identifier": "com.fitbod"}
    post(client, batch, auth)
    items = client.get("/api/v1/workouts", params={"sort": "start"}).json()["items"]
    assert [w["source_app"] for w in items] == [None, "Fitbod", None]
