-- SARGuardian Dynamic Step 8
-- Apply with Supabase migrations/SQL editor. This stores manifests and job metadata only.

create type public.processing_job_state as enum (
  'queued',
  'dispatching',
  'running',
  'succeeded',
  'failed',
  'cancelled'
);

create table public.catalog_preflights (
  id uuid primary key default gen_random_uuid(),
  owner_uid text not null,
  request_fingerprint text not null,
  request_snapshot jsonb not null,
  manifest_snapshot jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index catalog_preflights_owner_created_idx
  on public.catalog_preflights (owner_uid, created_at desc);

create table public.processing_jobs (
  id uuid primary key default gen_random_uuid(),
  owner_uid text not null,
  preflight_id uuid not null references public.catalog_preflights(id),
  idempotency_key text not null,
  product_family text not null check (product_family in ('GUNW', 'GOFF')),
  state public.processing_job_state not null default 'queued',
  request_snapshot jsonb not null,
  manifest_snapshot jsonb not null,
  worker_run_id text,
  error_code text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_uid, idempotency_key)
);

create index processing_jobs_owner_created_idx
  on public.processing_jobs (owner_uid, created_at desc);

create index processing_jobs_state_idx
  on public.processing_jobs (state);

-- Database-enforced global heavy-job gate. Queued jobs may accumulate; only one
-- dispatching/running job can exist across all app instances at a time.
create unique index processing_jobs_one_active_heavy_idx
  on public.processing_jobs ((true))
  where state in ('dispatching', 'running');

create or replace function public.enforce_processing_job_transition()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.state <> old.state and not (
    (old.state = 'queued' and new.state in ('dispatching', 'cancelled')) or
    (old.state = 'dispatching' and new.state in ('running', 'failed', 'cancelled')) or
    (old.state = 'running' and new.state in ('succeeded', 'failed', 'cancelled'))
  ) then
    raise exception 'invalid processing job state transition: % -> %', old.state, new.state
      using errcode = '22023';
  end if;
  new.updated_at = now();
  return new;
end;
$$;

create trigger processing_jobs_transition_guard
before update on public.processing_jobs
for each row execute function public.enforce_processing_job_transition();

alter table public.catalog_preflights enable row level security;
alter table public.processing_jobs enable row level security;

-- Clients do not receive table grants; the trusted Dynamic backend uses the
-- server-only Supabase service-role key and filters every query by verified Firebase UID.
revoke all on table public.catalog_preflights from anon, authenticated;
revoke all on table public.processing_jobs from anon, authenticated;
grant select, insert on table public.catalog_preflights to service_role;
grant select, insert, update on table public.processing_jobs to service_role;

-- These policies are defense-in-depth if a future Supabase JWT integration is
-- configured. Firebase IDs are not automatically trusted by Supabase auth.uid().
create policy catalog_preflights_owner_read
on public.catalog_preflights for select
to authenticated
using ((select auth.jwt() ->> 'sub') = owner_uid);

create policy processing_jobs_owner_read
on public.processing_jobs for select
to authenticated
using ((select auth.jwt() ->> 'sub') = owner_uid);

comment on table public.catalog_preflights is 'Immutable server-created ASF preflight manifests; no SAR files.';
comment on table public.processing_jobs is 'Durable job metadata only; workers are not dispatched by this milestone.';
comment on index processing_jobs_one_active_heavy_idx is 'Global database-enforced one-heavy-job gate for dispatching/running states.';
