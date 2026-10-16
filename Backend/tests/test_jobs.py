from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from app import main as main_module
from app.auth import get_current_user
from app.jobs import JobState, validate_transition
from app.persistence import PersistenceConfigurationError, get_job_store
from app.main import app


class FakeStore:
    def __init__(self, preflight: dict | None = None, existing: dict | None = None) -> None:
        self.preflight = preflight
        self.existing = existing
        self.created: dict | None = None
        self.listed_owner: str | None = None
        self.read_owner: str | None = None

    def save_preflight(self, owner_uid, request_snapshot, manifest_snapshot):
        return uuid4()

    def get_preflight(self, owner_uid, preflight_id):
        return self.preflight

    def get_job_by_idempotency(self, owner_uid, idempotency_key):
        return self.existing

    def create_job(self, values):
        self.created = values
        return values | {
            "created_at": "2026-10-15T12:00:00Z",
            "updated_at": "2026-10-15T12:00:00Z",
        }

    def list_jobs(self, owner_uid, limit=100):
        self.listed_owner = owner_uid
        return [self.created] if self.created else []

    def get_job(self, owner_uid, job_id):
        self.read_owner = owner_uid
        return self.created


def record_template(owner_uid: str = "firebase-user") -> dict:
    job_id = str(uuid4())
    preflight_id = str(uuid4())
    return {
        "id": job_id,
        "owner_uid": owner_uid,
        "preflight_id": preflight_id,
        "idempotency_key": "idempotency-key-001",
        "product_family": "GUNW",
        "state": "queued",
        "request_snapshot": {"product_type": "GUNW"},
        "manifest_snapshot": {"status": "ready", "product_count": 1},
        "created_at": "2026-10-15T12:00:00Z",
        "updated_at": "2026-10-15T12:00:00Z",
        "worker_run_id": None,
        "error_code": None,
        "error_message": None,
    }


def authenticated_client(monkeypatch: pytest.MonkeyPatch, store: FakeStore) -> TestClient:
    monkeypatch.setattr(main_module, "get_job_store", lambda: store)
    app.dependency_overrides[get_current_user] = lambda: {"uid": "firebase-user"}
    return TestClient(app)


def setup_function() -> None:
    app.dependency_overrides.clear()


def teardown_function() -> None:
    app.dependency_overrides.clear()


def test_create_job_requires_current_confirmed_preflight_and_starts_queued(monkeypatch: pytest.MonkeyPatch) -> None:
    preflight_id = uuid4()
    store = FakeStore({
        "id": str(preflight_id),
        "expires_at": (datetime.now(UTC) + timedelta(hours=1)).isoformat(),
        "request_snapshot": {"product_type": "GUNW", "coordinates": []},
        "manifest_snapshot": {"status": "ready", "product_count": 1},
    })
    response = authenticated_client(monkeypatch, store).post("/api/jobs", json={
        "preflight_id": str(preflight_id),
        "idempotency_key": "idempotency-key-001",
        "confirm": True,
    })
    assert response.status_code == 200
    assert response.json()["state"] == "queued"
    assert store.created["owner_uid"] == "firebase-user"
    assert store.created["manifest_snapshot"]["status"] == "ready"


def test_stale_preflight_is_rejected_and_idempotency_reuses_existing(monkeypatch: pytest.MonkeyPatch) -> None:
    preflight_id = uuid4()
    stale = FakeStore({
        "id": str(preflight_id),
        "expires_at": (datetime.now(UTC) - timedelta(seconds=1)).isoformat(),
        "request_snapshot": {"product_type": "GUNW"},
        "manifest_snapshot": {"status": "ready", "product_count": 1},
    })
    response = authenticated_client(monkeypatch, stale).post("/api/jobs", json={
        "preflight_id": str(preflight_id), "idempotency_key": "idempotency-key-001", "confirm": True,
    })
    assert response.status_code == 409

    existing = record_template()
    valid_id = uuid4()
    reused = FakeStore(
        preflight={
            "id": str(valid_id),
            "expires_at": (datetime.now(UTC) + timedelta(hours=1)).isoformat(),
            "request_snapshot": {"product_type": "GUNW"},
            "manifest_snapshot": {"status": "ready", "product_count": 1},
        },
        existing=existing,
    )
    response = authenticated_client(monkeypatch, reused).post("/api/jobs", json={
        "preflight_id": str(valid_id), "idempotency_key": "idempotency-key-001", "confirm": True,
    })
    assert response.status_code == 200
    assert response.json()["id"] == existing["id"]
    assert reused.created is None


def test_job_list_and_get_are_scoped_to_verified_owner(monkeypatch: pytest.MonkeyPatch) -> None:
    store = FakeStore()
    client = authenticated_client(monkeypatch, store)
    assert client.get("/api/jobs").status_code == 200
    assert store.listed_owner == "firebase-user"
    assert client.get(f"/api/jobs/{uuid4()}").status_code == 404
    assert store.read_owner == "firebase-user"


def test_job_state_transitions_are_explicit() -> None:
    validate_transition(JobState.QUEUED, JobState.DISPATCHING)
    validate_transition(JobState.RUNNING, JobState.SUCCEEDED)
    with pytest.raises(ValueError):
        validate_transition(JobState.QUEUED, JobState.RUNNING)
    with pytest.raises(ValueError):
        validate_transition(JobState.SUCCEEDED, JobState.RUNNING)


def test_sql_enforces_one_global_active_heavy_job_and_transition_guard() -> None:
    migration = Path(__file__).parents[1] / "migrations" / "001_processing_jobs.sql"
    sql = migration.read_text(encoding="utf-8")
    assert "processing_jobs_one_active_heavy_idx" in sql
    assert "where state in ('dispatching', 'running')" in sql
    assert "enforce_processing_job_transition" in sql


def test_missing_supabase_configuration_has_no_in_memory_fallback(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_SERVICE_ROLE_KEY", raising=False)
    get_job_store.cache_clear()
    with pytest.raises(PersistenceConfigurationError):
        get_job_store()
    get_job_store.cache_clear()
