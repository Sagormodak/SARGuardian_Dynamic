from __future__ import annotations

import json
from datetime import date
from urllib.parse import parse_qs, urlparse

import pytest

from app import asf_catalog


class FakeResponse:
    def __init__(self, payload: object) -> None:
        self.payload = payload

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, *args: object) -> None:
        return None

    def read(self) -> bytes:
        return json.dumps(self.payload).encode("utf-8")


def sample_row(name: str = "NISAR_L2_GUNW_TEST") -> dict:
    return {
        "granuleName": name,
        "productType": "GUNW",
        "startTime": "2026-08-01T00:00:00Z",
        "stopTime": "2026-08-13T00:00:00Z",
        "flightDirection": "ASCENDING",
        "path": 42,
        "processingLevel": "GUNW",
        "sizeMB": {"file.h5": {"bytes": 2_000_000, "format": "HDF5"}},
    }


def test_successful_search_builds_real_asf_query_and_maps_metadata(monkeypatch: pytest.MonkeyPatch) -> None:
    captured = {}

    def fake_urlopen(request, timeout):
        captured["url"] = request.full_url
        captured["timeout"] = timeout
        return FakeResponse({"results": [sample_row()]})

    monkeypatch.setattr(asf_catalog.urllib.request, "urlopen", fake_urlopen)
    result = asf_catalog.search_asf_catalog(
        [(85.3, 27.7), (85.301, 27.7), (85.301, 27.701)],
        date(2026, 8, 1),
        date(2026, 8, 15),
        "GUNW",
    )

    query = parse_qs(urlparse(captured["url"]).query)
    assert query["dataset"] == ["NISAR"]
    assert query["processingLevel"] == ["GUNW"]
    assert query["start"] == ["2026-08-01T00:00:00Z"]
    assert query["end"] == ["2026-08-15T23:59:59Z"]
    assert query["output"] == ["jsonlite"]
    assert query["maxResults"] == ["2000"]
    assert captured["timeout"] == 20
    assert result.rows[0]["granuleName"] == "NISAR_L2_GUNW_TEST"
    assert result.truncated is False
    products, unknown, warnings = asf_catalog.normalize_product_rows(result.rows, "GUNW")
    assert products[0]["size_mb"] == 2
    assert products[0]["observation_dates"] == ["2026-08-01", "2026-08-13"]
    assert unknown == 0
    assert warnings == []


def test_goff_search_uses_the_nisar_dataset_and_accepts_processing_level_metadata(monkeypatch: pytest.MonkeyPatch) -> None:
    captured = {}
    goff_row = sample_row("NISAR_L2_GOFF_TEST")
    goff_row.pop("productType")
    goff_row["processingLevel"] = "GOFF"

    def fake_urlopen(request, timeout):
        captured["url"] = request.full_url
        return FakeResponse({"results": [goff_row]})

    monkeypatch.setattr(asf_catalog.urllib.request, "urlopen", fake_urlopen)
    result = asf_catalog.search_asf_catalog([(85.3, 27.7), (85.301, 27.7), (85.301, 27.701)], date(2026, 9, 30), date(2026, 10, 22), "GOFF")
    query = parse_qs(urlparse(captured["url"]).query)
    products, unknown, warnings = asf_catalog.normalize_product_rows(result.rows, "GOFF")

    assert query["dataset"] == ["NISAR"]
    assert query["processingLevel"] == ["GOFF"]
    assert products[0]["product_type"] == "GOFF"
    assert unknown == 0
    assert warnings == []


def test_result_cap_is_reported_as_truncated(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ASF_MAX_RESULTS", "2")
    monkeypatch.setattr(asf_catalog.urllib.request, "urlopen", lambda request, timeout: FakeResponse({"results": [sample_row("a"), sample_row("b")]}))
    result = asf_catalog.search_asf_catalog([(0, 0), (1, 0), (1, 1)], date(2026, 8, 1), date(2026, 8, 2), "GUNW")
    assert result.truncated is True


def test_no_data_and_incomplete_metadata_are_honest(monkeypatch: pytest.MonkeyPatch) -> None:
    invalid_size = sample_row("invalid-size")
    invalid_size["sizeMB"] = {"file.h5": {"bytes": -1}}
    monkeypatch.setattr(asf_catalog.urllib.request, "urlopen", lambda request, timeout: FakeResponse({"results": [{"productType": "GUNW"}, invalid_size]}))
    result = asf_catalog.search_asf_catalog([(0, 0), (1, 0), (1, 1)], date(2026, 8, 1), date(2026, 8, 2), "GUNW")
    products, unknown, warnings = asf_catalog.normalize_product_rows(result.rows, "GUNW")
    assert len(products) == 1
    assert products[0]["size_mb"] is None
    assert unknown == 1
    assert warnings


def test_disabled_adapter_and_upstream_timeout(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ASF_CATALOG_ENABLED", "false")
    with pytest.raises(asf_catalog.ASFAdapterNotConfigured):
        asf_catalog.search_asf_catalog([(0, 0), (1, 0), (1, 1)], date(2026, 8, 1), date(2026, 8, 2), "GUNW")

    monkeypatch.setenv("ASF_CATALOG_ENABLED", "true")
    monkeypatch.setattr(asf_catalog.urllib.request, "urlopen", lambda request, timeout: (_ for _ in ()).throw(TimeoutError()))
    with pytest.raises(asf_catalog.ASFAdapterError, match="timed out"):
        asf_catalog.search_asf_catalog([(0, 0), (1, 0), (1, 1)], date(2026, 8, 1), date(2026, 8, 2), "GUNW")
