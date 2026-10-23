"""Run the supported per-product SARGuardian displacement screening workflow.

This adapter intentionally stops at AOI-clipped GUNW/GOFF outputs.  It does
not assemble an arbitrary-AOI time series or make a hazard/forecast claim:
the pinned science source does not support that for ``custom`` AOIs.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib
import json
import logging
import os
import sys
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any, Iterable
from uuid import UUID

SCIENCE_REPOSITORY = "moshiour0/SARGuardian"
SCIENCE_REF = "10639a916c9829850775410b3ed7de62e527770d"
PRODUCT_TYPES = frozenset({"GUNW", "GOFF"})
MAX_DATE_WINDOW_DAYS = 90

logger = logging.getLogger("sarguardian.dynamic-displacement")


class AdapterError(RuntimeError):
    """A safe failure suitable for the worker callback."""


@dataclass(frozen=True)
class JobInput:
    job_id: str
    aoi_wkt: str
    start_date: date
    end_date: date
    science_root: Path
    work_dir: Path
    max_download_gib: float


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def write_stage(work_dir: Path, stage: str, **details: Any) -> None:
    work_dir.mkdir(parents=True, exist_ok=True)
    event = {"stage": stage, **details}
    with (work_dir / "stage-events.jsonl").open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(event, default=str, sort_keys=True) + "\n")
    logger.info("stage=%s %s", stage, json.dumps(details, default=str, sort_keys=True))


def select_eligible_products(records: Iterable[dict[str, Any]], start_date: date, end_date: date) -> list[dict[str, Any]]:
    """Use the strict, reproducible policy: both acquisitions are in-window."""
    if end_date < start_date:
        raise AdapterError("End date must be on or after start date.")
    selected = [
        record for record in records
        if record.get("productType") in PRODUCT_TYPES
        and isinstance(record.get("reference"), date)
        and isinstance(record.get("secondary"), date)
        and start_date <= record["reference"] <= record["secondary"] <= end_date
        and isinstance(record.get("url"), str) and record["url"]
    ]
    selected.sort(key=lambda item: (item["secondary"], item["reference"], item["productType"], item["granule"]))
    return selected


def enforce_download_budget(records: Iterable[dict[str, Any]], max_download_gib: float) -> float:
    if max_download_gib <= 0:
        raise AdapterError("Maximum download budget must be positive.")
    sizes_mb: list[float] = []
    for record in records:
        size_mb = record.get("size_mb")
        if not isinstance(size_mb, (int, float)) or size_mb <= 0:
            raise AdapterError("A selected product has no validated download size.")
        sizes_mb.append(float(size_mb))
    total_gib = sum(sizes_mb) / 1024
    if total_gib > max_download_gib:
        raise AdapterError(f"Selected products require {total_gib:.2f} GiB, exceeding the configured {max_download_gib:.2f} GiB worker budget.")
    return total_gib


def resolve_download_sizes(records: Iterable[dict[str, Any]], acquisition: Any) -> list[dict[str, Any]]:
    """Resolve missing catalogue sizes before enforcing the hard download limit.

    Current ASF NISAR catalogue responses may omit ``sizeMB``.  Use the pinned
    source's authenticated ASF session to make a HEAD-only request to the final
    data URL, then require a positive Content-Length.  A missing or invalid size
    remains a safe failure; it can never bypass the configured download budget.
    """
    session: Any | None = None
    resolved: list[dict[str, Any]] = []
    for record in records:
        size_mb = record.get("size_mb")
        if isinstance(size_mb, (int, float)) and size_mb > 0:
            resolved.append(record)
            continue
        if session is None:
            try:
                session = acquisition.build_session()
            except AdapterError:
                raise
            except Exception as exc:
                raise AdapterError("Could not initialize the authenticated ASF session for size validation.") from exc
        response: Any | None = None
        try:
            response = session.head(str(record["url"]), allow_redirects=True, timeout=60)
            response.raise_for_status()
            content_length = response.headers.get("Content-Length")
            byte_count = int(content_length) if isinstance(content_length, str) and content_length.isdigit() else 0
        except Exception as exc:
            raise AdapterError("Could not validate the download size for a selected ASF product.") from exc
        finally:
            if response is not None:
                response.close()
        if byte_count <= 0:
            raise AdapterError("ASF did not provide a valid Content-Length for a selected product.")
        resolved.append(record | {"size_mb": byte_count / (1024 * 1024)})
    return resolved


def _install_earthdata_token_session(acquisition: Any) -> None:
    """Prefer an explicit EDL token for GUNW/GOFF when one is configured.

    ``asf_search.auth_with_creds`` additionally requests an ``asf-urs`` cookie.
    The upstream client documents that cookie as necessary for certain products
    such as SLC bursts, not these NISAR Level-2 products.  A scoped EDL user
    token is authenticated by the upstream client and is passed to both the
    HEAD size check and the source's existing download function.
    """
    token = os.getenv("EARTHDATA_TOKEN", "").strip()
    if not token:
        return
    try:
        import asf_search as asf
    except ImportError as exc:  # pragma: no cover - workflow installs this dependency
        raise AdapterError("The pinned ASF client is unavailable for Earthdata token authentication.") from exc

    def build_session() -> Any:
        try:
            return asf.ASFSession().auth_with_token(token)
        except Exception as exc:
            # The upstream client uses this exact safe message for a bad EDL
            # token.  Do not include exception data that could contain a token.
            if "Invalid/Expired token passed" in str(exc):
                raise AdapterError("Earthdata token was rejected or has expired.") from exc
            raise AdapterError("Earthdata token authentication failed; authorize the ASF application and generate a new token.") from exc

    acquisition.build_session = build_session


def _install_asf_response_compatibility(acquisition: Any) -> None:
    """Adapt the pinned source's documented dict-or-list ASF JSON contract.

    The pinned source annotates ``_get`` as returning ``dict | list``, but its
    ``asf_query`` immediately calls ``.get``.  ASF currently returns batches as
    a top-level list of product lists for this query.  Normalizing only that
    response to the source's existing ``{"results": [...]}`` shape preserves
    every catalogue record and lets the original acquisition, filtering, and
    reader code remain authoritative.
    """
    source_get = acquisition._get

    def normalized_rows(rows: list[Any]) -> list[dict[str, Any]]:
        if not all(isinstance(row, dict) for row in rows):
            raise AdapterError("ASF catalogue returned a list containing an invalid product record.")
        normalized: list[dict[str, Any]] = []
        for row in rows:
            normalized_row = dict(row)
            product = row.get("productType") or row.get("processingLevel")
            path = row.get("path")
            if isinstance(product, str):
                normalized_row["productType"] = product.upper()
            if path is None:
                path = row.get("relativeOrbit", row.get("track"))
            if path is not None:
                normalized_row["path"] = path
            normalized.append(normalized_row)
        return normalized

    def compatible_get(*args: Any, **kwargs: Any) -> dict[str, Any]:
        response = source_get(*args, **kwargs)
        if isinstance(response, list):
            if all(isinstance(row, dict) for row in response):
                return {"results": normalized_rows(response)}
            if all(isinstance(batch, list) for batch in response):
                rows = [row for batch in response for row in batch]
                return {"results": normalized_rows(rows)}
            raise AdapterError("ASF catalogue returned a list containing an invalid product record.")
        if not isinstance(response, dict):
            raise AdapterError("ASF catalogue returned an unsupported JSON response type.")
        results = response.get("results")
        if results is not None and (
            not isinstance(results, list) or not all(isinstance(row, dict) for row in results)
        ):
            raise AdapterError("ASF catalogue returned an invalid results payload.")
        return response | ({"results": normalized_rows(results)} if isinstance(results, list) else {})

    acquisition._get = compatible_get


def _load_science_modules(science_root: Path, aoi_wkt: str) -> tuple[Any, Any, Any]:
    source_dir = science_root / "src"
    if not (source_dir / "aoi_wkt.py").is_file():
        raise AdapterError("Pinned science source does not contain the required WKT parser.")
    os.environ["SARGUARDIAN_AOI_WKT"] = aoi_wkt
    sys.path.insert(0, str(source_dir))
    for name in ("aoi_wkt", "gunw_reader", "goff_reader", "nisar_acquisition"):
        sys.modules.pop(name, None)
    aoi_wkt_module = importlib.import_module("aoi_wkt")
    try:
        aoi_wkt_module.parse_polygon_wkt(aoi_wkt)
    except ValueError as exc:
        raise AdapterError(f"Science source rejected AOI WKT: {exc}") from None
    gunw = importlib.import_module("gunw_reader")
    goff = importlib.import_module("goff_reader")
    acquisition = importlib.import_module("nisar_acquisition")
    _install_asf_response_compatibility(acquisition)
    _install_earthdata_token_session(acquisition)
    if "custom" not in gunw.AOIS:
        raise AdapterError("Pinned science source did not install the submitted custom AOI.")
    acquisition.set_aoi("custom")
    gunw.set_aoi("custom")
    return acquisition, gunw, goff


def _raw_path(science_root: Path, record: dict[str, Any]) -> Path:
    filename = Path(str(record["url"]).split("?", 1)[0]).name
    candidate = (science_root / "data" / "nisar_l2" / "_incoming" / filename).resolve()
    incoming = (science_root / "data" / "nisar_l2" / "_incoming").resolve()
    if incoming not in candidate.parents or not candidate.name.startswith("NISAR_"):
        raise AdapterError("Source data path failed the safe cleanup check.")
    return candidate


def _validated_output(path: Path, kind: str, product: str) -> dict[str, Any]:
    return {"path": str(path.relative_to(path.parents[2])).replace("\\", "/"), "kind": kind, "product_type": product, "sha256": sha256_file(path), "bytes": path.stat().st_size}


def process_record(record: dict[str, Any], science_root: Path, work_dir: Path, gunw: Any, goff: Any) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    product = str(record["productType"])
    raw = _raw_path(science_root, record)
    granule = Path(str(record["granule"])).name
    if not granule.startswith("NISAR_"):
        raise AdapterError("Catalogue product identifier failed the safe output-path check.")
    output_root = work_dir / "outputs" / Path(granule).stem
    output_root.mkdir(parents=True, exist_ok=True)
    try:
        if product == "GUNW":
            result = gunw.read_gunw(raw, coherence_threshold=gunw.DEFAULT_COHERENCE, clip_aoi=True, apply_iono=True, auto_ref=True)
            summary: dict[str, Any] = gunw.report(result)
            export = gunw.export_clipped(result, output_root)
            summary["export"] = export
            exports = [output_root / export["export_file"]] if export.get("export_status") == "WRITTEN" else []
        elif product == "GOFF":
            result = goff.read_goff(raw, layer="best", correlation_min=goff.DEFAULT_CORRELATION, snr_min=goff.DEFAULT_SNR, cull_sigma=goff.CULL_SIGMA if hasattr(goff, "CULL_SIGMA") else 4.0, clip_aoi=True, auto_ref=True, deramp=True)
            summary = {"layers": goff.report(result, span_days=(record["secondary"] - record["reference"]).days)}
            export_rows = goff.export_clipped(result, output_root)
            summary["export"] = export_rows
            exports = [output_root / item["export_file"] for item in export_rows if item.get("export_status") == "WRITTEN" and item.get("export_file")]
        else:  # pragma: no cover - selection prevents this path
            raise AdapterError(f"Unsupported product type {product}.")
        summary_path = output_root / "product-summary.json"
        summary_path.write_text(json.dumps(summary, default=str, indent=2, sort_keys=True), encoding="utf-8")
        outputs = [_validated_output(path, "aoi_clipped_geotiff", product) for path in exports]
        if outputs:
            outputs.append(_validated_output(summary_path, "processing_summary", product))
        return {"granule": granule, "product_type": product, "reference": str(record["reference"]), "secondary": str(record["secondary"]), "export_status": "WRITTEN" if outputs else "NO_VALID_SCIENCE_PIXELS"}, outputs
    finally:
        if raw.exists():
            raw.unlink()


def run_job(job: JobInput) -> dict[str, Any]:
    UUID(job.job_id)
    if job.end_date < job.start_date:
        raise AdapterError("End date must be on or after start date.")
    if (job.end_date - job.start_date).days > MAX_DATE_WINDOW_DAYS:
        raise AdapterError(f"Date range cannot exceed {MAX_DATE_WINDOW_DAYS} days.")
    if not job.science_root.is_dir():
        raise AdapterError("Pinned science source checkout is unavailable.")
    write_stage(job.work_dir, "validating_input", job_id=job.job_id)
    acquisition, gunw, goff = _load_science_modules(job.science_root, job.aoi_wkt)
    write_stage(job.work_dir, "discovering_products", start_date=str(job.start_date), end_date=str(job.end_date))
    records = acquisition.recon_nisar(start=job.start_date.isoformat(), end=job.end_date.isoformat())
    selected = select_eligible_products(records, job.start_date, job.end_date)
    if not selected:
        raise AdapterError("No eligible GUNW or GOFF products have both acquisitions inside the requested date window.")
    write_stage(job.work_dir, "resolving_download_sizes", selected_product_count=len(selected))
    selected = resolve_download_sizes(selected, acquisition)
    download_gib = enforce_download_budget(selected, job.max_download_gib)
    product_results: list[dict[str, Any]] = []
    validated_outputs: list[dict[str, Any]] = []
    for ordinal, record in enumerate(selected, 1):
        write_stage(job.work_dir, "processing_product", ordinal=ordinal, total=len(selected), granule=record["granule"], product_type=record["productType"])
        acquisition.download([record["productType"]], [record])
        result, outputs = process_record(record, job.science_root, job.work_dir, gunw, goff)
        product_results.append(result)
        validated_outputs.extend(outputs)
    if not validated_outputs:
        raise AdapterError("Eligible products were processed but none contained valid AOI science pixels.")
    manifest = {
        "schema_version": 1,
        "job_id": job.job_id,
        "status": "succeeded",
        "analysis_type": "aoi_clipped_per_product_displacement_screening",
        "scientific_limit": "Per-product AOI-clipped GUNW/GOFF outputs; no arbitrary-AOI time-series, velocity trend, or forecast is claimed.",
        "science_source_repository": SCIENCE_REPOSITORY,
        "science_source_ref": SCIENCE_REF,
        "aoi_wkt_sha256": hashlib.sha256(job.aoi_wkt.encode("utf-8")).hexdigest(),
        "start_date": job.start_date.isoformat(), "end_date": job.end_date.isoformat(),
        "date_policy": "both_acquisitions_inside_requested_window",
        "selected_product_count": len(selected), "estimated_download_gib": round(download_gib, 3),
        "products": product_results, "validated_outputs": validated_outputs,
    }
    (job.work_dir / "result-manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True), encoding="utf-8")
    write_stage(job.work_dir, "completed", validated_output_count=len(validated_outputs))
    return manifest


def _parse_date(value: str) -> date:
    return date.fromisoformat(value)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--job-id", required=True)
    parser.add_argument("--aoi-wkt", required=True)
    parser.add_argument("--start-date", required=True, type=_parse_date)
    parser.add_argument("--end-date", required=True, type=_parse_date)
    parser.add_argument("--science-root", required=True, type=Path)
    parser.add_argument("--work-dir", required=True, type=Path)
    parser.add_argument("--max-download-gib", type=float, default=20.0)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    try:
        run_job(JobInput(args.job_id, args.aoi_wkt, args.start_date, args.end_date, args.science_root.resolve(), args.work_dir.resolve(), args.max_download_gib))
    except (AdapterError, ValueError) as exc:
        logger.error("%s", exc)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
