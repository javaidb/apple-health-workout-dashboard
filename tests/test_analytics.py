import json
from datetime import date, timedelta

from app.analytics import day_streaks, week_streaks

D = date.fromisoformat
TODAY = D("2026-10-17")  # a Saturday


def days_back(*offsets: int) -> set[date]:
    return {TODAY - timedelta(days=o) for o in offsets}


# ---- day streaks ---------------------------------------------------------

def test_streak_includes_today():
    s = day_streaks(days_back(0, 1, 2, 5), TODAY)
    assert s == {"current": 3, "longest": 3, "active_today": True, "at_risk": False}


def test_streak_alive_but_at_risk_when_no_workout_today():
    s = day_streaks(days_back(1, 2), TODAY)
    assert s["current"] == 2 and s["at_risk"] is True and s["active_today"] is False


def test_streak_broken_after_a_rest_day():
    s = day_streaks(days_back(2, 3, 4, 5), TODAY)
    assert s["current"] == 0 and s["at_risk"] is False
    assert s["longest"] == 4


def test_streak_empty_history():
    assert day_streaks(set(), TODAY) == {"current": 0, "longest": 0, "active_today": False, "at_risk": False}


# ---- week streaks (workouts per week) -------------------------------------

def per_day(*dates: str, n: int = 1) -> dict:
    return {D(d): n for d in dates}


def test_week_streak_counts_completed_weeks_and_current_week_once_met():
    # This week (Oct 12): Mon/Wed/Fri. Week of Oct 5: 3 workouts. Week of Sep 28: 1.
    days = per_day("2026-10-12", "2026-10-14", "2026-10-16", "2026-10-05", "2026-10-07", "2026-10-09", "2026-09-30")
    s = week_streaks(days, TODAY, goal=3)
    assert s["this_week_workouts"] == 3 and s["this_week_met"] is True
    assert s["current"] == 2 and s["longest"] == 2
    assert s["remaining"] == 0 and s["at_risk"] is False
    assert [d["workouts"] for d in s["this_week"]] == [1, 0, 1, 0, 1, 0, 0]


def test_multiple_workouts_on_one_day_each_count():
    days = {D("2026-10-12"): 2, D("2026-10-13"): 1}
    s = week_streaks(days, TODAY, goal=3)
    assert s["this_week_workouts"] == 3 and s["this_week_days"] == 2 and s["this_week_met"] is True
    assert s["current"] == 1


def test_open_week_keeps_streak_alive_but_at_risk():
    days = {D("2026-10-13"): 1, **per_day("2026-10-05", "2026-10-06", "2026-10-07")}
    s = week_streaks(days, TODAY, goal=3)
    assert s["this_week_met"] is False and s["current"] == 1  # last week still counts
    assert s["at_risk"] is True and s["remaining"] == 2
    assert s["days_left"] == 2  # Saturday and Sunday


def test_missed_week_breaks_streak():
    days = per_day("2026-09-28", "2026-09-29", "2026-09-30")  # two weeks ago; last week empty
    s = week_streaks(days, TODAY, goal=3)
    assert s["current"] == 0 and s["longest"] == 1 and s["at_risk"] is False


def test_any_workout_week_streak():
    days = per_day("2026-10-13", "2026-10-06", "2026-09-29", "2026-09-15")  # gap: week of Sep 21
    s = week_streaks(days, TODAY, goal=1)
    assert s["current"] == 3 and s["longest"] == 3 and s["this_week_met"] is True
    open_week = week_streaks(per_day("2026-10-06", "2026-09-29"), TODAY, goal=1)
    assert open_week["current"] == 2 and open_week["at_risk"] is True and open_week["remaining"] == 1


def test_week_streak_goal_changes_result():
    days = per_day("2026-10-12", "2026-10-14")
    assert week_streaks(days, TODAY, goal=2)["current"] == 1
    assert week_streaks(days, TODAY, goal=3)["current"] == 0


# ---- API -----------------------------------------------------------------

def _post(client, batch, auth):
    client.post("/api/v1/ingest/health-auto-export", content=json.dumps(batch),
                headers={**auth, "Content-Type": "application/json"})


def test_overview_endpoint(client, batch, auth):
    _post(client, batch, auth)
    o = client.get("/api/v1/analytics/overview", params={"today": "2026-10-16", "weekly_goal": 2}).json()
    assert o["last_workout"]["activity"]["type"] == "outdoor_walk"
    assert o["last_workout"]["days_ago"] == 1
    assert o["day_streak"] == {"current": 2, "longest": 2, "active_today": False, "at_risk": True}
    assert o["week_streak"]["this_week_workouts"] == 3 and o["week_streak"]["this_week_days"] == 2
    assert o["week_streak"]["current"] == 1
    assert o["active_week_streak"]["goal"] == 1 and o["active_week_streak"]["current"] == 1
    assert o["totals"]["workouts"] == 3 and o["totals"]["active_days"] == 2


def test_overview_ignores_workouts_after_today(client, batch, auth):
    _post(client, batch, auth)
    o = client.get("/api/v1/analytics/overview", params={"today": "2026-10-14"}).json()
    assert o["totals"]["workouts"] == 1
    assert o["last_workout"]["days_ago"] == 0


def test_overview_empty(client):
    o = client.get("/api/v1/analytics/overview", params={"today": "2026-10-16"}).json()
    assert o["last_workout"] is None and o["day_streak"]["current"] == 0


def test_days_endpoint(client, batch, auth):
    _post(client, batch, auth)
    r = client.get("/api/v1/analytics/days", params={"from": "2026-10-01", "to": "2026-11-01"}).json()
    assert [d["date"] for d in r["days"]] == ["2026-10-14", "2026-10-15"]
    oct15 = r["days"][1]
    assert oct15["workouts"] == 2 and oct15["categories"] == ["strength", "walk"]
    assert oct15["duration_s"] == 3120 + 2100
    assert client.get("/api/v1/analytics/days", params={"from": "2026-10-01"}).status_code == 422


def test_weekly_counts_are_zero_filled_from_first_week(client, batch, auth):
    _post(client, batch, auth)
    w = client.get("/api/v1/analytics/weekly", params={"today": "2026-10-28"}).json()["weeks"]
    assert [x["start"] for x in w] == ["2026-10-12", "2026-10-19", "2026-10-26"]
    assert [x["workouts"] for x in w] == [3, 0, 0]


def test_weekly_empty(client):
    assert client.get("/api/v1/analytics/weekly", params={"today": "2026-10-28"}).json() == {"weeks": []}
