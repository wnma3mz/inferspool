-- Worker capabilities are discovered from service reports. The legacy
-- workers.capabilities column and p_types admin argument remain only for
-- rolling-upgrade compatibility; neither limits scheduling anymore.

create or replace function private.reclaim_expired()
returns void
language sql
security definer
set search_path = ''
as $$
  update public.jobs set
    status = case when cancel_requested then 'canceled'::public.job_status
                  when attempts >= max_attempts then 'failed'::public.job_status
                  else 'queued'::public.job_status end,
    error = case
              when cancel_requested then error
              when attempts >= max_attempts
                then format('worker lost; lease expired after attempt %s; retries exhausted', attempts)
              else format('worker lost; lease expired after attempt %s; retry scheduled', attempts)
            end,
    finished_at = case when cancel_requested or attempts >= max_attempts
                       then now() end,
    can_start_at = now() + private.backoff(attempts),
    worker_id = null,
    lease_expires_at = null
  where status = 'running' and lease_expires_at < now();
$$;

-- This public wrapper lets the product API reclaim abandoned work while no
-- worker is polling. claim_jobs still performs the same recovery inline.
create or replace function reclaim_expired_jobs()
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare reclaimed int;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('inferspool-reclaim-expired-jobs', 0));
  select count(*) into reclaimed from public.jobs
  where status = 'running' and lease_expires_at < now();
  perform private.reclaim_expired();
  return reclaimed;
end;
$$;

revoke all on function reclaim_expired_jobs() from public, anon, authenticated;
grant execute on function reclaim_expired_jobs() to service_role;

-- Pending work is scoped to the worker pool and to service types the worker
-- has reported. Unhealthy rows are included so an on-demand backend can see
-- demand, start locally, report healthy, and then claim.
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
      )
    group by j.type;
end;
$$;

-- Claiming rechecks the latest service report in the same statement that
-- locks jobs. A stale or unhealthy backend cannot receive new work even if a
-- previous pending response advertised demand.
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

-- Keep the old signature so older API deployments remain compatible while
-- new clients stop asking administrators to choose task types.
create or replace function admin_create_worker(
  p_id text,
  p_name text,
  p_types text[],
  p_pool_id uuid default '00000000-0000-0000-0000-000000000001'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare token text;
begin
  if not private.is_admin(auth.uid()) then
    raise exception 'administrator access required' using errcode = '42501';
  end if;
  if p_id !~ '^[a-z0-9][a-z0-9_-]{2,62}$' then
    raise exception 'invalid worker id' using errcode = '22023';
  end if;
  token := private.new_worker_token();
  insert into public.workers(id, display_name, capabilities, pool_id, token_hash)
    values(p_id, coalesce(nullif(trim(p_name), ''), p_id), '{}', p_pool_id,
           extensions.crypt(token, extensions.gen_salt('bf', 12)));
  insert into public.worker_events(worker_id, event) values(p_id, 'created');
  return jsonb_build_object(
    'id', p_id, 'token', token, 'env',
    'INFERSPOOL_WORKER_ID=' || p_id || E'\nINFERSPOOL_WORKER_TOKEN=' || token || E'\n');
end;
$$;

create or replace function admin_list_workers()
returns jsonb
language plpgsql
security definer
set search_path = ''
stable
as $$
declare result jsonb;
begin
  if not private.is_admin(auth.uid()) then
    raise exception 'administrator access required' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', w.id, 'name', w.display_name, 'pool_id', w.pool_id,
    'disabled_at', w.disabled_at, 'last_heartbeat', w.last_heartbeat,
    'created_at', w.created_at,
    'services', (select coalesce(jsonb_agg(to_jsonb(s)), '[]')
                 from public.worker_services s where s.worker_id = w.id)
  ) order by w.created_at desc), '[]') into result
  from public.workers w;
  return result;
end;
$$;

create or replace function queue_stats()
returns jsonb
language sql
security definer
set search_path = ''
stable
as $$
  with live as (
    select ws.*, (w.last_heartbeat > now() - interval '90 seconds'
                  and ws.last_check > now() - interval '90 seconds') as fresh
    from public.worker_services ws
    join public.workers w on w.id = ws.worker_id
  )
  select jsonb_build_object(
    'queued', (select count(*) from public.jobs where status = 'queued'),
    'running', (select count(*) from public.jobs where status = 'running'),
    'workers_online', (
      select count(distinct worker_id) from live where healthy and fresh
    ),
    'services', (
      select coalesce(jsonb_object_agg(type, detail), '{}'::jsonb)
      from (
        select coalesce(l.type, q.type) as type,
               jsonb_build_object(
                 'up', coalesce(sum(case when l.healthy and l.fresh then 1 else 0 end), 0),
                 'total', count(l.worker_id),
                 'capacity', coalesce(sum(case when l.healthy and l.fresh then l.capacity else 0 end), 0),
                 'queued', coalesce(max(q.n), 0)
               ) as detail
        from live l
        full outer join (
          select type::text as type, count(*) as n from public.jobs
          where status = 'queued' group by type
        ) q on q.type = l.type
        group by coalesce(l.type, q.type)
      ) s
    ),
    'workers', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', case when auth.uid() is not null then w.id end,
        'online', coalesce(w.last_heartbeat > now() - interval '90 seconds', false),
        'services', case when auth.uid() is not null then (
          select coalesce(jsonb_agg(jsonb_build_object(
            'type', s.type, 'name', s.name,
            'healthy', s.healthy and s.fresh,
            'detail', s.detail, 'models', to_jsonb(s.models),
            'capacity', s.capacity
          )), '[]'::jsonb)
          from live s where s.worker_id = w.id
        ) end
      )), '[]'::jsonb)
      from public.workers w
    )
  );
$$;
