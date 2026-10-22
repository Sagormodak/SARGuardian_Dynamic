from __future__ import annotations

import math
import logging
from contextlib import asynccontextmanager
from datetime import UTC, date, datetime
from uuid import UUID, uuid4

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.requests import Request
from fastapi.responses import JSONResponse

from .asf_catalog import ASFAdapterError, ASFAdapterNotConfigured, normalize_product_rows, search_asf_catalog
from .auth import get_current_user
from .config import SettingsError, get_settings, validate_production_settings
from .jobs import CreateJobRequest, JobResponse, JobState
from .models import CatalogResponse, CatalogSearchRequest
from .persistence import (
    PersistenceConfigurationError,
    PersistenceError,
    get_job_store,
)

logger = logging.getLogger(__name__)

EARTH_RADIUS_METERS = 6_371_000
MAX_AOI_AREA_KM2 = 1_000
MAX_DATE_WINDOW_DAYS = 90
MAX_REQUEST_BODY_BYTES = 1_000_000
ELIGIBILITY_UNDETERMINED_REASON = "Catalogue metadata alone does not establish scientific processing eligibility; the science workflow must inspect the selected products and AOI separately."


def _cors_origins() -> list[str]:
    settings = get_settings()
    configured = settings.cors_origins
    if settings.app_env == "production" and not configured:
        raise RuntimeError("CORS_ORIGINS must be explicitly configured in production.")
    if not configured.strip():
        configured = "http://localhost:5173,http://127.0.0.1:5173"
    return [origin.strip() for origin in configured.split(",") if origin.strip()]


@asynccontextmanager
async def lifespan(_app: FastAPI):
    try:
        validate_production_settings()
    except SettingsError as exc:
        raise RuntimeError(str(exc)) from None
    yield


app = FastAPI(title="SARGuardian Catalogue API", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins(),
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)


@app.exception_handler(Exception)
async def handle_unexpected_error(_request: Request, _exc: Exception) -> JSONResponse:
    logger.error("Unhandled API error", exc_info=True)
    return JSONResponse(status_code=500, content={"detail": "Internal server error."})


@app.middleware("http")
async def enforce_request_size(request: Request, call_next):
    content_length = request.headers.get("content-length")
    if content_length:
        try:
            if int(content_length) > MAX_REQUEST_BODY_BYTES:
                return JSONResponse(status_code=413, content={"detail": "Request body is too large."})
        except ValueError:
            return JSONResponse(status_code=400, content={"detail": "Invalid Content-Length header."})
    return await call_next(request)


def _validate_coordinates(coordinates: list[list[float]]) -> list[tuple[float, float]]:
    if len(coordinates) < 3:
        raise HTTPException(status_code=422, detail="AOI must contain at least 3 coordinates.")

    normalized: list[tuple[float, float]] = []
    for coordinate in coordinates:
        if len(coordinate) != 2:
            raise HTTPException(status_code=422, detail="Each AOI coordinate must contain longitude and latitude.")
        longitude, latitude = coordinate
        if not math.isfinite(longitude) or not math.isfinite(latitude):
            raise HTTPException(status_code=422, detail="AOI coordinates must be finite numbers.")
        if not -180 <= longitude <= 180 or not -90 <= latitude <= 90:
            raise HTTPException(status_code=422, detail="AOI coordinates must use WGS84 longitude/latitude ranges.")
        normalized.append((longitude, latitude))

    if normalized[-1] != normalized[0]:
        raise HTTPException(status_code=422, detail="AOI polygon must be closed by repeating its first coordinate.")
    normalized.pop()
    if len(normalized) < 3:
        raise HTTPException(status_code=422, detail="AOI must contain at least 3 distinct polygon vertices.")
    return normalized


