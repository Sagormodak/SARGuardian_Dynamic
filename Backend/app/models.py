from __future__ import annotations

from datetime import date
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field

NisarProductType = Literal["GUNW", "GOFF", "BOTH"]


class CatalogSearchRequest(BaseModel):
    coordinates: list[list[float]] = Field(min_length=4, max_length=10000)
    start_date: date
    end_date: date
    product_type: NisarProductType


class CatalogProduct(BaseModel):
    granule_name: str
    product_type: str
    observation_dates: list[str]
    start_time: str | None = None
    stop_time: str | None = None
    direction: str | None = None
    path: str | int | None = None
    size_mb: float | None = None
    processing_date: str | None = None
    processing_level: str | None = None
    footprint_wkt: str | None = None


class ProcessingEligibility(BaseModel):
    status: Literal["undetermined"] = "undetermined"
    reason: str


class CatalogQuery(BaseModel):
    platform: str
    product_type: NisarProductType
    start_date: date
    end_date: date
    aoi_area_km2: float


class CatalogResponse(BaseModel):
    mode: Literal["catalog-preflight-only"] = "catalog-preflight-only"
    status: Literal["ready", "no_data", "insufficient_data", "not_configured", "upstream_error"]
    message: str
    checked_at: str
    data_downloaded: Literal[False] = False
    scientific_analysis_performed: Literal[False] = False
    processing_eligibility: ProcessingEligibility
    preflight_id: UUID | None = None
    query: CatalogQuery
    product_count: int = 0
    truncated: bool = False
    products_with_unknown_size: int = 0
    estimated_full_granule_volume_gib: float = 0
    estimated_full_granule_volume_is_complete: bool = False
    products: list[CatalogProduct] = Field(default_factory=list)
    next_step: str
    warnings: list[str] = Field(default_factory=list)
