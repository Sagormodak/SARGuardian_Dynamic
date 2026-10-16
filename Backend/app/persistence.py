from __future__ import annotations

import hashlib
import json
import os
from datetime import UTC, datetime, timedelta
from functools import lru_cache
from typing import Any, Protocol
from uuid import UUID, uuid4

try:
    from supabase import Client, ClientOptions, create_client
except ImportError:  # pragma: no cover - exercised by configuration tests
    Client = Any  # type: ignore[assignment,misc]
    ClientOptions = None
    create_client = None


class PersistenceConfigurationError(RuntimeError):
    pass


class PersistenceError(RuntimeError):
    pass


class PreflightNotFoundError(PersistenceError):
    pass


class PreflightExpiredError(PersistenceError):
    pass


class JobStore(Protocol):
    def save_preflight(self, owner_uid: str, request_snapshot: dict[str, Any], manifest_snapshot: dict[str, Any]) -> UUID: ...
    def get_preflight(self, owner_uid: str, preflight_id: UUID) -> dict[str, Any] | None: ...
    def get_job_by_idempotency(self, owner_uid: str, idempotency_key: str) -> dict[str, Any] | None: ...
    def create_job(self, values: dict[str, Any]) -> dict[str, Any]: ...
    def list_jobs(self, owner_uid: str, limit: int = 100) -> list[dict[str, Any]]: ...
    def get_job(self, owner_uid: str, job_id: UUID) -> dict[str, Any] | None: ...


def request_fingerprint(request_snapshot: dict[str, Any], manifest_snapshot: dict[str, Any]) -> str:
    payload = json.dumps({"request": request_snapshot, "manifest": manifest_snapshot}, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


class SupabaseJobStore:
    def __init__(self, client: Client, preflight_ttl_seconds: int) -> None:
        self.client = client
        self.preflight_ttl_seconds = preflight_ttl_seconds

    @staticmethod
    def _data(response: Any) -> list[dict[str, Any]]:
        data = getattr(response, "data", None)
        return data if isinstance(data, list) else []

    def save_preflight(self, owner_uid: str, request_snapshot: dict[str, Any], manifest_snapshot: dict[str, Any]) -> UUID:
        preflight_id = uuid4()
        expires_at = datetime.now(UTC) + timedelta(seconds=self.preflight_ttl_seconds)
        values = {
            "id": str(preflight_id),
            "owner_uid": owner_uid,
            "request_fingerprint": request_fingerprint(request_snapshot, manifest_snapshot),
            "request_snapshot": request_snapshot,
            "manifest_snapshot": manifest_snapshot,
            "expires_at": expires_at.isoformat(),
        }
        try:
            response = self.client.table("catalog_preflights").insert(values).select("id").execute()
        except Exception as exc:
            raise PersistenceError("Could not persist the catalogue preflight.") from exc
        if not self._data(response):
            raise PersistenceError("Catalogue preflight persistence returned no record.")
        return preflight_id

    def get_preflight(self, owner_uid: str, preflight_id: UUID) -> dict[str, Any] | None:
        try:
            response = (
                self.client.table("catalog_preflights")
                .select("*")
                .eq("id", str(preflight_id))
                .eq("owner_uid", owner_uid)
                .limit(1)
                .execute()
            )
        except Exception as exc:
            raise PersistenceError("Could not read the catalogue preflight.") from exc
        rows = self._data(response)
        return rows[0] if rows else None

    def get_job_by_idempotency(self, owner_uid: str, idempotency_key: str) -> dict[str, Any] | None:
        try:
            response = (
                self.client.table("processing_jobs")
                .select("*")
                .eq("owner_uid", owner_uid)
                .eq("idempotency_key", idempotency_key)
                .limit(1)
                .execute()
            )
        except Exception as exc:
            raise PersistenceError("Could not check job idempotency.") from exc
        rows = self._data(response)
        return rows[0] if rows else None

    def create_job(self, values: dict[str, Any]) -> dict[str, Any]:
        existing = self.get_job_by_idempotency(values["owner_uid"], values["idempotency_key"])
        if existing:
            return existing
        try:
            response = self.client.table("processing_jobs").insert(values).select("*").execute()
        except Exception:
            # A concurrent request may have won the unique idempotency constraint.
            existing = self.get_job_by_idempotency(values["owner_uid"], values["idempotency_key"])
            if existing:
                return existing
            raise PersistenceError("Could not persist the processing job.") from None
        rows = self._data(response)
        if not rows:
            raise PersistenceError("Job persistence returned no record.")
        return rows[0]

    def list_jobs(self, owner_uid: str, limit: int = 100) -> list[dict[str, Any]]:
        try:
            response = (
                self.client.table("processing_jobs")
                .select("*")
                .eq("owner_uid", owner_uid)
                .order("created_at", desc=True)
                .limit(limit)
                .execute()
            )
        except Exception as exc:
            raise PersistenceError("Could not list processing jobs.") from exc
        return self._data(response)

    def get_job(self, owner_uid: str, job_id: UUID) -> dict[str, Any] | None:
        try:
            response = (
                self.client.table("processing_jobs")
                .select("*")
                .eq("owner_uid", owner_uid)
                .eq("id", str(job_id))
                .limit(1)
                .execute()
            )
        except Exception as exc:
            raise PersistenceError("Could not read the processing job.") from exc
        rows = self._data(response)
        return rows[0] if rows else None


@lru_cache(maxsize=1)
def get_job_store() -> SupabaseJobStore:
    url = os.getenv("SUPABASE_URL", "").strip()
    service_role_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "").strip()
    if not url or not service_role_key:
        raise PersistenceConfigurationError("Supabase persistence is not configured on this server.")
    if create_client is None or ClientOptions is None:
        raise PersistenceConfigurationError("The Supabase Python SDK is not installed on this server.")
    try:
        client = create_client(
            url,
            service_role_key,
            options=ClientOptions(auto_refresh_token=False, persist_session=False),
        )
    except Exception as exc:
        raise PersistenceConfigurationError("Supabase persistence could not be initialized.") from exc
    try:
        ttl = int(os.getenv("PREFLIGHT_TTL_SECONDS", "86400"))
    except ValueError as exc:
        raise PersistenceConfigurationError("PREFLIGHT_TTL_SECONDS is invalid.") from exc
    if not 60 <= ttl <= 604800:
        raise PersistenceConfigurationError("PREFLIGHT_TTL_SECONDS must be between 60 and 604800.")
    return SupabaseJobStore(client, ttl)
