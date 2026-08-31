-- Test-only helpers, applied AFTER the schema (they call shipped functions).
-- Never applied to Supabase.

create or replace function assert(cond boolean, label text)
returns void language plpgsql as $$
begin
  if cond is not true then
    raise exception 'FAIL: %', label;
  end if;
  raise notice 'ok  %', label;
end;
$$;

-- Test-only convenience: claim exactly one job and return it as a row. The
-- shipped API is set-returning (claim_jobs), because workers always claim
-- batches; the single-row form only makes assertions terser.
create or replace function claim_one(
  p_worker_id  text,
  p_token      text,
  p_lease_secs int default 60
)
returns jobs
language plpgsql
as $$
declare
  v_job public.jobs;
begin
  select * into v_job
  from public.claim_jobs(p_worker_id, p_token, null, 1, p_lease_secs);
  return v_job;
end;
$$;

