"""Safe, non-networking configuration diagnostics for local setup.

The command reports only variable names and shape/status messages. It never prints
configuration values, reads a Firebase credential file, or initializes an API client.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping
from urllib.parse import urlsplit

from dotenv import load_dotenv


BACKEND_ROOT = Path(__file__).resolve().parents[1]
_TRUE_VALUES = {"1", "true", "yes"}
_FALSE_VALUES = {"0", "false", "no"}
_VALID_APP_ENVS = {"development", "staging", "production"}
_MODERN_SECRET_MARKER = "sb_secret_"
_LEGACY_SERVICE_ROLE_MARKER = "eyJ"


@dataclass(frozen=True)
class DiagnosticResult:
    name: str
    ok: bool
    message: str


def _present(value: str | None) -> bool:
    return bool(value and value.strip())


def _http_url_shape(value: str, *, origin_only: bool = False) -> bool:
    if not value or any(character.isspace() for character in value):
        return False
    parsed = urlsplit(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return False
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        return False
    if origin_only and parsed.path not in {"", "/"}:
        return False
    return True


def _supabase_key_shape(value: str) -> str | None:
    if value.startswith(_MODERN_SECRET_MARKER) and len(value) > len(_MODERN_SECRET_MARKER):
        return "modern server-only key shape"
    if value.startswith(_LEGACY_SERVICE_ROLE_MARKER) and value.count(".") == 2:
        return "legacy server-only key shape"
    return None


def diagnose_environment(environ: Mapping[str, str] | None = None) -> list[DiagnosticResult]:
    """Validate configuration shapes without exposing any environment values."""
    values = os.environ if environ is None else environ
    app_env = values.get("APP_ENV", "development").strip().lower()
    results: list[DiagnosticResult] = []

    if app_env in _VALID_APP_ENVS:
        results.append(DiagnosticResult("APP_ENV", True, "present or defaulted and validly shaped"))
    else:
        results.append(DiagnosticResult("APP_ENV", False, "must be development, staging, or production"))

    supabase_url = values.get("SUPABASE_URL", "").strip()
    results.append(
        DiagnosticResult(
            "SUPABASE_URL",
            _http_url_shape(supabase_url),
            "present and validly shaped" if _http_url_shape(supabase_url) else "must be an HTTP(S) URL",
        )
    )

    supabase_key = values.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
    key_shape = _supabase_key_shape(supabase_key)
    results.append(
        DiagnosticResult(
            "SUPABASE_SERVICE_ROLE_KEY",
            key_shape is not None,
            key_shape or "must be a modern server-only key or legacy service-role JWT shape",
        )
    )

    firebase_path = values.get("GOOGLE_APPLICATION_CREDENTIALS", "").strip()
    firebase_ok = not firebase_path or ("\n" not in firebase_path and "\r" not in firebase_path)
    results.append(
        DiagnosticResult(
            "GOOGLE_APPLICATION_CREDENTIALS",
            firebase_ok,
            "not set; Firebase Admin may use Application Default Credentials"
            if not firebase_path
            else "present and validly shaped; credential file contents were not read",
        )
    )

    firebase_json = values.get("FIREBASE_SERVICE_ACCOUNT_JSON", "").strip()
    firebase_json_ok = True
    if firebase_json:
        try:
            firebase_json_ok = isinstance(json.loads(firebase_json), dict)
        except (json.JSONDecodeError, TypeError):
            firebase_json_ok = False
    results.append(
        DiagnosticResult(
            "FIREBASE_SERVICE_ACCOUNT_JSON",
            firebase_json_ok,
            "not set; use local path or Application Default Credentials"
            if not firebase_json
            else "present and valid JSON-object shape; credential contents were not printed",
        )
    )

    asf_enabled = values.get("ASF_CATALOG_ENABLED", "true").strip().lower()
    asf_ok = asf_enabled in _TRUE_VALUES | _FALSE_VALUES
    results.append(
        DiagnosticResult(
            "ASF_CATALOG_ENABLED",
            asf_ok,
            "present or defaulted and validly shaped" if asf_ok else "must be a boolean flag",
        )
    )

    cors_origins = values.get("CORS_ORIGINS", "").strip()
    cors_ok = bool(cors_origins) and all(_http_url_shape(origin.strip(), origin_only=True) for origin in cors_origins.split(","))
    if not cors_origins and app_env != "production":
        cors_ok = True
        cors_message = "not set; development defaults are allowed"
    elif cors_ok:
        cors_message = "present and validly shaped"
    else:
        cors_message = "production requires comma-separated HTTP(S) origins"
    results.append(DiagnosticResult("CORS_ORIGINS", cors_ok, cors_message))

    ttl_raw = values.get("PREFLIGHT_TTL_SECONDS", "86400").strip()
    try:
        ttl = int(ttl_raw)
    except ValueError:
        ttl = -1
    ttl_ok = 60 <= ttl <= 604800
    results.append(
        DiagnosticResult(
            "PREFLIGHT_TTL_SECONDS",
            ttl_ok,
            "present or defaulted and within the supported range" if ttl_ok else "must be an integer from 60 through 604800",
        )
    )

    port_raw = values.get("PORT", "8000").strip()
    try:
        port = int(port_raw)
    except ValueError:
        port = -1
    port_ok = 1 <= port <= 65535
    results.append(
        DiagnosticResult(
            "PORT",
            port_ok,
            "present or defaulted and validly shaped" if port_ok else "must be an integer from 1 through 65535",
        )
    )

    max_results_raw = values.get("ASF_MAX_RESULTS", "2000").strip()
    try:
        max_results = int(max_results_raw)
    except ValueError:
        max_results = -1
    max_results_ok = 1 <= max_results <= 2000
    results.append(
        DiagnosticResult(
            "ASF_MAX_RESULTS",
            max_results_ok,
            "present or defaulted and within the supported range" if max_results_ok else "must be an integer from 1 through 2000",
        )
    )

    timeout_raw = values.get("ASF_TIMEOUT_SECONDS", "20").strip()
    try:
        timeout_seconds = int(timeout_raw)
    except ValueError:
        timeout_seconds = -1
    timeout_ok = 1 <= timeout_seconds <= 60
    results.append(
        DiagnosticResult(
            "ASF_TIMEOUT_SECONDS",
            timeout_ok,
            "present or defaulted and within the supported range" if timeout_ok else "must be an integer from 1 through 60",
        )
    )

    asf_url = values.get("ASF_SEARCH_URL", "https://api.daac.asf.alaska.edu/services/search/param").strip()
    results.append(
        DiagnosticResult(
            "ASF_SEARCH_URL",
            _http_url_shape(asf_url),
            "present or defaulted and validly shaped" if _http_url_shape(asf_url) else "must be an HTTP(S) URL",
        )
    )

    return results


def main() -> int:
    # This is the same local-development loading policy as the application, but
    # this module never imports persistence, Firebase, Supabase, or the API app.
    if os.getenv("APP_ENV", "development").strip().lower() != "production":
        load_dotenv(dotenv_path=BACKEND_ROOT / ".env", override=False)

    results = diagnose_environment()
    print("SARGuardian Dynamic configuration diagnostic")
    print("No network client was initialized and no credential-file contents were read.")
    for result in results:
        status = "OK" if result.ok else "FAIL"
        print(f"[{status}] {result.name}: {result.message}")
    passed = all(result.ok for result in results)
    print("Result: PASS" if passed else "Result: FAIL")
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
