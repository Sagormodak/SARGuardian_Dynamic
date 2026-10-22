-- Durable user-initiated displacement jobs. The trusted API owns all writes;
-- browser clients have no table grants and must use authenticated endpoints.
begin;

create table public.displacement_jobs (
  id uuid primary key default gen_random_uuid(),
  owner_uid text not null check (length(btrim(owner_uid)) > 0),
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9._:-]{16,128}$'),
  state public.processing_job_state not null default 'queued',
  stage text not null default 'queued' check (length(stage) between 1 and 80),
  aoi_wkt text not null check (length(aoi_wkt) <= 100000),
  start_date date not null,
  end_date date not null check (end_date >= start_date),
  github_run_id text,
  github_run_url text,
  callback_sequence integer not null default 0 check (callback_sequence between 0 and 1000),
  error_code text,
  error_message text,
  result_summary jsonb,
  artifact_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_uid, idempotency_key)
);

create index displacement_jobs_owner_created_idx on public.displacement_jobs (owner_uid, created_at desc);
create index displacement_jobs_state_idx on public.displacement_jobs (state);

create or replace function public.enforce_displacement_job_transition()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if new.state <> 'queued' then raise exception 'new displacement jobs must start queued'; end if;
    return new;
  end if;
  if new.state <> old.state and not (
    (old.state = 'queued' and new.state in ('dispatching', 'failed', 'cancelled')) or
    (old.state = 'dispatching' and new.state in ('running', 'failed', 'cancelled')) or
    (old.state = 'running' and new.state in ('succeeded', 'failed', 'cancelled'))
  ) then raise exception 'invalid displacement job transition: % -> %', old.state, new.state; end if;
  if new.owner_uid is distinct from old.owner_uid or new.idempotency_key is distinct from old.idempotency_key
    or new.aoi_wkt is distinct from old.aoi_wkt or new.start_date is distinct from old.start_date or new.end_date is distinct from old.end_date
  then raise exception 'displacement request inputs are immutable'; end if;
  if new.callback_sequence < old.callback_sequence or new.callback_sequence > old.callback_sequence + 1 then
    raise exception 'displacement callback sequence is invalid';
  end if;
  new.updated_at = now();
  return new;
end;
$$;

create trigger displacement_jobs_transition_guard before insert or update on public.displacement_jobs
for each row execute function public.enforce_displacement_job_transition();

alter table public.displacement_jobs enable row level security;
revoke all on table public.displacement_jobs from anon, authenticated;
grant select, insert, update on table public.displacement_jobs to service_role;
create policy displacement_jobs_owner_read on public.displacement_jobs for select to authenticated
using ((select auth.jwt() ->> 'sub') = owner_uid);
comment on table public.displacement_jobs is 'Durable authenticated displacement requests and verified GitHub Actions callbacks.';
commit;
