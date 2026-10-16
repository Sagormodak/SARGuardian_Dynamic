from __future__ import annotations

from datetime import UTC, datetime
from enum import StrEnum
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, Field


class JobState(StrEnum):
    QUEUED = "queued"
    DISPATCHING = "dispatching"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"


VALID_TRANSITIONS: dict[JobState, frozenset[JobState]] = {
    JobState.QUEUED: frozenset({JobState.DISPATCHING, JobState.CANCELLED}),
    JobState.DISPATCHING: frozenset({JobState.RUNNING, JobState.FAILED, JobState.CANCELLED}),
    JobState.RUNNING: frozenset({JobState.SUCCEEDED, JobState.FAILED, JobState.CANCELLED}),
    JobState.SUCCEEDED: frozenset(),
    JobState.FAILED: frozenset(),
    JobState.CANCELLED: frozenset(),
}


class CreateJobRequest(BaseModel):
    preflight_id: UUID
    idempotency_key: str = Field(min_length=16, max_length=128, pattern=r"^[A-Za-z0-9._:-]+$")
    confirm: Literal[True]


class JobResponse(BaseModel):
    id: UUID
    owner_uid: str
    preflight_id: UUID
    product_family: Literal["GUNW", "GOFF"]
    state: JobState
    request_snapshot: dict[str, Any]
    manifest_snapshot: dict[str, Any]
    worker_run_id: str | None = None
    error_code: str | None = None
    error_message: str | None = None
    created_at: datetime
    updated_at: datetime


def validate_transition(current: JobState, next_state: JobState) -> None:
    if next_state not in VALID_TRANSITIONS[current]:
        raise ValueError(f"Invalid job transition: {current.value} -> {next_state.value}.")


def utc_now() -> datetime:
    return datetime.now(UTC)
