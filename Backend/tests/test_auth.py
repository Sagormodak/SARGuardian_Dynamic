from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app import auth


class FakeInvalidIdTokenError(Exception):
    pass


class FakeExpiredIdTokenError(Exception):
    pass


class FakeRevokedIdTokenError(Exception):
    pass


class FakeFirebaseError(Exception):
    pass


class FakeFirebaseAuth:
    InvalidIdTokenError = FakeInvalidIdTokenError
    ExpiredIdTokenError = FakeExpiredIdTokenError
    RevokedIdTokenError = FakeRevokedIdTokenError

    @staticmethod
    def verify_id_token(token: str) -> dict[str, str]:
        return {"uid": "verified-user", "token": token}


class FakeFirebaseAdmin:
    _apps = [object()]

    @staticmethod
    def get_app() -> object:
        return object()


@pytest.fixture
def firebase_mocks(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(auth, "firebase_admin", FakeFirebaseAdmin)
    monkeypatch.setattr(auth, "firebase_auth", FakeFirebaseAuth)
    monkeypatch.setattr(auth, "firebase_exceptions", SimpleNamespace(FirebaseError=FakeFirebaseError))
    monkeypatch.setattr(auth, "credentials", SimpleNamespace())


def test_valid_token_is_verified_server_side(firebase_mocks: None) -> None:
    assert auth.get_current_user("Bearer server-token")["uid"] == "verified-user"


def test_invalid_token_returns_401(firebase_mocks: None, monkeypatch: pytest.MonkeyPatch) -> None:
    class InvalidatingAuth(FakeFirebaseAuth):
        @staticmethod
        def verify_id_token(token: str) -> dict[str, str]:
            raise FakeInvalidIdTokenError

    monkeypatch.setattr(auth, "firebase_auth", InvalidatingAuth)
    with pytest.raises(HTTPException) as error:
        auth.get_current_user("Bearer invalid")
    assert error.value.status_code == 401


def test_missing_firebase_configuration_returns_503(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(auth, "firebase_admin", None)
    monkeypatch.setattr(auth, "firebase_auth", None)
    monkeypatch.setattr(auth, "credentials", None)
    monkeypatch.setattr(auth, "firebase_exceptions", None)
    with pytest.raises(HTTPException) as error:
        auth.get_current_user("Bearer configured-looking-token")
    assert error.value.status_code == 503


def test_application_default_credentials_are_used_when_hosting_json_is_absent(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}

    class FakeCredentials:
        @staticmethod
        def ApplicationDefault() -> object:
            captured["credential"] = "application-default"
            return "application-default"

    class InitializingAdmin:
        @staticmethod
        def get_app() -> object:
            raise ValueError

        @staticmethod
        def initialize_app(credential: object) -> object:
            captured["initialized_with"] = credential
            return "firebase-app"

    monkeypatch.delenv("FIREBASE_SERVICE_ACCOUNT_JSON", raising=False)
    monkeypatch.setattr(auth, "credentials", FakeCredentials)
    monkeypatch.setattr(auth, "firebase_admin", InitializingAdmin)
    monkeypatch.setattr(auth, "firebase_auth", SimpleNamespace())
    monkeypatch.setattr(auth, "firebase_exceptions", SimpleNamespace(FirebaseError=Exception))

    assert auth._get_firebase_app() == "firebase-app"
    assert captured["initialized_with"] == "application-default"


def test_firebase_verification_configuration_error_returns_503(firebase_mocks: None, monkeypatch: pytest.MonkeyPatch) -> None:
    class FailingAuth(FakeFirebaseAuth):
        @staticmethod
        def verify_id_token(token: str) -> dict[str, str]:
            raise FakeFirebaseError

    monkeypatch.setattr(auth, "firebase_auth", FailingAuth)
    with pytest.raises(HTTPException) as error:
        auth.get_current_user("Bearer token")
    assert error.value.status_code == 503


def test_hosting_service_account_json_is_used_without_reading_a_file(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}

    class FakeCredentials:
        @staticmethod
        def Certificate(info: dict[str, object]) -> object:
            captured["certificate"] = info
            return "certificate-credential"

        @staticmethod
        def ApplicationDefault() -> object:
            raise AssertionError("hosting JSON should be selected")

    class InitializingAdmin:
        @staticmethod
        def get_app() -> object:
            raise ValueError

        @staticmethod
        def initialize_app(credential: object) -> object:
            captured["credential"] = credential
            return "firebase-app"

    monkeypatch.setattr(auth, "credentials", FakeCredentials)
    monkeypatch.setattr(auth, "firebase_admin", InitializingAdmin)
    monkeypatch.setattr(auth, "firebase_auth", SimpleNamespace())
    monkeypatch.setattr(auth, "firebase_exceptions", SimpleNamespace(FirebaseError=Exception))
    monkeypatch.setenv("FIREBASE_SERVICE_ACCOUNT_JSON", '{"project_id":"test-project","client_email":"test@example.invalid"}')

    assert auth._get_firebase_app() == "firebase-app"
    assert captured["credential"] == "certificate-credential"
    assert captured["certificate"] == {"project_id": "test-project", "client_email": "test@example.invalid"}


def test_malformed_hosting_service_account_json_is_safe_configuration_error(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(auth, "credentials", SimpleNamespace())
    monkeypatch.setenv("FIREBASE_SERVICE_ACCOUNT_JSON", "not-json")

    with pytest.raises(auth.FirebaseConfigurationError) as error:
        auth._firebase_credential()

    assert str(error.value) == ""


def test_non_object_hosting_service_account_json_is_safe_configuration_error(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(auth, "credentials", SimpleNamespace())
    monkeypatch.setenv("FIREBASE_SERVICE_ACCOUNT_JSON", "[]")

    with pytest.raises(auth.FirebaseConfigurationError) as error:
        auth._firebase_credential()

    assert str(error.value) == ""


def test_invalid_hosting_service_account_object_is_safe_configuration_error(monkeypatch: pytest.MonkeyPatch) -> None:
    class InvalidCredentials:
        @staticmethod
        def Certificate(_info: dict[str, object]) -> object:
            raise ValueError("invalid certificate")

    monkeypatch.setattr(auth, "credentials", InvalidCredentials)
    monkeypatch.setenv("FIREBASE_SERVICE_ACCOUNT_JSON", "{\"project_id\":\"invalid\"}")

    with pytest.raises(auth.FirebaseConfigurationError) as error:
        auth._firebase_credential()

    assert str(error.value) == ""


def test_existing_firebase_app_is_reused_without_reinitialization(monkeypatch: pytest.MonkeyPatch) -> None:
    existing_app = object()

    class ExistingAdmin:
        @staticmethod
        def get_app() -> object:
            return existing_app

        @staticmethod
        def initialize_app(_credential: object) -> object:
            raise AssertionError("an existing Firebase app must be reused")

    monkeypatch.setattr(auth, "firebase_admin", ExistingAdmin)
    monkeypatch.setattr(auth, "firebase_auth", SimpleNamespace())
    monkeypatch.setattr(auth, "credentials", SimpleNamespace())
    monkeypatch.setattr(auth, "firebase_exceptions", SimpleNamespace(FirebaseError=Exception))
    monkeypatch.setenv("FIREBASE_SERVICE_ACCOUNT_JSON", "not-json")

    assert auth._get_firebase_app() is existing_app
