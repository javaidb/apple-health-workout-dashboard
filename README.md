# health-auto-export

A local workout calendar fed by the [Health Auto Export](https://apps.apple.com/us/app/health-auto-export-json-csv/id1115567069) iOS app.

```
Workout → Apple Health
   ▼  HAE "REST API" automation (background, JSON v2)
POST http://<PC-IP>:8765/api/v1/ingest/health-auto-export   (Bearer token)
   ▼  validate → normalize (units, timezones) → idempotent upsert
SQLite cache  data/workouts.db
   ▼
Calendar UI   http://localhost:8765
```

The receiver runs whenever the PC is on. If the PC is off when the phone tries to sync, the next sync
catches up as long as the automation's date range overlaps (e.g. "last 7 days"). Re-sent workouts are
de-duplicated.

## Setup

### 1. Start the receiver
```
run.bat
```
On first run this creates `.venv`, the database and a random ingest token (`data/ingest_token.txt`),
then prints the exact values for the phone and opens the calendar.

Optional: start it automatically at logon (no browser window):
```
powershell -ExecutionPolicy Bypass -File install-startup.ps1
```

### 2. Allow the phone to reach the PC (once)
- Open only this port, only to devices on your local network (run PowerShell **as administrator**).
  This works on a Public network profile, so nothing else on the PC is exposed:
  ```
  New-NetFirewallRule -DisplayName "Health Auto Export receiver" -Direction Inbound -Protocol TCP -LocalPort 8765 -RemoteAddress LocalSubnet -Action Allow -Profile Any
  ```
  Undo with `Remove-NetFirewallRule -DisplayName "Health Auto Export receiver"`.
- Check from the iPhone's Safari: `http://<PC-IP>:8765/api/v1/health` should show `{"status":"ok"}`.
- Reserve the PC's IP in your router (DHCP reservation) so the URL doesn't change.

### 3. Create the automation in Health Auto Export
| Setting | Value |
|---|---|
| Automation type | REST API |
| URL | `http://<PC-IP>:8765/api/v1/ingest/health-auto-export` |
| Headers | `Authorization` = `Bearer <token from data/ingest_token.txt>` |
| Data type | Workouts |
| Include route data / workout metrics | On |
| Export format / version | JSON / Version 2 |
| Date range | Last 7 days (overlap covers syncs missed while the PC was off) |
| Batch requests | On |
| Sync cadence | Hourly, or the shortest available |

Allow **Local Network** access when iOS asks, then run a **Manual export** over a large date range once
to backfill history. You can also import an exported JSON file with **Import JSON** in the calendar.

## Design

| Layer | Module |
|---|---|
| HTTP, auth, limits, error format | `app/main.py` |
| Envelope + per-workout processing, batch records | `app/ingest.py` |
| HAE v2 → canonical model | `app/normalize.py`, `app/units.py`, `app/timeparse.py` |
| Schema + migrations (`PRAGMA user_version`) | `app/db.py` |
| Read queries shaped for the API | `app/queries.py` |
| Calendar UI (vanilla JS, no build) | `static/` |

**Data model.** `workouts` holds one row per workout with core summary columns (duration, distance, energy,
elevation, heart rate) in canonical units (m, s, kcal, bpm, m/s, °C). Anything else (temperature, MET,
swim fields, new HAE fields) lands in `extra_metrics` JSON, so new activity types and metrics need no
migration. Time series (heart rate, steps, power, …) go to `workout_metrics`, GPS points to
`workout_route_points`. `ingestion_batches` records every push. The latest raw payload per workout is kept in
`raw_workout_payloads` for reprocessing (disable with `HAE_STORE_RAW=0`).

**Timestamps.** HAE sends `yyyy-MM-dd HH:mm:ss Z`. Stored as fixed-width UTC text plus the original offset;
the calendar uses the local date the workout started in (a 23:30 walk stays on that day). Timestamps
without an offset are rejected, never assumed UTC.

**Idempotency.** Identity is HAE's workout `id` (HealthKit UUID).
- Same payload again → `unchanged`, no writes.
- Changed payload → summary updated; fields missing from the new payload keep their stored value.
- Each metric type present in the new payload replaces that workout's series (no duplicate samples);
  metric types/routes absent from the new payload are kept.
- Each workout is processed in its own savepoint: one malformed workout fails alone, the rest commit.
- HAE never sends deletions; delete a workout with `DELETE /api/v1/workouts/{id}`.

**Known HAE quirk.** `heartRateData` sometimes contains the post-workout recovery series
([issue #60](https://github.com/Lybron/health-auto-export/issues/60)). If every sample is at/after the
workout end it is stored as `heart_rate_recovery` and the workout is flagged.

## API

All responses are JSON; errors are `{"error": {"code", "message", "details"}}`. Interactive docs at
`/api/docs`.

| Endpoint | Access |
|---|---|
| `POST /api/v1/ingest/health-auto-export` | Bearer token (the phone) |
| `POST /api/v1/import` | this PC only (manual file import) |
| `GET /api/v1/status` | this PC only — counts and last sync |
| `GET /api/v1/workouts?from=&to=&category=&activity_type=&sort=-start&limit=50&offset=0` | this PC only |
| `GET /api/v1/workouts/{id}` · `/metrics?type=` · `/route` | this PC only |
| `DELETE /api/v1/workouts/{id}` | this PC only |

`from`/`to` are local dates, `from` inclusive and `to` exclusive. Distance and pace are only reported
for distance-based categories (run, walk, hike, cycle, swim, row).

Example ingest response:
```json
{"batch_id": 12, "status": "succeeded",
 "workouts": {"received": 3, "inserted": 1, "updated": 0, "unchanged": 2, "failed": 0},
 "ignored_data_types": {}, "errors": []}
```

## Security and privacy
- Ingest requires a 256-bit bearer token; 10 bad tokens in 5 minutes locks the client out.
- Dashboard API answers only requests from this PC (`HAE_DASHBOARD_ALLOW=ip1,ip2` to add devices).
- Plain HTTP is acceptable on a home network only; never port-forward this port to the internet.
  For remote sync put Tailscale or a tunnel with HTTPS in front of it.
- Logs contain batch ids and counts only, never health values or coordinates. Validation errors name
  fields, never values.
- All data lives in `data/` (git-ignored). Delete that folder to erase everything; back it up to keep it.

## Configuration
| Variable | Default |
|---|---|
| `HAE_PORT` | `8765` |
| `HAE_DATA_DIR` | `./data` |
| `HAE_INGEST_TOKEN` | generated into `data/ingest_token.txt` |
| `HAE_MAX_BODY_MB` | `50` |
| `HAE_STORE_RAW` | `1` |
| `HAE_DASHBOARD_ALLOW` | — |

## Development
```
.venv\Scripts\python -m pytest
```

## Limitations / next steps
- The fixture is built from the documented format; replace or extend it with a real export once the first
  sync arrives.
- Not yet: analytics endpoints (trends, personal records), route map, Postgres. The schema and service
  boundaries are set up so these are additive.