def _area_km2(coordinates: list[tuple[float, float]]) -> float:
    ring = [*coordinates, coordinates[0]]
    total = 0.0
    for (longitude_a, latitude_a), (longitude_b, latitude_b) in zip(ring, ring[1:]):
        delta_longitude = math.radians(longitude_b - longitude_a)
        if delta_longitude > math.pi:
            delta_longitude -= 2 * math.pi
        if delta_longitude < -math.pi:
            delta_longitude += 2 * math.pi
        total += delta_longitude * (
            math.sin(math.radians(latitude_a)) + math.sin(math.radians(latitude_b))
        )
    return abs(total) * EARTH_RADIUS_METERS**2 / 2 / 1_000_000


def _validate_request(request: CatalogSearchRequest) -> tuple[float, list[tuple[float, float]]]:
    coordinates = _validate_coordinates(request.coordinates)
    area = _area_km2(coordinates)
    if not math.isfinite(area) or area <= 0:
        raise HTTPException(status_code=422, detail="AOI must have positive area.")
    if area > MAX_AOI_AREA_KM2:
        raise HTTPException(status_code=422, detail=f"AOI exceeds the {MAX_AOI_AREA_KM2} km2 maximum.")

    if request.end_date < request.start_date:
        raise HTTPException(status_code=422, detail="end_date must be on or after start_date.")
    if (request.end_date - request.start_date).days > MAX_DATE_WINDOW_DAYS:
        raise HTTPException(status_code=422, detail=f"Date range cannot exceed {MAX_DATE_WINDOW_DAYS} days.")
    if request.end_date > date.today():
        raise HTTPException(status_code=422, detail="end_date cannot be in the future.")
    return area, coordinates


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "sarguardian-catalogue-api"}


@app.post("/api/catalog/search", response_model=CatalogResponse)
def search_catalog(request: CatalogSearchRequest, _user: dict = Depends(get_current_user)) -> CatalogResponse:
    area, coordinates = _validate_request(request)
    checked_at = datetime.now(UTC).isoformat().replace("+00:00", "Z")
    query = {
        "platform": "NISAR",
        "product_type": request.product_type,
        "start_date": request.start_date,
        "end_date": request.end_date,
        "aoi_area_km2": area,
    }
    try:
        result = search_asf_catalog(coordinates, request.start_date, request.end_date, request.product_type)
    except ASFAdapterNotConfigured:
        return CatalogResponse(
            status="not_configured",
            message="Live ASF catalogue search is disabled by server configuration. No products were returned.",
            checked_at=checked_at,
            query=query,
            processing_eligibility={"status": "undetermined", "reason": ELIGIBILITY_UNDETERMINED_REASON},
            next_step="Set ASF_CATALOG_ENABLED=true to enable the read-only ASF metadata adapter.",
            warnings=["Metadata preflight only: no satellite files were downloaded and no scientific movement analysis was performed."],
        )
    except ASFAdapterError as exc:
        return JSONResponse(status_code=502, content={"status": "upstream_error", "message": str(exc)})

    products, unknown_size, metadata_warnings = normalize_product_rows(result.rows, request.product_type)
    total_gib = sum(product["size_mb"] or 0 for product in products) / 1024
    warnings = [*metadata_warnings]
    if result.truncated:
        warnings.append("ASF returned the configured result cap; narrow the AOI or date range for a complete search.")
    if unknown_size:
        warnings.append(f"Size metadata is unavailable for {unknown_size} product(s); the volume estimate is incomplete.")
    if not products:
        status = "no_data"
        message = "ASF catalogue search completed with no eligible products matching this AOI and date range."
        next_step = "Try another date range, AOI, or supported product family."
    else:
        status = "ready"
        message = "ASF catalogue metadata search completed. No satellite files were downloaded."
        next_step = "Review the returned metadata before any separate scientific processing workflow."
    response = CatalogResponse(
        status=status,
        message=message,
        checked_at=checked_at,
        query=query,
        processing_eligibility={"status": "undetermined", "reason": ELIGIBILITY_UNDETERMINED_REASON},
        product_count=len(products),
        truncated=result.truncated,
        products_with_unknown_size=unknown_size,
        estimated_full_granule_volume_gib=total_gib,
        estimated_full_granule_volume_is_complete=unknown_size == 0,
        products=products,
        next_step=next_step,
        warnings=[*warnings, "Metadata preflight only: no satellite files were downloaded and no scientific movement analysis was performed."],
    )
    if status != "ready":
        return response

    try:
        store = get_job_store()
        response.preflight_id = store.save_preflight(
            str(_user["uid"]),
            request.model_dump(mode="json"),
            response.model_dump(mode="json"),
        )
    except PersistenceConfigurationError as exc:
        return JSONResponse(status_code=503, content={"status": "persistence_not_configured", "message": str(exc)})
    except PersistenceError:
        return JSONResponse(status_code=503, content={"status": "persistence_error", "message": "The preflight could not be persisted for job confirmation."})
    return response


