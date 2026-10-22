from __future__ import annotations

from app.config_diagnostic import diagnose_environment


def _values() -> dict[str, str]:
    return {
        "APP_ENV": "staging",
        "SUPABASE_URL": "https://staging-project.supabase.co",
        "SUPABASE_SERVICE_ROLE_KEY": "opaque-test-key",
        "GOOGLE_APPLICATION_CREDENTIALS": "C:/secrets/firebase-admin.json",
        "FIREBASE_SERVICE_ACCOUNT_JSON": '{"project_id":"test-project"}',
        "ASF_CATALOG_ENABLED": "true",
        "CORS_ORIGINS": "http://localhost:5173,https://staging.example.test",
        "PREFLIGHT_TTL_SECONDS": "86400",
        "PORT": "8000",
        "ASF_SEARCH_URL": "https://api.daac.asf.alaska.edu/services/search/param",
        "ASF_MAX_RESULTS": "2000",
        "ASF_TIMEOUT_SECONDS": "20",
    }


def test_diagnostic_accepts_valid_shapes_without_exposing_values() -> None:
    values = _values()
    values["APP_ENV"] = "staging"
    values["SUPABASE_SERVICE_ROLE_KEY"] = "sb_secret_test_only"

    results = diagnose_environment(values)

    assert all(result.ok for result in results)
    assert all("sb_secret" not in result.message for result in results)
    assert all("staging-project" not in result.message for result in results)
    assert all("test-project" not in result.message for result in results)


def test_diagnostic_rejects_missing_or_malformed_required_shapes() -> None:
    values = _values()
    values.update(
        {
            "APP_ENV": "production",
            "SUPABASE_URL": "not-a-url",
            "SUPABASE_SERVICE_ROLE_KEY": "not-a-server-key",
            "CORS_ORIGINS": "",
            "PREFLIGHT_TTL_SECONDS": "30",
        }
    )

    results = {result.name: result for result in diagnose_environment(values)}

    assert not results["SUPABASE_URL"].ok
    assert not results["SUPABASE_SERVICE_ROLE_KEY"].ok
    assert not results["CORS_ORIGINS"].ok
    assert not results["PREFLIGHT_TTL_SECONDS"].ok


def test_firebase_credential_path_is_not_read_or_required_when_using_adc() -> None:
    values = _values()
    values.pop("GOOGLE_APPLICATION_CREDENTIALS")

    results = {result.name: result for result in diagnose_environment(values)}

    assert results["GOOGLE_APPLICATION_CREDENTIALS"].ok
    assert "Application Default Credentials" in results["GOOGLE_APPLICATION_CREDENTIALS"].message
