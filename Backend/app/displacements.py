from __future__ import annotations

import hashlib
import hmac
import json
import re
from datetime import UTC, date, datetime
from typing import Any, Literal
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from uuid import UUID

from pydantic import BaseModel, Field, field_validator

from .config import RuntimeSettings
from .jobs import JobState


class CreateDisplacementJobRequest(BaseModel):
    aoi_wkt: str = Field(min_length=20, max_length=100_000)
    start_date: date
    end_date: date
    idempotency_key: str = Field(min_length=16, max_length=128, pattern=r"^[A-Za-z0-9._:-]+$")

    @field_validator("aoi_wkt")
    @classmethod
    def require_single_ring_wgs84_polygon(cls, value: str) -> str:
        text = value.strip()
        match = re.fullmatch(r"(?is)POLYGON\s*\(\s*\((.*?)\)\s*\)", text)
        if not match or re.search(r"\)\s*,\s*\(", match.group(1)):
            raise ValueError("AOI must be a single-ring WGS84 POLYGON.")
        points: list[tuple[float, float]] = []
        for item in match.group(1).split(","):
            parts = item.split()
            if len(parts) != 2:
                raise ValueError("AOI coordinates must be longitude/latitude pairs.")
            try:
                lon, lat = float(parts[0]), float(parts[1])
            except ValueError:
                raise ValueError("AOI coordinates must be numeric.") from None
            if not -180 <= lon <= 180 or not -90 <= lat <= 90:
                raise ValueError("AOI coordinates must be WGS84 longitude/latitude values.")
            points.append((lon, lat))
        if len(set(points[:-1] if points and points[0] == points[-1] else points)) < 3:
            raise ValueError("AOI needs at least three distinct vertices.")
        return text


class DisplacementJobResponse(BaseModel):
    id: UUID
    state: JobState
    aoi_wkt: str
    start_date: date
    end_date: date
    stage: str
    github_run_id: str | None = None
    github_run_url: str | None = None
    error_code: str | None = None
    error_message: str | None = None
    result_summary: dict[str, Any] | None = None
    artifact_url: str | None = None
    created_at: str
    updated_at: str


class WorkerCallback(BaseModel):
    state: Literal["running", "succeeded", "failed"]
    sequence: int = Field(ge=1, le=1_000)
    stage: str = Field(min_length=1, max_length=80)
    github_run_id: str = Field(min_length=1, max_length=64)
    github_run_url: str | None = Field(default=None, max_length=2_048)
    error_code: str | None = Field(default=None, max_length=80)
    error_message: str | None = Field(default=None, max_length=500)
    result_summary: dict[str, Any] | None = None
    artifact_url: str | None = Field(default=None, max_length=2_048)


class GitHubDispatchError(RuntimeError):
    pass


def dispatch_workflow(settings: RuntimeSettings, job_id: UUID, request: CreateDisplacementJobRequest) -> None:
    if not settings.displacement_actions_enabled:
        raise GitHubDispatchError("Displacement processing is not configured on this server.")
    endpoint = f"{settings.github_api_url}/repos/{settings.github_actions_repository}/actions/workflows/{settings.github_actions_workflow}/dispatches"
    body = json.dumps({"ref": settings.github_actions_ref, "inputs": {
        "job_id": str(job_id), "aoi_wkt": request.aoi_wkt,
        "start_date": request.start_date.isoformat(), "end_date": request.end_date.isoformat(),
        "callback_url": settings.public_api_url,
    }}).encode("utf-8")
    request_obj = Request(endpoint, data=body, method="POST", headers={
        "Accept": "application/vnd.github+json", "Authorization": f"Bearer {settings.github_actions_token}",
        "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json",
    })
    try:
        with urlopen(request_obj, timeout=15) as response:
            if response.status != 204:
                raise GitHubDispatchError("GitHub Actions did not accept the displacement workflow.")
    except HTTPError as exc:
        raise GitHubDispatchError(f"GitHub Actions dispatch was rejected ({exc.code}).") from None
    except (URLError, TimeoutError):
        raise GitHubDispatchError("Could not reach GitHub Actions to dispatch the workflow.") from None


def callback_signature_is_valid(secret: str, body: bytes, signature: str | None) -> bool:
    if not secret or not signature:
        return False
    expected = "sha256=" + hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature)


def workflow_run_status(settings: RuntimeSettings, run_id: str) -> tuple[str, str | None] | None:
    """Read GitHub's terminal state; never promote a job to success here."""
    endpoint = f"{settings.github_api_url}/repos/{settings.github_actions_repository}/actions/runs/{run_id}"
    request = Request(endpoint, headers={
        "Accept": "application/vnd.github+json", "Authorization": f"Bearer {settings.github_actions_token}",
        "X-GitHub-Api-Version": "2022-11-28",
    })
    try:
        with urlopen(request, timeout=10) as response:
            data = json.loads(response.read().decode("utf-8"))
    except (HTTPError, URLError, TimeoutError, json.JSONDecodeError):
        return None
    status = data.get("status")
    conclusion = data.get("conclusion")
    return (status, conclusion) if isinstance(status, str) and (isinstance(conclusion, str) or conclusion is None) else None


def is_dispatch_timed_out(record: dict[str, Any], timeout_seconds: int) -> bool:
    if record.get("state") != JobState.DISPATCHING.value:
        return False
    try:
        updated_at = datetime.fromisoformat(str(record["updated_at"]).replace("Z", "+00:00"))
    except (KeyError, TypeError, ValueError):
        return False
    return (datetime.now(UTC) - updated_at).total_seconds() > timeout_seconds