def _required_owner_uid(user: dict) -> str:
    owner_uid = user.get("uid")
    if not isinstance(owner_uid, str) or not owner_uid:
        raise HTTPException(status_code=401, detail="Authenticated Firebase user identity is unavailable.")
    return owner_uid


def _require_store():
    try:
        return get_job_store()
    except PersistenceConfigurationError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from None


def _job_response(record: dict) -> JobResponse:
    return JobResponse.model_validate(record)


@app.post("/api/jobs", response_model=JobResponse)
def create_job(request: CreateJobRequest, user: dict = Depends(get_current_user)) -> JobResponse:
    owner_uid = _required_owner_uid(user)
    store = _require_store()
    try:
        preflight = store.get_preflight(owner_uid, request.preflight_id)
    except PersistenceError:
        raise HTTPException(status_code=503, detail="Could not read the preflight persistence service.") from None
    if not preflight:
        raise HTTPException(status_code=404, detail="Preflight manifest was not found for this user.")
    try:
        expires_at = datetime.fromisoformat(str(preflight["expires_at"]).replace("Z", "+00:00"))
    except (KeyError, TypeError, ValueError):
        raise HTTPException(status_code=409, detail="Preflight manifest is invalid; run the catalogue search again.") from None
    if expires_at <= datetime.now(UTC):
        raise HTTPException(status_code=409, detail="Preflight manifest has expired; run the catalogue search again.")
    manifest = preflight.get("manifest_snapshot")
    request_snapshot = preflight.get("request_snapshot")
    if not isinstance(manifest, dict) or manifest.get("status") != "ready" or not isinstance(request_snapshot, dict):
        raise HTTPException(status_code=409, detail="Only a current successful preflight can be confirmed as a job.")

    try:
        existing = store.get_job_by_idempotency(owner_uid, request.idempotency_key)
    except PersistenceError:
        raise HTTPException(status_code=503, detail="Could not read the job persistence service.") from None
    if existing:
        return _job_response(existing)
    values = {
        "id": str(uuid4()),
        "owner_uid": owner_uid,
        "preflight_id": str(request.preflight_id),
        "idempotency_key": request.idempotency_key,
        "product_family": request_snapshot.get("product_type"),
        "state": JobState.QUEUED.value,
        "request_snapshot": request_snapshot,
        "manifest_snapshot": manifest,
    }
    try:
        return _job_response(store.create_job(values))
    except PersistenceError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from None


@app.get("/api/jobs", response_model=list[JobResponse])
def list_jobs(user: dict = Depends(get_current_user)) -> list[JobResponse]:
    owner_uid = _required_owner_uid(user)
    try:
        records = _require_store().list_jobs(owner_uid)
    except PersistenceError:
        raise HTTPException(status_code=503, detail="Could not read the job persistence service.") from None
    return [_job_response(record) for record in records]


@app.get("/api/jobs/{job_id}", response_model=JobResponse)
def get_job(job_id: UUID, user: dict = Depends(get_current_user)) -> JobResponse:
    owner_uid = _required_owner_uid(user)
    try:
        record = _require_store().get_job(owner_uid, job_id)
    except PersistenceError:
        raise HTTPException(status_code=503, detail="Could not read the job persistence service.") from None
    if not record:
        raise HTTPException(status_code=404, detail="Processing job was not found for this user.")
    return _job_response(record)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app.main:app", host="0.0.0.0", port=get_settings().port)
