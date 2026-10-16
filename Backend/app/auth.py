from __future__ import annotations

from typing import Any

from fastapi import Header, HTTPException

try:
    import firebase_admin
    from firebase_admin import auth as firebase_auth
    from firebase_admin import credentials
    from firebase_admin import exceptions as firebase_exceptions
    from google.auth import exceptions as google_auth_exceptions
except ImportError:  # pragma: no cover - exercised through the setup error path
    firebase_admin = None
    firebase_auth = None
    credentials = None
    firebase_exceptions = None
    google_auth_exceptions = None


class FirebaseConfigurationError(RuntimeError):
    pass


def _get_firebase_app() -> Any:
    if firebase_admin is None or firebase_auth is None or credentials is None or firebase_exceptions is None:
        raise FirebaseConfigurationError

    try:
        return firebase_admin.get_app()
    except ValueError:
        try:
            return firebase_admin.initialize_app(credentials.ApplicationDefault())
        except (ValueError, OSError, getattr(google_auth_exceptions, "GoogleAuthError", OSError)) as exc:
            raise FirebaseConfigurationError from exc


def get_current_user(authorization: str | None = Header(default=None)) -> dict[str, Any]:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="A Firebase Bearer token is required.")

    token = authorization.removeprefix("Bearer ").strip()
    if not token:
        raise HTTPException(status_code=401, detail="A Firebase Bearer token is required.")
    try:
        _get_firebase_app()
        return firebase_auth.verify_id_token(token)
    except FirebaseConfigurationError:
        raise _configuration_http_error() from None
    except (firebase_auth.InvalidIdTokenError, firebase_auth.ExpiredIdTokenError, firebase_auth.RevokedIdTokenError):
        raise HTTPException(status_code=401, detail="The Firebase sign-in token is invalid or expired.") from None
    except firebase_exceptions.FirebaseError as exc:
        raise _configuration_http_error() from exc


def _configuration_http_error() -> HTTPException:
    return HTTPException(status_code=503, detail="Firebase Admin authentication is not configured on this server.")
