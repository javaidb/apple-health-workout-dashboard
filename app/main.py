"""FastAPI application: ingestion endpoint, dashboard API and static calendar UI.

Run with:  python -m uvicorn app.main:create_app --factory --host 0.0.0.0 --port 8765
"""
import hmac
import json
import logging
import sqlite3
import time
from collections import defaultdict, deque
from collections.abc import Iterator
from datetime import date
from pathlib import Path

from fastapi import Depends, FastAPI, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import analytics, metrics, queries
from .config import ROOT, Settings, load_settings
from .db import connect, migrate
from .ingest import EnvelopeError, ingest_payload

log = logging.getLogger("hae")


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str, details: object = None):
        self.status, self.code, self.message, self.details = status, code, message, details


def _error(status: int, code: str, message: str, details: object = None) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": {"code": code, "message": message, "details": details}})


class FailedAuthLimiter:
    """Locks out a client after repeated bad tokens (default: 10 per 5 minutes)."""

    def __init__(self, max_failures: int = 10, window_s: float = 300):
        self.max_failures, self.window_s = max_failures, window_s
        self._failures: dict[str, deque] = defaultdict(deque)

    def blocked(self, client: str) -> bool:
        q = self._failures[client]
        cutoff = time.monotonic() - self.window_s
        while q and q[0] < cutoff:
            q.popleft()
        return len(q) >= self.max_failures

    def record_failure(self, client: str) -> None:
        self._failures[client].append(time.monotonic())


