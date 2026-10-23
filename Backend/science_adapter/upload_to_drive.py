"""Publish validated displacement results to the configured Google Drive folder.

The workflow grants viewer access to the per-job folder only after every
checksum-verified result file has been uploaded.  Raw NISAR HDF5 inputs are
never considered for upload by this module.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import quote

import requests


DRIVE_API = "https://www.googleapis.com/drive/v3"
DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3"
FOLDER_MIME_TYPE = "application/vnd.google-apps.folder"
GOOGLE_TOKEN_URIS = frozenset({
    "https://oauth2.googleapis.com/token",
    "https://accounts.google.com/o/oauth2/token",
})
FOLDER_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{10,200}$")


class DriveUploadError(RuntimeError):
    """A safe, user-facing result-publication failure."""


@dataclass(frozen=True)
class DriveConfig:
    client_id: str
    client_secret: str
    token_uri: str
    refresh_token: str
    parent_folder_id: str


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def load_drive_config(environ: dict[str, str] | None = None) -> DriveConfig:
    values = environ if environ is not None else os.environ
    raw_client = values.get("GOOGLE_DRIVE_OAUTH_CLIENT_JSON", "").strip()
    refresh_token = values.get("GOOGLE_DRIVE_REFRESH_TOKEN", "").strip()
    parent_folder_id = values.get("GOOGLE_DRIVE_FOLDER_ID", "").strip()
    if not raw_client or not refresh_token or not parent_folder_id:
        raise DriveUploadError("Google Drive result storage is not fully configured.")
    if not FOLDER_ID_PATTERN.fullmatch(parent_folder_id):
        raise DriveUploadError("Configured Google Drive folder identifier is invalid.")
    try:
        parsed = json.loads(raw_client)
    except json.JSONDecodeError as exc:
        raise DriveUploadError("Google Drive OAuth client JSON is invalid.") from exc
    client = parsed.get("web") if isinstance(parsed, dict) else None
    if not isinstance(client, dict):
        raise DriveUploadError("Google Drive OAuth client JSON must contain web credentials.")
    client_id = client.get("client_id")
    client_secret = client.get("client_secret")
    token_uri = client.get("token_uri")
    if not all(isinstance(value, str) and value.strip() for value in (client_id, client_secret, token_uri)):
        raise DriveUploadError("Google Drive OAuth client JSON is incomplete.")
    if token_uri not in GOOGLE_TOKEN_URIS:
        raise DriveUploadError("Google Drive OAuth client uses an unsupported token endpoint.")
    return DriveConfig(client_id, client_secret, token_uri, refresh_token, parent_folder_id)


class DriveClient:
    def __init__(self, config: DriveConfig, session: requests.Session | Any | None = None) -> None:
        self.config = config
        self.session = session or requests.Session()
        self.access_token = self._refresh_access_token()

    def _refresh_access_token(self) -> str:
        try:
            response = self.session.post(
                self.config.token_uri,
                data={
                    "client_id": self.config.client_id,
                    "client_secret": self.config.client_secret,
                    "refresh_token": self.config.refresh_token,
                    "grant_type": "refresh_token",
                },
                timeout=30,
            )
            response.raise_for_status()
            payload = response.json()
        except (requests.RequestException, ValueError) as exc:
            raise DriveUploadError("Could not authenticate to Google Drive result storage.") from exc
        token = payload.get("access_token") if isinstance(payload, dict) else None
        if not isinstance(token, str) or not token:
            raise DriveUploadError("Google Drive did not return an access token.")
        return token

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.access_token}"}

    def _json(self, method: str, url: str, **kwargs: Any) -> dict[str, Any]:
        try:
            response = self.session.request(method, url, headers=self._headers(), timeout=60, **kwargs)
            response.raise_for_status()
            payload = response.json() if response.content else {}
        except (requests.RequestException, ValueError) as exc:
            raise DriveUploadError("Google Drive result storage request failed.") from exc
        if not isinstance(payload, dict):
            raise DriveUploadError("Google Drive returned an invalid result-storage response.")
        return payload

    @staticmethod
    def _query_text(value: str) -> str:
        return value.replace("'", "\\'")

    def _find_named_file(self, name: str, parent_id: str, mime_type: str | None = None) -> str | None:
        clauses = ["trashed = false", f"'{self._query_text(parent_id)}' in parents", f"name = '{self._query_text(name)}'"]
        if mime_type:
            clauses.append(f"mimeType = '{self._query_text(mime_type)}'")
        payload = self._json(
            "GET",
            f"{DRIVE_API}/files",
            params={"q": " and ".join(clauses), "fields": "files(id)", "pageSize": 2},
        )
        files = payload.get("files")
        if not isinstance(files, list):
            raise DriveUploadError("Google Drive returned an invalid file-search response.")
        identifiers = [item.get("id") for item in files if isinstance(item, dict) and isinstance(item.get("id"), str)]
        if len(identifiers) > 1:
            raise DriveUploadError("Google Drive contains ambiguous prior result files for this job.")
        return identifiers[0] if identifiers else None

    def find_or_create_folder(self, name: str, parent_id: str) -> str:
        existing = self._find_named_file(name, parent_id, FOLDER_MIME_TYPE)
        if existing:
            return existing
        payload = self._json(
            "POST",
            f"{DRIVE_API}/files",
            json={"name": name, "mimeType": FOLDER_MIME_TYPE, "parents": [parent_id]},
            params={"fields": "id"},
        )
        identifier = payload.get("id")
        if not isinstance(identifier, str) or not identifier:
            raise DriveUploadError("Google Drive did not create a result folder.")
        return identifier

    def upload_file(self, path: Path, parent_id: str) -> str:
        existing = self._find_named_file(path.name, parent_id)
        method = "PATCH" if existing else "POST"
        url = f"{DRIVE_UPLOAD_API}/files/{quote(existing, safe='')}" if existing else f"{DRIVE_UPLOAD_API}/files"
        metadata: dict[str, Any] = {"name": path.name}
        if not existing:
            metadata["parents"] = [parent_id]
        try:
            with path.open("rb") as stream:
                response = self.session.request(
                    method,
                    url,
                    headers=self._headers(),
                    params={"uploadType": "multipart", "fields": "id"},
                    files={
                        "metadata": (None, json.dumps(metadata), "application/json; charset=UTF-8"),
                        "file": (path.name, stream, "application/octet-stream"),
                    },
                    timeout=300,
                )
                response.raise_for_status()
                payload = response.json()
        except (OSError, requests.RequestException, ValueError) as exc:
            raise DriveUploadError("Could not upload a validated result file to Google Drive.") from exc
        identifier = payload.get("id") if isinstance(payload, dict) else None
        if not isinstance(identifier, str) or not identifier:
            raise DriveUploadError("Google Drive did not confirm a result-file upload.")
        return identifier

    def enable_viewer_link(self, folder_id: str) -> None:
        existing = self._json(
            "GET",
            f"{DRIVE_API}/files/{quote(folder_id, safe='')}/permissions",
            params={"fields": "permissions(id,type,role)"},
        )
        permissions = existing.get("permissions")
        if isinstance(permissions, list) and any(
            isinstance(item, dict) and item.get("type") == "anyone" and item.get("role") in {"reader", "commenter", "writer"}
            for item in permissions
        ):
            return
        self._json(
            "POST",
            f"{DRIVE_API}/files/{quote(folder_id, safe='')}/permissions",
            json={"type": "anyone", "role": "reader"},
            params={"fields": "id"},
        )


def _validated_result_files(work_dir: Path) -> tuple[dict[str, Any], list[Path]]:
    manifest_path = work_dir / "result-manifest.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise DriveUploadError("Validated result manifest is unavailable for Google Drive upload.") from exc
    if not isinstance(manifest, dict) or manifest.get("status") != "succeeded":
        raise DriveUploadError("Result manifest does not prove a successful scientific run.")
    outputs = manifest.get("validated_outputs")
    if not isinstance(outputs, list) or not outputs:
        raise DriveUploadError("Result manifest has no validated files to upload.")
    root = work_dir.resolve()
    files = [manifest_path]
    for output in outputs:
        if not isinstance(output, dict):
            raise DriveUploadError("Result manifest contains an invalid validated-file entry.")
        relative = output.get("path")
        digest = output.get("sha256")
        if not isinstance(relative, str) or not isinstance(digest, str):
            raise DriveUploadError("Result manifest contains an invalid validated-file entry.")
        candidate = (root / relative).resolve()
        if root not in candidate.parents or not candidate.is_file() or _sha256_file(candidate) != digest:
            raise DriveUploadError("A validated result file is missing or failed its checksum before Google Drive upload.")
        files.append(candidate)
    return manifest, files


def upload_validated_results(work_dir: Path, *, config: DriveConfig | None = None, session: Any | None = None) -> str:
    manifest, files = _validated_result_files(work_dir)
    job_id = manifest.get("job_id")
    if not isinstance(job_id, str) or not re.fullmatch(r"[0-9a-fA-F-]{36}", job_id):
        raise DriveUploadError("Result manifest has an invalid job identifier.")
    client = DriveClient(config or load_drive_config(), session=session)
    job_folder = client.find_or_create_folder(job_id, client.config.parent_folder_id)
    outputs_folder = client.find_or_create_folder("outputs", job_folder)
    root = work_dir.resolve()
    for path in files:
        parent = job_folder if path.name == "result-manifest.json" else outputs_folder
        if path.name != "result-manifest.json":
            relative_parent = path.relative_to(root / "outputs").parent
            for part in relative_parent.parts:
                parent = client.find_or_create_folder(part, parent)
        client.upload_file(path, parent)
    client.enable_viewer_link(job_folder)
    return f"https://drive.google.com/drive/folders/{job_folder}"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work-dir", required=True, type=Path)
    args = parser.parse_args()
    try:
        url = upload_validated_results(args.work_dir.resolve())
    except DriveUploadError as exc:
        print(f"ERROR: {exc}", flush=True)
        return 1
    print(f"DRIVE_RESULT_URL={url}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
