# Supabase staging migration runbook

This runbook is for the specifically approved, NEW Supabase Free staging project
only. It does not authorize a live database operation by itself.

## Identify the intended project

1. Obtain the approved staging project name, project reference, and project URL from
   the deployment record or Supabase dashboard.
2. Confirm the dashboard project reference and URL match that record. The URL must be
   the NEW staging project, not the old paused project.
3. If the project identity is missing, differs from the record, or is ambiguous, stop.
   Do not open the SQL Editor or apply anything.
4. Keep the Supabase secret API key server-side only. Do not paste it into the SQL
   Editor, browser code, this repository, or a chat message.

## Review before approval

From a local checkout, inspect the proposed migration without connecting anywhere:

```powershell
cd D:\SARGuardian_Dynamic\Backend
Get-Content .\migrations\001_processing_jobs.sql
```

Confirm the review covers the transaction, schema-drift checks, Firebase-UID owner
filters, immutable snapshots, queued-only initial state, state-transition trigger,
idempotency constraint, global active-heavy-job index, RLS, grants, and policies.

Do not retry a failed or partially displayed SQL Editor execution blindly. A schema
drift error is intentional: stop and review the existing objects rather than adding
`IF NOT EXISTS` statements that conceal a different schema.

## Apply only after explicit approval

1. In the already-identified NEW staging project, open **SQL Editor**.
2. Run the read-only inspection below first. It must show either no application
   objects or the exact objects expected by this migration. Do not select the old
   paused project.

```sql
select current_schema(), current_user;
select to_regtype('public.processing_job_state') as processing_job_state,
       to_regclass('public.catalog_preflights') as catalog_preflights,
       to_regclass('public.processing_jobs') as processing_jobs;
```

3. After project identity and the read-only result are approved, paste the complete
   contents of `migrations/001_processing_jobs.sql` and run it once.
4. The migration runs in a transaction. If it reports schema drift or another
   error, stop and preserve the error for review; do not run destructive cleanup or
   attempt a blind retry.

## Safe post-apply verification

Run these read-only checks in the same NEW staging project. They inspect schema only;
they do not insert users, preflights, or jobs.

```sql
select table_schema, table_name
from information_schema.tables
where table_schema = 'public'
  and table_name in ('catalog_preflights', 'processing_jobs');

select indexname, indexdef
from pg_indexes
where schemaname = 'public'
  and indexname in (
    'catalog_preflights_owner_created_idx',
    'processing_jobs_owner_created_idx',
    'processing_jobs_state_idx',
    'processing_jobs_one_active_heavy_idx'
  )
order by indexname;

select c.relname as table_name, t.tgname, pg_get_triggerdef(t.oid)
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
where c.relnamespace = 'public'::regnamespace
  and not t.tgisinternal
  and c.relname in ('catalog_preflights', 'processing_jobs')
order by c.relname, t.tgname;

select schemaname, tablename, policyname, roles, cmd, qual, with_check
from pg_policies
where schemaname = 'public'
  and tablename in ('catalog_preflights', 'processing_jobs');

select relname, relrowsecurity
from pg_class
where relnamespace = 'public'::regnamespace
  and relname in ('catalog_preflights', 'processing_jobs');

select table_name, grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name in ('catalog_preflights', 'processing_jobs')
order by table_name, grantee, privilege_type;
```

Expected results include both tables, the four indexes, immutable-preflight and
job-integrity/transition triggers, owner-read policies limited to `authenticated`,
RLS enabled, and server-side `service_role` grants. `anon` and `authenticated`
must not have table grants. Do not treat this schema inspection as proof of live
Firebase authentication, owner isolation, or concurrency; those require a separately
approved staging smoke test with test accounts and test AOIs.

## Later authenticated persistence smoke test

Run this only after the project identity, migration, backend Render Environment,
Firebase Admin configuration, and staging CORS policy have been separately approved.
Use a dedicated Firebase test account and a small non-sensitive test AOI. Never put
the Firebase ID token, Supabase key, or Admin credential in this document, a shell
history, browser storage, or a log.

1. In the staging frontend or an approved API client, authenticate as test user A.
2. Call `POST /api/catalog/search` with that Firebase ID token and the test AOI/date/
   product request. Confirm the response is a real ASF metadata preflight with a
   `preflight_id`, `status: ready`, and no downloaded data or scientific result.
3. Call `POST /api/jobs` with that `preflight_id`, a fresh idempotency key, and
   `confirm: true`. Confirm the response has the same owner context, a real job ID,
   and `state: queued`.
4. Call `GET /api/jobs` and `GET /api/jobs/{job_id}` as user A. Confirm the created
   job is returned and its snapshots/product family match the persisted preflight.
5. Repeat the same `POST /api/jobs` request with the same idempotency key. Confirm it
   returns the original job rather than creating a second job.
6. Authenticate as test user B. Confirm B's list does not contain A's job and B's
   detail request for A's job returns not found. This verifies backend Firebase-UID
   filters; it is not a test of Supabase Auth identity matching.
7. Confirm no job leaves `queued`, no worker dispatch occurs, and no Drive artifact
   is created in this milestone.

The repository test suite uses mocked Firebase/ASF/persistence boundaries and local
fake stores. Those tests verify route contracts, ownership arguments, idempotency,
failure responses, and migration text, but they do not prove a durable write, RLS,
database-level concurrency, or cross-user isolation in Supabase. Only the approved
staging smoke test proves the create/list/detail path against the real database.

To compare the configured staging target, inspect the private Render Environment or
local configuration privately and compare its `SUPABASE_URL` project reference with
the approved Dashboard project reference. The non-networking diagnostic may confirm
that the URL is shaped correctly, but must not print the URL or any secret value.

The backend stores Firebase UIDs as text and filters every persistence query with the
verified Firebase UID. Supabase Auth `auth.uid()` is not assumed to equal a Firebase
UID. The browser never receives the server-only Supabase key; a modern `sb_secret_...`
value remains an `apikey` header credential for the backend's Supabase client, while
the Firebase ID token remains the end-user `Authorization: Bearer` credential.
