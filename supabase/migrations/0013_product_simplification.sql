-- Keep the public product centered on submit -> wait -> run -> download.
-- Worker services are the only capability source; ordinary jobs use fair
-- scheduling and fixed retention rather than user-controlled priority/keep.

create or replace function private.prepare_product_job()
returns trigger language plpgsql security definer set search_path = '' as $$
declare p public.user_profiles; active_count int; today_count int;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new.user_id::text, 1701));
  p := private.ensure_profile(new.user_id);
  if p.status = 'disabled' then raise exception 'account disabled' using errcode='42501'; end if;
  select count(*) into active_count from public.jobs where user_id=new.user_id and status in ('queued','running') and deleted_at is null;
  if active_count >= p.max_active_jobs then raise exception 'active job quota exceeded' using errcode='54000'; end if;
  select count(*) into today_count from public.jobs where user_id=new.user_id and created_at >= date_trunc('day', now());
  if today_count >= p.daily_job_limit then raise exception 'daily job quota exceeded' using errcode='54000'; end if;
  perform private.validate_job_payload(new.type::text, new.payload);
  new.priority := case when private.is_admin(new.user_id)
                       then least(greatest(coalesce(new.priority,0),0),10)
                       else 0 end;
  new.retained_until := coalesce(new.retained_until, now() + make_interval(days => p.retention_days));
  new.pool_id := coalesce(new.pool_id, '00000000-0000-0000-0000-000000000001');
  return new;
end;
$$;

drop index if exists jobs_retention_idx;
drop function set_job_retention(uuid,boolean);
alter table jobs drop column keep_result;
create index jobs_retention_idx on jobs(retained_until)
  where deleted_at is null and status in ('succeeded','failed','canceled');

alter table user_profiles drop column max_priority;

drop function admin_create_worker(text,text,text[],uuid);
create function admin_create_worker(
  p_id text,
  p_name text,
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
  insert into public.workers(id, display_name, pool_id, token_hash)
    values(p_id, coalesce(nullif(trim(p_name), ''), p_id), p_pool_id,
           extensions.crypt(token, extensions.gen_salt('bf', 12)));
  insert into public.worker_events(worker_id, event) values(p_id, 'created');
  return jsonb_build_object(
    'id', p_id, 'token', token, 'env',
    'INFERSPOOL_WORKER_ID=' || p_id || E'\nINFERSPOOL_WORKER_TOKEN=' || token || E'\n');
end;
$$;

alter table workers drop column capabilities;

create or replace function admin_metrics(p_hours int default 24)
returns jsonb language plpgsql security definer set search_path='' stable as $$
declare since timestamptz:=now()-make_interval(hours=>least(greatest(coalesce(p_hours,24),1),720)); out jsonb;
begin
  if not private.is_admin(auth.uid()) then raise exception 'administrator access required' using errcode='42501'; end if;
  select jsonb_build_object(
    'hours',p_hours,'queued',(select count(*) from public.jobs where status='queued' and deleted_at is null),
    'running',(select count(*) from public.jobs where status='running' and deleted_at is null),
    'workers_online',(select count(*) from public.workers where disabled_at is null and last_heartbeat>now()-interval '90 seconds'),
    'service_failures',(select count(*) from public.worker_events where event='service_failed' and created_at>=since),
    'storage_bytes',(select coalesce(sum((f->>'bytes')::bigint),0) from public.jobs j cross join lateral jsonb_array_elements(
      (case when jsonb_typeof(j.result->'artifacts')='array' then j.result->'artifacts' else '[]'::jsonb end) ||
      (case when jsonb_typeof(j.result->'files')='array' then j.result->'files' else '[]'::jsonb end) ||
      (case when jsonb_typeof(j.result->'file')='object' then jsonb_build_array(j.result->'file') else '[]'::jsonb end)
    ) f where j.deleted_at is null),
    'by_type',(select coalesce(jsonb_object_agg(type,stats),'{}') from (select type::text type,jsonb_build_object('total',count(*),'succeeded',count(*) filter(where status='succeeded'),'failed',count(*) filter(where status='failed'),'canceled',count(*) filter(where status='canceled'),'success_rate',round(100.0*count(*) filter(where status='succeeded')/nullif(count(*) filter(where status in ('succeeded','failed')),0),1),'avg_queue_seconds',round(avg(extract(epoch from started_at-created_at)) filter(where started_at is not null),1),'avg_run_seconds',round(avg(extract(epoch from finished_at-started_at)) filter(where finished_at is not null and started_at is not null),1)) stats from public.jobs where created_at>=since and deleted_at is null group by type)s)
  ) into out; return out;
end;
$$;

revoke all on function admin_create_worker(text,text,uuid) from public;
grant execute on function admin_create_worker(text,text,uuid) to authenticated;
