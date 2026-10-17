-- SARGuardian Dynamic durable job metadata schema.
-- Stores ASF preflight manifests and job metadata only; it does not dispatch work.
--
-- This script is safe to run again only when the existing objects match this
-- schema. Existing objects are validated below; schema drift raises an error
-- and the transaction rolls back instead of being hidden by IF NOT EXISTS.

begin;

do $$
begin
  if to_regprocedure('gen_random_uuid()') is null then
    raise exception 'gen_random_uuid() is required by this migration';
  end if;
end;
$$;

do $$
begin
  if to_regtype('public.processing_job_state') is null then
    create type public.processing_job_state as enum (
      'queued',
      'dispatching',
      'running',
      'succeeded',
      'failed',
      'cancelled'
    );
  elsif (
    select array_agg(enumlabel order by enumsortorder)
    from pg_enum
    where enumtypid = 'public.processing_job_state'::regtype
  ) <> array['queued', 'dispatching', 'running', 'succeeded', 'failed', 'cancelled']::text[] then
    raise exception 'processing_job_state exists with an unexpected definition';
  end if;
end;
$$;

create table if not exists public.catalog_preflights (
  id uuid primary key default gen_random_uuid(),
  owner_uid text not null check (length(btrim(owner_uid)) > 0),
  request_fingerprint text not null,
  request_snapshot jsonb not null,
  manifest_snapshot jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create table if not exists public.processing_jobs (
  id uuid primary key default gen_random_uuid(),
  owner_uid text not null check (length(btrim(owner_uid)) > 0),
  preflight_id uuid not null references public.catalog_preflights(id),
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9._:-]{16,128}$'),
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

-- Existing table names are accepted only when the required columns and types
-- are present. Missing or incompatible columns indicate schema drift.
do $$
declare
  expected record;
  actual_udt text;
  actual_nullable text;
begin
  for expected in
    select * from (values
      ('catalog_preflights', 'id', 'uuid', 'NO'),
      ('catalog_preflights', 'owner_uid', 'text', 'NO'),
      ('catalog_preflights', 'request_fingerprint', 'text', 'NO'),
      ('catalog_preflights', 'request_snapshot', 'jsonb', 'NO'),
      ('catalog_preflights', 'manifest_snapshot', 'jsonb', 'NO'),
      ('catalog_preflights', 'created_at', 'timestamptz', 'NO'),
      ('catalog_preflights', 'expires_at', 'timestamptz', 'NO'),
      ('processing_jobs', 'id', 'uuid', 'NO'),
      ('processing_jobs', 'owner_uid', 'text', 'NO'),
      ('processing_jobs', 'preflight_id', 'uuid', 'NO'),
      ('processing_jobs', 'idempotency_key', 'text', 'NO'),
      ('processing_jobs', 'product_family', 'text', 'NO'),
      ('processing_jobs', 'state', 'processing_job_state', 'NO'),
      ('processing_jobs', 'request_snapshot', 'jsonb', 'NO'),
      ('processing_jobs', 'manifest_snapshot', 'jsonb', 'NO'),
      ('processing_jobs', 'worker_run_id', 'text', 'YES'),
      ('processing_jobs', 'error_code', 'text', 'YES'),
      ('processing_jobs', 'error_message', 'text', 'YES'),
      ('processing_jobs', 'created_at', 'timestamptz', 'NO'),
      ('processing_jobs', 'updated_at', 'timestamptz', 'NO')
    ) as required(table_name, column_name, udt_name, is_nullable)
  loop
    select c.udt_name, c.is_nullable
      into actual_udt, actual_nullable
      from information_schema.columns c
     where c.table_schema = 'public'
       and c.table_name = expected.table_name
       and c.column_name = expected.column_name;
    if actual_udt is null
       or actual_udt <> expected.udt_name
       or actual_nullable <> expected.is_nullable then
      raise exception 'schema drift in public.%.%', expected.table_name, expected.column_name;
    end if;
  end loop;
end;
$$;

create index if not exists catalog_preflights_owner_created_idx
  on public.catalog_preflights (owner_uid, created_at desc);

create index if not exists processing_jobs_owner_created_idx
  on public.processing_jobs (owner_uid, created_at desc);

create index if not exists processing_jobs_state_idx
  on public.processing_jobs (state);

-- Database-enforced global heavy-job gate. Queued jobs may accumulate; only one
-- dispatching/running job can exist across all app instances at a time.
create unique index if not exists processing_jobs_one_active_heavy_idx
  on public.processing_jobs ((true))
  where state in ('dispatching', 'running');

do $$
begin
  if not exists (
    select 1
      from pg_index i
      join pg_class c on c.oid = i.indexrelid
     where c.oid = to_regclass('public.processing_jobs_one_active_heavy_idx')
       and i.indrelid = 'public.processing_jobs'::regclass
       and i.indisunique
       and pg_get_expr(i.indpred, i.indrelid) like '%dispatching%'
       and pg_get_expr(i.indpred, i.indrelid) like '%running%'
  ) then
    raise exception 'processing_jobs_one_active_heavy_idx has an unexpected definition';
  end if;
end;
$$;

create or replace function public.enforce_processing_job_transition()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if new.state <> 'queued' then
      raise exception 'new processing jobs must start in queued state'
        using errcode = '22023';
    end if;
    return new;
  end if;

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

create or replace function public.enforce_catalog_preflight_immutable()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'catalog preflight snapshots are immutable'
    using errcode = '55000';
end;
$$;

create or replace function public.enforce_processing_job_integrity()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if not exists (
    select 1
      from public.catalog_preflights p
     where p.id = new.preflight_id
       and p.owner_uid = new.owner_uid
  ) then
    raise exception 'processing job owner must match preflight owner'
      using errcode = '23514';
  end if;

  if tg_op = 'UPDATE' and (
    new.owner_uid is distinct from old.owner_uid
    or new.preflight_id is distinct from old.preflight_id
    or new.idempotency_key is distinct from old.idempotency_key
    or new.product_family is distinct from old.product_family
    or new.request_snapshot is distinct from old.request_snapshot
    or new.manifest_snapshot is distinct from old.manifest_snapshot
  ) then
    raise exception 'processing job ownership and snapshots are immutable'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conrelid = 'public.catalog_preflights'::regclass
       and contype = 'p'
       and pg_get_constraintdef(oid) = 'PRIMARY KEY (id)'
  ) then
    raise exception 'catalog_preflights primary key is missing or unsafe';
  end if;

  if not exists (
    select 1
      from pg_constraint
     where conrelid = 'public.processing_jobs'::regclass
       and contype = 'p'
       and pg_get_constraintdef(oid) = 'PRIMARY KEY (id)'
  ) then
    raise exception 'processing_jobs primary key is missing or unsafe';
  end if;

  if not exists (
    select 1
      from pg_constraint
     where conrelid = 'public.catalog_preflights'::regclass
       and contype = 'c'
       and pg_get_constraintdef(oid) like '%owner_uid%'
       and pg_get_constraintdef(oid) like '%btrim%'
  ) then
    raise exception 'catalog_preflights owner constraint is missing or unsafe';
  end if;
  if not exists (
    select 1
      from pg_constraint
     where conrelid = 'public.processing_jobs'::regclass
       and contype = 'u'
       and pg_get_constraintdef(oid) like '%owner_uid%idempotency_key%'
  ) then
    raise exception 'processing_jobs idempotency constraint is missing or unsafe';
  end if;
  if not exists (
    select 1
      from pg_constraint
     where conrelid = 'public.processing_jobs'::regclass
       and contype = 'c'
       and pg_get_constraintdef(oid) like '%owner_uid%'
       and pg_get_constraintdef(oid) like '%btrim%'
  ) then
    raise exception 'processing_jobs owner constraint is missing or unsafe';
  end if;
  if not exists (
    select 1
      from pg_constraint
     where conrelid = 'public.processing_jobs'::regclass
       and contype = 'c'
       and pg_get_constraintdef(oid) like '%idempotency_key%'
       and pg_get_constraintdef(oid) like '%128%'
  ) then
    raise exception 'processing_jobs idempotency format constraint is missing or unsafe';
  end if;
  if not exists (
    select 1
      from pg_constraint
     where conrelid = 'public.processing_jobs'::regclass
       and contype = 'f'
       and confrelid = 'public.catalog_preflights'::regclass
       and pg_get_constraintdef(oid) like '%preflight_id%'
  ) then
    raise exception 'processing_jobs preflight foreign key is missing or unsafe';
  end if;
  if not exists (
    select 1
      from pg_constraint
     where conrelid = 'public.processing_jobs'::regclass
       and contype = 'c'
       and pg_get_constraintdef(oid) like '%product_family%'
       and pg_get_constraintdef(oid) like '%GUNW%'
       and pg_get_constraintdef(oid) like '%GOFF%'
  ) then
    raise exception 'processing_jobs product-family constraint is missing or unsafe';
  end if;

  if not exists (
    select 1 from pg_trigger
     where tgrelid = 'public.processing_jobs'::regclass
       and tgname = 'processing_jobs_transition_guard'
       and not tgisinternal
  ) then
    create trigger processing_jobs_transition_guard
    before insert or update on public.processing_jobs
    for each row execute function public.enforce_processing_job_transition();
  elsif not exists (
    select 1 from pg_trigger
     where tgrelid = 'public.processing_jobs'::regclass
       and tgname = 'processing_jobs_transition_guard'
       and not tgisinternal
       and tgfoid = 'public.enforce_processing_job_transition()'::regprocedure
       and pg_get_triggerdef(oid) like '%BEFORE INSERT OR UPDATE%'
  ) then
    raise exception 'processing_jobs_transition_guard has an unexpected definition';
  end if;

  if not exists (
    select 1 from pg_trigger
     where tgrelid = 'public.catalog_preflights'::regclass
       and tgname = 'catalog_preflights_immutable_guard'
       and not tgisinternal
  ) then
    create trigger catalog_preflights_immutable_guard
    before update or delete on public.catalog_preflights
    for each row execute function public.enforce_catalog_preflight_immutable();
  elsif not exists (
    select 1 from pg_trigger
     where tgrelid = 'public.catalog_preflights'::regclass
       and tgname = 'catalog_preflights_immutable_guard'
       and not tgisinternal
       and tgfoid = 'public.enforce_catalog_preflight_immutable()'::regprocedure
       and pg_get_triggerdef(oid) like '%BEFORE UPDATE OR DELETE%'
  ) then
    raise exception 'catalog_preflights_immutable_guard has an unexpected definition';
  end if;

  if not exists (
    select 1 from pg_trigger
     where tgrelid = 'public.processing_jobs'::regclass
       and tgname = 'processing_jobs_integrity_guard'
       and not tgisinternal
  ) then
    create trigger processing_jobs_integrity_guard
    before insert or update on public.processing_jobs
    for each row execute function public.enforce_processing_job_integrity();
  elsif not exists (
    select 1 from pg_trigger
     where tgrelid = 'public.processing_jobs'::regclass
       and tgname = 'processing_jobs_integrity_guard'
       and not tgisinternal
       and tgfoid = 'public.enforce_processing_job_integrity()'::regprocedure
       and pg_get_triggerdef(oid) like '%BEFORE INSERT OR UPDATE%'
  ) then
    raise exception 'processing_jobs_integrity_guard has an unexpected definition';
  end if;
