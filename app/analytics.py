"""Analytics derived from canonical workouts: streaks, per-day activity, totals.

Conventions
- A day is "active" when at least one workout started on that local date.
- `today` is supplied by the caller (the viewer's local date), so streaks don't
  depend on the server's timezone.
- Day streak: consecutive active days ending today, or ending yesterday if there
  is no workout yet today (the streak is still alive, but "at risk").
- Week streak: consecutive Monday-start weeks with at least `weekly_goal` active
  days. The current week counts once the goal is met; until then the streak runs
  through last week.
"""
import sqlite3
from datetime import date, timedelta
from typing import Any

from .queries import serialize_workout


def _monday(d: date) -> date:
    return d - timedelta(days=d.weekday())


def day_streaks(active: set[date], today: date) -> dict[str, Any]:
    active_today = today in active
    current = 0
    cursor = today if active_today else today - timedelta(days=1)
    while cursor in active:
        current += 1
        cursor -= timedelta(days=1)

    longest = run = 0
    previous: date | None = None
    for d in sorted(active):
        run = run + 1 if previous and d - previous == timedelta(days=1) else 1
        longest = max(longest, run)
        previous = d
    return {"current": current, "longest": longest, "active_today": active_today,
            "at_risk": current > 0 and not active_today}


def week_streaks(active: set[date], today: date, goal: int) -> dict[str, Any]:
    per_week: dict[date, int] = {}
    for d in active:
        per_week[_monday(d)] = per_week.get(_monday(d), 0) + 1

    this_week = _monday(today)
    this_week_days = per_week.get(this_week, 0)
    met = this_week_days >= goal
    current = 0
    cursor = this_week if met else this_week - timedelta(weeks=1)
    while per_week.get(cursor, 0) >= goal:
        current += 1
        cursor -= timedelta(weeks=1)

    longest = run = 0
    previous: date | None = None
    for week in sorted(w for w, n in per_week.items() if n >= goal):
        run = run + 1 if previous and week - previous == timedelta(weeks=1) else 1
        longest = max(longest, run)
        previous = week
    week_dates = [this_week + timedelta(days=i) for i in range(7)]
    return {
        "current": current,
        "longest": longest,
        "goal": goal,
        "this_week_days": this_week_days,
        "this_week_met": met,
        "this_week": [{"date": d.isoformat(), "active": d in active} for d in week_dates],
    }


def _active_dates(conn: sqlite3.Connection) -> set[date]:
    return {date.fromisoformat(r[0]) for r in conn.execute("SELECT DISTINCT start_local_date FROM workouts")}


def overview(conn: sqlite3.Connection, today: date, weekly_goal: int) -> dict[str, Any]:
    active = {d for d in _active_dates(conn) if d <= today}
    last_row = conn.execute(
        "SELECT * FROM workouts WHERE start_local_date <= ? ORDER BY start_utc DESC LIMIT 1",
        (today.isoformat(),)).fetchone()
    last = None
    if last_row:
        last = serialize_workout(last_row)
        last["days_ago"] = (today - date.fromisoformat(last_row["start_local_date"])).days

    totals = conn.execute(
        "SELECT COUNT(*) AS n, COALESCE(SUM(duration_s), 0) AS secs, MIN(start_local_date) AS first "
        "FROM workouts WHERE start_local_date <= ?", (today.isoformat(),)).fetchone()
    year = conn.execute(
        "SELECT COUNT(*) AS n, COUNT(DISTINCT start_local_date) AS days FROM workouts "
        "WHERE start_local_date >= ? AND start_local_date <= ?",
        (date(today.year, 1, 1).isoformat(), today.isoformat())).fetchone()
    return {
        "today": today.isoformat(),
        "last_workout": last,
        "day_streak": day_streaks(active, today),
        "week_streak": week_streaks(active, today, weekly_goal),
        "totals": {
            "workouts": totals["n"],
            "active_days": len(active),
            "duration_s": totals["secs"],
            "first_workout_date": totals["first"],
            "this_year_workouts": year["n"],
            "this_year_active_days": year["days"],
        },
    }


def days(conn: sqlite3.Connection, date_from: str, date_to: str) -> dict[str, Any]:
    rows = conn.execute(
        "SELECT start_local_date AS d, COUNT(*) AS n, SUM(duration_s) AS secs, SUM(active_energy_kcal) AS kcal, "
        "GROUP_CONCAT(DISTINCT activity_category) AS cats FROM workouts "
        "WHERE start_local_date >= ? AND start_local_date < ? GROUP BY start_local_date ORDER BY d",
        (date_from, date_to)).fetchall()
    return {
        "from": date_from,
        "to": date_to,
        "days": [{"date": r["d"], "workouts": r["n"], "duration_s": round(r["secs"] or 0, 1),
                  "active_energy_kcal": None if r["kcal"] is None else round(r["kcal"], 1),
                  "categories": sorted(r["cats"].split(","))} for r in rows],
    }
