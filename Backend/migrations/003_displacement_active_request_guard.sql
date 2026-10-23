-- One account may have only one live workflow for one immutable AOI/date
-- request. Terminal records remain available as account history.
begin;

create unique index if not exists displacement_jobs_one_active_request_per_owner_idx
  on public.displacement_jobs (owner_uid, md5(aoi_wkt), start_date, end_date)
  where state in ('queued', 'dispatching', 'running');

comment on index public.displacement_jobs_one_active_request_per_owner_idx is
  'Prevents duplicate active displacement workflows for an account and immutable request.';

commit;
