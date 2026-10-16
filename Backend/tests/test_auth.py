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


def test_firebase_verification_configuration_error_returns_503(firebase_mocks: None, monkeypatch: pytest.MonkeyPatch) -> None:
    class FailingAuth(FakeFirebaseAuth):
        @staticmethod
        def verify_id_token(token: str) -> dict[str, str]:
            raise FakeFirebaseError

    monkeypatch.setattr(auth, "firebase_auth", FailingAuth)
    with pytest.raises(HTTPException) as error:
        auth.get_current_user("Bearer token")
    assert error.value.status_code == 503
