from __future__ import annotations

import logging
from types import SimpleNamespace

import pytest

from app import persistence


def test_modern_supabase_key_is_only_an_apikey_header() -> None:
    secret = "sb_secret_test_only"
    client = SimpleNamespace(
        options=SimpleNamespace(
            headers={
                "X-Client-Info": "test",
                "apiKey": secret,
                "Authorization": f"Bearer {secret}",
            }
        )
    )

    persistence._normalize_modern_key_headers(client, secret)

    assert client.options.headers == {"X-Client-Info": "test", "apikey": secret}
    assert "Authorization" not in client.options.headers
    assert secret not in repr({key: value for key, value in client.options.headers.items() if key != "apikey"})


def test_secret_client_initialization_suppresses_sdk_bearer_fallback(monkeypatch, caplog) -> None:
    secret = "sb_secret_test_only"
    captured: dict[str, object] = {}

    class FakeOptions:
        def __init__(self, **kwargs: object) -> None:
            self.headers = dict(kwargs.get("headers") or {})

    class FakeClient:
        def __init__(self, headers: dict[str, str]) -> None:
            self.options = SimpleNamespace(headers=headers)

    def fake_create_client(url: str, key: str, options: FakeOptions) -> FakeClient:
        captured["url"] = url
        captured["key"] = key
        captured["options"] = options
        return FakeClient({"apiKey": key, "Authorization": ""})

    monkeypatch.setenv("SUPABASE_URL", "https://example.invalid")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", secret)
    monkeypatch.setenv("PREFLIGHT_TTL_SECONDS", "86400")
    monkeypatch.setattr(persistence, "ClientOptions", FakeOptions)
    monkeypatch.setattr(persistence, "create_client", fake_create_client)
    persistence.get_job_store.cache_clear()

    with caplog.at_level(logging.DEBUG):
        store = persistence.get_job_store()

    options = captured["options"]
    assert isinstance(options, FakeOptions)
    assert options.headers == {"Authorization": ""}
    assert store.client.options.headers == {"apikey": secret}
    assert "Authorization" not in store.client.options.headers
    assert "Bearer" not in repr(store.client.options.headers)
    assert secret not in caplog.text
    persistence.get_job_store.cache_clear()


def test_supabase_initialization_error_does_not_expose_secret(monkeypatch) -> None:
    secret = "sb_secret_test_only"

    class FakeOptions:
        def __init__(self, **_kwargs: object) -> None:
            pass

    def failing_create_client(*_args: object, **_kwargs: object) -> None:
        raise RuntimeError(f"provider rejected {secret}")

    monkeypatch.setenv("SUPABASE_URL", "https://example.invalid")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", secret)
    monkeypatch.setattr(persistence, "ClientOptions", FakeOptions)
    monkeypatch.setattr(persistence, "create_client", failing_create_client)
    persistence.get_job_store.cache_clear()

    with pytest.raises(persistence.PersistenceConfigurationError) as error:
        persistence.get_job_store()

    assert str(error.value) == "Supabase persistence could not be initialized."
    assert secret not in str(error.value)
    assert error.value.__cause__ is None
    persistence.get_job_store.cache_clear()
