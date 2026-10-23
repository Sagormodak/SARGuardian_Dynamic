# Displacement Actions integration

`Find Displacements` creates an authenticated, durable `displacement_jobs` record and dispatches `.github/workflows/sarguardian-displacement.yml`. The browser never receives GitHub or callback secrets.

## Required server environment variables

- `DISPLACEMENT_ACTIONS_ENABLED=true`
- `GITHUB_ACTIONS_TOKEN`: fine-grained token limited to **Actions: write** for `GITHUB_ACTIONS_REPOSITORY`.
- `GITHUB_ACTIONS_REPOSITORY`: `owner/repository` containing this workflow.
- `GITHUB_ACTIONS_WORKFLOW=sarguardian-displacement.yml`
- `GITHUB_ACTIONS_REF=main`
- `DISPLACEMENT_CALLBACK_SECRET`: shared HMAC secret; never expose as `VITE_*`.
- `PUBLIC_API_URL`: deployed HTTPS API origin, without a trailing slash.

The existing `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, Firebase service-account configuration and restrictive `CORS_ORIGINS` remain required.

## Required GitHub Actions secrets

- `DISPLACEMENT_CALLBACK_SECRET`: exactly the backend value.
- `EARTHDATA_USERNAME` and `EARTHDATA_PASSWORD`: a valid Earthdata Login account with
  access to the ASF/NISAR archive. These values are available only to the runner and
  are used by the pinned source downloader; they must never be returned to the browser.
- `GOOGLE_DRIVE_OAUTH_CLIENT_JSON`: a Google OAuth **web client** credential for the
  dedicated SARGuardian storage account. Do not use a Firebase or service-account
  credential for this value.
- `GOOGLE_DRIVE_REFRESH_TOKEN`: offline OAuth refresh token granted by that storage
  account with Drive upload access.
- `GOOGLE_DRIVE_FOLDER_ID`: the parent folder for per-job result folders.

After scientific validation, the runner creates one folder named with the durable job
UUID, uploads only `result-manifest.json` and its checksum-verified outputs, then sets
that job folder to **Anyone with the link: Viewer**. It never uploads raw NISAR HDF5
source files. If Drive authentication, upload, or link-sharing fails, the workflow is
failed and no successful result callback is sent.
The workflow runs the version-controlled `Backend/science_adapter/run_displacement.py` adapter. It pins `moshiour0/SARGuardian` at `10639a916c9829850775410b3ed7de62e527770d`, reuses its WKT parser, ASF acquisition path, GUNW/GOFF readers, AOI masks, quality gates and exports, and does not use `SARGuardian-backend` as a scientific source. Products are selected by an in-window **secondary acquisition** date; their reference acquisition can predate the selected start date. The manifest records this policy explicitly.

Before reporting success, the workflow requires a JSON manifest with the dispatched job ID, exact WKT hash/date window/source repository/ref, and checksummed `validated_outputs` entirely inside the isolated job directory. A zero process exit code is insufficient. The supported result is explicitly AOI-clipped, per-product GUNW/GOFF displacement screening; it is not an arbitrary-AOI time-series or hazard forecast. Callbacks have signed, ordered sequence numbers; GitHub terminal success without the signed completion callback is recorded as failure, never as science success.

Run [002_displacement_jobs.sql](../Backend/migrations/002_displacement_jobs.sql) after the prior processing-job migration. Keep direct browser access revoked; the trusted backend uses the Supabase service-role key and verifies Firebase ownership before reads or writes.
