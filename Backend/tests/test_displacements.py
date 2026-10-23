from __future__ import annotations

import hashlib
import hmac
import json
from io import BytesIO
from datetime import UTC, datetime
from types import SimpleNamespace
from urllib.error import HTTPError
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient

from app import main as main_module
from app.auth import get_current_user
from app.config import get_settings
from app.displacements import CreateDisplacementJobRequest, GitHubDispatchError, dispatch_workflow, find_dispatched_workflow_run, is_dispatch_timed_out
from app.main import app


class DisplacementStore:
    def __init__(self) -> None:
        self.row: dict | None = None

    def get_displacement_job_by_idempotency(self, _owner, key):
        return self.row if self.row and self.row["idempotency_key"] == key else None

    def create_displacement_job(self, values):
        now = datetime.now(UTC).isoformat()
        self.row = values | {"id": str(uuid4()), "created_at": now, "updated_at": now, "github_run_id": None, "github_run_url": None, "callback_sequence": 0, "error_code": None, "error_message": None}
        return self.row

    def update_displacement_job(self, job_id, values):
        assert self.row and self.row["id"] == str(job_id)
        self.row |= values
        return self.row

    def get_displacement_job(self, owner, job_id):
        return self.row if self.row and self.row["owner_uid"] == owner and self.row["id"] == str(job_id) else None

    def get_displacement_job_unscoped(self, job_id):
        return self.row if self.row and self.row["id"] == str(job_id) else None


def client(monkeypatch, store: DisplacementStore) -> TestClient:
    monkeypatch.setattr(main_module, "get_job_store", lambda: store)
    monkeypatch.setattr(main_module, "dispatch_workflow", lambda *_args: None)
    app.dependency_overrides[get_current_user] = lambda: {"uid": "firebase-user"}
    return TestClient(app)


def setup_function() -> None:
    app.dependency_overrides.clear()


def teardown_function() -> None:
    app.dependency_overrides.clear()


def payload() -> dict:
    return {"aoi_wkt": "POLYGON((85 27, 85.01 27, 85 27.01, 85 27))", "start_date": "2026-10-01", "end_date": "2026-10-22", "idempotency_key": "displacement-test-001"}


def test_displacement_job_is_durable_dispatched_and_owner_scoped(monkeypatch) -> None:
    store = DisplacementStore()
    response = client(monkeypatch, store).post("/api/displacement-jobs", json=payload())
    assert response.status_code == 200
    assert response.json()["state"] == "dispatching"
    assert store.row and store.row["owner_uid"] == "firebase-user"
    assert client(monkeypatch, store).get(f"/api/displacement-jobs/{store.row['id']}").status_code == 200


def test_worker_callback_requires_hmac_and_ordered_transitions(monkeypatch) -> None:
    store = DisplacementStore()
    api = client(monkeypatch, store)
    created = api.post("/api/displacement-jobs", json=payload()).json()
    monkeypatch.setattr(main_module, "get_settings", lambda: type("Settings", (), {"displacement_callback_secret": "test-secret"})())
    body = json.dumps({"state": "running", "sequence": 1, "stage": "initializing", "github_run_id": "123", "github_run_url": "https://github.com/example/run/123"}).encode()
    signature = "sha256=" + hmac.new(b"test-secret", body, hashlib.sha256).hexdigest()
    callback = api.post(f"/api/displacement-jobs/{created['id']}/callback", content=body, headers={"Content-Type": "application/json", "X-SARGuardian-Signature": signature})
    assert callback.status_code == 200
    assert callback.json()["job_status"] == "running"
    bad_success = api.post(f"/api/displacement-jobs/{uuid4()}/callback", content=body, headers={"Content-Type": "application/json", "X-SARGuardian-Signature": signature})
    assert bad_success.status_code == 404


def test_callback_sequence_rejects_stale_replay(monkeypatch) -> None:
    store = DisplacementStore()
    api = client(monkeypatch, store)
    created = api.post("/api/displacement-jobs", json=payload()).json()
    monkeypatch.setattr(main_module, "get_settings", lambda: type("Settings", (), {"displacement_callback_secret": "test-secret"})())
    running = json.dumps({"state": "running", "sequence": 1, "stage": "initializing", "github_run_id": "123"}).encode()
    signature = "sha256=" + hmac.new(b"test-secret", running, hashlib.sha256).hexdigest()
    assert api.post(f"/api/displacement-jobs/{created['id']}/callback", content=running, headers={"Content-Type": "application/json", "X-SARGuardian-Signature": signature}).status_code == 200
    stale = json.dumps({"state": "failed", "sequence": 1, "stage": "failed", "github_run_id": "123"}).encode()
    stale_signature = "sha256=" + hmac.new(b"test-secret", stale, hashlib.sha256).hexdigest()
    assert api.post(f"/api/displacement-jobs/{created['id']}/callback", content=stale, headers={"Content-Type": "application/json", "X-SARGuardian-Signature": stale_signature}).status_code == 409


