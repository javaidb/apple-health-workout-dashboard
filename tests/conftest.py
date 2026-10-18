import copy
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app

FIXTURES = Path(__file__).parent / "fixtures"
TOKEN = "test-token-123"


@pytest.fixture
def batch() -> dict:
    return copy.deepcopy(json.loads((FIXTURES / "hae_v2_batch.json").read_text(encoding="utf-8")))


@pytest.fixture
def settings(tmp_path) -> Settings:
    # TestClient reports its client host as "testclient"; treat it as local.
    return Settings(data_dir=tmp_path, ingest_token=TOKEN,
                    local_clients=frozenset({"127.0.0.1", "testclient"}))


@pytest.fixture
def client(settings) -> TestClient:
    return TestClient(create_app(settings))


@pytest.fixture
def auth() -> dict:
    return {"Authorization": f"Bearer {TOKEN}"}
