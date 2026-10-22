from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime, timedelta
from functools import lru_cache
from typing import Any, Protocol
from uuid import UUID, uuid4

from .config import SettingsError, get_settings

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


MODERN_SUPABASE_KEY_PREFIXES = ("sb_publishable_", "sb_secret_")


def _is_modern_supabase_key(api_key: str) -> bool:
    return api_key.startswith(MODERN_SUPABASE_KEY_PREFIXES)


def _normalize_modern_key_headers(client: Any, api_key: str) -> None:
    """Make PostgREST use an opaque Supabase key as `apikey`, never as Bearer."""
    options = getattr(client, "options", None)
    headers = getattr(options, "headers", None)
    if not isinstance(headers, dict):
        raise PersistenceConfigurationError("Supabase client headers could not be configured safely.")

    for name in tuple(headers):
        if name.lower() in {"authorization", "apikey", "api-key"}:
            del headers[name]
    headers["apikey"] = api_key


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
            raise PersistenceError("Could not persist the catalogue preflight.") from None
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
            raise PersistenceError("Could not read the catalogue preflight.") from None
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
            raise PersistenceError("Could not check job idempotency.") from None
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
            raise PersistenceError("Could not list processing jobs.") from None
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
            raise PersistenceError("Could not read the processing job.") from None
        rows = self._data(response)
        return rows[0] if rows else None


@lru_cache(maxsize=1)
def get_job_store() -> SupabaseJobStore:
    try:
        settings = get_settings()
    except SettingsError as exc:
        raise PersistenceConfigurationError(str(exc)) from None
    url = settings.supabase_url
    service_role_key = settings.supabase_service_role_key
    if not url or not service_role_key:
        raise PersistenceConfigurationError("Supabase persistence is not configured on this server.")
    if create_client is None or ClientOptions is None:
        raise PersistenceConfigurationError("The Supabase Python SDK is not installed on this server.")
    modern_key = _is_modern_supabase_key(service_role_key)
    options_headers = {"Authorization": ""} if modern_key else None
    try:
        client = create_client(
            url,
            service_role_key,
            options=ClientOptions(
                auto_refresh_token=False,
                persist_session=False,
                **({"headers": options_headers} if options_headers is not None else {}),
            ),
        )
    except Exception as exc:
        raise PersistenceConfigurationError("Supabase persistence could not be initialized.") from None
    if modern_key:
        _normalize_modern_key_headers(client, service_role_key)
    return SupabaseJobStore(client, settings.preflight_ttl_seconds)
