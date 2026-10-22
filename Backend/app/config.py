from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping
from urllib.parse import urlsplit

from dotenv import load_dotenv


BACKEND_ROOT = Path(__file__).resolve().parents[1]

DEFAULT_ASF_SEARCH_URL = "https://api.daac.asf.alaska.edu/services/search/param"
DEFAULT_ASF_MAX_RESULTS = 2_000
DEFAULT_ASF_TIMEOUT_SECONDS = 20
DEFAULT_PREFLIGHT_TTL_SECONDS = 86_400
DEFAULT_PORT = 8_000
DEFAULT_GITHUB_API_URL = "https://api.github.com"
DEFAULT_DISPLACEMENT_DISPATCH_TIMEOUT_SECONDS = 3_600


class SettingsError(ValueError):
    """A safe configuration error that never includes a secret value."""


@dataclass(frozen=True)
class RuntimeSettings:
    app_env: str
    vercel: bool
    cors_origins: str
    supabase_url: str
    supabase_service_role_key: str
    google_application_credentials: str
    firebase_service_account_json: str
    asf_catalog_enabled: bool
    asf_search_url: str
    asf_max_results: int
    asf_timeout_seconds: int
    preflight_ttl_seconds: int
    displacement_actions_enabled: bool
    github_actions_token: str
    github_actions_repository: str
    github_actions_workflow: str
    github_actions_ref: str
    displacement_callback_secret: str
    public_api_url: str
    github_api_url: str
    displacement_dispatch_timeout_seconds: int
    port: int


def _bounded_int(values: Mapping[str, str], name: str, default: int, minimum: int, maximum: int) -> int:
    raw = values.get(name, str(default)).strip()
    try:
        value = int(raw)
    except ValueError:
        raise SettingsError(f"{name} is invalid.") from None
    if not minimum <= value <= maximum:
        raise SettingsError(f"{name} must be between {minimum} and {maximum}.")
    return value


def _flag(values: Mapping[str, str], name: str, default: bool) -> bool:
    raw = values.get(name, "true" if default else "false").strip().lower()
    if raw in {"1", "true", "yes"}:
        return True
    if raw in {"0", "false", "no"}:
        return False
    raise SettingsError(f"{name} is invalid.")


def get_settings(environ: Mapping[str, str] | None = None) -> RuntimeSettings:
    values = os.environ if environ is None else environ
    return RuntimeSettings(
        app_env=values.get("APP_ENV", "development").strip().lower(),
        vercel=values.get("VERCEL", "").strip() == "1",
        cors_origins=values.get("CORS_ORIGINS", "").strip(),
        supabase_url=values.get("SUPABASE_URL", "").strip(),
        supabase_service_role_key=values.get("SUPABASE_SERVICE_ROLE_KEY", "").strip(),
        google_application_credentials=values.get("GOOGLE_APPLICATION_CREDENTIALS", "").strip(),
        firebase_service_account_json=values.get("FIREBASE_SERVICE_ACCOUNT_JSON", "").strip(),
        asf_catalog_enabled=_flag(values, "ASF_CATALOG_ENABLED", True),
        asf_search_url=values.get("ASF_SEARCH_URL", DEFAULT_ASF_SEARCH_URL).strip(),
        asf_max_results=_bounded_int(values, "ASF_MAX_RESULTS", DEFAULT_ASF_MAX_RESULTS, 1, DEFAULT_ASF_MAX_RESULTS),
        asf_timeout_seconds=_bounded_int(values, "ASF_TIMEOUT_SECONDS", DEFAULT_ASF_TIMEOUT_SECONDS, 1, 60),
        preflight_ttl_seconds=_bounded_int(values, "PREFLIGHT_TTL_SECONDS", DEFAULT_PREFLIGHT_TTL_SECONDS, 60, 604_800),
        displacement_actions_enabled=_flag(values, "DISPLACEMENT_ACTIONS_ENABLED", False),
        github_actions_token=values.get("GITHUB_ACTIONS_TOKEN", "").strip(),
        github_actions_repository=values.get("GITHUB_ACTIONS_REPOSITORY", "").strip(),
        github_actions_workflow=values.get("GITHUB_ACTIONS_WORKFLOW", "sarguardian-displacement.yml").strip(),
        github_actions_ref=values.get("GITHUB_ACTIONS_REF", "main").strip(),
        displacement_callback_secret=values.get("DISPLACEMENT_CALLBACK_SECRET", "").strip(),
        public_api_url=values.get("PUBLIC_API_URL", "").rstrip("/"),
        github_api_url=values.get("GITHUB_API_URL", DEFAULT_GITHUB_API_URL).rstrip("/"),
        displacement_dispatch_timeout_seconds=_bounded_int(values, "DISPLACEMENT_DISPATCH_TIMEOUT_SECONDS", DEFAULT_DISPLACEMENT_DISPATCH_TIMEOUT_SECONDS, 300, 86_400),
        port=_bounded_int(values, "PORT", DEFAULT_PORT, 1, 65_535),
    )


def validate_production_settings(settings: RuntimeSettings | None = None) -> RuntimeSettings:
    current = settings or get_settings()
    if current.app_env != "production":
        return current
    if not current.cors_origins:
        raise SettingsError("CORS_ORIGINS must be explicitly configured in production.")
    if not current.supabase_url:
        raise SettingsError("SUPABASE_URL must be configured in production.")
    parsed = urlsplit(current.supabase_url)
    if parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password:
        raise SettingsError("SUPABASE_URL must be an HTTPS URL in production.")
    if not current.supabase_service_role_key:
        raise SettingsError("SUPABASE_SERVICE_ROLE_KEY must be configured in production.")
    if current.displacement_actions_enabled:
        missing = [name for name, value in {
            "GITHUB_ACTIONS_TOKEN": current.github_actions_token,
            "GITHUB_ACTIONS_REPOSITORY": current.github_actions_repository,
            "GITHUB_ACTIONS_WORKFLOW": current.github_actions_workflow,
            "GITHUB_ACTIONS_REF": current.github_actions_ref,
            "DISPLACEMENT_CALLBACK_SECRET": current.displacement_callback_secret,
            "PUBLIC_API_URL": current.public_api_url,
        }.items() if not value]
        if missing:
            raise SettingsError(f"Displacement Actions is enabled but missing: {', '.join(missing)}.")
        callback_url = urlsplit(current.public_api_url)
        if callback_url.scheme != "https" or not callback_url.netloc:
            raise SettingsError("PUBLIC_API_URL must be an HTTPS URL when Displacement Actions is enabled.")
    return current


def load_local_environment(dotenv_path: str | os.PathLike[str] | None = None) -> bool:
    """Load the backend-local .env during development without overriding host env."""
    if (
        os.getenv("APP_ENV", "development").strip().lower() == "production"
        or os.getenv("VERCEL", "").strip() == "1"
    ):
        return False

    path = Path(dotenv_path) if dotenv_path is not None else BACKEND_ROOT / ".env"
    return load_dotenv(dotenv_path=path, override=False)


load_local_environment()