def _parse_date(value: str | None, name: str) -> str | None:
    if value is None:
        return None
    try:
        return date.fromisoformat(value).isoformat()
    except ValueError:
        raise ApiError(422, "invalid_parameter", f"'{name}' must be a date in YYYY-MM-DD format") from None


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or load_settings()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    conn = connect(settings.db_path)
    try:
        migrate(conn)
    finally:
        conn.close()

    app = FastAPI(title="Health Auto Export receiver", version="0.1.0", docs_url="/api/docs", redoc_url=None)
    app.state.settings = settings
    limiter = FailedAuthLimiter()

    @app.middleware("http")
    async def revalidate_static(request: Request, call_next):
        # Dashboard files change with every update; without this, browsers may keep using a
        # cached copy. "no-cache" still allows cheap ETag revalidation (304 when unchanged).
        response = await call_next(request)
        if not request.url.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-cache"
        return response

    @app.exception_handler(ApiError)
    async def _api_error(_: Request, exc: ApiError):
        return _error(exc.status, exc.code, exc.message, exc.details)

    @app.exception_handler(RequestValidationError)
    async def _validation_error(_: Request, exc: RequestValidationError):
        details = [{"field": ".".join(str(p) for p in e["loc"]), "message": e["msg"]} for e in exc.errors()]
        return _error(422, "invalid_parameter", "request validation failed", details)

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(_: Request, exc: StarletteHTTPException):
        return _error(exc.status_code, "http_error", str(exc.detail))

    def get_conn() -> Iterator[sqlite3.Connection]:
        conn = connect(settings.db_path)
        try:
            yield conn
        finally:
            conn.close()

    def client_host(request: Request) -> str:
        return request.client.host if request.client else "unknown"

    def token_ok(request: Request) -> bool:
        header = request.headers.get("authorization", "")
        scheme, _, token = header.partition(" ")
        return scheme.lower() == "bearer" and hmac.compare_digest(token.strip().encode(), settings.ingest_token.encode())

    def require_token(request: Request) -> None:
        host = client_host(request)
        if limiter.blocked(host):
            raise ApiError(429, "too_many_failed_attempts", "too many failed authentication attempts; try later")
        if not token_ok(request):
            limiter.record_failure(host)
            log.warning("rejected ingest request with missing/invalid token from %s", host)
            raise ApiError(401, "unauthorized", "missing or invalid bearer token")

    def require_local(request: Request) -> None:
        if client_host(request) in settings.local_clients or token_ok(request):
            return
        raise ApiError(403, "forbidden", "dashboard API is only available from this computer")

    async def read_json_body(request: Request) -> tuple[object, int]:
        content_type = request.headers.get("content-type", "")
        if not content_type.lower().startswith("application/json"):
            raise ApiError(415, "unsupported_media_type", "Content-Type must be application/json (set HAE export format to JSON)")
        declared = request.headers.get("content-length")
        if declared and declared.isdigit() and int(declared) > settings.max_body_bytes:
            raise ApiError(413, "payload_too_large", f"payload exceeds {settings.max_body_bytes // (1024 * 1024)} MB; enable batch requests in HAE")
        chunks, size = [], 0
        async for chunk in request.stream():
            size += len(chunk)
            if size > settings.max_body_bytes:
                raise ApiError(413, "payload_too_large", f"payload exceeds {settings.max_body_bytes // (1024 * 1024)} MB; enable batch requests in HAE")
            chunks.append(chunk)
        try:
            return json.loads(b"".join(chunks)), size
        except (json.JSONDecodeError, UnicodeDecodeError):
            raise ApiError(400, "invalid_json", "request body is not valid JSON") from None

    async def run_ingest(request: Request, channel: str) -> JSONResponse:
        payload, size = await read_json_body(request)

        def work():
            conn = connect(settings.db_path)
            try:
                return ingest_payload(conn, payload, size, channel, settings.store_raw_payloads)
            finally:
                conn.close()

        try:
            result = await run_in_threadpool(work)
        except EnvelopeError as exc:
            raise ApiError(422, "invalid_envelope", str(exc)) from None
        body = result.as_dict()
        status_code = 422 if result.status == "failed" else 200
        return JSONResponse(status_code=status_code, content=body)

    # ---- ingestion ---------------------------------------------------------

    @app.post("/api/v1/ingest/health-auto-export", dependencies=[Depends(require_token)])
    async def ingest_rest(request: Request):
        return await run_ingest(request, "rest")

    @app.post("/api/v1/import", dependencies=[Depends(require_local)])
    async def ingest_manual(request: Request):
        """Manual import of an exported HAE JSON file from the dashboard."""
        return await run_ingest(request, "manual")

    # ---- dashboard API -----------------------------------------------------

    @app.get("/api/v1/health")
    def health():
        return {"status": "ok"}

    @app.get("/api/v1/status", dependencies=[Depends(require_local)])
    def get_status(conn: sqlite3.Connection = Depends(get_conn)):
        return queries.status(conn)

    @app.get("/api/v1/workouts", dependencies=[Depends(require_local)])
    def list_workouts(
        conn: sqlite3.Connection = Depends(get_conn),
        date_from: str | None = Query(None, alias="from", description="Inclusive local date YYYY-MM-DD"),
        date_to: str | None = Query(None, alias="to", description="Exclusive local date YYYY-MM-DD"),
        activity_type: str | None = Query(None),
        category: str | None = Query(None),
        sort: str = Query("-start", pattern="^-?(start|duration|distance)$"),
        limit: int = Query(50, ge=1, le=1000),
        offset: int = Query(0, ge=0),
    ):
        return queries.list_workouts(
            conn, date_from=_parse_date(date_from, "from"), date_to=_parse_date(date_to, "to"),
            activity_type=activity_type, category=category, sort=sort, limit=limit, offset=offset)

    @app.get("/api/v1/workouts/{workout_id}", dependencies=[Depends(require_local)])
    def get_workout(workout_id: int, conn: sqlite3.Connection = Depends(get_conn)):
        result = queries.get_workout(conn, workout_id)
        if result is None:
            raise ApiError(404, "not_found", "workout not found")
        return result

    @app.get("/api/v1/workouts/{workout_id}/metrics", dependencies=[Depends(require_local)])
    def get_metrics(workout_id: int, type: str | None = None, conn: sqlite3.Connection = Depends(get_conn)):
        if queries.get_workout(conn, workout_id) is None:
            raise ApiError(404, "not_found", "workout not found")
        return queries.get_metrics(conn, workout_id, type)

    @app.get("/api/v1/workouts/{workout_id}/route", dependencies=[Depends(require_local)])
    def get_route(workout_id: int, conn: sqlite3.Connection = Depends(get_conn)):
        if queries.get_workout(conn, workout_id) is None:
            raise ApiError(404, "not_found", "workout not found")
        return queries.get_route(conn, workout_id)

    @app.delete("/api/v1/workouts/{workout_id}", dependencies=[Depends(require_local)], status_code=204)
    def delete_workout(workout_id: int, conn: sqlite3.Connection = Depends(get_conn)):
        if not queries.delete_workout(conn, workout_id):
            raise ApiError(404, "not_found", "workout not found")

    # ---- analytics ---------------------------------------------------------

    @app.get("/api/v1/analytics/overview", dependencies=[Depends(require_local)])
    def get_overview(
        conn: sqlite3.Connection = Depends(get_conn),
        today: str | None = Query(None, description="Viewer's local date YYYY-MM-DD (defaults to server date)"),
        weekly_goal: int = Query(3, ge=1, le=7, description="Active days per week that keep the week streak"),
    ):
        day = date.fromisoformat(_parse_date(today, "today")) if today else date.today()
        return analytics.overview(conn, day, weekly_goal)

    @app.get("/api/v1/analytics/days", dependencies=[Depends(require_local)])
    def get_days(
        conn: sqlite3.Connection = Depends(get_conn),
        date_from: str = Query(..., alias="from", description="Inclusive local date YYYY-MM-DD"),
        date_to: str = Query(..., alias="to", description="Exclusive local date YYYY-MM-DD"),
    ):
        return analytics.days(conn, _parse_date(date_from, "from"), _parse_date(date_to, "to"))

    # ---- health metrics ----------------------------------------------------

    @app.get("/api/v1/metrics", dependencies=[Depends(require_local)])
    def list_metrics(conn: sqlite3.Connection = Depends(get_conn)):
        return metrics.available(conn)

    @app.get("/api/v1/metrics/daily", dependencies=[Depends(require_local)])
    def get_daily_metrics(
        conn: sqlite3.Connection = Depends(get_conn),
        names: str = Query(..., description="Comma-separated metric slugs, e.g. step_count,weight_body_mass"),
        date_from: str = Query(..., alias="from", description="Inclusive local date YYYY-MM-DD"),
        date_to: str = Query(..., alias="to", description="Exclusive local date YYYY-MM-DD"),
    ):
        wanted = [n.strip() for n in names.split(",") if n.strip()]
        if not wanted or len(wanted) > 20:
            raise ApiError(422, "invalid_parameter", "'names' must list between 1 and 20 metrics")
        return metrics.daily(conn, wanted, _parse_date(date_from, "from"), _parse_date(date_to, "to"))

    # ---- static calendar UI ------------------------------------------------

    static_dir: Path = ROOT / "static"
    app.mount("/", StaticFiles(directory=static_dir, html=True), name="static")
    return app