def test_ordered_worker_callbacks_preserve_stage_and_validated_result_summary(monkeypatch) -> None:
    store = DisplacementStore()
    api = client(monkeypatch, store)
    created = api.post("/api/displacement-jobs", json=payload()).json()
    monkeypatch.setattr(main_module, "get_settings", lambda: type("Settings", (), {"displacement_callback_secret": "test-secret"})())

    def callback(payload_value: dict) -> dict:
        body = json.dumps(payload_value).encode()
        signature = "sha256=" + hmac.new(b"test-secret", body, hashlib.sha256).hexdigest()
        response = api.post(f"/api/displacement-jobs/{created['id']}/callback", content=body, headers={"Content-Type": "application/json", "X-SARGuardian-Signature": signature})
        assert response.status_code == 200, response.text
        return response.json()

    callback({"state": "running", "stage": "initializing", "sequence": 1, "github_run_id": "123"})
    callback({"state": "running", "stage": "science_processing", "sequence": 2, "github_run_id": "123"})
    final = callback({"state": "succeeded", "stage": "completed", "sequence": 3, "github_run_id": "123", "result_summary": {"analysis_type": "aoi_clipped_per_product_displacement_screening", "selected_product_count": 1}, "artifact_url": "https://github.com/example/run/123"})
    assert final["job_status"] == "succeeded"
    assert store.row and store.row["stage"] == "completed"
    assert store.row["result_summary"]["selected_product_count"] == 1


def test_dispatch_uses_only_configured_server_values(monkeypatch) -> None:
    captured: dict = {}

    class Response:
        status = 204
        def __enter__(self): return self
        def __exit__(self, *_args): return False

    def fake_urlopen(request, timeout):
        captured["url"] = request.full_url
        captured["body"] = json.loads(request.data.decode())
        captured["authorization"] = request.headers["Authorization"]
        assert timeout == 15
        return Response()

    monkeypatch.setattr("app.displacements.urlopen", fake_urlopen)
    settings = get_settings({
        "DISPLACEMENT_ACTIONS_ENABLED": "true", "GITHUB_ACTIONS_TOKEN": "server-token",
        "GITHUB_ACTIONS_REPOSITORY": "owner/repository", "GITHUB_ACTIONS_WORKFLOW": "workflow.yml",
        "GITHUB_ACTIONS_REF": "main", "DISPLACEMENT_CALLBACK_SECRET": "callback-secret",
        "PUBLIC_API_URL": "https://api.example.test",
    })
    request = CreateDisplacementJobRequest(**payload())
    dispatch_workflow(settings, UUID("11111111-1111-1111-1111-111111111111"), request)
    assert captured["url"].endswith("/repos/owner/repository/actions/workflows/workflow.yml/dispatches")
    assert captured["authorization"] == "Bearer server-token"
    assert captured["body"]["inputs"] == {
        "job_id": "11111111-1111-1111-1111-111111111111", "aoi_wkt": payload()["aoi_wkt"],
        "start_date": "2026-10-01", "end_date": "2026-10-22", "callback_url": "https://api.example.test",
    }


def test_dispatch_reports_the_safe_github_rejection_reason(monkeypatch) -> None:
    def fake_urlopen(*_args, **_kwargs):
        raise HTTPError("https://api.github.test", 422, "Unprocessable Content", hdrs=None, fp=BytesIO(b'{"message":"Workflow does not have workflow_dispatch trigger"}'))

    monkeypatch.setattr("app.displacements.urlopen", fake_urlopen)
    settings = get_settings({
        "DISPLACEMENT_ACTIONS_ENABLED": "true", "GITHUB_ACTIONS_TOKEN": "server-token",
        "GITHUB_ACTIONS_REPOSITORY": "owner/repository", "GITHUB_ACTIONS_WORKFLOW": "workflow.yml",
        "GITHUB_ACTIONS_REF": "main", "DISPLACEMENT_CALLBACK_SECRET": "callback-secret",
        "PUBLIC_API_URL": "https://api.example.test",
    })
    with pytest.raises(GitHubDispatchError, match="Workflow does not have workflow_dispatch trigger"):
        dispatch_workflow(settings, UUID("11111111-1111-1111-1111-111111111111"), CreateDisplacementJobRequest(**payload()))


