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

Configure Firebase Admin with Application Default Credentials or a server-only
`GOOGLE_APPLICATION_CREDENTIALS` path. Never place service-account credentials in `Frontend/`
or any `VITE_*` variable. The frontend sends a Firebase ID token as `Authorization: Bearer ...`.
Set `APP_ENV=production` and an explicit comma-separated `CORS_ORIGINS` allowlist in production;
the server refuses to start in production without that allowlist. `PORT` is honored for hosting
platforms and defaults to `8000` locally.

For durable jobs, set `SUPABASE_URL` and the server-only `SUPABASE_SERVICE_ROLE_KEY`.
There is no in-memory fallback: missing values produce a safe configuration error. Apply
`migrations/001_processing_jobs.sql` to the Supabase project before enabling job creation.
Supabase does not automatically treat Firebase identities as Supabase Auth identities. The
backend verifies Firebase first and filters every persistence operation by that verified UID;
the SQL RLS policies are defense-in-depth for a future Supabase JWT integration.

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
