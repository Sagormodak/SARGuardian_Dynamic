# SARGuardian catalogue API foundation

This FastAPI service provides the frontend's metadata-only archive preflight.
It queries the official ASF Search API for NISAR `GUNW` and `GOFF` metadata only. It does not
download satellite data, run scientific processing, or fabricate catalogue products.
Set `ASF_CATALOG_ENABLED=false` to disable the adapter; otherwise valid searches use the real
ASF endpoint and return `ready` or `no_data`.

## Setup

Use Python 3.11+ in this directory:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
Copy-Item .env.example .env
```

During local development, the backend loads `Backend/.env` through `python-dotenv`.
Existing host environment variables take precedence. Set `APP_ENV=production` in a
hosted environment; production skips local dotenv loading and requires hosting-provided
environment variables, including an explicit `CORS_ORIGINS` value.

Configure Firebase Admin with Application Default Credentials or a server-only
`GOOGLE_APPLICATION_CREDENTIALS` path. On Vercel, use the server-only
`FIREBASE_SERVICE_ACCOUNT_JSON` environment variable instead; it contains the full JSON
object supplied by the hosting environment and is parsed in memory. Do not commit its value,
print it in logs, or place service-account credentials in `Frontend/`
or any `VITE_*` variable. The frontend sends a Firebase ID token as `Authorization: Bearer ...`.
Set `APP_ENV=production` and an explicit comma-separated `CORS_ORIGINS` allowlist in production;
the server refuses to start in production without that allowlist. `PORT` is honored for hosting
platforms and defaults to `8000` locally.

For durable jobs, set `SUPABASE_URL` and the server-only `SUPABASE_SERVICE_ROLE_KEY`.
That variable may contain either a modern opaque `sb_secret_...` key or a legacy
`service_role` JWT. Modern keys are sent to Supabase as `apikey` and are never used
as `Authorization: Bearer ...`; the Firebase ID token remains the separate client
authentication credential.
There is no in-memory fallback: missing values produce a safe configuration error. Apply
`migrations/001_processing_jobs.sql` to the Supabase project before enabling job creation.
Supabase does not automatically treat Firebase identities as Supabase Auth identities. The
backend verifies Firebase first and filters every persistence operation by that verified UID;
the SQL RLS policies are defense-in-depth for a future Supabase JWT integration.
The manual, approval-gated staging procedure is documented in
[`STAGING_MIGRATION_RUNBOOK.md`](STAGING_MIGRATION_RUNBOOK.md). It explicitly warns against
selecting the old paused project and does not authorize this local environment to contact
Supabase.

## Safe local configuration preflight

Do not commit `Backend/.env`. Create it manually from `Backend/.env.example` only after
obtaining staging values. The current code expects these names:

- `APP_ENV` (`development` locally; `production` on a host)
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY` (the server-only modern secret API key, or a legacy service-role JWT)
- `GOOGLE_APPLICATION_CREDENTIALS` (local file path, optional when Application Default Credentials are configured)
- `FIREBASE_SERVICE_ACCOUNT_JSON` (Vercel-only full JSON secret, parsed in memory)
- `ASF_CATALOG_ENABLED`, `ASF_SEARCH_URL`, `ASF_MAX_RESULTS`, and `ASF_TIMEOUT_SECONDS`
- `CORS_ORIGINS` (comma-separated origins; required in production)
- `PREFLIGHT_TTL_SECONDS` (60 through 604800 seconds)
- `PORT` (optional; defaults to 8000)

Manual setup:

1. Copy `Backend/.env.example` to `Backend/.env` locally; do not commit the copy.
2. Set `APP_ENV=development` and the staging `SUPABASE_URL`.
3. Put the modern server-only Supabase secret key in `SUPABASE_SERVICE_ROLE_KEY`.
4. Set either `GOOGLE_APPLICATION_CREDENTIALS` to a local server-side credential path, or configure Application Default Credentials. Do not put the credential JSON in this repository.
5. Set `ASF_CATALOG_ENABLED` deliberately, review `CORS_ORIGINS`, and keep `PREFLIGHT_TTL_SECONDS` within its supported range.
6. From `Backend`, run the non-networking diagnostic:

```powershell
python -m app.config_diagnostic
```

The diagnostic reports only variable names and shape/status messages. It does not initialize
Supabase or Firebase, contact ASF or Supabase, apply migrations, print values or key prefixes,
or read the Firebase credential file. It exits with code 0 only when all checks pass. The
Supabase secret is an API key for the server-side `apikey` header; it is not a Firebase token
and is never the end-user `Authorization: Bearer` credential.

## Vercel deployment preparation

Create two Vercel projects from this repository without deploying from this phase:

- Frontend project root: `Frontend/`
- Backend project root: `Backend/`

For the backend project, use the Python runtime with `index.py` as the FastAPI entrypoint.
Vercel installs the backend dependencies from `Backend/requirements.txt`; no separate server
or long-running process is required. Set `APP_ENV=production` and an explicit trusted
comma-separated `CORS_ORIGINS` value containing the final Vercel frontend origin. Also set
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `FIREBASE_SERVICE_ACCOUNT_JSON` in Vercel's
server-side environment settings. Do not set `GOOGLE_APPLICATION_CREDENTIALS` to a Windows
path on Vercel. Keep Supabase migrations and worker dispatch as later phases.

For the frontend project, use the Vite preset, root directory `Frontend/`, build command
`npm run build`, and output directory `dist`. Set the public frontend variables documented in
`Frontend/.env.example` before building. The existing `Frontend/vercel.json` provides the SPA
rewrite for client-side routes such as `/landslide`.

## Run

```powershell
python -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

Health: `GET http://localhost:8000/health`
Catalogue preflight: `POST http://localhost:8000/api/catalog/search`
Create confirmed queued job: `POST http://localhost:8000/api/jobs`
List current user's jobs: `GET http://localhost:8000/api/jobs`
Inspect current user's job: `GET http://localhost:8000/api/jobs/{job_id}`

The adapter uses ASF's public `services/search/param` endpoint with a WKT `intersectsWith`
polygon, `platform=NISAR`, `processingLevel=GUNW` or `GOFF`, UTC `start`/`end`,
`output=jsonlite`, and a bounded `maxResults` cap. ASF's response has no continuation token;
when the cap is reached, the response sets `truncated=true` and asks the caller to narrow the
search. Catalogue search is read-only and does not require Earthdata download credentials.

## Request

```json
{
  "coordinates": [[85.3, 27.7], [85.301, 27.7], [85.301, 27.701], [85.3, 27.7]],
  "start_date": "2026-08-01",
  "end_date": "2026-08-15",
  "product_type": "GUNW"
}
```

The endpoint validates a closed WGS84 longitude/latitude polygon, positive area, the 1,000 km2
AOI limit, date order, the 90-day limit, and `GUNW`/`GOFF` product types before the adapter
is called. Results preserve actual ASF granule names, product types, dates, direction, path,
processing level, and size metadata where ASF provides them. Missing metadata remains absent.

Job creation requires a current successful `preflight_id`, `confirm: true`, and a caller-owned
idempotency key. It stores immutable request and manifest snapshots and starts in `queued`
state. This milestone does not dispatch a worker or transition jobs to `dispatching`/`running`.

## Tests

```powershell
python -m pytest
```
