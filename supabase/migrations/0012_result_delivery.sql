-- Route direct-delivery jobs only to workers that advertise a LAN result
-- endpoint. Cloud delivery remains the default for old jobs and workers.

alter table jobs add constraint jobs_result_delivery_check check (
  coalesce(payload->>'_result_delivery', 'cloud') in ('cloud', 'direct')
  and not (type = 'llm' and payload->>'_result_delivery' = 'direct')
);

create or replace function pending_by_type(p_worker_id text, p_token text)
returns table (type text, n bigint)
language plpgsql
security definer
set search_path = ''
volatile
as $$
declare worker_pool uuid;
begin
  perform private.auth_worker(p_worker_id, p_token);
  perform private.reclaim_expired();
  select pool_id into worker_pool from public.workers where id = p_worker_id;

  return query
    select j.type::text, count(*)
    from public.jobs j
    where j.status = 'queued'
      and j.pool_id = worker_pool
      and j.deleted_at is null
      and j.can_start_at <= now()
      and not j.cancel_requested
      and exists (
        select 1 from public.worker_services ws
        where ws.worker_id = p_worker_id and ws.type = j.type::text
          and coalesce(
            ws.parameter_schema->'_result_delivery'->'enum',
            '["cloud"]'::jsonb
          ) ? coalesce(j.payload->>'_result_delivery', 'cloud')
      )
    group by j.type;
end;
$$;

create or replace function claim_jobs(
  p_worker_id text,
  p_token text,
  p_types text[] default null,
  p_limit int default 8,
  p_lease_secs int default 60
)
returns setof jobs
language plpgsql
security definer
set search_path = ''
as $$
declare worker_pool uuid;
begin
  perform private.auth_worker(p_worker_id, p_token);
  perform private.reclaim_expired();
  select pool_id into worker_pool from public.workers where id = p_worker_id;

  return query with ranked as (
    select j.id,
           row_number() over (
             partition by j.user_id
             order by j.priority desc, j.can_start_at, j.created_at
           ) rn
    from public.jobs j
    where j.status = 'queued'
      and j.pool_id = worker_pool
      and j.deleted_at is null
      and j.can_start_at <= now()
      and not j.cancel_requested
      and exists (
        select 1 from public.worker_services ws
        where ws.worker_id = p_worker_id
          and ws.type = j.type::text
          and ws.healthy
          and ws.last_check > now() - interval '90 seconds'
          and (p_types is null or ws.type = any(p_types))
          and coalesce(
            ws.parameter_schema->'_result_delivery'->'enum',
            '["cloud"]'::jsonb
          ) ? coalesce(j.payload->>'_result_delivery', 'cloud')
      )
  ), picked as (
    select j.id from public.jobs j join ranked r on r.id = j.id
    order by r.rn, j.priority desc, j.can_start_at
    for update of j skip locked
    limit least(greatest(coalesce(p_limit, 1), 1), 64)
  )
  update public.jobs j set
    status = 'running', worker_id = p_worker_id,
    lease_expires_at = now() + make_interval(secs => p_lease_secs),
    attempts = attempts + 1, started_at = coalesce(started_at, now()),
    progress = null, progress_msg = null, error = null
  from picked
  where j.id = picked.id and j.status = 'queued' and not j.cancel_requested
  returning j.*;
end;
$$;