end;
$$;

alter table public.catalog_preflights enable row level security;
alter table public.processing_jobs enable row level security;

-- Clients do not receive table grants; only the trusted Dynamic backend uses
-- the server-only Supabase API key and filters by verified Firebase UID.
revoke all on table public.catalog_preflights from anon, authenticated;
revoke all on table public.processing_jobs from anon, authenticated;
grant select, insert on table public.catalog_preflights to service_role;
grant select, insert, update on table public.processing_jobs to service_role;

do $$
begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public'
       and tablename = 'catalog_preflights'
       and policyname = 'catalog_preflights_owner_read'
  ) then
    execute $policy$
      create policy catalog_preflights_owner_read
      on public.catalog_preflights for select
      to authenticated
      using ((select auth.jwt() ->> 'sub') = owner_uid)
    $policy$;
  end if;

  if not exists (
    select 1 from pg_policies
     where schemaname = 'public'
       and tablename = 'processing_jobs'
       and policyname = 'processing_jobs_owner_read'
  ) then
    execute $policy$
      create policy processing_jobs_owner_read
      on public.processing_jobs for select
      to authenticated
      using ((select auth.jwt() ->> 'sub') = owner_uid)
    $policy$;
  end if;
end;
$$;

do $$
begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public'
       and tablename = 'catalog_preflights'
       and policyname = 'catalog_preflights_owner_read'
       and array_to_string(roles, ',') = 'authenticated'
       and qual like '%auth.jwt()%'
       and qual like '%owner_uid%'
  ) then
    raise exception 'catalog_preflights_owner_read has an unsafe definition';
  end if;
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public'
       and tablename = 'processing_jobs'
       and policyname = 'processing_jobs_owner_read'
       and array_to_string(roles, ',') = 'authenticated'
       and qual like '%auth.jwt()%'
       and qual like '%owner_uid%'
  ) then
    raise exception 'processing_jobs_owner_read has an unsafe definition';
  end if;
end;
$$;

comment on table public.catalog_preflights is 'Immutable server-created ASF preflight manifests; no SAR files.';
comment on table public.processing_jobs is 'Durable job metadata only; workers are not dispatched by this milestone.';
comment on index processing_jobs_one_active_heavy_idx is 'Global database-enforced one-heavy-job gate for dispatching/running states.';

commit;
