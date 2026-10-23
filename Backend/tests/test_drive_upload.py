from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from science_adapter import upload_to_drive as drive


class Response:
    def __init__(self, payload: dict):
        self.payload = payload
        self.content = json.dumps(payload).encode("utf-8")

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict:
        return self.payload


class DriveSession:
    def __init__(self) -> None:
        self.requests: list[tuple[str, str, dict]] = []
        self.next_id = 0

    def post(self, _url, **_kwargs):
        return Response({"access_token": "access-token"})

    def request(self, method, url, **kwargs):
        self.requests.append((method, url, kwargs))
        if method == "GET" and url.endswith("/files"):
            return Response({"files": []})
        if method == "GET" and url.endswith("/permissions"):
            return Response({"permissions": []})
        if method == "POST" and url == f"{drive.DRIVE_API}/files":
            self.next_id += 1
            return Response({"id": f"folder-{self.next_id}"})
        if method in {"POST", "PATCH"} and url.startswith(f"{drive.DRIVE_UPLOAD_API}/files"):
            self.next_id += 1
            return Response({"id": f"file-{self.next_id}"})
        if method == "POST" and url.endswith("/permissions"):
            return Response({"id": "public-viewer"})
        raise AssertionError(f"Unexpected Drive request: {method} {url}")


def write_validated_manifest(work_dir: Path) -> None:
    output = work_dir / "outputs" / "granule-one" / "screening.tif"
    output.parent.mkdir(parents=True)
    output.write_bytes(b"validated-geotiff")
    (work_dir / "result-manifest.json").write_text(json.dumps({
        "status": "succeeded",
        "job_id": "123e4567-e89b-12d3-a456-426614174000",
        "validated_outputs": [{
            "path": "outputs/granule-one/screening.tif",
            "sha256": hashlib.sha256(output.read_bytes()).hexdigest(),
        }],
    }), encoding="utf-8")


def test_uploads_only_manifest_and_checksum_verified_outputs_to_a_public_job_folder(tmp_path: Path) -> None:
    write_validated_manifest(tmp_path)
    session = DriveSession()
    config = drive.DriveConfig("client", "secret", "https://oauth2.googleapis.com/token", "refresh", "13BIAepPGLlYYmscUlNPeMCdtepYshjT4")

    url = drive.upload_validated_results(tmp_path, config=config, session=session)

    assert url == "https://drive.google.com/drive/folders/folder-1"
    uploaded = [item for item in session.requests if item[1].startswith(f"{drive.DRIVE_UPLOAD_API}/files")]
    assert len(uploaded) == 2
    permission = next(item for item in session.requests if item[1].endswith("/permissions") and item[0] == "POST")
    assert permission[2]["json"] == {"type": "anyone", "role": "reader"}


def test_rejects_tampered_validated_outputs_before_google_drive_is_contacted(tmp_path: Path) -> None:
    write_validated_manifest(tmp_path)
    (tmp_path / "outputs" / "granule-one" / "screening.tif").write_bytes(b"tampered")

    with pytest.raises(drive.DriveUploadError, match="checksum"):
        drive.upload_validated_results(tmp_path, config=drive.DriveConfig("client", "secret", "https://oauth2.googleapis.com/token", "refresh", "13BIAepPGLlYYmscUlNPeMCdtepYshjT4"))


def test_rejects_non_web_or_untrusted_google_oauth_configuration() -> None:
    with pytest.raises(drive.DriveUploadError, match="web credentials"):
        drive.load_drive_config({
            "GOOGLE_DRIVE_OAUTH_CLIENT_JSON": json.dumps({"installed": {}}),
            "GOOGLE_DRIVE_REFRESH_TOKEN": "refresh",
            "GOOGLE_DRIVE_FOLDER_ID": "13BIAepPGLlYYmscUlNPeMCdtepYshjT4",
        })
    with pytest.raises(drive.DriveUploadError, match="unsupported token endpoint"):
        drive.load_drive_config({
            "GOOGLE_DRIVE_OAUTH_CLIENT_JSON": json.dumps({"web": {
                "client_id": "client", "client_secret": "secret", "token_uri": "https://invalid.example/token",
            }}),
            "GOOGLE_DRIVE_REFRESH_TOKEN": "refresh",
            "GOOGLE_DRIVE_FOLDER_ID": "13BIAepPGLlYYmscUlNPeMCdtepYshjT4",
        })
