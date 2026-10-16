from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import date
from typing import Any

ASF_SEARCH_URL = "https://api.daac.asf.alaska.edu/services/search/param"
DEFAULT_MAX_RESULTS = 2_000
DEFAULT_TIMEOUT_SECONDS = 20


class ASFAdapterError(RuntimeError):
    """A safe, user-facing upstream ASF failure."""


class ASFAdapterNotConfigured(RuntimeError):
    """The adapter was intentionally disabled by server configuration."""


@dataclass(frozen=True)
class ASFSearchResult:
    rows: list[dict[str, Any]]
    truncated: bool
    query_url: str


def _setting_int(name: str, default: int, minimum: int, maximum: int) -> int:
    raw = os.getenv(name, str(default))
    try:
        value = int(raw)
    except ValueError as exc:
        raise ASFAdapterError(f"Invalid {name} configuration.") from exc
    if not minimum <= value <= maximum:
        raise ASFAdapterError(f"{name} must be between {minimum} and {maximum}.")
    return value


def _polygon_wkt(coordinates: list[tuple[float, float]]) -> str:
    points = [*coordinates, coordinates[0]]
    return "POLYGON ((" + ", ".join(f"{longitude} {latitude}" for longitude, latitude in points) + "))"


def _search_parameters(
    coordinates: list[tuple[float, float]],
    start_date: date,
    end_date: date,
    product_type: str,
    max_results: int,
) -> dict[str, str]:
    return {
        "intersectsWith": _polygon_wkt(coordinates),
        "platform": "NISAR",
        "processingLevel": product_type,
        "start": f"{start_date.isoformat()}T00:00:00Z",
        "end": f"{end_date.isoformat()}T23:59:59Z",
        "output": "jsonlite",
        "maxResults": str(max_results),
    }


def search_asf_catalog(
    coordinates: list[tuple[float, float]],
    start_date: date,
    end_date: date,
    product_type: str,
) -> ASFSearchResult:
    if os.getenv("ASF_CATALOG_ENABLED", "true").strip().lower() not in {"1", "true", "yes"}:
        raise ASFAdapterNotConfigured

    max_results = _setting_int("ASF_MAX_RESULTS", DEFAULT_MAX_RESULTS, 1, DEFAULT_MAX_RESULTS)
    timeout_seconds = _setting_int("ASF_TIMEOUT_SECONDS", DEFAULT_TIMEOUT_SECONDS, 1, 60)
    params = _search_parameters(coordinates, start_date, end_date, product_type, max_results)
    url = f"{os.getenv('ASF_SEARCH_URL', ASF_SEARCH_URL).rstrip('?')}?{urllib.parse.urlencode(params)}"
    request = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "SARGuardian-Dynamic/0.1"})

    try:
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise ASFAdapterError(f"ASF catalogue returned HTTP {exc.code}.") from None
    except (urllib.error.URLError, TimeoutError):
        raise ASFAdapterError("ASF catalogue request timed out or could not be reached.") from None
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise ASFAdapterError("ASF catalogue returned an invalid response.") from None

    if not isinstance(payload, dict) or not isinstance(payload.get("results"), list):
        raise ASFAdapterError("ASF catalogue returned an unexpected response shape.")
    rows = [row for row in payload["results"] if isinstance(row, dict)]
    return ASFSearchResult(rows=rows, truncated=len(rows) >= max_results, query_url=url)


def _date_fields(row: dict[str, Any]) -> list[str]:
    values = []
    for key in ("startTime", "stopTime"):
        value = row.get(key)
        if isinstance(value, str) and value:
            values.append(value[:10])
    return list(dict.fromkeys(values))


def _size_mb(row: dict[str, Any]) -> float | None:
    value = row.get("sizeMB")
    if isinstance(value, (int, float)) and value >= 0:
        return float(value)
    if not isinstance(value, dict):
        return None
    bytes_total = 0
    found = False
    for item in value.values():
        if isinstance(item, dict) and isinstance(item.get("bytes"), (int, float)) and item["bytes"] >= 0:
            bytes_total += item["bytes"]
            found = True
    return bytes_total / 1_000_000 if found else None


def normalize_product_rows(rows: list[dict[str, Any]], product_type: str) -> tuple[list[dict[str, Any]], int, list[str]]:
    products: list[dict[str, Any]] = []
    unknown_size = 0
    warnings: list[str] = []
    for row in rows:
        granule_name = row.get("granuleName")
        actual_type = row.get("productType")
        if not isinstance(granule_name, str) or not granule_name or actual_type != product_type:
            warnings.append("ASF returned a product record with incomplete or mismatched metadata; it was omitted.")
            continue
        size_mb = _size_mb(row)
        if size_mb is None:
            unknown_size += 1
        products.append({
            "granule_name": granule_name,
            "product_type": actual_type,
            "observation_dates": _date_fields(row),
            "start_time": row.get("startTime") if isinstance(row.get("startTime"), str) else None,
            "stop_time": row.get("stopTime") if isinstance(row.get("stopTime"), str) else None,
            "direction": row.get("flightDirection") if isinstance(row.get("flightDirection"), str) else None,
            "path": row.get("path") if isinstance(row.get("path"), (str, int)) else None,
            "size_mb": size_mb,
            "processing_date": row.get("processingDate") if isinstance(row.get("processingDate"), str) else None,
            "processing_level": row.get("processingLevel") if isinstance(row.get("processingLevel"), str) else None,
            "footprint_wkt": row.get("wkt") if isinstance(row.get("wkt"), str) else None,
        })
    return products, unknown_size, list(dict.fromkeys(warnings))
