from __future__ import annotations

from datetime import date
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import pytest

from science_adapter import run_displacement as adapter


def record(reference: str, secondary: str, product: str = "GUNW", size_mb: float = 100.0) -> dict:
    return {
        "productType": product, "reference": date.fromisoformat(reference), "secondary": date.fromisoformat(secondary),
        "url": f"https://example.test/NISAR_L2_PR_{product}_example.h5", "size_mb": size_mb, "granule": f"NISAR_L2_PR_{product}_example",
    }


def test_selection_requires_both_pair_acquisitions_inside_the_requested_window() -> None:
    selected = adapter.select_eligible_products([
        record("2026-10-01", "2026-10-13"),
        record("2026-09-29", "2026-10-11"),
        record("2026-10-12", "2026-10-24"),
        record("2026-10-02", "2026-10-14", "RIFG"),
    ], date(2026, 10, 1), date(2026, 10, 22))
    assert [item["granule"] for item in selected] == ["NISAR_L2_PR_GUNW_example"]


def test_selection_refuses_unknown_size_and_download_budget_excess() -> None:
    assert adapter.select_eligible_products([record("2026-10-01", "2026-10-13", size_mb=0)], date(2026, 10, 1), date(2026, 10, 22)) == []
    with pytest.raises(adapter.AdapterError, match="exceeding"):
        adapter.enforce_download_budget([record("2026-10-01", "2026-10-13", size_mb=2048)], 1)


def test_adapter_normalizes_list_asf_responses_for_the_pinned_source() -> None:
    class Acquisition:
        def _get(self, _url):
            return [{"granuleName": "NISAR_example"}]

        def asf_query(self):
            body = self._get("https://asf.example.test")
            return body.get("results", body if isinstance(body, list) else [])

    acquisition = Acquisition()
    adapter._install_asf_response_compatibility(acquisition)

    assert acquisition.asf_query() == [{"granuleName": "NISAR_example"}]


def test_adapter_flattens_asf_product_batches_without_dropping_records() -> None:
    class Acquisition:
        def _get(self, _url):
            return [[{"granuleName": "NISAR_first"}], [{"granuleName": "NISAR_second"}]]

        def asf_query(self):
            body = self._get("https://asf.example.test")
            return body.get("results", body if isinstance(body, list) else [])

    acquisition = Acquisition()
    adapter._install_asf_response_compatibility(acquisition)

    assert acquisition.asf_query() == [
        {"granuleName": "NISAR_first"}, {"granuleName": "NISAR_second"},
    ]


def test_adapter_rejects_invalid_asf_response_shape() -> None:
    acquisition = SimpleNamespace(_get=lambda _url: ["not-a-product"])
    adapter._install_asf_response_compatibility(acquisition)

    with pytest.raises(adapter.AdapterError, match="invalid product record"):
        acquisition._get("https://asf.example.test")


def test_adapter_rejects_a_direct_workflow_request_outside_the_api_date_limit(tmp_path: Path) -> None:
    source_root = tmp_path / "science"; source_root.mkdir()
    with pytest.raises(adapter.AdapterError, match="cannot exceed 90 days"):
        adapter.run_job(adapter.JobInput(str(uuid4()), "POLYGON((85 27, 85.01 27, 85 27.01, 85 27))", date(2026, 1, 1), date(2026, 5, 1), source_root, tmp_path / "work", 1))


def test_adapter_propagates_inputs_uses_science_reader_and_removes_raw_data(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    source_root, work_dir = tmp_path / "science", tmp_path / "work"
    source_root.mkdir()
    seen: dict[str, object] = {}

    class Acquisition:
        def recon_nisar(self, start, end):
            seen["dates"] = (start, end)
            return [record("2026-10-01", "2026-10-13")]
        def download(self, _products, records):
            raw = source_root / "data" / "nisar_l2" / "_incoming" / Path(records[0]["url"]).name
            raw.parent.mkdir(parents=True, exist_ok=True)
            raw.write_bytes(b"raw")

    class Gunw:
        DEFAULT_COHERENCE = 0.3
        def read_gunw(self, raw, **kwargs):
            seen["reader"] = (raw, kwargs)
            return {"raw": raw}
        def report(self, _result): return {"quality": "source-reader-report"}
        def export_clipped(self, _result, output):
            target = output / "GUNW_test.tif"
            target.write_bytes(b"derived-geotiff")
            return {"export_status": "WRITTEN", "export_file": target.name, "export_valid_px": 9}

    monkeypatch.setattr(adapter, "_load_science_modules", lambda _root, wkt: (Acquisition(), Gunw(), SimpleNamespace()))
    job = adapter.JobInput(str(uuid4()), "POLYGON((85 27, 85.01 27, 85 27.01, 85 27))", date(2026, 10, 1), date(2026, 10, 22), source_root, work_dir, 1)
    manifest = adapter.run_job(job)
    assert seen["dates"] == ("2026-10-01", "2026-10-22")
    assert seen["reader"][1]["auto_ref"] is True
    assert manifest["analysis_type"] == "aoi_clipped_per_product_displacement_screening"
    assert manifest["validated_outputs"]
    assert not list((source_root / "data" / "nisar_l2" / "_incoming").glob("*.h5"))
    assert (work_dir / "result-manifest.json").is_file()


def test_adapter_fails_when_a_real_reader_returns_no_valid_science_pixels(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    source_root, work_dir = tmp_path / "science", tmp_path / "work"
    source_root.mkdir()

    class Acquisition:
        def recon_nisar(self, start, end): return [record("2026-10-01", "2026-10-13")]
        def download(self, _products, records):
            raw = source_root / "data" / "nisar_l2" / "_incoming" / Path(records[0]["url"]).name
            raw.parent.mkdir(parents=True, exist_ok=True); raw.write_bytes(b"raw")

    class Gunw:
        DEFAULT_COHERENCE = 0.3
        def read_gunw(self, *_args, **_kwargs): return {}
        def report(self, _result): return {}
        def export_clipped(self, _result, _output): return {"export_status": "NO_VALID_PIXELS"}

    monkeypatch.setattr(adapter, "_load_science_modules", lambda *_args: (Acquisition(), Gunw(), SimpleNamespace()))
    job = adapter.JobInput(str(uuid4()), "POLYGON((85 27, 85.01 27, 85 27.01, 85 27))", date(2026, 10, 1), date(2026, 10, 22), source_root, work_dir, 1)
    with pytest.raises(adapter.AdapterError, match="none contained valid AOI science pixels"):
        adapter.run_job(job)
