from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from uuid import uuid4

from app import main as main_module
from app.asf_catalog import ASFAdapterError, ASFSearchResult
from app.auth import get_current_user
from app.main import app
from app.persistence import PersistenceError

client = TestClient(app)


def setup_function() -> None:
    app.dependency_overrides.clear()


def teardown_function() -> None:
    app.dependency_overrides.clear()


def authenticated_client() -> TestClient:
    app.dependency_overrides[get_current_user] = lambda: {"uid": "test-user"}
    return client


def valid_payload() -> dict:
    return {
        "coordinates": [[85.3, 27.7], [85.301, 27.7], [85.301, 27.701], [85.3, 27.7]],
        "start_date": "2026-08-01",
        "end_date": "2026-08-15",
        "product_type": "GUNW",
    }


def test_health() -> None:
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_catalog_requires_firebase_bearer_token() -> None:
    response = client.post("/api/catalog/search", json=valid_payload())
    assert response.status_code == 401
    assert "Bearer token" in response.json()["detail"]


def test_catalog_with_bearer_token_reports_missing_firebase_admin_config() -> None:
    response = client.post(
        "/api/catalog/search",
        headers={"Authorization": "Bearer test-token"},
        json=valid_payload(),
    )
    assert response.status_code == 503
    assert "not configured" in response.json()["detail"]


def test_catalog_validates_server_side_and_returns_honest_not_configured_result(monkeypatch) -> None:
    monkeypatch.setenv("ASF_CATALOG_ENABLED", "false")
    response = authenticated_client().post("/api/catalog/search", json=valid_payload())
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "not_configured"
    assert body["product_count"] == 0
    assert body["products"] == []
    assert body["data_downloaded"] is False
    assert body["scientific_analysis_performed"] is False
    assert body["processing_eligibility"]["status"] == "undetermined"
    assert body["query"]["product_type"] == "GUNW"
    assert body["query"]["aoi_area_km2"] > 0


def test_catalog_rejects_date_and_area_limits() -> None:
    client_instance = authenticated_client()
    too_long = valid_payload() | {"end_date": "2026-11-01"}
    assert client_instance.post("/api/catalog/search", json=too_long).status_code == 422

    too_large = valid_payload() | {
        "coordinates": [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]],
    }
    assert client_instance.post("/api/catalog/search", json=too_large).status_code == 422


def test_catalog_rejects_unsupported_product_type() -> None:
    response = authenticated_client().post("/api/catalog/search", json=valid_payload() | {"product_type": "OTHER"})
    assert response.status_code == 422


def test_catalog_response_contract_maps_ready_metadata_without_downloading(monkeypatch) -> None:
    monkeypatch.setattr(main_module, "search_asf_catalog", lambda *args: ASFSearchResult(rows=[{
        "granuleName": "NISAR_L2_GUNW_TEST",
        "productType": "GUNW",
        "startTime": "2026-08-01T00:00:00Z",
        "stopTime": "2026-08-13T00:00:00Z",
        "sizeMB": {"file.h5": {"bytes": 2_000_000}},
    }], truncated=False, query_url="https://example.invalid"))
    monkeypatch.setattr(main_module, "normalize_product_rows", lambda rows, product_type: ([{
        "granule_name": "NISAR_L2_GUNW_TEST",
        "product_type": "GUNW",
        "observation_dates": ["2026-08-01", "2026-08-13"],
        "size_mb": 2,
    }], 0, []))
    class PreflightStore:
        def save_preflight(self, owner_uid, request_snapshot, manifest_snapshot):
            return uuid4()
    monkeypatch.setattr(main_module, "get_job_store", lambda: PreflightStore())
    response = authenticated_client().post("/api/catalog/search", json=valid_payload())
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ready"
    assert body["product_count"] == 1
    assert body["products"][0]["granule_name"] == "NISAR_L2_GUNW_TEST"
    assert body["scientific_analysis_performed"] is False
    assert body["processing_eligibility"]["status"] == "undetermined"


def test_catalog_upstream_failure_is_not_reported_as_no_data(monkeypatch) -> None:
    def fail(*args):
        raise ASFAdapterError("ASF catalogue request timed out or could not be reached.")

    monkeypatch.setattr(main_module, "search_asf_catalog", fail)
    response = authenticated_client().post("/api/catalog/search", json=valid_payload())
    assert response.status_code == 502
    assert response.json()["status"] == "upstream_error"


def test_catalog_persistence_failure_is_reported_without_fabricating_a_preflight(monkeypatch) -> None:
    monkeypatch.setattr(main_module, "search_asf_catalog", lambda *args: ASFSearchResult(rows=[{
        "granuleName": "NISAR_L2_GUNW_TEST",
        "productType": "GUNW",
        "startTime": "2026-08-01T00:00:00Z",
        "stopTime": "2026-08-13T00:00:00Z",
        "sizeMB": {"file.h5": {"bytes": 2_000_000}},
    }], truncated=False, query_url="https://example.invalid"))
    monkeypatch.setattr(main_module, "normalize_product_rows", lambda rows, product_type: ([{
        "granule_name": "NISAR_L2_GUNW_TEST",
        "product_type": "GUNW",
        "observation_dates": ["2026-08-01", "2026-08-13"],
        "size_mb": 2,
    }], 0, []))

    class FailingPreflightStore:
        def save_preflight(self, owner_uid, request_snapshot, manifest_snapshot):
            raise PersistenceError("database unavailable")

    monkeypatch.setattr(main_module, "get_job_store", lambda: FailingPreflightStore())
    response = authenticated_client().post("/api/catalog/search", json=valid_payload())
    assert response.status_code == 503
    assert response.json() == {
        "status": "persistence_error",
        "message": "The preflight could not be persisted for job confirmation.",
    }


def test_catalog_rejects_open_polygon_malformed_json_and_oversized_body() -> None:
    client_instance = authenticated_client()
    open_polygon = valid_payload() | {
        "coordinates": [[85.3, 27.7], [85.301, 27.7], [85.301, 27.701]],
    }
    assert client_instance.post("/api/catalog/search", json=open_polygon).status_code == 422
    malformed = client_instance.post("/api/catalog/search", content=b"{not-json", headers={"Content-Type": "application/json"})
    assert malformed.status_code == 422
    oversized = client_instance.post(
        "/api/catalog/search",
        content=b"{}",
        headers={"Content-Type": "application/json", "Content-Length": "1000001"},
    )
    assert oversized.status_code == 413


def test_unexpected_errors_use_a_safe_response() -> None:
    def explode() -> dict[str, str]:
        raise RuntimeError("internal test failure")

    app.dependency_overrides[get_current_user] = explode
    response = TestClient(app, raise_server_exceptions=False).post("/api/catalog/search", json=valid_payload())
    assert response.status_code == 500
    assert response.json() == {"detail": "Internal server error."}


def test_production_requires_explicit_cors_origins(monkeypatch: pytest.MonkeyPatch) -> None:
    from app import main as main_module

    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.delenv("CORS_ORIGINS", raising=False)
    with pytest.raises(RuntimeError, match="CORS_ORIGINS"):
        main_module._cors_origins()
