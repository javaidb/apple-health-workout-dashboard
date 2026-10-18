"""Runtime settings, read from environment variables with sensible defaults.

The ingest token is generated on first run and stored in the data directory
(git-ignored) unless HAE_INGEST_TOKEN is set explicitly.
"""
import os
import secrets
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

DEFAULT_LOCAL_CLIENTS = frozenset({"127.0.0.1", "::1", "localhost"})


@dataclass(frozen=True)
class Settings:
    data_dir: Path
    ingest_token: str
    port: int = 8765
    max_body_bytes: int = 50 * 1024 * 1024
    # Clients allowed to read the dashboard API without a token.
    local_clients: frozenset = field(default=DEFAULT_LOCAL_CLIENTS)
    store_raw_payloads: bool = True

    @property
    def db_path(self) -> Path:
        return self.data_dir / "workouts.db"


def _load_or_create_token(path: Path) -> str:
    if path.exists():
        token = path.read_text(encoding="utf-8").strip()
        if token:
            return token
    token = secrets.token_urlsafe(32)
    path.write_text(token + "\n", encoding="utf-8")
    return token


def load_settings() -> Settings:
    data_dir = Path(os.environ.get("HAE_DATA_DIR", ROOT / "data"))
    data_dir.mkdir(parents=True, exist_ok=True)
    token = os.environ.get("HAE_INGEST_TOKEN") or _load_or_create_token(data_dir / "ingest_token.txt")
    extra_clients = {c.strip() for c in os.environ.get("HAE_DASHBOARD_ALLOW", "").split(",") if c.strip()}
    return Settings(
        data_dir=data_dir,
        ingest_token=token,
        port=int(os.environ.get("HAE_PORT", 8765)),
        max_body_bytes=int(os.environ.get("HAE_MAX_BODY_MB", 50)) * 1024 * 1024,
        local_clients=DEFAULT_LOCAL_CLIENTS | extra_clients,
        store_raw_payloads=os.environ.get("HAE_STORE_RAW", "1") != "0",
    )