def test_dispatch_timeout_only_applies_before_the_worker_starts() -> None:
    old = "2026-01-01T00:00:00Z"
    assert is_dispatch_timed_out({"state": "dispatching", "updated_at": old}, 300) is True
    assert is_dispatch_timed_out({"state": "running", "updated_at": old}, 300) is False


def test_dispatched_workflow_failure_is_reported_before_a_worker_callback(monkeypatch) -> None:
    store = DisplacementStore()
    api = client(monkeypatch, store)
    created = api.post("/api/displacement-jobs", json=payload()).json()
    monkeypatch.setattr(main_module, "get_settings", lambda: SimpleNamespace(
        displacement_actions_enabled=True, displacement_dispatch_timeout_seconds=3_600,
    ))
    monkeypatch.setattr(main_module, "find_dispatched_workflow_run", lambda *_args: (
        "39915851321", "https://github.com/example/run/39915851321", "completed", "failure",
    ))

    response = api.get(f"/api/displacement-jobs/{created['id']}")
    body = response.json()

    assert response.status_code == 200
    assert body["state"] == "failed"
    assert body["stage"] == "terminal_validation_failed"
    assert body["error_code"] == "GITHUB_ACTIONS_WORKER_FAILED"
    assert body["github_run_id"] == "39915851321"


def test_find_dispatched_workflow_run_matches_the_job_display_title(monkeypatch) -> None:
    captured: dict = {}

    class Response:
        def read(self):
            return json.dumps({"workflow_runs": [{
                "id": 99, "display_title": "Displacement 11111111-1111-1111-1111-111111111111",
                "html_url": "https://github.com/example/run/99", "status": "completed", "conclusion": "failure",
            }]}).encode()
        def __enter__(self): return self
        def __exit__(self, *_args): return False

    def fake_urlopen(request, timeout):
        captured["url"] = request.full_url
        assert timeout == 10
        return Response()

    monkeypatch.setattr("app.displacements.urlopen", fake_urlopen)
    settings = get_settings({
        "DISPLACEMENT_ACTIONS_ENABLED": "true", "GITHUB_ACTIONS_TOKEN": "server-token",
        "GITHUB_ACTIONS_REPOSITORY": "owner/repository", "GITHUB_ACTIONS_WORKFLOW": "workflow with spaces.yml",
    })
    result = find_dispatched_workflow_run(settings, UUID("11111111-1111-1111-1111-111111111111"))

    assert result == ("99", "https://github.com/example/run/99", "completed", "failure")
    assert captured["url"].endswith("/workflows/workflow%20with%20spaces.yml/runs?event=workflow_dispatch&per_page=100")


def test_invalid_displacement_wkt_is_rejected(monkeypatch) -> None:
    response = client(monkeypatch, DisplacementStore()).post("/api/displacement-jobs", json=payload() | {"aoi_wkt": "MULTIPOLYGON EMPTY"})
    assert response.status_code == 422


def test_displacement_migration_has_immutable_owner_scoped_job_schema() -> None:
    sql = (main_module.__file__ and __import__("pathlib").Path(main_module.__file__).parents[1] / "migrations" / "002_displacement_jobs.sql").read_text(encoding="utf-8")
    assert "create table public.displacement_jobs" in sql
    assert "unique (owner_uid, idempotency_key)" in sql
    assert "displacement_jobs_transition_guard" in sql
    assert "callback_sequence" in sql
    assert "enable row level security" in sql


def test_displacement_workflow_initializes_runner_workspace_in_a_step() -> None:
    workflow = (__import__("pathlib").Path(main_module.__file__).parents[2] / ".github" / "workflows" / "sarguardian-displacement.yml").read_text(encoding="utf-8")
    assert "SARGUARDIAN_WORK_DIR: ${{ runner.temp }}" not in workflow
    assert "Initialize isolated job workspace" in workflow
    assert "${RUNNER_TEMP}/sarguardian-displacement-${JOB_ID}" in workflow
